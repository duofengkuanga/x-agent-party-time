import { parseRow, type DatabaseRow } from '@/platform/database/row-mapper';
import { environmentReady } from '@/cooking/submissions/server/environment-access';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import {
  StoredFileSchema,
  type StoredFile,
} from '@/platform/files/local-file-store';
import { UserSchema, type User } from '@/platform/auth/contract';
import {
  BugSchema,
  BugWorkspaceProjectionSchema,
  type Bug,
  type BugWorkspaceProjection,
} from '../contract';

type BugRow = Omit<DatabaseRow<Bug>, 'report'> & {
  title: string;
  operation_path: string | null;
  actual_result: string | null;
  expected_result: string | null;
};

export type AccessRow = {
  submission_id: string;
  submission_status: 'ACTIVE' | 'CLOSED';
  tester_user_id: string;
  project_id: string;
  membership_role: 'OWNER' | 'MEMBER';
};

type ItemRow = {
  id: string;
  engineering_name: string;
  engineering_type: 'FRONTEND' | 'BACKEND';
  engineering_identifier: string;
  responsible_user_id: string;
  responsible_username: string;
  responsible_display_name: string;
  responsible_user_created_at: string;
  binding_id: string;
};

export type BugAttachmentRole = 'ACTUAL_RESULT' | 'EXPECTED_RESULT';

export type ReportAttachmentIds = {
  actualResultAttachmentIds: string[];
  expectedResultAttachmentIds: string[];
};

const STAGE_LABELS: Record<Bug['stage'], string> = {
  WAITING_FOR_REPAIR: '待修复',
  REPAIRING: '修复中',
  WAITING_FOR_UPDATE: '待更新',
  UPDATING: '更新中',
  WAITING_FOR_VERIFICATION: '待验证',
  DONE: '已完成',
  CANCELLED: '已取消',
};

export class BugQueries {
  constructor(private readonly db: AppDatabase) {}

  workspace(userId: string, submissionId: string): BugWorkspaceProjection {
    const access = this.requireAccess(userId, submissionId);
    const bugs = this.db
      .all<BugRow>(
        `SELECT * FROM cooking_bug
           WHERE submission_id = ? ORDER BY short_id`,
        submissionId,
      )
      .map((row) => {
        const bug = mapBug(row, this.reportAttachmentIds(row.id));
        const item = this.requireItem(submissionId, bug.submissionItemId);
        return {
          ...bug,
          report: {
            title: bug.report.title,
            ...(bug.report.operationPath
              ? { operationPath: bug.report.operationPath }
              : {}),
            ...(bug.report.actualResult
              ? { actualResult: bug.report.actualResult }
              : {}),
            ...(bug.report.expectedResult
              ? { expectedResult: bug.report.expectedResult }
              : {}),
            actualResultAttachments: this.attachments(row.id, 'ACTUAL_RESULT'),
            expectedResultAttachments: this.attachments(
              row.id,
              'EXPECTED_RESULT',
            ),
          },
          createdBy: this.getUser(bug.createdByUserId),
          assignment: item
            ? {
                submissionItemId: item.id,
                engineeringName: item.engineering_name,
                engineeringType: item.engineering_type,
                engineeringIdentifier: item.engineering_identifier,
                responsibleUser: itemUser(item),
              }
            : null,
          availableActions: this.availableActions(userId, access, bug),
          presentation: {
            stageLabel: STAGE_LABELS[bug.stage],
            assignmentLabel: item
              ? `${item.engineering_name}（${item.engineering_identifier}）`
              : '暂未确定工程',
          },
        };
      });
    return BugWorkspaceProjectionSchema.parse({
      availableActions:
        access.submission_status === 'ACTIVE' &&
        userId === access.tester_user_id
          ? ['CREATE_BUG']
          : [],
      bugs,
    });
  }

  requireAttachmentAccess(userId: string, fileId: string): void {
    const row = this.db.get(
      `SELECT submission_id FROM (
           SELECT bug.submission_id
           FROM cooking_bug_attachment attachment
           JOIN cooking_bug bug ON bug.id = attachment.bug_id
           WHERE attachment.file_id = ?
           UNION ALL
           SELECT bug.submission_id
           FROM cooking_verification_attachment attachment
           JOIN cooking_verification_record verification
             ON verification.id = attachment.verification_id
           JOIN cooking_bug bug ON bug.id = verification.bug_id
           WHERE attachment.file_id = ?
           UNION ALL
           SELECT bug.submission_id
           FROM cooking_reopen_attachment attachment
           JOIN cooking_reopen_record reopen ON reopen.id = attachment.reopen_id
           JOIN cooking_bug bug ON bug.id = reopen.bug_id
           WHERE attachment.file_id = ?
         ) LIMIT 1`,
      fileId,
      fileId,
      fileId,
    ) as { submission_id: string } | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '附件不存在或无权访问');
    try {
      this.requireAccess(userId, row.submission_id);
    } catch {
      throw new PlatformError('NOT_FOUND', '附件不存在或无权访问');
    }
  }

  requireAccess(userId: string, submissionId: string): AccessRow {
    const row = this.db.get(
      `SELECT submission.id submission_id,
                submission.status submission_status,
                submission.tester_user_id,
                submission.project_id,
                membership.role membership_role
         FROM cooking_test_submission submission
         JOIN cooking_project_membership membership
           ON membership.project_id = submission.project_id
          AND membership.user_id = ?
         WHERE submission.id = ?`,
      userId,
      submissionId,
    ) as AccessRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '提测单不存在或无权访问');
    return row;
  }

  requireBug(bugId: string): Bug {
    const row = this.db.get('SELECT * FROM cooking_bug WHERE id = ?', bugId) as
      BugRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '缺陷不存在或无权访问');
    return mapBug(row, this.reportAttachmentIds(row.id));
  }

  requireItem(submissionId: string, itemId: string | null): ItemRow | null {
    if (!itemId) return null;
    const row = this.db.get(
      `SELECT id, engineering_name, engineering_type,
                engineering_identifier, responsible_user_id,
                responsible_username, responsible_display_name,
                responsible_user_created_at, binding_id
         FROM cooking_submission_item
         WHERE id = ? AND submission_id = ?`,
      itemId,
      submissionId,
    ) as ItemRow | undefined;
    if (!row)
      throw new PlatformError('VALIDATION_FAILED', '所选工程不属于当前提测单');
    return row;
  }

  isAnyResponsible(userId: string, submissionId: string): boolean {
    return Boolean(
      this.db.get(
        `SELECT 1 FROM cooking_submission_item
           WHERE submission_id = ? AND responsible_user_id = ? LIMIT 1`,
        submissionId,
        userId,
      ),
    );
  }

  nextShortId(submissionId: string): number {
    const row = this.db.get(
      `SELECT COALESCE(MAX(short_id), 0) + 1 next_id
         FROM cooking_bug WHERE submission_id = ?`,
      submissionId,
    ) as { next_id: number };
    return row.next_id;
  }

  private reportAttachmentIds(bugId: string): ReportAttachmentIds {
    const rows = this.db.all<{
      file_id: string;
      role: BugAttachmentRole;
    }>(
      `SELECT file_id, role FROM cooking_bug_attachment
         WHERE bug_id = ? ORDER BY role, position`,
      bugId,
    );
    return {
      actualResultAttachmentIds: rows
        .filter(({ role }) => role === 'ACTUAL_RESULT')
        .map(({ file_id }) => file_id),
      expectedResultAttachmentIds: rows
        .filter(({ role }) => role === 'EXPECTED_RESULT')
        .map(({ file_id }) => file_id),
    };
  }

  private attachments(
    bugId: string,
    role: BugAttachmentRole,
  ): Array<
    Pick<
      StoredFile,
      'id' | 'originalName' | 'mediaType' | 'sizeBytes' | 'createdAt'
    >
  > {
    const rows = this.db.all<{
      id: string;
      storage_key: string;
      original_name: string;
      media_type: string;
      size_bytes: number;
      sha256: string;
      uploaded_by_user_id: string;
      created_at: string;
    }>(
      `SELECT file.id, file.storage_key, file.original_name, file.media_type,
                file.size_bytes, file.sha256, file.uploaded_by_user_id,
                file.created_at
         FROM cooking_bug_attachment attachment
         JOIN platform_file file ON file.id = attachment.file_id
         WHERE attachment.bug_id = ? AND attachment.role = ?
         ORDER BY attachment.position`,
      bugId,
      role,
    );
    return rows.map((row) => {
      const file = parseRow(StoredFileSchema, row);
      return {
        id: file.id,
        originalName: file.originalName,
        mediaType: file.mediaType,
        sizeBytes: file.sizeBytes,
        createdAt: file.createdAt,
      };
    });
  }

  private availableActions(userId: string, access: AccessRow, bug: Bug) {
    if (access.submission_status !== 'ACTIVE') return [];
    const tester = userId === access.tester_user_id;
    const anyResponsible = this.isAnyResponsible(userId, bug.submissionId);
    const actions: Array<
      | 'EDIT_REPORT'
      | 'ASSIGN'
      | 'REQUEST_REPAIR'
      | 'VERIFY_PASS'
      | 'VERIFY_FAIL'
      | 'REOPEN'
      | 'CANCEL'
      | 'RESTORE'
      | 'ARCHIVE'
      | 'UNARCHIVE'
    > = [];
    if (!bug.reportLockedAt) {
      if (tester) actions.push('EDIT_REPORT');
      if (tester || access.membership_role === 'OWNER' || anyResponsible)
        actions.push('ASSIGN');
    }
    if (!tester) return actions;
    if (
      bug.stage === 'WAITING_FOR_REPAIR' &&
      bug.submissionItemId &&
      !bug.archivedAt
    )
      actions.push('REQUEST_REPAIR', 'CANCEL');
    if (bug.stage === 'CANCELLED') actions.push('RESTORE');
    if (
      bug.stage === 'WAITING_FOR_VERIFICATION' &&
      bug.submissionItemId &&
      environmentReady(this.db, bug.submissionItemId)
    )
      actions.push('VERIFY_PASS', 'VERIFY_FAIL');
    if (bug.stage === 'DONE' && !bug.archivedAt)
      actions.push('REOPEN', 'ARCHIVE');
    if (bug.stage === 'DONE' && bug.archivedAt) actions.push('UNARCHIVE');
    return actions;
  }

  private getUser(userId: string): User {
    const row = this.db.get(
      `SELECT id, username, display_name, created_at
         FROM platform_user WHERE id = ?`,
      userId,
    ) as DatabaseRow<User> | undefined;
    if (!row) throw new PlatformError('INTERNAL_ERROR', '缺陷用户快照无效');
    return parseRow(UserSchema, row);
  }
}

function mapBug(row: BugRow, attachmentIds: ReportAttachmentIds): Bug {
  return BugSchema.parse({
    id: row.id,
    shortId: row.short_id,
    submissionId: row.submission_id,
    submissionItemId: row.submission_item_id,
    stage: row.stage,
    report: {
      title: row.title,
      ...(row.operation_path ? { operationPath: row.operation_path } : {}),
      ...(row.actual_result ? { actualResult: row.actual_result } : {}),
      ...(row.expected_result ? { expectedResult: row.expected_result } : {}),
      ...attachmentIds,
    },
    reportLockedAt: row.report_locked_at,
    archivedAt: row.archived_at,
    archivedByUserId: row.archived_by_user_id,
    version: row.version,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function itemUser(item: ItemRow): User {
  return UserSchema.parse({
    id: item.responsible_user_id,
    username: item.responsible_username,
    displayName: item.responsible_display_name,
    createdAt: item.responsible_user_created_at,
  });
}
