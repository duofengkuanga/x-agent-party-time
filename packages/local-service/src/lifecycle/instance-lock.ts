import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  ERROR_CODES,
  createAppError,
  type HeartbeatRepository,
} from '@agent-party-time/shared';
import type { Logger } from '../logging/logger.js';

const TimestampSchema = z.string().datetime();
export const LockRecordSchema = z.object({
  instanceId: z.string().min(1),
  pid: z.number().int().positive(),
  nonce: z.string().min(1),
  dataDirectory: z.string().min(1),
  startedAt: TimestampSchema,
  lastRefreshedAt: TimestampSchema,
});
export type LockRecord = z.infer<typeof LockRecordSchema>;
export const LockInspectionSchema = z.object({
  record: LockRecordSchema.nullable(),
  processAlive: z.boolean(),
  heartbeatFresh: z.boolean(),
  canTakeOver: z.boolean(),
});
export type LockInspection = z.infer<typeof LockInspectionSchema>;
export interface LockHandle {
  readonly record: LockRecord;
  assertOwner(): Promise<void>;
  refresh(): Promise<void>;
  release(): Promise<void>;
}
export interface InstanceLockOptions {
  lockPath: string;
  dataDirectory: string;
  pid?: number;
  staleAfterMs: number;
  heartbeats?: HeartbeatRepository;
  logger: Logger;
  now?: () => Date;
}

export class InstanceLock {
  constructor(private readonly options: InstanceLockOptions) {}

  async acquire(instanceId = randomUUID()): Promise<LockHandle> {
    await mkdir(dirname(this.options.lockPath), {
      recursive: true,
      mode: 0o700,
    });
    const now = (this.options.now ?? (() => new Date()))().toISOString();
    const record = LockRecordSchema.parse({
      instanceId,
      pid: this.options.pid ?? process.pid,
      nonce: randomUUID(),
      dataDirectory: this.options.dataDirectory,
      startedAt: now,
      lastRefreshedAt: now,
    });
    try {
      await this.createExclusive(record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const inspection = await this.inspect();
      if (!inspection.canTakeOver)
        throw createAppError({
          code: ERROR_CODES.instanceAlreadyRunning,
          category: 'conflict',
          message: '该数据目录已有服务实例运行',
          retryable: false,
          details: {
            instanceId: inspection.record?.instanceId ?? null,
            pid: inspection.record?.pid ?? null,
          },
        });
      const stalePath = `${this.options.lockPath}.stale.${randomUUID()}`;
      await rename(this.options.lockPath, stalePath);
      await unlink(stalePath).catch(() => undefined);
      await this.createExclusive(record);
    }
    return new FileLockHandle(this.options, record);
  }

  async inspect(): Promise<LockInspection> {
    let record: LockRecord | null = null;
    try {
      record = LockRecordSchema.parse(
        JSON.parse(await readFile(this.options.lockPath, 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.options.logger.warn('lock.invalid', '锁文件无效，将按 stale 处理');
    }
    if (!record)
      return {
        record: null,
        processAlive: false,
        heartbeatFresh: false,
        canTakeOver: true,
      };
    let processAlive = true;
    try {
      process.kill(record.pid, 0);
    } catch {
      processAlive = false;
    }
    const heartbeat = await this.options.heartbeats?.get(record.instanceId);
    const heartbeatFresh = Boolean(
      heartbeat &&
      Date.now() - Date.parse(heartbeat.lastBeatAt) <=
        this.options.staleAfterMs,
    );
    return LockInspectionSchema.parse({
      record,
      processAlive,
      heartbeatFresh,
      canTakeOver: !processAlive && !heartbeatFresh,
    });
  }

  private async createExclusive(record: LockRecord): Promise<void> {
    const handle = await open(this.options.lockPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

class FileLockHandle implements LockHandle {
  constructor(
    private readonly options: InstanceLockOptions,
    public record: LockRecord,
  ) {}
  async assertOwner(): Promise<void> {
    const current = await this.read();
    if (
      !current ||
      current.instanceId !== this.record.instanceId ||
      current.nonce !== this.record.nonce ||
      current.dataDirectory !== this.record.dataDirectory
    )
      throw this.lost();
  }
  async refresh(): Promise<void> {
    await this.assertOwner();
    this.record = LockRecordSchema.parse({
      ...this.record,
      lastRefreshedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    });
    const handle = await open(this.options.lockPath, 'w', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(this.record)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async release(): Promise<void> {
    await this.assertOwner();
    await unlink(this.options.lockPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  private async read(): Promise<LockRecord | null> {
    try {
      return LockRecordSchema.parse(
        JSON.parse(await readFile(this.options.lockPath, 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  private lost() {
    return createAppError({
      code: ERROR_CODES.instanceOwnershipLost,
      category: 'conflict',
      message: '服务实例已失去数据目录所有权',
      retryable: false,
    });
  }
}
