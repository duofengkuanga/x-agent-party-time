import { parseRow, type DatabaseRow } from '@/platform/database/row-mapper';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import type { CookingWriteStore } from '@/cooking/shared/server/write-store';
import {
  MutationIdSchema,
  ProjectInvitationDecisionSchema,
  ProjectInvitationDetailSchema,
  ProjectInvitationSchema,
  ReceivedProjectInvitationSchema,
  type ProjectInvitation,
  type ProjectInvitationDetail,
  type ReceivedProjectInvitation,
} from '../contract';

const INVITATION_HIDDEN_MESSAGE = '邀请不存在或无权操作';
const INVITATION_STATUS = {
  ACCEPT: 'ACCEPTED',
  REJECT: 'REJECTED',
  REVOKE: 'REVOKED',
} as const;

type InvitationRow = DatabaseRow<ProjectInvitation>;

export class ProjectInvitations {
  constructor(
    private readonly db: AppDatabase,
    private readonly writes: CookingWriteStore,
    private readonly now: () => Date,
    private readonly createId: () => string,
    private readonly requireOwner: (userId: string, projectId: string) => void,
  ) {}

  inviteUser(
    actorUserId: string,
    projectId: string,
    input: { mutationId: string; username: string },
  ): ProjectInvitation {
    const mutationId = MutationIdSchema.parse(input.mutationId);
    const username = input.username.trim().toLowerCase();

    return this.writes.run({
      mutationId,
      actorUserId,
      operation: 'PROJECT_INVITE',
      resourceType: 'PROJECT_INVITATION',
      resultSchema: ProjectInvitationSchema,
      perform: () => {
        this.requireOwner(actorUserId, projectId);
        const user = this.db.get(
          'SELECT id FROM platform_user WHERE username = ? COLLATE NOCASE',
          username,
        ) as { id: string } | undefined;
        if (!user)
          throw new PlatformError('VALIDATION_FAILED', '邀请用户不存在');
        const member = this.db.get(
          'SELECT 1 present FROM cooking_project_membership WHERE project_id = ? AND user_id = ?',
          projectId,
          user.id,
        );
        if (member)
          throw new PlatformError('RESOURCE_CONFLICT', '该用户已经是项目成员');
        const pending = this.db.get(
          `SELECT id, project_id, invited_user_id, invited_by_user_id, status,
                  version, created_at, responded_at
           FROM cooking_project_invitation
           WHERE project_id = ? AND invited_user_id = ? AND status = 'PENDING'`,
          projectId,
          user.id,
        ) as InvitationRow | undefined;
        const invitation = pending
          ? mapInvitation(pending)
          : this.insertInvitation(projectId, user.id, actorUserId);
        return {
          result: invitation,
          resourceId: invitation.id,
          audit: {
            projectId: projectId,
            action: 'PROJECT_USER_INVITED',
            details: { invitedUserId: user.id },
          },
        };
      },
    });
  }

  listProjectInvitations(
    userId: string,
    projectId: string,
  ): ProjectInvitationDetail[] {
    this.requireOwner(userId, projectId);
    return this.db
      .all(
        `SELECT i.id, i.project_id, i.invited_user_id, i.invited_by_user_id,
                i.status, i.version, i.created_at, i.responded_at,
                u.username, u.display_name, u.created_at user_created_at
         FROM cooking_project_invitation i
         JOIN platform_user u ON u.id = i.invited_user_id
         WHERE i.project_id = ? AND i.status = 'PENDING'
         ORDER BY i.created_at DESC, i.id`,
        projectId,
      )
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
      .all(
        `SELECT i.id, i.project_id, i.invited_user_id, i.invited_by_user_id,
                i.status, i.version, i.created_at, i.responded_at,
                p.name project_name, inviter.display_name inviter_name
         FROM cooking_project_invitation i
         JOIN cooking_project p ON p.id = i.project_id
         JOIN platform_user inviter ON inviter.id = i.invited_by_user_id
         WHERE i.invited_user_id = ? AND i.status = 'PENDING'
         ORDER BY i.created_at DESC, i.id`,
        userId,
      )
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
    return this.transitionInvitation(
      actorUserId,
      invitationId,
      { mutationId, expectedVersion: input.expectedVersion },
      decision,
    );
  }

  revokeInvitation(
    actorUserId: string,
    invitationId: string,
    input: { mutationId: string; expectedVersion: number },
  ): ProjectInvitation {
    const mutationId = MutationIdSchema.parse(input.mutationId);
    return this.transitionInvitation(
      actorUserId,
      invitationId,
      { mutationId, expectedVersion: input.expectedVersion },
      'REVOKE',
    );
  }

  private transitionInvitation(
    actorUserId: string,
    invitationId: string,
    input: { mutationId: string; expectedVersion: number },
    decision: keyof typeof INVITATION_STATUS,
  ): ProjectInvitation {
    const targetStatus = INVITATION_STATUS[decision];
    return this.writes.run({
      mutationId: input.mutationId,
      actorUserId,
      operation: `PROJECT_INVITATION_${decision}`,
      resourceType: 'PROJECT_INVITATION',
      resultSchema: ProjectInvitationSchema,
      perform: () => {
        const row =
          decision === 'REVOKE'
            ? this.invitationForOwner(invitationId, actorUserId)
            : this.invitationForRecipient(invitationId, actorUserId);
        if (row.status !== 'PENDING') {
          if (row.status !== targetStatus)
            throw new PlatformError(
              'INVALID_TRANSITION',
              decision === 'REVOKE'
                ? '邀请已完成，无法撤销'
                : '邀请已完成其他处理',
            );
          return { result: mapInvitation(row), resourceId: invitationId };
        }
        if (row.version !== input.expectedVersion)
          throw new PlatformError(
            'STALE_STATE',
            '邀请状态已更新，请刷新后重试',
          );
        const respondedAt = this.now().toISOString();
        const update = this.db.run(
          `UPDATE cooking_project_invitation
           SET status = ?, version = version + 1, responded_at = ?
           WHERE id = ? AND version = ? AND status = 'PENDING'`,
          [targetStatus, respondedAt, invitationId, input.expectedVersion],
        );
        if (update.changes !== 1)
          throw new PlatformError(
            'STALE_STATE',
            '邀请状态已更新，请刷新后重试',
          );
        if (decision === 'ACCEPT')
          this.db.run(
            `INSERT OR IGNORE INTO cooking_project_membership(
               project_id, user_id, role, version, created_at
             ) VALUES (?, ?, 'MEMBER', 1, ?)`,
            [row.project_id, actorUserId, respondedAt],
          );
        const result = mapInvitation({
          ...row,
          status: targetStatus,
          version: row.version + 1,
          responded_at: respondedAt,
        });
        return {
          result,
          resourceId: invitationId,
          audit: {
            projectId: row.project_id,
            action: `PROJECT_INVITATION_${targetStatus}`,
            details: {},
          },
        };
      },
    });
  }

  private insertInvitation(
    projectId: string,
    invitedUserId: string,
    invitedByUserId: string,
  ): ProjectInvitation {
    const id = this.createId();
    const createdAt = this.now().toISOString();
    const stored = this.db.get<InvitationRow>(
      `INSERT INTO cooking_project_invitation(
           id, project_id, invited_user_id, invited_by_user_id, status,
           version, created_at, responded_at
         ) VALUES (?, ?, ?, ?, 'PENDING', 1, ?, NULL) RETURNING *`,
      id,
      projectId,
      invitedUserId,
      invitedByUserId,
      createdAt,
    );
    return mapInvitation(stored!);
  }

  private invitationForRecipient(id: string, userId: string): InvitationRow {
    const row = this.db.get(
      `SELECT id, project_id, invited_user_id, invited_by_user_id, status,
                version, created_at, responded_at
         FROM cooking_project_invitation
         WHERE id = ? AND invited_user_id = ?`,
      id,
      userId,
    ) as InvitationRow | undefined;
    if (!row) throw hiddenInvitation();
    return row;
  }

  private invitationForOwner(id: string, userId: string): InvitationRow {
    const row = this.db.get(
      `SELECT i.id, i.project_id, i.invited_user_id, i.invited_by_user_id,
                i.status, i.version, i.created_at, i.responded_at
         FROM cooking_project_invitation i
         JOIN cooking_project_membership m ON m.project_id = i.project_id
         WHERE i.id = ? AND m.user_id = ? AND m.role = 'OWNER'`,
      id,
      userId,
    ) as InvitationRow | undefined;
    if (!row) throw hiddenInvitation();
    return row;
  }
}

function mapInvitation(row: InvitationRow): ProjectInvitation {
  return parseRow(ProjectInvitationSchema, row);
}

function hiddenInvitation(): PlatformError {
  return new PlatformError('NOT_FOUND', INVITATION_HIDDEN_MESSAGE);
}
