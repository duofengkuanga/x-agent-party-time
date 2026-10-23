import type { Execution, ExecutionState } from '@agent-party-time/execution-contract';
import { PlatformError } from '@/server/platform/errors/index';
import type {
  SubmissionInteractionView,
  SubmissionVisualPresentation,
} from '@/contracts/shared';
import {
  interactionVisual,
  queueVisual,
} from '@/server/submissions/shared/executionVisual';
import {
  RepairExecutionResultSchema,
  ManualOperationsSchema,
} from '../../../contracts/submissions/repair';
import type { AttemptRow } from './repairQueries';

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
  if (raw.outcome === 'HANDED_OFF')
    return {
      outcome: 'HANDED_OFF' as const,
      questions: technical ? raw.questions : null,
    };
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
      technical && typeof raw.technicalFailure === 'string' ? raw.technicalFailure : null,
  };
}

export function repairVisual(
  latest: AttemptRow | undefined,
  interactions: SubmissionInteractionView[],
  responsible: boolean,
  idleLabel: string,
  queue: { state: Execution['state']; aheadCount: number } | undefined,
): SubmissionVisualPresentation {
  const interaction = interactionVisual(interactions, latest?.state, responsible, '修复');
  if (interaction) return interaction;
  if (latest?.state === 'HANDED_OFF')
    return { state: 'NEEDS_INPUT', label: '等待人工确认', symbol: '?' };
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

export function isSynchronizableAttempt(outcomeJson: string | null): boolean {
  if (!outcomeJson) return false;
  const outcome = (JSON.parse(outcomeJson) as { outcome?: string }).outcome;
  return outcome === 'FAILED' || outcome === 'HANDED_OFF';
}

export function isRepairExecution(execution: Execution): boolean {
  return (
    execution.owner.namespace === 'submissions' && execution.owner.kind === 'BUG_REPAIR'
  );
}

export function staleRepair(): PlatformError {
  return new PlatformError('STALE_STATE', '缺陷已更新，请刷新后重试');
}

const REPAIR_STATE_LABELS: Record<ExecutionState, string> = {
  QUEUED: '等待 Agent',
  CLAIMED: '正在准备修复',
  RUNNING: '正在修复',
  WAITING_FOR_INTERACTION: '等待工程负责人处理',
  WAITING_TO_RESUME: '等待继续',
  CANCEL_REQUESTED: '正在停止',
  SUCCEEDED: '修复已完成',
  FAILED: '修复未完成',
  CANCELLED: '修复已停止',
  HANDED_OFF: '等待人工确认',
};

export function repairStateLabel(state: ExecutionState): string {
  return REPAIR_STATE_LABELS[state];
}

export function parseCommits(value: string): string[] {
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string'))
    throw new PlatformError('INTERNAL_ERROR', '待提交记录无效');
  return parsed;
}

export function parseStoredManualOperations(value: string, message: string) {
  try {
    return ManualOperationsSchema.parse(JSON.parse(value));
  } catch {
    throw new PlatformError('INTERNAL_ERROR', message);
  }
}
