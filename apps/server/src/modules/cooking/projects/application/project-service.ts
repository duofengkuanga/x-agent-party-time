import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import {
  MutationIdSchema,
  ProjectIdSchema,
  ProjectInvitationDecisionSchema,
  ProjectInvitationDetailSchema,
  ProjectInvitationSchema,
  ProjectMemberSchema,
  ProjectMembershipSchema,
  ProjectNameSchema,
  ProjectSchema,
  ProjectSummarySchema,
  ReceivedProjectInvitationSchema,
  type Project,
  type ProjectInvitation,
  type ProjectInvitationDetail,
  type ProjectMember,
  type ProjectMembership,
  type ProjectSummary,
  type ReceivedProjectInvitation,
} from '../contract';

const PROJECT_HIDDEN_MESSAGE = '项目不存在或无权访问';
const INVITATION_HIDDEN_MESSAGE = '邀请不存在或无权操作';

type ProjectRow = {
  id: string;
  name: string;
  version: number;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
};

type MembershipRow = {
  project_id: string;
  user_id: string;
  role: 'OWNER' | 'MEMBER';
  version: number;
  created_at: string;
};

type InvitationRow = {
  id: string;
  project_id: string;
  invited_user_id: string;
  invited_by_user_id: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'REVOKED';
  version: number;
  created_at: string;
  responded_at: string | null;
};

type MutationRow = {
  actor_user_id: string;
  operation: string;
  result_json: string;
};

export type RemoveMemberResult = { removed: boolean; userId: string };

export class ProjectService {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    private readonly hasActiveResponsibilities: (
      projectId: string,
      userId: string,
    ) => boolean = () => false,
  ) {}

  createProject(
    actorUserId: string,
    input: { mutationId: string; name: string },
  ): ProjectSummary {
    const mutationId = MutationIdSchema.parse(input.mutationId);
    const name = ProjectNameSchema.parse(input.name);
    const previous = this.readMutation(
      mutationId,
      actorUserId,
      'PROJECT_CREATE',
      ProjectSummarySchema.parse,
    );
    if (previous) return previous;

    return this.db.transaction(() => {
      const projectId = this.createId();
      const createdAt = this.now().toISOString();
      this.db
        .prepare(
          `INSERT INTO cooking_project(
             id, name, version, created_by_user_id, created_at, updated_at
           ) VALUES (?, ?, 1, ?, ?, ?)`,
        )
        .run(projectId, name, actorUserId, createdAt, createdAt);
      this.db
        .prepare(
          `INSERT INTO cooking_project_membership(
             project_id, user_id, role, version, created_at
           ) VALUES (?, ?, 'OWNER', 1, ?)`,
        )
        .run(projectId, actorUserId, createdAt);
      const result = ProjectSummarySchema.parse({
        project: {
          id: projectId,
          name,
          version: 1,
          createdByUserId: actorUserId,
          createdAt,
          updatedAt: createdAt,
        },
        membership: {
          projectId,
          userId: actorUserId,
          role: 'OWNER',
          version: 1,
          createdAt,
        },
      });
      this.audit(
        projectId,
        actorUserId,
        'PROJECT_CREATED',
        'PROJECT',
        projectId,
        {
          name,
        },
      );
      this.recordMutation(
        mutationId,
        actorUserId,
        'PROJECT_CREATE',
        'PROJECT',
        projectId,
        result,
      );
      return result;
    })();
  }

  listProjects(userId: string): ProjectSummary[] {
    return this.db
      .prepare(
        `SELECT p.id, p.name, p.version, p.created_by_user_id, p.created_at,
                p.updated_at, m.user_id, m.role, m.version membership_version,
                m.created_at membership_created_at
         FROM cooking_project_membership m
         JOIN cooking_project p ON p.id = m.project_id
         WHERE m.user_id = ?
         ORDER BY p.updated_at DESC, p.id`,
      )
      .all(userId)
      .map((row) => {
        const value = row as ProjectRow & {
          user_id: string;
          role: 'OWNER' | 'MEMBER';
          membership_version: number;
          membership_created_at: string;
        };
        return ProjectSummarySchema.parse({
          project: mapProject(value),
          membership: {
            projectId: value.id,
            userId: value.user_id,
            role: value.role,
            version: value.membership_version,
            createdAt: value.membership_created_at,
          },
        });
      });
  }

  getProject(userId: string, projectId: string): ProjectSummary {
    ProjectIdSchema.parse(projectId);
    const row = this.db
      .prepare(
        `SELECT p.id, p.name, p.version, p.created_by_user_id, p.created_at,
                p.updated_at, m.user_id, m.role, m.version membership_version,
                m.created_at membership_created_at
         FROM cooking_project p
         JOIN cooking_project_membership m ON m.project_id = p.id
         WHERE p.id = ? AND m.user_id = ?`,
      )
      .get(projectId, userId) as
      | (ProjectRow & {
          user_id: string;
          role: 'OWNER' | 'MEMBER';
          membership_version: number;
          membership_created_at: string;
        })
      | undefined;
    if (!row) throw hiddenProject();
    return ProjectSummarySchema.parse({
      project: mapProject(row),
      membership: {
        projectId,
        userId: row.user_id,
        role: row.role,
        version: row.membership_version,
        createdAt: row.membership_created_at,
      },
    });
  }

  listMembers(userId: string, projectId: string): ProjectMember[] {
    this.getProject(userId, projectId);
    return this.db
      .prepare(
        `SELECT m.project_id, m.user_id, m.role, m.version, m.created_at,
                u.username, u.display_name, u.created_at user_created_at
         FROM cooking_project_membership m
         JOIN platform_user u ON u.id = m.user_id
         WHERE m.project_id = ?
         ORDER BY CASE m.role WHEN 'OWNER' THEN 0 ELSE 1 END, u.display_name, u.id`,
      )
      .all(projectId)
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

  inviteUser(
    actorUserId: string,
    projectId: string,
    input: { mutationId: string; username: string },
  ): ProjectInvitation {
    const mutationId = MutationIdSchema.parse(input.mutationId);
    const username = input.username.trim().toLowerCase();
    const previous = this.readMutation(
      mutationId,
      actorUserId,
      'PROJECT_INVITE',
      ProjectInvitationSchema.parse,
    );
    if (previous) return previous;

    return this.db.transaction(() => {
      this.requireOwner(actorUserId, projectId);
      const user = this.db
        .prepare(
          'SELECT id FROM platform_user WHERE username = ? COLLATE NOCASE',
        )
        .get(username) as { id: string } | undefined;
      if (!user) throw new PlatformError('VALIDATION_FAILED', '邀请用户不存在');
      const member = this.db
        .prepare(
          'SELECT 1 present FROM cooking_project_membership WHERE project_id = ? AND user_id = ?',
        )
        .get(projectId, user.id);
      if (member)
        throw new PlatformError('RESOURCE_CONFLICT', '该用户已经是项目成员');
      const pending = this.db
        .prepare(
          `SELECT id, project_id, invited_user_id, invited_by_user_id, status,
                  version, created_at, responded_at
           FROM cooking_project_invitation
           WHERE project_id = ? AND invited_user_id = ? AND status = 'PENDING'`,
        )
        .get(projectId, user.id) as InvitationRow | undefined;
      const invitation = pending
        ? mapInvitation(pending)
        : this.insertInvitation(projectId, user.id, actorUserId);
      this.audit(
        projectId,
        actorUserId,
        'PROJECT_USER_INVITED',
        'PROJECT_INVITATION',
        invitation.id,
        { invitedUserId: user.id },
      );
      this.recordMutation(
        mutationId,
        actorUserId,
        'PROJECT_INVITE',
        'PROJECT_INVITATION',
        invitation.id,
        invitation,
      );
      return invitation;
    })();
  }

  listProjectInvitations(
    userId: string,
    projectId: string,
  ): ProjectInvitationDetail[] {
    this.requireOwner(userId, projectId);
    return this.db
      .prepare(
        `SELECT i.id, i.project_id, i.invited_user_id, i.invited_by_user_id,
                i.status, i.version, i.created_at, i.responded_at,
                u.username, u.display_name, u.created_at user_created_at
         FROM cooking_project_invitation i
         JOIN platform_user u ON u.id = i.invited_user_id
         WHERE i.project_id = ? AND i.status = 'PENDING'
         ORDER BY i.created_at DESC, i.id`,
      )
      .all(projectId)
      .map((row) => {
        const value = row as InvitationRow & {
          username: string;
          display_name: string;
          user_created_at: string;
        };
        return ProjectInvitationDetailSchema.parse({
          invitation: mapInvitation(value),
          invitedUser: {
            id: value.invited_user_id,
            username: value.username,
            displayName: value.display_name,
            createdAt: value.user_created_at,
          },
        });
      });
  }

  listReceivedInvitations(userId: string): ReceivedProjectInvitation[] {
    return this.db
      .prepare(
        `SELECT i.id, i.project_id, i.invited_user_id, i.invited_by_user_id,
                i.status, i.version, i.created_at, i.responded_at,
                p.name project_name, inviter.display_name inviter_name
         FROM cooking_project_invitation i
         JOIN cooking_project p ON p.id = i.project_id
         JOIN platform_user inviter ON inviter.id = i.invited_by_user_id
         WHERE i.invited_user_id = ? AND i.status = 'PENDING'
         ORDER BY i.created_at DESC, i.id`,
      )
      .all(userId)
      .map((row) => {
        const value = row as InvitationRow & {
          project_name: string;
          inviter_name: string;
        };
        return ReceivedProjectInvitationSchema.parse({
          invitation: mapInvitation(value),
          projectName: value.project_name,
          invitedByDisplayName: value.inviter_name,
        });
      });
  }

  respondToInvitation(
    actorUserId: string,
    invitationId: string,
    input: {
      mutationId: string;
      expectedVersion: number;
      decision: 'ACCEPT' | 'REJECT';
    },
  ): ProjectInvitation {
    const mutationId = MutationIdSchema.parse(input.mutationId);
    const decision = ProjectInvitationDecisionSchema.parse(input.decision);
    const operation = `PROJECT_INVITATION_${decision}`;
    const previous = this.readMutation(
      mutationId,
      actorUserId,
      operation,
      ProjectInvitationSchema.parse,
    );
    if (previous) return previous;

    return this.db.transaction(() => {
      const row = this.invitationForRecipient(invitationId, actorUserId);
      const targetStatus =
        input.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
      if (row.status !== 'PENDING') {
        if (row.status !== targetStatus)
          throw new PlatformError('INVALID_TRANSITION', '邀请已完成其他处理');
        const result = mapInvitation(row);
        this.recordMutation(
          mutationId,
          actorUserId,
          operation,
          'PROJECT_INVITATION',
          invitationId,
          result,
        );
        return result;
      }
      if (row.version !== input.expectedVersion)
        throw new PlatformError('STALE_STATE', '邀请状态已更新，请刷新后重试');
      const respondedAt = this.now().toISOString();
      const update = this.db
        .prepare(
          `UPDATE cooking_project_invitation
           SET status = ?, version = version + 1, responded_at = ?
           WHERE id = ? AND version = ? AND status = 'PENDING'`,
        )
        .run(targetStatus, respondedAt, invitationId, input.expectedVersion);
      if (update.changes !== 1)
        throw new PlatformError('STALE_STATE', '邀请状态已更新，请刷新后重试');
      if (targetStatus === 'ACCEPTED')
        this.db
          .prepare(
            `INSERT OR IGNORE INTO cooking_project_membership(
               project_id, user_id, role, version, created_at
             ) VALUES (?, ?, 'MEMBER', 1, ?)`,
          )
          .run(row.project_id, actorUserId, respondedAt);
      const result = mapInvitation({
        ...row,
        status: targetStatus,
        version: row.version + 1,
        responded_at: respondedAt,
      });
      this.audit(
        row.project_id,
        actorUserId,
        targetStatus === 'ACCEPTED'
          ? 'PROJECT_INVITATION_ACCEPTED'
          : 'PROJECT_INVITATION_REJECTED',
        'PROJECT_INVITATION',
        invitationId,
        {},
      );
      this.recordMutation(
        mutationId,
        actorUserId,
        operation,
        'PROJECT_INVITATION',
        invitationId,
        result,
      );
      return result;
    })();
  }

  revokeInvitation(
    actorUserId: string,
    invitationId: string,
    input: { mutationId: string; expectedVersion: number },
  ): ProjectInvitation {
    const mutationId = MutationIdSchema.parse(input.mutationId);
    const previous = this.readMutation(
      mutationId,
      actorUserId,
      'PROJECT_INVITATION_REVOKE',
      ProjectInvitationSchema.parse,
    );
    if (previous) return previous;
    return this.db.transaction(() => {
      const row = this.invitationForOwner(invitationId, actorUserId);
      if (row.status !== 'PENDING') {
        if (row.status !== 'REVOKED')
          throw new PlatformError('INVALID_TRANSITION', '邀请已完成，无法撤销');
        const result = mapInvitation(row);
        this.recordMutation(
          mutationId,
          actorUserId,
          'PROJECT_INVITATION_REVOKE',
          'PROJECT_INVITATION',
          invitationId,
          result,
        );
        return result;
      }
      if (row.version !== input.expectedVersion)
        throw new PlatformError('STALE_STATE', '邀请状态已更新，请刷新后重试');
      const respondedAt = this.now().toISOString();
      this.db
        .prepare(
          `UPDATE cooking_project_invitation
           SET status = 'REVOKED', version = version + 1, responded_at = ?
           WHERE id = ? AND version = ? AND status = 'PENDING'`,
        )
        .run(respondedAt, invitationId, input.expectedVersion);
      const result = mapInvitation({
        ...row,
        status: 'REVOKED',
        version: row.version + 1,
        responded_at: respondedAt,
      });
      this.audit(
        row.project_id,
        actorUserId,
        'PROJECT_INVITATION_REVOKED',
        'PROJECT_INVITATION',
        invitationId,
        {},
      );
      this.recordMutation(
        mutationId,
        actorUserId,
        'PROJECT_INVITATION_REVOKE',
        'PROJECT_INVITATION',
        invitationId,
        result,
      );
      return result;
    })();
  }

  updateProject(
    actorUserId: string,
    projectId: string,
    input: { mutationId: string; expectedVersion: number; name: string },
  ): Project {
    const mutationId = MutationIdSchema.parse(input.mutationId);
    const name = ProjectNameSchema.parse(input.name);
    const previous = this.readMutation(
      mutationId,
      actorUserId,
      'PROJECT_UPDATE',
      ProjectSchema.parse,
    );
    if (previous) return previous;
    return this.db.transaction(() => {
      const current = this.requireOwner(actorUserId, projectId);
      if (current.version !== input.expectedVersion)
        throw new PlatformError('STALE_STATE', '项目已更新，请刷新后重试');
      const updatedAt = this.now().toISOString();
      const update = this.db
        .prepare(
          `UPDATE cooking_project SET name = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .run(name, updatedAt, projectId, input.expectedVersion);
      if (update.changes !== 1)
        throw new PlatformError('STALE_STATE', '项目已更新，请刷新后重试');
      const result = ProjectSchema.parse({
        ...current,
        name,
        version: current.version + 1,
        updatedAt,
      });
      this.audit(
        projectId,
        actorUserId,
        'PROJECT_UPDATED',
        'PROJECT',
        projectId,
        {
          name,
        },
      );
      this.recordMutation(
        mutationId,
        actorUserId,
        'PROJECT_UPDATE',
        'PROJECT',
        projectId,
        result,
      );
      return result;
    })();
  }

  removeMember(
    actorUserId: string,
    projectId: string,
    targetUserId: string,
    input: { mutationId: string; expectedVersion: number },
  ): RemoveMemberResult {
    const mutationId = MutationIdSchema.parse(input.mutationId);
    const previous = this.readMutation(
      mutationId,
      actorUserId,
      'PROJECT_MEMBER_REMOVE',
      parseRemoveResult,
    );
    if (previous) return previous;
    return this.db.transaction(() => {
      this.requireOwner(actorUserId, projectId);
      const row = this.db
        .prepare(
          `SELECT project_id, user_id, role, version, created_at
           FROM cooking_project_membership
           WHERE project_id = ? AND user_id = ?`,
        )
        .get(projectId, targetUserId) as MembershipRow | undefined;
      if (!row) {
        const result = { removed: false, userId: targetUserId };
        this.recordMutation(
          mutationId,
          actorUserId,
          'PROJECT_MEMBER_REMOVE',
          'PROJECT_MEMBERSHIP',
          targetUserId,
          result,
        );
        return result;
      }
      if (row.version !== input.expectedVersion)
        throw new PlatformError('STALE_STATE', '成员关系已更新，请刷新后重试');
      if (row.role === 'OWNER') {
        const owners = this.db
          .prepare(
            `SELECT COUNT(*) count FROM cooking_project_membership
             WHERE project_id = ? AND role = 'OWNER'`,
          )
          .get(projectId) as { count: number };
        if (owners.count <= 1)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '项目必须至少保留一名所有者',
          );
      }
      if (this.hasActiveResponsibilities(projectId, targetUserId))
        throw new PlatformError(
          'RESOURCE_CONFLICT',
          '该成员仍有活动职责，暂时不能移除',
        );
      this.db
        .prepare(
          `DELETE FROM cooking_project_membership
           WHERE project_id = ? AND user_id = ? AND version = ?`,
        )
        .run(projectId, targetUserId, input.expectedVersion);
      const result = { removed: true, userId: targetUserId };
      this.audit(
        projectId,
        actorUserId,
        'PROJECT_MEMBER_REMOVED',
        'PROJECT_MEMBERSHIP',
        targetUserId,
        {},
      );
      this.recordMutation(
        mutationId,
        actorUserId,
        'PROJECT_MEMBER_REMOVE',
        'PROJECT_MEMBERSHIP',
        targetUserId,
        result,
      );
      return result;
    })();
  }

  private requireOwner(userId: string, projectId: string): Project {
    const row = this.db
      .prepare(
        `SELECT p.id, p.name, p.version, p.created_by_user_id, p.created_at,
                p.updated_at, m.role
         FROM cooking_project p
         JOIN cooking_project_membership m ON m.project_id = p.id
         WHERE p.id = ? AND m.user_id = ?`,
      )
      .get(projectId, userId) as (ProjectRow & { role: string }) | undefined;
    if (!row) throw hiddenProject();
    if (row.role !== 'OWNER')
      throw new PlatformError(
        'PERMISSION_DENIED',
        '只有项目所有者可以执行此操作',
      );
    return mapProject(row);
  }

  private insertInvitation(
    projectId: string,
    invitedUserId: string,
    invitedByUserId: string,
  ): ProjectInvitation {
    const id = this.createId();
    const createdAt = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO cooking_project_invitation(
           id, project_id, invited_user_id, invited_by_user_id, status,
           version, created_at, responded_at
         ) VALUES (?, ?, ?, ?, 'PENDING', 1, ?, NULL)`,
      )
      .run(id, projectId, invitedUserId, invitedByUserId, createdAt);
    return ProjectInvitationSchema.parse({
      id,
      projectId,
      invitedUserId,
      invitedByUserId,
      status: 'PENDING',
      version: 1,
      createdAt,
      respondedAt: null,
    });
  }

  private invitationForRecipient(id: string, userId: string): InvitationRow {
    const row = this.db
      .prepare(
        `SELECT id, project_id, invited_user_id, invited_by_user_id, status,
                version, created_at, responded_at
         FROM cooking_project_invitation
         WHERE id = ? AND invited_user_id = ?`,
      )
      .get(id, userId) as InvitationRow | undefined;
    if (!row) throw hiddenInvitation();
    return row;
  }

  private invitationForOwner(id: string, userId: string): InvitationRow {
    const row = this.db
      .prepare(
        `SELECT i.id, i.project_id, i.invited_user_id, i.invited_by_user_id,
                i.status, i.version, i.created_at, i.responded_at
         FROM cooking_project_invitation i
         JOIN cooking_project_membership m ON m.project_id = i.project_id
         WHERE i.id = ? AND m.user_id = ? AND m.role = 'OWNER'`,
      )
      .get(id, userId) as InvitationRow | undefined;
    if (!row) throw hiddenInvitation();
    return row;
  }

  private readMutation<T>(
    id: string,
    actorUserId: string,
    operation: string,
    parse: (value: unknown) => T,
  ): T | null {
    const row = this.db
      .prepare(
        'SELECT actor_user_id, operation, result_json FROM cooking_mutation WHERE id = ?',
      )
      .get(id) as MutationRow | undefined;
    if (!row) return null;
    if (row.actor_user_id !== actorUserId || row.operation !== operation)
      throw new PlatformError('RESOURCE_CONFLICT', '操作标识已用于其他操作');
    return parse(JSON.parse(row.result_json));
  }

  private recordMutation(
    id: string,
    actorUserId: string,
    operation: string,
    resourceType: string,
    resourceId: string,
    result: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO cooking_mutation(
           id, actor_user_id, operation, resource_type, resource_id,
           result_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        actorUserId,
        operation,
        resourceType,
        resourceId,
        JSON.stringify(result),
        this.now().toISOString(),
      );
  }

  private audit(
    projectId: string,
    actorUserId: string,
    action: string,
    targetType: string,
    targetId: string,
    details: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO cooking_audit_event(
           id, project_id, actor_user_id, action, target_type, target_id,
           details_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.createId(),
        projectId,
        actorUserId,
        action,
        targetType,
        targetId,
        JSON.stringify(details),
        this.now().toISOString(),
      );
  }
}

function mapProject(row: ProjectRow): Project {
  return ProjectSchema.parse({
    id: row.id,
    name: row.name,
    version: row.version,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapMembership(row: MembershipRow): ProjectMembership {
  return ProjectMembershipSchema.parse({
    projectId: row.project_id,
    userId: row.user_id,
    role: row.role,
    version: row.version,
    createdAt: row.created_at,
  });
}

function mapInvitation(row: InvitationRow): ProjectInvitation {
  return ProjectInvitationSchema.parse({
    id: row.id,
    projectId: row.project_id,
    invitedUserId: row.invited_user_id,
    invitedByUserId: row.invited_by_user_id,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    respondedAt: row.responded_at,
  });
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

function hiddenInvitation(): PlatformError {
  return new PlatformError('NOT_FOUND', INVITATION_HIDDEN_MESSAGE);
}
