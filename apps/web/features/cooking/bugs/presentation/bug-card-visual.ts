import type { ExecutionState } from '@agent-party-time/execution-contract';
import type { UpdateBatchView } from '@/features/cooking/update/contract';

export type BugCardVisualState = 'attention' | 'failed' | null;

export type BugCardVisualPresentation = {
  state: BugCardVisualState;
  label: string | null;
};

export function bugCardVisualPresentation({
  repairExecutionState,
  updateBatchState,
  updateExecutionState,
  waitingForInteraction = false,
}: {
  repairExecutionState?: ExecutionState | null;
  updateBatchState?: UpdateBatchView['state'] | null;
  updateExecutionState?: ExecutionState | null;
  waitingForInteraction?: boolean;
}): BugCardVisualPresentation {
  if (
    waitingForInteraction ||
    repairExecutionState === 'WAITING_FOR_INTERACTION' ||
    updateExecutionState === 'WAITING_FOR_INTERACTION' ||
    updateBatchState === 'WAITING_EXTERNAL'
  )
    return {
      state: 'attention',
      label: '等待用户操作 · 点击查看详情',
    };
  if (
    repairExecutionState === 'FAILED' ||
    updateExecutionState === 'FAILED' ||
    updateBatchState === 'FAILED'
  )
    return {
      state: 'failed',
      label: 'Codex 执行异常 · 点击查看详情',
    };
  return { state: null, label: null };
}
