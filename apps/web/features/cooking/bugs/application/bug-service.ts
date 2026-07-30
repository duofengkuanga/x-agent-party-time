import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '@/server/database';
import { PlatformError } from '@/server/errors';
import {
  StoredFileSchema,
  type StoredFile,
} from '@/server/files/local-file-store';
import { UserSchema, type User } from '@/server/auth/contract';
import { CookingWriteStore } from '@/features/cooking/shared/write-store';
import {
  AssignBugInputSchema,
  BugMutationResultSchema,
  BugSchema,
  BugWorkspaceProjectionSchema,
  CreateBugInputSchema,
  RequestRepairInputSchema,
  UpdateBugReportInputSchema,
  type AssignBugInput,
  type Bug,
  type BugMutationResult,
  type BugWorkspaceProjection,
  type CreateBugInput,
  type RequestRepairInput,
  type UpdateBugReportInput,
} from '../contract';

type BugRow = {
  id: string;
  short_id: number;
  submission_id: string;
  submission_item_id: string | null;
  stage: Bug['stage'];
  title: string;
  operation_path: string | null;
  actual_result: string | null;
  expected_result: string | null;
  notes: string | null;
  report_locked_at: string | null;
  archived_at: string | null;
  archived_by_user_id: string | null;
  version: number;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
};

type AccessRow = {
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

const STAGE_LABELS: Record<Bug['stage'], string> = {
  WAITING_FOR_REPAIR: '待修复',
  REPAIRING: '修复中',
  WAITING_FOR_UPDATE: '待更新',
  UPDATING: '更新中',
  WAITING_FOR_VERIFICATION: '待验证',
  DONE: '已完成',
  CANCELLED: '已取消',
};

export type BugRepairHooks = {
  requested: (bugId: string) => void;
};

const NOOP_REPAIR_HOOKS: BugRepairHooks = {
  requested: () => {},
};

export class BugService {
  private readonly writes: CookingWriteStore;

  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    private readonly onInvalidated: (
      submissionId: string,
      revision: number,
    ) => void = () => {},
    private readonly repairHooks: BugRepairHooks = NOOP_REPAIR_HOOKS,
  ) {
    this.writes = new CookingWriteStore(db, now, createId);
  }

  createBug(
    actorUserId: string,
    submissionId: string,
    input: CreateBugInput,
  ): BugMutationResult {
    const parsed = CreateBugInputSchema.parse(input);
    const replay = this.hasRecordedMutation(parsed.mutationId);
    const result = this.writes.run({
      mutationId: parsed.mutationId,
      actorUserId,
      operation: 'BUG_CREATE',
      resourceType: 'BUG',
      resultSchema: BugMutationResultSchema,
      perform: () => {
        const access = this.requireAccess(actorUserId, submissionId);
        this.requireActive(access);
        if (actorUserId !== access.tester_user_id)
          throw new PlatformError(
            'PERMISSION_DENIED',
            '只有测试负责人可以登记缺陷',
          );
        this.requireItem(submissionId, parsed.submissionItemId);
        this.requireBindableFiles(actorUserId, parsed.attachmentIds);
        const now = this.now().toISOString();
        const bugId = this.createId();
        const shortId = this.nextShortId(submissionId);
        const report = normalizedReport(parsed);
        this.db
          .prepare(
            `INSERT INTO cooking_bug(
               id, short_id, submission_id, submission_item_id, stage,
               title, operation_path, actual_result, expected_result, notes,
               report_locked_at, version, created_by_user_id, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'WAITING_FOR_REPAIR', ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)`,
          )
          .run(
            bugId,
            shortId,
            submissionId,
            parsed.submissionItemId,
            report.title,
            report.operationPath ?? null,
            report.actualResult ?? null,
            report.expectedResult ?? null,
            report.notes ?? null,
            actorUserId,
            now,
            now,
          );
        this.bindAttachments(bugId, parsed.attachmentIds, now);
        const revision = this.bumpRevision(submissionId, now);
        const bug = this.requireBug(bugId);
        return {
          result: {
            bug,
            revision,
            boundAttachmentIds: parsed.attachmentIds,
            unboundAttachmentIds: [],
          },
          resourceId: bugId,
          audits: [
            {
              projectId: access.project_id,
              action: 'BUG_CREATED',
              targetType: 'BUG',
              targetId: bugId,
              details: {
                shortId,
                submissionItemId: parsed.submissionItemId,
                attachmentCount: parsed.attachmentIds.length,
              },
            },
          ],
        };
      },
    });
    if (!replay) this.onInvalidated(result.bug.submissionId, result.revision);
    return result;
  }

  updateReport(
    actorUserId: string,
    bugId: string,
    input: UpdateBugReportInput,
  ): BugMutationResult {
    const parsed = UpdateBugReportInputSchema.parse(input);
    return this.updateBug(
      actorUserId,
      bugId,
      parsed.mutationId,
      'BUG_REPORT_UPDATE',
      (bug, access, now) => {
        if (actorUserId !== access.tester_user_id)
          throw new PlatformError(
            'PERMISSION_DENIED',
            '只有测试负责人可以编辑缺陷报告',
          );
        this.requireEditableReport(bug, parsed.expectedVersion);
        this.requireItem(bug.submissionId, parsed.submissionItemId);
        this.requireBindableFiles(actorUserId, parsed.attachmentIds, bug.id);
        const report = normalizedReport(parsed);
        const update = this.db
          .prepare(
            `UPDATE cooking_bug
             SET submission_item_id = ?, title = ?, operation_path = ?,
                 actual_result = ?, expected_result = ?, notes = ?,
                 version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND report_locked_at IS NULL`,
          )
          .run(
            parsed.submissionItemId,
            report.title,
            report.operationPath ?? null,
            report.actualResult ?? null,
            report.expectedResult ?? null,
            report.notes ?? null,
            now,
            bug.id,
            parsed.expectedVersion,
          );
        if (update.changes !== 1) throw staleBug();
        this.replaceReportAttachments(bug.id, parsed.attachmentIds, now);
        return {
          action: 'BUG_REPORT_UPDATED',
          boundAttachmentIds: parsed.attachmentIds,
          unboundAttachmentIds: bug.report.attachmentIds.filter(
            (fileId) => !parsed.attachmentIds.includes(fileId),
          ),
          details: {
            submissionItemId: parsed.submissionItemId,
            attachmentCount: parsed.attachmentIds.length,
          },
        };
      },
    );
  }

  assignBug(
    actorUserId: string,
    bugId: string,
    input: AssignBugInput,
  ): BugMutationResult {
    const parsed = AssignBugInputSchema.parse(input);
    return this.updateBug(
      actorUserId,
      bugId,
      parsed.mutationId,
      'BUG_ASSIGN',
      (bug, access, now) => {
        this.requireEditableReport(bug, parsed.expectedVersion);
        if (
          actorUserId !== access.tester_user_id &&
          access.membership_role !== 'OWNER' &&
          !this.isAnyResponsible(actorUserId, bug.submissionId)
        )
          throw new PlatformError(
            'PERMISSION_DENIED',
            '当前成员不能分诊此缺陷',
          );
        this.requireItem(bug.submissionId, parsed.submissionItemId);
        const update = this.db
          .prepare(
            `UPDATE cooking_bug
             SET submission_item_id = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND report_locked_at IS NULL`,
          )
          .run(parsed.submissionItemId, now, bug.id, parsed.expectedVersion);
        if (update.changes !== 1) throw staleBug();
        return {
          action: 'BUG_ASSIGNED',
          details: { submissionItemId: parsed.submissionItemId },
        };
      },
    );
  }

  requestRepair(
    actorUserId: string,
    bugId: string,
    input: RequestRepairInput,
  ): BugMutationResult {
    const parsed = RequestRepairInputSchema.parse(input);
    return this.updateBug(
      actorUserId,
      bugId,
      parsed.mutationId,
      'BUG_REPAIR_REQUEST',
      (bug, access, now) => {
        if (bug.version !== parsed.expectedVersion) throw staleBug();
        if (bug.stage !== 'WAITING_FOR_REPAIR')
          throw new PlatformError(
            'INVALID_TRANSITION',
            '只有待修复缺陷可以开始自动修复',
          );
        if (!bug.submissionItemId)
          throw new PlatformError('VALIDATION_FAILED', '请先确定缺陷所属工程');
        this.requireItem(bug.submissionId, bug.submissionItemId);
        if (actorUserId !== access.tester_user_id)
          throw new PlatformError(
            'PERMISSION_DENIED',
            '只有测试负责人可以开始自动修复',
          );
        const update = this.db
          .prepare(
            `UPDATE cooking_bug
             SET stage = 'REPAIRING', report_locked_at = COALESCE(report_locked_at, ?),
                 version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND stage = 'WAITING_FOR_REPAIR'`,
          )
          .run(now, now, bug.id, parsed.expectedVersion);
        if (update.changes !== 1) throw staleBug();
        this.repairHooks.requested(bug.id);
        return {
          action: 'BUG_REPAIR_REQUESTED',
          details: { submissionItemId: bug.submissionItemId },
        };
      },
    );
  }

  workspace(userId: string, submissionId: string): BugWorkspaceProjection {
    const access = this.requireAccess(userId, submissionId);
    const bugs = (
      this.db
        .prepare(
          `SELECT * FROM cooking_bug
           WHERE submission_id = ? ORDER BY short_id`,
        )
        .all(submissionId) as BugRow[]
    ).map((row) => {
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
          ...(bug.report.notes ? { notes: bug.report.notes } : {}),
          attachments: this.attachments(row.id),
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
        availableActions: this.availableActions(userId, access, bug, item),
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
    const row = this.db
      .prepare(
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
      )
      .get(fileId, fileId, fileId) as { submission_id: string } | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '附件不存在或无权访问');
    try {
      this.requireAccess(userId, row.submission_id);
    } catch {
      throw new PlatformError('NOT_FOUND', '附件不存在或无权访问');
    }
  }

  private updateBug(
    actorUserId: string,
    bugId: string,
    mutationId: string,
    operation: string,
    perform: (
      bug: Bug,
      access: AccessRow,
      now: string,
    ) => {
      action: string;
      details: unknown;
      boundAttachmentIds?: string[];
      unboundAttachmentIds?: string[];
    },
  ): BugMutationResult {
    const replay = this.hasRecordedMutation(mutationId);
    const result = this.writes.run({
      mutationId,
      actorUserId,
      operation,
      resourceType: 'BUG',
      resultSchema: BugMutationResultSchema,
      perform: () => {
        const bug = this.requireBug(bugId);
        const access = this.requireAccess(actorUserId, bug.submissionId);
        this.requireActive(access);
        const now = this.now().toISOString();
        const audit = perform(bug, access, now);
        const revision = this.bumpRevision(bug.submissionId, now);
        return {
          result: {
            bug: this.requireBug(bugId),
            revision,
            boundAttachmentIds: audit.boundAttachmentIds ?? [],
            unboundAttachmentIds: audit.unboundAttachmentIds ?? [],
          },
          resourceId: bugId,
          audits: [
            {
              projectId: access.project_id,
              action: audit.action,
              targetType: 'BUG',
              targetId: bugId,
              details: audit.details,
            },
          ],
        };
      },
    });
    if (!replay) this.onInvalidated(result.bug.submissionId, result.revision);
    return result;
  }

  private requireAccess(userId: string, submissionId: string): AccessRow {
    const row = this.db
      .prepare(
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
      )
      .get(userId, submissionId) as AccessRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '提测单不存在或无权访问');
    return row;
  }

  private requireActive(access: AccessRow): void {
    if (access.submission_status !== 'ACTIVE')
      throw new PlatformError('INVALID_TRANSITION', '已关闭提测单不能修改');
  }

  private requireBug(bugId: string): Bug {
    const row = this.db
      .prepare('SELECT * FROM cooking_bug WHERE id = ?')
      .get(bugId) as BugRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', '缺陷不存在或无权访问');
    return mapBug(row, this.reportAttachmentIds(row.id));
  }

  private requireItem(
    submissionId: string,
    itemId: string | null,
  ): ItemRow | null {
    if (!itemId) return null;
    const row = this.db
      .prepare(
        `SELECT id, engineering_name, engineering_type,
                engineering_identifier, responsible_user_id,
                responsible_username, responsible_display_name,
                responsible_user_created_at, binding_id
         FROM cooking_submission_item
         WHERE id = ? AND submission_id = ?`,
      )
      .get(itemId, submissionId) as ItemRow | undefined;
    if (!row)
      throw new PlatformError('VALIDATION_FAILED', '所选工程不属于当前提测单');
    return row;
  }

  private isAnyResponsible(userId: string, submissionId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM cooking_submission_item
           WHERE submission_id = ? AND responsible_user_id = ? LIMIT 1`,
        )
        .get(submissionId, userId),
    );
  }

  private nextShortId(submissionId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(short_id), 0) + 1 next_id
         FROM cooking_bug WHERE submission_id = ?`,
      )
      .get(submissionId) as { next_id: number };
    return row.next_id;
  }

  private requireEditableReport(bug: Bug, expectedVersion: number): void {
    if (bug.version !== expectedVersion) throw staleBug();
    if (bug.reportLockedAt)
      throw new PlatformError(
        'INVALID_TRANSITION',
        '首次修复后原始缺陷报告不能修改',
      );
  }

  private requireBindableFiles(
    actorUserId: string,
    fileIds: string[],
    currentBugId?: string,
  ): void {
    for (const fileId of fileIds) {
      const row = this.db
        .prepare(
          `SELECT file.uploaded_by_user_id, attachment.bug_id,
                  verification_attachment.file_id verification_file_id,
                  reopen_attachment.file_id reopen_file_id,
                  report_attachment.file_id report_file_id
           FROM platform_file file
           LEFT JOIN cooking_bug_attachment attachment
             ON attachment.file_id = file.id
           LEFT JOIN cooking_verification_attachment verification_attachment
             ON verification_attachment.file_id = file.id
           LEFT JOIN cooking_reopen_attachment reopen_attachment
             ON reopen_attachment.file_id = file.id
           LEFT JOIN cooking_external_deployment_report_attachment report_attachment
             ON report_attachment.file_id = file.id
           WHERE file.id = ?`,
        )
        .get(fileId) as
        | {
            uploaded_by_user_id: string;
            bug_id: string | null;
            verification_file_id: string | null;
            reopen_file_id: string | null;
            report_file_id: string | null;
          }
        | undefined;
      if (
        !row ||
        row.uploaded_by_user_id !== actorUserId ||
        (row.bug_id && row.bug_id !== currentBugId) ||
        row.verification_file_id ||
        row.reopen_file_id ||
        row.report_file_id
      )
        throw new PlatformError(
          'VALIDATION_FAILED',
          '附件不存在、已被使用或不属于当前用户',
        );
    }
  }

  private bindAttachments(bugId: string, fileIds: string[], now: string): void {
    fileIds.forEach((fileId, position) =>
      this.db
        .prepare(
          `INSERT INTO cooking_bug_attachment(
             file_id, bug_id, position, created_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(fileId, bugId, position, now),
    );
  }

  private replaceReportAttachments(
    bugId: string,
    fileIds: string[],
    now: string,
  ): void {
    this.db
      .prepare(`DELETE FROM cooking_bug_attachment WHERE bug_id = ?`)
      .run(bugId);
    this.bindAttachments(bugId, fileIds, now);
  }

  private reportAttachmentIds(bugId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT file_id FROM cooking_bug_attachment
           WHERE bug_id = ? ORDER BY position`,
        )
        .all(bugId) as Array<{ file_id: string }>
    ).map(({ file_id }) => file_id);
  }

  private attachments(
    bugId: string,
  ): Array<
    Pick<
      StoredFile,
      'id' | 'originalName' | 'mediaType' | 'sizeBytes' | 'createdAt'
    >
  > {
    const rows = this.db
      .prepare(
        `SELECT file.id, file.storage_key, file.original_name, file.media_type,
                file.size_bytes, file.sha256, file.uploaded_by_user_id,
                file.created_at
         FROM cooking_bug_attachment attachment
         JOIN platform_file file ON file.id = attachment.file_id
         WHERE attachment.bug_id = ?
         ORDER BY attachment.position`,
      )
      .all(bugId) as Array<{
      id: string;
      storage_key: string;
      original_name: string;
      media_type: string;
      size_bytes: number;
      sha256: string;
      uploaded_by_user_id: string;
      created_at: string;
    }>;
    return rows.map((row) => {
      const file = StoredFileSchema.parse({
        id: row.id,
        storageKey: row.storage_key,
        originalName: row.original_name,
        mediaType: row.media_type,
        sizeBytes: row.size_bytes,
        sha256: row.sha256,
        uploadedByUserId: row.uploaded_by_user_id,
        createdAt: row.created_at,
      });
      return {
        id: file.id,
        originalName: file.originalName,
        mediaType: file.mediaType,
        sizeBytes: file.sizeBytes,
        createdAt: file.createdAt,
      };
    });
  }

  private bumpRevision(submissionId: string, now: string): number {
    const update = this.db
      .prepare(
        `UPDATE cooking_test_submission
         SET workspace_revision = workspace_revision + 1, updated_at = ?
         WHERE id = ? AND status = 'ACTIVE'`,
      )
      .run(now, submissionId);
    if (update.changes !== 1)
      throw new PlatformError('INVALID_TRANSITION', '已关闭提测单不能修改');
    return (
      this.db
        .prepare(
          `SELECT workspace_revision revision
           FROM cooking_test_submission WHERE id = ?`,
        )
        .get(submissionId) as { revision: number }
    ).revision;
  }

  private availableActions(
    userId: string,
    access: AccessRow,
    bug: Bug,
    _item: ItemRow | null,
  ) {
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
    if (bug.stage === 'WAITING_FOR_VERIFICATION')
      actions.push('VERIFY_PASS', 'VERIFY_FAIL');
    if (bug.stage === 'DONE' && !bug.archivedAt)
      actions.push('REOPEN', 'ARCHIVE');
    if (bug.stage === 'DONE' && bug.archivedAt) actions.push('UNARCHIVE');
    return actions;
  }

  private getUser(userId: string): User {
    const row = this.db
      .prepare(
        `SELECT id, username, display_name, created_at
         FROM platform_user WHERE id = ?`,
      )
      .get(userId) as
      | {
          id: string;
          username: string;
          display_name: string;
          created_at: string;
        }
      | undefined;
    if (!row) throw new PlatformError('INTERNAL_ERROR', '缺陷用户快照无效');
    return UserSchema.parse({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      createdAt: row.created_at,
    });
  }

  private hasRecordedMutation(mutationId: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM cooking_mutation WHERE id = ?')
        .get(mutationId),
    );
  }
}

function normalizedReport(input: {
  title: string;
  operationPath?: string;
  actualResult?: string;
  expectedResult?: string;
  notes?: string;
}) {
  return {
    title: input.title.trim(),
    operationPath: normalizedOptional(input.operationPath),
    actualResult: normalizedOptional(input.actualResult),
    expectedResult: normalizedOptional(input.expectedResult),
    notes: normalizedOptional(input.notes),
  };
}

function normalizedOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function mapBug(row: BugRow, attachmentIds: string[]): Bug {
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
      ...(row.notes ? { notes: row.notes } : {}),
      attachmentIds,
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

function staleBug(): PlatformError {
  return new PlatformError('STALE_STATE', '缺陷已更新，请刷新后重试');
}
