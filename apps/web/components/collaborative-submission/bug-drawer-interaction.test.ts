import { expect, test } from 'bun:test';
import type { SubmissionBug } from '@agent-party-time/shared/control-plane';
import { findBugInteraction } from './bug-drawer';
import type { WorkspaceSnapshot } from './model';

const itemId = '11111111-1111-4111-8111-111111111111';
const bugId = '22222222-2222-4222-8222-222222222222';
const batchId = '33333333-3333-4333-8333-333333333333';
const interaction = {
  id: '44444444-4444-4444-8444-444444444444',
  executionKind: 'UPDATE',
  executionId: batchId,
  state: 'PENDING',
};

const snapshot = {
  repairQueues: {},
  updateBatches: {
    [itemId]: [{ id: batchId, bugIds: [bugId], state: 'RUNNING' }],
  },
  interactions: { [itemId]: [interaction] },
} as unknown as WorkspaceSnapshot;

test('更新批次的待处理交互归属到批次内 Bug 的详情抽屉', () => {
  const result = findBugInteraction(
    {
      id: bugId,
      submissionItemId: itemId,
      status: 'UPDATING',
    } as SubmissionBug,
    snapshot,
  );

  expect(result).toBe(interaction);
});

test('已取消 Bug 的待处理清理交互归属到垃圾桶详情', () => {
  const cleanupTaskId = '55555555-5555-4555-8555-555555555555';
  const cleanupInteraction = {
    ...interaction,
    id: '66666666-6666-4666-8666-666666666666',
    executionKind: 'CLEANUP',
    executionId: cleanupTaskId,
  };
  const cleanupSnapshot = {
    ...snapshot,
    interactions: { [itemId]: [cleanupInteraction] },
  } as unknown as WorkspaceSnapshot;

  const result = findBugInteraction(
    {
      id: bugId,
      submissionItemId: itemId,
      status: 'CANCELLED',
      cleanup: {
        state: 'RUNNING',
        taskId: cleanupTaskId,
        summary: null,
      },
    } as SubmissionBug,
    cleanupSnapshot,
  );

  expect(result).toBe(cleanupInteraction);
});
