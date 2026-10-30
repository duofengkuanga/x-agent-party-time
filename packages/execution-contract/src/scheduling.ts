import type { Execution } from './index';

export type ExecutionAccess = Pick<
  Execution,
  'bindingId' | 'workspace' | 'sessionId' | 'codexTurn'
>;

function taskId(execution: ExecutionAccess): string | null {
  return (
    execution.sessionId ??
    (execution.codexTurn && execution.codexTurn.kind !== 'INITIAL'
      ? execution.codexTurn.taskId
      : null)
  );
}

/** A branch lane and a detached lane may run together in distinct workspaces. */
export function executionsConflict(
  left: ExecutionAccess,
  right: ExecutionAccess,
): boolean {
  const session = taskId(left);
  if (session && session === taskId(right)) return true;
  const a = left.workspace;
  const b = right.workspace;
  if (a && b && a.key === b.key) return true;
  if (left.bindingId !== right.bindingId) return false;
  if (!a || !b) return true;
  if (a.isolation === 'CLEANUP_WORKTREES') {
    if (b.isolation === 'CLEANUP_WORKTREES') return true;
    return a.workspaceKeys.includes(b.key);
  }
  if (b.isolation === 'CLEANUP_WORKTREES') return b.workspaceKeys.includes(a.key);
  return a.isolation === b.isolation;
}

/** Keep one of the three local slots available for a detached execution. */
export function hasExecutionCapacity(
  candidate: ExecutionAccess,
  active: readonly ExecutionAccess[],
): boolean {
  return (
    candidate.workspace?.isolation !== 'BRANCH_WORKTREE' ||
    active.filter((entry) => entry.workspace?.isolation === 'BRANCH_WORKTREE').length < 2
  );
}
