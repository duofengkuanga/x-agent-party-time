import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerClient } from './client';
import { RunnerStateStore, runnerLocalPaths } from './state';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('RunnerClient 配对后私下保存 Credential，后续请求使用 Bearer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-party-time-runner-client-'));
  directories.push(root);
  const state = new RunnerStateStore(
    runnerLocalPaths({ AGENT_PARTY_TIME_RUNNER_HOME: root }),
  );
  const credential = 'credential-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';
  const calls: Array<{
    url: string;
    method?: string;
    authorization?: string;
    body?: string;
  }> = [];
  const fetchImplementation = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method,
      authorization:
        new Headers(init?.headers).get('authorization') ?? undefined,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    if (url.endsWith('/pair'))
      return Response.json({
        runner: runner('00000000-0000-4000-8000-000000000011'),
        credential,
      });
    if (url.endsWith('/heartbeat'))
      return Response.json({
        runner: {
          ...runner('00000000-0000-4000-8000-000000000011'),
          lastSeenAt: '2026-07-26T12:30:00.000Z',
        },
      });
    if (url.endsWith('/bindings') && init?.method === 'POST')
      return Response.json(JSON.parse(String(init.body)));
    return Response.json({
      bindings: [{ bindingId: '00000000-0000-4000-8000-000000000012' }],
    });
  }) as typeof fetch;
  const client = new RunnerClient(state, fetchImplementation);

  const paired = await client.pair({
    serverUrl: 'http://localhost:3000/',
    code: 'A1B2-C3D4-E5F6-A7B8',
    name: '本机 Runner',
  });
  expect('credential' in paired).toBe(false);
  expect((await state.loadConfig()).credential).toBe(credential);
  await client.heartbeat();
  await client.confirmBinding(
    '00000000-0000-4000-8000-000000000012',
    'git@Example.com:team/repository.git',
  );
  expect(await client.listServerBindings()).toEqual([
    { bindingId: '00000000-0000-4000-8000-000000000012' },
  ]);
  expect(calls[0]?.body).not.toContain('password');
  expect(calls[1]?.authorization).toBe(`Bearer ${credential}`);
  expect(calls[2]?.authorization).toBe(`Bearer ${credential}`);
  expect(calls[2]?.body).toBe(
    JSON.stringify({
      bindingId: '00000000-0000-4000-8000-000000000012',
      repositoryUrl: 'https://example.com/team/repository.git',
    }),
  );
  expect(calls[3]?.authorization).toBe(`Bearer ${credential}`);
});

test('浏览器授权领取凭据并通过出站请求处理 Web Binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-party-time-runner-client-'));
  directories.push(root);
  const state = new RunnerStateStore(
    runnerLocalPaths({ AGENT_PARTY_TIME_RUNNER_HOME: root }),
  );
  const credential = 'credential-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const calls: Array<{ url: string; authorization?: string }> = [];
  const fetchImplementation = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push({
      url,
      authorization:
        new Headers(init?.headers).get('authorization') ?? undefined,
    });
    if (url.endsWith('/api/runner/authorizations'))
      return Response.json({
        requestId: 'r'.repeat(32),
        expiresAt: '2026-07-28T13:05:00.000Z',
      });
    if (url.includes('/authorizations/') && url.endsWith('/claim'))
      return Response.json({
        state: 'AUTHORIZED',
        runner: runner('00000000-0000-4000-8000-000000000111'),
        credential,
      });
    if (url.endsWith('/api/runner/binding-requests'))
      return Response.json({
        request: {
          requestId: '00000000-0000-4000-8000-000000000112',
          bindingId: '00000000-0000-4000-8000-000000000113',
          expiresAt: '2026-07-28T13:05:00.000Z',
        },
      });
    if (url.includes('/api/runner/binding-requests/'))
      return Response.json({ state: 'SUCCEEDED' });
    return Response.json({ error: { message: '未处理' } }, { status: 500 });
  }) as typeof fetch;
  const client = new RunnerClient(state, fetchImplementation);
  const issue = await client.createAuthorization('http://localhost:3000', {
    verifierHash: 'a'.repeat(64),
    fingerprint: 'AAAA-BBBB-CCCC',
    suggestedName: '本机 Agent',
  });
  await client.claimAuthorization(
    'http://localhost:3000',
    issue.requestId,
    'v'.repeat(43),
  );
  expect((await state.loadConfig()).credential).toBe(credential);
  const work = await client.claimBindingWork();
  expect(work?.bindingId).toBe('00000000-0000-4000-8000-000000000113');
  expect(
    await client.completeBindingWork(work!.requestId, {
      outcome: 'SUCCEEDED',
      repositoryUrl: 'git@Example.com:team/repository.git',
    }),
  ).toBe('SUCCEEDED');
  expect(calls[2]?.authorization).toBe(`Bearer ${credential}`);
  expect(calls[3]?.authorization).toBe(`Bearer ${credential}`);
});

function runner(id: string) {
  return {
    id,
    ownerUserId: 'runner-user',
    name: '本机 Runner',
    version: 1,
    lastSeenAt: null,
    revokedAt: null,
    createdAt: '2026-07-26T12:00:00.000Z',
  };
}
