import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppDatabase } from '@/server/database';
import { PlatformError } from '@/server/errors';
import { ProjectIdSchema } from '@/features/cooking/projects/contract';
import { CookingMutationIdSchema } from '@/features/cooking/shared/contract';
import { CookingWriteStore } from '@/features/cooking/shared/write-store';
import {
  DeploymentMethodSchema,
  EngineeringIdSchema,
  EngineeringMemberSchema,
  EngineeringMembershipSchema,
  EngineeringNameSchema,
  EngineeringSchema,
  EngineeringWorkspaceSchema,
  EnvironmentIdSchema,
  EnvironmentNameSchema,
  RepositoryUrlSchema,
  TestEnvironmentSchema,
  type DeploymentMethod,
  type Engineering,
  type EngineeringMember,
  type EngineeringMembership,
  type EngineeringWorkspace,
  type TestEnvironment,
} from '../contract';

type EngineeringRow = {
  id: string;
  project_id: string;
  name: string;
  repository_url: string;
  version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type EngineeringMembershipRow = {
  engineering_id: string;
  user_id: string;
  version: number;
  created_at: string;
};

type EnvironmentRow = {
  id: string;
  engineering_id: string;
  name: string;
  deployment_json: string;
  version: number;
  created_at: string;
  updated_at: string;
};

export type EngineeringGuards = {
  engineeringReferenced: (engineeringId: string) => boolean;
  environmentReferenced: (environmentId: string) => boolean;
  memberHasActiveResponsibilities: (
    engineeringId: string,
    userId: string,
  ) => boolean;
};

const DEFAULT_GUARDS: EngineeringGuards = {
  engineeringReferenced: () => false,
  environmentReferenced: () => false,
  memberHasActiveResponsibilities: () => false,
};

const RemoveEngineeringMemberResultSchema = z.object({
  removed: z.boolean(),
  userId: z.string().trim().min(1).max(80),
});
const DeleteEnvironmentResultSchema = z.object({
  deleted: z.boolean(),
  environmentId: EnvironmentIdSchema,
});

export class EngineeringService {
  private readonly writes: CookingWriteStore;

  constructor(
    private readonly db: AppDatabase,
    private readonly guards: EngineeringGuards = DEFAULT_GUARDS,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {
    this.writes = new CookingWriteStore(db, now, createId);
  }

  createEngineering(
    actorUserId: string,
    projectId: string,
    input: {
      mutationId: string;
      name: string;
      repositoryUrl: string;
    },
  ): Engineering {
    ProjectIdSchema.parse(projectId);
    CookingMutationIdSchema.parse(input.mutationId);
    const name = EngineeringNameSchema.parse(input.name);
    const repositoryUrl = RepositoryUrlSchema.parse(input.repositoryUrl);
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'ENGINEERING_CREATE',
      resourceType: 'ENGINEERING',
      resultSchema: EngineeringSchema,
      perform: () => {
        this.requireProjectOwner(actorUserId, projectId);
        this.ensureEngineeringNameAvailable(projectId, name);
        const id = this.createId();
        const createdAt = this.now().toISOString();
        this.db
          .prepare(
            `INSERT INTO cooking_engineering(
               id, project_id, name, repository_url, version, archived_at,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, 1, NULL, ?, ?)`,
          )
          .run(id, projectId, name, repositoryUrl, createdAt, createdAt);
        const result = EngineeringSchema.parse({
          id,
          projectId,
          name,
          repositoryUrl,
          version: 1,
          archivedAt: null,
          createdAt,
          updatedAt: createdAt,
        });
        return {
          result,
          resourceId: id,
          audits: [
            {
              projectId,
              action: 'ENGINEERING_CREATED',
              targetType: 'ENGINEERING',
              targetId: id,
              details: { name, repositoryUrl },
            },
          ],
        };
      },
    });
  }

  listEngineering(userId: string, projectId: string): Engineering[] {
    this.requireProjectMember(userId, projectId);
    return this.db
      .prepare(
        `SELECT id, project_id, name, repository_url, version, archived_at,
                created_at, updated_at
         FROM cooking_engineering
         WHERE project_id = ?
         ORDER BY archived_at IS NOT NULL, name COLLATE NOCASE, id`,
      )
      .all(projectId)
      .map((row) => mapEngineering(row as EngineeringRow));
  }

  getEngineering(userId: string, engineeringId: string): Engineering {
    EngineeringIdSchema.parse(engineeringId);
    const row = this.engineeringForProjectMember(userId, engineeringId);
    return mapEngineering(row);
  }

  getWorkspace(userId: string, engineeringId: string): EngineeringWorkspace {
    const engineering = this.getEngineering(userId, engineeringId);
    return EngineeringWorkspaceSchema.parse({
      engineering,
      members: this.listMembers(userId, engineeringId),
      environments: this.listEnvironments(userId, engineeringId),
    });
  }

  updateEngineering(
    actorUserId: string,
    engineeringId: string,
    input: {
      mutationId: string;
      expectedVersion: number;
      name: string;
      repositoryUrl: string;
    },
  ): Engineering {
    const name = EngineeringNameSchema.parse(input.name);
    const repositoryUrl = RepositoryUrlSchema.parse(input.repositoryUrl);
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'ENGINEERING_UPDATE',
      resourceType: 'ENGINEERING',
      resultSchema: EngineeringSchema,
      perform: () => {
        const current = this.requireEngineeringOwner(
          actorUserId,
          engineeringId,
        );
        if (current.archivedAt)
          throw new PlatformError('INVALID_TRANSITION', '已归档工程不能修改');
        if (current.version !== input.expectedVersion)
          throw new PlatformError('STALE_STATE', '工程已更新，请刷新后重试');
        if (this.guards.engineeringReferenced(engineeringId))
          throw new PlatformError(
            'RESOURCE_CONFLICT',
            '工程正在被活动提测引用，暂时不能修改',
          );
        if (current.name.toLowerCase() !== name.toLowerCase())
          this.ensureEngineeringNameAvailable(current.projectId, name);
        const updatedAt = this.now().toISOString();
        const update = this.db
          .prepare(
            `UPDATE cooking_engineering
             SET name = ?, repository_url = ?, version = version + 1,
                 updated_at = ?
             WHERE id = ? AND version = ? AND archived_at IS NULL`,
          )
          .run(
            name,
            repositoryUrl,
            updatedAt,
            engineeringId,
            input.expectedVersion,
          );
        if (update.changes !== 1)
          throw new PlatformError('STALE_STATE', '工程已更新，请刷新后重试');
        const result = EngineeringSchema.parse({
          ...current,
          name,
          repositoryUrl,
          version: current.version + 1,
          updatedAt,
        });
        return {
          result,
          resourceId: engineeringId,
          audits: [
            {
              projectId: current.projectId,
              action: 'ENGINEERING_UPDATED',
              targetType: 'ENGINEERING',
              targetId: engineeringId,
              details: { name, repositoryUrl },
            },
          ],
        };
      },
    });
  }

  archiveEngineering(
    actorUserId: string,
    engineeringId: string,
    input: { mutationId: string; expectedVersion: number },
  ): Engineering {
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'ENGINEERING_ARCHIVE',
      resourceType: 'ENGINEERING',
      resultSchema: EngineeringSchema,
      perform: () => {
        const current = this.requireEngineeringOwner(
          actorUserId,
          engineeringId,
        );
        if (current.archivedAt)
          return { result: current, resourceId: engineeringId };
        if (current.version !== input.expectedVersion)
          throw new PlatformError('STALE_STATE', '工程已更新，请刷新后重试');
        if (this.guards.engineeringReferenced(engineeringId))
          throw new PlatformError(
            'RESOURCE_CONFLICT',
            '工程正在被活动提测引用，暂时不能归档',
          );
        const archivedAt = this.now().toISOString();
        const update = this.db
          .prepare(
            `UPDATE cooking_engineering
             SET archived_at = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND archived_at IS NULL`,
          )
          .run(archivedAt, archivedAt, engineeringId, input.expectedVersion);
        if (update.changes !== 1)
          throw new PlatformError('STALE_STATE', '工程已更新，请刷新后重试');
        const result = EngineeringSchema.parse({
          ...current,
          archivedAt,
          version: current.version + 1,
          updatedAt: archivedAt,
        });
        return {
          result,
          resourceId: engineeringId,
          audits: [
            {
              projectId: current.projectId,
              action: 'ENGINEERING_ARCHIVED',
              targetType: 'ENGINEERING',
              targetId: engineeringId,
            },
          ],
        };
      },
    });
  }

  listMembers(userId: string, engineeringId: string): EngineeringMember[] {
    this.getEngineering(userId, engineeringId);
    return this.db
      .prepare(
        `SELECT m.engineering_id, m.user_id, m.version, m.created_at,
                u.username, u.display_name, u.created_at user_created_at
         FROM cooking_engineering_membership m
         JOIN platform_user u ON u.id = m.user_id
         WHERE m.engineering_id = ?
         ORDER BY u.display_name, u.id`,
      )
      .all(engineeringId)
      .map((row) => {
        const value = row as EngineeringMembershipRow & {
          username: string;
          display_name: string;
          user_created_at: string;
        };
        return EngineeringMemberSchema.parse({
          membership: mapMembership(value),
          user: {
            id: value.user_id,
            username: value.username,
            displayName: value.display_name,
            createdAt: value.user_created_at,
          },
        });
      });
  }

  addMember(
    actorUserId: string,
    engineeringId: string,
    targetUserId: string,
    input: { mutationId: string },
  ): EngineeringMembership {
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'ENGINEERING_MEMBER_ADD',
      resourceType: 'ENGINEERING_MEMBERSHIP',
      resultSchema: EngineeringMembershipSchema,
      perform: () => {
        const engineering = this.requireEngineeringOwner(
          actorUserId,
          engineeringId,
        );
        if (engineering.archivedAt)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '已归档工程不能增加成员',
          );
        this.requireProjectMember(targetUserId, engineering.projectId);
        const existing = this.db
          .prepare(
            `SELECT engineering_id, user_id, version, created_at
             FROM cooking_engineering_membership
             WHERE engineering_id = ? AND user_id = ?`,
          )
          .get(engineeringId, targetUserId) as
          EngineeringMembershipRow | undefined;
        if (existing)
          return {
            result: mapMembership(existing),
            resourceId: `${engineeringId}:${targetUserId}`,
          };
        const createdAt = this.now().toISOString();
        this.db
          .prepare(
            `INSERT INTO cooking_engineering_membership(
               engineering_id, user_id, version, created_at
             ) VALUES (?, ?, 1, ?)`,
          )
          .run(engineeringId, targetUserId, createdAt);
        const result = EngineeringMembershipSchema.parse({
          engineeringId,
          userId: targetUserId,
          version: 1,
          createdAt,
        });
        return {
          result,
          resourceId: `${engineeringId}:${targetUserId}`,
          audits: [
            {
              projectId: engineering.projectId,
              action: 'ENGINEERING_MEMBER_ADDED',
              targetType: 'ENGINEERING_MEMBERSHIP',
              targetId: targetUserId,
            },
          ],
        };
      },
    });
  }

  removeMember(
    actorUserId: string,
    engineeringId: string,
    targetUserId: string,
    input: { mutationId: string; expectedVersion: number },
  ): { removed: boolean; userId: string } {
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'ENGINEERING_MEMBER_REMOVE',
      resourceType: 'ENGINEERING_MEMBERSHIP',
      resultSchema: RemoveEngineeringMemberResultSchema,
      perform: () => {
        const engineering = this.requireEngineeringOwner(
          actorUserId,
          engineeringId,
        );
        const row = this.db
          .prepare(
            `SELECT engineering_id, user_id, version, created_at
             FROM cooking_engineering_membership
             WHERE engineering_id = ? AND user_id = ?`,
          )
          .get(engineeringId, targetUserId) as
          EngineeringMembershipRow | undefined;
        if (!row)
          return {
            result: { removed: false, userId: targetUserId },
            resourceId: `${engineeringId}:${targetUserId}`,
          };
        if (row.version !== input.expectedVersion)
          throw new PlatformError('STALE_STATE', '工程成员关系已更新');
        if (
          this.guards.memberHasActiveResponsibilities(
            engineeringId,
            targetUserId,
          )
        )
          throw new PlatformError(
            'RESOURCE_CONFLICT',
            '该工程成员仍有活动职责，暂时不能移除',
          );
        this.db
          .prepare(
            `DELETE FROM cooking_engineering_membership
             WHERE engineering_id = ? AND user_id = ? AND version = ?`,
          )
          .run(engineeringId, targetUserId, input.expectedVersion);
        return {
          result: { removed: true, userId: targetUserId },
          resourceId: `${engineeringId}:${targetUserId}`,
          audits: [
            {
              projectId: engineering.projectId,
              action: 'ENGINEERING_MEMBER_REMOVED',
              targetType: 'ENGINEERING_MEMBERSHIP',
              targetId: targetUserId,
            },
          ],
        };
      },
    });
  }

  createEnvironment(
    actorUserId: string,
    engineeringId: string,
    input: {
      mutationId: string;
      name: string;
      deployment: DeploymentMethod;
    },
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
        const engineering = this.requireEngineeringOwner(
          actorUserId,
          engineeringId,
        );
        if (engineering.archivedAt)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '已归档工程不能创建环境',
          );
        this.ensureEnvironmentNameAvailable(engineeringId, name);
        const id = this.createId();
        const createdAt = this.now().toISOString();
        this.db
          .prepare(
            `INSERT INTO cooking_environment(
               id, engineering_id, name, deployment_json, version,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            id,
            engineeringId,
            name,
            JSON.stringify(deployment),
            createdAt,
            createdAt,
          );
        const result = TestEnvironmentSchema.parse({
          id,
          engineeringId,
          name,
          deployment,
          version: 1,
          createdAt,
          updatedAt: createdAt,
        });
        return {
          result,
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

  listEnvironments(userId: string, engineeringId: string): TestEnvironment[] {
    this.getEngineering(userId, engineeringId);
    return this.db
      .prepare(
        `SELECT id, engineering_id, name, deployment_json, version,
                created_at, updated_at
         FROM cooking_environment
         WHERE engineering_id = ?
         ORDER BY name COLLATE NOCASE, id`,
      )
      .all(engineeringId)
      .map((row) => mapEnvironment(row as EnvironmentRow));
  }

  updateEnvironment(
    actorUserId: string,
    environmentId: string,
    input: {
      mutationId: string;
      expectedVersion: number;
      name: string;
      deployment: DeploymentMethod;
    },
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
        const current = this.requireEnvironmentOwner(
          actorUserId,
          environmentId,
        );
        if (current.version !== input.expectedVersion)
          throw new PlatformError('STALE_STATE', '环境已更新，请刷新后重试');
        if (this.guards.environmentReferenced(environmentId))
          throw new PlatformError(
            'RESOURCE_CONFLICT',
            '环境正在被活动提测引用，暂时不能修改部署配置',
          );
        if (current.name.toLowerCase() !== name.toLowerCase())
          this.ensureEnvironmentNameAvailable(current.engineeringId, name);
        const engineering = this.requireEngineeringOwner(
          actorUserId,
          current.engineeringId,
        );
        if (engineering.archivedAt)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '已归档工程的环境不能修改',
          );
        const updatedAt = this.now().toISOString();
        const update = this.db
          .prepare(
            `UPDATE cooking_environment
             SET name = ?, deployment_json = ?, version = version + 1,
                 updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .run(
            name,
            JSON.stringify(deployment),
            updatedAt,
            environmentId,
            input.expectedVersion,
          );
        if (update.changes !== 1)
          throw new PlatformError('STALE_STATE', '环境已更新，请刷新后重试');
        const result = TestEnvironmentSchema.parse({
          ...current,
          name,
          deployment,
          version: current.version + 1,
          updatedAt,
        });
        return {
          result,
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
        const current = this.requireEnvironmentOwner(
          actorUserId,
          environmentId,
        );
        if (current.version !== input.expectedVersion)
          throw new PlatformError('STALE_STATE', '环境已更新，请刷新后重试');
        if (this.guards.environmentReferenced(environmentId))
          throw new PlatformError(
            'RESOURCE_CONFLICT',
            '环境正在被活动提测引用，暂时不能删除',
          );
        const engineering = this.requireEngineeringOwner(
          actorUserId,
          current.engineeringId,
        );
        if (engineering.archivedAt)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '已归档工程的环境不能删除',
          );
        const deleted = this.db
          .prepare(
            'DELETE FROM cooking_environment WHERE id = ? AND version = ?',
          )
          .run(environmentId, input.expectedVersion);
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

  private requireProjectOwner(userId: string, projectId: string): void {
    const membership = this.db
      .prepare(
        `SELECT role FROM cooking_project_membership
         WHERE project_id = ? AND user_id = ?`,
      )
      .get(projectId, userId) as { role: 'OWNER' | 'MEMBER' } | undefined;
    if (!membership)
      throw new PlatformError('NOT_FOUND', '项目不存在或无权访问');
    if (membership.role !== 'OWNER')
      throw new PlatformError(
        'PERMISSION_DENIED',
        '只有项目所有者可以管理工程',
      );
  }

  private requireProjectMember(userId: string, projectId: string): void {
    const membership = this.db
      .prepare(
        `SELECT 1 present FROM cooking_project_membership
         WHERE project_id = ? AND user_id = ?`,
      )
      .get(projectId, userId);
    if (!membership)
      throw new PlatformError('NOT_FOUND', '项目不存在或无权访问');
  }

  private engineeringForProjectMember(
    userId: string,
    engineeringId: string,
  ): EngineeringRow {
    const row = this.db
      .prepare(
        `SELECT e.id, e.project_id, e.name, e.repository_url, e.version,
                e.archived_at, e.created_at, e.updated_at
         FROM cooking_engineering e
         JOIN cooking_project_membership p
           ON p.project_id = e.project_id AND p.user_id = ?
         WHERE e.id = ?`,
      )
      .get(userId, engineeringId) as EngineeringRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '工程不存在或无权访问');
    return row;
  }

  private requireEngineeringOwner(
    userId: string,
    engineeringId: string,
  ): Engineering {
    const row = this.db
      .prepare(
        `SELECT e.id, e.project_id, e.name, e.repository_url, e.version,
                e.archived_at, e.created_at, e.updated_at, p.role
         FROM cooking_engineering e
         JOIN cooking_project_membership p
           ON p.project_id = e.project_id AND p.user_id = ?
         WHERE e.id = ?`,
      )
      .get(userId, engineeringId) as
      (EngineeringRow & { role: 'OWNER' | 'MEMBER' }) | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '工程不存在或无权访问');
    if (row.role !== 'OWNER')
      throw new PlatformError(
        'PERMISSION_DENIED',
        '只有项目所有者可以管理工程',
      );
    return mapEngineering(row);
  }

  private requireEnvironmentOwner(
    userId: string,
    environmentId: string,
  ): TestEnvironment {
    const row = this.db
      .prepare(
        `SELECT env.id, env.engineering_id, env.name, env.deployment_json,
                env.version, env.created_at, env.updated_at, p.role
         FROM cooking_environment env
         JOIN cooking_engineering e ON e.id = env.engineering_id
         JOIN cooking_project_membership p
           ON p.project_id = e.project_id AND p.user_id = ?
         WHERE env.id = ?`,
      )
      .get(userId, environmentId) as
      (EnvironmentRow & { role: 'OWNER' | 'MEMBER' }) | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '环境不存在或无权访问');
    if (row.role !== 'OWNER')
      throw new PlatformError(
        'PERMISSION_DENIED',
        '只有项目所有者可以管理环境',
      );
    return mapEnvironment(row);
  }

  private ensureEngineeringNameAvailable(
    projectId: string,
    name: string,
  ): void {
    const existing = this.db
      .prepare(
        `SELECT 1 present FROM cooking_engineering
         WHERE project_id = ? AND name = ? COLLATE NOCASE AND archived_at IS NULL`,
      )
      .get(projectId, name);
    if (existing)
      throw new PlatformError('RESOURCE_CONFLICT', '项目中已存在同名工程');
  }

  private ensureEnvironmentNameAvailable(
    engineeringId: string,
    name: string,
  ): void {
    const existing = this.db
      .prepare(
        `SELECT 1 present FROM cooking_environment
         WHERE engineering_id = ? AND name = ? COLLATE NOCASE`,
      )
      .get(engineeringId, name);
    if (existing)
      throw new PlatformError('RESOURCE_CONFLICT', '工程中已存在同名环境');
  }
}

function mapEngineering(row: EngineeringRow): Engineering {
  return EngineeringSchema.parse({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    repositoryUrl: row.repository_url,
    version: row.version,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapMembership(row: EngineeringMembershipRow): EngineeringMembership {
  return EngineeringMembershipSchema.parse({
    engineeringId: row.engineering_id,
    userId: row.user_id,
    version: row.version,
    createdAt: row.created_at,
  });
}

function mapEnvironment(row: EnvironmentRow): TestEnvironment {
  let deployment: unknown;
  try {
    deployment = JSON.parse(row.deployment_json);
  } catch (error) {
    throw new PlatformError('INTERNAL_ERROR', '环境部署配置无效', {
      cause: error,
    });
  }
  return TestEnvironmentSchema.parse({
    id: row.id,
    engineeringId: row.engineering_id,
    name: row.name,
    deployment,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
