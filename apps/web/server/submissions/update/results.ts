import type { Execution } from '@agent-party-time/execution-contract';
import { PlatformError } from '@/server/platform/errors/index';
import type {
  SubmissionInteractionView,
  SubmissionVisualPresentation,
} from '@/contracts/shared';
import {
  interactionVisual,
  queueVisual,
} from '@/server/submissions/shared/executionVisual';
import type { BatchRow, AttemptRow } from './updateQueries';
import { UpdateHandoffUseSchema } from '../../../contracts/submissions/update';

export function projectUpdateAttemptResult(outcomeJson: string, technical: boolean) {
  const outcome = JSON.parse(outcomeJson) as Record<string, unknown>;
  if (outcome.outcome === 'HANDED_OFF')
    return {
      outcome: 'HANDED_OFF' as const,
      questions: technical ? outcome.questions : null,
    };
  const engineeringDeliveries =
    technical && outcome.deliveries && typeof outcome.deliveries === 'object'
      ? Object.entries(outcome.deliveries).map(([alias, value]) => {
          const detail = value as {
            state: string;
            commit?: string;
            evidence?: string;
            receipt?: { artifactSha256?: string };
          };
          const labels: Record<string, string> = {
            NOT_STARTED: '未开始',
            VALIDATED: '验证通过',
            PUSHED: '已确认推送',
            DEPLOYED: '部署验收通过',
            UNKNOWN: '等待核实',
            FAILED: '执行失败',
            UNCHANGED: '无改动',
          };
          return {
            alias,
            label: labels[detail.state] ?? '等待核实',
            commit: detail.commit ?? null,
            evidence: detail.evidence ?? null,
            artifactSha256: detail.receipt?.artifactSha256 ?? null,
          };
        })
      : null;
  const engineering = engineeringDeliveries ? { engineeringDeliveries } : {};
  if (outcome.outcome === 'COMPLETED' || outcome.outcome === 'PUSH_CONFIRMED')
    return {
      ...engineering,
      outcome: outcome.outcome,
      completedActions: stringArray(outcome.completedActions),
      validations: Array.isArray(outcome.validations) ? outcome.validations : [],
      warnings: stringArray(outcome.warnings),
      handoffUse: technical ? UpdateHandoffUseSchema.parse(outcome.handoffUse) : null,
    };
  return {
    ...engineering,
    outcome: 'FAILED' as const,
    failedStep:
      typeof outcome.failedStep === 'string' ? outcome.failedStep : '执行统一更新',
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
    handoffUse:
      technical && !outcome.technicalFailure
        ? UpdateHandoffUseSchema.parse(outcome.handoffUse)
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
    execution.owner.namespace === 'submissions' && execution.owner.kind === 'UPDATE_BATCH'
  );
}

export function batchStateLabel(state: BatchRow['state']): string {
  return {
    READY: '已排队，等待 Agent 启动',
    RUNNING: '正在统一更新',
    FAILED: '统一更新未完成',
    COMPLETED: '统一更新已完成',
  }[state];
}

export function updateVisual(
  batch: BatchRow,
  latest: AttemptRow | undefined,
  interactions: SubmissionInteractionView[],
  responsible: boolean,
  idleLabel: string,
  queue: { state: Execution['state']; aheadCount: number } | undefined,
): SubmissionVisualPresentation {
  const interaction = interactionVisual(interactions, latest?.state, responsible, '更新');
  if (interaction) return interaction;
  if (latest?.state === 'HANDED_OFF')
    return { state: 'NEEDS_INPUT', label: '等待人工确认', symbol: '?' };
  if (batch.state === 'FAILED' || latest?.state === 'FAILED')
    return { state: 'FAILED', label: '统一更新未完成', symbol: '×' };
  if (batch.state === 'READY' || latest?.state === 'QUEUED')
    return { ...queueVisual(queue?.aheadCount), label: '已排队，等待 Agent 启动' };
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

export function staleBatch(): PlatformError {
  return new PlatformError('STALE_STATE', '更新批次已变化，请刷新后重试');
}

export function canRestartAfterSkillMismatch(
  batch: BatchRow,
  attempt: AttemptRow | undefined,
): boolean {
  return (
    batch.state === 'FAILED' &&
    !batch.session_id &&
    Boolean(
      attempt?.outcome_json &&
      JSON.parse(attempt.outcome_json).technicalFailure === 'SKILL_PROTOCOL_MISMATCH',
    )
  );
}
