import type {
  CookingInteractionView,
  CookingVisualPresentation,
} from '@/cooking/shared/contract';
import { PlatformError } from '@/platform/errors';
import type { Execution } from '@agent-party-time/execution-contract';

export function interactionVisual(
  interactions: CookingInteractionView[],
  state: Execution['state'] | undefined,
  responsible: boolean,
  subject: '修复' | '更新',
): CookingVisualPresentation | null {
  const pending = interactions.filter((interaction) => interaction.state === 'PENDING');
  if (pending.length > 1)
    throw new PlatformError('INTERNAL_ERROR', `同一${subject}记录存在多个待处理操作请求`);
  const interaction = pending[0];
  if (interaction) {
    if (state !== 'WAITING_FOR_INTERACTION')
      throw new PlatformError('INTERNAL_ERROR', `${subject}操作请求与任务状态不一致`);
    return interaction.kind === 'APPROVAL'
      ? {
          state: 'NEEDS_APPROVAL',
          label: responsible ? '需要你审批' : '等待工程负责人审批',
          symbol: '!',
        }
      : {
          state: 'NEEDS_INPUT',
          label: responsible ? '需要你回答' : '等待工程负责人回答',
          symbol: '?',
        };
  }
  if (state === 'WAITING_FOR_INTERACTION')
    throw new PlatformError(
      'INTERNAL_ERROR',
      `等待操作请求的${subject}任务缺少待处理记录`,
    );
  return null;
}

export function queueVisual(aheadCount = 0): CookingVisualPresentation {
  return {
    state: 'QUEUED_FOR_ENGINEERING',
    label: `等待工程执行通道（前方 ${aheadCount} 项）`,
    symbol: '…',
    aheadCount,
  };
}
