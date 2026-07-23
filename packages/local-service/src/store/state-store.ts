import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Database, type Statement } from 'bun:sqlite';
import { z } from 'zod';
import {
  ChannelCursorSchema,
  CompleteRunInputSchema,
  CreateTaskEffectSchema,
  DurableEventSchema,
  ERROR_CODES,
  EVENT_NAMES,
  PROTOCOL_VERSION,
  IngestMessageInputSchema,
  IngestMessageResultSchema,
  LeaseNextJobInputSchema,
  LeasedJobResultSchema,
  OutboxEntrySchema,
  RunRecordSchema,
  ServiceHeartbeatSchema,
  SessionRecordSchema,
  StoredEventSchema,
  TaskEventSchema,
  TaskMutationEffectSchema,
  TaskRecordSchema,
  WakeJobSchema,
  SquadSchema,
  TeamLineageSchema,
  createAppError,
  normalizeError,
  type AppError,
  type ChannelCursor,
  type CompleteRunInput,
  type CreateTaskEffect,
  type DurableEvent,
  type EventRepository,
  type HeartbeatRepository,
  type IngestMessageInput,
  type IngestMessageResult,
  type JobFilter,
  type JobRepository,
  type Lease,
  type LeaseNextJobInput,
  type LeasedJobResult,
  type OutboxEntry,
  type OutboxRepository,
  type PageRequest,
  type PageResult,
  type RunFilter,
  type RunRecord,
  type RunRepository,
  type ServiceHeartbeat,
  type SessionFilter,
  type SessionRecord,
  type SessionRepository,
  type StateStore,
  type TaskFilter,
  type TaskMutationEffect,
  type TaskRecord,
  type TaskRepository,
  type WakeJob,
  type WakeJobState,
  type Squad,
  type TeamLineage,
  type TeamRepository,
  WakeSourceContextSchema,
  type WakeSourceContext,
} from '@agent-party-time/shared';
import type { Clock } from '../health/heartbeat.js';
import type { Logger } from '../logging/logger.js';

export interface Migration {
  version: number;
  sql: string;
}
export interface SqliteStateStoreOptions {
  databasePath: string;
  migrations?: readonly Migration[];
  logger: Logger;
  clock: Clock;
  busyTimeoutMs?: number;
}
type Row = Record<string, unknown>;

function cursorOffset(cursor?: string): number {
  if (!cursor) return 0;
  const value = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  return Number.isInteger(value) && value >= 0 ? value : 0;
}
function nextCursor(
  offset: number,
  count: number,
  limit: number,
): string | null {
  return count === limit
    ? Buffer.from(String(offset + count)).toString('base64url')
    : null;
}
function parseJson(value: unknown): unknown {
  return value == null ? null : JSON.parse(String(value));
}

export class SqliteStateStore implements StateStore {
  readonly sessions: SessionRepository;
  readonly tasks: TaskRepository;
  readonly jobs: JobRepository;
  readonly runs: RunRepository;
  readonly cursors: {
    get(subscriptionId: string): Promise<ChannelCursor | null>;
  };
  readonly outbox: OutboxRepository;
  readonly events: EventRepository;
  readonly heartbeats: HeartbeatRepository;
  readonly teams: TeamRepository;
  private closed = false;

  private constructor(
    private readonly db: Database,
    private readonly options: SqliteStateStoreOptions,
  ) {
    this.sessions = this.buildSessionRepository();
    this.tasks = this.buildTaskRepository();
    this.jobs = this.buildJobRepository();
    this.runs = this.buildRunRepository();
    this.cursors = {
      get: async (id) =>
        this.mapCursor(
          this.get(
            'SELECT * FROM channel_cursor WHERE subscription_id = ?',
            id,
          ),
        ),
    };
    this.outbox = this.buildOutboxRepository();
    this.events = this.buildEventRepository();
    this.heartbeats = this.buildHeartbeatRepository();
    this.teams = this.buildTeamRepository();
  }

  static async open(
    options: SqliteStateStoreOptions,
  ): Promise<SqliteStateStore> {
    await mkdir(dirname(options.databasePath), {
      recursive: true,
      mode: 0o700,
    });
    const db = new Database(options.databasePath, { create: true });
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(
      `PRAGMA busy_timeout = ${Math.max(0, options.busyTimeoutMs ?? 5_000)}`,
    );
    db.exec('PRAGMA journal_mode = WAL');
    const schema = await readFile(
      new URL('./schema.sql', import.meta.url),
      'utf8',
    );
    db.exec(schema);
    for (const migration of [...(options.migrations ?? [])].sort(
      (a, b) => a.version - b.version,
    )) {
      const exists = db
        .prepare('SELECT 1 FROM schema_migration WHERE version = ?')
        .get(migration.version);
      if (!exists) {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec(migration.sql);
          db.prepare(
            'INSERT INTO schema_migration(version, applied_at) VALUES (?, ?)',
          ).run(migration.version, options.clock.now().toISOString());
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
    }
    return new SqliteStateStore(db, options);
  }

  async integrityCheck(): Promise<void> {
    const row = this.get('PRAGMA integrity_check');
    if (!row || !Object.values(row).includes('ok'))
      throw createAppError({
        code: ERROR_CODES.storeInvariantViolation,
        category: 'invariant',
        message: 'SQLite integrity check failed',
        retryable: false,
      });
  }
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }

  async ingestMessage(raw: IngestMessageInput): Promise<IngestMessageResult> {
    const input = IngestMessageInputSchema.parse(raw);
    return this.transaction(() => {
      const existing = this.get(
        'SELECT * FROM ingested_message WHERE subscription_id = ? AND (source_seq = ? OR (? IS NOT NULL AND source_event_id = ?)) LIMIT 1',
        input.message.channel.subscriptionId,
        input.message.sourceSeq,
        input.message.sourceEventId ?? null,
        input.message.sourceEventId ?? null,
      );
      if (existing) {
        const cursor =
          this.mapCursor(
            this.get(
              'SELECT * FROM channel_cursor WHERE subscription_id = ?',
              input.message.channel.subscriptionId,
            ),
          ) ?? input.nextCursor;
        const job = existing.wake_job_id
          ? this.mapJob(
              this.get(
                'SELECT * FROM wake_job WHERE id = ?',
                existing.wake_job_id,
              ),
            )
          : null;
        return IngestMessageResultSchema.parse({
          duplicate: true,
          job,
          cursor,
        });
      }
      this.run(
        'INSERT INTO ingested_message(subscription_id, channel_key, source_seq, source_event_id, sender_id, received_at, message_text, thread_key, wake_job_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        input.message.channel.subscriptionId,
        input.message.channel.channelKey,
        input.message.sourceSeq,
        input.message.sourceEventId ?? null,
        input.message.sender.id,
        input.message.receivedAt,
        input.message.text,
        input.message.channel.threadKey ?? null,
        input.wakeJob?.id ?? null,
      );
      this.upsertCursor(input.nextCursor);
      const job = input.wakeJob
        ? this.insertJobOrExisting(input.wakeJob)
        : null;
      this.appendEvent(input.event);
      return IngestMessageResultSchema.parse({
        duplicate: false,
        job,
        cursor: input.nextCursor,
      });
    });
  }

  async leaseNextJob(raw: LeaseNextJobInput): Promise<LeasedJobResult | null> {
    const input = LeaseNextJobInputSchema.parse(raw);
    return this.transaction(() => {
      const rows = this.all(
        "SELECT * FROM wake_job WHERE state IN ('queued','retry_wait') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND deadline_at > ? ORDER BY priority DESC, created_at ASC, id ASC",
        input.now,
        input.now,
      );
      const candidate = rows
        .map((row) => this.mapJob(row)!)
        .find((job) => {
          if (input.excludedSessionKeys.includes(job.sessionKey)) return false;
          const session = this.mapSession(
            this.get(
              "SELECT * FROM session WHERE key=? AND status IN ('pending','active') ORDER BY generation DESC LIMIT 1",
              job.sessionKey,
            ),
          );
          return (
            !session ||
            !input.excludedWorkspacePaths.includes(session.workspacePath)
          );
        });
      if (!candidate) return null;
      const generation = (candidate.lease?.generation ?? 0) + 1;
      const attempt = candidate.attemptCount + 1;
      const change = this.run(
        "UPDATE wake_job SET state='running', attempt_count=?, lease_owner_instance_id=?, lease_generation=?, lease_acquired_at=?, lease_expires_at=?, updated_at=? WHERE id=? AND state IN ('queued','retry_wait')",
        attempt,
        input.ownerInstanceId,
        generation,
        input.now,
        input.expiresAt,
        input.now,
        candidate.id,
      );
      if (Number(change.changes) !== 1) return null;
      const run: RunRecord = RunRecordSchema.parse({
        id: randomUUID(),
        jobId: candidate.id,
        attempt,
        leaseGeneration: generation,
        runnerName: 'codex',
        state: 'running',
        startedAt: input.now,
        finishedAt: null,
        resultSummary: null,
        error: null,
        usage: null,
      });
      this.insertRun(run);
      const job = this.mapJob(
        this.get('SELECT * FROM wake_job WHERE id = ?', candidate.id),
      )!;
      this.appendEvent(
        DurableEventSchema.parse({
          schema: PROTOCOL_VERSION,
          id: randomUUID(),
          name: EVENT_NAMES.jobLeased,
          occurredAt: input.now,
          correlationId: job.idempotencyKey,
          causationId: null,
          payload: { jobId: job.id, runId: run.id },
        }),
      );
      this.appendEvent(
        DurableEventSchema.parse({
          schema: PROTOCOL_VERSION,
          id: randomUUID(),
          name: EVENT_NAMES.runStarted,
          occurredAt: input.now,
          correlationId: job.idempotencyKey,
          causationId: null,
          payload: { runId: run.id, jobId: job.id, taskId: job.taskId },
        }),
      );
      return LeasedJobResultSchema.parse({ job, run });
    });
  }

  async renewJobLease(
    jobId: string,
    ownerInstanceId: string,
    generation: number,
    expiresAt: string,
  ): Promise<Lease> {
    const now = this.options.clock.now().toISOString();
    const result = this.run(
      "UPDATE wake_job SET lease_expires_at=?, updated_at=? WHERE id=? AND state='running' AND lease_owner_instance_id=? AND lease_generation=?",
      expiresAt,
      now,
      jobId,
      ownerInstanceId,
      generation,
    );
    if (Number(result.changes) !== 1)
      throw createAppError({
        code: ERROR_CODES.jobLeaseLost,
        category: 'conflict',
        message: 'job lease 已失效',
        retryable: false,
      });
    const job = await this.jobs.get(jobId);
    return job!.lease!;
  }

  async getWakeSource(jobId: string): Promise<WakeSourceContext> {
    const job = await this.jobs.get(jobId);
    if (!job) throw this.notFound('job');
    if (job.triggerKind === 'channel_message') {
      const row = this.get(
        'SELECT * FROM ingested_message WHERE wake_job_id=? LIMIT 1',
        jobId,
      );
      if (row)
        return WakeSourceContextSchema.parse({
          instructions: row.message_text,
          subscriptionId: row.subscription_id,
          channelKey: row.channel_key,
          threadKey: row.thread_key,
          messageAnchor: {
            channelKey: row.channel_key,
            sourceSeq: row.source_seq,
            ...(row.source_event_id ? { eventId: row.source_event_id } : {}),
          },
        });
    }
    if (job.taskId) {
      const task = await this.tasks.get(job.taskId);
      if (task)
        return WakeSourceContextSchema.parse({
          instructions: `${task.title}\n\n${task.description}`.trim(),
          subscriptionId: null,
          channelKey: task.anchors[0]?.channelKey ?? 'task-ledger',
          threadKey: null,
          messageAnchor: task.anchors[0] ?? null,
        });
    }
    return WakeSourceContextSchema.parse({
      instructions: job.sourceRef,
      subscriptionId: null,
      channelKey: job.triggerKind === 'worker' ? job.sessionKey : 'manual',
      threadKey: null,
      messageAnchor: null,
    });
  }

  async completeRun(raw: CompleteRunInput): Promise<void> {
    const input = CompleteRunInputSchema.parse(raw);
    this.transaction(() => {
      const job = this.mapJob(
        this.get('SELECT * FROM wake_job WHERE id = ?', input.jobId),
      );
      if (
        !job ||
        job.lease?.ownerInstanceId !== input.leaseOwnerInstanceId ||
        job.lease.generation !== input.leaseGeneration
      )
        throw createAppError({
          code: ERROR_CODES.jobLeaseLost,
          category: 'conflict',
          message: '完成 run 时 lease 已失效',
          retryable: false,
        });
      const now = this.options.clock.now().toISOString();
      const runState =
        input.result.status === 'succeeded' ? 'succeeded' : input.result.status;
      const summary =
        input.result.status === 'succeeded'
          ? input.result.finalText.slice(0, 10_000)
          : null;
      const error =
        input.result.status === 'succeeded' ? null : input.result.error;
      const usage =
        input.result.status === 'succeeded' ? input.result.usage : null;
      this.run(
        'UPDATE run_attempt SET state=?, finished_at=?, result_summary=?, error_json=?, usage_json=? WHERE id=? AND job_id=?',
        runState,
        now,
        summary,
        error ? JSON.stringify(error) : null,
        usage ? JSON.stringify(usage) : null,
        input.runId,
        input.jobId,
      );
      if (input.result.sessionUpdate) {
        const session = this.mapSession(
          this.get(
            "SELECT * FROM session WHERE key=? AND status IN ('pending','active') ORDER BY generation DESC LIMIT 1",
            input.result.sessionUpdate.sessionKey,
          ),
        );
        if (
          !session ||
          session.revision !== input.result.sessionUpdate.expectedRevision
        )
          throw createAppError({
            code: ERROR_CODES.storeConstraintConflict,
            category: 'conflict',
            message: 'session revision conflict',
            retryable: false,
          });
        this.run(
          "UPDATE session SET codex_thread_id=?, status='active', revision=revision+1, updated_at=? WHERE key=? AND generation=? AND revision=?",
          input.result.sessionUpdate.codexThreadId,
          now,
          session.key,
          session.generation,
          session.revision,
        );
      }
      if (input.taskMutation) this.applyTaskMutation(input.taskMutation);
      if (input.outboxEntry) this.insertOutbox(input.outboxEntry);
      let jobState: WakeJobState =
        input.result.status === 'succeeded'
          ? 'succeeded'
          : input.result.status === 'cancelled'
            ? 'cancelled'
            : 'failed';
      let nextAttemptAt: string | null = null;
      if (
        input.result.status === 'failed' &&
        input.result.error.retryable &&
        job.attemptCount < job.maxAttempts &&
        input.retryNextAttemptAt &&
        Date.parse(job.deadlineAt) > this.options.clock.now().getTime()
      ) {
        jobState = 'retry_wait';
        nextAttemptAt = input.retryNextAttemptAt;
      }
      this.run(
        'UPDATE wake_job SET state=?, next_attempt_at=?, lease_owner_instance_id=NULL, lease_generation=NULL, lease_acquired_at=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?',
        jobState,
        nextAttemptAt,
        now,
        input.jobId,
      );
      for (const event of input.events) this.appendEvent(event);
    });
  }

  async createTask(raw: CreateTaskEffect): Promise<TaskRecord> {
    const input = CreateTaskEffectSchema.parse(raw);
    return this.transaction(() => {
      this.insertTask(input.task);
      this.insertTaskEvent(input.event);
      if (input.wakeJob) this.insertJobOrExisting(input.wakeJob);
      this.appendEvent(input.durableEvent);
      return input.task;
    });
  }
  async mutateTask(raw: TaskMutationEffect): Promise<TaskRecord> {
    const input = TaskMutationEffectSchema.parse(raw);
    return this.transaction(() => this.applyTaskMutation(input));
  }
  async retryJob(jobId: string, now: string): Promise<WakeJob> {
    const result = this.run(
      "UPDATE wake_job SET state='retry_wait', next_attempt_at=?, updated_at=? WHERE id=? AND state IN ('failed','cancelled')",
      now,
      now,
      jobId,
    );
    if (Number(result.changes) !== 1)
      throw createAppError({
        code: ERROR_CODES.storeConstraintConflict,
        category: 'conflict',
        message: 'job 当前不可重试',
        retryable: false,
      });
    return (await this.jobs.get(jobId))!;
  }
  async createWorker(
    lineage: TeamLineage,
    job: WakeJob,
    event: DurableEvent,
  ): Promise<void> {
    this.transaction(() => {
      const value = TeamLineageSchema.parse(lineage);
      this.run(
        'INSERT INTO team_lineage(worker_agent_id,team_id,root_agent_id,parent_agent_id,role,depth,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)',
        value.workerAgentId,
        value.teamId,
        value.rootAgentId,
        value.parentAgentId,
        value.role,
        value.depth,
        value.expiresAt,
        value.createdAt,
      );
      this.insertJobOrExisting(WakeJobSchema.parse(job));
      this.appendEvent(DurableEventSchema.parse(event));
    });
  }

  async leaseNextOutboxEntry(
    ownerInstanceId: string,
    now: string,
    expiresAt: string,
  ): Promise<OutboxEntry | null> {
    return this.transaction(() => {
      const row = this.get(
        "SELECT * FROM reply_outbox WHERE (state='pending' OR (state='retry_wait' AND next_attempt_at<=?) OR (state='sending' AND lease_expires_at<?)) ORDER BY created_at ASC LIMIT 1",
        now,
        now,
      );
      const entry = this.mapOutbox(row);
      if (!entry) return null;
      const generation = (entry.lease?.generation ?? 0) + 1;
      const changed = this.run(
        "UPDATE reply_outbox SET state='sending', lease_owner_instance_id=?, lease_generation=?, lease_acquired_at=?, lease_expires_at=?, updated_at=? WHERE id=?",
        ownerInstanceId,
        generation,
        now,
        expiresAt,
        now,
        entry.id,
      );
      return Number(changed.changes) === 1
        ? this.mapOutbox(
            this.get('SELECT * FROM reply_outbox WHERE id=?', entry.id),
          )
        : null;
    });
  }
  async acknowledgeOutbox(
    entryId: string,
    leaseGeneration: number,
    providerMessageId: string,
    deliveredAt: string,
  ): Promise<OutboxEntry> {
    return this.transaction(() => {
      const current = this.mapOutbox(
        this.get('SELECT * FROM reply_outbox WHERE id=?', entryId),
      );
      if (!current) throw this.notFound('outbox entry');
      const changed = this.run(
        "UPDATE reply_outbox SET state='delivered', provider_message_id=?, lease_owner_instance_id=NULL, lease_generation=NULL, lease_acquired_at=NULL, lease_expires_at=NULL, updated_at=? WHERE id=? AND state='sending' AND lease_generation=?",
        providerMessageId,
        deliveredAt,
        entryId,
        leaseGeneration,
      );
      if (Number(changed.changes) !== 1) throw this.outboxLeaseLost();
      this.appendEvent(
        DurableEventSchema.parse({
          schema: PROTOCOL_VERSION,
          id: randomUUID(),
          name: EVENT_NAMES.replyDelivered,
          occurredAt: deliveredAt,
          correlationId: current.runId,
          causationId: null,
          payload: {
            outboxEntryId: entryId,
            runId: current.runId,
            providerMessageId,
          },
        }),
      );
      return this.mapOutbox(
        this.get('SELECT * FROM reply_outbox WHERE id=?', entryId),
      )!;
    });
  }
  async failOutboxAttempt(
    entryId: string,
    leaseGeneration: number,
    error: AppError,
    nextAttemptAt: string | null,
  ): Promise<OutboxEntry> {
    return this.transaction(() => {
      const current = this.mapOutbox(
        this.get('SELECT * FROM reply_outbox WHERE id=?', entryId),
      );
      if (!current) throw this.notFound('outbox entry');
      const now = this.options.clock.now().toISOString();
      const state = nextAttemptAt ? 'retry_wait' : 'failed';
      const changed = this.run(
        'UPDATE reply_outbox SET state=?, attempt_count=attempt_count+1, next_attempt_at=?, last_error_json=?, lease_owner_instance_id=NULL, lease_generation=NULL, lease_acquired_at=NULL, lease_expires_at=NULL, updated_at=? WHERE id=? AND lease_generation=?',
        state,
        nextAttemptAt,
        JSON.stringify(error),
        now,
        entryId,
        leaseGeneration,
      );
      if (Number(changed.changes) !== 1) throw this.outboxLeaseLost();
      const event = nextAttemptAt
        ? DurableEventSchema.parse({
            schema: PROTOCOL_VERSION,
            id: randomUUID(),
            name: EVENT_NAMES.replyRetryScheduled,
            occurredAt: now,
            correlationId: current.runId,
            causationId: null,
            payload: {
              outboxEntryId: entryId,
              runId: current.runId,
              nextAttemptAt,
            },
          })
        : DurableEventSchema.parse({
            schema: PROTOCOL_VERSION,
            id: randomUUID(),
            name: EVENT_NAMES.replyFailed,
            occurredAt: now,
            correlationId: current.runId,
            causationId: null,
            payload: { outboxEntryId: entryId, runId: current.runId, error },
          });
      this.appendEvent(event);
      return this.mapOutbox(
        this.get('SELECT * FROM reply_outbox WHERE id=?', entryId),
      )!;
    });
  }

  private buildSessionRepository(): SessionRepository {
    return {
      get: async (key) =>
        this.mapSession(
          this.get(
            "SELECT * FROM session WHERE key=? ORDER BY CASE WHEN status IN ('pending','active') THEN 0 ELSE 1 END, generation DESC LIMIT 1",
            key,
          ),
        ),
      list: async (filter, page) =>
        this.page(
          this.all('SELECT * FROM session ORDER BY updated_at DESC'),
          (row) => this.mapSession(row)!,
          (item) =>
            (!filter.agentId || item.agentId === filter.agentId) &&
            (!filter.channelKey || item.channelKey === filter.channelKey) &&
            (!filter.status || item.status === filter.status),
          page,
        ),
      create: async (record) => {
        const parsed = SessionRecordSchema.parse(record);
        this.run(
          'INSERT INTO session(key,generation,agent_id,channel_key,workspace_path,codex_thread_id,status,invalidated_reason,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          parsed.key,
          parsed.generation,
          parsed.agentId,
          parsed.channelKey,
          parsed.workspacePath,
          parsed.codexThreadId,
          parsed.status,
          parsed.invalidatedReason,
          parsed.revision,
          parsed.createdAt,
          parsed.updatedAt,
        );
        return parsed;
      },
      update: async (record, expected) => {
        const parsed = SessionRecordSchema.parse(record);
        const changed = this.run(
          'UPDATE session SET codex_thread_id=?, status=?, invalidated_reason=?, revision=?, updated_at=? WHERE key=? AND generation=? AND revision=?',
          parsed.codexThreadId,
          parsed.status,
          parsed.invalidatedReason,
          parsed.revision,
          parsed.updatedAt,
          parsed.key,
          parsed.generation,
          expected,
        );
        if (Number(changed.changes) !== 1) throw this.revisionError('session');
        return parsed;
      },
      invalidate: async (key, reason, expected) => {
        const current = await this.sessions.get(key);
        if (!current) throw this.notFound('session');
        const next = SessionRecordSchema.parse({
          ...current,
          status: 'invalidated',
          invalidatedReason: reason,
          revision: expected + 1,
          updatedAt: this.options.clock.now().toISOString(),
        });
        return this.sessions.update(next, expected);
      },
    };
  }

  private buildTaskRepository(): TaskRepository {
    return {
      get: async (id) =>
        this.mapTask(this.get('SELECT * FROM task WHERE id=?', id)),
      findByAnchor: async (anchor) => {
        const row = this.get(
          'SELECT t.* FROM task t JOIN task_anchor a ON a.task_id=t.id WHERE a.channel_key=? AND a.source_seq=?',
          anchor.channelKey,
          anchor.sourceSeq,
        );
        return this.mapTask(row);
      },
      list: async (filter, page) =>
        this.page(
          this.all('SELECT * FROM task ORDER BY updated_at DESC'),
          (row) => this.mapTask(row)!,
          (item) =>
            (!filter.state || item.state === filter.state) &&
            (!filter.priority || item.priority === filter.priority) &&
            (filter.parentTaskId === undefined ||
              item.parentTaskId === filter.parentTaskId) &&
            (filter.assignee === undefined ||
              JSON.stringify(item.assignee) ===
                JSON.stringify(filter.assignee)),
          page,
        ),
      listEvents: async (taskId, page) =>
        this.page(
          this.all(
            'SELECT * FROM task_event WHERE task_id=? ORDER BY next_revision ASC',
            taskId,
          ),
          (row) =>
            TaskEventSchema.parse({
              id: row.id,
              taskId: row.task_id,
              type: row.type,
              actor: parseJson(row.actor_json),
              previousRevision: row.previous_revision,
              nextRevision: row.next_revision,
              reason: row.reason ?? undefined,
              payload: parseJson(row.payload_json),
              createdAt: row.created_at,
            }),
          () => true,
          page,
        ),
    };
  }

  private buildJobRepository(): JobRepository {
    return {
      get: async (id) =>
        this.mapJob(this.get('SELECT * FROM wake_job WHERE id=?', id)),
      findByIdempotencyKey: async (key) =>
        this.mapJob(
          this.get('SELECT * FROM wake_job WHERE idempotency_key=?', key),
        ),
      list: async (filter, page) =>
        this.page(
          this.all('SELECT * FROM wake_job ORDER BY created_at DESC'),
          (row) => this.mapJob(row)!,
          (item) =>
            (!filter.state || item.state === filter.state) &&
            (!filter.agentId || item.agentId === filter.agentId) &&
            (!filter.sessionKey || item.sessionKey === filter.sessionKey) &&
            (filter.taskId === undefined || item.taskId === filter.taskId),
          page,
        ),
      enqueue: async (job) =>
        this.transaction(() =>
          this.insertJobOrExisting(WakeJobSchema.parse(job)),
        ),
      cancel: async (id, expectedState) => {
        const condition = expectedState ? ' AND state=?' : '';
        const args: unknown[] = [
          this.options.clock.now().toISOString(),
          id,
          ...(expectedState ? [expectedState] : []),
        ];
        const changed = this.run(
          `UPDATE wake_job SET state='cancelled', updated_at=?, lease_owner_instance_id=NULL, lease_generation=NULL, lease_acquired_at=NULL, lease_expires_at=NULL WHERE id=?${condition}`,
          ...args,
        );
        if (Number(changed.changes) !== 1) throw this.revisionError('job');
        return (await this.jobs.get(id))!;
      },
      countByState: async () =>
        this.countStates('wake_job', [
          'queued',
          'leased',
          'running',
          'retry_wait',
          'succeeded',
          'failed',
          'cancelled',
        ]) as Record<WakeJobState, number>,
    };
  }
  private buildRunRepository(): RunRepository {
    return {
      get: async (id) =>
        this.mapRun(this.get('SELECT * FROM run_attempt WHERE id=?', id)),
      list: async (filter, page) => {
        const rows = this.all(
          "SELECT r.*, j.agent_id AS job_agent_id, j.task_id AS job_task_id, s.channel_key AS session_channel_key FROM run_attempt r JOIN wake_job j ON j.id=r.job_id LEFT JOIN session s ON s.key=j.session_key AND s.status IN ('pending','active') ORDER BY r.started_at DESC",
        ).filter(
          (row) =>
            (!filter.agentId || row.job_agent_id === filter.agentId) &&
            (!filter.channelKey ||
              row.session_channel_key === filter.channelKey) &&
            (filter.taskId === undefined || row.job_task_id === filter.taskId),
        );
        return this.page(
          rows,
          (row) => this.mapRun(row)!,
          (item) =>
            (!filter.jobId || item.jobId === filter.jobId) &&
            (!filter.state || item.state === filter.state),
          page,
        );
      },
      listByJob: async (id) =>
        this.all(
          'SELECT * FROM run_attempt WHERE job_id=? ORDER BY attempt ASC',
          id,
        ).map((row) => this.mapRun(row)!),
    };
  }
  private buildOutboxRepository(): OutboxRepository {
    return {
      get: async (id) =>
        this.mapOutbox(this.get('SELECT * FROM reply_outbox WHERE id=?', id)),
      listDue: async (now, limit) =>
        this.all(
          "SELECT * FROM reply_outbox WHERE state='pending' OR (state='retry_wait' AND next_attempt_at<=?) ORDER BY created_at ASC LIMIT ?",
          now,
          limit,
        ).map((row) => this.mapOutbox(row)!),
      listByRun: async (runId) =>
        this.all(
          'SELECT * FROM reply_outbox WHERE run_id=? ORDER BY created_at ASC',
          runId,
        ).map((row) => this.mapOutbox(row)!),
      countByState: async () =>
        this.countStates('reply_outbox', [
          'pending',
          'sending',
          'retry_wait',
          'delivered',
          'failed',
        ]) as Record<OutboxEntry['state'], number>,
    };
  }
  private buildEventRepository(): EventRepository {
    return {
      readAfter: async (cursor, limit) => {
        const offset = cursor ? Number(cursor) : 0;
        const rows = this.all(
          'SELECT * FROM event_journal WHERE cursor>? ORDER BY cursor ASC LIMIT ?',
          offset,
          limit,
        );
        const items = rows.map((row) =>
          StoredEventSchema.parse({
            cursor: String(row.cursor),
            event: this.mapEvent(row),
            committedAt: row.committed_at,
          }),
        );
        return {
          items,
          nextCursor: rows.length > 0 ? String(rows.at(-1)!.cursor) : null,
        };
      },
      latestCursor: async () => {
        const row = this.get('SELECT MAX(cursor) AS cursor FROM event_journal');
        return row?.cursor == null ? null : String(row.cursor);
      },
    };
  }
  private buildHeartbeatRepository(): HeartbeatRepository {
    return {
      get: async (id) =>
        this.mapHeartbeat(
          this.get('SELECT * FROM service_heartbeat WHERE instance_id=?', id),
        ),
      write: async (snapshot) => {
        const value = ServiceHeartbeatSchema.parse(snapshot);
        this.run(
          'INSERT INTO service_heartbeat(instance_id,pid,version,status,sequence,started_at,last_beat_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(instance_id) DO UPDATE SET pid=excluded.pid,version=excluded.version,status=excluded.status,sequence=excluded.sequence,started_at=excluded.started_at,last_beat_at=excluded.last_beat_at',
          value.instanceId,
          value.pid,
          value.version,
          value.status,
          value.sequence,
          value.startedAt,
          value.lastBeatAt,
        );
      },
    };
  }
  private buildTeamRepository(): TeamRepository {
    return {
      getLineage: async (workerAgentId) =>
        this.mapLineage(
          this.get(
            'SELECT * FROM team_lineage WHERE worker_agent_id=?',
            workerAgentId,
          ),
        ),
      listLineages: async (teamId) =>
        this.all(
          'SELECT * FROM team_lineage WHERE team_id=? ORDER BY created_at ASC',
          teamId,
        ).map((row) => this.mapLineage(row)!),
      getSquad: async (id) =>
        this.mapSquad(this.get('SELECT * FROM squad WHERE id=?', id)),
      listSquads: async (page) =>
        this.page(
          this.all('SELECT * FROM squad ORDER BY updated_at DESC'),
          (row) => this.mapSquad(row)!,
          () => true,
          page,
        ),
      saveSquad: async (squad, expectedRevision) => {
        const value = SquadSchema.parse(squad);
        this.transaction(() => {
          if (expectedRevision === null)
            this.run(
              'INSERT INTO squad(id,name,leader_agent_id,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)',
              value.id,
              value.name,
              value.leaderAgentId,
              value.revision,
              value.createdAt,
              value.updatedAt,
            );
          else {
            const changed = this.run(
              'UPDATE squad SET name=?,leader_agent_id=?,revision=?,updated_at=? WHERE id=? AND revision=?',
              value.name,
              value.leaderAgentId,
              value.revision,
              value.updatedAt,
              value.id,
              expectedRevision,
            );
            if (Number(changed.changes) !== 1)
              throw this.revisionError('squad');
          }
          this.run('DELETE FROM squad_member WHERE squad_id=?', value.id);
          for (const agentId of value.memberAgentIds)
            this.run(
              'INSERT INTO squad_member(squad_id,agent_id) VALUES(?,?)',
              value.id,
              agentId,
            );
        });
        return value;
      },
    };
  }

  private applyTaskMutation(input: TaskMutationEffect): TaskRecord {
    if (
      input.nextTask.revision !== input.expectedRevision + 1 ||
      input.event.previousRevision !== input.expectedRevision ||
      input.event.nextRevision !== input.nextTask.revision
    )
      throw createAppError({
        code: ERROR_CODES.storeInvariantViolation,
        category: 'invariant',
        message: 'task mutation revision invariant violated',
        retryable: false,
      });
    const changed = this.updateTask(input.nextTask, input.expectedRevision);
    if (!changed) throw this.revisionError('task');
    if (input.completionArtifact) this.insertCompletion(input.nextTask);
    this.insertTaskEvent(input.event);
    if (input.wakeJob) this.insertJobOrExisting(input.wakeJob);
    this.appendEvent(input.durableEvent);
    return input.nextTask;
  }
  private insertTask(task: TaskRecord): void {
    this.run(
      'INSERT INTO task(id,title,description,state,priority,assignee_json,creator_json,parent_task_id,labels_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      task.id,
      task.title,
      task.description,
      task.state,
      task.priority,
      task.assignee ? JSON.stringify(task.assignee) : null,
      JSON.stringify(task.creator),
      task.parentTaskId,
      JSON.stringify(task.labels),
      task.revision,
      task.createdAt,
      task.updatedAt,
    );
    this.syncTaskRelations(task);
  }
  private updateTask(task: TaskRecord, expected: number): boolean {
    const changed = this.run(
      'UPDATE task SET title=?,description=?,state=?,priority=?,assignee_json=?,creator_json=?,parent_task_id=?,labels_json=?,revision=?,updated_at=? WHERE id=? AND revision=?',
      task.title,
      task.description,
      task.state,
      task.priority,
      task.assignee ? JSON.stringify(task.assignee) : null,
      JSON.stringify(task.creator),
      task.parentTaskId,
      JSON.stringify(task.labels),
      task.revision,
      task.updatedAt,
      task.id,
      expected,
    );
    if (Number(changed.changes) === 1) this.syncTaskRelations(task);
    return Number(changed.changes) === 1;
  }
  private syncTaskRelations(task: TaskRecord): void {
    this.run('DELETE FROM task_anchor WHERE task_id=?', task.id);
    for (const anchor of task.anchors)
      this.run(
        'INSERT INTO task_anchor(task_id,channel_key,source_seq,event_id) VALUES(?,?,?,?)',
        task.id,
        anchor.channelKey,
        anchor.sourceSeq,
        anchor.eventId ?? null,
      );
    if (task.completion) this.insertCompletion(task);
  }
  private insertCompletion(task: TaskRecord): void {
    const artifact = task.completion;
    if (!artifact) return;
    this.run(
      'INSERT OR REPLACE INTO completion_artifact(id,task_id,run_id,submitted_by_json,summary,references_json,created_at) VALUES(?,?,?,?,?,?,?)',
      artifact.id,
      artifact.taskId,
      artifact.runId ?? null,
      JSON.stringify(artifact.submittedBy),
      artifact.summary,
      JSON.stringify(artifact.references),
      artifact.createdAt,
    );
    if (task.completionReview) {
      const review = task.completionReview;
      this.run(
        'INSERT OR REPLACE INTO completion_review(artifact_id,status,reviewer_json,reason,replacement_artifact_id,reviewed_at) VALUES(?,?,?,?,?,?)',
        artifact.id,
        review.status,
        'reviewer' in review ? JSON.stringify(review.reviewer) : null,
        'reason' in review ? (review.reason ?? null) : null,
        'replacementArtifactId' in review
          ? (review.replacementArtifactId ?? null)
          : null,
        'reviewedAt' in review ? review.reviewedAt : null,
      );
    }
  }
  private insertTaskEvent(event: z.infer<typeof TaskEventSchema>): void {
    this.run(
      'INSERT INTO task_event(id,task_id,type,actor_json,previous_revision,next_revision,reason,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      event.id,
      event.taskId,
      event.type,
      JSON.stringify(event.actor),
      event.previousRevision,
      event.nextRevision,
      event.reason ?? null,
      JSON.stringify(event.payload),
      event.createdAt,
    );
  }
  private insertJobOrExisting(job: WakeJob): WakeJob {
    const existing = this.mapJob(
      this.get(
        'SELECT * FROM wake_job WHERE idempotency_key=?',
        job.idempotencyKey,
      ),
    );
    if (existing) return existing;
    this.run(
      'INSERT INTO wake_job(id,idempotency_key,trigger_kind,agent_id,session_key,task_id,source_ref,priority,state,attempt_count,max_attempts,lease_owner_instance_id,lease_generation,lease_acquired_at,lease_expires_at,next_attempt_at,deadline_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      job.id,
      job.idempotencyKey,
      job.triggerKind,
      job.agentId,
      job.sessionKey,
      job.taskId,
      job.sourceRef,
      job.priority,
      job.state,
      job.attemptCount,
      job.maxAttempts,
      job.lease?.ownerInstanceId ?? null,
      job.lease?.generation ?? null,
      job.lease?.acquiredAt ?? null,
      job.lease?.expiresAt ?? null,
      job.nextAttemptAt,
      job.deadlineAt,
      job.createdAt,
      job.updatedAt,
    );
    this.appendEvent(
      DurableEventSchema.parse({
        schema: PROTOCOL_VERSION,
        id: randomUUID(),
        name: EVENT_NAMES.jobQueued,
        occurredAt: job.createdAt,
        correlationId: job.idempotencyKey,
        causationId: null,
        payload: { jobId: job.id, runId: null },
      }),
    );
    return job;
  }
  private insertRun(run: RunRecord): void {
    this.run(
      'INSERT INTO run_attempt(id,job_id,attempt,lease_generation,runner_name,state,started_at,finished_at,result_summary,error_json,usage_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      run.id,
      run.jobId,
      run.attempt,
      run.leaseGeneration,
      run.runnerName,
      run.state,
      run.startedAt,
      run.finishedAt,
      run.resultSummary,
      run.error ? JSON.stringify(run.error) : null,
      run.usage ? JSON.stringify(run.usage) : null,
    );
  }
  private insertOutbox(entry: OutboxEntry): void {
    this.run(
      'INSERT OR IGNORE INTO reply_outbox(id,run_id,subscription_id,channel_key,thread_key,reply_to_event_id,text,dedupe_key,state,attempt_count,lease_owner_instance_id,lease_generation,lease_acquired_at,lease_expires_at,next_attempt_at,provider_message_id,last_error_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      entry.id,
      entry.runId,
      entry.destination.subscriptionId,
      entry.destination.channelKey,
      entry.destination.threadKey ?? null,
      entry.destination.replyToEventId ?? null,
      entry.text,
      entry.dedupeKey,
      entry.state,
      entry.attemptCount,
      entry.lease?.ownerInstanceId ?? null,
      entry.lease?.generation ?? null,
      entry.lease?.acquiredAt ?? null,
      entry.lease?.expiresAt ?? null,
      entry.nextAttemptAt,
      entry.providerMessageId,
      entry.lastError ? JSON.stringify(entry.lastError) : null,
      entry.createdAt,
      entry.updatedAt,
    );
  }
  private appendEvent(event: DurableEvent): void {
    const value = DurableEventSchema.parse(event);
    if (this.get('SELECT 1 FROM event_journal WHERE event_id=?', value.id))
      return;
    this.run(
      'INSERT INTO event_journal(event_id,name,correlation_id,causation_id,payload_json,occurred_at,committed_at) VALUES(?,?,?,?,?,?,?)',
      value.id,
      value.name,
      value.correlationId,
      value.causationId,
      JSON.stringify(value.payload),
      value.occurredAt,
      this.options.clock.now().toISOString(),
    );
  }
  private upsertCursor(cursor: ChannelCursor): void {
    this.run(
      'INSERT INTO channel_cursor(subscription_id,source_seq,source_event_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(subscription_id) DO UPDATE SET source_seq=excluded.source_seq,source_event_id=excluded.source_event_id,updated_at=excluded.updated_at',
      cursor.subscriptionId,
      cursor.sourceSeq,
      cursor.sourceEventId,
      cursor.updatedAt,
    );
  }

  private mapSession(row?: Row): SessionRecord | null {
    return row
      ? SessionRecordSchema.parse({
          key: row.key,
          generation: row.generation,
          agentId: row.agent_id,
          channelKey: row.channel_key,
          workspacePath: row.workspace_path,
          codexThreadId: row.codex_thread_id,
          status: row.status,
          invalidatedReason: row.invalidated_reason,
          revision: row.revision,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })
      : null;
  }
  private mapCursor(row?: Row): ChannelCursor | null {
    return row
      ? ChannelCursorSchema.parse({
          subscriptionId: row.subscription_id,
          sourceSeq: row.source_seq,
          sourceEventId: row.source_event_id,
          updatedAt: row.updated_at,
        })
      : null;
  }
  private mapJob(row?: Row): WakeJob | null {
    return row
      ? WakeJobSchema.parse({
          id: row.id,
          idempotencyKey: row.idempotency_key,
          triggerKind: row.trigger_kind,
          agentId: row.agent_id,
          sessionKey: row.session_key,
          taskId: row.task_id,
          sourceRef: row.source_ref,
          priority: row.priority,
          state: row.state,
          attemptCount: row.attempt_count,
          maxAttempts: row.max_attempts,
          lease: row.lease_owner_instance_id
            ? {
                ownerInstanceId: row.lease_owner_instance_id,
                generation: row.lease_generation,
                acquiredAt: row.lease_acquired_at,
                expiresAt: row.lease_expires_at,
              }
            : null,
          nextAttemptAt: row.next_attempt_at,
          deadlineAt: row.deadline_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })
      : null;
  }
  private mapRun(row?: Row): RunRecord | null {
    return row
      ? RunRecordSchema.parse({
          id: row.id,
          jobId: row.job_id,
          attempt: row.attempt,
          leaseGeneration: row.lease_generation,
          runnerName: row.runner_name,
          state: row.state,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          resultSummary: row.result_summary,
          error: parseJson(row.error_json),
          usage: parseJson(row.usage_json),
        })
      : null;
  }
  private mapOutbox(row?: Row): OutboxEntry | null {
    return row
      ? OutboxEntrySchema.parse({
          id: row.id,
          runId: row.run_id,
          destination: {
            subscriptionId: row.subscription_id,
            channelKey: row.channel_key,
            ...(row.thread_key ? { threadKey: row.thread_key } : {}),
            ...(row.reply_to_event_id
              ? { replyToEventId: row.reply_to_event_id }
              : {}),
          },
          text: row.text,
          dedupeKey: row.dedupe_key,
          state: row.state,
          attemptCount: row.attempt_count,
          lease: row.lease_owner_instance_id
            ? {
                ownerInstanceId: row.lease_owner_instance_id,
                generation: row.lease_generation,
                acquiredAt: row.lease_acquired_at,
                expiresAt: row.lease_expires_at,
              }
            : null,
          nextAttemptAt: row.next_attempt_at,
          providerMessageId: row.provider_message_id,
          lastError: parseJson(row.last_error_json),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })
      : null;
  }
  private mapTask(row?: Row): TaskRecord | null {
    if (!row) return null;
    const anchors = this.all(
      'SELECT * FROM task_anchor WHERE task_id=? ORDER BY rowid',
      row.id,
    ).map((anchor) => ({
      channelKey: String(anchor.channel_key),
      sourceSeq: String(anchor.source_seq),
      ...(anchor.event_id ? { eventId: String(anchor.event_id) } : {}),
    }));
    const artifactRow = this.get(
      'SELECT * FROM completion_artifact WHERE task_id=? ORDER BY created_at DESC LIMIT 1',
      row.id,
    );
    const completion = artifactRow
      ? {
          id: artifactRow.id,
          taskId: artifactRow.task_id,
          ...(artifactRow.run_id ? { runId: artifactRow.run_id } : {}),
          submittedBy: parseJson(artifactRow.submitted_by_json),
          summary: artifactRow.summary,
          references: parseJson(artifactRow.references_json),
          createdAt: artifactRow.created_at,
        }
      : null;
    const reviewRow = artifactRow
      ? this.get(
          'SELECT * FROM completion_review WHERE artifact_id=?',
          artifactRow.id,
        )
      : undefined;
    let completionReview: unknown = null;
    if (reviewRow)
      completionReview =
        reviewRow.status === 'pending'
          ? { status: 'pending' }
          : {
              status: reviewRow.status,
              reviewer: parseJson(reviewRow.reviewer_json),
              reviewedAt: reviewRow.reviewed_at,
              ...(reviewRow.reason ? { reason: reviewRow.reason } : {}),
              ...(reviewRow.replacement_artifact_id
                ? { replacementArtifactId: reviewRow.replacement_artifact_id }
                : {}),
            };
    return TaskRecordSchema.parse({
      id: row.id,
      title: row.title,
      description: row.description,
      state: row.state,
      priority: row.priority,
      assignee: parseJson(row.assignee_json),
      creator: parseJson(row.creator_json),
      labels: parseJson(row.labels_json),
      parentTaskId: row.parent_task_id,
      anchors,
      completion,
      completionReview,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  private mapHeartbeat(row?: Row): ServiceHeartbeat | null {
    return row
      ? ServiceHeartbeatSchema.parse({
          instanceId: row.instance_id,
          pid: row.pid,
          version: row.version,
          status: row.status,
          sequence: row.sequence,
          startedAt: row.started_at,
          lastBeatAt: row.last_beat_at,
        })
      : null;
  }
  private mapLineage(row?: Row): TeamLineage | null {
    return row
      ? TeamLineageSchema.parse({
          teamId: row.team_id,
          rootAgentId: row.root_agent_id,
          parentAgentId: row.parent_agent_id,
          workerAgentId: row.worker_agent_id,
          role: row.role,
          depth: row.depth,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
        })
      : null;
  }
  private mapSquad(row?: Row): Squad | null {
    if (!row) return null;
    const members = this.all(
      'SELECT agent_id FROM squad_member WHERE squad_id=? ORDER BY agent_id ASC',
      row.id,
    ).map((item) => String(item.agent_id));
    return SquadSchema.parse({
      id: row.id,
      name: row.name,
      leaderAgentId: row.leader_agent_id,
      memberAgentIds: members,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  private mapEvent(row: Row): DurableEvent {
    return DurableEventSchema.parse({
      schema: 'agent-party-time.v1',
      id: row.event_id,
      name: row.name,
      occurredAt: row.occurred_at,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      payload: parseJson(row.payload_json),
    });
  }
  private page<T>(
    rows: Row[],
    map: (row: Row) => T,
    filter: (value: T) => boolean,
    request: PageRequest,
  ): PageResult<z.ZodType<T>> {
    const offset = cursorOffset(request.cursor);
    const selected = rows
      .map(map)
      .filter(filter)
      .slice(offset, offset + request.limit);
    return {
      items: selected,
      nextCursor: nextCursor(offset, selected.length, request.limit),
    } as PageResult<z.ZodType<T>>;
  }
  private countStates(
    table: 'wake_job' | 'reply_outbox',
    states: readonly string[],
  ): Record<string, number> {
    const result = Object.fromEntries(
      states.map((state) => [state, 0]),
    ) as Record<string, number>;
    for (const row of this.all(
      `SELECT state, COUNT(*) AS count FROM ${table} GROUP BY state`,
    ))
      result[String(row.state)] = Number(row.count);
    return result;
  }
  private transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = callback();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private statement(sql: string): Statement {
    return this.db.prepare(sql);
  }
  private get(sql: string, ...values: unknown[]): Row | undefined {
    return this.statement(sql).get(...(values as never[])) as Row | undefined;
  }
  private all(sql: string, ...values: unknown[]): Row[] {
    return this.statement(sql).all(...(values as never[])) as Row[];
  }
  private run(sql: string, ...values: unknown[]) {
    return this.statement(sql).run(...(values as never[]));
  }
  private revisionError(entity: string) {
    return createAppError({
      code: ERROR_CODES.storeConstraintConflict,
      category: 'conflict',
      message: `${entity} revision/state conflict`,
      retryable: false,
    });
  }
  private notFound(entity: string) {
    return createAppError({
      code: ERROR_CODES.entityNotFound,
      category: 'not_found',
      message: `${entity} 不存在`,
      retryable: false,
    });
  }
  private outboxLeaseLost() {
    return createAppError({
      code: ERROR_CODES.storeConstraintConflict,
      category: 'conflict',
      message: 'outbox lease 已失效',
      retryable: false,
    });
  }
}
