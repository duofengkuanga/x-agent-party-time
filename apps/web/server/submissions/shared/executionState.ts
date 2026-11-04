import { PlatformError } from '@/server/platform/errors/index';
import type { Execution } from '@agent-party-time/execution-contract';
import type { AppDatabase } from '@/server/database/index';

export function originalTaskExecution(
  get: (id: string) => Execution,
  latest: Execution,
): Execution {
  let execution = latest;
  const visited = new Set<string>();
  while (execution.codexTurn?.kind === 'READ_SESSION') {
    const id = execution.previousExecutionId;
    if (!id || visited.has(id))
      throw new PlatformError('INVALID_TRANSITION', '原会话的执行记录不完整');
    visited.add(id);
    execution = get(id);
  }
  return execution;
}

export function requireTaskSkillBinding(execution: Execution, task: '修复' | '更新') {
  const binding =
    execution.codexTurn?.kind === 'CONTINUATION' ||
    execution.codexTurn?.kind === 'INITIAL'
      ? execution.codexTurn.taskSkillBinding
      : null;
  if (!binding)
    throw new PlatformError('INVALID_TRANSITION', `原${task}任务缺少规则关联，不能继续`);
  return binding;
}

export function isTerminal(state: Execution['state']): boolean {
  return state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED';
}

export function markInvalidExecutionResult(
  db: AppDatabase,
  executionId: string,
  message: string,
): void {
  db.run(
    `UPDATE platform_execution
       SET state = 'FAILED', outcome_json = ? WHERE id = ?`,
    [
      JSON.stringify({
        kind: 'FAILED',
        failure: {
          code: 'CODEX_EXECUTION_FAILED',
          message,
          retryable: true,
        },
      }),
      executionId,
    ],
  );
}

export function asDetails(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
