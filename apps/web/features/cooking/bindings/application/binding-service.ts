import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppDatabase } from '@/server/database';
import { PlatformError } from '@/server/errors';
import { RunnerSchema } from '@/server/runner/contract';
import {
  EngineeringIdSchema,
  RepositoryUrlSchema,
} from '@/features/cooking/engineering/contract';
import { CookingWriteStore } from '@/features/cooking/shared/write-store';
import {
  EngineeringBindingSchema,
  EngineeringBindingSummarySchema,
  type EngineeringBinding,
  type EngineeringBindingSummary,
} from '../contract';

type BindingRow = {
  id: string;
  engineering_id: string;
  user_id: string;
  runner_id: string;
  created_at: string;
};

const DeleteBindingResultSchema = z.object({
  deleted: z.boolean(),
  bindingId: z.uuid(),
});

export class BindingService {
  private readonly writes: CookingWriteStore;

  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {
    this.writes = new CookingWriteStore(db, now, createId);
  }

  createBinding(
    actorUserId: string,
    engineeringId: string,
    runnerId: string,
    mutationId: string,
  ): EngineeringBinding {
    EngineeringIdSchema.parse(engineeringId);
    return this.writes.run({
      mutationId,
      actorUserId,
      operation: 'ENGINEERING_BINDING_CREATE',
      resourceType: 'ENGINEERING_BINDING',
      resultSchema: EngineeringBindingSchema,
      perform: () => {
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
            `SELECT id FROM platform_runner
             WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
          )
          .get(runnerId, actorUserId);
        if (!runner)
          throw new PlatformError(
            'NOT_FOUND',
            'Agent 不存在、已停用或不属于当前用户',
          );
        const existing = this.db
          .prepare(
            `SELECT id, engineering_id, user_id, runner_id, created_at
             FROM cooking_engineering_binding
             WHERE engineering_id = ? AND user_id = ?`,
          )
          .get(engineeringId, actorUserId) as BindingRow | undefined;
        if (existing?.runner_id === runnerId)
          return { result: mapBinding(existing), resourceId: existing.id };
        if (existing)
          throw new PlatformError(
            'RESOURCE_CONFLICT',
            '当前用户已经为这个工程建立绑定；请先删除原绑定',
          );
        const id = this.createId();
        const createdAt = this.now().toISOString();
        this.db
          .prepare(
            `INSERT INTO cooking_engineering_binding(
               id, engineering_id, user_id, runner_id, created_at
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(id, engineeringId, actorUserId, runnerId, createdAt);
        const result = EngineeringBindingSchema.parse({
          id,
          engineeringId,
          userId: actorUserId,
          runnerId,
          createdAt,
        });
        return {
          result,
          resourceId: id,
          audits: [
            {
              projectId: engineering.project_id,
              action: 'ENGINEERING_BINDING_CREATED',
              targetType: 'ENGINEERING_BINDING',
              targetId: id,
              details: { engineeringId, runnerId },
            },
          ],
        };
      },
    });
  }

  createReservedBinding(
    actorUserId: string,
    engineeringId: string,
    runnerId: string,
    bindingId: string,
    mutationId: string,
  ): EngineeringBinding {
    EngineeringIdSchema.parse(engineeringId);
    const id = z.uuid().parse(bindingId);
    return this.writes.run({
      mutationId,
      actorUserId,
      operation: 'ENGINEERING_BINDING_CREATE',
      resourceType: 'ENGINEERING_BINDING',
      resultSchema: EngineeringBindingSchema,
      perform: () => {
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
            `SELECT id FROM platform_runner
             WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
          )
          .get(runnerId, actorUserId);
        if (!runner)
          throw new PlatformError(
            'NOT_FOUND',
            'Agent 不存在、已停用或不属于当前用户',
          );
        const existing = this.db
          .prepare(
            `SELECT id, engineering_id, user_id, runner_id, created_at
             FROM cooking_engineering_binding
             WHERE engineering_id = ? AND user_id = ?`,
          )
          .get(engineeringId, actorUserId) as BindingRow | undefined;
        if (existing)
          throw new PlatformError(
            'RESOURCE_CONFLICT',
            '当前用户已经为这个工程建立绑定',
          );
        const createdAt = this.now().toISOString();
        this.db
          .prepare(
            `INSERT INTO cooking_engineering_binding(
               id, engineering_id, user_id, runner_id, created_at
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(id, engineeringId, actorUserId, runnerId, createdAt);
        const result = EngineeringBindingSchema.parse({
          id,
          engineeringId,
          userId: actorUserId,
          runnerId,
          createdAt,
        });
        return {
          result,
          resourceId: id,
          audits: [
            {
              projectId: engineering.project_id,
              action: 'ENGINEERING_BINDING_CREATED',
              targetType: 'ENGINEERING_BINDING',
              targetId: id,
              details: { engineeringId, runnerId },
            },
          ],
        };
      },
    });
  }

  deleteBinding(
    actorUserId: string,
    bindingId: string,
    mutationId: string,
  ): { deleted: boolean; bindingId: string } {
    const id = z.uuid().parse(bindingId);
    return this.writes.run({
      mutationId,
      actorUserId,
      operation: 'ENGINEERING_BINDING_DELETE',
      resourceType: 'ENGINEERING_BINDING',
      resultSchema: DeleteBindingResultSchema,
      perform: () => {
        const row = this.db
          .prepare(
            `SELECT binding.id, binding.engineering_id, binding.user_id,
                    binding.runner_id, binding.created_at,
                    engineering.project_id
             FROM cooking_engineering_binding binding
             JOIN cooking_engineering engineering
               ON engineering.id = binding.engineering_id
             WHERE binding.id = ? AND binding.user_id = ?`,
          )
          .get(id, actorUserId) as
          (BindingRow & { project_id: string }) | undefined;
        if (!row)
          return {
            result: { deleted: false, bindingId: id },
            resourceId: id,
          };
        const submissionReference = this.db
          .prepare(
            `SELECT 1 present FROM cooking_submission_item
             WHERE binding_id = ? LIMIT 1`,
          )
          .get(id);
        const executionReference = this.db
          .prepare(
            `SELECT 1 present FROM platform_execution
             WHERE binding_id = ? LIMIT 1`,
          )
          .get(id);
        if (submissionReference || executionReference)
          throw new PlatformError(
            'RESOURCE_CONFLICT',
            '这个绑定已经用于提测或任务，不能删除',
          );
        const deleted = this.db
          .prepare(
            `DELETE FROM cooking_engineering_binding
             WHERE id = ? AND user_id = ?`,
          )
          .run(id, actorUserId);
        if (deleted.changes !== 1)
          throw new PlatformError('STALE_STATE', '工程绑定已更新');
        return {
          result: { deleted: true, bindingId: id },
          resourceId: id,
          audits: [
            {
              projectId: row.project_id,
              action: 'ENGINEERING_BINDING_DELETED',
              targetType: 'ENGINEERING_BINDING',
              targetId: id,
            },
          ],
        };
      },
    });
  }

  confirmRepository(
    runnerId: string,
    bindingId: string,
    repositoryUrlInput: string,
  ): string {
    const repositoryUrl = RepositoryUrlSchema.parse(repositoryUrlInput);
    return this.db.transaction(() => {
      const row = this.repositoryConfirmationTarget(runnerId, bindingId);
      if (row.archived_at)
        throw new PlatformError('INVALID_TRANSITION', '已归档工程不能确认仓库');
      if (row.repository_state === 'CONFIRMED')
        return requireMatchingRepository(row.repository_url, repositoryUrl);

      const confirmedAt = this.now().toISOString();
      const update = this.db
        .prepare(
          `UPDATE cooking_engineering
           SET repository_state = 'CONFIRMED', repository_url = ?,
               version = version + 1, updated_at = ?
           WHERE id = ? AND repository_state = 'PENDING'`,
        )
        .run(repositoryUrl, confirmedAt, row.engineering_id);
      if (update.changes !== 1) {
        const current = this.repositoryConfirmationTarget(runnerId, bindingId);
        return requireMatchingRepository(current.repository_url, repositoryUrl);
      }
      this.db
        .prepare(
          `INSERT INTO cooking_audit_event(
             id, project_id, actor_user_id, action, target_type, target_id,
             details_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.createId(),
          row.project_id,
          row.user_id,
          'ENGINEERING_REPOSITORY_CONFIRMED',
          'ENGINEERING',
          row.engineering_id,
          JSON.stringify({ repositoryUrl }),
          confirmedAt,
        );
      return repositoryUrl;
    })();
  }

  listBindings(
    userId: string,
    engineeringId: string,
  ): EngineeringBindingSummary[] {
    this.requireEngineeringProjectMember(userId, engineeringId);
    return this.db
      .prepare(
        `SELECT binding.id, binding.engineering_id, binding.user_id,
                binding.runner_id, binding.created_at,
                user.username, user.display_name,
                user.created_at user_created_at,
                runner.name runner_name, runner.version runner_version,
                runner.last_seen_at, runner.revoked_at,
                runner.created_at runner_created_at
         FROM cooking_engineering_binding binding
         JOIN platform_user user ON user.id = binding.user_id
         JOIN platform_runner runner ON runner.id = binding.runner_id
         WHERE binding.engineering_id = ?
         ORDER BY binding.created_at, binding.id`,
      )
      .all(engineeringId)
      .map((row) => mapSummary(row as BindingSummaryRow));
  }

  listBindingsForRunner(runnerId: string): EngineeringBinding[] {
    return this.db
      .prepare(
        `SELECT id, engineering_id, user_id, runner_id, created_at
         FROM cooking_engineering_binding
         WHERE runner_id = ?
         ORDER BY created_at, id`,
      )
      .all(runnerId)
      .map((row) => mapBinding(row as BindingRow));
  }

  private requireEngineeringProjectMember(
    userId: string,
    engineeringId: string,
  ): void {
    const membership = this.db
      .prepare(
        `SELECT 1 present
         FROM cooking_engineering engineering
         JOIN cooking_project_membership membership
           ON membership.project_id = engineering.project_id
          AND membership.user_id = ?
         WHERE engineering.id = ?`,
      )
      .get(userId, engineeringId);
    if (!membership)
      throw new PlatformError('NOT_FOUND', '工程不存在或无权访问');
  }

  private repositoryConfirmationTarget(
    runnerId: string,
    bindingId: string,
  ): RepositoryConfirmationRow {
    const row = this.db
      .prepare(
        `SELECT engineering.id engineering_id, engineering.project_id,
                engineering.repository_state, engineering.repository_url,
                engineering.archived_at, binding.user_id
         FROM cooking_engineering_binding binding
         JOIN cooking_engineering engineering ON engineering.id = binding.engineering_id
         WHERE binding.id = ? AND binding.runner_id = ?`,
      )
      .get(bindingId, runnerId) as RepositoryConfirmationRow | undefined;
    if (!row)
      throw new PlatformError(
        'NOT_FOUND',
        '本机 Agent 关联不存在或不属于当前 Agent',
      );
    return row;
  }
}

type RepositoryConfirmationRow = {
  engineering_id: string;
  project_id: string;
  user_id: string;
  repository_state: 'PENDING' | 'CONFIRMED';
  repository_url: string | null;
  archived_at: string | null;
};

function requireMatchingRepository(
  confirmedRepositoryUrl: string | null,
  repositoryUrl: string,
): string {
  if (confirmedRepositoryUrl !== repositoryUrl)
    throw new PlatformError(
      'RESOURCE_CONFLICT',
      '本机仓库与工程仓库身份不一致',
    );
  return repositoryUrl;
}

type BindingSummaryRow = BindingRow & {
  username: string;
  display_name: string;
  user_created_at: string;
  runner_name: string;
  runner_version: number;
  last_seen_at: string | null;
  revoked_at: string | null;
  runner_created_at: string;
};

function mapBinding(row: BindingRow): EngineeringBinding {
  return EngineeringBindingSchema.parse({
    id: row.id,
    engineeringId: row.engineering_id,
    userId: row.user_id,
    runnerId: row.runner_id,
    createdAt: row.created_at,
  });
}

function mapSummary(row: BindingSummaryRow): EngineeringBindingSummary {
  return EngineeringBindingSummarySchema.parse({
    binding: mapBinding(row),
    user: {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name,
      createdAt: row.user_created_at,
    },
    runner: RunnerSchema.parse({
      id: row.runner_id,
      ownerUserId: row.user_id,
      name: row.runner_name,
      version: row.runner_version,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
      createdAt: row.runner_created_at,
    }),
  });
}
