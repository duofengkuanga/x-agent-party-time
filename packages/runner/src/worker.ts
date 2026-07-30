import { stat } from 'node:fs/promises';
import type {
  ClaimedExecution,
  CompleteExecutionRequest,
  ExecutionFailure,
  ExecutionStartRequest,
  JsonValue,
} from '@agent-party-time/execution-contract';
import { AttachmentMaterializer } from './attachments';
import {
  CodexAppServerExecutor,
  CodexAppServerError,
  type CodexExecutor,
  type CodexInteraction,
} from './codex-app-server';
import { RunnerClient, RunnerProtocolError } from './client';
import { ExecutionOutbox, type OutboxEntry } from './outbox';
import {
  GitExecutionWorkspaceManager,
  type ExecutionWorkspaceManager,
} from './execution-workspaces';
import { RunnerStateStore } from './state';

type WorkerOutput = Pick<Console, 'log' | 'error'>;

export class RunnerWorker {
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly slots: SlotPool;
  private stopped = false;

  constructor(
    private readonly client: RunnerClient = new RunnerClient(),
    private readonly state: RunnerStateStore = new RunnerStateStore(),
    private readonly outbox: ExecutionOutbox = new ExecutionOutbox(),
    private readonly executor: CodexExecutor = new CodexAppServerExecutor(),
    private readonly materializer: AttachmentMaterializer = new AttachmentMaterializer(
      client,
    ),
    concurrency = 1,
    private readonly output: WorkerOutput = console,
    private readonly workspaces: ExecutionWorkspaceManager = new GitExecutionWorkspaceManager(),
  ) {
    this.slots = new SlotPool(concurrency);
  }

  async run(pollWaitMs = 5_000): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      const claimed = await this.cycle(pollWaitMs);
      if (claimed === 0 || this.slots.available === 0) await sleep(250);
    }
    await this.waitForIdle();
  }

  stop(): void {
    this.stopped = true;
  }

  async cycle(waitMs = 0): Promise<number> {
    try {
      await this.client.heartbeat();
    } catch {
      return 0;
    }
    const replayed = await this.replayOutbox();
    if (!replayed) return 0;
    const available = this.slots.available;
    if (available === 0) return 0;
    const claimed = await this.client.claimExecutions(available, waitMs);
    for (const execution of claimed) {
      if (this.tasks.has(execution.id) || !this.slots.reserve()) continue;
      const task = this.execute(execution)
        .catch(() => {
          this.output.error(`Execution ${execution.id} 执行失败。`);
        })
        .finally(() => {
          this.slots.release();
          this.tasks.delete(execution.id);
        });
      this.tasks.set(execution.id, task);
    }
    return claimed.length;
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.tasks.values()]);
  }

  async replayOutbox(): Promise<boolean> {
    for (const entry of await this.outbox.list()) {
      try {
        await this.deliver(entry);
        await this.outbox.remove(entry.id);
      } catch (error) {
        if (
          error instanceof RunnerProtocolError &&
          (error.code === 'LEASE_EXPIRED' ||
            error.code === 'OUTCOME_CONFLICT' ||
            error.code === 'INVALID_TRANSITION')
        ) {
          await this.outbox.remove(entry.id);
          continue;
        }
        return false;
      }
    }
    return true;
  }

  private async execute(execution: ClaimedExecution): Promise<void> {
    if (execution.cancellationRequested) {
      await this.reportStartFailure(execution, {
        code: 'CANCELLED_BY_REQUEST',
        message: 'Execution 已被取消，不再启动本机任务',
        retryable: false,
      });
      return;
    }
    if (execution.recoveredInteraction) {
      await this.reportStartFailure(execution, {
        code: 'CODEX_START_FAILED',
        message: 'Agent 重启后原生 Codex Interaction Turn 已不可恢复',
        retryable: true,
      });
      return;
    }
    const bindingPath = await this.state.resolveBinding(execution.bindingId);
    if (!bindingPath) {
      await this.reportStartFailure(execution, {
        code: 'BINDING_NOT_FOUND',
        message: '本机未登记该 Binding',
        retryable: true,
      });
      return;
    }
    let repositoryPath = bindingPath;
    try {
      const repository = await stat(bindingPath);
      if (!repository.isDirectory()) throw new Error('not-directory');
    } catch {
      await this.reportStartFailure(execution, {
        code: 'REPOSITORY_NOT_FOUND',
        message: '本机仓库目录不存在',
        retryable: true,
      });
      return;
    }
    if (execution.workspace)
      try {
        const prepared = await this.workspaces.prepare(
          bindingPath,
          execution.workspace,
        );
        if (prepared.kind === 'COMPLETED') {
          await this.completePreparedWorkspace(execution, prepared.result);
          return;
        }
        repositoryPath = prepared.cwd;
      } catch {
        await this.reportStartFailure(execution, {
          code: 'REPOSITORY_NOT_FOUND',
          message: '无法准备隔离的本机 Git 工作区',
          retryable: true,
        });
        return;
      }

    let attachments;
    try {
      attachments = await this.materializer.materialize(execution);
    } catch {
      await this.reportStartFailure(execution, {
        code: 'ATTACHMENT_DOWNLOAD_FAILED',
        message: 'Execution 附件下载或校验失败',
        retryable: true,
      });
      return;
    }

    const controller = new AbortController();
    let releaseStartGate!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStartGate = resolve;
    });
    let startAccepted = false;
    let started;
    try {
      started = await this.executor.begin(
        {
          executionId: execution.id,
          repositoryPath,
          prompt: execution.renderedPrompt,
          outputSchema: execution.outputJsonSchema,
          attachments,
          artifactsDirectory: this.materializer.artifactsDirectory(
            execution.id,
          ),
          resumeSessionId: execution.resumeSessionId,
          onInteraction: async (interaction) => {
            await startGate;
            if (!startAccepted)
              throw new Error('Execution 启动状态尚未被服务端接受');
            return this.handleInteraction(execution, interaction);
          },
        },
        controller.signal,
      );
    } catch (error) {
      await this.reportStartFailure(execution, {
        code: 'CODEX_START_FAILED',
        message:
          error instanceof CodexAppServerError
            ? error.message
            : 'Codex App Server 启动任务失败',
        retryable: true,
      });
      return;
    }

    const startRequest: ExecutionStartRequest = {
      kind: 'STARTED',
      leaseToken: execution.lease.token,
      sessionId: started.sessionId,
    };
    if (!(await this.persistAndDeliver('START', execution.id, startRequest))) {
      releaseStartGate();
      controller.abort();
      await this.persistAndDeliver('OUTCOME', execution.id, {
        leaseToken: execution.lease.token,
        sessionId: started.sessionId,
        outcome: {
          kind: 'FAILED',
          failure: {
            code: 'CODEX_EXECUTION_FAILED',
            message: 'Runner 无法确认 Execution 已启动',
            retryable: true,
          },
        },
      });
      return;
    }
    startAccepted = true;
    releaseStartGate();

    const lease = this.keepLease(execution, controller);
    let request: CompleteExecutionRequest;
    try {
      const result = await Promise.race([started.completion, lease.lost]);
      request = {
        leaseToken: execution.lease.token,
        sessionId: started.sessionId,
        outcome: { kind: 'SUCCEEDED', result },
      };
    } catch (error) {
      request = {
        leaseToken: execution.lease.token,
        sessionId: started.sessionId,
        outcome:
          error instanceof CancellationRequested
            ? { kind: 'CANCELLED', reason: '服务端已请求取消' }
            : {
                kind: 'FAILED',
                failure: {
                  code: 'CODEX_EXECUTION_FAILED',
                  message:
                    error instanceof CodexAppServerError
                      ? error.message
                      : 'Runner 执行中断',
                  retryable: true,
                },
              },
      };
    } finally {
      lease.stop();
    }
    await this.persistAndDeliver('OUTCOME', execution.id, request);
  }

  private async reportStartFailure(
    execution: ClaimedExecution,
    failure: ExecutionFailure,
  ): Promise<void> {
    await this.persistAndDeliver('START', execution.id, {
      kind: 'START_FAILED',
      leaseToken: execution.lease.token,
      failure,
    });
  }

  private async completePreparedWorkspace(
    execution: ClaimedExecution,
    result: JsonValue,
  ): Promise<void> {
    const sessionId = `runner-workspace:${execution.id}`;
    await this.persistAndDeliver('START', execution.id, {
      kind: 'STARTED',
      leaseToken: execution.lease.token,
      sessionId,
    });
    await this.persistAndDeliver('OUTCOME', execution.id, {
      leaseToken: execution.lease.token,
      sessionId,
      outcome: { kind: 'SUCCEEDED', result },
    });
  }

  private async handleInteraction(
    execution: ClaimedExecution,
    interaction: CodexInteraction,
  ): Promise<JsonValue> {
    const opened = await this.client.openInteraction(execution.id, {
      leaseToken: execution.lease.token,
      kind:
        interaction.method === 'item/tool/requestUserInput'
          ? 'USER_INPUT'
          : 'APPROVAL',
      method: interaction.method,
      payload: interaction.payload,
    });
    this.slots.release();
    try {
      while (true) {
        const waited = await this.client.waitInteraction(
          execution.id,
          opened.id,
          execution.lease.token,
          5_000,
        );
        const renewed = await this.client.renewExecution(
          execution.id,
          execution.lease.token,
        );
        if (renewed.cancellationRequested) throw new CancellationRequested();
        if (waited.interaction.state === 'RESOLVED' && waited.laneAcquired)
          return waited.interaction.resolution;
        if (waited.interaction.state === 'INVALIDATED')
          throw new RunnerProtocolError(
            'LEASE_EXPIRED',
            'Execution Interaction 已失效',
            409,
          );
      }
    } finally {
      await this.slots.acquire();
    }
  }

  private keepLease(
    execution: ClaimedExecution,
    controller: AbortController,
  ): { lost: Promise<never>; stop: () => void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectLost!: (error: Error) => void;
    let stopped = false;
    const lost = new Promise<never>((_resolve, reject) => {
      rejectLost = reject;
    });
    const renew = async () => {
      if (stopped) return;
      try {
        const status = await this.client.renewExecution(
          execution.id,
          execution.lease.token,
        );
        if (status.cancellationRequested) throw new CancellationRequested();
        timer = setTimeout(renew, 5_000);
      } catch (error) {
        controller.abort();
        rejectLost(
          error instanceof Error ? error : new Error('Execution Lease 已失效'),
        );
      }
    };
    timer = setTimeout(renew, 5_000);
    return {
      lost,
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
    };
  }

  private async persistAndDeliver(
    kind: 'START',
    executionId: string,
    request: ExecutionStartRequest,
  ): Promise<boolean>;
  private async persistAndDeliver(
    kind: 'OUTCOME',
    executionId: string,
    request: CompleteExecutionRequest,
  ): Promise<boolean>;
  private async persistAndDeliver(
    kind: 'START' | 'OUTCOME',
    executionId: string,
    request: ExecutionStartRequest | CompleteExecutionRequest,
  ): Promise<boolean> {
    const entry =
      kind === 'START'
        ? await this.outbox.add({
            kind,
            executionId,
            request: request as ExecutionStartRequest,
          })
        : await this.outbox.add({
            kind,
            executionId,
            request: request as CompleteExecutionRequest,
          });
    try {
      await this.deliver(entry);
      await this.outbox.remove(entry.id);
      return true;
    } catch {
      return false;
    }
  }

  private async deliver(entry: OutboxEntry): Promise<void> {
    if (entry.kind === 'START') {
      await this.client.startExecution(entry.executionId, entry.request);
      return;
    }
    await this.client.completeExecution(entry.executionId, entry.request);
  }
}

class CancellationRequested extends Error {}

class SlotPool {
  private used = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 32)
      throw new Error('Runner 并发数必须在 1 到 32 之间');
  }

  get available(): number {
    return this.capacity - this.used;
  }

  reserve(): boolean {
    if (this.available === 0) return false;
    this.used += 1;
    return true;
  }

  release(): void {
    if (this.used === 0) return;
    this.used -= 1;
    this.flush();
  }

  async acquire(): Promise<void> {
    if (this.reserve()) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private flush(): void {
    const waiter = this.waiters.shift();
    if (!waiter || !this.reserve()) return;
    waiter();
  }
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
