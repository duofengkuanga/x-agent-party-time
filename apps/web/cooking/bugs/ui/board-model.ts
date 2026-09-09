'use client';

import { createClientId } from '@/cooking/shared/ui/client-id';
import type { CookingWorkspaceSnapshot } from '@/cooking/workspace/contract';
import {
  verifyBugAction,
  type BugLifecycleActionResult,
} from '@/cooking/lifecycle/server/actions';
import type { BugRepairView } from '@/cooking/repair/contract';
import { type RepairActionResult } from '@/cooking/repair/server/actions';
import type { UpdateBatchView } from '@/cooking/update/contract';
import { type UpdateActionResult } from '@/cooking/update/server/actions';
import type { BugView } from '../contract';
import { requestRepairAction, type BugActionResult } from '../server/actions';

export const STATUS_COLUMNS = [
  { status: 'WAITING_FOR_REPAIR', label: '待修复', note: '录入' },
  { status: 'REPAIRING', label: '修复中', note: '修复' },
  { status: 'WAITING_FOR_UPDATE', label: '待更新', note: '批次' },
  { status: 'UPDATING', label: '更新中', note: '交付' },
  { status: 'WAITING_FOR_VERIFICATION', label: '待验证', note: '测试' },
  { status: 'DONE', label: '已完成', note: '完成' },
] as const;

export const TRANSIENT_NOTICE_MS = 3_000;

export type MainStage = (typeof STATUS_COLUMNS)[number]['status'];

export type Drawer =
  | { mode: 'create' }
  | { mode: 'view' | 'edit'; bugId: string }
  | { mode: 'batch'; batchId: string };

export type WorkspaceActionResult =
  | BugActionResult
  | RepairActionResult
  | UpdateActionResult
  | BugLifecycleActionResult;

export type UndoAction = {
  message: string;
  successMessage: string;
  command: () => Promise<WorkspaceActionResult>;
};

export type BugFeedbackIntent = {
  bugId: string;
  kind: 'VERIFY_FAIL' | 'REOPEN';
};

export function dragTransition(bug: BugView, target: MainStage) {
  if (
    target === 'REPAIRING' &&
    bug.stage === 'WAITING_FOR_REPAIR' &&
    bug.availableActions.includes('REQUEST_REPAIR')
  )
    return {
      command: () =>
        requestRepairAction(bug.id, {
          mutationId: createClientId(),
          expectedVersion: bug.version,
        }),
      message: `${bugLabel(bug)} 已提交自动修复。`,
    };
  if (
    target === 'DONE' &&
    bug.stage === 'WAITING_FOR_VERIFICATION' &&
    bug.availableActions.includes('VERIFY_PASS')
  )
    return {
      command: () => {
        const formData = new FormData();
        formData.set('mutationId', createClientId());
        formData.set('expectedVersion', String(bug.version));
        formData.set('result', 'PASSED');
        return verifyBugAction(bug.id, formData);
      },
      message: `${bugLabel(bug)} 已验证完成。`,
    };
  return null;
}

export function drawerTitle(mode: Drawer['mode'], bug: BugView | null): string {
  if (mode === 'create') return '登记缺陷';
  if (mode === 'edit') return '编辑缺陷';
  if (mode === 'batch') return '统一更新批次详情';
  return bug?.report.title ?? '缺陷详情';
}

export function bugLabel(bug: BugView): string {
  return `缺陷-${String(bug.shortId).padStart(3, '0')}`;
}

export function pendingDeliveryFor(
  bug: BugView,
  snapshot: CookingWorkspaceSnapshot,
) {
  const submissionItemId = bug.assignment?.submissionItemId;
  return submissionItemId
    ? snapshot.pendingDeliveries.find(
        (candidate) => candidate.submissionItemId === submissionItemId,
      )
    : undefined;
}

export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  if (totalSeconds <= 0) return '正在准备统一更新';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} 秒后开始更新`;
  if (seconds === 0) return `${minutes} 分钟后开始更新`;
  return `${minutes} 分 ${seconds} 秒后开始更新`;
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value));
}

export function deploymentLabel(
  kind: UpdateBatchView['deploymentKind'],
): string {
  return kind === 'LOCAL_SCRIPT' ? '本地脚本部署' : '持续集成部署';
}

export function engineeringTypeLabel(
  engineeringType?: NonNullable<BugView['assignment']>['engineeringType'],
): string {
  if (!engineeringType) return '待分配';
  return engineeringType === 'FRONTEND' ? '前端' : '后端';
}

export function updateAttemptLabel(
  attempt: Extract<
    UpdateBatchView['timeline'][number],
    { kind: 'UPDATE_ATTEMPT' }
  >,
): string {
  if (attempt.result?.outcome === 'COMPLETED')
    return `第 ${attempt.attempt} 轮统一更新已完成`;
  if (attempt.result?.outcome === 'PUSHED')
    return `第 ${attempt.attempt} 轮已 Push，等待外部结果`;
  if (attempt.result?.outcome === 'FAILED')
    return `第 ${attempt.attempt} 轮统一更新未完成`;
  return `第 ${attempt.attempt} 轮统一更新进行中`;
}

export function validationLabel(
  status: 'PASSED' | 'FAILED' | 'SKIPPED',
): string {
  return {
    PASSED: '通过',
    FAILED: '失败',
    SKIPPED: '跳过',
  }[status];
}

export function repairStateLabel(
  state: Extract<
    BugRepairView['timeline'][number],
    { kind: 'REPAIR_ATTEMPT' }
  >['executionState'],
): string {
  return {
    QUEUED: '等待 Agent',
    CLAIMED: '正在准备修复',
    RUNNING: '正在修复',
    WAITING_FOR_INTERACTION: '等待工程负责人处理',
    WAITING_TO_RESUME: '等待继续',
    CANCEL_REQUESTED: '正在停止',
    SUCCEEDED: '修复已完成',
    FAILED: '修复未完成',
    CANCELLED: '修复已停止',
  }[state];
}

export function stopCardAction(action: () => void) {
  return (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    action();
  };
}

export function bugVersionOf(result: WorkspaceActionResult): number | null {
  return result.ok && 'bugVersion' in result.result
    ? result.result.bugVersion
    : null;
}

export function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
