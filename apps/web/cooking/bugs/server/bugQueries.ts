import { BugRelations, stageLabel } from './bugRelations';
import { parseRow, type DatabaseRow } from '@/platform/database/rowMapper';
import { environmentReady } from '@/cooking/submissions/server/environmentAccess';
import { CookingAttachmentViewSchema } from '@/cooking/shared/contract';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import { StoredFileSchema, type StoredFile } from '@/platform/files/localFileStore';
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
  created_by_user_id: string;
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

type BugAttachmentPreview = Pick<
  StoredFile,
  'id' | 'originalName' | 'mediaType' | 'sizeBytes' | 'createdAt'
>;

export class BugQueries {
  constructor(private readonly db: AppDatabase) {}

  workspace(userId: string, submissionId: string): BugWorkspaceProjection {
    const access = this.requireAccess(userId, submissionId);
    const anyResponsible =
      access.submission_status === 'ACTIVE' &&
      this.isAnyResponsible(userId, submissionId);
    const relations = new BugRelations(this.db);
    const bugs = this.db
      .all<BugRow>(
        `SELECT * FROM cooking_bug
           WHERE submission_id = ? ORDER BY short_id`,
        submissionId,
      )
      .map((row) => {
        const attachments = this.attachmentsForBug(row.id);
        const bug = mapBug(row, attachments);
        const routing = bugRoutingPolicy(this.db, bug, userId);
        const item = this.requireItem(submissionId, bug.submissionItemId);
        return {
          ...bug,
          routing,
          relatedBugs: relations.list(bug.id),
          report: {
            title: bug.report.title,
            ...(bug.report.operationPath
              ? { operationPath: bug.report.operationPath }
              : {}),
            ...(bug.report.actualResult ? { actualResult: bug.report.actualResult } : {}),
            ...(bug.report.expectedResult
              ? { expectedResult: bug.report.expectedResult }
              : {}),
            actualResultAttachments: attachments.actualResultAttachments,
            expectedResultAttachments: attachments.expectedResultAttachments,
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
          availableActions: this.availableActions(
            userId,
            access,
            bug,
            routing,
            anyResponsible,
          ),
          presentation: {
            stageLabel: bug.transferredAt ? '已关闭（转交）' : stageLabel(bug.stage),
            assignmentLabel: item
              ? `${item.engineering_name}（${item.engineering_identifier}）`
              : '暂未确定工程',
          },
        };
      });
    return BugWorkspaceProjectionSchema.parse({
      availableActions:
        access.submission_status === 'ACTIVE' && userId === access.tester_user_id
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
                submission.created_by_user_id,
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
    return mapBug(row, this.attachmentsForBug(row.id));
  }

  requireItem(submissionId: string, itemId: string | null): ItemRow | null {
    if (!itemId) return null;
    const row = this.db.get(
      `SELECT item.id, engineering.name engineering_name, item.engineering_type,
                item.engineering_identifier, item.responsible_user_id,
                item.responsible_username, item.responsible_display_name,
                item.responsible_user_created_at, item.binding_id
         FROM cooking_submission_item item
         JOIN cooking_engineering engineering ON engineering.id = item.engineering_id
         WHERE item.id = ? AND item.submission_id = ?`,
      itemId,
      submissionId,
    ) as ItemRow | undefined;
    if (!row) throw new PlatformError('VALIDATION_FAILED', '所选工程不属于当前提测单');
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

  private attachmentsForBug(bugId: string) {
    const rows = this.db.all<DatabaseRow<StoredFile> & { role: BugAttachmentRole }>(
      `SELECT attachment.role, file.id, file.storage_key, file.original_name,
              file.media_type, file.size_bytes, file.sha256,
              file.uploaded_by_user_id, file.created_at
         FROM cooking_bug_attachment attachment
         JOIN platform_file file ON file.id = attachment.file_id
         WHERE attachment.bug_id = ?
         ORDER BY attachment.role, attachment.position`,
      bugId,
    );
    const actual = {
      ids: [] as string[],
      previews: [] as BugAttachmentPreview[],
    };
    const expected = {
      ids: [] as string[],
      previews: [] as BugAttachmentPreview[],
    };
    for (const row of rows) {
      const target = row.role === 'ACTUAL_RESULT' ? actual : expected;
      const file = parseRow(StoredFileSchema, row);
      target.ids.push(file.id);
      target.previews.push(CookingAttachmentViewSchema.parse(file));
    }
    return {
      actualResultAttachmentIds: actual.ids,
      expectedResultAttachmentIds: expected.ids,
      actualResultAttachments: actual.previews,
      expectedResultAttachments: expected.previews,
    };
  }

  private availableActions(
    userId: string,
    access: AccessRow,
    bug: Bug,
    routing: ReturnType<typeof bugRoutingPolicy>,
    anyResponsible: boolean,
  ) {
    if (access.submission_status !== 'ACTIVE') return [];
    const tester = userId === access.tester_user_id;
    const actions: Array<
      | 'DELETE'
      | 'TRANSFER'
      | 'COLLABORATE'
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
    if (canDeleteUnassignedBug(userId, access, bug, anyResponsible))
      actions.push('DELETE');
    if (!routing.transferReason) actions.push('TRANSFER');
    if (!routing.collaborationReason) actions.push('COLLABORATE');
    if (!bug.reportLockedAt) {
      if (tester) actions.push('EDIT_REPORT');
      if (
        !bug.collaborationLocked &&
        (tester || access.membership_role === 'OWNER' || anyResponsible)
      )
        actions.push('ASSIGN');
    }
    const canRequestRepair =
      bug.stage === 'WAITING_FOR_REPAIR' && bug.submissionItemId && !bug.archivedAt;
    if (canRequestRepair && (tester || userId === access.created_by_user_id))
      actions.push('REQUEST_REPAIR');
    if (!tester) return actions;
    if (canRequestRepair) actions.push('CANCEL');
    if (bug.stage === 'CANCELLED' && !bug.transferredAt) actions.push('RESTORE');
    if (
      bug.stage === 'WAITING_FOR_VERIFICATION' &&
      bug.submissionItemId &&
      environmentReady(this.db, bug.submissionItemId)
    )
      actions.push('VERIFY_PASS', 'VERIFY_FAIL');
    if (bug.stage === 'DONE' && !bug.archivedAt) actions.push('REOPEN', 'ARCHIVE');
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
  return parseRow(BugSchema, {
    ...row,
    collaboration_locked: Boolean(row.collaboration_locked),
    report: {
      title: row.title,
      ...(row.operation_path ? { operationPath: row.operation_path } : {}),
      ...(row.actual_result ? { actualResult: row.actual_result } : {}),
      ...(row.expected_result ? { expectedResult: row.expected_result } : {}),
      ...attachmentIds,
    },
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

export function canDeleteUnassignedBug(
  userId: string,
  access: AccessRow,
  bug: Bug,
  anyResponsible: boolean,
): boolean {
  return (
    access.submission_status === 'ACTIVE' &&
    (userId === access.tester_user_id || anyResponsible) &&
    bug.submissionItemId === null &&
    bug.stage === 'WAITING_FOR_REPAIR' &&
    !bug.reportLockedAt &&
    !bug.collaborationLocked &&
    !bug.transferredAt &&
    !bug.archivedAt
  );
}

export function bugRoutingPolicy(db: AppDatabase, bug: Bug, actorUserId: string) {
  const source = db.get(
    `SELECT item.engineering_type, item.responsible_user_id, submission.tester_user_id, submission.status
     FROM cooking_test_submission submission
     LEFT JOIN cooking_submission_item item ON item.id = ? WHERE submission.id = ?`,
    bug.submissionItemId,
    bug.submissionId,
  ) as {
    engineering_type: string | null;
    responsible_user_id: string | null;
    tester_user_id: string;
    status: string;
  };
  const authorized =
    actorUserId === source.tester_user_id || actorUserId === source.responsible_user_id;
  const targets =
    authorized && source.engineering_type
      ? db.all<{ id: string; name: string; type: 'FRONTEND' | 'BACKEND' }>(
          `SELECT item.id, engineering.name, item.engineering_type type
           FROM cooking_submission_item item
           JOIN cooking_engineering engineering ON engineering.id = item.engineering_id
           WHERE item.submission_id = ? AND item.engineering_type != ? ORDER BY item.position`,
          bug.submissionId,
          source.engineering_type,
        )
      : [];
  const latest = db.get(
    'SELECT finished_at FROM cooking_repair_attempt WHERE bug_id = ? ORDER BY attempt DESC LIMIT 1',
    bug.id,
  ) as { finished_at: string | null } | undefined;
  const active = db.get(
    `SELECT 1 FROM platform_execution WHERE state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND id IN (
       SELECT execution_id FROM cooking_repair_attempt WHERE bug_id = ?
       UNION SELECT execution_id FROM cooking_repair_session_sync WHERE bug_id = ?
       UNION SELECT attempt.execution_id FROM cooking_update_attempt attempt JOIN cooking_update_batch_entry entry ON entry.batch_id = attempt.batch_id WHERE entry.bug_id = ?
       UNION SELECT sync.execution_id FROM cooking_update_session_sync sync JOIN cooking_update_batch_entry entry ON entry.batch_id = sync.batch_id WHERE entry.bug_id = ?
     ) LIMIT 1`,
    bug.id,
    bug.id,
    bug.id,
    bug.id,
  );
  const reason = !authorized
    ? '只有测试负责人或原工程负责人可以操作'
    : source.status !== 'ACTIVE'
      ? '已关闭提测单不能操作'
      : bug.collaborationLocked
        ? '前后端关联单不能转交或增加协作'
        : bug.transferredAt || ['DONE', 'CANCELLED'].includes(bug.stage)
          ? '已结束的缺陷不能操作'
          : !targets.length
            ? '当前提测单没有可用的另一端工程'
            : active || bug.stage === 'UPDATING'
              ? '请等待当前修复、更新或同步任务结束'
              : !latest?.finished_at
                ? '请先完成一次自动修复，再判断工程归属'
                : null;
  const pending = db.get(
    'SELECT pending_commits_json, pending_manual_operations_json FROM cooking_bug_repair_context WHERE bug_id = ?',
    bug.id,
  ) as
    { pending_commits_json: string; pending_manual_operations_json: string } | undefined;
  const hasPending =
    pending &&
    (JSON.parse(pending.pending_commits_json).length > 0 ||
      JSON.parse(pending.pending_manual_operations_json).length > 0);
  return {
    targets,
    transferReason: reason ?? (hasPending ? '请先处理待交付改动，不能转交' : null),
    collaborationReason: reason,
  };
}
