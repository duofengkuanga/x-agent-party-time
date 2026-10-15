import type {
  CompleteExecutionRequest,
  ExecutionStartRequest,
} from '@agent-party-time/execution-contract';
import type { AuthenticatedRunnerSession } from '../agent/connection';
import type { RunnerExecutionHttp } from '../agent/server-http';
import { RunnerHttpError } from '@agent-party-time/runner-contract/http-client';
import { OUTBOX_STATE_SCHEMA_VERSION, type OutboxEntry } from '../state/schemas';
import type { LocalStateStore } from '../state/store';
import { randomUUID } from 'node:crypto';

type DeliveryNotice = {
  executionId: string;
  entryId: string;
  attemptId: string;
  terminal: boolean;
  stage: 'started' | 'accepted' | 'rejected' | 'unknown';
};
export class ExecutionOutbox {
  constructor(
    private readonly http: RunnerExecutionHttp,
    private readonly state: LocalStateStore,
    private readonly now: () => Date,
    private readonly createId: () => string,
    private readonly observation: (notice: DeliveryNotice) => void,
  ) {}
  async persistAndDeliver(
    session: AuthenticatedRunnerSession,
    kind: 'START' | 'OUTCOME',
    executionId: string,
    request: ExecutionStartRequest | CompleteExecutionRequest,
  ): Promise<boolean> {
    const entry = await this.prepare(kind, executionId, request);
    return this.deliverPrepared(session, entry);
  }

  async prepare(
    kind: 'START' | 'OUTCOME',
    executionId: string,
    request: ExecutionStartRequest | CompleteExecutionRequest,
  ): Promise<OutboxEntry> {
    const entry = {
      schemaVersion: OUTBOX_STATE_SCHEMA_VERSION,
      id: this.createId(),
      kind,
      executionId,
      request,
      createdAt: this.now().toISOString(),
    } as OutboxEntry;
    await this.state.saveOutbox(entry);
    return entry;
  }

  deliverPrepared(
    session: AuthenticatedRunnerSession,
    entry: OutboxEntry,
  ): Promise<boolean> {
    return this.deliver(session, entry, 'LIVE');
  }

  async confirmSessionReleased(entry: OutboxEntry): Promise<OutboxEntry> {
    if (entry.kind !== 'OUTCOME' || entry.request.outcome.kind !== 'HANDED_OFF')
      throw new Error('只有人工接管回执可以记录会话释放');
    const released = { ...entry, sessionReleased: true as const };
    await this.state.saveOutbox(released);
    return released;
  }

  async replayOutbox(
    session: AuthenticatedRunnerSession,
    beforeReplay?: (entry: OutboxEntry) => Promise<boolean>,
  ): Promise<boolean> {
    for (const entry of await this.state.loadOutbox()) {
      if (beforeReplay && !(await beforeReplay(entry))) return false;
      if (!(await this.deliver(session, entry, 'RECOVERY'))) return false;
    }
    return true;
  }

  private async deliver(
    session: AuthenticatedRunnerSession,
    entry: OutboxEntry,
    mode: 'LIVE' | 'RECOVERY',
  ): Promise<boolean> {
    const attemptId = randomUUID();
    const terminal = entry.kind === 'OUTCOME' || entry.request.kind === 'START_FAILED';
    const observe = (stage: DeliveryNotice['stage']) => {
      try {
        this.observation({
          executionId: entry.executionId,
          entryId: entry.id,
          attemptId,
          terminal,
          stage,
        });
      } catch {
        /* Diagnostics are independent. */
      }
    };
    observe('started');
    let accepted = false;
    try {
      const address = [
        session.serverOrigin,
        session.credential,
        entry.executionId,
      ] as const;
      if (entry.kind === 'START')
        await this.http.startExecution(...address, entry.request);
      else await this.http.completeExecution(...address, entry.request);
      accepted = true;
      observe('accepted');
      await this.state.removeOutbox(entry.id);
      if (
        mode === 'RECOVERY' &&
        (entry.kind === 'OUTCOME' || entry.request.kind === 'START_FAILED')
      )
        await this.state.removeExecution(entry.executionId);
      return true;
    } catch (error) {
      if (!accepted) observe(isTerminalDeliveryError(error) ? 'rejected' : 'unknown');
      if (!isTerminalDeliveryError(error)) return false;
      await this.state.removeOutbox(entry.id);
      if (mode === 'RECOVERY') await this.state.removeExecution(entry.executionId);
      return true;
    }
  }
}
function isTerminalDeliveryError(error: unknown): boolean {
  return (
    error instanceof RunnerHttpError &&
    ['LEASE_EXPIRED', 'OUTCOME_CONFLICT', 'INVALID_TRANSITION'].includes(error.code)
  );
}
