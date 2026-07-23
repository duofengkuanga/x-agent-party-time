import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  DeploymentResultSchema,
  type DeploymentWorkClaim,
  FinishDeploymentAttemptCommandSchema,
  type RepairAttemptOutcome,
  type RepairDispatchClaim,
  type RepairWorkItem,
  type RepairResult,
} from '@agent-party-time/shared';
import type { z } from 'zod';
import type { ControlPlanePort } from '@agent-party-time/control-plane-client';
import type { Logger } from '../logging/logger.js';
import type {
  PendingControlPlaneOutcome,
  RunnerStateStore,
} from './runner-state-store.js';
import {
  CodexAppServerError,
  type RepairExecutor,
  type StructuredExecutionResult,
} from './codex-app-server.js';

type DeploymentAttemptOutcome = z.infer<
  typeof FinishDeploymentAttemptCommandSchema
>['outcome'];

export interface BugRepairWorkerOptions {
  controlPlane: ControlPlanePort;
  runner: { runnerId: string; runnerName: string };
  stateStore: RunnerStateStore;
  executor: RepairExecutor;
  attemptsDirectory: string;
  logger: Logger;
  pollIntervalMs?: number;
  leaseRenewIntervalMs?: number;
  controlPollIntervalMs?: number;
}

export class BugRepairWorker {
  private controller: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly options: BugRepairWorkerOptions) {}

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

        const repairClaim =
          await this.options.controlPlane.acquireRepairDispatch(
            this.options.runner.runnerId,
          );
        if (repairClaim) {
          await this.processRepairClaim(repairClaim, signal);
          continue;
        }

        const deploymentClaim =
          await this.options.controlPlane.acquireDeploymentBatch(
            this.options.runner.runnerId,
          );
        if (deploymentClaim) {
          await this.processDeploymentClaim(deploymentClaim, signal);
          continue;
        }

        await delay(this.options.pollIntervalMs ?? 1_000, signal);
      } catch (error) {
        if (signal.aborted) break;
        this.options.logger.warn(
          'control_plane.worker_failed',
          'Agent 执行控制平面工作失败，将稍后重试',
          { error: messageOf(error) },
        );
        await delay(this.options.pollIntervalMs ?? 1_000, signal);
      }
    }
  }

  private async replayPendingOutcomes(signal: AbortSignal) {
    for (const pending of await this.options.stateStore.listPendingOutcomes()) {
      if (signal.aborted) return;
      const retryItem = await this.submitPendingOutcome(pending);
      if (retryItem && pending.kind === 'repair') {
        await this.processRepairItem(
          {
            dispatchId: pending.input.dispatchId,
            leaseToken: pending.input.leaseToken,
          },
          retryItem,
          signal,
        );
      }
    }
  }

  private async submitPendingOutcome(pending: PendingControlPlaneOutcome) {
    if (pending.kind === 'repair') {
      const result = await this.options.controlPlane.finishRepairAttempt(
        pending.input,
      );
      await this.options.stateStore.removePendingOutcome(pending.id);
      return result.retryItem;
    }
    await this.options.controlPlane.finishDeploymentAttempt(pending.input);
    await this.options.stateStore.removePendingOutcome(pending.id);
    return null;
  }

  private async processRepairClaim(
    claim: RepairDispatchClaim,
    signal: AbortSignal,
  ) {
    let renewalError: Error | null = null;
    const stopRenewal = this.renewLease(
      async () => {
        await this.options.controlPlane.renewRepairDispatchLease({
          runnerId: this.options.runner.runnerId,
          dispatchId: claim.dispatch.id,
          leaseToken: claim.leaseToken,
        });
      },
      signal,
      (error) => {
        renewalError = error;
      },
    );
    try {
      for (const item of claim.items) {
        if (signal.aborted) break;
        if (renewalError) throw renewalError;
        await this.processRepairItem(
          { dispatchId: claim.dispatch.id, leaseToken: claim.leaseToken },
          item,
          signal,
        );
      }
    } finally {
      stopRenewal();
    }
  }

  private async processRepairItem(
    claim: { dispatchId: string; leaseToken: string },
    initialItem: RepairWorkItem,
    signal: AbortSignal,
  ) {
    let item: RepairWorkItem | null = initialItem;
    while (item && !signal.aborted) {
      item = await this.executeRepairItem(claim, item, signal);
    }
  }

  private async executeRepairItem(
    claim: { dispatchId: string; leaseToken: string },
    item: RepairWorkItem,
    signal: AbortSignal,
  ) {
    let executionInput:
      | {
          repositoryPath: string;
          prompt: string;
          artifactsDirectory: string;
          resumeSessionId: string | null;
        }
      | undefined;
    let preparationError: unknown;
    try {
      const binding = (await this.options.stateStore.listBindings()).find(
        (candidate) => candidate.projectId === item.project.id,
      );
      if (!binding) throw new Error('Agent 本机缺少该项目绑定');
      const artifactsDirectory = join(
        this.options.attemptsDirectory,
        item.attemptId,
      );
      const attachmentPaths = await this.prepareAttachments(
        item,
        artifactsDirectory,
      );
      executionInput = {
        repositoryPath: binding.repositoryPath,
        artifactsDirectory,
        resumeSessionId: await this.options.stateStore.resumableSession(
          item.resumeSessionId,
        ),
        prompt: item.prompt.text
          .replaceAll('{{REPOSITORY_PATH}}', binding.repositoryPath)
          .replaceAll(
            '{{ATTACHMENTS}}',
            attachmentPaths.length
              ? attachmentPaths.map((path) => `- ${path}`).join('\n')
              : '- 无',
          ),
      };
    } catch (error) {
      preparationError = error;
    }

    await this.options.controlPlane.startRepairAttempt({
      runnerId: this.options.runner.runnerId,
      dispatchId: claim.dispatchId,
      attemptId: item.attemptId,
      leaseToken: claim.leaseToken,
    });

    let outcome: RepairAttemptOutcome;
    if (!executionInput) {
      outcome = {
        kind: 'execution_failure',
        sessionId: null,
        message: messageOf(preparationError),
      };
    } else {
      const execution = await this.executeWithControl(
        (executionSignal) =>
          this.options.executor.execute(
            {
              attemptId: item!.attemptId,
              repositoryPath: executionInput!.repositoryPath,
              prompt: executionInput!.prompt,
              outputSchema: item!.prompt.outputSchema,
              artifactsDirectory: executionInput!.artifactsDirectory,
              resumeSessionId: executionInput!.resumeSessionId,
            },
            executionSignal,
          ),
        () =>
          this.options.controlPlane.repairAttemptControl({
            attemptId: item!.attemptId,
            runnerId: this.options.runner.runnerId,
          }),
        signal,
      );
      outcome = repairOutcome(execution);
    }

    const pending = await this.options.stateStore.savePendingOutcome({
      kind: 'repair',
      input: {
        runnerId: this.options.runner.runnerId,
        dispatchId: claim.dispatchId,
        attemptId: item.attemptId,
        leaseToken: claim.leaseToken,
        outcome,
      },
    });
    return this.submitPendingOutcome(pending);
  }

  private async processDeploymentClaim(
    claim: DeploymentWorkClaim,
    signal: AbortSignal,
  ) {
    let renewalError: Error | null = null;
    const stopRenewal = this.renewLease(
      async () => {
        await this.options.controlPlane.renewDeploymentLease({
          runnerId: this.options.runner.runnerId,
          batchId: claim.batch.id,
          leaseToken: claim.leaseToken,
        });
      },
      signal,
      (error) => {
        renewalError = error;
      },
    );
    try {
      if (renewalError) throw renewalError;
      await this.executeDeploymentClaim(claim, signal);
    } finally {
      stopRenewal();
    }
  }

  private async executeDeploymentClaim(
    claim: DeploymentWorkClaim,
    signal: AbortSignal,
  ) {
    await this.options.controlPlane.startDeploymentAttempt({
      runnerId: this.options.runner.runnerId,
      batchId: claim.batch.id,
      attemptId: claim.attemptId,
      leaseToken: claim.leaseToken,
    });

    let outcome: DeploymentAttemptOutcome;
    const binding = (await this.options.stateStore.listBindings()).find(
      (candidate) => candidate.projectId === claim.batch.projectId,
    );
    if (!binding) {
      outcome = {
        kind: 'execution_failure',
        sessionId: null,
        message: 'Agent 本机缺少该项目绑定',
      };
    } else if (!this.options.executor.executeStructured) {
      outcome = {
        kind: 'execution_failure',
        sessionId: null,
        message: '当前 Codex Executor 不支持部署结构化结果',
      };
    } else {
      const resumeSessionId = await this.options.stateStore.resumableSession(
        claim.resumeSessionId,
      );
      const execution = await this.executeWithControl(
        (executionSignal) =>
          this.options.executor.executeStructured!(
            {
              executionId: claim.attemptId,
              repositoryPath: binding.repositoryPath,
              prompt: claim.prompt.text.replaceAll(
                '{{REPOSITORY_PATH}}',
                binding.repositoryPath,
              ),
              outputSchema: claim.prompt.outputSchema,
              resultSchema: DeploymentResultSchema,
              artifactsDirectory: join(
                this.options.attemptsDirectory,
                `deployment-${claim.attemptId}`,
              ),
              resumeSessionId,
            },
            executionSignal,
          ),
        () =>
          this.options.controlPlane.deploymentAttemptControl({
            batchId: claim.batch.id,
            runnerId: this.options.runner.runnerId,
          }),
        signal,
      );
      outcome = deploymentOutcome(execution);
    }

    const pending = await this.options.stateStore.savePendingOutcome({
      kind: 'deployment',
      input: {
        runnerId: this.options.runner.runnerId,
        batchId: claim.batch.id,
        attemptId: claim.attemptId,
        leaseToken: claim.leaseToken,
        outcome,
      },
    });
    await this.submitPendingOutcome(pending);
  }

  private renewLease(
    renew: () => Promise<void>,
    signal: AbortSignal,
    onError: (error: Error) => void,
  ) {
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing || signal.aborted) return;
      renewing = true;
      void renew()
        .catch((error) => onError(asError(error)))
        .finally(() => {
          renewing = false;
        });
    }, this.options.leaseRenewIntervalMs ?? 20_000);
    return () => clearInterval(timer);
  }

  private async executeWithControl<TResult>(
    execute: (
      signal: AbortSignal,
    ) => Promise<StructuredExecutionResult<TResult>>,
    control: () => Promise<boolean>,
    parentSignal: AbortSignal,
  ): Promise<
    | { kind: 'result'; value: StructuredExecutionResult<TResult> }
    | { kind: 'cancelled'; sessionId: string | null; message: string }
    | { kind: 'failure'; sessionId: string | null; message: string }
  > {
    const controller = new AbortController();
    let cancelRequested = false;
    let checking = false;
    const abortForShutdown = () => controller.abort();
    parentSignal.addEventListener('abort', abortForShutdown, { once: true });
    const timer = setInterval(() => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      void control()
        .then((cancel) => {
          if (cancel) {
            cancelRequested = true;
            controller.abort();
          }
        })
        .catch((error) =>
          this.options.logger.warn(
            'control_plane.control_poll_failed',
            '无法读取执行取消意图，将继续轮询',
            { error: messageOf(error) },
          ),
        )
        .finally(() => {
          checking = false;
        });
    }, this.options.controlPollIntervalMs ?? 750);

    try {
      return { kind: 'result', value: await execute(controller.signal) };
    } catch (error) {
      const sessionId =
        error instanceof CodexAppServerError ? error.sessionId : null;
      return cancelRequested
        ? {
            kind: 'cancelled',
            sessionId,
            message: '用户已取消 Codex 执行',
          }
        : {
            kind: 'failure',
            sessionId,
            message: messageOf(error),
          };
    } finally {
      clearInterval(timer);
      parentSignal.removeEventListener('abort', abortForShutdown);
    }
  }

  private async prepareAttachments(
    item: RepairWorkItem,
    artifactsDirectory: string,
  ) {
    if (item.bug.attachments.length === 0) return [];
    const directory = join(artifactsDirectory, 'attachments');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return Promise.all(
      item.bug.attachments.map(async (metadata) => {
        const attachment = await this.options.controlPlane.getBugAttachment(
          metadata.id,
        );
        const safeName = `${metadata.id}-${basename(metadata.fileName)}`;
        const path = join(directory, safeName);
        await writeFile(path, Buffer.from(attachment.contentBase64, 'base64'), {
          mode: 0o600,
        });
        return path;
      }),
    );
  }
}

function repairOutcome(
  execution:
    | { kind: 'result'; value: StructuredExecutionResult<RepairResult> }
    | { kind: 'cancelled'; sessionId: string | null; message: string }
    | { kind: 'failure'; sessionId: string | null; message: string },
): RepairAttemptOutcome {
  if (execution.kind === 'result')
    return {
      kind: 'result',
      sessionId: execution.value.sessionId,
      result: execution.value.result,
    };
  return {
    kind: execution.kind === 'cancelled' ? 'cancelled' : 'execution_failure',
    sessionId: execution.sessionId,
    message: execution.message,
  };
}

function deploymentOutcome(
  execution:
    | {
        kind: 'result';
        value: StructuredExecutionResult<
          z.infer<typeof DeploymentResultSchema>
        >;
      }
    | { kind: 'cancelled'; sessionId: string | null; message: string }
    | { kind: 'failure'; sessionId: string | null; message: string },
): DeploymentAttemptOutcome {
  if (execution.kind === 'result')
    return {
      kind: 'result',
      sessionId: execution.value.sessionId,
      result: execution.value.result,
    };
  return {
    kind: execution.kind === 'cancelled' ? 'cancelled' : 'execution_failure',
    sessionId: execution.sessionId,
    message: execution.message,
  };
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

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
