import type { Execution } from '@agent-party-time/execution-contract';
import { PlatformError } from '@/platform/errors';
import { parseStoredManualOperations } from '@/cooking/shared/server/result-data';
import type {
  CookingInteractionView,
  CookingVisualPresentation,
} from '@/cooking/shared/contract';
import {
  interactionVisual,
  queueVisual,
} from '@/cooking/shared/server/execution-visual';
import { RepairExecutionResultSchema } from '../contract';
import type { AttemptRow } from './records';

export function formatRepairContractIssues(
  issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>,
): string {
  return issues
    .map(
      ({ path, message }) =>
        `${path.length ? path.map(String).join('.') : '$'}: ${message}`,
    )
    .join('; ')
    .slice(0, 3_500);
}

export function projectAttemptResult(outcomeJson: string, technical: boolean) {
  const raw = JSON.parse(outcomeJson) as Record<string, unknown>;
  const { technicalFailure: _technicalFailure, ...contractResult } = raw;
  const parsed = RepairExecutionResultSchema.safeParse({
    result: contractResult,
  });
  if (!parsed.success)
    throw new PlatformError('INTERNAL_ERROR', '已保存的修复记录结果格式无效');
  const result = parsed.data.result;
  if (result.outcome === 'COMPLETED')
    return {
      outcome: result.outcome,
      changes: result.changes,
      validations: result.validations,
      warnings: result.warnings,
      commitCount: result.commits.length,
      commits: technical ? result.commits : null,
    };
  return {
    outcome: result.outcome,
    failedStep: result.failedStep,
    reason:
      !technical &&
      typeof raw.technicalFailure === 'string' &&
      raw.technicalFailure !== 'CANCELLED'
        ? '自动修复执行未完成，工程负责人可查看详细原因。'
        : result.reason,
    completedActions: result.completedActions,
    pendingActions: result.pendingActions,
    failureCode:
      technical && typeof raw.technicalFailure === 'string'
        ? raw.technicalFailure
        : null,
  };
}

export function repairVisual(
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
    '修复',
  );
  if (interaction) return interaction;
  if (
    latest?.state === 'FAILED' ||
    (latest?.outcome_json && isFailedAttemptOutcome(latest.outcome_json))
  )
    return { state: 'FAILED', label: '自动修复未完成', symbol: '×' };
  if (latest?.state === 'QUEUED') return queueVisual(queue?.aheadCount);
  if (latest?.state === 'WAITING_TO_RESUME')
    return { state: 'WAITING_TO_RESUME', label: '等待继续', symbol: 'Ⅱ' };
  if (latest && ['CLAIMED', 'RUNNING'].includes(latest.state))
    return { state: 'RUNNING', label: '正在自动处理', symbol: '●' };
  if (latest && ['CANCEL_REQUESTED', 'CANCELLED'].includes(latest.state))
    return {
      state: 'WAITING_TO_RESUME',
      label: '等待重新处理',
      symbol: 'Ⅱ',
    };
  return { state: 'IDLE', label: idleLabel, symbol: '·' };
}

export function isFailedAttemptOutcome(outcomeJson: string): boolean {
  const raw = JSON.parse(outcomeJson) as Record<string, unknown>;
  return raw.outcome === 'FAILED';
}

export function parseManualOperations(value: string): Array<{
  kind: 'DATABASE_SQL';
  paths: string[];
}> {
  return parseStoredManualOperations(value, '待执行的人工操作记录无效');
}

export function isRepairExecution(execution: Execution): boolean {
  return (
    execution.owner.namespace === 'cooking' &&
    execution.owner.kind === 'BUG_REPAIR'
  );
}

export function staleRepair(): PlatformError {
  return new PlatformError('STALE_STATE', '缺陷已更新，请刷新后重试');
}
