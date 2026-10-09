import { parseRow, type DatabaseRow } from '@/platform/database/row-mapper';
import { z } from 'zod';
import { CookingWriteStore } from '@/cooking/shared/server/write-store';
import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import {
  MutationIdSchema,
  ProjectIdSchema,
  ProjectMemberSchema,
  ProjectMembershipSchema,
  ProjectNameSchema,
  ProjectSchema,
  ProjectSummarySchema,
  type Project,
  type ProjectMember,
  type ProjectMembership,
  type ProjectSummary,
} from '../contract';
import { ProjectInvitations } from './project-invitations';

const PROJECT_HIDDEN_MESSAGE = '项目不存在或无权访问';
type ProjectRow = DatabaseRow<Project>;

type ProjectSummaryRow = ProjectRow & {
  user_id: string;
  role: 'OWNER' | 'MEMBER';
  membership_version: number;
  membership_created_at: string;
};

type MembershipRow = DatabaseRow<ProjectMembership>;

export type RemoveMemberResult = { removed: boolean; userId: string };

const RemoveMemberResultSchema = z.unknown().transform(parseRemoveResult);

export class ProjectService {
  private readonly writes: CookingWriteStore;
  readonly inviteUser: ProjectInvitations['inviteUser'];
  readonly listProjectInvitations: ProjectInvitations['listProjectInvitations'];
  readonly listReceivedInvitations: ProjectInvitations['listReceivedInvitations'];
  readonly respondToInvitation: ProjectInvitations['respondToInvitation'];
  readonly revokeInvitation: ProjectInvitations['revokeInvitation'];
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    private readonly hasActiveResponsibilities: (
      projectId: string,
      userId: string,
    ) => boolean = () => false,
  ) {
    this.writes = new CookingWriteStore(db, now, createId);
    const invitations = new ProjectInvitations(
      db,
      this.writes,
      now,
      createId,
      (userId, projectId) => {
        this.requireOwner(userId, projectId);
      },
    );
    this.inviteUser = invitations.inviteUser.bind(invitations);
    this.listProjectInvitations = invitations.listProjectInvitations.bind(invitations);
    this.listReceivedInvitations = invitations.listReceivedInvitations.bind(invitations);
    this.respondToInvitation = invitations.respondToInvitation.bind(invitations);
    this.revokeInvitation = invitations.revokeInvitation.bind(invitations);
  }

  createProject(
    actorUserId: string,
    input: { mutationId: string; name: string },
  ): ProjectSummary {
    const mutationId = MutationIdSchema.parse(input.mutationId);
    const name = ProjectNameSchema.parse(input.name);

    return this.writes.run({
      mutationId,
      actorUserId,
      operation: 'PROJECT_CREATE',
      resourceType: 'PROJECT',
      resultSchema: ProjectSummarySchema,
      perform: () => {
        const projectId = this.createId();
        const createdAt = this.now().toISOString();
        const project = this.db.get<ProjectRow>(
          `INSERT INTO cooking_project(
             id, name, version, created_by_user_id, created_at, updated_at
           ) VALUES (?, ?, 1, ?, ?, ?) RETURNING *`,
          projectId,
          name,
          actorUserId,
          createdAt,
          createdAt,
        );
        const membership = this.db.get<MembershipRow>(
          `INSERT INTO cooking_project_membership(
             project_id, user_id, role, version, created_at
           ) VALUES (?, ?, 'OWNER', 1, ?) RETURNING *`,
          projectId,
          actorUserId,
          createdAt,
        );
        const result = {
          project: mapProject(project!),
          membership: mapMembership(membership!),
        } satisfies ProjectSummary;
        return {
          result: result,
          resourceId: projectId,
          audit: {
            projectId: projectId,
            action: 'PROJECT_CREATED',
            details: {
              name,
            },
          },
        };
      },
    });
  }

  listProjects(userId: string): ProjectSummary[] {
    return this.db
      .all(
        `SELECT p.id, p.name, p.version, p.created_by_user_id, p.created_at,
                p.updated_at, m.user_id, m.role, m.version membership_version,
                m.created_at membership_created_at
         FROM cooking_project_membership m
         JOIN cooking_project p ON p.id = m.project_id
         WHERE m.user_id = ?
         ORDER BY p.updated_at DESC, p.id`,
        userId,
      )
      .map((row) => mapProjectSummary(row as ProjectSummaryRow));
  }

  getProject(userId: string, projectId: string): ProjectSummary {
    ProjectIdSchema.parse(projectId);
    const row = this.db.get(
      `SELECT p.id, p.name, p.version, p.created_by_user_id, p.created_at,
                p.updated_at, m.user_id, m.role, m.version membership_version,
                m.created_at membership_created_at
         FROM cooking_project p
         JOIN cooking_project_membership m ON m.project_id = p.id
         WHERE p.id = ? AND m.user_id = ?`,
      projectId,
      userId,
    ) as ProjectSummaryRow | undefined;
    if (!row) throw hiddenProject();
    return mapProjectSummary(row);
  }

  listMembers(userId: string, projectId: string): ProjectMember[] {
    this.getProject(userId, projectId);
    return this.db
      .all(
        `SELECT m.project_id, m.user_id, m.role, m.version, m.created_at,
                u.username, u.display_name, u.created_at user_created_at
         FROM cooking_project_membership m
         JOIN platform_user u ON u.id = m.user_id
         WHERE m.project_id = ?
         ORDER BY CASE m.role WHEN 'OWNER' THEN 0 ELSE 1 END, u.display_name, u.id`,
        projectId,
      )
      .map((row) => {
        const value = row as MembershipRow & {
          username: string;
          display_name: string;
          user_created_at: string;
        };
        return ProjectMemberSchema.parse({
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

  updateProject(
    actorUserId: string,
    projectId: string,
    input: { mutationId: string; expectedVersion: number; name: string },
  ): Project {
    const mutationId = MutationIdSchema.parse(input.mutationId);
    const name = ProjectNameSchema.parse(input.name);
    return this.writes.run({
      mutationId,
      actorUserId,
      operation: 'PROJECT_UPDATE',
      resourceType: 'PROJECT',
      resultSchema: ProjectSchema,
      perform: () => {
        const current = this.requireOwner(actorUserId, projectId);
        if (current.version !== input.expectedVersion)
          throw new PlatformError('STALE_STATE', '项目已更新，请刷新后重试');
        const updatedAt = this.now().toISOString();
        const updated = this.db.get<ProjectRow>(
          `UPDATE cooking_project SET name = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? RETURNING *`,
          name,
          updatedAt,
          projectId,
          input.expectedVersion,
        );
        if (!updated) throw new PlatformError('STALE_STATE', '项目已更新，请刷新后重试');
        return {
          result: mapProject(updated),
          resourceId: projectId,
          audit: {
            projectId: projectId,
            action: 'PROJECT_UPDATED',
            details: {
              name,
            },
          },
        };
      },
    });
  }

  removeMember(
    actorUserId: string,
    projectId: string,
    targetUserId: string,
    input: { mutationId: string; expectedVersion: number },
  ): RemoveMemberResult {
    const mutationId = MutationIdSchema.parse(input.mutationId);
    return this.writes.run({
      mutationId,
      actorUserId,
      operation: 'PROJECT_MEMBER_REMOVE',
      resourceType: 'PROJECT_MEMBERSHIP',
      resultSchema: RemoveMemberResultSchema,
      perform: () => {
        this.requireOwner(actorUserId, projectId);
        const row = this.db.get(
          `SELECT project_id, user_id, role, version, created_at
           FROM cooking_project_membership
           WHERE project_id = ? AND user_id = ?`,
          projectId,
          targetUserId,
        ) as MembershipRow | undefined;
        if (!row) {
          const result = { removed: false, userId: targetUserId };
          return { result: result, resourceId: targetUserId };
        }
        if (row.version !== input.expectedVersion)
          throw new PlatformError('STALE_STATE', '成员关系已更新，请刷新后重试');
        if (row.role === 'OWNER') {
          const owners = this.db.get(
            `SELECT COUNT(*) count FROM cooking_project_membership
             WHERE project_id = ? AND role = 'OWNER'`,
            projectId,
          ) as { count: number };
          if (owners.count <= 1)
            throw new PlatformError('INVALID_TRANSITION', '项目必须至少保留一名所有者');
        }
        if (this.hasActiveResponsibilities(projectId, targetUserId))
          throw new PlatformError(
            'RESOURCE_CONFLICT',
            '该成员仍有活动职责，暂时不能移除',
          );
        this.db.run(
          `DELETE FROM cooking_project_membership
           WHERE project_id = ? AND user_id = ? AND version = ?`,
          [projectId, targetUserId, input.expectedVersion],
        );
        const result = { removed: true, userId: targetUserId };
        return {
          result: result,
          resourceId: targetUserId,
          audit: {
            projectId: projectId,
            action: 'PROJECT_MEMBER_REMOVED',
            details: {},
          },
        };
      },
    });
  }

  private requireOwner(userId: string, projectId: string): Project {
    const row = this.db.get(
      `SELECT p.id, p.name, p.version, p.created_by_user_id, p.created_at,
                p.updated_at, m.role
         FROM cooking_project p
         JOIN cooking_project_membership m ON m.project_id = p.id
         WHERE p.id = ? AND m.user_id = ?`,
      projectId,
      userId,
    ) as (ProjectRow & { role: string }) | undefined;
    if (!row) throw hiddenProject();
    if (row.role !== 'OWNER')
      throw new PlatformError('PERMISSION_DENIED', '只有项目所有者可以执行此操作');
    return mapProject(row);
  }
}

function mapProject(row: ProjectRow): Project {
  return parseRow(ProjectSchema, row);
}

function mapProjectSummary(row: ProjectSummaryRow): ProjectSummary {
  return ProjectSummarySchema.parse({
    project: mapProject(row),
    membership: {
      projectId: row.id,
      userId: row.user_id,
      role: row.role,
      version: row.membership_version,
      createdAt: row.membership_created_at,
    },
  });
}

function mapMembership(row: MembershipRow): ProjectMembership {
  return parseRow(ProjectMembershipSchema, row);
}

function parseRemoveResult(value: unknown): RemoveMemberResult {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as RemoveMemberResult).removed !== 'boolean' ||
    typeof (value as RemoveMemberResult).userId !== 'string'
  )
    throw new PlatformError('INTERNAL_ERROR', '成员移除结果无效');
  return value as RemoveMemberResult;
}

function hiddenProject(): PlatformError {
  return new PlatformError('NOT_FOUND', PROJECT_HIDDEN_MESSAGE);
}
