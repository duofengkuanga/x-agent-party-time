import type {
  ClaimedExecution,
  CompleteExecutionRequest,
  ExecutionFailure,
  ExecutionStartRequest,
  JsonValue,
} from '@agent-party-time/execution-contract';
import { serializeDeterministicJson } from '@agent-party-time/execution-contract';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRunnerSession } from '../agent/connection';
import type { RunnerExecutionHttp } from '../agent/server-http';
import { RunnerHttpError } from '@agent-party-time/runner-contract/http-client';
import {
  type CodexExecutor,
  type StartedCodexExecution,
} from '../codex/contract';
import { CodexAppServerError } from '../codex/errors';
import type { LocalFileSystem } from '../platform/files';
import type { SkillBundleManager } from '../skills/manager';
import type { LocalStateStore } from '../state/store';
import type { AttachmentMaterializer } from './attachments';
import { ExecutionOutbox } from './outbox';
import { ExecutionPreparation } from './preparation';
import { ExecutionRecovery } from './recovery';
import { failureMessage } from './failure-message';
import {
  ExecutionResultVerificationError,
  type ExecutionResultVerifier,
} from './result-verification';
import type { ExecutionWorkspaceManager } from './workspaces';

export interface ExecutionProjection {
  activeExecutionCount: number;
  waitingInteractionCount: number;
  recoveryRequired: boolean;
}

export class ExecutionService {
  private readonly outbox: ExecutionOutbox;
  private readonly preparation: ExecutionPreparation;
  private readonly recovery: ExecutionRecovery;
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
    files: LocalFileSystem,
    private readonly attachments: AttachmentMaterializer,
    workspaces: ExecutionWorkspaceManager,
    private readonly executor: CodexExecutor,
    skills: SkillBundleManager,
    private readonly resultVerifier: ExecutionResultVerifier,
    now: () => Date = () => new Date(),
    createId: () => string = randomUUID,
  ) {
    this.outbox = new ExecutionOutbox(http, state, now, createId);
    this.preparation = new ExecutionPreparation(
      state,
      files,
      attachments,
      workspaces,
      skills,
      resultVerifier,
      executor,
    );
    this.recovery = new ExecutionRecovery(http, state, now);
  }

  async cycle(session: AuthenticatedRunnerSession): Promise<boolean> {
    if (this.tasks.size === 0) {
      if (!(await this.outbox.replayOutbox(session))) return false;
      if (await this.recovery.recoverInterrupted()) {
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
    const persisted = this.recovery.recordPhase(execution, 'CLAIMED', null);
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
    const turn = execution.codexTurn;
    if (!turn) {
      await this.reportStartFailure(session, execution, {
        code: 'CODEX_START_FAILED',
        message: '任务缺少 Codex 输入',
        retryable: false,
      });
      return;
    }
    if (turn.kind === 'READ_SESSION') {
      const synchronization = await this.preparation.readSession(
        execution,
        turn.taskId,
      );
      if (synchronization.kind === 'FAILED')
        await this.reportStartFailure(
          session,
          execution,
          synchronization.failure,
        );
      else
        await this.completeImmediateExecution(
          session,
          execution,
          turn.taskId,
          synchronization.result,
        );
      return;
    }
    const prepared = await this.preparation.prepare(session, execution, turn);
    if (prepared.kind === 'FAILED') {
      await this.reportStartFailure(session, execution, prepared.failure);
      return;
    }
    if (prepared.kind === 'WORKSPACE_COMPLETED') {
      try {
        await this.completeImmediateExecution(
          session,
          execution,
          `xapt-workspace:${execution.id}`,
          prepared.result,
        );
      } catch {
        await this.reportStartFailure(session, execution, {
          code: 'REPOSITORY_NOT_FOUND',
          message: '无法准备隔离的本机 Git 工作区',
          retryable: true,
        });
      }
      return;
    }
    const {
      repositoryPath,
      materialized,
      resolvedSkill,
      resultAssertions,
      resultBaseline,
    } = prepared;
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
      !(await this.outbox.persistAndDeliver(
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
    await this.recovery.recordPhase(execution, 'RUNNING', started.sessionId);
    const lease = this.recovery.keepLease(session, execution, controller);
    let request: CompleteExecutionRequest;
    try {
      const result = await Promise.race([started.completion, lease.lost]);
      await this.resultVerifier.verify(
        repositoryPath,
        resultAssertions,
        resultBaseline,
        result,
      );
      request = {
        leaseToken: execution.lease.token,
        sessionId: started.sessionId,
        outcome: {
          kind: 'SUCCEEDED',
          result,
        },
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
              error instanceof CodexAppServerError ||
              error instanceof ExecutionResultVerificationError
                ? failureMessage(error.message)
                : 'Codex 执行中断',
            retryable: true,
          },
        },
      };
    } finally {
      lease.stop();
    }
    await this.recovery.recordPhase(
      execution,
      'OUTCOME_PENDING',
      started.sessionId,
    );
    if (
      await this.outbox.persistAndDeliver(
        session,
        'OUTCOME',
        execution.id,
        request,
      )
    )
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
    await this.recovery.recordPhase(
      execution,
      'WAITING_INTERACTION',
      sessionId,
    );
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
        const renewed = await this.recovery.renew(session, execution);
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
      await this.outbox.persistAndDeliver(session, 'START', execution.id, {
        kind: 'START_FAILED',
        leaseToken: execution.lease.token,
        failure,
      })
    )
      await this.state.removeExecution(execution.id);
  }

  private async completeImmediateExecution(
    session: AuthenticatedRunnerSession,
    execution: ClaimedExecution,
    sessionId: string,
    result: JsonValue,
  ): Promise<void> {
    if (
      !(await this.outbox.persistAndDeliver(session, 'START', execution.id, {
        kind: 'STARTED',
        leaseToken: execution.lease.token,
        sessionId,
        taskSkillBinding: null,
      }))
    )
      return;
    if (
      await this.outbox.persistAndDeliver(session, 'OUTCOME', execution.id, {
        leaseToken: execution.lease.token,
        sessionId,
        outcome: { kind: 'SUCCEEDED', result },
      })
    )
      await this.state.removeExecution(execution.id);
  }
}

class CancellationRequested extends Error {}
