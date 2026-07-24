import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ControlPlanePort } from '@agent-party-time/control-plane-client';
import { ERROR_CODES, createAppError } from '@agent-party-time/shared';
import type {
  CollaborativeCommand,
  CollaborativeCommandResult,
  CollaborativeQuery,
  CollaborativeQueryResult,
  CodexInteractionRequest,
  SubmissionBug,
  SubmissionCleanupTask,
  SubmissionRepairTask,
  SubmissionUpdateBatch,
  TestSubmissionDetail,
  TestSubmissionSummary,
} from '@agent-party-time/shared';
import type { Logger } from '../logging/logger.js';
import {
  type StructuredExecutionInput,
  type StructuredExecutionResult,
  type StructuredExecutor,
} from './codex-app-server.js';
import { CollaborativeSubmissionWorker } from './collaborative-submission-worker.js';
import { RunnerStateStore } from './runner-state-store.js';

describe('CollaborativeSubmissionWorker', () => {
  const directories = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...directories].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
    directories.clear();
  });

  test('labels preparation failures without blaming Runner or Codex', async () => {
    const fixture = await createFixture('LOCAL_SCRIPT');
    directories.add(fixture.directory);
    fixture.controlPlane.bugQueryError = new Error('Bug 协议解析失败');
    fixture.controlPlane.repairQueue.push(repairTask(fixture));
    const executor = new ScriptedExecutor(() => {
      throw new Error('不应启动 Codex');
    });
    const worker = fixture.worker(executor, 1);

    worker.start();
    await waitFor(() => fixture.controlPlane.successfulFinishes.length === 1);
    await worker.stop();

    expect(executor.inputs).toHaveLength(0);
    expect(fixture.controlPlane.successfulFinishes[0]).toMatchObject({
      kind: 'repair_task.fail_start',
      summary: '修复任务启动失败：Bug 协议解析失败',
    });
  });

  test('drops a stale finish outbox after the task lease is lost', async () => {
    const fixture = await createFixture('LOCAL_SCRIPT');
    directories.add(fixture.directory);
    const pending = await fixture.stateStore.saveCollaborativePendingOutcome({
      command: {
        kind: 'repair_task.finish',
        taskId: randomUUID(),
        runnerId: fixture.runner.runnerId,
        leaseToken: `lease-${randomUUID()}`,
        sessionId: null,
        outcome: 'INFRASTRUCTURE_ERROR',
        summary: '旧租约下产生的结果',
        candidateCommit: null,
      },
    });
    fixture.controlPlane.finishError = Object.assign(
      new Error('修复任务租约不匹配'),
      {
        appError: createAppError({
          code: ERROR_CODES.jobLeaseLost,
          category: 'conflict',
          message: '修复任务租约不匹配',
          retryable: false,
        }),
      },
    );
    const worker = fixture.worker(
      new ScriptedExecutor(() => {
        throw new Error('不应启动 Codex');
      }),
      1,
    );

    worker.start();
    await waitFor(() =>
      fixture.stateStore
        .listCollaborativePendingOutcomes()
        .then((items) => items.length === 0),
    );
    await worker.stop();

    const finishCalls = fixture.controlPlane.commands.filter(({ input }) =>
      input.kind.endsWith('.finish'),
    );
    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0]!.idempotencyKey).toBe(pending.id);
  });

  test('resumes the original repair thread and replays the finish outbox', async () => {
    const fixture = await createFixture('LOCAL_SCRIPT');
    directories.add(fixture.directory);
    const attachmentId = randomUUID();
    fixture.bug.attachments.push({
      id: attachmentId,
      bugId: fixture.bug.id,
      fileName: 'evidence.txt',
      mediaType: 'text/plain',
      sizeBytes: Buffer.byteLength('repair evidence'),
      createdAt: now(),
    });
    fixture.bug.latestFeedback = '验证失败：保存后页面仍为空';
    fixture.bug.repairRecords.push({
      id: randomUUID(),
      bugId: fixture.bug.id,
      taskId: randomUUID(),
      phase: 'EXECUTION',
      sessionId: 'session-previous',
      outcome: 'FAILED',
      summary: '第一次尝试未复现',
      candidateCommit: null,
      createdAt: now(),
    });
    fixture.controlPlane.attachmentContents.set(
      attachmentId,
      Buffer.from('repair evidence').toString('base64'),
    );
    fixture.controlPlane.repairQueue.push(
      repairTask(fixture, { resumeSessionId: 'session-resume' }),
    );
    fixture.controlPlane.finishFailuresRemaining = 1;
    const executor = new ScriptedExecutor(({ input }) => ({
      sessionId: 'session-resume',
      result: input.resultSchema.parse({
        status: 'ready',
        summary: '已修复并验证',
        changes: [{ path: 'src/save.ts', summary: '修复保存逻辑' }],
        checks: [{ name: 'unit', status: 'passed', summary: '通过' }],
        candidateCommit: 'deadbeef',
        reason: null,
      }),
    }));
    const worker = fixture.worker(executor, 2);

    worker.start();
    await waitFor(
      () =>
        fixture.controlPlane.successfulFinishes.length === 1 &&
        fixture.stateStore
          .listCollaborativePendingOutcomes()
          .then((items) => items.length === 0),
    );
    await worker.stop();

    expect(executor.inputs).toHaveLength(1);
    expect(executor.inputs[0]!.resumeSessionId).toBe('session-resume');
    expect(executor.inputs[0]!.prompt).toContain('验证失败：保存后页面仍为空');
    expect(executor.inputs[0]!.prompt).toContain('第一次尝试未复现');
    expect(executor.inputs[0]!.prompt).toContain('用户自定义工作流');
    expect(executor.inputs[0]!.prompt).toContain('原 Codex Thread');
    expect(executor.inputs[0]!.prompt).toContain(
      '每次收到“继续”后，都必须重新读取持续上下文文件',
    );
    const attachmentPath = executor.inputs[0]!.prompt.split('\n')
      .find((line) => line.includes('evidence.txt'))
      ?.replace(/^- /, '');
    expect(attachmentPath).toBeTruthy();
    expect(await readFile(attachmentPath!, 'utf8')).toBe('repair evidence');
    const repairContextPath = continuationContextPath(
      executor.inputs[0]!.prompt,
    );
    expect(repairContextPath).toContain(`/repair/${fixture.bug.id}/`);
    expect(JSON.parse(await readFile(repairContextPath, 'utf8'))).toMatchObject(
      {
        schemaVersion: 1,
        executionKind: 'REPAIR',
        bug: {
          id: fixture.bug.id,
          latestFeedback: '验证失败：保存后页面仍为空',
          repairRecords: [
            expect.objectContaining({ summary: '第一次尝试未复现' }),
          ],
        },
        attachmentPaths: [attachmentPath],
      },
    );

    const finishCalls = fixture.controlPlane.commands.filter(
      ({ input }) => input.kind === 'repair_task.finish',
    );
    expect(finishCalls).toHaveLength(2);
    expect(finishCalls[0]!.idempotencyKey).toBe(finishCalls[1]!.idempotencyKey);
    expect(fixture.controlPlane.successfulFinishes[0]).toMatchObject({
      kind: 'repair_task.finish',
      outcome: 'READY',
      sessionId: 'session-resume',
      candidateCommit: 'deadbeef',
    });
  });

  test('passes update evidence to Codex and serializes cleanup for the same binding', async () => {
    const fixture = await createFixture('CI_CD');
    directories.add(fixture.directory);
    const batch = updateBatch(fixture);
    batch.externalFailure = 'Pipeline 42 的 smoke test 失败';
    batch.externalFailureAttachments.push({
      id: randomUUID(),
      batchId: batch.id,
      fileName: 'pipeline.json',
      mediaType: 'application/json',
      sizeBytes: Buffer.byteLength('{"failed":true}'),
      contentBase64: Buffer.from('{"failed":true}').toString('base64'),
      createdAt: now(),
    });
    fixture.controlPlane.updateQueue.push(batch);
    fixture.controlPlane.cleanupQueue.push(cleanupTask(fixture));
    const executor = new ScriptedExecutor(({ input }) => {
      if (input.prompt.includes('update-batch-start'))
        return {
          sessionId: 'session-update',
          result: input.resultSchema.parse({
            outcome: 'PUSHED',
            summary: '候选提交已集成并普通 Push',
          }),
        };
      return {
        sessionId: null,
        result: input.resultSchema.parse({
          success: true,
          summary: '仅清理了系统临时 worktree',
        }),
      };
    });
    const worker = fixture.worker(executor, 2);

    worker.start();
    await waitFor(() => fixture.controlPlane.successfulFinishes.length === 2);
    await worker.stop();

    expect(executor.inputs).toHaveLength(2);
    expect(executor.inputs[0]!.prompt).toContain('Pipeline 42');
    expect(executor.inputs[0]!.prompt).toContain('deadbeef');
    expect(executor.inputs[0]!.prompt).toContain('已经冻结的原子 Batch');
    expect(executor.inputs[0]!.prompt).toContain('不得自动拆批');
    expect(executor.inputs[0]!.prompt).toContain('Batch integration Commit');
    expect(executor.inputs[0]!.prompt).toContain(
      '每次收到“继续”后，都必须重新读取持续上下文文件',
    );
    const feedbackPath = executor.inputs[0]!.prompt.split('\n')
      .find((line) => line.includes('pipeline.json'))
      ?.replace(/^- /, '');
    expect(feedbackPath).toBeTruthy();
    expect(await readFile(feedbackPath!, 'utf8')).toBe('{"failed":true}');
    const updateContextPath = continuationContextPath(
      executor.inputs[0]!.prompt,
    );
    expect(updateContextPath).toContain(`/update/${batch.id}/`);
    expect(JSON.parse(await readFile(updateContextPath, 'utf8'))).toMatchObject(
      {
        schemaVersion: 1,
        executionKind: 'UPDATE',
        batchId: batch.id,
        externalFailure: 'Pipeline 42 的 smoke test 失败',
        feedbackAttachmentPaths: [feedbackPath],
      },
    );
    expect(executor.inputs[1]!.prompt).toContain(
      '只清理本提测单由系统明确创建',
    );
    expect(executor.inputs[1]!.prompt).toContain('绝不删除目标分支');
    expect(fixture.controlPlane.successfulFinishes).toEqual([
      expect.objectContaining({
        kind: 'update_task.finish',
        outcome: 'PUSHED',
        sessionId: 'session-update',
      }),
      expect.objectContaining({ kind: 'cleanup_task.finish', success: true }),
    ]);
  });

  test('refreshes stable repair continuation context before resuming the original thread', async () => {
    const fixture = await createFixture('LOCAL_SCRIPT');
    directories.add(fixture.directory);
    fixture.bug.latestFeedback = '第一次反馈';
    fixture.controlPlane.repairQueue.push(repairTask(fixture));
    const contexts: Array<{ path: string; value: Record<string, unknown> }> =
      [];
    const executor = new ScriptedExecutor(async ({ input, call }) => {
      const path = continuationContextPath(input.prompt);
      contexts.push({
        path,
        value: JSON.parse(await readFile(path, 'utf8')) as Record<
          string,
          unknown
        >,
      });
      if (call === 1) {
        fixture.bug.latestFeedback = '第二次反馈';
        fixture.bug.updatedAt = new Date(Date.now() + 1_000).toISOString();
        fixture.controlPlane.repairQueue.push(
          repairTask(fixture, { resumeSessionId: 'repair-thread' }),
        );
      }
      return {
        sessionId: 'repair-thread',
        result: input.resultSchema.parse({
          status: 'ready',
          summary: '完成',
          changes: [],
          checks: [],
          candidateCommit: `candidate-${call}`,
          reason: null,
        }),
      };
    });
    const worker = fixture.worker(executor, 1);

    worker.start();
    await waitFor(() => fixture.controlPlane.successfulFinishes.length === 2);
    await worker.stop();

    expect(contexts).toHaveLength(2);
    expect(contexts[0]!.path).toBe(contexts[1]!.path);
    expect(contexts[0]!.value).toMatchObject({
      executionKind: 'REPAIR',
      bug: { latestFeedback: '第一次反馈' },
    });
    expect(contexts[1]!.value).toMatchObject({
      executionKind: 'REPAIR',
      bug: { latestFeedback: '第二次反馈' },
    });
    expect(executor.inputs[1]!.resumeSessionId).toBe('repair-thread');
  });

  test('refreshes stable update continuation context before resuming the original thread', async () => {
    const fixture = await createFixture('CI_CD');
    directories.add(fixture.directory);
    const first = updateBatch(fixture);
    first.externalFailure = '第一次 Pipeline 反馈';
    fixture.controlPlane.updateQueue.push(first);
    const contexts: Array<{ path: string; value: Record<string, unknown> }> =
      [];
    const executor = new ScriptedExecutor(async ({ input, call }) => {
      const path = continuationContextPath(input.prompt);
      contexts.push({
        path,
        value: JSON.parse(await readFile(path, 'utf8')) as Record<
          string,
          unknown
        >,
      });
      if (call === 1)
        fixture.controlPlane.updateQueue.push({
          ...first,
          leaseToken: `lease-${randomUUID()}`,
          sessionId: 'update-thread',
          externalFailure: '第二次 Pipeline 反馈',
          updatedAt: new Date(Date.now() + 1_000).toISOString(),
        });
      return {
        sessionId: 'update-thread',
        result: input.resultSchema.parse({
          outcome: 'PUSHED',
          summary: `第 ${call} 次 Push 完成`,
        }),
      };
    });
    const worker = fixture.worker(executor, 1);

    worker.start();
    await waitFor(() => fixture.controlPlane.successfulFinishes.length === 2);
    await worker.stop();

    expect(contexts).toHaveLength(2);
    expect(contexts[0]!.path).toBe(contexts[1]!.path);
    expect(contexts[0]!.value).toMatchObject({
      executionKind: 'UPDATE',
      externalFailure: '第一次 Pipeline 反馈',
    });
    expect(contexts[1]!.value).toMatchObject({
      executionKind: 'UPDATE',
      externalFailure: '第二次 Pipeline 反馈',
    });
    expect(executor.inputs[1]!.resumeSessionId).toBe('update-thread');
  });

  test('claims update work before repair work at the same scheduling point', async () => {
    const fixture = await createFixture('LOCAL_SCRIPT');
    directories.add(fixture.directory);
    fixture.controlPlane.repairQueue.push(repairTask(fixture));
    fixture.controlPlane.updateQueue.push(updateBatch(fixture));
    const executor = new ScriptedExecutor(({ input }) => {
      if (input.prompt.includes('update-batch-start'))
        return {
          sessionId: 'session-update-first',
          result: input.resultSchema.parse({
            outcome: 'COMPLETED',
            summary: '整批更新完成',
          }),
        };
      return {
        sessionId: 'session-repair-second',
        result: input.resultSchema.parse({
          status: 'ready',
          summary: '修复完成',
          changes: [],
          checks: [],
          candidateCommit: 'repair-after-update',
          reason: null,
        }),
      };
    });
    const worker = fixture.worker(executor, 1);

    worker.start();
    await waitFor(() => fixture.controlPlane.successfulFinishes.length === 2);
    await worker.stop();

    expect(executor.inputs).toHaveLength(2);
    expect(executor.inputs[0]!.prompt).toContain('update-batch-start');
    expect(executor.inputs[1]!.prompt).toContain('bug-repair-start');
    expect(
      fixture.controlPlane.successfulFinishes.map((item) => item.kind),
    ).toEqual(['update_task.finish', 'repair_task.finish']);
  });

  test('releases the binding slot while Codex waits and resumes after the running turn', async () => {
    const fixture = await createFixture('LOCAL_SCRIPT');
    directories.add(fixture.directory);
    fixture.controlPlane.repairQueue.push(
      repairTask(fixture),
      repairTask(fixture),
    );
    const events: string[] = [];
    let releaseSecond!: () => void;
    const secondRunning = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const executor = new ScriptedExecutor(async ({ input, call }) => {
      if (call === 1) {
        events.push('first:waiting');
        const amendmentDecision = {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: ['git', 'diff', '--cached', '--check'],
          },
        };
        const response = await input.onInteraction!({
          requestId: 'approval-1',
          method: 'item/commandExecution/requestApproval',
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          params: {
            reason: '需要检查候选提交',
            availableDecisions: ['accept', amendmentDecision, 'cancel'],
          },
        });
        expect(response).toEqual({ decision: amendmentDecision });
        events.push('first:resumed');
      } else {
        events.push('second:running');
        await secondRunning;
        events.push('second:finished');
      }
      return {
        sessionId: `session-${call}`,
        result: input.resultSchema.parse({
          status: 'ready',
          summary: '完成',
          changes: [],
          checks: [],
          candidateCommit: `commit-${call}`,
          reason: null,
        }),
      };
    });
    const worker = fixture.worker(executor, 1);

    worker.start();
    await waitFor(
      () =>
        fixture.controlPlane.interactions.size === 1 &&
        events.includes('second:running'),
    );
    const interaction = [...fixture.controlPlane.interactions.values()][0]!;
    await fixture.controlPlane.collaborativeCommand({
      kind: 'interaction.resolve',
      interactionId: interaction.id,
      action: 'ACCEPT_FOR_SESSION',
    });
    await Bun.sleep(20);
    expect(events).not.toContain('first:resumed');

    releaseSecond();
    await waitFor(() => fixture.controlPlane.successfulFinishes.length === 2);
    await worker.stop();

    expect(events.indexOf('second:finished')).toBeLessThan(
      events.indexOf('first:resumed'),
    );
  });

  test('runs different bindings concurrently and keeps Runner free of repository commands', async () => {
    const fixture = await createFixture('LOCAL_SCRIPT');
    directories.add(fixture.directory);
    const second = await fixture.addBinding();
    const secondBug = bugFixture(fixture.submission, second.item.id);
    fixture.controlPlane.bugs.set(secondBug.id, secondBug);
    fixture.controlPlane.repairQueue.push(
      repairTask(fixture),
      repairTask(
        { ...fixture, bug: secondBug, bindingId: second.bindingId },
        { submissionItemId: second.item.id },
      ),
    );
    let active = 0;
    let maxActive = 0;
    const executor = new ScriptedExecutor(async ({ input }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(25);
      active -= 1;
      return {
        sessionId: `session-${input.executionId}`,
        result: input.resultSchema.parse({
          status: 'ready',
          summary: '完成',
          changes: [],
          checks: [],
          candidateCommit: input.executionId,
          reason: null,
        }),
      };
    });
    const worker = fixture.worker(executor, 2);

    worker.start();
    await waitFor(() => fixture.controlPlane.successfulFinishes.length === 2);
    await worker.stop();

    expect(maxActive).toBe(2);
    const source = await readFile(
      new URL('./collaborative-submission-worker.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/spawn(?:Sync)?\s*\(/);
    expect(source).not.toMatch(/execFile(?:Sync)?\s*\(/);
    expect(source).not.toMatch(
      /\b(?:git|bun|npm|pnpm|yarn|mvn|gradle|pytest|cargo)\s+(?:push|test|build|run|deploy)\b/,
    );
  });
});

class FakeControlPlane {
  readonly commands: Array<{
    input: CollaborativeCommand;
    idempotencyKey?: string;
  }> = [];
  readonly successfulFinishes: CollaborativeCommand[] = [];
  readonly repairQueue: SubmissionRepairTask[] = [];
  readonly updateQueue: SubmissionUpdateBatch[] = [];
  readonly cleanupQueue: SubmissionCleanupTask[] = [];
  readonly bugs = new Map<string, SubmissionBug>();
  readonly submissions = new Map<string, TestSubmissionDetail>();
  readonly attachmentContents = new Map<string, string>();
  readonly interactions = new Map<string, CodexInteractionRequest>();
  finishFailuresRemaining = 0;
  finishError: Error | null = null;
  bugQueryError: Error | null = null;

  async collaborativeCommand(
    input: CollaborativeCommand,
    idempotencyKey?: string,
  ): Promise<CollaborativeCommandResult> {
    this.commands.push({ input, idempotencyKey });
    if (input.kind === 'repair_task.claim')
      return {
        kind: input.kind,
        repairTask: this.repairQueue.shift() ?? null,
      };
    if (input.kind === 'update_task.claim')
      return {
        kind: input.kind,
        updateBatch: this.updateQueue.shift() ?? null,
      };
    if (input.kind === 'cleanup_task.claim')
      return {
        kind: input.kind,
        cleanupTask: this.cleanupQueue.shift() ?? null,
      };
    if (input.kind === 'interaction.open') {
      const interaction: CodexInteractionRequest = {
        id: randomUUID(),
        executionKind: input.executionKind,
        executionId: input.executionId,
        submissionItemId: input.submissionItemId,
        bindingId: input.bindingId,
        kind: input.interactionKind,
        method: input.method,
        threadId: input.threadId,
        turnId: input.turnId,
        itemId: input.itemId,
        payload: input.payload,
        state: 'PENDING',
        resolution: null,
        createdAt: now(),
        resolvedAt: null,
      };
      this.interactions.set(interaction.id, interaction);
      return { kind: input.kind, interaction };
    }
    if (input.kind === 'interaction.resolve') {
      const interaction = this.interactions.get(input.interactionId);
      if (!interaction) return { kind: input.kind, interaction: null };
      interaction.state = 'RESOLVED';
      interaction.resolution = {
        action: input.action,
        ...(input.answers ? { answers: input.answers } : {}),
      };
      interaction.resolvedAt = now();
      return { kind: input.kind, interaction };
    }
    if (input.kind === 'interaction.invalidate') {
      const interaction = [...this.interactions.values()].find(
        (candidate) =>
          candidate.executionKind === input.executionKind &&
          candidate.executionId === input.executionId &&
          candidate.state === 'PENDING',
      );
      if (interaction) {
        interaction.state = 'INVALIDATED';
        interaction.resolvedAt = now();
      }
      return { kind: input.kind, interaction: interaction ?? null };
    }
    if (
      input.kind === 'repair_task.fail_start' ||
      input.kind.endsWith('.finish')
    ) {
      if (this.finishError) throw this.finishError;
      if (this.finishFailuresRemaining > 0) {
        this.finishFailuresRemaining -= 1;
        throw new Error('temporary control-plane failure');
      }
      this.successfulFinishes.push(input);
    }
    return { kind: input.kind };
  }

  async collaborativeQuery(
    input: CollaborativeQuery,
  ): Promise<CollaborativeQueryResult> {
    if (input.kind === 'submission.list')
      return {
        kind: input.kind,
        submissions: [...this.submissions.values()].map(summaryOf),
      };
    if (input.kind === 'submission.get')
      return {
        kind: input.kind,
        submission: this.submissions.get(input.submissionId),
      };
    if (input.kind === 'bug.get') {
      if (this.bugQueryError) throw this.bugQueryError;
      return { kind: input.kind, bug: this.bugs.get(input.bugId) };
    }
    if (input.kind === 'interaction.get')
      return {
        kind: input.kind,
        interaction: this.interactions.get(input.interactionId),
      };
    if (input.kind === 'bug.attachment.get') {
      const bug = [...this.bugs.values()].find((candidate) =>
        candidate.attachments.some(
          (attachment) => attachment.id === input.attachmentId,
        ),
      );
      const attachment = bug?.attachments.find(
        (candidate) => candidate.id === input.attachmentId,
      );
      return {
        kind: input.kind,
        attachment,
        contentBase64: this.attachmentContents.get(input.attachmentId),
      };
    }
    return { kind: input.kind };
  }
}

class ScriptedExecutor implements StructuredExecutor {
  readonly inputs: StructuredExecutionInput<unknown>[] = [];
  private calls = 0;

  constructor(
    private readonly execute: (context: {
      input: StructuredExecutionInput<unknown>;
      call: number;
    }) =>
      | StructuredExecutionResult<unknown>
      | Promise<StructuredExecutionResult<unknown>>,
  ) {}

  async executeStructured<TResult>(
    input: StructuredExecutionInput<TResult>,
  ): Promise<StructuredExecutionResult<TResult>> {
    this.calls += 1;
    this.inputs.push(input as StructuredExecutionInput<unknown>);
    return (await this.execute({
      input: input as StructuredExecutionInput<unknown>,
      call: this.calls,
    })) as StructuredExecutionResult<TResult>;
  }
}

function continuationContextPath(prompt: string) {
  const prefix = '持续上下文文件：';
  const line = prompt
    .split('\n')
    .find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error('prompt 缺少持续上下文文件路径');
  return line.slice(prefix.length);
}

async function createFixture(deploymentType: 'LOCAL_SCRIPT' | 'CI_CD') {
  const directory = await mkdtemp(join(tmpdir(), 'apt-collaborative-worker-'));
  const stateStore = new RunnerStateStore(join(directory, 'runner.json'));
  const runner = await stateStore.ensureIdentity('Collaborative Runner');
  const submission = submissionFixture(deploymentType);
  const item = submission.items[0]!;
  const bindingId = item.technical!.bindingId;
  await stateStore.saveEngineeringBinding({
    bindingId,
    engineeringId: item.engineeringId,
    developerUserId: item.responsibleDeveloper.id,
    runnerId: runner.runnerId,
    repositoryPath: join(directory, 'repository-a'),
    createdAt: now(),
    updatedAt: now(),
  });
  const bug = bugFixture(submission, item.id);
  const controlPlane = new FakeControlPlane();
  controlPlane.submissions.set(submission.id, submission);
  controlPlane.bugs.set(bug.id, bug);

  return {
    directory,
    stateStore,
    runner,
    submission,
    bug,
    bindingId,
    controlPlane,
    worker(executor: StructuredExecutor, maxConcurrent: number) {
      return new CollaborativeSubmissionWorker({
        controlPlane: controlPlane as unknown as ControlPlanePort,
        runner,
        stateStore,
        executor,
        artifactsDirectory: join(directory, 'artifacts'),
        logger: NOOP_LOGGER,
        maxConcurrent,
        pollIntervalMs: 2,
        leaseRenewIntervalMs: 1_000,
      });
    },
    async addBinding() {
      const item = submissionItemFixture(submission.id, deploymentType);
      submission.items.push(item);
      submission.itemCount = submission.items.length;
      await stateStore.saveEngineeringBinding({
        bindingId: item.technical!.bindingId,
        engineeringId: item.engineeringId,
        developerUserId: item.responsibleDeveloper.id,
        runnerId: runner.runnerId,
        repositoryPath: join(directory, 'repository-b'),
        createdAt: now(),
        updatedAt: now(),
      });
      return { item, bindingId: item.technical!.bindingId };
    },
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

function submissionFixture(
  deploymentType: 'LOCAL_SCRIPT' | 'CI_CD',
): TestSubmissionDetail {
  const submissionId = randomUUID();
  const item = submissionItemFixture(submissionId, deploymentType);
  return {
    id: submissionId,
    projectId: randomUUID(),
    projectTitle: '协作项目',
    title: '协作提测',
    requirementDescription: '支持多工程修复和统一更新',
    tester: user('tester-1', 'TESTER'),
    status: 'ACTIVE',
    itemCount: 1,
    bugCounts: emptyBugCounts(),
    createdByUserId: 'developer-1',
    createdAt: now(),
    updatedAt: now(),
    closedAt: null,
    items: [item],
  };
}

function submissionItemFixture(
  submissionId: string,
  deploymentType: 'LOCAL_SCRIPT' | 'CI_CD',
): TestSubmissionDetail['items'][number] {
  return {
    id: randomUUID(),
    submissionId,
    engineeringId: randomUUID(),
    engineeringSlug: `engineering-${randomUUID().slice(0, 8)}`,
    engineeringDisplayName: '订单前端',
    engineeringType: 'FRONTEND',
    responsibleDeveloper: user('developer-1', 'DEVELOPER'),
    testTarget: {
      targetBranch: 'develop',
      environment: { slug: 'test', displayName: '测试环境' },
    },
    technical: {
      repositoryUrl: 'https://example.test/order.git',
      bindingId: randomUUID(),
      runnerId: randomUUID(),
      targetBranch: 'develop',
      environment: {
        id: randomUUID(),
        slug: 'test',
        displayName: '测试环境',
        deploymentType,
        localScriptCommand:
          deploymentType === 'LOCAL_SCRIPT' ? 'bun run deploy:test' : null,
        manualConfirmationRequired: deploymentType === 'CI_CD',
      },
    },
    lockedAt: now(),
    createdAt: now(),
    updatedAt: now(),
  };
}

function bugFixture(
  submission: TestSubmissionDetail,
  submissionItemId: string,
): SubmissionBug {
  return {
    id: randomUUID(),
    shortId: `BUG-${Math.floor(1000 + Math.random() * 9000)}`,
    submissionId: submission.id,
    submissionItemId,
    engineeringType: 'FRONTEND',
    engineeringDisplayName: '订单前端',
    status: 'REPAIRING',
    title: '保存后内容为空',
    operationPath: '打开编辑页并点击保存',
    actualResult: '页面内容为空',
    expectedResult: '展示刚保存的数据',
    supplementalDescription: '仅在测试环境复现',
    latestFeedback: null,
    attachments: [],
    repairActivity: 'RUNNING',
    latestRepairFailed: false,
    repairRecords: [],
    candidateCommit: 'deadbeef',
    repairSessionId: null,
    createdByUserId: 'tester-1',
    createdAt: now(),
    updatedAt: now(),
  };
}

function repairTask(
  fixture: Pick<Fixture, 'bug' | 'bindingId' | 'runner'>,
  overrides: Partial<SubmissionRepairTask> = {},
): SubmissionRepairTask {
  return {
    id: randomUUID(),
    bugId: fixture.bug.id,
    submissionItemId: fixture.bug.submissionItemId!,
    bindingId: fixture.bindingId,
    runnerId: fixture.runner.runnerId,
    state: 'RUNNING',
    position: 0,
    leaseToken: `lease-${randomUUID()}`,
    leaseExpiresAt: now(),
    resumeSessionId: null,
    failurePhase: null,
    failureSummary: null,
    createdAt: now(),
    startedAt: now(),
    completedAt: null,
    ...overrides,
  };
}

function updateBatch(fixture: Fixture): SubmissionUpdateBatch {
  return {
    id: randomUUID(),
    submissionItemId: fixture.submission.items[0]!.id,
    bindingId: fixture.bindingId,
    runnerId: fixture.runner.runnerId,
    state: 'RUNNING',
    deploymentType:
      fixture.submission.items[0]!.technical!.environment.deploymentType,
    bugIds: [fixture.bug.id],
    candidateCommits: ['deadbeef'],
    eligibleAt: now(),
    immediateRequestedAt: null,
    sessionId: null,
    leaseToken: `lease-${randomUUID()}`,
    leaseExpiresAt: now(),
    externalFailure: null,
    externalFailureAttachments: [],
    createdAt: now(),
    updatedAt: now(),
    completedAt: null,
  };
}

function cleanupTask(fixture: Fixture): SubmissionCleanupTask {
  return {
    id: randomUUID(),
    submissionId: fixture.submission.id,
    submissionItemId: fixture.submission.items[0]!.id,
    bindingId: fixture.bindingId,
    runnerId: fixture.runner.runnerId,
    state: 'RUNNING',
    sessionIds: ['session-update'],
    summary: null,
    leaseToken: `lease-${randomUUID()}`,
    leaseExpiresAt: now(),
    retryCount: 0,
    createdAt: now(),
    updatedAt: now(),
  };
}

function summaryOf(submission: TestSubmissionDetail): TestSubmissionSummary {
  const { items: _items, ...summary } = submission;
  return summary;
}

function user(id: string, accountType: 'DEVELOPER' | 'TESTER') {
  return {
    id,
    username: id,
    displayName: id === 'tester-1' ? '测试同学' : '开发同学',
    accountType,
  } as const;
}

function emptyBugCounts() {
  return {
    waitingForRepair: 0,
    repairing: 0,
    waitingForUpdate: 0,
    updating: 0,
    waitingForVerification: 0,
    done: 0,
  };
}

function now() {
  return new Date().toISOString();
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('等待 Worker 测试条件超时');
    await Bun.sleep(5);
  }
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
