import type {
  ClaimedExecution,
  CompleteExecutionRequest,
  ExecutionFailure,
  ExecutionStartRequest,
  JsonValue,
} from '@agent-party-time/execution-contract';
import { serializeDeterministicJson } from '@agent-party-time/execution-contract';
import { sanitizeExecutionInteractionPayload } from '@agent-party-time/execution-contract';
import type { OutboxEntry } from '../state/schemas';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRunnerSession } from '../agent/connection';
import type { RunnerExecutionHttp } from '../agent/server-http';
import { RunnerHttpError } from '@agent-party-time/runner-contract/http-client';
import { type CodexExecutor, type StartedCodexExecution } from '../codex/contract';
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
import type { ObservationService } from '../observability/service';
import type { ExecutionObservation } from '../observability/recorder';
import { protocolObserver } from '../observability/protocol';
import { XAPT_VERSION } from '../version';
import { createCommandClassifier } from '../observability/command-context';

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
    attachments: AttachmentMaterializer,
    workspaces: ExecutionWorkspaceManager,
    private readonly executor: CodexExecutor,
    skills: SkillBundleManager,
    private readonly resultVerifier: ExecutionResultVerifier,
    private readonly observations: ObservationService,
    now: () => Date = () => new Date(),
    createId: () => string = randomUUID,
  ) {
    this.outbox = new ExecutionOutbox(http, state, now, createId, (notice) => {
      const correlation = {
        intervalId: notice.attemptId,
        parentIntervalId: notice.entryId,
      };
      if (!notice.terminal) {
        this.observations.event(notice.executionId, {
          name: notice.stage === 'started' ? 'phase.started' : 'phase.finished',
          source: 'xapt',
          phase: 'startup',
          correlation,
          status:
            notice.stage === 'accepted'
              ? 'succeeded'
              : notice.stage === 'started'
                ? 'running'
                : 'unknown',
        });
      } else
        this.observations.event(notice.executionId, {
          name:
            notice.stage === 'started'
              ? 'delivery.started'
              : notice.stage === 'accepted'
                ? 'delivery.accepted'
                : notice.stage === 'rejected'
                  ? 'delivery.rejected'
                  : 'delivery.unknown',
          source: notice.stage === 'started' ? 'xapt' : 'server_response',
          phase: 'delivery',
          correlation,
        });
      if (
        notice.terminal &&
        notice.stage !== 'started' &&
        !this.tasks.has(notice.executionId)
      )
        this.observations.close(notice.executionId);
    });
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
    await this.observations.prepareCycle(session);
    if (this.tasks.size === 0) {
      if (
        !(await this.outbox.replayOutbox(session, async (entry) => {
          if (entry.kind !== 'OUTCOME' || entry.request.outcome.kind !== 'HANDED_OFF')
            return true;
          if (!entry.sessionReleased) {
            if (!this.executor.releaseSession) return false;
            try {
              await this.executor.releaseSession(entry.request.sessionId);
              await this.outbox.confirmSessionReleased(entry);
            } catch {
              return false;
            }
          }
          const attemptId = randomUUID();
          const correlation = { intervalId: attemptId, parentIntervalId: entry.id };
          this.observations.event(entry.executionId, {
            name: 'delivery.started',
            source: 'xapt',
            phase: 'delivery',
            correlation,
          });
          try {
            await this.http.completeExecution(
              session.serverOrigin,
              session.credential,
              entry.executionId,
              entry.request,
            );
            this.observations.event(entry.executionId, {
              name: 'delivery.accepted',
              source: 'server_response',
              phase: 'delivery',
              correlation,
            });
            return true;
          } catch (error) {
            this.observations.event(entry.executionId, {
              name:
                error instanceof RunnerHttpError &&
                ['OUTCOME_CONFLICT', 'INVALID_TRANSITION', 'LEASE_EXPIRED'].includes(
                  error.code,
                )
                  ? 'delivery.rejected'
                  : 'delivery.unknown',
              source: 'server_response',
              phase: 'delivery',
              correlation,
            });
            if (!(error instanceof RunnerHttpError)) return false;
            if (error.code === 'OUTCOME_CONFLICT') return true;
            if (error.code !== 'INVALID_TRANSITION') return false;
          }
          try {
            await this.http.openInteraction(
              session.serverOrigin,
              session.credential,
              entry.executionId,
              {
                leaseToken: entry.request.leaseToken,
                kind: 'USER_INPUT',
                method: 'xapt/manualHandoff',
                payload: { questions: entry.request.outcome.questions },
              },
            );
            return true;
          } catch {
            return false;
          }
        }))
      )
        return false;
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
    const observation = this.observations.receive(session, execution);
    const waitId = randomUUID();
    observation.record({
      name: 'configuration.observed',
      source: 'xapt',
      configuration: { xaptVersion: XAPT_VERSION },
    });
    observation.record({
      name: 'phase.started',
      source: 'xapt',
      phase: 'local_wait',
      correlation: { intervalId: waitId },
    });
    const previous = this.bindingTails.get(execution.bindingId);
    const persisted = this.recovery.recordPhase(execution, 'CLAIMED', null);
    let task!: Promise<void>;
    task = Promise.all([persisted, previous ?? Promise.resolve()])
      .then(async () => {
        if (this.forceStopping) return;
        observation.record({
          name: 'phase.finished',
          source: 'xapt',
          phase: 'local_wait',
          correlation: { intervalId: waitId },
          status: 'succeeded',
        });
        this.runningExecutionIds.add(execution.id);
        try {
          await this.execute(session, execution, observation);
        } finally {
          this.runningExecutionIds.delete(execution.id);
        }
      })
      .catch(() => {
        this.recoveryRequired = true;
      })
      .finally(() => {
        this.observations.close(execution.id);
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
    observation: ExecutionObservation,
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
        observation,
      );
      if (synchronization.kind === 'FAILED')
        await this.reportStartFailure(session, execution, synchronization.failure);
      else
        await this.completeImmediateExecution(
          session,
          execution,
          turn.taskId,
          synchronization.result,
        );
      return;
    }
    const prepared = await this.preparation.prepare(
      session,
      execution,
      turn,
      observation,
    );
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
    let handoffEntry: OutboxEntry | undefined;
    let handoffPrepared = false;
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
          taskId: turn.kind === 'CONTINUATION' ? turn.taskId : null,
          observe: protocolObserver(observation, createCommandClassifier(repositoryPath)),
          onManualHandoff:
            turn.manualHandoff === 'EXTERNAL_SESSION'
              ? async (questions) => {
                  observation.record({
                    name: 'handoff.requested',
                    source: 'xapt',
                    status: 'handed_off',
                  });
                  await startGate;
                  if (!startAccepted) throw new Error('任务启动状态尚未被服务接受');
                  const payload = sanitizeExecutionInteractionPayload(
                    'xapt/manualHandoff',
                    { questions },
                  );
                  handoffEntry = await this.outbox.prepare('OUTCOME', execution.id, {
                    leaseToken: execution.lease.token,
                    sessionId: started.sessionId,
                    outcome: {
                      kind: 'HANDED_OFF',
                      questions: (payload as { questions: string[] }).questions,
                    },
                  });
                  await this.http.openInteraction(
                    session.serverOrigin,
                    session.credential,
                    execution.id,
                    {
                      leaseToken: execution.lease.token,
                      kind: 'USER_INPUT',
                      method: 'xapt/manualHandoff',
                      payload,
                    },
                  );
                  handoffPrepared = true;
                }
              : undefined,
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
      !(await this.outbox.persistAndDeliver(session, 'START', execution.id, startRequest))
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
      await observation.phase('validation', () =>
        this.resultVerifier.verify(
          repositoryPath,
          resultAssertions,
          resultBaseline,
          result,
        ),
      );
      observation.record({
        name: 'outcome.validated',
        source: 'xapt',
        status: 'succeeded',
      });
      request = {
        leaseToken: execution.lease.token,
        sessionId: started.sessionId,
        outcome: {
          kind: 'SUCCEEDED',
          result,
        },
      };
    } catch (error) {
      if (handoffEntry) {
        // completion settles only after the owning app-server has exited.
        await started.completion.catch(() => undefined);
        handoffEntry = await this.outbox.confirmSessionReleased(handoffEntry);
        lease.stop();
        await this.recovery.recordPhase(execution, 'OUTCOME_PENDING', started.sessionId);
        if (handoffPrepared && (await this.outbox.deliverPrepared(session, handoffEntry)))
          await this.state.removeExecution(execution.id);
        this.controllers.delete(execution.id);
        return;
      }
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
    await this.recovery.recordPhase(execution, 'OUTCOME_PENDING', started.sessionId);
    if (await this.outbox.persistAndDeliver(session, 'OUTCOME', execution.id, request))
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
        kind: method === 'item/tool/requestUserInput' ? 'USER_INPUT' : 'APPROVAL',
        method,
        payload,
      },
    );
    this.waitingInteractionCount += 1;
    await this.recovery.recordPhase(execution, 'WAITING_INTERACTION', sessionId);
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
