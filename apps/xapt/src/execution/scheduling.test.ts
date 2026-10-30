import { expect, test } from 'bun:test';
import type { ExecutionWorkspace } from '@agent-party-time/execution-contract';
import {
  executionsConflict,
  hasExecutionCapacity,
  type ExecutionAccess,
} from '@agent-party-time/execution-contract/scheduling';

function access(
  key: string,
  isolation: 'BRANCH_WORKTREE' | 'DETACHED_WORKTREE',
  bindingId = 'binding',
): ExecutionAccess {
  const workspace: ExecutionWorkspace =
    isolation === 'BRANCH_WORKTREE'
      ? { key, isolation, baseRef: 'main', branch: key }
      : { key, isolation, baseRef: 'main' };
  return { bindingId, workspace, sessionId: null, codexTurn: null };
}

test('同 Binding 不同分支/Detached 工作区并行，同通道、相同工作区与 Session 互斥', () => {
  const branch = access('repair', 'BRANCH_WORKTREE');
  const detached = access('update', 'DETACHED_WORKTREE');
  expect(executionsConflict(branch, detached)).toBe(false);
  expect(executionsConflict(branch, access('repair2', 'BRANCH_WORKTREE'))).toBe(true);
  expect(executionsConflict(detached, access('update2', 'DETACHED_WORKTREE'))).toBe(true);
  expect(
    executionsConflict(branch, {
      ...detached,
      workspace: { ...detached.workspace!, key: 'repair' },
    }),
  ).toBe(true);
  expect(executionsConflict(branch, { ...detached, workspace: null })).toBe(true);
  expect(
    executionsConflict(
      { ...branch, sessionId: 'session' },
      { ...detached, bindingId: 'other', sessionId: 'session' },
    ),
  ).toBe(true);
  expect(executionsConflict(branch, access('repair2', 'BRANCH_WORKTREE', 'other'))).toBe(
    false,
  );
  expect(executionsConflict(branch, access('repair', 'BRANCH_WORKTREE', 'other'))).toBe(
    true,
  );
});

test('清理只互斥所涉及工作区，不能删除正在执行的工作区', () => {
  const cleanup: ExecutionAccess = {
    bindingId: 'binding',
    sessionId: null,
    codexTurn: null,
    workspace: {
      key: 'cleanup',
      isolation: 'CLEANUP_WORKTREES',
      workspaceKeys: ['repair'],
      completionResult: {},
    },
  };
  expect(executionsConflict(cleanup, access('repair', 'BRANCH_WORKTREE'))).toBe(true);
  expect(executionsConflict(access('repair', 'BRANCH_WORKTREE'), cleanup)).toBe(true);
  expect(executionsConflict(cleanup, access('update', 'DETACHED_WORKTREE'))).toBe(false);
  expect(
    executionsConflict(cleanup, {
      ...cleanup,
      workspace: {
        key: 'other-cleanup',
        isolation: 'CLEANUP_WORKTREES',
        workspaceKeys: ['other'],
        completionResult: {},
      },
    }),
  ).toBe(true);
});

test('两个分支任务后为 Detached 预留第三槽', () => {
  const active = [
    access('a', 'BRANCH_WORKTREE', 'a'),
    access('b', 'BRANCH_WORKTREE', 'b'),
  ];
  expect(hasExecutionCapacity(access('c', 'BRANCH_WORKTREE', 'c'), active)).toBe(false);
  expect(hasExecutionCapacity(access('update', 'DETACHED_WORKTREE'), active)).toBe(true);
});
