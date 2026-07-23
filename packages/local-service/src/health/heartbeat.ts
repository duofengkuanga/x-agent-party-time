import {
  ERROR_CODES,
  ServiceHeartbeatSchema,
  createAppError,
  type AppError,
  type HeartbeatRepository,
  type ServiceHeartbeat,
} from '@agent-party-time/shared';
import type { LockHandle } from '../lifecycle/instance-lock.js';
import type { Logger } from '../logging/logger.js';

export interface Clock {
  now(): Date;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
export const SYSTEM_CLOCK: Clock = {
  now: () => new Date(),
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) =>
    globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};
export interface HeartbeatOptions {
  instanceId: string;
  pid: number;
  version: string;
  intervalMs: number;
  staleAfterMs: number;
  clock: Clock;
  store: HeartbeatRepository;
  lock: LockHandle;
  logger: Logger;
  onOwnershipLost(error: AppError): void | Promise<void>;
}

export class HeartbeatService {
  private current: ServiceHeartbeat | null = null;
  private timer: unknown = null;
  private stopping = false;
  private inFlight: Promise<ServiceHeartbeat> | null = null;
  constructor(private readonly options: HeartbeatOptions) {}
  async start(): Promise<void> {
    if (this.timer) return;
    await this.beat();
    this.timer = this.options.clock.setInterval(() => {
      void this.beat().catch(async (error) => {
        this.options.logger.error(
          'heartbeat.failed',
          'heartbeat 更新失败',
          error,
        );
        if (
          (error as { code?: string }).code ===
          ERROR_CODES.instanceOwnershipLost
        )
          await this.options.onOwnershipLost(error as AppError);
      });
    }, this.options.intervalMs);
  }
  async beat(): Promise<ServiceHeartbeat> {
    if (this.stopping && this.current?.status === 'stopping')
      return this.current;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.performBeat();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }
  snapshot(): ServiceHeartbeat | null {
    return this.current;
  }
  isStale(snapshot: ServiceHeartbeat, now = this.options.clock.now()): boolean {
    return (
      now.getTime() - Date.parse(snapshot.lastBeatAt) >
      this.options.staleAfterMs
    );
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) this.options.clock.clearInterval(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight;
    if (this.current) {
      this.current = ServiceHeartbeatSchema.parse({
        ...this.current,
        status: 'stopping',
        sequence: this.current.sequence + 1,
        lastBeatAt: this.options.clock.now().toISOString(),
      });
      await this.options.store.write(this.current);
    }
  }
  private async performBeat(): Promise<ServiceHeartbeat> {
    await this.options.lock.assertOwner();
    const now = this.options.clock.now().toISOString();
    const snapshot = ServiceHeartbeatSchema.parse({
      instanceId: this.options.instanceId,
      pid: this.options.pid,
      version: this.options.version,
      startedAt: this.current?.startedAt ?? now,
      lastBeatAt: now,
      sequence: (this.current?.sequence ?? -1) + 1,
      status: this.current ? 'running' : 'starting',
    });
    await this.options.store.write(snapshot);
    await this.options.lock.refresh();
    this.current = snapshot;
    return snapshot;
  }
}
