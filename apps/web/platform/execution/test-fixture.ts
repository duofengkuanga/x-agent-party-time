import type { EnqueueExecutionInput } from '@agent-party-time/execution-contract';

export function input(
  runnerId: string,
  localBindingId: string,
  ownerId: string,
): EnqueueExecutionInput {
  return {
    owner: { namespace: 'fixture', kind: 'generic', id: ownerId },
    attempt: 1,
    previousExecutionId: null,
    runnerId,
    bindingId: localBindingId,
    priority: 0,
    approvalPolicy: 'on-request',
    codexTurn: null,
    workspace: null,
    attachmentIds: [],
  };
}

export function bindingId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}
