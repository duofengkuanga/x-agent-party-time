import { CommittedRepairResultSchema } from '@/cooking/repair/contract';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import type { FrozenRepairHandoff } from '../contract';

/** Runs inside the batch transaction; source results and membership freeze together. */
export function freezeRepairHandoffs(
  db: AppDatabase,
  bugId: string,
  commits: string[],
): FrozenRepairHandoff[] {
  const pending = new Set(commits);
  const sources: FrozenRepairHandoff[] = [];
  const invalid = () =>
    new PlatformError('INTERNAL_ERROR', '修复交接缺失或与候选提交不一致，统一更新未启动');
  for (const row of db.all<{ id: string; execution_id: string; outcome_json: string }>(
    `SELECT id, execution_id, outcome_json FROM cooking_repair_attempt
     WHERE bug_id = ? AND outcome_json IS NOT NULL ORDER BY attempt`,
    bugId,
  )) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.outcome_json);
    } catch {
      throw invalid();
    }
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('outcome' in raw) ||
      raw.outcome !== 'COMPLETED'
    )
      continue;
    if (!('commits' in raw) || !Array.isArray(raw.commits)) throw invalid();
    if (!raw.commits.some((commit) => pending.has(commit))) continue;
    const parsed = CommittedRepairResultSchema.safeParse(raw);
    if (!parsed.success || parsed.data.commits.some((commit) => !pending.has(commit)))
      throw invalid();
    const {
      changes,
      validations,
      warnings,
      handoff,
      commits: sourceCommits,
    } = parsed.data;
    sources.push({
      attemptId: row.id,
      executionId: row.execution_id,
      commits: sourceCommits,
      changes,
      validations,
      warnings,
      handoff,
    });
  }
  const covered = sources.flatMap((source) => source.commits);
  if (
    !commits.length ||
    covered.length !== commits.length ||
    new Set(covered).size !== covered.length ||
    covered.some((commit, index) => commit !== commits[index])
  )
    throw invalid();
  return sources;
}
