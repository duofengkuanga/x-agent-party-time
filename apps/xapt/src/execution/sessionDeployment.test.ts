import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonValue } from '@agent-party-time/execution-contract';
import { readCompletedTurn } from '../codex/sessionReader';
import { bindingId, createFixture, session } from './serviceFixture';

test.each([
  'valid',
  'message-only',
  'older-turn',
  'wrong-environment',
  'failed-command',
  'in-progress',
])('同步双工程部署只采信最新完成轮次的实际命令回执：%s', async (scenario) => {
  const bindings = [bindingId, '00000000-0000-4000-8000-000000000316'];
  const f = await createFixture({
    readSessionId: 'manual-session',
    previousExecutionId: '00000000-0000-4000-8000-000000000399',
    readResultAssertions: bindings.map((workspaceBindingId, index) => ({
      kind: 'GIT_DELIVERY_STATE',
      workspaceBindingId,
      targetBranch: 'main',
      environmentKey: '1082',
      resultPath: ['result', 'deliveries', `repo-${index + 1}`],
    })),
  });
  const result: JsonValue = { result: { outcome: 'COMPLETED', deliveries: {} } };
  const deliveries = (result.result as { deliveries: Record<string, JsonValue> })
    .deliveries;
  const items: unknown[] = [];
  const members = [];
  for (const [index, id] of bindings.entries()) {
    const repository = index === 0 ? f.repositoryPath : join(f.paths.home, 'second');
    await mkdir(join(repository, '.xapt'), { recursive: true });
    await f.state.bind(id, repository);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    await writeFile(join(repository, '.gitignore'), '.xapt/\n');
    await writeFile(
      join(repository, '.xapt/README.md'),
      '```xapt-delivery\n' +
        JSON.stringify({
          prepare: 'node .xapt/delivery.cjs prepare 1082',
          environments: [
            {
              key: '1082',
              deploy: 'node .xapt/delivery.cjs deploy 1082',
              verify: 'node .xapt/delivery.cjs verify 1082',
            },
          ],
        }) +
        '\n```\n',
    );
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    );
    const commit = git('rev-parse', 'HEAD');
    const artifactSha256 = String(index + 1).repeat(64);
    deliveries[`repo-${index + 1}`] = {
      state: 'DEPLOYED',
      commit,
      receipt: { artifactSha256: 'f'.repeat(64) },
    };
    items.push({
      type: 'commandExecution',
      status: 'completed',
      exitCode: scenario === 'failed-command' ? 1 : 0,
      command: `/bin/bash -c 'node .xapt/delivery.cjs ${index === 0 ? 'deploy' : 'verify'} 1082'`,
      cwd: repository,
      aggregatedOutput: `XAPT_DEPLOYMENT_V1 ${JSON.stringify({ commit, artifactSha256, environmentKey: scenario === 'wrong-environment' ? '1083' : '1082' })}\n`,
    });
    members.push({
      bindingId: id,
      workspace: {
        key: `batch-${index}`,
        isolation: 'DETACHED_WORKTREE' as const,
        baseRef: 'origin/main',
      },
    });
  }
  f.http.claimed[0]!.workspaces = members;
  const methods: string[] = [];
  f.executor.readLastCompletedTurn = () =>
    readCompletedTurn('manual-session', async (method) => {
      methods.push(method);
      return {
        thread: {
          turns: [
            { id: 'old', status: 'completed', items },
            {
              id: 'latest',
              status: scenario === 'in-progress' ? 'inProgress' : 'completed',
              items: [
                ...(scenario === 'message-only' || scenario === 'older-turn'
                  ? []
                  : items),
                ...(scenario === 'message-only'
                  ? [{ type: 'agentMessage', text: JSON.stringify(items) }]
                  : []),
                { type: 'agentMessage', text: JSON.stringify(result) },
              ],
            },
          ],
        },
      };
    });
  try {
    await f.service.cycle(session);
    await f.service.waitForIdle();
    expect(methods).toEqual(['thread/read']);
    expect(f.executor.inputs).toEqual([]);
    if (scenario === 'valid') {
      expect(f.http.starts[0]).toMatchObject({ kind: 'STARTED' });
      expect(f.http.outcomes[0]).toMatchObject({
        outcome: {
          kind: 'SUCCEEDED',
          result: {
            turnId: 'latest',
            result: {
              result: {
                deliveries: {
                  'repo-1': {
                    receipt: { source: 'CODEX_COMMAND', artifactSha256: '1'.repeat(64) },
                  },
                  'repo-2': {
                    receipt: { source: 'CODEX_COMMAND', artifactSha256: '2'.repeat(64) },
                  },
                },
              },
            },
          },
        },
      });
      expect(JSON.stringify(f.http.outcomes)).not.toContain(f.paths.home);
      expect(JSON.stringify(f.http.outcomes)).not.toContain('aggregatedOutput');
    } else {
      expect(f.http.starts[0]).toMatchObject({
        kind: 'START_FAILED',
        failure: {
          message: expect.stringContaining(
            scenario === 'in-progress' ? '尚未完成' : '本机部署验收回执',
          ),
        },
      });
      expect(f.http.outcomes).toEqual([]);
    }
  } finally {
    await f.shutdownObservations();
  }
});
