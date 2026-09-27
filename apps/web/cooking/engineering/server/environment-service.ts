import { z } from 'zod';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import { CookingWriteStore } from '@/cooking/shared/server/write-store';
import {
  DeploymentMethodSchema,
  EnvironmentIdSchema,
  EnvironmentNameSchema,
  TestEnvironmentSchema,
  type TestEnvironment,
} from '../contract';
import {
  EngineeringQueries,
  mapEnvironment,
  type EnvironmentRow,
} from './engineering-queries';

export type EnvironmentInput = Pick<TestEnvironment, 'name' | 'deployment'> & {
  mutationId: string;
};

const DeleteEnvironmentResultSchema = z.object({
  deleted: z.boolean(),
  environmentId: EnvironmentIdSchema,
});

export class EnvironmentService {
  private readonly writes: CookingWriteStore;

  constructor(
    private readonly db: AppDatabase,
    private readonly queries: EngineeringQueries,
    private readonly environmentReferenced: (id: string) => boolean,
    private readonly now: () => Date,
    private readonly createId: () => string,
  ) {
    this.writes = new CookingWriteStore(db, now, createId);
  }

  createEnvironments(
    actorUserId: string,
    engineeringId: string,
    environments: EnvironmentInput[],
  ): TestEnvironment[] {
    validateEnvironments(environments, '至少添加一个测试环境');
    return this.db.transaction(() =>
      environments.map((environment) =>
        this.createEnvironment(actorUserId, engineeringId, environment),
      ),
    )();
  }

  createEnvironment(
    actorUserId: string,
    engineeringId: string,
    input: EnvironmentInput,
  ): TestEnvironment {
    const name = EnvironmentNameSchema.parse(input.name);
    const deployment = DeploymentMethodSchema.parse(input.deployment);
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'ENVIRONMENT_CREATE',
      resourceType: 'ENVIRONMENT',
      resultSchema: TestEnvironmentSchema,
      perform: () => {
        const engineering = this.queries.requireEngineeringOwner(
          actorUserId,
          engineeringId,
        );
        if (engineering.archivedAt)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '已归档工程不能创建环境',
          );
        this.queries.ensureEnvironmentNameAvailable(engineeringId, name);
        const id = this.createId();
        const createdAt = this.now().toISOString();
        const stored = this.db.get<EnvironmentRow>(
          `INSERT INTO cooking_environment(
               id, engineering_id, name, deployment_json, version,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, 1, ?, ?) RETURNING *`,
          id,
          engineeringId,
          name,
          JSON.stringify(deployment),
          createdAt,
          createdAt,
        )!;
        return {
          result: mapEnvironment(stored),
          resourceId: id,
          audits: [
            {
              projectId: engineering.projectId,
              action: 'ENVIRONMENT_CREATED',
              targetType: 'ENVIRONMENT',
              targetId: id,
              details: { name, deployment },
            },
          ],
        };
      },
    });
  }

  updateEnvironment(
    actorUserId: string,
    environmentId: string,
    input: EnvironmentInput & { expectedVersion: number },
  ): TestEnvironment {
    const name = EnvironmentNameSchema.parse(input.name);
    const deployment = DeploymentMethodSchema.parse(input.deployment);
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'ENVIRONMENT_UPDATE',
      resourceType: 'ENVIRONMENT',
      resultSchema: TestEnvironmentSchema,
      perform: () => {
        const current = this.queries.requireEnvironmentOwner(
          actorUserId,
          environmentId,
        );
        if (current.version !== input.expectedVersion)
          throw new PlatformError('STALE_STATE', '环境已更新，请刷新后重试');
        if (this.environmentReferenced(environmentId))
          throw new PlatformError(
            'RESOURCE_CONFLICT',
            '环境正在被活动提测引用，暂时不能修改部署配置',
          );
        if (current.name.toLowerCase() !== name.toLowerCase())
          this.queries.ensureEnvironmentNameAvailable(
            current.engineeringId,
            name,
          );
        const engineering = this.queries.requireEngineeringOwner(
          actorUserId,
          current.engineeringId,
        );
        if (engineering.archivedAt)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '已归档工程的环境不能修改',
          );
        const updatedAt = this.now().toISOString();
        const update = this.db.get<EnvironmentRow>(
          `UPDATE cooking_environment
             SET name = ?, deployment_json = ?, version = version + 1,
                 updated_at = ?
             WHERE id = ? AND version = ? RETURNING *`,
          name,
          JSON.stringify(deployment),
          updatedAt,
          environmentId,
          input.expectedVersion,
        );
        if (!update)
          throw new PlatformError('STALE_STATE', '环境已更新，请刷新后重试');
        return {
          result: mapEnvironment(update),
          resourceId: environmentId,
          audits: [
            {
              projectId: engineering.projectId,
              action: 'ENVIRONMENT_UPDATED',
              targetType: 'ENVIRONMENT',
              targetId: environmentId,
              details: { name, deployment },
            },
          ],
        };
      },
    });
  }

  deleteEnvironment(
    actorUserId: string,
    environmentId: string,
    input: { mutationId: string; expectedVersion: number },
  ): { deleted: boolean; environmentId: string } {
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'ENVIRONMENT_DELETE',
      resourceType: 'ENVIRONMENT',
      resultSchema: DeleteEnvironmentResultSchema,
      perform: () => {
        const current = this.queries.requireEnvironmentOwner(
          actorUserId,
          environmentId,
        );
        if (current.version !== input.expectedVersion)
          throw new PlatformError('STALE_STATE', '环境已更新，请刷新后重试');
        if (this.environmentReferenced(environmentId))
          throw new PlatformError(
            'RESOURCE_CONFLICT',
            '环境正在被活动提测引用，暂时不能删除',
          );
        const engineering = this.queries.requireEngineeringOwner(
          actorUserId,
          current.engineeringId,
        );
        if (engineering.archivedAt)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '已归档工程的环境不能删除',
          );
        const deleted = this.db.run(
          'DELETE FROM cooking_environment WHERE id = ? AND version = ?',
          [environmentId, input.expectedVersion],
        );
        if (deleted.changes !== 1)
          throw new PlatformError('STALE_STATE', '环境已更新，请刷新后重试');
        return {
          result: { deleted: true, environmentId },
          resourceId: environmentId,
          audits: [
            {
              projectId: engineering.projectId,
              action: 'ENVIRONMENT_DELETED',
              targetType: 'ENVIRONMENT',
              targetId: environmentId,
            },
          ],
        };
      },
    });
  }
}

export function validateEnvironments(
  environments: readonly { mutationId: string }[],
  emptyMessage: string,
): void {
  if (!environments.length)
    throw new PlatformError('VALIDATION_FAILED', emptyMessage);
  if (
    new Set(environments.map(({ mutationId }) => mutationId)).size !==
    environments.length
  )
    throw new PlatformError('VALIDATION_FAILED', '测试环境的操作标识不能重复');
}
