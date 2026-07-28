import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '@/server/database';
import { PlatformError, publicError } from '@/server/errors';
import {
  RunnerBindingWorkCompletionSchema,
  RunnerBindingWorkCompletionResponseSchema,
  RunnerBindingWorkResponseSchema,
  type RunnerBindingWork,
  type RunnerBindingWorkCompletion,
} from '@agent-party-time/runner-contract';
import { EngineeringIdSchema } from '@/features/cooking/engineering/contract';
import { CookingMutationIdSchema } from '@/features/cooking/shared/contract';
import { CookingWriteStore } from '@/features/cooking/shared/write-store';
import {
  BindingRequestIdSchema,
  BindingRequestSchema,
  type BindingRequest,
} from '../contract';
import { BindingService } from './binding-service';

type BindingRequestRow = {
  id: string;
  engineering_id: string;
  user_id: string;
  runner_id: string;
  state: BindingRequest['state'];
  error_message: string | null;
  repository_url: string | null;
  binding_id: string;
  expires_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  created_at: string;
};

const DEFAULT_REQUEST_DURATION_MS = 5 * 60 * 1_000;
const DEFAULT_ONLINE_AFTER_MS = 30 * 1_000;
const CLAIM_RECOVERY_MS = 60 * 1_000;

export class BindingRequestService {
  private readonly writes: CookingWriteStore;

  constructor(
    private readonly db: AppDatabase,
    private readonly bindings: BindingService = new BindingService(db),
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    private readonly onlineAfterMs: number = DEFAULT_ONLINE_AFTER_MS,
  ) {
    this.writes = new CookingWriteStore(db, now, createId);
  }

  createRequest(
    actorUserId: string,
    engineeringIdInput: string,
    runnerId: string,
    mutationIdInput: string,
    durationMs: number = DEFAULT_REQUEST_DURATION_MS,
  ): BindingRequest {
    const engineeringId = EngineeringIdSchema.parse(engineeringIdInput);
    const mutationId = CookingMutationIdSchema.parse(mutationIdInput);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
      throw new PlatformError('VALIDATION_FAILED', '绑定请求有效期无效');
    return this.writes.run({
      mutationId,
      actorUserId,
      operation: 'ENGINEERING_BINDING_REQUEST_CREATE',
      resourceType: 'ENGINEERING_BINDING_REQUEST',
      resultSchema: BindingRequestSchema,
      perform: () => {
        this.failExpired();
        const engineering = this.db
          .prepare(
            `SELECT engineering.project_id, engineering.archived_at
             FROM cooking_engineering engineering
             JOIN cooking_engineering_membership membership
               ON membership.engineering_id = engineering.id
              AND membership.user_id = ?
             WHERE engineering.id = ?`,
          )
          .get(actorUserId, engineeringId) as
          { project_id: string; archived_at: string | null } | undefined;
        if (!engineering)
          throw new PlatformError('NOT_FOUND', '工程不存在或你不是工程成员');
        if (engineering.archived_at)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '已归档工程不能建立绑定',
          );
        const runner = this.db
          .prepare(
            `SELECT last_seen_at FROM platform_runner
             WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
          )
          .get(runnerId, actorUserId) as
          { last_seen_at: string | null } | undefined;
        if (
          !runner?.last_seen_at ||
          this.now().getTime() - Date.parse(runner.last_seen_at) >
            this.onlineAfterMs
        )
          throw new PlatformError(
            'INVALID_TRANSITION',
            '所选 Agent 当前不在线',
          );
        const existingBinding = this.db
          .prepare(
            `SELECT 1 present FROM cooking_engineering_binding
             WHERE engineering_id = ? AND user_id = ?`,
          )
          .get(engineeringId, actorUserId);
        if (existingBinding)
          throw new PlatformError(
            'RESOURCE_CONFLICT',
            '你已经为这个工程建立绑定',
          );
        const active = this.db
          .prepare(
            `SELECT id, engineering_id, user_id, runner_id, state,
                    error_message, repository_url, binding_id, expires_at,
                    claimed_at, completed_at, created_at
             FROM cooking_binding_request
             WHERE engineering_id = ? AND user_id = ?
               AND state IN ('PENDING', 'PROCESSING')`,
          )
          .get(engineeringId, actorUserId) as BindingRequestRow | undefined;
        if (active)
          return { result: mapRequest(active), resourceId: active.id };

        const id = this.createId();
        const bindingId = this.createId();
        const createdAt = this.now();
        const expiresAt = new Date(
          createdAt.getTime() + durationMs,
        ).toISOString();
        this.db
          .prepare(
            `INSERT INTO cooking_binding_request(
               id, engineering_id, user_id, runner_id, state, error_message,
               repository_url, binding_id, expires_at, claimed_at,
               completed_at, created_at
             ) VALUES (?, ?, ?, ?, 'PENDING', NULL, NULL, ?, ?, NULL, NULL, ?)`,
          )
          .run(
            id,
            engineeringId,
            actorUserId,
            runnerId,
            bindingId,
            expiresAt,
            createdAt.toISOString(),
          );
        const result = BindingRequestSchema.parse({
          id,
          engineeringId,
          userId: actorUserId,
          runnerId,
          state: 'PENDING',
          errorMessage: null,
          expiresAt,
          createdAt: createdAt.toISOString(),
          completedAt: null,
        });
        return {
          result,
          resourceId: id,
          audits: [
            {
              projectId: engineering.project_id,
              action: 'ENGINEERING_BINDING_REQUESTED',
              targetType: 'ENGINEERING_BINDING_REQUEST',
              targetId: id,
              details: { engineeringId, runnerId },
            },
          ],
        };
      },
    });
  }

  getRequest(userId: string, requestIdInput: string): BindingRequest {
    const requestId = BindingRequestIdSchema.parse(requestIdInput);
    this.failExpired();
    const row = this.db
      .prepare(
        `SELECT id, engineering_id, user_id, runner_id, state,
                error_message, repository_url, binding_id, expires_at,
                claimed_at, completed_at, created_at
         FROM cooking_binding_request
         WHERE id = ? AND user_id = ?`,
      )
      .get(requestId, userId) as BindingRequestRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '绑定请求不存在或无权访问');
    return mapRequest(row);
  }

  claimNext(runnerId: string): RunnerBindingWork | null {
    this.failExpired();
    const reclaimBefore = new Date(
      this.now().getTime() - CLAIM_RECOVERY_MS,
    ).toISOString();
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT id, engineering_id, user_id, runner_id, state,
                  error_message, repository_url, binding_id, expires_at,
                  claimed_at, completed_at, created_at
           FROM cooking_binding_request
           WHERE runner_id = ? AND expires_at > ?
             AND (
               state = 'PENDING' OR
               (state = 'PROCESSING' AND claimed_at < ?)
             )
           ORDER BY created_at, id
           LIMIT 1`,
        )
        .get(runnerId, this.now().toISOString(), reclaimBefore) as
        BindingRequestRow | undefined;
      if (!row) return null;
      const claimedAt = this.now().toISOString();
      const claimed = this.db
        .prepare(
          `UPDATE cooking_binding_request
           SET state = 'PROCESSING', claimed_at = ?
           WHERE id = ? AND (
             state = 'PENDING' OR
             (state = 'PROCESSING' AND claimed_at < ?)
           )`,
        )
        .run(claimedAt, row.id, reclaimBefore);
      if (claimed.changes !== 1) return null;
      return RunnerBindingWorkResponseSchema.shape.request.unwrap().parse({
        requestId: row.id,
        bindingId: row.binding_id,
        expiresAt: row.expires_at,
      });
    })();
  }

  complete(
    runnerId: string,
    requestIdInput: string,
    completionInput: RunnerBindingWorkCompletion,
  ): 'SUCCEEDED' | 'FAILED' {
    const requestId = BindingRequestIdSchema.parse(requestIdInput);
    const completion = RunnerBindingWorkCompletionSchema.parse(completionInput);
    const row = this.requestForRunner(runnerId, requestId);
    if (row.state === 'SUCCEEDED') return 'SUCCEEDED';
    if (row.state === 'FAILED' || row.state === 'CANCELLED') return 'FAILED';
    if (row.state !== 'PROCESSING')
      throw new PlatformError('INVALID_TRANSITION', '绑定请求当前不能完成');
    if (completion.outcome === 'FAILED') {
      this.failRequest(row.id, completion.message);
      return RunnerBindingWorkCompletionResponseSchema.shape.state.parse(
        'FAILED',
      );
    }

    try {
      this.db.transaction(() => {
        this.bindings.createReservedBinding(
          row.user_id,
          row.engineering_id,
          row.runner_id,
          row.binding_id,
          row.id,
        );
        const repositoryUrl = this.bindings.confirmRepository(
          row.runner_id,
          row.binding_id,
          completion.repositoryUrl,
        );
        const completedAt = this.now().toISOString();
        const update = this.db
          .prepare(
            `UPDATE cooking_binding_request
             SET state = 'SUCCEEDED', repository_url = ?, completed_at = ?,
                 error_message = NULL
             WHERE id = ? AND state = 'PROCESSING'`,
          )
          .run(repositoryUrl, completedAt, row.id);
        if (update.changes !== 1)
          throw new PlatformError('STALE_STATE', '绑定请求已更新');
      })();
      return RunnerBindingWorkCompletionResponseSchema.shape.state.parse(
        'SUCCEEDED',
      );
    } catch (error) {
      this.failRequest(row.id, publicError(error).message);
      return RunnerBindingWorkCompletionResponseSchema.shape.state.parse(
        'FAILED',
      );
    }
  }

  private requestForRunner(
    runnerId: string,
    requestId: string,
  ): BindingRequestRow {
    this.failExpired();
    const row = this.db
      .prepare(
        `SELECT id, engineering_id, user_id, runner_id, state,
                error_message, repository_url, binding_id, expires_at,
                claimed_at, completed_at, created_at
         FROM cooking_binding_request
         WHERE id = ? AND runner_id = ?`,
      )
      .get(requestId, runnerId) as BindingRequestRow | undefined;
    if (!row)
      throw new PlatformError('NOT_FOUND', '绑定请求不存在或不属于当前 Agent');
    return row;
  }

  private failRequest(requestId: string, message: string): void {
    this.db
      .prepare(
        `UPDATE cooking_binding_request
         SET state = 'FAILED', error_message = ?, completed_at = ?
         WHERE id = ? AND state IN ('PENDING', 'PROCESSING')`,
      )
      .run(message.slice(0, 240), this.now().toISOString(), requestId);
  }

  private failExpired(): void {
    const now = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE cooking_binding_request
         SET state = 'FAILED', error_message = '绑定请求已过期',
             completed_at = ?
         WHERE state IN ('PENDING', 'PROCESSING') AND expires_at <= ?`,
      )
      .run(now, now);
  }
}

function mapRequest(row: BindingRequestRow): BindingRequest {
  return BindingRequestSchema.parse({
    id: row.id,
    engineeringId: row.engineering_id,
    userId: row.user_id,
    runnerId: row.runner_id,
    state: row.state,
    errorMessage: row.error_message,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });
}
