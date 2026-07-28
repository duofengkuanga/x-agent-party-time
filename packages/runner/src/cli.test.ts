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
  client.confirmBinding = async () => undefined;
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
    repositoryOrigin: async () => 'https://example.com/team/repository.git',
  });
  const text = lines.join('\n');
  expect(text).not.toContain(credential);
  expect(text).not.toContain(localPath);
  expect(text).toContain(bindingId);
});

test('仓库没有 origin 时允许命令末尾手工提供仓库地址', async () => {
  const confirmations: Array<{ bindingId: string; repositoryUrl: string }> = [];
  const bindings: Array<{ bindingId: string; repositoryPath: string }> = [];
  const client = {
    confirmBinding: async (bindingId: string, repositoryUrl: string) => {
      confirmations.push({ bindingId, repositoryUrl });
    },
  } as RunnerClient;
  const state = {
    bind: async (bindingId: string, repositoryPath: string) => {
      bindings.push({ bindingId, repositoryPath });
      return {
        bindingId,
        repositoryPath,
        updatedAt: '2026-07-28T00:00:00.000Z',
      };
    },
  } as RunnerStateStore;
  const bindingId = '00000000-0000-4000-8000-000000000023';
  await runRunnerCli(
    ['bind', bindingId, '/tmp/repository', 'git@Example.com:team/repository'],
    {
      client,
      state,
      output: { log: () => undefined },
      repositoryOrigin: async () => null,
    },
  );
  expect(confirmations).toEqual([
    {
      bindingId,
      repositoryUrl: 'https://example.com/team/repository.git',
    },
  ]);
  expect(bindings).toEqual([{ bindingId, repositoryPath: '/tmp/repository' }]);
});
