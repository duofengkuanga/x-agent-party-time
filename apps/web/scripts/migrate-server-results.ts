import type { AppDatabase } from '@/platform/database';
import { RepairExecutionResultSchema } from '@/cooking/repair/contract';
import {
  CiCdUpdateExecutionResultSchema,
  LocalScriptUpdateExecutionResultSchema,
} from '@/cooking/update/contract';
import { freezeRepairHandoffs } from '@/cooking/update/server/repair-handoffs';
import { ExecutionOutcomeSchema } from '@agent-party-time/execution-contract';

export type ResultRewrite = {
  table: string;
  rowid: number;
  column: string;
  before: string;
  after: string;
};
type Result = Record<string, unknown>;
type Kind = 'repair' | 'update';

function record(value: unknown): Result {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('历史执行结果结构不完整，无法无损转换。');
  return value as Result;
}

function normalizeResult(value: unknown, kind: Kind): Result {
  const result = { ...record(value) };
  if (kind === 'repair') {
    if (
      result.outcome === 'COMPLETED' &&
      result.completionKind === 'CHANGES_COMMITTED' &&
      !('handoff' in result)
    ) {
      result.handoff = {
        validationCommands: [],
        environmentNotes: [],
        impact: [],
        remainingWork: [],
        limitations: [
          '由旧版历史记录迁入；旧版本未记录交接命令、环境经验、影响范围和剩余事项，现有验证摘要不代表最终组合已通过验收。',
        ],
      };
    }
    const { technicalFailure: _technicalFailure, ...contract } = result;
    if (!RepairExecutionResultSchema.safeParse({ result: contract }).success)
      throw new Error('历史修复结果无法无损转换为当前契约，迁移已中止。');
  } else {
    if (!('handoffUse' in result))
      result.handoffUse = { adopted: [], rechecked: [], validationCommands: [] };
    const { technicalFailure: _technicalFailure, ...contract } = result;
    const schema =
      result.outcome === 'PUSHED'
        ? CiCdUpdateExecutionResultSchema
        : LocalScriptUpdateExecutionResultSchema;
    if (!schema.safeParse({ result: contract }).success)
      throw new Error('历史更新结果无法无损转换为当前契约，迁移已中止。');
  }
  return result;
}

/** Add only facts derivable from existing rows; never invent past command execution. */
export function rewriteHistoricalResults(db: AppDatabase): ResultRewrite[] {
  const changes: ResultRewrite[] = [];
  const save = (
    table: string,
    rowid: number,
    column: string,
    before: string,
    value: unknown,
  ) => {
    const after = JSON.stringify(value);
    if (after === before) return;
    assertOriginalFacts(JSON.parse(before), value);
    db.run(`UPDATE ${table} SET ${column}=? WHERE rowid=?`, [after, rowid]);
    changes.push({ table, rowid, column, before, after });
  };
  for (const [table, kind] of [
    ['cooking_repair_attempt', 'repair'],
    ['cooking_update_attempt', 'update'],
  ] as const) {
    for (const row of db.all<{ rowid: number; outcome_json: string }>(
      `SELECT rowid, outcome_json FROM ${table} WHERE outcome_json IS NOT NULL`,
    ))
      save(
        table,
        row.rowid,
        'outcome_json',
        row.outcome_json,
        normalizeResult(JSON.parse(row.outcome_json), kind),
      );
  }
  const repairSyncs = new Set(
    db
      .all<{ execution_id: string }>(
        'SELECT execution_id FROM cooking_repair_session_sync',
      )
      .map((row) => row.execution_id),
  );
  const updateSyncs = new Set(
    db
      .all<{ execution_id: string }>(
        'SELECT execution_id FROM cooking_update_session_sync',
      )
      .map((row) => row.execution_id),
  );
  for (const row of db.all<{
    rowid: number;
    id: string;
    owner_kind: string;
    outcome_json: string | null;
    reported_outcome_json: string | null;
  }>(
    "SELECT rowid, id, owner_kind, outcome_json, reported_outcome_json FROM platform_execution WHERE owner_namespace='cooking'",
  )) {
    const kind: Kind | null =
      row.owner_kind === 'BUG_REPAIR' || repairSyncs.has(row.id)
        ? 'repair'
        : row.owner_kind === 'UPDATE_BATCH' || updateSyncs.has(row.id)
          ? 'update'
          : null;
    if (!kind) continue;
    for (const column of ['outcome_json', 'reported_outcome_json'] as const) {
      const before = row[column];
      if (!before) continue;
      const outcome = record(JSON.parse(before));
      if (outcome.kind !== 'SUCCEEDED') continue;
      const envelope = record(outcome.result);
      const result =
        row.owner_kind === 'SESSION_SYNC' ? record(envelope.result) : envelope;
      result.result = normalizeResult(result.result, kind);
      if (!ExecutionOutcomeSchema.safeParse(outcome).success)
        throw new Error('转换后的执行结果不符合当前契约。');
      save('platform_execution', row.rowid, column, before, outcome);
    }
  }
  for (const entry of db.all<{ batch_id: string; bug_id: string; commits_json: string }>(
    'SELECT batch_id, bug_id, commits_json FROM cooking_update_batch_entry ORDER BY batch_id, position',
  )) {
    const sources = freezeRepairHandoffs(
      db,
      entry.bug_id,
      JSON.parse(entry.commits_json),
    );
    db.run(
      'UPDATE cooking_update_batch_entry SET handoffs_json=? WHERE batch_id=? AND bug_id=?',
      [JSON.stringify(sources), entry.batch_id, entry.bug_id],
    );
  }
  return changes;
}

function assertOriginalFacts(before: unknown, after: unknown): void {
  if (Array.isArray(before)) {
    if (!Array.isArray(after) || after.length !== before.length)
      throw new Error('迁移不得删除或替换历史列表。');
    before.forEach((value, index) => assertOriginalFacts(value, after[index]));
  } else if (before && typeof before === 'object') {
    const target = record(after);
    for (const [key, value] of Object.entries(before)) {
      if (!(key in target)) throw new Error('迁移不得删除历史字段。');
      assertOriginalFacts(value, target[key]);
    }
  } else if (before !== after) {
    throw new Error('迁移不得改写历史事实。');
  }
}
