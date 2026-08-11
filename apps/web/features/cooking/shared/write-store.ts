import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { AppDatabase } from '@/server/database';
import { PlatformError } from '@/server/errors';
import { CookingMutationIdSchema } from './contract';

export type CookingAuditInput = {
  projectId: string;
  action: string;
  targetType: string;
  targetId: string;
  details?: unknown;
};

export type CookingWriteOutcome<T> = {
  result: T;
  resourceId: string;
  audits?: CookingAuditInput[];
};

export type CookingWriteInput<T> = {
  mutationId: string;
  actorUserId: string;
  operation: string;
  resourceType: string;
  resultSchema: z.ZodType<T>;
  perform: () => CookingWriteOutcome<T>;
};

export type TrackedCookingWriteResult<T> = {
  result: T;
  replayed: boolean;
};

export class CookingWriteStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  run<T>(input: CookingWriteInput<T>): T {
    return this.runTracked(input).result;
  }

  runTracked<T>(input: CookingWriteInput<T>): TrackedCookingWriteResult<T> {
    const mutationId = CookingMutationIdSchema.parse(input.mutationId);
    return this.db.transaction(() => {
      const previous = this.db
        .prepare(
          `SELECT actor_user_id, operation, result_json
           FROM cooking_mutation WHERE id = ?`,
        )
        .get(mutationId) as
        | { actor_user_id: string; operation: string; result_json: string }
        | undefined;
      if (previous) {
        if (
          previous.actor_user_id !== input.actorUserId ||
          previous.operation !== input.operation
        )
          throw new PlatformError(
            'RESOURCE_CONFLICT',
            '操作标识已用于其他操作',
          );
        return {
          result: input.resultSchema.parse(JSON.parse(previous.result_json)),
          replayed: true,
        };
      }

      const outcome = input.perform();
      const result = input.resultSchema.parse(outcome.result);
      const createdAt = this.now().toISOString();
      for (const audit of outcome.audits ?? [])
        this.db
          .prepare(
            `INSERT INTO cooking_audit_event(
               id, project_id, actor_user_id, action, target_type, target_id,
               details_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            this.createId(),
            audit.projectId,
            input.actorUserId,
            audit.action,
            audit.targetType,
            audit.targetId,
            JSON.stringify(audit.details ?? {}),
            createdAt,
          );
      this.db
        .prepare(
          `INSERT INTO cooking_mutation(
             id, actor_user_id, operation, resource_type, resource_id,
             result_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          mutationId,
          input.actorUserId,
          input.operation,
          input.resourceType,
          outcome.resourceId,
          JSON.stringify(result),
          createdAt,
        );
      return { result, replayed: false };
    })();
  }
}
