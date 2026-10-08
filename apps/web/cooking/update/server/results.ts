import type { Execution } from '@agent-party-time/execution-contract';
import { PlatformError } from '@/platform/errors';
import { ManualOperationsSchema } from '@/cooking/repair/contract';
import type {
  CookingInteractionView,
  CookingVisualPresentation,
} from '@/cooking/shared/contract';
import {
  interactionVisual,
  queueVisual,
} from '@/cooking/shared/server/execution-visual';
import type { BatchRow, AttemptRow } from './records';

export function parseCommits(value: string): string[] {
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string'))
    throw new PlatformError('INTERNAL_ERROR', '待提交记录无效');
  return parsed;
}

export function parseManualOperations(value: string) {
  try {
    return ManualOperationsSchema.parse(JSON.parse(value));
  } catch {
    throw new PlatformError('INTERNAL_ERROR', '更新批次的人工操作记录无效');
  }
}

export function projectUpdateAttemptResult(
  outcomeJson: string,
  technical: boolean,
) {
  const outcome = JSON.parse(outcomeJson) as Record<string, unknown>;
  if (outcome.outcome === 'COMPLETED' || outcome.outcome === 'PUSHED')
    return {
      outcome: outcome.outcome,
      completedActions: stringArray(outcome.completedActions),
      validations: Array.isArray(outcome.validations)
        ? outcome.validations
        : [],
      warnings: stringArray(outcome.warnings),
    };
  return {
    outcome: 'FAILED' as const,
    failedStep:
      typeof outcome.failedStep === 'string'
        ? outcome.failedStep
        : '执行统一更新',
    reason:
      !technical &&
      typeof outcome.technicalFailure === 'string' &&
      outcome.technicalFailure !== 'CANCELLED'
        ? '统一更新执行未完成，工程负责人可查看详细原因。'
        : typeof outcome.reason === 'string'
          ? outcome.reason
          : '统一更新未完成',
    completedActions: stringArray(outcome.completedActions),
    validations: Array.isArray(outcome.validations) ? outcome.validations : [],
    warnings: stringArray(outcome.warnings),
    pendingActions: stringArray(outcome.pendingActions),
    failureCode:
      technical && typeof outcome.technicalFailure === 'string'
        ? outcome.technicalFailure
        : null,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function isUpdateExecution(execution: Execution): boolean {
  return (
    execution.owner.namespace === 'cooking' &&
    execution.owner.kind === 'UPDATE_BATCH'
  );
}

export function batchStateLabel(state: BatchRow['state']): string {
  return {
    READY: '等待 Agent',
    RUNNING: '正在统一更新',
    WAITING_EXTERNAL: '等待外部部署结果',
    FAILED: '统一更新未完成',
    COMPLETED: '统一更新已完成',
  }[state];
}

export function updateVisual(
  batch: BatchRow,
  latest: AttemptRow | undefined,
  interactions: CookingInteractionView[],
  responsible: boolean,
  idleLabel: string,
  queue: { state: Execution['state']; aheadCount: number } | undefined,
): CookingVisualPresentation {
  const interaction = interactionVisual(
    interactions,
    latest?.state,
    responsible,
    '更新',
  );
  if (interaction) return interaction;
  if (batch.state === 'FAILED' || latest?.state === 'FAILED')
    return { state: 'FAILED', label: '统一更新未完成', symbol: '×' };
  if (batch.state === 'READY' || latest?.state === 'QUEUED')
    return queueVisual(queue?.aheadCount);
  if (latest?.state === 'WAITING_TO_RESUME')
    return { state: 'WAITING_TO_RESUME', label: '等待继续', symbol: 'Ⅱ' };
  if (latest && ['CLAIMED', 'RUNNING'].includes(latest.state))
    return { state: 'RUNNING', label: '正在自动处理', symbol: '●' };
  if (
    batch.state === 'WAITING_EXTERNAL' ||
    (latest && ['CANCEL_REQUESTED', 'CANCELLED'].includes(latest.state))
  )
    return {
      state: 'WAITING_TO_RESUME',
      label:
        batch.state === 'WAITING_EXTERNAL' ? '等待部署结果' : '等待重新处理',
      symbol: 'Ⅱ',
    };
  return { state: 'IDLE', label: idleLabel, symbol: '·' };
}

export function staleBatch(): PlatformError {
  return new PlatformError('STALE_STATE', '更新批次已变化，请刷新后重试');
}
