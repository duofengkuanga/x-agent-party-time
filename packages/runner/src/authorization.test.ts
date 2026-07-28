import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type {
  RunnerAuthorizationClaimResponse,
  RunnerAuthorizationIssue,
} from '@agent-party-time/runner-contract';
import { AgentAuthorization } from './authorization';
import { RunnerProtocolError, type RunnerClient } from './client';
import type { RunnerStateStore } from './state';

test('空本机状态等待 Web、只打开一次浏览器并领取长期凭据', async () => {
  const opened: string[] = [];
  const waits: number[] = [];
  const creates: unknown[] = [];
  const verifier = 'v'.repeat(43);
  let createAttempts = 0;
  let claimAttempts = 0;
  const issue: RunnerAuthorizationIssue = {
    requestId: 'r'.repeat(32),
    expiresAt: '2026-07-28T12:05:00.000Z',
  };
  const client = {
    heartbeat: async () => {
      throw new Error('尚未连接');
    },
    createAuthorization: async (_serverUrl: string, input: unknown) => {
      creates.push(input);
      createAttempts += 1;
      if (createAttempts === 1) throw new Error('Web 尚未启动');
      return issue;
    },
    claimAuthorization: async (): Promise<RunnerAuthorizationClaimResponse> => {
      claimAttempts += 1;
      return claimAttempts === 1
        ? { state: 'WAITING', retryAfterMs: 1_000 }
        : {
            state: 'AUTHORIZED',
            runner: runner(),
            credential: 'credential-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
          };
    },
  } as unknown as RunnerClient;
  const state = {
    hasConfig: async () => false,
    loadConfig: async () => {
      throw new Error('不应读取');
    },
    clearConfig: async () => undefined,
  } as unknown as RunnerStateStore;
  const authorization = new AgentAuthorization(
    client,
    state,
    async (url) => {
      opened.push(url);
    },
    async (durationMs) => {
      waits.push(durationMs);
    },
    () => verifier,
    () => '我的 Agent',
    { log: () => undefined },
  );

  await authorization.ensureAuthorized('http://localhost:3000');

  expect(opened).toEqual([
    `http://localhost:3000/cooking/agents/connect?request=${issue.requestId}`,
  ]);
  expect(waits).toEqual([1_000, 1_000]);
  expect(creates[1]).toEqual({
    verifierHash: createHash('sha256').update(verifier).digest('hex'),
    fingerprint: createHash('sha256')
      .update(verifier)
      .digest('hex')
      .slice(0, 12)
      .toUpperCase()
      .match(/.{4}/gu)!
      .join('-'),
    suggestedName: '我的 Agent',
  });
});

test('已有有效凭据正常重启不创建请求或打开浏览器', async () => {
  let opened = false;
  let created = false;
  const client = {
    heartbeat: async () => runner(),
    createAuthorization: async () => {
      created = true;
      throw new Error('不应创建');
    },
  } as unknown as RunnerClient;
  const state = {
    hasConfig: async () => true,
    loadConfig: async () => ({
      serverUrl: 'http://localhost:3000',
      runnerId: runner().id,
      credential: 'credential-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    }),
  } as unknown as RunnerStateStore;
  await new AgentAuthorization(client, state, async () => {
    opened = true;
  }).ensureAuthorized('http://localhost:3000');
  expect(created).toBe(false);
  expect(opened).toBe(false);
});

test('凭据被撤销后清理旧状态并重新打开浏览器授权', async () => {
  let cleared = false;
  let opened = false;
  const client = {
    heartbeat: async () => {
      throw new RunnerProtocolError(
        'NOT_AUTHENTICATED',
        'Agent 凭据无效或已撤销',
        401,
      );
    },
    createAuthorization: async () => ({
      requestId: 'r'.repeat(32),
      expiresAt: '2026-07-28T12:05:00.000Z',
    }),
    claimAuthorization: async () => ({
      state: 'AUTHORIZED' as const,
      runner: runner(),
      credential: 'credential-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    }),
  } as unknown as RunnerClient;
  const state = {
    hasConfig: async () => true,
    loadConfig: async () => ({
      serverUrl: 'http://localhost:3000',
      runnerId: runner().id,
      credential: 'credential-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    }),
    clearConfig: async () => {
      cleared = true;
    },
  } as unknown as RunnerStateStore;
  await new AgentAuthorization(
    client,
    state,
    async () => {
      opened = true;
    },
    async () => undefined,
    () => 'v'.repeat(43),
    () => '重新授权 Agent',
    { log: () => undefined },
  ).ensureAuthorized('http://localhost:3000');
  expect(cleared).toBe(true);
  expect(opened).toBe(true);
});

function runner() {
  return {
    id: '00000000-0000-4000-8000-000000000101',
    ownerUserId: 'runner-user',
    name: '我的 Agent',
    version: 1,
    lastSeenAt: null,
    revokedAt: null,
    createdAt: '2026-07-28T12:00:00.000Z',
  };
}
