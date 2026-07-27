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
  const calls: Array<{ url: string; authorization?: string; body?: string }> =
    [];
  const fetchImplementation = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push({
      url,
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
  expect(await client.listServerBindings()).toEqual([
    { bindingId: '00000000-0000-4000-8000-000000000012' },
  ]);
  expect(calls[0]?.body).not.toContain('password');
  expect(calls[1]?.authorization).toBe(`Bearer ${credential}`);
  expect(calls[2]?.authorization).toBe(`Bearer ${credential}`);
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
