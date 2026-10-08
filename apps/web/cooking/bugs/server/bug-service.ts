import { requireBindableFiles } from '@/cooking/shared/server/attachments';
import { BugDeletion } from './bug-deletion';
import {
  BugQueries,
  type AccessRow,
  type BugAttachmentRole,
  type ReportAttachmentIds,
} from './bug-queries';
import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import { TestSubmissionWriteStore } from '@/cooking/submissions/server/test-submission-write-store';
import {
  AssignBugInputSchema,
  BugMutationResultSchema,
  CreateBugInputSchema,
  RequestRepairInputSchema,
  UpdateBugReportInputSchema,
  type AssignBugInput,
  type Bug,
  type BugMutationResult,
  type BugWorkspaceProjection,
  type BugDeleteRequest,
  type BugDeleteResponse,
  type CreateBugInput,
  type RequestRepairInput,
  type UpdateBugReportInput,
} from '../contract';

export type BugRepairHooks = {
  requested: (bugId: string) => void;
};

const NOOP_REPAIR_HOOKS: BugRepairHooks = {
  requested: () => {},
};

export class BugService {
  private readonly writes: TestSubmissionWriteStore;
  private readonly queries: BugQueries;

  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    onInvalidated: (submissionId: string, revision: number) => void = () => {},
    private readonly repairHooks: BugRepairHooks = NOOP_REPAIR_HOOKS,
  ) {
    this.writes = new TestSubmissionWriteStore(
      db,
      now,
      createId,
      onInvalidated,
    );
    this.queries = new BugQueries(db);
  }

  createBug(
    actorUserId: string,
    submissionId: string,
    input: CreateBugInput,
  ): BugMutationResult {
    const parsed = CreateBugInputSchema.parse(input);
    return this.writes.run({
      mutationId: parsed.mutationId,
      actorUserId,
      operation: 'BUG_CREATE',
      resourceType: 'BUG',
      resultSchema: BugMutationResultSchema,
      invalidation: (mutation) => ({
        submissionId: mutation.bug.submissionId,
        revision: mutation.revision,
      }),
      perform: () => {
        const access = this.queries.requireAccess(actorUserId, submissionId);
        this.requireActive(access);
        if (actorUserId !== access.tester_user_id)
          throw new PlatformError(
            'PERMISSION_DENIED',
            '只有测试负责人可以登记缺陷',
          );
        this.queries.requireItem(submissionId, parsed.submissionItemId);
        const attachmentIds = reportAttachmentIds(parsed);
        requireBindableFiles(this.db, actorUserId, attachmentIds);
        const now = this.now().toISOString();
        const bugId = this.createId();
        const shortId = this.queries.nextShortId(submissionId);
        const report = normalizedReport(parsed);
        this.db.run(
          `INSERT INTO cooking_bug(
               id, short_id, submission_id, submission_item_id, stage,
               title, operation_path, actual_result, expected_result,
               report_locked_at, version, created_by_user_id, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'WAITING_FOR_REPAIR', ?, ?, ?, ?, NULL, 1, ?, ?, ?)`,
          [
            bugId,
            shortId,
            submissionId,
            parsed.submissionItemId,
            report.title,
            report.operationPath ?? null,
            report.actualResult ?? null,
            report.expectedResult ?? null,
            actorUserId,
            now,
            now,
          ],
        );
        this.bindReportAttachments(bugId, parsed, now);
        const revision = this.writes.bumpRevision(submissionId, now);
        const bug = this.queries.requireBug(bugId);
        return {
          result: {
            bug,
            revision,
            boundAttachmentIds: attachmentIds,
            unboundAttachmentIds: [],
          },
          resourceId: bugId,
          audit: {
            projectId: access.project_id,
            action: 'BUG_CREATED',
            details: {
              shortId,
              submissionItemId: parsed.submissionItemId,
              attachmentCount: attachmentIds.length,
            },
          },
        };
      },
    });
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
        this.queries.requireItem(bug.submissionId, parsed.submissionItemId);
        const attachmentIds = reportAttachmentIds(parsed);
        requireBindableFiles(this.db, actorUserId, attachmentIds, bug.id);
        const report = normalizedReport(parsed);
        const update = this.db.run(
          `UPDATE cooking_bug
             SET submission_item_id = ?, title = ?, operation_path = ?,
                 actual_result = ?, expected_result = ?,
                 version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND report_locked_at IS NULL`,
          [
            parsed.submissionItemId,
            report.title,
            report.operationPath ?? null,
            report.actualResult ?? null,
            report.expectedResult ?? null,
            now,
            bug.id,
            parsed.expectedVersion,
          ],
        );
        if (update.changes !== 1) throw staleBug();
        this.replaceReportAttachments(bug.id, parsed, now);
        const previousAttachmentIds = reportAttachmentIds(bug.report);
        return {
          action: 'BUG_REPORT_UPDATED',
          boundAttachmentIds: attachmentIds,
          unboundAttachmentIds: previousAttachmentIds.filter(
            (fileId) => !attachmentIds.includes(fileId),
          ),
          details: {
            submissionItemId: parsed.submissionItemId,
            attachmentCount: attachmentIds.length,
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
          !this.queries.isAnyResponsible(actorUserId, bug.submissionId)
        )
          throw new PlatformError(
            'PERMISSION_DENIED',
            '当前成员不能分诊此缺陷',
          );
        this.queries.requireItem(bug.submissionId, parsed.submissionItemId);
        const update = this.db.run(
          `UPDATE cooking_bug
             SET submission_item_id = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND report_locked_at IS NULL`,
          [parsed.submissionItemId, now, bug.id, parsed.expectedVersion],
        );
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
        this.queries.requireItem(bug.submissionId, bug.submissionItemId);
        if (actorUserId !== access.tester_user_id)
          throw new PlatformError(
            'PERMISSION_DENIED',
            '只有测试负责人可以开始自动修复',
          );
        const update = this.db.run(
          `UPDATE cooking_bug
             SET stage = 'REPAIRING', report_locked_at = COALESCE(report_locked_at, ?),
                 version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND stage = 'WAITING_FOR_REPAIR'`,
          [now, now, bug.id, parsed.expectedVersion],
        );
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
    return this.queries.workspace(userId, submissionId);
  }

  requireAttachmentAccess(userId: string, fileId: string): void {
    this.queries.requireAttachmentAccess(userId, fileId);
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
    return this.writes.run({
      mutationId,
      actorUserId,
      operation,
      resourceType: 'BUG',
      resultSchema: BugMutationResultSchema,
      invalidation: (mutation) => ({
        submissionId: mutation.bug.submissionId,
        revision: mutation.revision,
      }),
      perform: () => {
        const bug = this.queries.requireBug(bugId);
        const access = this.queries.requireAccess(
          actorUserId,
          bug.submissionId,
        );
        this.requireActive(access);
        const now = this.now().toISOString();
        const audit = perform(bug, access, now);
        const revision = this.writes.bumpRevision(bug.submissionId, now);
        return {
          result: {
            bug: this.queries.requireBug(bugId),
            revision,
            boundAttachmentIds: audit.boundAttachmentIds ?? [],
            unboundAttachmentIds: audit.unboundAttachmentIds ?? [],
          },
          resourceId: bugId,
          audit: {
            projectId: access.project_id,
            action: audit.action,
            details: audit.details,
          },
        };
      },
    });
  }

  private requireActive(access: AccessRow): void {
    if (access.submission_status !== 'ACTIVE')
      throw new PlatformError('INVALID_TRANSITION', '已关闭提测单不能修改');
  }

  private requireEditableReport(bug: Bug, expectedVersion: number): void {
    if (bug.version !== expectedVersion) throw staleBug();
    if (bug.reportLockedAt)
      throw new PlatformError(
        'INVALID_TRANSITION',
        '首次修复后原始缺陷报告不能修改',
      );
  }

  private bindAttachments(
    bugId: string,
    role: BugAttachmentRole,
    fileIds: string[],
    now: string,
  ): void {
    fileIds.forEach((fileId, position) =>
      this.db.run(
        `INSERT INTO cooking_bug_attachment(
             file_id, bug_id, role, position, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        [fileId, bugId, role, position, now],
      ),
    );
  }

  private bindReportAttachments(
    bugId: string,
    attachmentIds: ReportAttachmentIds,
    now: string,
  ): void {
    for (const [role, fileIds] of [
      ['ACTUAL_RESULT', attachmentIds.actualResultAttachmentIds],
      ['EXPECTED_RESULT', attachmentIds.expectedResultAttachmentIds],
    ] as const)
      this.bindAttachments(bugId, role, fileIds, now);
  }

  private replaceReportAttachments(
    bugId: string,
    attachmentIds: ReportAttachmentIds,
    now: string,
  ): void {
    this.db.run(`DELETE FROM cooking_bug_attachment WHERE bug_id = ?`, [bugId]);
    this.bindReportAttachments(bugId, attachmentIds, now);
  }

  deleteBugs(input: BugDeleteRequest): BugDeleteResponse {
    return new BugDeletion(
      this.db,
      (bugId) => this.queries.requireBug(bugId),
      this.writes,
      () => this.now(),
    ).deleteBugs(input);
  }
}

function normalizedReport(input: {
  title: string;
  operationPath?: string;
  actualResult?: string;
  expectedResult?: string;
}) {
  return {
    title: input.title.trim(),
    operationPath: normalizedOptional(input.operationPath),
    actualResult: normalizedOptional(input.actualResult),
    expectedResult: normalizedOptional(input.expectedResult),
  };
}

function normalizedOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function reportAttachmentIds(report: ReportAttachmentIds): string[] {
  return [
    ...report.actualResultAttachmentIds,
    ...report.expectedResultAttachmentIds,
  ];
}

function staleBug(): PlatformError {
  return new PlatformError('STALE_STATE', '缺陷已更新，请刷新后重试');
}
