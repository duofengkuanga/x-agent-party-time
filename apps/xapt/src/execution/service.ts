import { join } from 'node:path';
import {
  attachDeploymentEvidence,
  observeDeploymentEvidence,
  type DeploymentEvidenceTarget,
} from './deploymentEvidence';
import type {
  ClaimedExecution,
  CompleteExecutionRequest,
  ExecutionFailure,
  ExecutionStartRequest,
  JsonValue,
} from '@agent-party-time/execution-contract';
import { serializeDeterministicJson } from '@agent-party-time/execution-contract';
import { executionsConflict } from '@agent-party-time/execution-contract/scheduling';
import type { OutboxEntry } from '../state/schemas';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRunnerSession } from '../agent/connection';
import type { RunnerExecutionHttp } from '../agent/serverHttp';
import { RunnerHttpError } from '@agent-party-time/runner-contract/http-client';
import { type CodexExecutor, type StartedCodexExecution } from '../codex/contract';
import { CodexAppServerError, CodexSessionReleaseError } from '../codex/errors';
import { processGroupExists } from '../platform/processGroups';
import { interactionContinuation } from '../codex/interaction';
import type { LocalFileSystem } from '../platform/files';
import type { SkillBundleManager } from '../skills/manager';
import type { LocalStateStore } from '../state/store';
import type { AttachmentMaterializer } from './attachments';
import { ExecutionOutbox } from './outbox';
import { ExecutionPreparation } from './preparation';
import { ExecutionRecovery, type ExecutionLease } from './recovery';
import { failureMessage } from './failureMessage';
import {
  ExecutionResultVerificationError,
  type ExecutionResultVerifier,
} from './resultVerification';
import type { ExecutionWorkspaceManager } from './workspaces';
import type { ObservationService } from '../observability/service';
import type { ExecutionObservation } from '../observability/recorder';
import { protocolObserver } from '../observability/protocol';
import { XAPT_VERSION } from '../version';
import { createCommandClassifier } from '../observability/commandContext';

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
  private readonly scheduledExecutions = new Map<string, ClaimedExecution>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly runningExecutionIds = new Set<string>();
  private readonly blockedReleases = new Set<string>();
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
    private readonly workspaces: ExecutionWorkspaceManager,
    private readonly executor: CodexExecutor,
    skills: SkillBundleManager,
    private readonly resultVerifier: ExecutionResultVerifier,
    private readonly observations: ObservationService,
    now: () => Date = () => new Date(),
    createId: () => string = randomUUID,
  ) {
    this.outbox = new ExecutionOutbox(http, state, executor, now, createId, (notice) => {
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
    const active = new Set(this.tasks.keys());
    if (this.blockedReleases.size || (await this.recovery.hasOwnedProcesses(active))) {
      this.recoveryRequired = true;
      return false;
    }
    if (!(await this.outbox.replayOutbox(session, active))) {
      this.recoveryRequired = true;
      return false;
    }
    if (this.tasks.size === 0) {
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
    const previous = [...this.scheduledExecutions.values()]
      .filter((entry) => executionsConflict(entry, execution))
      .map((entry) => this.tasks.get(entry.id)!);
    const persisted = this.recovery.recordPhase(execution, 'CLAIMED', null);
    const controller = new AbortController();
    this.controllers.set(execution.id, controller);
    const lease = this.recovery.keepLease(session, execution, controller);
    let task!: Promise<void>;
    task = Promise.all([persisted, ...previous])
      .then(async () => {
        if (this.forceStopping) return;
        controller.signal.throwIfAborted();
        observation.record({
          name: 'phase.finished',
          source: 'xapt',
          phase: 'local_wait',
          correlation: { intervalId: waitId },
          status: 'succeeded',
        });
        this.runningExecutionIds.add(execution.id);
        try {
          await this.execute(session, execution, observation, controller, lease);
        } finally {
          this.runningExecutionIds.delete(execution.id);
        }
      })
      .catch(() => {
        this.recoveryRequired = true;
      })
      .finally(async () => {
        await lease.stop();
        this.controllers.delete(execution.id);
        this.observations.close(execution.id);
        this.tasks.delete(execution.id);
        this.scheduledExecutions.delete(execution.id);
      });
    this.tasks.set(execution.id, task);
    this.scheduledExecutions.set(execution.id, execution);
  }

  private async execute(
    session: AuthenticatedRunnerSession,
    execution: ClaimedExecution,
    observation: ExecutionObservation,
    controller: AbortController,
    lease: ExecutionLease,
  ): Promise<void> {
    const failStart = async (failure: ExecutionFailure) => {
      await lease.stop();
      await this.reportStartFailure(session, execution, failure);
    };
    if (execution.cancellationRequested) {
      await failStart({
        code: 'CANCELLED_BY_REQUEST',
        message: '处理任务已取消，不再启动本机任务',
        retryable: false,
      });
      return;
    }
    const turn = execution.codexTurn;
    if (
      !turn &&
      !execution.workspaces.every(
        ({ workspace }) => workspace?.isolation === 'CLEANUP_WORKTREES',
      )
    ) {
      await failStart({
        code: 'CODEX_START_FAILED',
        message: '任务缺少 Codex 输入',
        retryable: false,
      });
      return;
    }
    if (turn?.kind === 'READ_SESSION') {
      const synchronization = await this.preparation.readSession(
        execution,
        turn.taskId,
        observation,
      );
      controller.signal.throwIfAborted();
      if (synchronization.kind === 'FAILED') await failStart(synchronization.failure);
      else
        await this.completeImmediateExecution(
          session,
          execution,
          turn.taskId,
          synchronization.result,
          lease,
        );
      return;
    }
    const prepared = await this.preparation.prepare(
      session,
      execution,
      turn,
      observation,
    );
    controller.signal.throwIfAborted();
    if (prepared.kind === 'FAILED') {
      await failStart(prepared.failure);
      return;
    }
    if (prepared.kind === 'WORKSPACE_COMPLETED') {
      try {
        for (const { workspace } of execution.workspaces)
          if (workspace?.isolation === 'CLEANUP_WORKTREES')
            for (const key of workspace.workspaceKeys)
              await this.state.removeDeploymentEvidence(key);
        await this.completeImmediateExecution(
          session,
          execution,
          `xapt-workspace:${execution.id}`,
          prepared.result,
          lease,
        );
      } catch {
        await failStart({
          code: 'REPOSITORY_NOT_FOUND',
          message: '无法准备隔离的本机 Git 工作区',
          retryable: true,
        });
      }
      return;
    }
    if (!turn) throw new Error('清理执行没有返回本机结果');
    const {
      repositoryPath,
      materialized,
      resolvedSkill,
      workspaceDirectories,
      verification,
    } = prepared;
    const deliveryTargets: DeploymentEvidenceTarget[] = verification.flatMap(
      ({ workspace, repositoryPath, resultAssertions }) =>
        workspace
          ? resultAssertions.flatMap((assertion) =>
              assertion.kind === 'GIT_DELIVERY_STATE'
                ? [{ repositoryPath, workspaceKey: workspace.key, assertion }]
                : [],
            )
          : [],
    );
    let pendingEvidence = Promise.resolve();
    let evidenceWriteFailed = false;
    const observeProtocol = protocolObserver(
      observation,
      createCommandClassifier(repositoryPath),
    );
    let recoveredInteraction = execution.recoveredInteraction;
    let releaseStartGate!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStartGate = resolve;
    });
    let startAccepted = false;
    let started: StartedCodexExecution;
    let handoffEntry: Promise<OutboxEntry> | undefined;
    let interactionEntry: OutboxEntry | undefined;
    let interactionQueue: Promise<unknown> = Promise.resolve();
    try {
      started = await this.executor.begin(
        {
          approvalPolicy: execution.approvalPolicy,
          executionId: execution.id,
          repositoryPath,
          workspaceDirectories,
          text:
            recoveredInteraction && turn.managedInteractions
              ? interactionContinuation(recoveredInteraction)
              : turn.kind === 'INITIAL'
                ? serializeDeterministicJson(turn.executionBrief)
                : turn.input,
          skill:
            turn.kind === 'INITIAL'
              ? { name: resolvedSkill.skillName, path: resolvedSkill.path }
              : null,
          handoffSkillPath: resolvedSkill.handoffPath,
          boundSkillPath:
            turn.kind === 'CONTINUATION'
              ? join(resolvedSkill.path, 'SKILL.md')
              : undefined,
          outputSchema: turn.outputJsonSchema,
          // Reclaimed executions already sent these paths to the same session.
          // Materialization above restores the files at their original paths.
          attachments: execution.sessionId ? [] : materialized,
          taskId: turn.kind === 'CONTINUATION' ? turn.taskId : null,
          managedInteractions: turn.managedInteractions,
          onProcessGroups: turn.managedInteractions
            ? (groups) => this.recovery.recordProcessGroups(execution.id, groups)
            : undefined,
          observe: (notice) => {
            observeProtocol(notice);
            if (!deliveryTargets.length) return;
            const evidence = observeDeploymentEvidence(
              notice,
              deliveryTargets,
              execution.id,
            );
            if (evidence)
              pendingEvidence = pendingEvidence
                .then(() => this.state.saveDeploymentEvidence(evidence))
                .catch(() => {
                  evidenceWriteFailed = true;
                });
          },
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
                  handoffEntry = this.outbox.prepareHandoff(
                    session,
                    execution,
                    started.sessionId,
                    questions,
                  );
                  await handoffEntry;
                }
              : undefined,
          onInteraction: (interaction) => {
            const response = interactionQueue.then(async () => {
              controller.signal.throwIfAborted();
              if (this.blockedReleases.has(execution.id))
                throw new Error('正在确认本机执行已停止');
              await startGate;
              controller.signal.throwIfAborted();
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
              try {
                if (turn.managedInteractions)
                  interactionEntry = await this.outbox.prepareInteractionYield(
                    execution.id,
                    {
                      leaseToken: execution.lease.token,
                      sessionId: started.sessionId,
                      kind:
                        interaction.method === 'item/tool/requestUserInput' ||
                        interaction.method === 'xapt/asyncQuestions'
                          ? 'USER_INPUT'
                          : 'APPROVAL',
                      ...interaction,
                    },
                  );
                const resolution = await this.handleInteraction(
                  session,
                  execution,
                  started.sessionId,
                  interaction.method,
                  interaction.payload,
                  controller,
                );
                if (interactionEntry) {
                  await this.state.removeOutbox(interactionEntry.id);
                  interactionEntry = undefined;
                }
                return resolution;
              } catch (error) {
                if (turn.managedInteractions && !this.blockedReleases.has(execution.id))
                  controller.abort();
                throw error;
              }
            });
            interactionQueue = response.catch(() => undefined);
            return response;
          },
        },
        controller.signal,
      );
      // The turn can end while its START acknowledgement is still in flight.
      void started.completion.catch(() => undefined);
    } catch (error) {
      if (error instanceof CodexSessionReleaseError)
        await this.waitForProcessRelease(execution.id, error, controller);
      await failStart({
        code: 'CODEX_START_FAILED',
        message:
          turn.managedInteractions &&
          (execution.sessionId || turn.kind === 'CONTINUATION')
            ? `原会话无法继续，需要工程负责人处理。${error instanceof CodexAppServerError ? failureMessage(error.message) : ''}`
            : error instanceof CodexAppServerError
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
      await started.completion.catch(async (error) => {
        if (error instanceof CodexSessionReleaseError)
          await this.waitForProcessRelease(execution.id, error, controller);
      });
      return;
    }
    startAccepted = true;
    releaseStartGate();
    await this.recovery.recordPhase(execution, 'RUNNING', started.sessionId);
    let request: CompleteExecutionRequest;
    try {
      const result = await Promise.race([started.completion, lease.lost]);
      await observation.phase('validation', async () => {
        for (const {
          repositoryPath,
          bindingPath,
          workspace,
          resultAssertions,
          resultBaseline,
        } of verification) {
          if (
            workspace &&
            (await this.workspaces.resolve(bindingPath, workspace)) !== repositoryPath
          )
            throw new ExecutionResultVerificationError('执行结果的 Git 工作区身份已变化');
          await this.resultVerifier.verify(
            repositoryPath,
            resultAssertions,
            resultBaseline,
            result,
          );
        }
      });
      await pendingEvidence;
      if (evidenceWriteFailed)
        throw new ExecutionResultVerificationError('无法持久化本机部署验收回执');
      for (const target of deliveryTargets)
        await attachDeploymentEvidence(this.state, target, result);
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
      // A failed renewal can win the race before the executor has stopped.
      // Completion is also the executor's cleanup acknowledgement.
      await started.completion.catch(async (completionError) => {
        if (completionError instanceof CodexSessionReleaseError)
          await this.waitForProcessRelease(execution.id, completionError, controller);
      });
      if (interactionEntry) {
        await this.outbox.finishInteractionYield(session, interactionEntry, lease.stop());
        return;
      }
      if (handoffEntry) {
        await this.recovery.recordPhase(execution, 'OUTCOME_PENDING', started.sessionId);
        await this.outbox.finishHandoff(session, handoffEntry, lease.stop());
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
      await lease.stop();
    }
    await this.recovery.recordPhase(execution, 'OUTCOME_PENDING', started.sessionId);
    await this.outbox.persistAndDeliver(session, 'OUTCOME', execution.id, request);
  }

  private async handleInteraction(
    session: AuthenticatedRunnerSession,
    execution: ClaimedExecution,
    sessionId: string,
    method: string,
    payload: JsonValue,
    controller: AbortController,
  ): Promise<JsonValue> {
    controller.signal.throwIfAborted();
    const opened = await this.http.openInteraction(
      session.serverOrigin,
      session.credential,
      execution.id,
      {
        leaseToken: execution.lease.token,
        kind:
          method === 'item/tool/requestUserInput' || method === 'xapt/asyncQuestions'
            ? 'USER_INPUT'
            : 'APPROVAL',
        method,
        payload,
      },
    );
    controller.signal.throwIfAborted();
    this.waitingInteractionCount += 1;
    try {
      await this.recovery.recordPhase(execution, 'WAITING_INTERACTION', sessionId);
      for (;;) {
        if (this.blockedReleases.has(execution.id))
          throw new Error('正在确认本机执行已停止');
        const waited = await this.http.waitInteraction(
          session.serverOrigin,
          session.credential,
          execution.id,
          opened.id,
          execution.lease.token,
          5_000,
        );
        controller.signal.throwIfAborted();
        if (this.blockedReleases.has(execution.id))
          throw new Error('正在确认本机执行已停止');
        if (waited.yieldRequested) throw new Error('人工等待已让位');
        const renewed = await this.recovery.renew(session, execution);
        if (renewed.cancellationRequested) {
          controller.abort();
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

  private async waitForProcessRelease(
    executionId: string,
    error: CodexSessionReleaseError,
    controller: AbortController,
  ): Promise<void> {
    this.blockedReleases.add(executionId);
    this.recoveryRequired = true;
    // Keep the task and its renewal alive. Restart checks the same durable groups
    // before replaying receipts or claiming anything, even after the lease expires.
    while (error.ownershipUncertain || error.processGroups.some(processGroupExists)) {
      if (error.ownershipUncertain && this.forceStopping) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await this.recovery.recordProcessGroups(executionId, []);
    controller.abort();
    this.blockedReleases.delete(executionId);
  }

  private async reportStartFailure(
    session: AuthenticatedRunnerSession,
    execution: ClaimedExecution,
    failure: ExecutionFailure,
  ): Promise<void> {
    await this.outbox.persistAndDeliver(session, 'START', execution.id, {
      kind: 'START_FAILED',
      leaseToken: execution.lease.token,
      failure,
    });
  }

  private async completeImmediateExecution(
    session: AuthenticatedRunnerSession,
    execution: ClaimedExecution,
    sessionId: string,
    result: JsonValue,
    lease: ExecutionLease,
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
    await lease.stop();
    await this.outbox.persistAndDeliver(session, 'OUTCOME', execution.id, {
      leaseToken: execution.lease.token,
      sessionId,
      outcome: { kind: 'SUCCEEDED', result },
    });
  }
}

class CancellationRequested extends Error {}
