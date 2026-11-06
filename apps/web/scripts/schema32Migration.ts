import { Database } from 'bun:sqlite';
import { z } from 'zod';
import type { AppDatabase } from '@/server/database/index';

const DeploymentScriptSchema = z.strictObject({
  command: z.string().trim().min(1).max(4_000),
});

const legacyDeployment = z.discriminatedUnion('kind', [
  DeploymentScriptSchema.extend({ kind: z.literal('LOCAL_SCRIPT') }),
  z.strictObject({
    kind: z.literal('CI_CD'),
    scriptCommand: DeploymentScriptSchema.shape.command.optional(),
  }),
]);

export const DeploymentCommandsSchema = z.record(
  z.uuid(),
  DeploymentScriptSchema.shape.command,
);

type DeploymentCommands = z.infer<typeof DeploymentCommandsSchema>;

export function planScriptCutover(
  db: AppDatabase,
  version: number,
  commands: DeploymentCommands,
) {
  const prefix = version < 31 ? 'cooking' : 'submission';
  const environmentTable = version < 31 ? 'cooking_environment' : 'platform_environment';
  const environments = db.all<{ id: string; deployment_json: string }>(
    `SELECT id, deployment_json FROM ${environmentTable}`,
  );
  const scripts = new Map<string, string>();
  const missing: string[] = [];
  for (const { id, deployment_json } of environments) {
    const legacy = legacyDeployment.parse(JSON.parse(deployment_json));
    if (legacy.kind === 'LOCAL_SCRIPT') {
      if (Object.hasOwn(commands, id)) throw new Error(`环境 ${id} 已有本地部署脚本。`);
      scripts.set(id, legacy.command);
    } else if (Object.hasOwn(commands, id)) {
      scripts.set(id, commands[id]!);
    } else {
      missing.push(id);
    }
  }
  if (Object.keys(commands).some((id) => !scripts.has(id)))
    throw new Error('部署脚本配置包含不存在的环境。');
  if (missing.length)
    throw new Error(
      `以下环境需要提供实际部署脚本（--deployment-commands）：${missing.join('、')}`,
    );

  if (db.get(`SELECT 1 FROM ${prefix}_update_batch WHERE state <> 'COMPLETED' LIMIT 1`))
    throw new Error('存在未完成的旧更新批次，请在旧 Server 处理后再切换。');

  const itemTable = version < 31 ? 'cooking_submission_item' : 'submission_item';
  for (const name of [itemTable, `${prefix}_bug_deployment`, `${prefix}_update_batch`]) {
    for (const row of db.all<{ deployment_json: string }>(
      `SELECT deployment_json FROM ${name}`,
    )) {
      if (!legacyDeployment.safeParse(JSON.parse(row.deployment_json)).success)
        throw new Error(`旧部署快照无效（${name}）。`);
    }
  }

  if (
    db.get(
      `SELECT 1 FROM ${prefix}_bug_deployment deployment
         JOIN ${prefix}_bug bug ON bug.id = deployment.bug_id
         WHERE json_extract(deployment.deployment_json, '$.kind') = 'CI_CD'
           AND bug.stage NOT IN ('DONE', 'WAITING_FOR_VERIFICATION') LIMIT 1`,
    )
  )
    throw new Error('存在仍需交付的旧部署配置，请在旧 Server 完成对应修复和更新。');
  if (
    db.get(`SELECT 1 FROM ${prefix}_update_batch batch
    WHERE json_extract(batch.deployment_json, '$.kind') = 'CI_CD'
      AND (NOT EXISTS (SELECT 1 FROM ${prefix}_update_attempt attempt WHERE attempt.batch_id = batch.id
        AND json_extract(attempt.outcome_json, '$.outcome') = 'PUSHED')
        OR NOT EXISTS (SELECT 1 FROM ${prefix}_external_deployment_report report WHERE report.batch_id = batch.id
          AND report.outcome = 'SUCCEEDED'))
    LIMIT 1`)
  )
    throw new Error('旧流水线批次缺少可核对的推送或人工确认记录。');
  return scripts;
}

/** Only runs inside the offline migrator's backed-up write transaction. */
export function migrateSchema32Deployment(
  db: AppDatabase,
  latestSchema: string,
  scripts: ReadonlyMap<string, string>,
): number {
  const reference = new Database(':memory:');
  try {
    reference.exec(latestSchema);
    db.exec(
      reference
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE name = 'platform_environment_deployment_cutover'",
        )
        .get()!.sql,
    );
    const appliedAt = new Date().toISOString();
    db.run(
      `INSERT INTO platform_environment_deployment_cutover
      SELECT id, deployment_json, ? FROM platform_environment
      WHERE json_extract(deployment_json, '$.kind') = 'CI_CD'`,
      [appliedAt],
    );
    const settings = db.prepare(`UPDATE platform_environment SET deployment_json = ?,
      version = version + CASE WHEN json_extract(deployment_json, '$.kind') = 'CI_CD' THEN 1 ELSE 0 END,
      updated_at = CASE WHEN json_extract(deployment_json, '$.kind') = 'CI_CD' THEN ? ELSE updated_at END
      WHERE id = ?`);
    for (const [id, command] of scripts)
      settings.run(JSON.stringify({ command }), appliedAt, id);

    const retireReceipt = db.prepare(
      "UPDATE platform_mutation SET operation = 'HISTORICAL_' || operation WHERE id = ?",
    );
    const receiptUpdate = db.prepare(
      'UPDATE platform_mutation SET result_json = ? WHERE id = ?',
    );
    for (const { id, result_json } of db.all<{ id: string; result_json: string }>(
      "SELECT id, result_json FROM platform_mutation WHERE operation IN ('ENVIRONMENT_CREATE', 'ENVIRONMENT_UPDATE')",
    )) {
      const {
        deployment,
        scriptCommand: _scriptCommand,
        ...receipt
      } = JSON.parse(result_json);
      const original = legacyDeployment.parse(deployment);
      if (original.kind === 'LOCAL_SCRIPT')
        receiptUpdate.run(
          JSON.stringify({ ...receipt, deployment: { command: original.command } }),
          id,
        );
      else retireReceipt.run(id);
    }

    // Old item and Bug snapshots must never be reinterpreted as a script that ran.
    rebuild(db, reference, 'submission_item', {
      deployment_json: scriptSnapshot('deployment_json'),
    });
    db.exec(`DELETE FROM submission_bug_deployment
      WHERE json_extract(deployment_json, '$.kind') = 'CI_CD';
      UPDATE submission_bug_deployment SET deployment_json = ${scriptSnapshot('deployment_json')};`);

    rebuild(db, reference, 'submission_update_batch', {
      deployment_json: scriptSnapshot('deployment_json'),
      historical_delivery_json: `CASE WHEN json_extract(deployment_json, '$.kind') = 'CI_CD' THEN
        json_object(
          'configuration', json(deployment_json),
          'confirmations', (SELECT json_group_array(json_object(
            'id', report.id, 'round', report.round, 'outcome', report.outcome,
            'summary', report.summary, 'reported_by_user_id', report.reported_by_user_id,
            'created_at', report.created_at,
            'continuedByAttemptId', (SELECT attempt.id FROM submission_update_attempt attempt
              WHERE attempt.continuation_report_id = report.id),
            'fileIds', (SELECT json_group_array(file_id) FROM (
              SELECT file_id FROM submission_external_deployment_report_attachment
              WHERE report_id = report.id ORDER BY position))
          ))
          FROM (SELECT * FROM submission_external_deployment_report
            WHERE batch_id = submission_update_batch.id ORDER BY round) report)
        ) END`,
    });

    const reportCount = db.get<{ count: number }>(
      'SELECT count(*) count FROM submission_external_deployment_report',
    )!.count;
    const attachmentCount = db.get<{ count: number }>(
      'SELECT count(*) count FROM submission_external_deployment_report_attachment',
    )!.count;
    const counts = db.get<{ reports: number; attachments: number }>(
      `SELECT count(*) reports, coalesce(sum(json_array_length(report.value, '$.fileIds')), 0) attachments
         FROM submission_update_batch
         JOIN json_each(historical_delivery_json, '$.confirmations') report`,
    )!;
    if (counts.reports !== reportCount || counts.attachments !== attachmentCount)
      throw new Error('历史部署确认或附件记录无法完整转换。');

    const historyFile = reference
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE name = 'submission_update_history_file'",
      )
      .get()!;
    db.exec(historyFile.sql);
    db.exec(`INSERT INTO submission_update_history_file(batch_id, file_id)
      SELECT report.batch_id, attachment.file_id
      FROM submission_external_deployment_report_attachment attachment
      JOIN submission_external_deployment_report report ON report.id = attachment.report_id`);

    rebuild(db, reference, 'submission_update_attempt', {
      outcome_json: `CASE WHEN json_extract(outcome_json, '$.outcome') = 'PUSHED'
        THEN json_set(outcome_json, '$.outcome', 'PUSH_CONFIRMED') ELSE outcome_json END`,
    });
    db.exec(`DROP TABLE submission_external_deployment_report_attachment;
      DROP TABLE submission_external_deployment_report;`);
    return reportCount;
  } finally {
    reference.close();
  }
}

function scriptSnapshot(column: string): string {
  return `CASE WHEN json_extract(${column}, '$.kind') = 'LOCAL_SCRIPT'
    THEN json_object('command', trim(json_extract(${column}, '$.command'))) END`;
}

function rebuild(
  db: AppDatabase,
  reference: Database,
  table: string,
  replacements: Record<string, string>,
): void {
  const objects = reference
    .query<{ sql: string; type: string }, [string]>(
      'SELECT sql, type FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL',
    )
    .all(table);
  const definition = objects.find(({ type }) => type === 'table')!.sql;
  const columns = reference
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map(({ name }) => name);
  const temporary = `${table}_migrating`;
  db.exec(definition.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${temporary}`));
  db.exec(`INSERT INTO ${temporary} (rowid, ${columns.join(', ')})
    SELECT rowid, ${columns.map((column) => replacements[column] ?? column).join(', ')}
    FROM ${table}`);
  db.exec(`DROP TABLE ${table}; ALTER TABLE ${temporary} RENAME TO ${table};`);
  for (const object of objects) if (object.type === 'index') db.exec(object.sql);
}
