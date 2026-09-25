import { requireProjectMember } from '@/cooking/shared/server/access';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import { ProjectIdSchema } from '@/cooking/projects/contract';
import { CookingMutationIdSchema } from '@/cooking/shared/contract';
import { CookingWriteStore } from '@/cooking/shared/server/write-store';
import {
  EngineeringIdentifierSchema,
  EngineeringMembershipSchema,
  EngineeringNameSchema,
  EngineeringSchema,
  EngineeringTypeSchema,
  type Engineering,
  type EngineeringMembership,
} from '../contract';
import {
  EngineeringQueries,
  mapEngineering,
  mapMembership,
  type EngineeringRow,
  type EngineeringMembershipRow,
} from './engineering-queries';
import {
  EnvironmentService,
  validateEnvironments,
  type EnvironmentInput,
} from './environment-service';

type EngineeringInput = Pick<Engineering, 'name' | 'type' | 'identifier'> & {
  mutationId: string;
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

export class EngineeringService {
  private readonly writes: CookingWriteStore;
  private readonly queries: EngineeringQueries;
  readonly listEngineering: EngineeringQueries['listEngineering'];
  readonly getEngineering: EngineeringQueries['getEngineering'];
  readonly getWorkspace: EngineeringQueries['getWorkspace'];
  readonly listMembers: EngineeringQueries['listMembers'];
  readonly listEnvironments: EngineeringQueries['listEnvironments'];
  readonly createEnvironments: EnvironmentService['createEnvironments'];
  readonly createEnvironment: EnvironmentService['createEnvironment'];
  readonly updateEnvironment: EnvironmentService['updateEnvironment'];
  readonly deleteEnvironment: EnvironmentService['deleteEnvironment'];

  constructor(
    private readonly db: AppDatabase,
    private readonly guards: EngineeringGuards = DEFAULT_GUARDS,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {
    this.writes = new CookingWriteStore(db, now, createId);
    this.queries = new EngineeringQueries(db);
    const environments = new EnvironmentService(
      db,
      this.queries,
      (id) => guards.environmentReferenced(id),
      now,
      createId,
    );
    this.listEngineering = this.queries.listEngineering.bind(this.queries);
    this.getEngineering = this.queries.getEngineering.bind(this.queries);
    this.getWorkspace = this.queries.getWorkspace.bind(this.queries);
    this.listMembers = this.queries.listMembers.bind(this.queries);
    this.listEnvironments = this.queries.listEnvironments.bind(this.queries);
    this.createEnvironments =
      environments.createEnvironments.bind(environments);
    this.createEnvironment = environments.createEnvironment.bind(environments);
    this.updateEnvironment = environments.updateEnvironment.bind(environments);
    this.deleteEnvironment = environments.deleteEnvironment.bind(environments);
  }

  createEngineeringSetup(
    actorUserId: string,
    projectId: string,
    input: EngineeringInput & {
      creatorMembershipMutationId: string;
      members: Array<{ userId: string; mutationId: string }>;
      environments: EnvironmentInput[];
    },
  ): Engineering {
    validateEnvironments(input.environments, '新建工程时至少配置一个测试环境');
    return this.db.transaction(() => {
      const engineering = this.createEngineering(actorUserId, projectId, {
        mutationId: input.mutationId,
        name: input.name,
        type: input.type,
        identifier: input.identifier,
      });
      this.addMember(actorUserId, engineering.id, actorUserId, {
        mutationId: input.creatorMembershipMutationId,
      });
      for (const member of input.members)
        this.addMember(actorUserId, engineering.id, member.userId, {
          mutationId: member.mutationId,
        });
      for (const environment of input.environments)
        this.createEnvironment(actorUserId, engineering.id, environment);
      return engineering;
    })();
  }

  createEngineering(
    actorUserId: string,
    projectId: string,
    input: EngineeringInput,
  ): Engineering {
    ProjectIdSchema.parse(projectId);
    CookingMutationIdSchema.parse(input.mutationId);
    const name = EngineeringNameSchema.parse(input.name);
    const type = EngineeringTypeSchema.parse(input.type);
    const identifier = EngineeringIdentifierSchema.parse(input.identifier);
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'ENGINEERING_CREATE',
      resourceType: 'ENGINEERING',
      resultSchema: EngineeringSchema,
      perform: () => {
        this.queries.requireProjectOwner(actorUserId, projectId);
        this.queries.ensureEngineeringNameAvailable(projectId, name);
        this.queries.ensureEngineeringIdentifierAvailable(
          projectId,
          identifier,
        );
        const id = this.createId();
        const createdAt = this.now().toISOString();
        const stored = this.db.get<EngineeringRow>(
          `INSERT INTO cooking_engineering(
               id, project_id, name, type, identifier, repository_state,
               repository_url, version, archived_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 'PENDING', NULL, 1, NULL, ?, ?) RETURNING *`,
          id,
          projectId,
          name,
          type,
          identifier,
          createdAt,
          createdAt,
        )!;
        return {
          result: mapEngineering(stored),
          resourceId: id,
          audits: [
            {
              projectId,
              action: 'ENGINEERING_CREATED',
              targetType: 'ENGINEERING',
              targetId: id,
              details: { name, type, identifier },
            },
          ],
        };
      },
    });
  }

  isIdentifierLocked(userId: string, engineeringId: string): boolean {
    this.getEngineering(userId, engineeringId);
    return this.guards.engineeringReferenced(engineeringId);
  }

  updateEngineering(
    actorUserId: string,
    engineeringId: string,
    input: EngineeringInput & { expectedVersion: number },
  ): Engineering {
    const name = EngineeringNameSchema.parse(input.name);
    const type = EngineeringTypeSchema.parse(input.type);
    const identifier = EngineeringIdentifierSchema.parse(input.identifier);
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: 'ENGINEERING_UPDATE',
      resourceType: 'ENGINEERING',
      resultSchema: EngineeringSchema,
      perform: () => {
        const current = this.queries.requireEngineeringOwner(
          actorUserId,
          engineeringId,
        );
        if (current.archivedAt)
          throw new PlatformError('INVALID_TRANSITION', '已归档工程不能修改');
        if (current.version !== input.expectedVersion)
          throw new PlatformError('STALE_STATE', '工程已更新，请刷新后重试');
        if (
          current.identifier !== identifier &&
          this.guards.engineeringReferenced(engineeringId)
        )
          throw new PlatformError(
            'RESOURCE_CONFLICT',
            '工程已被提测引用，稳定标识不能修改',
          );
        if (current.name.toLowerCase() !== name.toLowerCase())
          this.queries.ensureEngineeringNameAvailable(current.projectId, name);
        if (current.identifier !== identifier)
          this.queries.ensureEngineeringIdentifierAvailable(
            current.projectId,
            identifier,
            engineeringId,
          );
        const updatedAt = this.now().toISOString();
        const update = this.db.get<EngineeringRow>(
          `UPDATE cooking_engineering
             SET name = ?, type = ?, identifier = ?, version = version + 1,
                 updated_at = ?
             WHERE id = ? AND version = ? AND archived_at IS NULL RETURNING *`,
          name,
          type,
          identifier,
          updatedAt,
          engineeringId,
          input.expectedVersion,
        );
        if (!update)
          throw new PlatformError('STALE_STATE', '工程已更新，请刷新后重试');
        return {
          result: mapEngineering(update),
          resourceId: engineeringId,
          audits: [
            {
              projectId: current.projectId,
              action: 'ENGINEERING_UPDATED',
              targetType: 'ENGINEERING',
              targetId: engineeringId,
              details: { name, type, identifier },
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
        const current = this.queries.requireEngineeringOwner(
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
        const update = this.db.get<EngineeringRow>(
          `UPDATE cooking_engineering
             SET archived_at = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND archived_at IS NULL RETURNING *`,
          archivedAt,
          archivedAt,
          engineeringId,
          input.expectedVersion,
        );
        if (!update)
          throw new PlatformError('STALE_STATE', '工程已更新，请刷新后重试');
        return {
          result: mapEngineering(update),
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
        const engineering = this.queries.requireEngineeringOwner(
          actorUserId,
          engineeringId,
        );
        if (engineering.archivedAt)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '已归档工程不能增加成员',
          );
        requireProjectMember(this.db, targetUserId, engineering.projectId);
        const existing = this.db.get(
          `SELECT engineering_id, user_id, version, created_at
             FROM cooking_engineering_membership
             WHERE engineering_id = ? AND user_id = ?`,
          engineeringId,
          targetUserId,
        ) as EngineeringMembershipRow | undefined;
        if (existing)
          return {
            result: mapMembership(existing),
            resourceId: `${engineeringId}:${targetUserId}`,
          };
        const createdAt = this.now().toISOString();
        const stored = this.db.get<EngineeringMembershipRow>(
          `INSERT INTO cooking_engineering_membership(
               engineering_id, user_id, version, created_at
             ) VALUES (?, ?, 1, ?) RETURNING *`,
          engineeringId,
          targetUserId,
          createdAt,
        )!;
        return {
          result: mapMembership(stored),
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
        const engineering = this.queries.requireEngineeringOwner(
          actorUserId,
          engineeringId,
        );
        const row = this.db.get(
          `SELECT engineering_id, user_id, version, created_at
             FROM cooking_engineering_membership
             WHERE engineering_id = ? AND user_id = ?`,
          engineeringId,
          targetUserId,
        ) as EngineeringMembershipRow | undefined;
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
        this.db.run(
          `DELETE FROM cooking_engineering_membership
             WHERE engineering_id = ? AND user_id = ? AND version = ?`,
          [engineeringId, targetUserId, input.expectedVersion],
        );
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
}
