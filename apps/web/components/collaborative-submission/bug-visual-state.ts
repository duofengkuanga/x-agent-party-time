import type { SubmissionBug } from '@agent-party-time/shared/control-plane';

type VisualBug = Pick<
  SubmissionBug,
  'status' | 'repairActivity' | 'updateActivity' | 'latestRepairFailed'
>;

export type BugVisualState =
  | 'failed'
  | 'queued'
  | 'preparing'
  | 'running'
  | 'waiting-interaction'
  | 'idle';

export type BugVisualPresentation = {
  state: BugVisualState;
  label: string;
};

export function bugVisualPresentation(bug: VisualBug): BugVisualPresentation {
  if (bug.status === 'WAITING_FOR_REPAIR' && bug.latestRepairFailed)
    return { state: 'failed', label: '最近一次修复失败' };
  if (bug.repairActivity === 'QUEUED')
    return { state: 'queued', label: '等待修复' };
  if (bug.repairActivity === 'PREPARING')
    return { state: 'preparing', label: '正在启动修复' };
  if (bug.repairActivity === 'RUNNING')
    return { state: 'running', label: 'Codex 正在修复' };
  if (bug.repairActivity === 'WAITING_INTERACTION')
    return { state: 'waiting-interaction', label: '等待开发负责人处理' };

  if (bug.updateActivity === 'QUEUED')
    return { state: 'queued', label: '等待更新' };
  if (bug.updateActivity === 'RUNNING')
    return { state: 'running', label: 'Codex 正在更新' };
  if (bug.updateActivity === 'WAITING_INTERACTION')
    return {
      state: 'waiting-interaction',
      label: '更新等待开发负责人处理',
    };
  if (bug.updateActivity === 'WAITING_EXTERNAL')
    return {
      state: 'waiting-interaction',
      label: '等待开发负责人确认外部更新',
    };
  if (bug.updateActivity === 'FAILED')
    return { state: 'failed', label: '更新失败，等待开发负责人处理' };

  return { state: 'idle', label: '缺陷卡片' };
}
