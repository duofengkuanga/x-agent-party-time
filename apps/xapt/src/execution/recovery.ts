import type { ClaimedExecution } from '@agent-party-time/execution-contract';
import type { AuthenticatedRunnerSession } from '../agent/connection';
import type { RunnerExecutionHttp } from '../agent/serverHttp';
import {
  EXECUTION_STATE_SCHEMA_VERSION,
  type ExecutionRecoveryState,
} from '../state/schemas';
import type { LocalStateStore } from '../state/store';

export type ExecutionLease = { lost: Promise<never>; stop: () => Promise<void> };

/** Durable phase records and the live lease belong to the same execution. */
export class ExecutionRecovery {
  private readonly writes = new Map<string, Promise<void>>();
  constructor(
    private readonly http: RunnerExecutionHttp,
    private readonly state: LocalStateStore,
    private readonly now: () => Date,
  ) {}

  async renew(session: AuthenticatedRunnerSession, execution: ClaimedExecution) {
    const status = await this.http.renewExecution(
      session.serverOrigin,
      session.credential,
      execution.id,
      execution.lease.token,
    );
    await this.persistRenewedLease(execution, status.expiresAt);
    return status;
  }

  recordPhase(
    execution: ClaimedExecution,
    phase: ExecutionRecoveryState['phase'],
    sessionId: string | null,
  ): Promise<void> {
    return this.writeExecution(execution.id, () =>
      this.state.saveExecution({
        schemaVersion: EXECUTION_STATE_SCHEMA_VERSION,
        executionId: execution.id,
        bindingId: execution.bindingId,
        phase,
        sessionId,
        claimedExecution: execution,
        updatedAt: this.now().toISOString(),
      }),
    );
  }

  async recoverInterrupted(): Promise<boolean> {
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
    await this.writeExecution(execution.id, async () => {
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
    });
  }

  private writeExecution(executionId: string, write: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(executionId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(write);
    const finished = pending.finally(() => {
      if (this.writes.get(executionId) === finished) this.writes.delete(executionId);
    });
    this.writes.set(executionId, finished);
    return finished;
  }

  keepLease(
    session: AuthenticatedRunnerSession,
    execution: ClaimedExecution,
    controller: AbortController,
  ): ExecutionLease {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<void> | undefined;
    let rejectLost!: (error: Error) => void;
    let stopped = false;
    const lost = new Promise<never>((_resolve, reject) => {
      rejectLost = reject;
    });
    // Loss can happen while preparation is still pending. The caller checks the
    // abort signal before starting and races this promise once the turn exists.
    void lost.catch(() => undefined);
    const renew = async () => {
      if (stopped || controller.signal.aborted) return;
      try {
        const status = await this.renew(session, execution);
        if (stopped || controller.signal.aborted) return;
        if (status.cancellationRequested) throw new Error('服务端已请求取消');
        schedule();
      } catch (error) {
        if (stopped) return;
        controller.abort();
        rejectLost(error instanceof Error ? error : new Error('任务领取凭据已失效'));
      }
    };
    const schedule = () => {
      timer = setTimeout(() => {
        inFlight = renew();
      }, 5_000);
    };
    schedule();
    return {
      lost,
      stop: async () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        await inFlight;
      },
    };
  }
}
