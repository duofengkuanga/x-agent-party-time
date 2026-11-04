import type { ExecutionWorkspaceMember } from '@agent-party-time/execution-contract';
import type { AppDatabase } from '@/server/database/index';

export function personAgentCleanupHeads(
  db: AppDatabase,
  submissionId: string,
  bindingId: string,
): Record<string, string | null> {
  const executions = db.all<{ workspace_json: string; outcome_json: string | null }>(
    `SELECT execution.workspace_json, attempt.outcome_json, execution.created_at, attempt.attempt
       FROM submission_repair_attempt attempt
       JOIN submission_bug bug ON bug.id = attempt.bug_id
       JOIN platform_execution execution ON execution.id = attempt.execution_id
       WHERE bug.submission_id = ?
     UNION ALL
     SELECT execution.workspace_json, attempt.outcome_json, execution.created_at, attempt.attempt
       FROM submission_update_attempt attempt
       JOIN submission_update_batch batch ON batch.id = attempt.batch_id
       JOIN platform_execution execution ON execution.id = attempt.execution_id
       WHERE batch.submission_id = ?
     ORDER BY created_at, attempt`,
    submissionId,
    submissionId,
  );
  const heads: Record<string, string | null> = Object.create(null);
  for (const row of executions) {
    const members = JSON.parse(row.workspace_json) as ExecutionWorkspaceMember[];
    const index = members.findIndex((member) => member.bindingId === bindingId);
    const workspace = members[index]?.workspace;
    if (!workspace || workspace.isolation === 'CLEANUP_WORKTREES') continue;
    const result = row.outcome_json
      ? (JSON.parse(row.outcome_json) as {
          outcome?: string;
          repositories?: Record<string, { commits?: string[] }>;
          deliveries?: Record<string, { state?: string; commit?: string }>;
        })
      : null;
    if (!Object.hasOwn(heads, workspace.key)) heads[workspace.key] = null;
    if (result?.outcome !== 'COMPLETED') continue;
    const alias = `repo-${index + 1}`;
    if (result.repositories)
      heads[workspace.key] = result.repositories[alias]?.commits?.at(-1) ?? null;
    if (result.deliveries)
      heads[workspace.key] = result.deliveries[alias]?.commit ?? null;
  }
  return heads;
}
