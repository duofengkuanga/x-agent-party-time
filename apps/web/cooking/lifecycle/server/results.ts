import { type Execution } from '@agent-party-time/execution-contract';
import { PlatformError } from '@/platform/errors';
import { CleanupExecutionResultSchema } from '../contract';
import type { CleanupSourceRow } from './records';

export function isCleanupExecution(execution: Execution): boolean {
  return (
    execution.owner.namespace === 'cooking' &&
    execution.owner.kind === 'CLEANUP'
  );
}

export function isTerminal(state: Execution['state']): boolean {
  return state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED';
}

export function parseWorkspaceKeys(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((item) => typeof item !== 'string' || !item.trim())
  )
    throw new PlatformError(
      'INVALID_TRANSITION',
      '清理任务缺少有效的逻辑工作区范围',
    );
  return [...new Set(parsed)];
}

export function interpretCleanup(execution: Execution): {
  kind: 'COMPLETED' | 'FAILED';
  outcome: unknown;
} {
  if (execution.outcome?.kind === 'SUCCEEDED') {
    const parsed = CleanupExecutionResultSchema.safeParse(
      execution.outcome.result,
    );
    if (parsed.success)
      return {
        kind: parsed.data.outcome,
        outcome: parsed.data,
      };
    return {
      kind: 'FAILED',
      outcome: {
        outcome: 'FAILED',
        summary: '清理结果格式无效',
        technicalFailure: 'RESULT_SCHEMA_INVALID',
      },
    };
  }
  return {
    kind: 'FAILED',
    outcome: {
      outcome: 'FAILED',
      summary:
        execution.outcome?.kind === 'CANCELLED'
          ? '清理执行已停止，可由工程负责人重试。'
          : '清理执行未完成，可由工程负责人重试。',
      technicalFailure:
        execution.outcome?.kind === 'FAILED'
          ? execution.outcome.failure.code
          : execution.outcome?.kind,
    },
  };
}

export function cleanupStateLabel(state: CleanupSourceRow['state']): string {
  return {
    READY: '等待 Agent 清理',
    RUNNING: '正在清理本机临时资源',
    FAILED: '资源清理未完成，不影响业务终态',
    COMPLETED: '本机临时资源已清理',
  }[state];
}

export function staleLifecycle(target: string): PlatformError {
  return new PlatformError('STALE_STATE', `${target}已变化，请刷新后重试`);
}
