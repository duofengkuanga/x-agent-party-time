import type {
  CompleteExecutionRequest,
  ExecutionStartRequest,
} from '@agent-party-time/execution-contract';
import type { AuthenticatedRunnerSession } from '../agent/connection';
import type { RunnerExecutionHttp } from '../agent/server-http';
import { RunnerHttpError } from '../agent/server-http';
import {
  OUTBOX_STATE_SCHEMA_VERSION,
  type OutboxEntry,
} from '../state/schemas';
import type { LocalStateStore } from '../state/store';
export class ExecutionOutbox {
  constructor(
    private readonly http: RunnerExecutionHttp,
    private readonly state: LocalStateStore,
    private readonly now: () => Date,
    private readonly createId: () => string,
  ) {}
  async persistAndDeliver(
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
    return this.deliver(session, entry, 'LIVE');
  }

  async replayOutbox(session: AuthenticatedRunnerSession): Promise<boolean> {
    for (const entry of await this.state.loadOutbox())
      if (!(await this.deliver(session, entry, 'RECOVERY'))) return false;
    return true;
  }

  private async deliver(
    session: AuthenticatedRunnerSession,
    entry: OutboxEntry,
    mode: 'LIVE' | 'RECOVERY',
  ): Promise<boolean> {
    try {
      const address = [
        session.serverOrigin,
        session.credential,
        entry.executionId,
      ] as const;
      if (entry.kind === 'START')
        await this.http.startExecution(...address, entry.request);
      else await this.http.completeExecution(...address, entry.request);
      await this.state.removeOutbox(entry.id);
      if (
        mode === 'RECOVERY' &&
        (entry.kind === 'OUTCOME' || entry.request.kind === 'START_FAILED')
      )
        await this.state.removeExecution(entry.executionId);
      return true;
    } catch (error) {
      if (!isTerminalDeliveryError(error)) return false;
      await this.state.removeOutbox(entry.id);
      if (mode === 'RECOVERY')
        await this.state.removeExecution(entry.executionId);
      return true;
    }
  }
}
function isTerminalDeliveryError(error: unknown): boolean {
  return (
    error instanceof RunnerHttpError &&
    ['LEASE_EXPIRED', 'OUTCOME_CONFLICT', 'INVALID_TRANSITION'].includes(
      error.code,
    )
  );
}
