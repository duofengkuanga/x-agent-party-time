import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ControlPlanePort } from '@agent-party-time/control-plane-client';
import { EngineeringBindingService } from './engineering-binding-service.js';
import { RunnerStateStore } from './runner-state-store.js';

describe('engineering binding', () => {
  let directory: string | null = null;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = null;
  });

  test('中心只接收逻辑标识，本机保存并恢复绝对目录', async () => {
    directory = await mkdtemp(join(tmpdir(), 'apt-engineering-binding-'));
    const repositoryPath = join(directory, 'zj-soil-web');
    await mkdir(repositoryPath);
    const statePath = join(directory, 'runner.json');
    const stateStore = new RunnerStateStore(statePath);
    const runner = await stateStore.ensureIdentity('本机 Agent');
    const engineeringId = crypto.randomUUID();
    const bindingId = crypto.randomUUID();
    const calls: unknown[] = [];
    const controlPlane = {
      claimEngineeringBinding: async (input: unknown) => {
        calls.push(input);
        return {
          id: bindingId,
          engineeringId,
          developer: {
            id: 'user-xujiequan',
            username: 'xujiequan',
            displayName: '徐捷泉',
            accountType: 'DEVELOPER' as const,
          },
          repositoryName: 'zj-soil-web',
          runner: {
            id: runner.runnerId,
            name: runner.runnerName,
            availability: 'online' as const,
            lastSeenAt: '2026-07-22T08:00:00.000Z',
          },
          createdAt: '2026-07-22T08:00:00.000Z',
          updatedAt: '2026-07-22T08:00:00.000Z',
        };
      },
    } as unknown as ControlPlanePort;
    const service = new EngineeringBindingService({
      controlPlane,
      stateStore,
      runner,
      now: () => new Date('2026-07-22T08:00:00.000Z'),
    });

    const result = await service.bind({
      engineeringId,
      pairingTicket: 't'.repeat(32),
      repositoryPath,
    });
    expect(result.binding.repositoryPath).toBe(await realpath(repositoryPath));
    expect(calls).toEqual([
      {
        ticket: 't'.repeat(32),
        runnerId: runner.runnerId,
        runnerName: runner.runnerName,
        repositoryName: 'zj-soil-web',
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain(directory);
    expect(
      await new RunnerStateStore(statePath).listEngineeringBindings(),
    ).toEqual([result.binding]);
  });

  test('初始化当前 Runner 状态，并且不要求目录是 Git 仓库', async () => {
    directory = await mkdtemp(join(tmpdir(), 'apt-engineering-state-'));
    const statePath = join(directory, 'runner.json');
    const store = new RunnerStateStore(statePath);

    await store.ensureIdentity('本机 Agent');

    expect(await store.listEngineeringBindings()).toEqual([]);
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
      schemaVersion: 4,
      runnerName: '本机 Agent',
      engineeringBindings: [],
      collaborativePendingOutcomes: [],
    });
  });
});
