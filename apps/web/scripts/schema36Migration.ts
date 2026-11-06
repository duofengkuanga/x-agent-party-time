import { z } from 'zod';
import type { AppDatabase } from '@/server/database/index';
import { FrozenRepairHandoffSchema } from '@/contracts/submissions/update';
import { projectAttemptResult } from '@/server/submissions/repair/results';
import { projectUpdateAttemptResult } from '@/server/submissions/update/results';
import { readPersonAgentUpdateScope } from '@/server/submissions/update/personAgentUpdate';
import type { ResultRewrite } from './migrateServerResults';

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return z.record(z.string(), z.unknown()).parse(value);
}

function normalizeResult(value: unknown, kind: 'repair' | 'update'): RecordValue {
  const result = record(value);
  if (kind === 'repair' && result.outcome === 'COMPLETED') {
    if ('repositories' in result) {
      const repositories = record(result.repositories);
      for (const [alias, repository] of Object.entries(repositories))
        repositories[alias] = normalizeResult(repository, 'repair');
      result.repositories = repositories;
    } else if (!('testingScope' in result)) result.testingScope = null;
  }
  if (
    kind === 'update' &&
    ['COMPLETED', 'PUSHED', 'PUSH_CONFIRMED'].includes(String(result.outcome))
  ) {
    if (!('testingScopes' in result)) result.testingScopes = [];
  }
  return result;
}

/** Build a read-only plan; absent historical evidence never becomes a READY review. */
export function planSchema36Migration(db: AppDatabase): ResultRewrite[] {
  const unfinished =
    db.get(`SELECT 1 FROM submission_bug WHERE stage NOT IN ('DONE', 'CANCELLED')
    UNION ALL SELECT 1 FROM submission_update_batch WHERE state <> 'COMPLETED'
    UNION ALL SELECT 1 FROM submission_pending_delivery
    UNION ALL SELECT 1 FROM platform_execution_interaction WHERE state='PENDING'
    UNION ALL SELECT 1 FROM platform_execution WHERE state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'HANDED_OFF')
      OR (state='HANDED_OFF' AND finished_at IS NULL)
    LIMIT 1`);
  if (unfinished)
    throw new Error('存在未完成的旧流程，请先用 Schema 36 对应版本完成；原数据已保留。');

  const changes: ResultRewrite[] = [];
  const plan = (
    table: string,
    rowid: number,
    column: string,
    before: string,
    value: unknown,
  ) => {
    const after = JSON.stringify(value);
    if (after !== before) changes.push({ table, rowid, column, before, after });
  };
  for (const [table, kind, project] of [
    ['submission_repair_attempt', 'repair', projectAttemptResult],
    ['submission_update_attempt', 'update', projectUpdateAttemptResult],
  ] as const) {
    for (const row of db.all<{ rowid: number; outcome_json: string }>(
      `SELECT rowid, outcome_json FROM ${table} WHERE outcome_json IS NOT NULL`,
    )) {
      const value = normalizeResult(JSON.parse(row.outcome_json), kind);
      project(JSON.stringify(value), true);
      plan(table, row.rowid, 'outcome_json', row.outcome_json, value);
    }
  }
  for (const row of db.all<{
    rowid: number;
    owner_kind: string;
    outcome_json: string | null;
    reported_outcome_json: string | null;
    sync_kind: string | null;
  }>(`SELECT execution.rowid, execution.owner_kind, execution.outcome_json, execution.reported_outcome_json,
    CASE WHEN repair.execution_id IS NOT NULL THEN 'repair' WHEN delivery.execution_id IS NOT NULL THEN 'update' END sync_kind
    FROM platform_execution execution
    LEFT JOIN submission_repair_session_sync repair ON repair.execution_id=execution.id
    LEFT JOIN submission_update_session_sync delivery ON delivery.execution_id=execution.id
    WHERE execution.owner_namespace='submissions'`)) {
    const kind =
      row.owner_kind === 'BUG_REPAIR'
        ? 'repair'
        : row.owner_kind === 'UPDATE_BATCH'
          ? 'update'
          : row.sync_kind;
    if (kind !== 'repair' && kind !== 'update') continue;
    for (const column of ['outcome_json', 'reported_outcome_json'] as const) {
      const before = row[column];
      if (!before) continue;
      const outcome = record(JSON.parse(before));
      if (outcome.kind !== 'SUCCEEDED') continue;
      const envelope = record(outcome.result);
      if (row.owner_kind === 'SESSION_SYNC') {
        const synchronized = record(envelope.result);
        synchronized.result = normalizeResult(synchronized.result, kind);
        envelope.result = synchronized;
      } else envelope.result = normalizeResult(envelope.result, kind);
      outcome.result = envelope;
      plan('platform_execution', row.rowid, column, before, outcome);
    }
  }
  for (const row of db.all<{ rowid: number; handoffs_json: string }>(
    'SELECT rowid, handoffs_json FROM submission_update_batch_entry',
  )) {
    const handoffs = z
      .array(z.record(z.string(), z.unknown()))
      .parse(JSON.parse(row.handoffs_json));
    for (const handoff of handoffs) {
      if (!('testingScope' in handoff)) handoff.testingScope = null;
      if (!('unchangedTestingScopes' in handoff)) handoff.unchangedTestingScopes = [];
    }
    FrozenRepairHandoffSchema.array().parse(handoffs);
    plan(
      'submission_update_batch_entry',
      row.rowid,
      'handoffs_json',
      row.handoffs_json,
      handoffs,
    );
  }
  for (const row of db.all<{ rowid: number; id: string; delivery_scope_json: string }>(
    'SELECT rowid, id, delivery_scope_json FROM submission_update_batch WHERE delivery_scope_json IS NOT NULL',
  )) {
    const members = z
      .array(z.record(z.string(), z.unknown()))
      .parse(JSON.parse(row.delivery_scope_json));
    const entries = db.all<{ position: number; commits_json: string }>(
      'SELECT position, commits_json FROM submission_update_batch_entry WHERE batch_id=? ORDER BY position',
      row.id,
    );
    for (const member of members) {
      if ('candidatePositions' in member) continue;
      const commits = z.array(z.string()).parse(member.candidateCommits);
      member.candidatePositions = entries
        .filter((entry) =>
          z
            .array(z.string())
            .parse(JSON.parse(entry.commits_json))
            .some((commit) => commits.includes(commit)),
        )
        .map(({ position }) => position);
      if (commits.length && !(member.candidatePositions as number[]).length)
        throw new Error('旧更新批次缺少候选关联，无法保留原有交付范围。');
    }
    readPersonAgentUpdateScope(JSON.stringify(members));
    plan(
      'submission_update_batch',
      row.rowid,
      'delivery_scope_json',
      row.delivery_scope_json,
      members,
    );
  }
  return changes;
}
