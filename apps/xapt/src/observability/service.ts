import { randomUUID } from 'node:crypto';
import {
  calculateObservationReport,
  observationDigest,
  OBSERVATION_LIMITS,
  type ObservationBatch,
  type ObservationEvent,
  type ObservationReport,
} from '@agent-party-time/execution-contract/observability';
import type { ClaimedExecution } from '@agent-party-time/execution-contract';
import type { AuthenticatedRunnerSession } from '../agent/connection';
import type { LocalFileSystem } from '../platform/files';
import type { LocalStateStore } from '../state/store';
import { ExecutionObservation, type ObservationFields } from './recorder';
import { ObservationCapacityError, ObservationStore } from './store';
import { ObservationDeliveryError, type ObservationTransport } from './transport';

type Capture = {
  executionId: string;
  runnerId: string;
  origin: string;
  recorder: ExecutionObservation;
  pending: ObservationEvent[];
  history: ObservationEvent[];
  loaded: boolean;
  head: ObservationReport | null;
  closed: boolean;
  limited: boolean;
  detailStopped: boolean;
};

export class ObservationService {
  private readonly store: ObservationStore;
  private readonly captures = new Map<string, Capture>();
  private timer?: ReturnType<typeof setTimeout>;
  private draining: Promise<void> | null = null;
  private delivering: Promise<void> | null = null;
  private session: AuthenticatedRunnerSession | null = null;
  private retryAt = 0;
  private failures = 0;
  private bufferedBytes = 0;
  private pausedSession: string | null = null;
  private unhealthy = false;
  private warned = false;
  private stopping = false;
  private readonly deliveryAbort = new AbortController();
  private degrade(): void {
    this.unhealthy = true;
    if (!this.warned) {
      this.warned = true;
      console.warn('耗时归因部分不可用，请检查本机观测存储或补报连接；业务执行照常。');
    }
  }

  constructor(
    root: string,
    files: LocalFileSystem,
    private readonly state: LocalStateStore,
    private readonly transport: ObservationTransport,
    private readonly now: () => Date = () => new Date(),
    private readonly codexVersion?: string,
  ) {
    this.store = new ObservationStore(root, files, now);
  }

  get degraded(): boolean {
    return this.unhealthy || this.store.degraded;
  }

  receive(
    session: AuthenticatedRunnerSession,
    execution: Pick<ClaimedExecution, 'id' | 'runnerId'>,
  ): ExecutionObservation {
    try {
      const capture = this.capture(session, execution.id, execution.runnerId);
      capture.recorder.record({ name: 'execution.received', source: 'xapt' });
      if (this.codexVersion)
        capture.recorder.record({
          name: 'configuration.observed',
          source: 'xapt',
          configuration: { codexVersion: this.codexVersion },
        });
      return capture.recorder;
    } catch {
      this.degrade();
      return new ExecutionObservation(execution.id, () => {});
    }
  }

  forExecution(executionId: string): ExecutionObservation | null {
    return this.captures.get(executionId)?.recorder ?? null;
  }

  event(executionId: string, fields: ObservationFields): void {
    this.forExecution(executionId)?.record(fields);
  }

  close(executionId: string): void {
    const capture = this.captures.get(executionId);
    if (!capture) return;
    capture.recorder.close();
    capture.closed = true;
    this.schedule();
  }

  /** Only local, bounded recovery preparation. Never propagates diagnostics failure. */
  async prepareCycle(session: AuthenticatedRunnerSession): Promise<void> {
    this.session = session;
    const preparation = (async () => {
      const connection = await this.state.loadConnection();
      if (!connection || new URL(connection.serverUrl).origin !== session.serverOrigin)
        return;
      for (const recovery of await this.state.loadExecutions()) {
        if (
          recovery.claimedExecution.runnerId !== connection.runnerId ||
          this.captures.has(recovery.executionId)
        )
          continue;
        const capture = this.capture(session, recovery.executionId, connection.runnerId);
        capture.recorder.record({
          name: 'gap',
          source: 'recovered_evidence',
          reason: 'recording_gap',
        });
      }
    })().catch(() => {
      this.degrade();
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      preparation,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 100);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    this.schedule();
  }

  async flush(session?: AuthenticatedRunnerSession): Promise<void> {
    if (this.stopping) return;
    if (session) this.session = session;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.draining)
      this.draining = this.drain()
        .catch(() => {
          this.degrade();
        })
        .finally(() => {
          this.draining = null;
        });
    await this.draining;
    if (!this.delivering)
      this.delivering = this.deliver()
        .catch(() => {
          this.degrade();
        })
        .finally(() => {
          this.delivering = null;
        });
    await this.delivering;
  }

  private capture(
    session: AuthenticatedRunnerSession,
    executionId: string,
    runnerId: string,
  ): Capture {
    const previous = this.captures.get(executionId);
    if (previous) {
      if (previous.runnerId !== runnerId || previous.origin !== session.serverOrigin)
        throw new Error('观测来源冲突');
      return previous;
    }
    const initial: ObservationEvent[] = [];
    let capture: Capture | undefined;
    const recorder = new ExecutionObservation(executionId, (event) => {
      if (!capture) {
        initial.push(event);
        return;
      }
      if (
        capture.detailStopped &&
        ![
          'execution.received',
          'delivery.accepted',
          'segment.opened',
          'segment.closed',
          'gap',
        ].includes(event.name)
      )
        return;
      const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (this.bufferedBytes + bytes > OBSERVATION_LIMITS.memoryBytes * 0.75) {
        capture.limited = true;
        this.degrade();
        if (
          ![
            'execution.received',
            'delivery.accepted',
            'segment.opened',
            'segment.closed',
            'gap',
          ].includes(event.name)
        )
          return;
        for (const candidate of this.captures.values()) {
          while (this.bufferedBytes + bytes > OBSERVATION_LIMITS.memoryBytes * 0.75) {
            const index = candidate.pending.findIndex(
              (entry) =>
                ![
                  'execution.received',
                  'delivery.accepted',
                  'segment.opened',
                  'segment.closed',
                  'gap',
                ].includes(entry.name),
            );
            if (index < 0) break;
            const [removed] = candidate.pending.splice(index, 1);
            this.bufferedBytes -= new TextEncoder().encode(
              JSON.stringify(removed),
            ).byteLength;
            candidate.limited = true;
          }
        }
        if (this.bufferedBytes + bytes > OBSERVATION_LIMITS.memoryBytes * 0.75) return;
      }
      capture.pending.push(event);
      this.bufferedBytes += bytes;
      this.schedule();
    });
    capture = {
      executionId,
      runnerId,
      origin: session.serverOrigin,
      recorder,
      pending: initial,
      history: [],
      loaded: false,
      head: null,
      closed: false,
      limited: false,
      detailStopped: false,
    };
    this.bufferedBytes += initial.reduce(
      (sum, event) => sum + new TextEncoder().encode(JSON.stringify(event)).byteLength,
      0,
    );
    this.captures.set(executionId, capture);
    this.session = session;
    return capture;
  }

  private schedule(): void {
    if (this.stopping) return;
    if (this.timer) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.flush().then(() => {
          if ([...this.captures.values()].some((capture) => capture.pending.length))
            this.schedule();
        });
      },
      Math.max(1000, Math.min(300_000, this.retryAt - this.now().getTime())),
    );
    this.timer.unref();
  }

  /** Graceful exit persists local diagnostics only, without waiting for the network. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.deliveryAbort.abort();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await this.draining;
          await this.drain();
        })(),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            this.degrade();
            resolve();
          }, 1000);
        }),
      ]);
    } catch {
      this.degrade();
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async drain(): Promise<void> {
    for (const capture of this.captures.values()) {
      try {
        await this.persist(capture);
      } catch (error) {
        capture.loaded = false;
        this.degrade();
        if (error instanceof ObservationCapacityError) {
          const stopped = capture.detailStopped;
          capture.detailStopped = true;
          capture.limited = true;
          const retained = stopped
            ? []
            : capture.pending.filter((event) =>
                [
                  'execution.received',
                  'delivery.accepted',
                  'segment.opened',
                  'segment.closed',
                ].includes(event.name),
              );
          this.bufferedBytes -= capture.pending.reduce(
            (sum, event) =>
              sum + new TextEncoder().encode(JSON.stringify(event)).byteLength,
            0,
          );
          capture.pending = retained;
          this.bufferedBytes += retained.reduce(
            (sum, event) =>
              sum + new TextEncoder().encode(JSON.stringify(event)).byteLength,
            0,
          );
          if (!stopped)
            capture.recorder.record({ name: 'gap', source: 'xapt', reason: 'budget' });
        }
      }
    }
    try {
      await this.store.prune(
        new Set(
          [...this.captures.values()]
            .filter((capture) => !capture.closed)
            .map((capture) => capture.executionId),
        ),
      );
    } catch {
      this.degrade();
    }
    for (const [id, capture] of this.captures)
      if (capture.closed && !capture.pending.length) this.captures.delete(id);
  }

  private async persist(capture: Capture): Promise<void> {
    const namespace = await observationDigest({
      origin: capture.origin,
      runnerId: capture.runnerId,
    });
    const loss = await this.store.loss(namespace, capture.executionId);
    // An identity/content rejection quarantines this report lineage. Other executions continue.
    const quarantined = loss.includes('rejected');
    if (!capture.loaded) {
      const old = await this.store.events(namespace, capture.executionId);
      capture.history = old.events;
      capture.head = await this.store.head(namespace, capture.executionId);
      const queued = await this.store.pending(namespace, capture.executionId);
      for (const entry of queued.sort(
        (a, b) => (a.batch.report?.revision ?? 0) - (b.batch.report?.revision ?? 0),
      )) {
        const report = entry.batch.report;
        if (report && report.revision > (capture.head?.revision ?? 0)) {
          await this.store.saveHead(namespace, capture.executionId, report);
          capture.head = report;
        }
      }
      const durableIds = new Set(
        queued.flatMap((entry) => entry.batch.events.map((event) => event.eventId)),
      );
      const consumed = capture.pending.filter((event) => durableIds.has(event.eventId));
      capture.pending = capture.pending.filter((event) => !durableIds.has(event.eventId));
      this.bufferedBytes -= consumed.reduce(
        (sum, event) => sum + new TextEncoder().encode(JSON.stringify(event)).byteLength,
        0,
      );
      capture.loaded = true;
      if (old.incomplete)
        capture.recorder.record({
          name: 'gap',
          source: 'recovered_evidence',
          reason: 'recording_gap',
        });
    }
    while (capture.pending.length) {
      let events = capture.pending.slice(0, OBSERVATION_LIMITS.batchEvents);
      while (new TextEncoder().encode(JSON.stringify(events)).byteLength > 160 * 1024)
        events = events.slice(0, Math.max(1, Math.floor(events.length / 2)));
      await this.store.append(namespace, capture.executionId, randomUUID(), events);
      const merged = [
        ...new Map(
          [...capture.history, ...events].map((event) => [event.eventId, event]),
        ).values(),
      ];
      let report: ObservationReport | null = quarantined
        ? null
        : calculateObservationReport(merged, {
            executionId: capture.executionId,
            reportId: randomUUID(),
            revision: (capture.head?.revision ?? 0) + 1,
            parentReportId: capture.head?.reportId ?? null,
            inputDigest: await observationDigest(
              [...merged].sort((a, b) => a.eventId.localeCompare(b.eventId)),
            ),
            calculatedAt: this.now().toISOString(),
          });
      if (report) {
        if (capture.limited) {
          report.issues = [...new Set([...report.issues, 'budget' as const])];
          report.segments = report.segments.map((segment) =>
            segment.id === capture.recorder.segmentId
              ? { ...segment, hasGap: true }
              : segment,
          );
        }
        const detailKeys = [
          'intervals',
          'unplaced',
          'incompleteActivities',
          'configurations',
          'usages',
          'segments',
        ] as const;
        while (
          new TextEncoder().encode(JSON.stringify(report)).byteLength >
          OBSERVATION_LIMITS.summaryBytes
        ) {
          const key = [...detailKeys].sort(
            (a, b) =>
              JSON.stringify(report![b]).length - JSON.stringify(report![a]).length,
          )[0]!;
          if (!report[key].length) throw new Error('归因最小摘要超过预算');
          report = {
            ...report,
            [key]: report[key].slice(0, Math.floor(report[key].length / 2)),
            issues: [...new Set([...report.issues, 'budget' as const])],
          };
        }
      }
      const payload = {
        schemaVersion: 1 as const,
        batchId: randomUUID(),
        executionId: capture.executionId,
        events,
        report,
      };
      const batch: ObservationBatch = {
        ...payload,
        digest: await observationDigest(payload),
      };
      await this.store.enqueue(namespace, capture.executionId, batch);
      if (report) {
        await this.store.saveHead(namespace, capture.executionId, report);
        capture.head = report;
      }
      const committed = new Set(events.map((event) => event.eventId));
      const consumed = capture.pending.filter((event) => committed.has(event.eventId));
      capture.pending = capture.pending.filter((event) => !committed.has(event.eventId));
      this.bufferedBytes -= consumed.reduce(
        (sum, event) => sum + new TextEncoder().encode(JSON.stringify(event)).byteLength,
        0,
      );
      if (merged.length > 4000) {
        capture.limited = true;
        const protectedEvents = merged.filter((event) =>
          [
            'execution.received',
            'delivery.accepted',
            'segment.opened',
            'segment.closed',
            'gap',
          ].includes(event.name),
        );
        capture.history = [
          ...new Map(
            [...protectedEvents.slice(-1000), ...merged.slice(-3000)].map((event) => [
              event.eventId,
              event,
            ]),
          ).values(),
        ];
      } else capture.history = merged;
    }
  }

  private async deliver(): Promise<void> {
    if (!this.session || this.now().getTime() < this.retryAt) return;
    const session = this.session;
    const connection = await this.state.loadConnection();
    if (!connection || new URL(connection.serverUrl).origin !== session.serverOrigin)
      return;
    const sessionKey = `${session.serverOrigin}:${connection.runnerId}:${session.credential}`;
    if (this.pausedSession === sessionKey) return;
    const namespace = await observationDigest({
      origin: session.serverOrigin,
      runnerId: connection.runnerId,
    });
    const rejected = new Set<string>();
    for (const entry of await this.store.pending(namespace)) {
      try {
        if (
          rejected.has(entry.batch.executionId) ||
          (await this.store.loss(namespace, entry.batch.executionId)).includes('rejected')
        ) {
          await this.store.discard(namespace, entry.batch);
          continue;
        }
        // Do not release the only durable copy before its local head commit is recoverable.
        if (
          entry.batch.report &&
          ((await this.store.head(namespace, entry.batch.executionId))?.revision ?? 0) <
            entry.batch.report.revision
        ) {
          try {
            await this.store.saveHead(
              namespace,
              entry.batch.executionId,
              entry.batch.report,
            );
          } catch {
            this.degrade();
            continue;
          }
        }
        const receipt = await this.transport.send(
          session,
          entry.batch,
          this.deliveryAbort.signal,
        );
        if (
          !receipt.accepted ||
          receipt.batchId !== entry.batch.batchId ||
          receipt.digest !== entry.batch.digest
        )
          throw new ObservationDeliveryError(409);
        await this.store.acknowledge(namespace, entry.batch);
        this.failures = 0;
      } catch (error) {
        if (this.stopping) return;
        this.degrade();
        if (
          error instanceof ObservationDeliveryError &&
          [400, 404, 409, 410, 413, 422].includes(error.status)
        ) {
          // Rejected diagnostics are not business failures; retain the failure in the local head.
          rejected.add(entry.batch.executionId);
          await this.store.discard(namespace, entry.batch);
          continue;
        }
        if (
          error instanceof ObservationDeliveryError &&
          [401, 403].includes(error.status)
        )
          this.pausedSession = sessionKey;
        this.failures++;
        this.retryAt =
          this.now().getTime() +
          (error instanceof ObservationDeliveryError && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : Math.min(300_000, 1000 * 2 ** Math.min(this.failures, 8)) *
              (0.8 + Math.random() * 0.4));
        break;
      }
    }
  }
}
