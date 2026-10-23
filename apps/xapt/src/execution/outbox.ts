import type {
  ClaimedExecution,
  CompleteExecutionRequest,
  ExecutionStartRequest,
} from '@agent-party-time/execution-contract';
import { sanitizeExecutionInteractionPayload } from '@agent-party-time/execution-contract';
import type { CodexExecutor } from '../codex/contract';
import type { AuthenticatedRunnerSession } from '../agent/connection';
import type { RunnerExecutionHttp } from '../agent/serverHttp';
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
    private readonly executor: Pick<CodexExecutor, 'releaseSession'>,
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
    return this.deliver(session, entry, 'LIVE');
  }

  private async prepare(
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

  async prepareHandoff(
    session: AuthenticatedRunnerSession,
    execution: ClaimedExecution,
    sessionId: string,
    questions: string[],
  ): Promise<OutboxEntry> {
    const payload = sanitizeExecutionInteractionPayload('xapt/manualHandoff', {
      questions,
    });
    const entry = await this.prepare('OUTCOME', execution.id, {
      leaseToken: execution.lease.token,
      sessionId,
      outcome: {
        kind: 'HANDED_OFF',
        questions: (payload as { questions: string[] }).questions,
      },
    });
    try {
      await this.openHandoff(session, entry);
    } catch {
      // The durable receipt lets delivery retry missing preparation after release.
    }
    return entry;
  }

  async finishHandoff(
    session: AuthenticatedRunnerSession,
    entry: Promise<OutboxEntry>,
    completion: Promise<unknown>,
  ): Promise<boolean> {
    // The owning app-server has exited when completion settles, including rejection.
    await completion.catch(() => undefined);
    return this.deliver(session, await this.confirmSessionReleased(await entry), 'LIVE');
  }

  private async confirmSessionReleased(entry: OutboxEntry): Promise<OutboxEntry> {
    if (entry.kind !== 'OUTCOME' || entry.request.outcome.kind !== 'HANDED_OFF')
      throw new Error('只有人工接管回执可以记录会话释放');
    const released = { ...entry, sessionReleased: true as const };
    await this.state.saveOutbox(released);
    return released;
  }

  private async openHandoff(session: AuthenticatedRunnerSession, entry: OutboxEntry) {
    if (entry.kind !== 'OUTCOME' || entry.request.outcome.kind !== 'HANDED_OFF')
      throw new Error('只有人工接管回执可以准备会话交接');
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
  }

  async replayOutbox(session: AuthenticatedRunnerSession): Promise<boolean> {
    for (const entry of await this.state.loadOutbox()) {
      if (!(await this.deliver(session, entry, 'RECOVERY'))) return false;
    }
    return true;
  }

  private async deliver(
    session: AuthenticatedRunnerSession,
    entry: OutboxEntry,
    mode: 'LIVE' | 'RECOVERY',
  ): Promise<boolean> {
    const handoff =
      entry.kind === 'OUTCOME' && entry.request.outcome.kind === 'HANDED_OFF';
    if (handoff && !entry.sessionReleased) {
      if (!this.executor.releaseSession) return false;
      try {
        await this.executor.releaseSession(entry.request.sessionId);
        await this.confirmSessionReleased(entry);
      } catch {
        return false;
      }
    }
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
      else {
        try {
          await this.http.completeExecution(...address, entry.request);
        } catch (error) {
          if (
            !handoff ||
            !(error instanceof RunnerHttpError) ||
            error.code !== 'INVALID_TRANSITION'
          )
            throw error;
          try {
            await this.openHandoff(session, entry);
          } catch {
            observe('unknown');
            return false;
          }
          await this.http.completeExecution(...address, entry.request);
        }
      }
      accepted = true;
      observe('accepted');
    } catch (error) {
      observe(isTerminalDeliveryError(error) ? 'rejected' : 'unknown');
      if (
        !isTerminalDeliveryError(error) ||
        (handoff && error instanceof RunnerHttpError && error.code === 'LEASE_EXPIRED')
      )
        return false;
    }
    try {
      if (terminal || (mode === 'RECOVERY' && !accepted))
        await this.state.removeExecution(entry.executionId);
      // Keep the receipt until all local cleanup succeeds, so an accepted Outcome can be retried.
      await this.state.removeOutbox(entry.id);
      return true;
    } catch {
      return false;
    }
  }
}
function isTerminalDeliveryError(error: unknown): boolean {
  return (
    error instanceof RunnerHttpError &&
    ['LEASE_EXPIRED', 'OUTCOME_CONFLICT', 'INVALID_TRANSITION'].includes(error.code)
  );
}
