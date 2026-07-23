import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerStateStore } from './runner-state-store.js';

describe('RunnerStateStore concurrency', () => {
  let directory: string | null = null;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = null;
  });

  test('serializes read-modify-write updates across store instances', async () => {
    directory = await mkdtemp(join(tmpdir(), 'apt-runner-state-'));
    const statePath = join(directory, 'runner.json');
    const initial = new RunnerStateStore(statePath);
    const runner = await initial.ensureIdentity('Concurrent Runner');
    const timestamp = new Date().toISOString();
    const bindings = Array.from({ length: 12 }, (_, index) => ({
      projectId: randomUUID(),
      projectSlug: `project-${index}`,
      projectTitle: null,
      runnerId: runner.runnerId,
      repositoryPath: join(directory!, `repo-${index}`),
      baseBranch: 'main',
      createdAt: timestamp,
      updatedAt: timestamp,
    }));

    await Promise.all(
      bindings.map((binding) =>
        new RunnerStateStore(statePath).saveBinding(binding),
      ),
    );

    expect(await initial.listBindings()).toHaveLength(bindings.length);
  });

  test('recovers one stale lock without allowing competing cleaners to remove a new owner', async () => {
    directory = await mkdtemp(join(tmpdir(), 'apt-runner-stale-lock-'));
    const statePath = join(directory, 'runner.json');
    const initial = new RunnerStateStore(statePath);
    const runner = await initial.ensureIdentity('Stale Lock Runner');
    await writeFile(
      `${statePath}.lock`,
      JSON.stringify({
        nonce: randomUUID(),
        pid: 2_147_483_647,
        createdAt: 0,
      }),
    );
    const timestamp = new Date().toISOString();
    const binding = (index: number) => ({
      projectId: randomUUID(),
      projectSlug: `stale-lock-${index}`,
      projectTitle: null,
      runnerId: runner.runnerId,
      repositoryPath: join(directory!, `repo-${index}`),
      baseBranch: 'main',
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await Promise.all([
      new RunnerStateStore(statePath).saveBinding(binding(1)),
      new RunnerStateStore(statePath).saveBinding(binding(2)),
    ]);

    expect(await initial.listBindings()).toHaveLength(2);
  });

  test('restores pending outcomes and cleaned Session mappings in a fresh instance', async () => {
    directory = await mkdtemp(join(tmpdir(), 'apt-runner-restart-'));
    const statePath = join(directory, 'runner.json');
    const initial = new RunnerStateStore(statePath);
    const runner = await initial.ensureIdentity('Restart Runner');
    const pending = await initial.savePendingOutcome({
      kind: 'repair',
      input: {
        runnerId: runner.runnerId,
        dispatchId: randomUUID(),
        attemptId: randomUUID(),
        leaseToken: 'l'.repeat(24),
        outcome: {
          kind: 'execution_failure',
          sessionId: 'session-pending',
          message: '等待 Control Plane 确认',
        },
      },
    });
    await initial.markSessionsCleaned(['session-cleaned']);

    const restored = new RunnerStateStore(statePath);
    expect(await restored.identity()).toEqual(runner);
    expect(await restored.listPendingOutcomes()).toEqual([pending]);
    expect(await restored.resumableSession('session-cleaned')).toBeNull();
    expect(await restored.resumableSession('session-active')).toBe(
      'session-active',
    );
  });
});
