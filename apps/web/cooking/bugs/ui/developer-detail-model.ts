import type { ExecutionState } from '@agent-party-time/execution-contract';
import type {
  BugProgressTimelineNode,
  CookingWorkspaceSnapshot,
} from '@/cooking/workspace/contract';
import type { UpdateBatchView } from '@/cooking/update/contract';

export type RepairRound = Extract<BugProgressTimelineNode, { kind: 'REPAIR_ATTEMPT' }>;
export type UpdateRound = Extract<
  UpdateBatchView['timeline'][number],
  { kind: 'UPDATE_ATTEMPT' }
>;
type BugEvent = Exclude<
  BugProgressTimelineNode,
  { kind: 'REPAIR_ATTEMPT' | 'UPDATE_BATCH' }
>;
export type DeveloperTimelineEntry =
  | { id: string; at: string; kind: 'repair'; node: RepairRound }
  | {
      id: string;
      at: string;
      kind: 'update';
      node: UpdateRound;
      batch: UpdateBatchView;
      round: number;
    }
  | {
      id: string;
      at: string;
      kind: 'report';
      node: Extract<UpdateBatchView['timeline'][number], { kind: 'EXTERNAL_REPORT' }>;
      batch: UpdateBatchView;
    }
  | { id: string; at: string; kind: 'event'; node: BugEvent };

export function developerTimeline(
  bugId: string,
  snapshot: CookingWorkspaceSnapshot,
): DeveloperTimelineEntry[] {
  const entries: DeveloperTimelineEntry[] = (snapshot.progressByBug[bugId] ?? []).flatMap(
    (node): DeveloperTimelineEntry[] => {
      if (node.kind === 'UPDATE_BATCH') return [];
      if (node.kind === 'REPAIR_ATTEMPT')
        return [{ id: node.id, at: node.queuedAt, kind: 'repair', node }];
      return [
        {
          id: node.id,
          at: 'createdAt' in node ? node.createdAt : node.occurredAt,
          kind: 'event',
          node,
        },
      ];
    },
  );
  for (const batch of snapshot.updateBatches) {
    if (!batch.entries.some((entry) => entry.bugId === bugId)) continue;
    for (const node of batch.timeline) {
      if (node.kind === 'UPDATE_ATTEMPT')
        entries.push({
          id: node.id,
          at: node.queuedAt,
          kind: 'update',
          node,
          batch,
          round: 0,
        });
      if (node.kind === 'EXTERNAL_REPORT')
        entries.push({ id: node.id, at: node.occurredAt, kind: 'report', node, batch });
    }
  }
  entries.sort((a, b) => a.at.localeCompare(b.at));
  let updateRound = 0;
  for (const entry of entries) if (entry.kind === 'update') entry.round = ++updateRound;
  return entries.reverse();
}

export function executionRoundStatus(
  node: Pick<RepairRound | UpdateRound, 'executionState' | 'result'>,
): string {
  if (node.result?.outcome === 'HANDED_OFF') return '等待人工确认';
  if (node.result?.outcome === 'FAILED') return '未完成';
  if (node.result?.outcome === 'PUSHED') return '已推送';
  if (node.result?.outcome === 'COMPLETED') return '已完成';
  const labels: Record<ExecutionState, string> = {
    QUEUED: '排队中',
    CLAIMED: '准备中',
    RUNNING: '执行中',
    WAITING_FOR_INTERACTION: '等待处理',
    WAITING_TO_RESUME: '等待恢复',
    CANCEL_REQUESTED: '正在停止',
    SUCCEEDED: '执行结束',
    FAILED: '未完成',
    CANCELLED: '已停止',
    HANDED_OFF: '等待人工确认',
  };
  return labels[node.executionState];
}

export function executionRoundProgress(node: RepairRound | UpdateRound): string {
  const result = node.result;
  if (result?.outcome === 'FAILED') return `${result.failedStep}：${result.reason}`;
  if (result?.outcome === 'HANDED_OFF') return '自动执行已停止，等待在原会话中继续处理。';
  if (result?.outcome === 'COMPLETED') return '本轮执行已完成。';
  if (result?.outcome === 'PUSHED') return '已完成推送，等待确认环境更新结果。';
  if (node.executionState === 'RUNNING') return 'Agent 正在执行，尚未回传步骤明细。';
  if (node.executionState === 'CLAIMED') return 'Agent 已领取，正在准备执行。';
  if (node.executionState === 'QUEUED') return '等待 Agent 执行。';
  if (node.executionState === 'WAITING_TO_RESUME') return '执行暂时中断，等待恢复。';
  return executionRoundStatus(node);
}
