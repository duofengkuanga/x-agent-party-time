import type { ClaimedExecution } from '@agent-party-time/execution-contract';
import type { AuthenticatedRunnerSession } from '../agent/connection';
import type { RunnerExecutionHttp } from '../agent/server-http';
import {
  EXECUTION_STATE_SCHEMA_VERSION,
  type ExecutionRecoveryState,
} from '../state/schemas';
import type { LocalStateStore } from '../state/store';

/** Durable phase records and the live lease belong to the same execution. */
export class ExecutionRecovery {
  constructor(
    private readonly http: RunnerExecutionHttp,
    private readonly state: LocalStateStore,
    private readonly now: () => Date,
  ) {}

  async renew(
    session: AuthenticatedRunnerSession,
    execution: ClaimedExecution,
  ) {
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
    return this.state.saveExecution({
      schemaVersion: EXECUTION_STATE_SCHEMA_VERSION,
      executionId: execution.id,
      bindingId: execution.bindingId,
      phase,
      sessionId,
      claimedExecution: execution,
      updatedAt: this.now().toISOString(),
    });
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

  keepLease(
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
        const status = await this.renew(session, execution);
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
