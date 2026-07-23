import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpControlPlaneAdapter } from '@agent-party-time/control-plane-client';
import type { CreateBugCommand } from '@agent-party-time/shared';
import {
  startControlPlane,
  type ControlPlaneHandle,
} from '../../../../services/control-plane/src/index.js';
import type { Logger } from '../logging/logger.js';
import type {
  RepairExecutionInput,
  RepairExecutionResult,
  RepairExecutor,
} from './codex-app-server.js';
import { BugRepairWorker } from './repair-worker.js';
import { RunnerStateStore } from './runner-state-store.js';

describe('BugRepairWorker', () => {
  let home: string | null = null;
  let controlPlaneHome: string | null = null;
  let handle: ControlPlaneHandle | null = null;

  afterEach(async () => {
    await handle?.close();
    if (home) await rm(home, { recursive: true, force: true });
    if (controlPlaneHome)
      await rm(controlPlaneHome, { recursive: true, force: true });
    home = null;
    controlPlaneHome = null;
    handle = null;
  });

  test('runs every bug in one dispatch strictly serially with isolated attempts', async () => {
    home = await mkdtemp(join(tmpdir(), 'apt-repair-worker-'));
    controlPlaneHome = await mkdtemp(
      join(tmpdir(), 'apt-repair-control-plane-'),
    );
    handle = await startControlPlane({
      homeDirectory: controlPlaneHome,
      port: await availablePort(),
      repairDispatchDelayMs: 60_000,
    });
    const controlPlane = new HttpControlPlaneAdapter({
      baseUrl: handle.address(),
    });
    const runnerState = new RunnerStateStore(join(home, 'runner.json'));
    const runner = await runnerState.ensureIdentity('Worker Test Runner');
    await controlPlane.registerRunner({
      runnerId: runner.runnerId,
      name: runner.runnerName,
    });
    const project = await controlPlane.createProject(
      { slug: 'worker-test', title: 'Worker Test' },
      `project:${crypto.randomUUID()}`,
    );
    await controlPlane.setProjectDefaultRunner(project.id, runner.runnerId);
    await runnerState.saveBinding({
      projectId: project.id,
      projectSlug: project.slug,
      projectTitle: project.title,
      runnerId: runner.runnerId,
      repositoryPath: home,
      baseBranch: 'main',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const first = await createBug(controlPlane, project.id, '第一个缺陷', true);
    const second = await createBug(
      controlPlane,
      project.id,
      '第二个缺陷',
      false,
    );
    const dispatch = await controlPlane.enqueueBugForRepair(
      first.id,
      `repair:${crypto.randomUUID()}`,
    );
    await controlPlane.enqueueBugForRepair(
      second.id,
      `repair:${crypto.randomUUID()}`,
    );
    await controlPlane.closeRepairDispatch(
      dispatch.dispatch.id,
      `close:${crypto.randomUUID()}`,
    );

    const executor = new RecordingExecutor();
    const attemptsDirectory = join(home, 'attempts');
    const worker = new BugRepairWorker({
      controlPlane,
      runner,
      stateStore: runnerState,
      executor,
      attemptsDirectory,
      logger: NOOP_LOGGER,
      pollIntervalMs: 5,
      leaseRenewIntervalMs: 10,
    });
    worker.start();
    await waitFor(async () => {
      const details = await Promise.all([
        controlPlane.getBug(first.id),
        controlPlane.getBug(second.id),
      ]);
      return details.every((bug) =>
        ['ready', 'failed'].includes(bug.repairAttempt?.state ?? ''),
      );
    });
    await worker.stop();

    const firstDetail = await controlPlane.getBug(first.id);
    const secondDetail = await controlPlane.getBug(second.id);
    expect(executor.maxConcurrency).toBe(1);
    expect(executor.inputs.map((input) => input.attemptId)).toHaveLength(2);
    expect(new Set(executor.inputs.map((input) => input.attemptId)).size).toBe(
      2,
    );
    expect(executor.inputs[0]!.prompt).toContain(
      `repair-${executor.inputs[0]!.attemptId}`,
    );
    expect(executor.inputs[1]!.prompt).toContain(
      `repair-${executor.inputs[1]!.attemptId}`,
    );
    expect(firstDetail.status).toBe('repair_ready');
    expect(firstDetail.repairAttempt?.sessionId).toBe('session-1');
    expect(firstDetail.repairAttempt?.result?.status).toBe('ready');
    expect(secondDetail.status).toBe('repairing');
    expect(secondDetail.repairState).toBe('failed');
    expect(secondDetail.repairAttempt?.sessionId).toBe('session-2');
    expect(secondDetail.repairAttempt?.result?.status).toBe('failed');

    const firstInput = executor.inputs[0]!;
    const attachmentLine = firstInput.prompt
      .split('\n')
      .find((line) => line.includes('evidence.txt'));
    expect(attachmentLine).toBeTruthy();
    expect(await readFile(attachmentLine!.replace(/^- /, ''), 'utf8')).toBe(
      'evidence',
    );
  });

  test('contains no Runner-side Git or project workflow process execution', async () => {
    const sources = await Promise.all([
      readFile(new URL('./repair-worker.ts', import.meta.url), 'utf8'),
      readFile(new URL('./codex-app-server.ts', import.meta.url), 'utf8'),
    ]);
    const source = sources.join('\n');
    expect(source).not.toMatch(/spawn(?:Sync)?\s*\(\s*['\"]git['\"]/);
    expect(source).not.toMatch(/execFile(?:Sync)?\s*\(\s*['\"]git['\"]/);
    expect(source).not.toMatch(
      /\b(?:bun|npm|pnpm|yarn|mvn|gradle|pytest|cargo)\s+(?:test|build|run)\b/,
    );
  });
});

class RecordingExecutor implements RepairExecutor {
  inputs: RepairExecutionInput[] = [];
  concurrency = 0;
  maxConcurrency = 0;

  async execute(input: RepairExecutionInput): Promise<RepairExecutionResult> {
    this.inputs.push(input);
    this.concurrency += 1;
    this.maxConcurrency = Math.max(this.maxConcurrency, this.concurrency);
    const sequence = this.inputs.length;
    await Bun.sleep(20);
    this.concurrency -= 1;
    return sequence === 1
      ? {
          sessionId: 'session-1',
          result: {
            status: 'ready',
            summary: '第一个缺陷已修复',
            changes: [{ path: 'src/first.ts', summary: '修复第一个缺陷' }],
            checks: [{ name: 'unit', status: 'passed', summary: '通过' }],
            candidateCommit: 'deadbeef',
          },
        }
      : {
          sessionId: 'session-2',
          result: {
            status: 'failed',
            summary: '第二个缺陷无法安全修复',
            changes: [],
            checks: [{ name: 'unit', status: 'not_run', summary: '未运行' }],
            reason: '缺少必要输入',
          },
        };
  }
}

async function createBug(
  client: HttpControlPlaneAdapter,
  projectId: string,
  title: string,
  attachment: boolean,
) {
  const input: CreateBugCommand = {
    projectId,
    title,
    operationPath: '执行操作',
    actualResult: '出现错误',
    expectedResult: '操作成功',
    attachments: attachment
      ? [
          {
            fileName: 'evidence.txt',
            mediaType: 'text/plain',
            sizeBytes: Buffer.byteLength('evidence'),
            contentBase64: Buffer.from('evidence').toString('base64'),
          },
        ]
      : [],
  };
  return client.createBug(input, `bug:${crypto.randomUUID()}`);
}

async function waitFor(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error('等待 Worker 完成超时');
}

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

const NOOP_LOGGER: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return this;
  },
  async flush() {},
  async close() {},
};
