import { createHash, randomUUID } from 'node:crypto';
import type {
  ClaimedExecution,
  CompleteExecutionRequest,
  ExecutionFailure,
  ExecutionStartRequest,
  JsonValue,
} from '@agent-party-time/execution-contract';
import { serializeDeterministicJson } from '@agent-party-time/execution-contract';
import type { LocalFileSystem } from '../platform/files';
import {
  EXECUTION_STATE_SCHEMA_VERSION,
  OUTBOX_STATE_SCHEMA_VERSION,
  type OutboxEntry,
} from '../state/schemas';
import type { LocalStateStore } from '../state/store';
import type { AuthenticatedRunnerSession } from '../daemon/connection';
import type { RunnerExecutionHttp } from '../daemon/runner-http';
import { RunnerHttpError } from '../daemon/runner-http';
import type { AttachmentMaterializer } from './attachments';
import {
  CodexAppServerError,
  type CodexExecutor,
  type StartedCodexExecution,
} from './codex-app-server';
import type { ExecutionWorkspaceManager } from './workspaces';
import {
  SkillBundleManager,
  XAPT_SKILL_NAMES,
  type XaptSkillName,
} from '../skills/manager';

const MAX_FAILURE_MESSAGE_LENGTH = 1_000;

export interface ExecutionProjection {
  activeExecutionCount: number;
  waitingInteractionCount: number;
  recoveryRequired: boolean;
}

export class ExecutionService {
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly bindingTails = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly runningExecutionIds = new Set<string>();
  private waitingInteractionCount = 0;
  private forceStopping = false;
  private recoveryRequired = false;

  get projection(): ExecutionProjection {
    return {
      activeExecutionCount: this.runningExecutionIds.size,
      waitingInteractionCount: this.waitingInteractionCount,
      recoveryRequired: this.recoveryRequired,
    };
  }

  constructor(
    private readonly http: RunnerExecutionHttp,
    private readonly state: LocalStateStore,
    private readonly files: LocalFileSystem,
    private readonly attachments: AttachmentMaterializer,
    private readonly workspaces: ExecutionWorkspaceManager,
    private readonly executor: CodexExecutor,
    private readonly skills: SkillBundleManager,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  async cycle(session: AuthenticatedRunnerSession): Promise<boolean> {
    if (this.tasks.size === 0) {
      if (!(await this.replayOutbox(session))) return false;
      if (await this.recoverInterrupted()) {
        this.recoveryRequired = true;
        return true;
      }
      this.recoveryRequired = false;
    }
    const availableSlots = 3 - this.tasks.size;
    if (availableSlots <= 0) return false;
    const executions = await this.http.claimExecutions(
      session.serverOrigin,
      session.credential,
      availableSlots,
      0,
    );
    for (const execution of executions) this.schedule(session, execution);
    return executions.length > 0;
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.tasks.values()]);
  }

  async hasRecoveryRecords(): Promise<boolean> {
    return (await this.state.loadExecutions()).some(
      ({ executionId }) => !this.tasks.has(executionId),
    );
  }

  forceStop(): void {
    this.forceStopping = true;
    for (const controller of this.controllers.values()) controller.abort();
  }

  private schedule(
    session: AuthenticatedRunnerSession,
    execution: ClaimedExecution,
  ): void {
    if (this.tasks.has(execution.id)) return;
    const previous = this.bindingTails.get(execution.bindingId);
    const persisted = this.state.saveExecution({
      schemaVersion: EXECUTION_STATE_SCHEMA_VERSION,
      executionId: execution.id,
      bindingId: execution.bindingId,
      phase: 'CLAIMED',
      sessionId: null,
      claimedExecution: execution,
      updatedAt: this.now().toISOString(),
    });
    let task!: Promise<void>;
    task = Promise.all([persisted, previous ?? Promise.resolve()])
      .then(async () => {
        if (this.forceStopping) return;
        this.runningExecutionIds.add(execution.id);
        try {
          await this.execute(session, execution);
        } finally {
          this.runningExecutionIds.delete(execution.id);
        }
      })
      .catch(() => {
        this.recoveryRequired = true;
      })
      .finally(() => {
        this.tasks.delete(execution.id);
        if (this.bindingTails.get(execution.bindingId) === task)
          this.bindingTails.delete(execution.bindingId);
      });
    this.tasks.set(execution.id, task);
    this.bindingTails.set(execution.bindingId, task);
  }

  private async execute(
    session: AuthenticatedRunnerSession,
    execution: ClaimedExecution,
  ): Promise<void> {
    if (execution.cancellationRequested) {
      await this.reportStartFailure(session, execution, {
        code: 'CANCELLED_BY_REQUEST',
        message: '处理任务已取消，不再启动本机任务',
        retryable: false,
      });
      return;
    }
    const bindingPath = await this.state.resolveBinding(execution.bindingId);
    if (!bindingPath) {
      await this.reportStartFailure(session, execution, {
        code: 'BINDING_NOT_FOUND',
        message: '本机未登记该关联',
        retryable: true,
      });
      return;
    }
    if ((await this.files.info(bindingPath))?.type !== 'directory') {
      await this.reportStartFailure(session, execution, {
        code: 'REPOSITORY_NOT_FOUND',
        message: '本机仓库目录不存在',
        retryable: true,
      });
      return;
    }

    let repositoryPath = bindingPath;
    if (execution.workspace)
      try {
        const prepared = await this.workspaces.prepare(
          bindingPath,
          execution.workspace,
        );
        if (prepared.kind === 'COMPLETED') {
          await this.completePreparedWorkspace(
            session,
            execution,
            prepared.result,
          );
          return;
        }
        repositoryPath = prepared.cwd;
      } catch {
        await this.reportStartFailure(session, execution, {
          code: 'REPOSITORY_NOT_FOUND',
          message: '无法准备隔离的本机 Git 工作区',
          retryable: true,
        });
        return;
      }

    let materialized;
    try {
      materialized = await this.attachments.materialize(
        session.serverOrigin,
        session.credential,
        execution,
      );
    } catch {
      await this.reportStartFailure(session, execution, {
        code: 'ATTACHMENT_DOWNLOAD_FAILED',
        message: '任务附件下载或校验失败',
        retryable: true,
      });
      return;
    }

    const turn = execution.codexTurn;
    if (!turn) {
      await this.reportStartFailure(session, execution, {
        code: 'CODEX_START_FAILED',
        message: '任务缺少 Codex 输入',
        retryable: false,
      });
      return;
    }
    let resolvedSkill;
    try {
      if (turn.kind === 'INITIAL') {
        const serialized = serializeDeterministicJson(turn.executionBrief);
        if (
          createHash('sha256').update(serialized).digest('hex') !==
          turn.executionBriefHash
        )
          throw new Error('任务说明校验值不匹配');
        if (!XAPT_SKILL_NAMES.includes(turn.requiredSkillName as XaptSkillName))
          throw new Error('任务请求了未知规则');
        resolvedSkill = await this.skills.resolveCurrent(
          turn.requiredSkillName as XaptSkillName,
        );
      } else
        resolvedSkill = await this.skills.resolveBound({
          skillName: turn.taskSkillBinding.skillName as XaptSkillName,
          bundleHash: turn.taskSkillBinding.bundleHash,
          sourceRevision: turn.taskSkillBinding.sourceRevision,
        });
    } catch (error) {
      await this.reportStartFailure(session, execution, {
        code: 'CODEX_START_FAILED',
        message: failureMessage(
          error instanceof Error ? error.message : '规则包解析失败',
        ),
        retryable: false,
      });
      return;
    }

    const controller = new AbortController();
    this.controllers.set(execution.id, controller);
    let recoveredInteraction = execution.recoveredInteraction;
    let releaseStartGate!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStartGate = resolve;
    });
    let startAccepted = false;
    let started: StartedCodexExecution;
    try {
      started = await this.executor.begin(
        {
          approvalPolicy: execution.approvalPolicy,
          executionId: execution.id,
          repositoryPath,
          text:
            turn.kind === 'INITIAL'
              ? serializeDeterministicJson(turn.executionBrief)
              : turn.input,
          skill:
            turn.kind === 'INITIAL'
              ? { name: resolvedSkill.skillName, path: resolvedSkill.path }
              : null,
          outputSchema: turn.outputJsonSchema,
          attachments: materialized,
          artifactsDirectory: this.attachments.artifactsDirectory(execution.id),
          taskId: turn.kind === 'CONTINUATION' ? turn.taskId : null,
          onInteraction: async (interaction) => {
            await startGate;
            if (!startAccepted) throw new Error('任务启动状态尚未被服务接受');
            if (
              recoveredInteraction &&
              recoveredInteraction.method === interaction.method &&
              JSON.stringify(recoveredInteraction.payload) ===
                JSON.stringify(interaction.payload)
            ) {
              const resolution = recoveredInteraction.resolution;
              recoveredInteraction = null;
              return resolution;
            }
            return await this.handleInteraction(
              session,
              execution,
              started.sessionId,
              interaction.method,
              interaction.payload,
            );
          },
        },
        controller.signal,
      );
    } catch (error) {
      this.controllers.delete(execution.id);
      await this.reportStartFailure(session, execution, {
        code: 'CODEX_START_FAILED',
        message:
          error instanceof CodexAppServerError
            ? failureMessage(error.message)
            : 'Codex 本机服务启动任务失败',
        retryable: true,
      });
      return;
    }

    const startRequest: ExecutionStartRequest = {
      kind: 'STARTED',
      leaseToken: execution.lease.token,
      sessionId: started.sessionId,
      taskSkillBinding: {
        skillName: resolvedSkill.skillName,
        bundleHash: resolvedSkill.bundleHash,
        sourceRevision: resolvedSkill.sourceRevision,
      },
    };
    if (
      !(await this.persistAndDeliver(
        session,
        'START',
        execution.id,
        startRequest,
      ))
    ) {
      releaseStartGate();
      controller.abort();
      this.controllers.delete(execution.id);
      return;
    }
    startAccepted = true;
    releaseStartGate();
    await this.state.saveExecution({
      schemaVersion: EXECUTION_STATE_SCHEMA_VERSION,
      executionId: execution.id,
      bindingId: execution.bindingId,
      phase: 'RUNNING',
      sessionId: started.sessionId,
      claimedExecution: execution,
      updatedAt: this.now().toISOString(),
    });

    const lease = this.keepLease(session, execution, controller);
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
        outcome: {
          kind: 'FAILED',
          failure: {
            code: 'CODEX_EXECUTION_FAILED',
            message:
              error instanceof CodexAppServerError
                ? failureMessage(error.message)
                : 'Codex 执行中断',
            retryable: true,
          },
        },
      };
    } finally {
      lease.stop();
    }
    await this.state.saveExecution({
      schemaVersion: EXECUTION_STATE_SCHEMA_VERSION,
      executionId: execution.id,
      bindingId: execution.bindingId,
      phase: 'OUTCOME_PENDING',
      sessionId: started.sessionId,
      claimedExecution: execution,
      updatedAt: this.now().toISOString(),
    });
    if (await this.persistAndDeliver(session, 'OUTCOME', execution.id, request))
      await this.state.removeExecution(execution.id);
    this.controllers.delete(execution.id);
  }

  private async handleInteraction(
    session: AuthenticatedRunnerSession,
    execution: ClaimedExecution,
    sessionId: string,
    method: string,
    payload: JsonValue,
  ): Promise<JsonValue> {
    const opened = await this.http.openInteraction(
      session.serverOrigin,
      session.credential,
      execution.id,
      {
        leaseToken: execution.lease.token,
        kind:
          method === 'item/tool/requestUserInput' ? 'USER_INPUT' : 'APPROVAL',
        method,
        payload,
      },
    );
    this.waitingInteractionCount += 1;
    await this.state.saveExecution({
      schemaVersion: EXECUTION_STATE_SCHEMA_VERSION,
      executionId: execution.id,
      bindingId: execution.bindingId,
      phase: 'WAITING_INTERACTION',
      sessionId,
      claimedExecution: execution,
      updatedAt: this.now().toISOString(),
    });
    try {
      for (;;) {
        const waited = await this.http.waitInteraction(
          session.serverOrigin,
          session.credential,
          execution.id,
          opened.id,
          execution.lease.token,
          5_000,
        );
        const renewed = await this.http.renewExecution(
          session.serverOrigin,
          session.credential,
          execution.id,
          execution.lease.token,
        );
        await this.persistRenewedLease(execution, renewed.expiresAt);
        if (renewed.cancellationRequested) {
          this.controllers.get(execution.id)?.abort();
          throw new CancellationRequested();
        }
        if (waited.interaction.state === 'RESOLVED' && waited.laneAcquired)
          return waited.interaction.resolution!;
        if (waited.interaction.state === 'INVALIDATED')
          throw new RunnerHttpError('LEASE_EXPIRED', '任务操作请求已失效', 409);
      }
    } finally {
      this.waitingInteractionCount -= 1;
    }
  }

  private async reportStartFailure(
    session: AuthenticatedRunnerSession,
    execution: ClaimedExecution,
    failure: ExecutionFailure,
  ): Promise<void> {
    if (
      await this.persistAndDeliver(session, 'START', execution.id, {
        kind: 'START_FAILED',
        leaseToken: execution.lease.token,
        failure,
      })
    )
      await this.state.removeExecution(execution.id);
  }

  private async completePreparedWorkspace(
    session: AuthenticatedRunnerSession,
    execution: ClaimedExecution,
    result: JsonValue,
  ): Promise<void> {
    const sessionId = `xapt-workspace:${execution.id}`;
    if (
      !(await this.persistAndDeliver(session, 'START', execution.id, {
        kind: 'STARTED',
        leaseToken: execution.lease.token,
        sessionId,
        taskSkillBinding: null,
      }))
    )
      return;
    if (
      await this.persistAndDeliver(session, 'OUTCOME', execution.id, {
        leaseToken: execution.lease.token,
        sessionId,
        outcome: { kind: 'SUCCEEDED', result },
      })
    )
      await this.state.removeExecution(execution.id);
  }

  private async recoverInterrupted(): Promise<boolean> {
    const recoveries = await this.state.loadExecutions();
    const now = this.now().getTime();
    for (const recovery of recoveries)
      if (Date.parse(recovery.claimedExecution.lease.expiresAt) <= now)
        await this.state.removeExecution(recovery.executionId);
    return recoveries.length > 0;
  }

  private async persistRenewedLease(
    execution: ClaimedExecution,
    expiresAt: string,
  ): Promise<void> {
    execution.lease.expiresAt = expiresAt;
    const recovery = (await this.state.loadExecutions()).find(
      ({ executionId }) => executionId === execution.id,
    );
    if (!recovery) return;
    await this.state.saveExecution({
      ...recovery,
      claimedExecution: {
        ...recovery.claimedExecution,
        lease: { ...recovery.claimedExecution.lease, expiresAt },
      },
      updatedAt: this.now().toISOString(),
    });
  }

  private async persistAndDeliver(
    session: AuthenticatedRunnerSession,
    kind: 'START' | 'OUTCOME',
    executionId: string,
    request: ExecutionStartRequest | CompleteExecutionRequest,
  ): Promise<boolean> {
    const entry = {
      schemaVersion: OUTBOX_STATE_SCHEMA_VERSION,
      id: this.createId(),
      kind,
      executionId,
      request,
      createdAt: this.now().toISOString(),
    } as OutboxEntry;
    await this.state.saveOutbox(entry);
    try {
      await this.deliver(session, entry);
      await this.state.removeOutbox(entry.id);
      return true;
    } catch (error) {
      if (isTerminalDeliveryError(error)) {
        await this.state.removeOutbox(entry.id);
        return true;
      }
      return false;
    }
  }

  private async replayOutbox(
    session: AuthenticatedRunnerSession,
  ): Promise<boolean> {
    for (const entry of await this.state.loadOutbox())
      try {
        await this.deliver(session, entry);
        await this.state.removeOutbox(entry.id);
        if (entry.kind === 'OUTCOME' || entry.request.kind === 'START_FAILED')
          await this.state.removeExecution(entry.executionId);
      } catch (error) {
        if (isTerminalDeliveryError(error)) {
          await this.state.removeOutbox(entry.id);
          await this.state.removeExecution(entry.executionId);
          continue;
        }
        return false;
      }
    return true;
  }

  private async deliver(
    session: AuthenticatedRunnerSession,
    entry: OutboxEntry,
  ): Promise<void> {
    if (entry.kind === 'START') {
      await this.http.startExecution(
        session.serverOrigin,
        session.credential,
        entry.executionId,
        entry.request,
      );
      return;
    }
    await this.http.completeExecution(
      session.serverOrigin,
      session.credential,
      entry.executionId,
      entry.request,
    );
  }

  private keepLease(
    session: AuthenticatedRunnerSession,
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
        const status = await this.http.renewExecution(
          session.serverOrigin,
          session.credential,
          execution.id,
          execution.lease.token,
        );
        await this.persistRenewedLease(execution, status.expiresAt);
        if (status.cancellationRequested) throw new Error('服务端已请求取消');
        timer = setTimeout(renew, 5_000);
      } catch (error) {
        controller.abort();
        rejectLost(
          error instanceof Error ? error : new Error('任务领取凭据已失效'),
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
}

function failureMessage(message: string): string {
  const normalized = message.trim();
  return normalized.length <= MAX_FAILURE_MESSAGE_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_FAILURE_MESSAGE_LENGTH - 1)}…`;
}

function isTerminalDeliveryError(error: unknown): boolean {
  return (
    error instanceof RunnerHttpError &&
    ['LEASE_EXPIRED', 'OUTCOME_CONFLICT', 'INVALID_TRANSITION'].includes(
      error.code,
    )
  );
}

class CancellationRequested extends Error {}
