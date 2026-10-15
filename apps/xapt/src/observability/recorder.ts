import { randomUUID } from 'node:crypto';
import {
  ObservationEventSchema,
  OBSERVATION_LIMITS,
  type ObservationEvent,
  type ObservationPhase,
} from '@agent-party-time/execution-contract/observability';

export type ObservationFields = Omit<
  ObservationEvent,
  | 'schemaVersion'
  | 'eventId'
  | 'executionId'
  | 'segmentId'
  | 'sequence'
  | 'observedAt'
  | 'observedElapsedMs'
>;
export type ObservationClock = { wall(): Date; monotonic(): number };
export type ObservationSink = (event: ObservationEvent) => void;

/** A failure in diagnostics must never throw into the execution it observes. */
export class ExecutionObservation {
  readonly segmentId = randomUUID();
  private sequence = 0;
  private readonly started: number;
  private dropped = false;

  constructor(
    readonly executionId: string,
    private readonly sink: ObservationSink,
    private readonly clock: ObservationClock = {
      wall: () => new Date(),
      monotonic: () => performance.now(),
    },
  ) {
    this.started = clock.monotonic();
    this.record({ name: 'segment.opened', source: 'xapt' });
    this.record({
      name: 'capability.observed',
      source: 'xapt',
      configuration: { clockSleep: 'unknown', items: 'unknown' },
    });
  }

  record(fields: ObservationFields): void {
    try {
      const parsed = ObservationEventSchema.safeParse({
        ...fields,
        schemaVersion: 1,
        eventId: randomUUID(),
        executionId: this.executionId,
        segmentId: this.segmentId,
        sequence: ++this.sequence,
        observedAt: this.clock.wall().toISOString(),
        observedElapsedMs: Math.max(0, this.clock.monotonic() - this.started),
      });
      if (
        !parsed.success ||
        new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength >
          OBSERVATION_LIMITS.eventBytes
      ) {
        this.dropped = true;
        return;
      }
      this.sink(parsed.data);
    } catch {
      this.dropped = true;
    }
  }

  async phase<T>(phase: ObservationPhase, operation: () => Promise<T>): Promise<T> {
    const intervalId = randomUUID();
    this.record({
      name: 'phase.started',
      source: 'xapt',
      phase,
      correlation: { intervalId },
    });
    try {
      const result = await operation();
      this.record({
        name: 'phase.finished',
        source: 'xapt',
        phase,
        correlation: { intervalId },
        status: 'succeeded',
      });
      return result;
    } catch (error) {
      this.record({
        name: 'phase.finished',
        source: 'xapt',
        phase,
        correlation: { intervalId },
        status: 'failed',
      });
      throw error;
    }
  }

  close(): void {
    if (this.dropped)
      this.record({ name: 'gap', source: 'xapt', reason: 'recording_gap' });
    this.record({ name: 'segment.closed', source: 'xapt' });
  }
}
