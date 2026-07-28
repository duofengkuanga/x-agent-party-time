import { expect, test } from 'bun:test';
import { AgentBindingWorker } from './binding-worker';
import type { RunnerClient } from './client';
import type { DirectorySelector } from './directory-selector';
import type { RunnerStateStore } from './state';

const request = {
  requestId: '00000000-0000-4000-8000-000000000201',
  bindingId: '00000000-0000-4000-8000-000000000202',
  expiresAt: '2026-07-28T13:05:00.000Z',
};

test('选择有效仓库后先保存本机映射，再原子完成 Web Binding', async () => {
  const events: string[] = [];
  const client = {
    listServerBindings: async () => [],
    claimBindingWork: async () => request,
    completeBindingWork: async (
      _requestId: string,
      completion: { outcome: string; repositoryUrl?: string },
    ) => {
      events.push(`complete:${completion.outcome}:${completion.repositoryUrl}`);
      return 'SUCCEEDED' as const;
    },
  } as unknown as RunnerClient;
  const state = {
    pruneBindings: async () => [],
    bind: async (bindingId: string, path: string) => {
      events.push(`bind:${bindingId}:${path}`);
      return {
        bindingId,
        repositoryPath: path,
        updatedAt: new Date().toISOString(),
      };
    },
    removeBinding: async () => false,
  } as unknown as RunnerStateStore;
  const selector: DirectorySelector = {
    selectDirectory: async () => '/private/repository',
  };
  const worker = new AgentBindingWorker(
    client,
    state,
    selector,
    async () => 'https://example.com/team/repository.git',
  );

  expect(await worker.cycle()).toBe(true);
  expect(events).toEqual([
    `bind:${request.bindingId}:/private/repository`,
    'complete:SUCCEEDED:https://example.com/team/repository.git',
  ]);
});

test('取消选择不上报路径且不保存本机映射', async () => {
  const completions: unknown[] = [];
  let bound = false;
  const client = {
    listServerBindings: async () => [],
    claimBindingWork: async () => request,
    completeBindingWork: async (_requestId: string, completion: unknown) => {
      completions.push(completion);
      return 'FAILED' as const;
    },
  } as unknown as RunnerClient;
  const state = {
    pruneBindings: async () => [],
    bind: async () => {
      bound = true;
      throw new Error('不应保存');
    },
  } as unknown as RunnerStateStore;
  const worker = new AgentBindingWorker(
    client,
    state,
    { selectDirectory: async () => null },
    async () => null,
  );
  expect(await worker.cycle()).toBe(true);
  expect(bound).toBe(false);
  expect(completions).toEqual([
    {
      outcome: 'FAILED',
      code: 'CANCELLED',
      message: '已取消选择仓库目录',
    },
  ]);
  expect(JSON.stringify(completions)).not.toContain('/private/');
});

test('同步服务端 Binding 列表会幂等清理本机孤儿映射', async () => {
  const client = {
    listServerBindings: async () => [
      { bindingId: '00000000-0000-4000-8000-000000000203' },
    ],
    claimBindingWork: async () => null,
  } as unknown as RunnerClient;
  const pruned: string[][] = [];
  const state = {
    pruneBindings: async (ids: string[]) => {
      pruned.push(ids);
      return ['00000000-0000-4000-8000-000000000204'];
    },
  } as unknown as RunnerStateStore;
  const worker = new AgentBindingWorker(
    client,
    state,
    { selectDirectory: async () => null },
    async () => null,
    async () => undefined,
    { log: () => undefined },
  );
  expect(await worker.cycle()).toBe(false);
  expect(pruned).toEqual([['00000000-0000-4000-8000-000000000203']]);
});
