import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { AppDatabase } from '@/server/database/index';
import { PlatformError } from '@/server/platform/errors/index';
import { RequestMutationIdSchema } from '@/contracts/mutation';
import { insertAuditEvent } from './auditEvent';

export type AuditInput = {
  projectId: string;
  action: string;
  /** Defaults to resourceId; targetType is always the mutation's resourceType. */
  targetId?: string;
  details?: unknown;
};

export type MutationWriteOutcome<T> = {
  result: T;
  resourceId: string;
  audit?: AuditInput;
};

export type MutationWriteInput<T> = {
  mutationId: string;
  actorUserId: string;
  operation: string;
  resourceType: string;
  resultSchema: z.ZodType<T>;
  perform: () => MutationWriteOutcome<T>;
};

export type TrackedMutationResult<T> = {
  result: T;
  replayed: boolean;
};

export class MutationStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  run<T>(input: MutationWriteInput<T>): T {
    return this.runTracked(input).result;
  }

  runTracked<T>(input: MutationWriteInput<T>): TrackedMutationResult<T> {
    const mutationId = RequestMutationIdSchema.parse(input.mutationId);
    return this.db.transaction(() => {
      const previous = this.db.get(
        `SELECT actor_user_id, operation, result_json
           FROM platform_mutation WHERE id = ?`,
        mutationId,
      ) as { actor_user_id: string; operation: string; result_json: string } | undefined;
      if (previous) {
        if (
          previous.actor_user_id !== input.actorUserId ||
          previous.operation !== input.operation
        )
          throw new PlatformError('RESOURCE_CONFLICT', '操作标识已用于其他操作');
        return {
          result: input.resultSchema.parse(JSON.parse(previous.result_json)),
          replayed: true,
        };
      }

      const outcome = input.perform();
      const result = input.resultSchema.parse(outcome.result);
      const createdAt = this.now().toISOString();
      const audit = outcome.audit;
      if (audit)
        insertAuditEvent(this.db, {
          id: this.createId(),
          projectId: audit.projectId,
          actorUserId: input.actorUserId,
          action: audit.action,
          targetType: input.resourceType,
          targetId: audit.targetId ?? outcome.resourceId,
          details: audit.details,
          createdAt,
        });
      this.db.run(
        `INSERT INTO platform_mutation(
             id, actor_user_id, operation, resource_type, resource_id,
             result_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          mutationId,
          input.actorUserId,
          input.operation,
          input.resourceType,
          outcome.resourceId,
          JSON.stringify(result),
          createdAt,
        ],
      );
      return { result, replayed: false };
    })();
  }
}
