import type { ExecutionState } from '@agent-party-time/execution-contract';

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
};

export function repairStateLabel(state: ExecutionState): string {
  return REPAIR_STATE_LABELS[state];
}
