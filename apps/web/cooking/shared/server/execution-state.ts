import { PlatformError } from '@/platform/errors';
import type { Execution } from '@agent-party-time/execution-contract';

export function requireTaskSkillBinding(
  execution: Execution,
  task: '修复' | '更新',
) {
  const binding =
    execution.codexTurn?.kind === 'CONTINUATION' ||
    execution.codexTurn?.kind === 'INITIAL'
      ? execution.codexTurn.taskSkillBinding
      : null;
  if (!binding)
    throw new PlatformError(
      'INVALID_TRANSITION',
      `原${task}任务缺少规则关联，不能继续`,
    );
  return binding;
}

export function isTerminal(state: Execution['state']): boolean {
  return state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED';
}

export function asDetails(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
