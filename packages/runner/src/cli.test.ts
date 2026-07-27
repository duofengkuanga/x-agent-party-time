import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRunnerCli } from './cli';
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

test('CLI 输出不泄露 Credential 或本机路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-party-time-runner-cli-'));
  directories.push(root);
  const state = new RunnerStateStore(
    runnerLocalPaths({ AGENT_PARTY_TIME_RUNNER_HOME: root }),
  );
  const credential = 'credential-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
  const client = new RunnerClient(state, (async () =>
    Response.json({
      runner: {
        id: '00000000-0000-4000-8000-000000000021',
        ownerUserId: 'cli-user',
        name: 'CLI Runner',
        version: 1,
        lastSeenAt: null,
        revokedAt: null,
        createdAt: '2026-07-26T12:00:00.000Z',
      },
      credential,
    })) as unknown as typeof fetch);
  const lines: string[] = [];
  const output = { log: (line: string) => lines.push(line) };
  await runRunnerCli(
    [
      'pair',
      '--server',
      'http://localhost:3000',
      '--code',
      'A1B2-C3D4-E5F6-A7B8',
      '--name',
      'CLI Runner',
    ],
    { client, state, output },
  );
  const bindingId = '00000000-0000-4000-8000-000000000022';
  const localPath = '/tmp/private/repository';
  await runRunnerCli(['bind', bindingId, localPath], {
    client,
    state,
    output,
  });
  const text = lines.join('\n');
  expect(text).not.toContain(credential);
  expect(text).not.toContain(localPath);
  expect(text).toContain(bindingId);
});
