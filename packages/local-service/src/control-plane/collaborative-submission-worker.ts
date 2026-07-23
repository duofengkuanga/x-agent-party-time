import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  BUG_REPAIR_OUTPUT_JSON_SCHEMA,
  RepairResultSchema,
  type CodexInteractionRequest,
  type CollaborativeCommand,
  type RepairPrompt,
  type SubmissionBug,
  type SubmissionCleanupTask,
  type SubmissionRepairTask,
  type SubmissionUpdateBatch,
  type TestSubmissionDetail,
} from '@agent-party-time/shared';
import type { ControlPlanePort } from '@agent-party-time/control-plane-client';
import { z } from 'zod';
import type { Logger } from '../logging/logger.js';
import {
  BindingExecutionCoordinator,
  type BindingExecutionSlot,
} from './binding-execution-coordinator.js';
import {
  CodexAppServerError,
  type CodexAppServerInteraction,
  type StructuredExecutionResult,
  type StructuredExecutor,
} from './codex-app-server.js';
import type {
  PendingCollaborativeOutcome,
  RunnerStateStore,
} from './runner-state-store.js';

const UpdateExecutionResultSchema = z.object({
  outcome: z.enum(['PUSHED', 'COMPLETED', 'FAILED']),
  summary: z.string().trim().min(1).max(12_000),
});
const CleanupExecutionResultSchema = z.object({
  success: z.boolean(),
  summary: z.string().trim().min(1).max(8_000),
});

const UPDATE_OUTPUT_JSON_SCHEMA: RepairPrompt['outputSchema'] = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'summary'],
  properties: {
    outcome: {
      type: 'string',
      enum: ['PUSHED', 'COMPLETED', 'FAILED'],
    },
    summary: { type: 'string', minLength: 1, maxLength: 12000 },
  },
};
const CLEANUP_OUTPUT_JSON_SCHEMA: RepairPrompt['outputSchema'] = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'summary'],
  properties: {
    success: { type: 'boolean' },
    summary: { type: 'string', minLength: 1, maxLength: 8000 },
  },
};

type TestSubmissionItem = TestSubmissionDetail['items'][number];

type CollaborativeFinishCommand = Extract<
  CollaborativeCommand,
  {
    kind: 'repair_task.finish' | 'update_task.finish' | 'cleanup_task.finish';
  }
>;

type ClaimedWork =
  | { kind: 'repair'; task: SubmissionRepairTask }
  | { kind: 'update'; task: SubmissionUpdateBatch }
  | { kind: 'cleanup'; task: SubmissionCleanupTask };

export interface CollaborativeSubmissionWorkerOptions {
  controlPlane: ControlPlanePort;
  runner: { runnerId: string; runnerName: string };
  stateStore: RunnerStateStore;
  executor: StructuredExecutor;
  artifactsDirectory: string;
  logger: Logger;
  maxConcurrent: number;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  leaseRenewIntervalMs?: number;
}

/**
 * Thin Runner for the collaborative submission workflow. It only claims work,
 * prepares versioned Codex prompts, renews leases and relays structured
 * results. Repository, Git, test, build, push, deployment and cleanup actions
 * are deliberately delegated to Codex.
 */
export class CollaborativeSubmissionWorker {
  private controller: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private readonly coordinator: BindingExecutionCoordinator;
  private readonly activeJobs = new Set<Promise<void>>();
  private readonly submittingOutcomeIds = new Set<string>();

  constructor(private readonly options: CollaborativeSubmissionWorkerOptions) {
    this.coordinator = new BindingExecutionCoordinator(options.maxConcurrent);
  }

  start() {
    if (this.loopPromise) return;
    this.controller = new AbortController();
    this.loopPromise = this.runLoop(this.controller.signal).finally(() => {
      this.loopPromise = null;
      this.controller = null;
    });
  }

  async stop() {
    this.controller?.abort();
    await this.loopPromise;
  }

  running() {
    return this.loopPromise !== null;
  }

  private async runLoop(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        await this.replayPendingOutcomes(signal);
        if (signal.aborted) break;

        let claimed = false;
        while (!signal.aborted && this.coordinator.availableSlots > 0) {
          const work = await this.claimNextWork();
          if (!work) break;
          claimed = true;
          this.schedule(work, signal);
        }
        if (signal.aborted) break;
        if (!claimed)
          await waitForWork(
            this.activeJobs,
            this.options.pollIntervalMs ?? 1_000,
            signal,
          );
      } catch (error) {
        if (signal.aborted) break;
        this.options.logger.warn(
          'collaborative_submission.worker_failed',
          '协作提测 Worker 执行失败，将稍后重试',
          { error: messageOf(error) },
        );
        await delay(this.options.pollIntervalMs ?? 1_000, signal);
      }
    }
    await Promise.allSettled(this.activeJobs);
  }

  private async replayPendingOutcomes(signal: AbortSignal) {
    for (const pending of await this.options.stateStore.listCollaborativePendingOutcomes()) {
      if (signal.aborted) return;
      await this.submitPendingOutcome(pending);
    }
  }

  private async submitPendingOutcome(pending: PendingCollaborativeOutcome) {
    if (this.submittingOutcomeIds.has(pending.id)) return;
    this.submittingOutcomeIds.add(pending.id);
    try {
      await this.options.controlPlane.collaborativeCommand(
        pending.command,
        pending.id,
      );
      await this.options.stateStore.removeCollaborativePendingOutcome(
        pending.id,
      );
    } finally {
      this.submittingOutcomeIds.delete(pending.id);
    }
  }

  private async claimNextWork(): Promise<ClaimedWork | null> {
    const common = {
      runnerId: this.options.runner.runnerId,
      leaseDurationMs: this.options.leaseDurationMs ?? 60_000,
    };
    const update = await this.options.controlPlane.collaborativeCommand({
      kind: 'update_task.claim',
      ...common,
    });
    if (update.updateBatch) return { kind: 'update', task: update.updateBatch };

    const repair = await this.options.controlPlane.collaborativeCommand({
      kind: 'repair_task.claim',
      ...common,
    });
    if (repair.repairTask) return { kind: 'repair', task: repair.repairTask };

    const cleanup = await this.options.controlPlane.collaborativeCommand({
      kind: 'cleanup_task.claim',
      ...common,
    });
    return cleanup.cleanupTask
      ? { kind: 'cleanup', task: cleanup.cleanupTask }
      : null;
  }

  private schedule(work: ClaimedWork, signal: AbortSignal) {
    const promise = this.coordinator
      .run(
        work.task.bindingId,
        async (slot) => {
          if (work.kind === 'repair')
            await this.processRepair(work.task, signal, slot);
          else if (work.kind === 'update')
            await this.processUpdate(work.task, signal, slot);
          else await this.processCleanup(work.task, signal, slot);
        },
        work.kind === 'repair' ? 2 : 1,
      )
      .catch((error) => {
        if (signal.aborted) return;
        this.options.logger.warn(
          'collaborative_submission.work_failed',
          '协作提测任务执行失败，等待租约恢复或 outbox 重放',
          {
            kind: work.kind,
            taskId: work.task.id,
            bindingId: work.task.bindingId,
            error: messageOf(error),
          },
        );
      })
      .finally(() => this.activeJobs.delete(promise));
    this.activeJobs.add(promise);
  }

  private async processRepair(
    task: SubmissionRepairTask,
    signal: AbortSignal,
    slot: BindingExecutionSlot,
  ) {
    const stopRenewal = this.renewLease(
      () =>
        this.options.controlPlane.collaborativeCommand({
          kind: 'repair_task.renew',
          taskId: task.id,
          runnerId: this.options.runner.runnerId,
          leaseToken: requireLease(task.leaseToken),
          leaseDurationMs: this.options.leaseDurationMs ?? 60_000,
        }),
      signal,
      task.id,
    );
    let command: CollaborativeFinishCommand;
    try {
      const context = await this.loadRepairContext(task);
      const artifactsDirectory = join(
        this.options.artifactsDirectory,
        'repair',
        task.id,
      );
      const attachmentPaths = await this.writeBugAttachments(
        context.bug,
        artifactsDirectory,
      );
      const continuationContextPath = await this.writeContinuationContext(
        join(this.options.artifactsDirectory, 'repair', task.bugId),
        {
          schemaVersion: 1,
          executionKind: 'REPAIR',
          taskId: task.id,
          bug: {
            id: context.bug.id,
            shortId: context.bug.shortId,
            title: context.bug.title,
            operationPath: context.bug.operationPath,
            actualResult: context.bug.actualResult,
            expectedResult: context.bug.expectedResult,
            supplementalDescription: context.bug.supplementalDescription,
            latestFeedback: context.bug.latestFeedback,
            attempts: context.bug.attempts,
          },
          attachmentPaths,
          updatedAt: context.bug.updatedAt,
        },
      );
      const prompt = repairPrompt(
        context,
        attachmentPaths,
        continuationContextPath,
      );
      const execution = await this.options.executor.executeStructured(
        {
          executionId: task.id,
          repositoryPath: context.repositoryPath,
          prompt,
          outputSchema:
            BUG_REPAIR_OUTPUT_JSON_SCHEMA as unknown as RepairPrompt['outputSchema'],
          resultSchema: RepairResultSchema,
          artifactsDirectory,
          resumeSessionId: await this.options.stateStore.resumableSession(
            task.resumeSessionId,
          ),
          onInteraction: (interaction) =>
            slot.waitFor(
              this.resolveInteraction(
                'REPAIR',
                task.id,
                task.submissionItemId,
                task.bindingId,
                interaction,
                signal,
              ),
            ),
        },
        signal,
      );
      command = {
        kind: 'repair_task.finish',
        taskId: task.id,
        runnerId: this.options.runner.runnerId,
        leaseToken: requireLease(task.leaseToken),
        sessionId: execution.sessionId,
        outcome: repairOutcome(execution.result.status),
        summary: summarizeRepair(execution.result),
        candidateCommit:
          execution.result.status === 'ready'
            ? execution.result.candidateCommit
            : null,
      };
    } catch (error) {
      await this.invalidateInteraction('REPAIR', task.id);
      command = {
        kind: 'repair_task.finish',
        taskId: task.id,
        runnerId: this.options.runner.runnerId,
        leaseToken: requireLease(task.leaseToken),
        sessionId: sessionIdOf(error),
        outcome: 'INFRASTRUCTURE_ERROR',
        summary: truncate(`Runner/Codex 执行失败：${messageOf(error)}`, 12_000),
        candidateCommit: null,
      };
    } finally {
      stopRenewal();
    }
    await this.persistAndSubmit(command);
  }

  private async processUpdate(
    batch: SubmissionUpdateBatch,
    signal: AbortSignal,
    slot: BindingExecutionSlot,
  ) {
    const stopRenewal = this.renewLease(
      () =>
        this.options.controlPlane.collaborativeCommand({
          kind: 'update_task.renew',
          batchId: batch.id,
          runnerId: this.options.runner.runnerId,
          leaseToken: requireLease(batch.leaseToken),
          leaseDurationMs: this.options.leaseDurationMs ?? 60_000,
        }),
      signal,
      batch.id,
    );
    let command: CollaborativeFinishCommand;
    try {
      const context = await this.loadUpdateContext(batch);
      const artifactsDirectory = join(
        this.options.artifactsDirectory,
        'update',
        batch.id,
      );
      const feedbackAttachments = await this.writeUpdateAttachments(
        batch,
        artifactsDirectory,
      );
      const continuationContextPath = await this.writeContinuationContext(
        artifactsDirectory,
        {
          schemaVersion: 1,
          executionKind: 'UPDATE',
          batchId: batch.id,
          deploymentType: batch.deploymentType,
          candidateCommits: batch.bugIds.map((bugId, index) => ({
            bugId,
            candidateCommit: batch.candidateCommits[index] ?? null,
          })),
          bugs: context.bugs.map((bug) => ({
            id: bug.id,
            shortId: bug.shortId,
            title: bug.title,
            latestFeedback: bug.latestFeedback,
            candidateCommit: bug.candidateCommit,
          })),
          externalFailure: batch.externalFailure,
          feedbackAttachmentPaths: feedbackAttachments,
          updatedAt: batch.updatedAt,
        },
      );
      const execution = await this.options.executor.executeStructured(
        {
          executionId: batch.id,
          repositoryPath: context.repositoryPath,
          prompt: updatePrompt(
            context,
            feedbackAttachments,
            continuationContextPath,
          ),
          outputSchema: UPDATE_OUTPUT_JSON_SCHEMA,
          resultSchema: UpdateExecutionResultSchema,
          artifactsDirectory,
          resumeSessionId: await this.options.stateStore.resumableSession(
            batch.sessionId,
          ),
          onInteraction: (interaction) =>
            slot.waitFor(
              this.resolveInteraction(
                'UPDATE',
                batch.id,
                batch.submissionItemId,
                batch.bindingId,
                interaction,
                signal,
              ),
            ),
        },
        signal,
      );
      command = {
        kind: 'update_task.finish',
        batchId: batch.id,
        runnerId: this.options.runner.runnerId,
        leaseToken: requireLease(batch.leaseToken),
        sessionId: execution.sessionId,
        outcome: normalizeUpdateOutcome(
          batch.deploymentType,
          execution.result.outcome,
        ),
        summary: execution.result.summary,
      };
    } catch (error) {
      await this.invalidateInteraction('UPDATE', batch.id);
      command = {
        kind: 'update_task.finish',
        batchId: batch.id,
        runnerId: this.options.runner.runnerId,
        leaseToken: requireLease(batch.leaseToken),
        sessionId: sessionIdOf(error),
        outcome: 'FAILED',
        summary: truncate(`Runner/Codex 执行失败：${messageOf(error)}`, 12_000),
      };
    } finally {
      stopRenewal();
    }
    await this.persistAndSubmit(command);
  }

  private async processCleanup(
    task: SubmissionCleanupTask,
    signal: AbortSignal,
    slot: BindingExecutionSlot,
  ) {
    const stopRenewal = this.renewLease(
      () =>
        this.options.controlPlane.collaborativeCommand({
          kind: 'cleanup_task.renew',
          taskId: task.id,
          runnerId: this.options.runner.runnerId,
          leaseToken: requireLease(task.leaseToken),
          leaseDurationMs: this.options.leaseDurationMs ?? 60_000,
        }),
      signal,
      task.id,
    );
    let command: CollaborativeFinishCommand;
    try {
      const context = await this.loadCleanupContext(task);
      const execution = await this.options.executor.executeStructured(
        {
          executionId: task.id,
          repositoryPath: context.repositoryPath,
          prompt: cleanupPrompt(context),
          outputSchema: CLEANUP_OUTPUT_JSON_SCHEMA,
          resultSchema: CleanupExecutionResultSchema,
          artifactsDirectory: join(
            this.options.artifactsDirectory,
            'cleanup',
            task.id,
          ),
          resumeSessionId: null,
          onInteraction: (interaction) =>
            slot.waitFor(
              this.resolveInteraction(
                'CLEANUP',
                task.id,
                task.submissionItemId,
                task.bindingId,
                interaction,
                signal,
              ),
            ),
        },
        signal,
      );
      command = {
        kind: 'cleanup_task.finish',
        taskId: task.id,
        runnerId: this.options.runner.runnerId,
        leaseToken: requireLease(task.leaseToken),
        success: execution.result.success,
        summary: execution.result.summary,
      };
    } catch (error) {
      await this.invalidateInteraction('CLEANUP', task.id);
      command = {
        kind: 'cleanup_task.finish',
        taskId: task.id,
        runnerId: this.options.runner.runnerId,
        leaseToken: requireLease(task.leaseToken),
        success: false,
        summary: truncate(`Runner/Codex 执行失败：${messageOf(error)}`, 8_000),
      };
    } finally {
      stopRenewal();
    }
    await this.persistAndSubmit(command);
  }

  private async resolveInteraction(
    executionKind: CodexInteractionRequest['executionKind'],
    executionId: string,
    submissionItemId: string,
    bindingId: string,
    interaction: CodexAppServerInteraction,
    signal: AbortSignal,
  ): Promise<unknown> {
    const opened = await this.options.controlPlane.collaborativeCommand({
      kind: 'interaction.open',
      executionKind,
      executionId,
      submissionItemId,
      bindingId,
      interactionKind:
        interaction.method === 'item/tool/requestUserInput'
          ? 'USER_INPUT'
          : 'PERMISSION',
      method: interaction.method,
      threadId: interaction.threadId,
      turnId: interaction.turnId,
      itemId: interaction.itemId,
      payload: interaction.params,
    });
    const interactionId = required(
      opened.interaction,
      'Control Plane 未返回 Codex 交互请求',
    ).id;

    while (!signal.aborted) {
      const result = await this.options.controlPlane.collaborativeQuery({
        kind: 'interaction.get',
        interactionId,
      });
      const current = required(
        result.interaction,
        'Control Plane 未返回 Codex 交互状态',
      );
      if (current.state === 'INVALIDATED')
        throw new Error('Codex 交互请求已失效');
      if (current.state === 'RESOLVED')
        return interactionResponse(current, interaction.params);
      await delay(this.options.pollIntervalMs ?? 1_000, signal);
    }
    throw new Error('Codex 交互等待已取消');
  }

  private async invalidateInteraction(
    executionKind: CodexInteractionRequest['executionKind'],
    executionId: string,
  ) {
    try {
      await this.options.controlPlane.collaborativeCommand({
        kind: 'interaction.invalidate',
        executionKind,
        executionId,
      });
    } catch (error) {
      this.options.logger.warn(
        'collaborative_submission.interaction_invalidate_failed',
        'Codex 交互请求失效标记失败',
        { executionKind, executionId, error: messageOf(error) },
      );
    }
  }

  private async loadRepairContext(task: SubmissionRepairTask) {
    const bugResult = await this.options.controlPlane.collaborativeQuery({
      kind: 'bug.get',
      bugId: task.bugId,
    });
    const bug = required(bugResult.bug, 'Control Plane 未返回修复 Bug');
    const submission = await this.getSubmission(bug.submissionId);
    const item = submissionItem(submission, task.submissionItemId);
    const repositoryPath = await this.repositoryPath(task.bindingId);
    return { task, bug, submission, item, repositoryPath };
  }

  private async loadUpdateContext(batch: SubmissionUpdateBatch) {
    const submission = await this.submissionForItem(batch.submissionItemId);
    const item = submissionItem(submission, batch.submissionItemId);
    const bugs = await Promise.all(
      batch.bugIds.map(async (bugId) => {
        const result = await this.options.controlPlane.collaborativeQuery({
          kind: 'bug.get',
          bugId,
        });
        return required(result.bug, `Control Plane 未返回 Bug ${bugId}`);
      }),
    );
    const repositoryPath = await this.repositoryPath(batch.bindingId);
    return { batch, bugs, submission, item, repositoryPath };
  }

  private async loadCleanupContext(task: SubmissionCleanupTask) {
    const submission = await this.getSubmission(task.submissionId);
    const item = submissionItem(submission, task.submissionItemId);
    const repositoryPath = await this.repositoryPath(task.bindingId);
    return { task, submission, item, repositoryPath };
  }

  private async getSubmission(submissionId: string) {
    const result = await this.options.controlPlane.collaborativeQuery({
      kind: 'submission.get',
      submissionId,
    });
    return required(result.submission, 'Control Plane 未返回提测单');
  }

  private async submissionForItem(submissionItemId: string) {
    const list = await this.options.controlPlane.collaborativeQuery({
      kind: 'submission.list',
      includeClosed: true,
    });
    for (const summary of list.submissions ?? []) {
      const submission = await this.getSubmission(summary.id);
      if (submission.items.some((item) => item.id === submissionItemId))
        return submission;
    }
    throw new Error(`找不到工程提测项 ${submissionItemId}`);
  }

  private async repositoryPath(bindingId: string) {
    const binding = (
      await this.options.stateStore.listEngineeringBindings()
    ).find((candidate) => candidate.bindingId === bindingId);
    if (!binding) throw new Error(`Runner 本机缺少工程绑定 ${bindingId}`);
    if (binding.runnerId !== this.options.runner.runnerId)
      throw new Error('工程绑定不属于当前 Runner');
    return binding.repositoryPath;
  }

  private async writeBugAttachments(
    bug: SubmissionBug,
    artifactsDirectory: string,
  ) {
    if (bug.attachments.length === 0) return [];
    const directory = join(artifactsDirectory, 'attachments');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return Promise.all(
      bug.attachments.map(async (metadata) => {
        const result = await this.options.controlPlane.collaborativeQuery({
          kind: 'bug.attachment.get',
          attachmentId: metadata.id,
        });
        const path = join(
          directory,
          `${metadata.id}-${basename(metadata.fileName)}`,
        );
        await writeFile(
          path,
          Buffer.from(
            required(result.contentBase64, 'Control Plane 未返回附件内容'),
            'base64',
          ),
          { mode: 0o600 },
        );
        return path;
      }),
    );
  }

  private async writeUpdateAttachments(
    batch: SubmissionUpdateBatch,
    artifactsDirectory: string,
  ) {
    if (batch.externalFailureAttachments.length === 0) return [];
    const directory = join(artifactsDirectory, 'external-feedback');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return Promise.all(
      batch.externalFailureAttachments.map(async (attachment) => {
        const path = join(
          directory,
          `${attachment.id}-${basename(attachment.fileName)}`,
        );
        await writeFile(path, Buffer.from(attachment.contentBase64, 'base64'), {
          mode: 0o600,
        });
        return path;
      }),
    );
  }

  private async writeContinuationContext(
    directory: string,
    context: Record<string, unknown>,
  ) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'continuation-context.json');
    await writeFile(path, `${JSON.stringify(context, null, 2)}\n`, {
      mode: 0o600,
    });
    return path;
  }

  private renewLease(
    renew: () => Promise<unknown>,
    signal: AbortSignal,
    taskId: string,
  ) {
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing || signal.aborted) return;
      renewing = true;
      void renew()
        .catch((error) =>
          this.options.logger.warn(
            'collaborative_submission.lease_renew_failed',
            '协作提测任务续租失败，将在提交结果或租约恢复时重试',
            { taskId, error: messageOf(error) },
          ),
        )
        .finally(() => {
          renewing = false;
        });
    }, this.options.leaseRenewIntervalMs ?? 20_000);
    return () => clearInterval(timer);
  }

  private async persistAndSubmit(command: CollaborativeFinishCommand) {
    const pending =
      await this.options.stateStore.saveCollaborativePendingOutcome({
        command,
      });
    await this.submitPendingOutcome(pending);
  }
}

function repairPrompt(
  context: Awaited<
    ReturnType<CollaborativeSubmissionWorker['loadRepairContext']>
  >,
  attachmentPaths: readonly string[],
  continuationContextPath: string,
) {
  const { task, bug, submission, item, repositoryPath } = context;
  const template = task.resumeSessionId
    ? 'bug-repair-resume@2.0.0'
    : 'bug-repair-start@2.0.0';
  return `你正在执行 ${template}。\n\n仓库路径：${repositoryPath}\n目标分支：${required(item.technical, '工程技术配置不可用').targetBranch}\n工程：${item.engineeringDisplayName} (${item.engineeringSlug})\n提测单：${submission.title}\n需求：${submission.requirementDescription}\n\nBug 与完整历史：\n${JSON.stringify(
    {
      id: bug.id,
      shortId: bug.shortId,
      title: bug.title,
      operationPath: bug.operationPath,
      actualResult: bug.actualResult,
      expectedResult: bug.expectedResult,
      supplementalDescription: bug.supplementalDescription,
      latestFeedback: bug.latestFeedback,
      attempts: bug.attempts,
    },
    null,
    2,
  )}\n\n附件（只读证据）：\n${attachmentPaths.length ? attachmentPaths.map((path) => `- ${path}`).join('\n') : '- 无'}\n\n持续上下文文件：${continuationContextPath}\n\n要求：\n1. 先读取并遵守仓库中的 AGENTS.md、README、贡献规范、脚本以及用户自定义工作流，校验当前仓库身份和目标分支。\n2. 开始执行以及每次收到“继续”后，都必须重新读取持续上下文文件，以获取最新反馈、尝试记录和附件路径；不要只依赖当前 Turn 的输入文本。\n3. Bug 修复、测试、构建与验证优先使用本工程或用户定义的工作流；Control Plane 不规定具体命令，Runner 也不会执行或解释仓库命令。\n4. 为本 Bug 使用系统拥有的隔离 worktree；恢复任务时继续使用原 Codex Thread 和原资源，不创建替代 Thread，不生成迁移摘要。\n5. 最小修复并运行与改动匹配的检查。成功时创建仅包含本 Bug 的独立候选 Commit，禁止 push、部署或改写其他候选 Commit。\n6. 不修改附件或持续上下文文件，不泄露凭据。最终只返回符合 Schema 的 JSON。`;
}

function updatePrompt(
  context: Awaited<
    ReturnType<CollaborativeSubmissionWorker['loadUpdateContext']>
  >,
  feedbackAttachmentPaths: readonly string[],
  continuationContextPath: string,
) {
  const { batch, bugs, submission, item, repositoryPath } = context;
  const technical = required(item.technical, '工程技术配置不可用');
  return `你正在执行 ${batch.sessionId ? 'update-batch-resume' : 'update-batch-start'}@2.0.0。\n\n仓库路径：${repositoryPath}\n工程：${item.engineeringDisplayName} (${item.engineeringSlug})\n提测单：${submission.title}\n目标分支：${technical.targetBranch}\n部署类型：${technical.environment.deploymentType}\n本地部署命令：${technical.environment.localScriptCommand ?? '无（CI/CD 由外部人工确认）'}\n\n候选提交（每个 Bug 必须保持独立 Commit）：\n${batch.bugIds
    .map(
      (bugId, index) =>
        `- ${bugId}: ${batch.candidateCommits[index] ?? '缺失候选提交'}`,
    )
    .join('\n')}\n\nBug 摘要：\n${JSON.stringify(
    bugs.map((bug) => ({
      id: bug.id,
      shortId: bug.shortId,
      title: bug.title,
      latestFeedback: bug.latestFeedback,
      candidateCommit: bug.candidateCommit,
    })),
    null,
    2,
  )}\n\n上次外部更新失败反馈：\n${batch.externalFailure ?? '无'}\n附件：\n${feedbackAttachmentPaths.length ? feedbackAttachmentPaths.map((path) => `- ${path}`).join('\n') : '- 无'}\n\n持续上下文文件：${continuationContextPath}\n\n要求：\n1. 这是已经冻结的原子 Batch。先读取并遵守仓库中的 AGENTS.md、README、贡献规范、脚本以及用户自定义工作流，校验仓库身份和目标分支。\n2. 开始执行以及每次收到“继续”后，都必须重新读取持续上下文文件，以获取最新外部失败反馈和附件路径；不要只依赖当前 Turn 的输入文本。\n3. 整批集成全部候选 Commit；不得自动拆批、跳过或排除冲突/失败候选。候选缺失、冲突或验证失败时，在当前 Update Thread 中继续解决。\n4. 保留原候选 Commit，不重写其历史；集成过程需要额外修正时创建 Batch integration Commit。\n5. 测试、构建、验证、普通 Push 与部署优先使用本工程或用户定义的工作流，并按整批统一执行一次；Control Plane 不规定具体命令，Runner 不执行任何仓库命令。整个批次只普通 Push 一次，禁止 force push。\n6. LOCAL_SCRIPT：按工程工作流完成整批集成、验证、普通 Push 和本地部署；全部完成返回 COMPLETED。\n7. CI_CD：完成整批集成、验证和普通 Push 后返回 PUSHED，禁止声称外部 Pipeline 已成功。\n8. 无法安全完成时保留原 Batch 与原 Thread 并返回 FAILED，等待负责人在原会话中输入“继续”。不修改持续上下文文件。最终只返回符合 Schema 的 JSON。`;
}

function cleanupPrompt(
  context: Awaited<
    ReturnType<CollaborativeSubmissionWorker['loadCleanupContext']>
  >,
) {
  const { task, submission, item, repositoryPath } = context;
  return `你正在执行 cleanup-test-submission@2.0.0。\n\n仓库路径：${repositoryPath}\n已关闭提测单：${submission.title} (${submission.id})\n工程：${item.engineeringDisplayName} (${item.engineeringSlug})\n系统关联 Session：\n${task.sessionIds.length ? task.sessionIds.map((id) => `- ${id}`).join('\n') : '- 无'}\n\n要求：\n1. 先读取并遵守仓库规则，识别且只清理本提测单由系统明确创建的临时 worktree、临时分支和其他临时资源。\n2. 绝不删除目标分支、正式提交、远端历史、原始仓库、用户资源或 Runner 原始日志。\n3. 无法证明资源归属时保留并在 summary 中说明。\n4. 清理必须幂等；资源已不存在视为成功。最终只返回符合 Schema 的 JSON。`;
}

function interactionResponse(
  interaction: CodexInteractionRequest,
  requestPayload: Record<string, unknown>,
) {
  const resolution = required(interaction.resolution, 'Codex 交互请求尚未响应');
  if (interaction.kind === 'USER_INPUT') {
    return {
      answers: Object.fromEntries(
        Object.entries(resolution.answers ?? {}).map(([id, answers]) => [
          id,
          { answers },
        ]),
      ),
    };
  }
  if (interaction.method === 'item/permissions/requestApproval') {
    return resolution.action === 'DECLINE'
      ? { permissions: {}, scope: 'turn' }
      : { permissions: requestPayload.permissions ?? {}, scope: 'session' };
  }
  if (resolution.action === 'DECLINE') return { decision: 'decline' };
  if (interaction.method === 'item/commandExecution/requestApproval') {
    const nativeDecision = nativeSessionApprovalDecision(requestPayload);
    if (nativeDecision) return { decision: nativeDecision };
  }
  return { decision: 'acceptForSession' };
}

function nativeSessionApprovalDecision(
  requestPayload: Record<string, unknown>,
): unknown {
  const available = requestPayload.availableDecisions;
  if (Array.isArray(available)) {
    return (
      available.find((decision) => {
        if (decision === 'acceptForSession') return true;
        if (!decision || typeof decision !== 'object') return false;
        return (
          'acceptWithExecpolicyAmendment' in decision ||
          'applyNetworkPolicyAmendment' in decision
        );
      }) ?? null
    );
  }
  const amendment = requestPayload.proposedExecpolicyAmendment;
  return amendment
    ? {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: amendment,
        },
      }
    : 'acceptForSession';
}

function submissionItem(
  submission: TestSubmissionDetail,
  submissionItemId: string,
): TestSubmissionItem {
  return required(
    submission.items.find((item) => item.id === submissionItemId),
    `提测单缺少工程提测项 ${submissionItemId}`,
  );
}

function repairOutcome(status: z.infer<typeof RepairResultSchema>['status']) {
  return {
    ready: 'READY',
    needs_input: 'NEEDS_INPUT',
    blocked: 'BLOCKED',
    failed: 'FAILED',
  }[status] as 'READY' | 'NEEDS_INPUT' | 'BLOCKED' | 'FAILED';
}

function summarizeRepair(result: z.infer<typeof RepairResultSchema>) {
  const checks = result.checks
    .map((check) => `${check.name}: ${check.status} (${check.summary})`)
    .join('\n');
  return truncate(
    [result.summary, result.reason, checks].filter(Boolean).join('\n'),
    12_000,
  );
}

function normalizeUpdateOutcome(
  deploymentType: SubmissionUpdateBatch['deploymentType'],
  outcome: z.infer<typeof UpdateExecutionResultSchema>['outcome'],
) {
  if (outcome === 'FAILED') return outcome;
  if (deploymentType === 'CI_CD') return 'PUSHED' as const;
  if (outcome !== 'COMPLETED')
    throw new Error('LOCAL_SCRIPT 更新必须在部署完成后返回 COMPLETED');
  return outcome;
}

function requireLease(value: string | null) {
  return required(value, 'Control Plane 未返回任务租约');
}

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function sessionIdOf(error: unknown) {
  return error instanceof CodexAppServerError ? error.sessionId : null;
}

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1)}…`;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function waitForWork(
  activeJobs: ReadonlySet<Promise<void>>,
  milliseconds: number,
  signal: AbortSignal,
) {
  if (activeJobs.size === 0) return delay(milliseconds, signal);
  await Promise.race([...activeJobs, delay(milliseconds, signal)]);
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
