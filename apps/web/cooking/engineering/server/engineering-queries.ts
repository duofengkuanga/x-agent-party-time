import { requireProjectMember } from '@/cooking/shared/server/access';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import {
  EngineeringIdSchema,
  EngineeringMemberSchema,
  EngineeringMembershipSchema,
  EngineeringSchema,
  EngineeringWorkspaceSchema,
  TestEnvironmentSchema,
  type Engineering,
  type EngineeringMember,
  type EngineeringMembership,
  type EngineeringWorkspace,
  type TestEnvironment,
} from '../contract';

export type EngineeringRow = {
  id: string;
  project_id: string;
  name: string;
  type: 'FRONTEND' | 'BACKEND';
  identifier: string;
  repository_state: 'PENDING' | 'CONFIRMED';
  repository_url: string | null;
  version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type EngineeringMembershipRow = {
  engineering_id: string;
  user_id: string;
  version: number;
  created_at: string;
};

export type EnvironmentRow = {
  id: string;
  engineering_id: string;
  name: string;
  deployment_json: string;
  version: number;
  created_at: string;
  updated_at: string;
};

export class EngineeringQueries {
  constructor(private readonly db: AppDatabase) {}

  listEngineering(userId: string, projectId: string): Engineering[] {
    requireProjectMember(this.db, userId, projectId);
    return this.db
      .all<EngineeringRow>(
        `SELECT id, project_id, name, type, identifier, repository_state,
                repository_url, version, archived_at, created_at, updated_at
         FROM cooking_engineering
         WHERE project_id = ?
         ORDER BY archived_at IS NOT NULL, name COLLATE NOCASE, id`,
        projectId,
      )
      .map(mapEngineering);
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

  listMembers(userId: string, engineeringId: string): EngineeringMember[] {
    this.getEngineering(userId, engineeringId);
    return this.db
      .all(
        `SELECT m.engineering_id, m.user_id, m.version, m.created_at,
                u.username, u.display_name, u.created_at user_created_at
         FROM cooking_engineering_membership m
         JOIN platform_user u ON u.id = m.user_id
         WHERE m.engineering_id = ?
         ORDER BY u.display_name, u.id`,
        engineeringId,
      )
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

  listEnvironments(userId: string, engineeringId: string): TestEnvironment[] {
    this.getEngineering(userId, engineeringId);
    return this.db
      .all<EnvironmentRow>(
        `SELECT id, engineering_id, name, deployment_json, version,
                created_at, updated_at
         FROM cooking_environment
         WHERE engineering_id = ?
         ORDER BY name COLLATE NOCASE, id`,
        engineeringId,
      )
      .map(mapEnvironment);
  }

  requireProjectOwner(userId: string, projectId: string): void {
    const membership = requireProjectMember(this.db, userId, projectId);
    if (membership.role !== 'OWNER')
      throw new PlatformError(
        'PERMISSION_DENIED',
        '只有项目所有者可以管理工程',
      );
  }

  private engineeringForProjectMember(
    userId: string,
    engineeringId: string,
  ): EngineeringRow & { role: 'OWNER' | 'MEMBER' } {
    const row = this.db.get(
      `SELECT e.id, e.project_id, e.name, e.type, e.identifier,
                e.repository_state, e.repository_url, e.version,
                e.archived_at, e.created_at, e.updated_at, p.role
         FROM cooking_engineering e
         JOIN cooking_project_membership p
           ON p.project_id = e.project_id AND p.user_id = ?
         WHERE e.id = ?`,
      userId,
      engineeringId,
    ) as (EngineeringRow & { role: 'OWNER' | 'MEMBER' }) | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '工程不存在或无权访问');
    return row;
  }

  requireEngineeringOwner(userId: string, engineeringId: string): Engineering {
    const row = this.engineeringForProjectMember(userId, engineeringId);
    if (row.role !== 'OWNER')
      throw new PlatformError(
        'PERMISSION_DENIED',
        '只有项目所有者可以管理工程',
      );
    return mapEngineering(row);
  }

  requireEnvironmentOwner(
    userId: string,
    environmentId: string,
  ): TestEnvironment {
    const row = this.db.get(
      `SELECT env.id, env.engineering_id, env.name, env.deployment_json,
                env.version, env.created_at, env.updated_at, p.role
         FROM cooking_environment env
         JOIN cooking_engineering e ON e.id = env.engineering_id
         JOIN cooking_project_membership p
           ON p.project_id = e.project_id AND p.user_id = ?
         WHERE env.id = ?`,
      userId,
      environmentId,
    ) as (EnvironmentRow & { role: 'OWNER' | 'MEMBER' }) | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '环境不存在或无权访问');
    if (row.role !== 'OWNER')
      throw new PlatformError(
        'PERMISSION_DENIED',
        '只有项目所有者可以管理环境',
      );
    return mapEnvironment(row);
  }

  ensureEngineeringNameAvailable(projectId: string, name: string): void {
    const existing = this.db.get(
      `SELECT 1 present FROM cooking_engineering
         WHERE project_id = ? AND name = ? COLLATE NOCASE AND archived_at IS NULL`,
      projectId,
      name,
    );
    if (existing)
      throw new PlatformError('RESOURCE_CONFLICT', '项目中已存在同名工程');
  }

  ensureEngineeringIdentifierAvailable(
    projectId: string,
    identifier: string,
    excludedEngineeringId?: string,
  ): void {
    const existing = this.db.get(
      `SELECT 1 present FROM cooking_engineering
         WHERE project_id = ? AND identifier = ? COLLATE NOCASE
           AND (? IS NULL OR id <> ?)`,
      projectId,
      identifier,
      excludedEngineeringId ?? null,
      excludedEngineeringId ?? null,
    );
    if (existing)
      throw new PlatformError('RESOURCE_CONFLICT', '项目中已存在相同工程标识');
  }

  ensureEnvironmentNameAvailable(engineeringId: string, name: string): void {
    const existing = this.db.get(
      `SELECT 1 present FROM cooking_environment
         WHERE engineering_id = ? AND name = ? COLLATE NOCASE`,
      engineeringId,
      name,
    );
    if (existing)
      throw new PlatformError('RESOURCE_CONFLICT', '工程中已存在同名环境');
  }
}

export function mapEngineering(row: EngineeringRow): Engineering {
  return EngineeringSchema.parse({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    type: row.type,
    identifier: row.identifier,
    repositoryState: row.repository_state,
    ...(row.repository_state === 'CONFIRMED'
      ? { repositoryUrl: row.repository_url }
      : {}),
    version: row.version,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function mapMembership(
  row: EngineeringMembershipRow,
): EngineeringMembership {
  return EngineeringMembershipSchema.parse({
    engineeringId: row.engineering_id,
    userId: row.user_id,
    version: row.version,
    createdAt: row.created_at,
  });
}

export function mapEnvironment(row: EnvironmentRow): TestEnvironment {
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
