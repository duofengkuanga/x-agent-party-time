import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionOutbox } from './outbox';
import { runnerLocalPaths } from './state';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('Outbox 使用私有文件持久化并可在重启后按协议顺序恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-outbox-'));
  directories.push(root);
  const paths = runnerLocalPaths({ AGENT_PARTY_TIME_RUNNER_HOME: root });
  const ids = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
  ];
  let index = 0;
  const outbox = new ExecutionOutbox(
    paths,
    () => new Date('2026-07-27T09:00:00.000Z'),
    () => ids[index++]!,
  );
  const executionId = '00000000-0000-4000-8000-000000000010';
  const leaseToken = `lease-${'x'.repeat(32)}`;
  await outbox.add({
    kind: 'OUTCOME',
    executionId,
    request: {
      leaseToken,
      sessionId: 'session-outbox',
      outcome: { kind: 'SUCCEEDED', result: { ok: true } },
    },
  });
  await outbox.add({
    kind: 'START',
    executionId,
    request: {
      kind: 'STARTED',
      leaseToken,
      sessionId: 'session-outbox',
    },
  });

  const restarted = new ExecutionOutbox(paths);
  const entries = await restarted.list();
  expect(entries.map(({ kind }) => kind)).toEqual(['START', 'OUTCOME']);
  expect((await stat(paths.outbox)).mode & 0o777).toBe(0o700);
  for (const entry of entries)
    expect(
      (await stat(join(paths.outbox, `${entry.id}.json`))).mode & 0o777,
    ).toBe(0o600);
});
