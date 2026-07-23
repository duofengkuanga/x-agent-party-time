import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WakeJobSchema, type WakeJob } from '@agent-party-time/shared';
import type { Clock } from '../health/heartbeat.js';
import type { Logger } from '../logging/logger.js';
import { SqliteStateStore } from './state-store.js';

const NOW = new Date('2026-07-21T00:00:00.000Z');
const clock: Clock = {
  now: () => new Date(NOW),
  setInterval: () => 0,
  clearInterval: () => undefined,
};
const logger: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child() {
    return this;
  },
  flush: async () => undefined,
  close: async () => undefined,
};

describe('SqliteStateStore job lifecycle', () => {
  let directory: string | null = null;
  let store: SqliteStateStore | null = null;

  afterEach(async () => {
    await store?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    store = null;
    directory = null;
  });

  test('persists enqueue and lease events with real resumable cursors', async () => {
    directory = await mkdtemp(join(tmpdir(), 'apt-store-'));
    store = await SqliteStateStore.open({
      databasePath: join(directory, 'state.sqlite'),
      logger,
      clock,
    });
    const job: WakeJob = WakeJobSchema.parse({
      id: 'job-1',
      idempotencyKey: 'manual:job-1',
      triggerKind: 'manual',
      agentId: 'agent-1',
      sessionKey: 'session-1',
      taskId: null,
      sourceRef: 'run the job',
      priority: 10,
      state: 'queued',
      attemptCount: 0,
      maxAttempts: 2,
      lease: null,
      nextAttemptAt: null,
      deadlineAt: '2026-07-21T01:00:00.000Z',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });

    await store.jobs.enqueue(job);
    await store.jobs.enqueue({ ...job, id: 'duplicate-id' });
    const first = await store.events.readAfter(null, 1);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.event.name).toBe('job.queued');
    expect(first.nextCursor).toBe(first.items[0]?.cursor);

    const leased = await store.leaseNextJob({
      ownerInstanceId: 'instance-1',
      now: NOW.toISOString(),
      expiresAt: '2026-07-21T00:01:00.000Z',
      excludedSessionKeys: [],
      excludedWorkspacePaths: [],
    });
    expect(leased?.job.state).toBe('running');
    expect(leased?.job.attemptCount).toBe(1);

    const rest = await store.events.readAfter(first.nextCursor, 10);
    expect(rest.items.map((item) => item.event.name)).toEqual([
      'job.leased',
      'run.started',
    ]);
    expect(rest.items.map((item) => Number(item.cursor))).toEqual([2, 3]);
    expect(rest.nextCursor).toBe('3');
  });
});
