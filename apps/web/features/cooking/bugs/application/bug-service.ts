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
  AddBugFeedbackInputSchema,
  AssignBugInputSchema,
  BugMutationResultSchema,
  BugSchema,
  BugWorkspaceProjectionSchema,
  CreateBugInputSchema,
  ReorderRepairQueueInputSchema,
  RepairQueueMutationResultSchema,
  RequestRepairInputSchema,
  UpdateBugReportInputSchema,
  WithdrawRepairInputSchema,
  type AddBugFeedbackInput,
  type AssignBugInput,
  type Bug,
  type BugMutationResult,
  type BugWorkspaceProjection,
  type CreateBugInput,
  type ReorderRepairQueueInput,
  type RepairQueueMutationResult,
  type RequestRepairInput,
  type UpdateBugReportInput,
  type WithdrawRepairInput,
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
  responsible_user_id: string;
  responsible_username: string;
  responsible_display_name: string;
  responsible_user_created_at: string;
  binding_id: string;
};

type FeedbackRow = {
  id: string;
  bug_id: string;
  kind: 'TESTER_FEEDBACK' | 'DEVELOPER_NOTE' | 'EXECUTION_FAILURE';
  author_user_id: string | null;
  content: string;
  created_at: string;
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
  requested: (bugId: string, priority: number) => void;
  withdrawn: (bugId: string) => void;
  reordered: (submissionId: string) => void;
};

const NOOP_REPAIR_HOOKS: BugRepairHooks = {
  requested: () => {},
  withdrawn: () => {},
  reordered: () => {},
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
        this.bindAttachments(bugId, null, parsed.attachmentIds, now);
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
            '只有待修复缺陷可以进入修复队列',
          );
        if (!bug.submissionItemId)
          throw new PlatformError('VALIDATION_FAILED', '请先确定缺陷所属工程');
        const item = this.requireItem(bug.submissionId, bug.submissionItemId)!;
        if (
          actorUserId !== access.tester_user_id &&
          actorUserId !== item.responsible_user_id
        )
          throw new PlatformError(
            'PERMISSION_DENIED',
            '只有测试负责人或该工程负责人可以发起修复',
          );
        this.ensureQueue(bug.submissionId, now);
        this.db
          .prepare(
            `UPDATE cooking_repair_queue_entry
             SET position = position + 1 WHERE submission_id = ?`,
          )
          .run(bug.submissionId);
        this.db
          .prepare(
            `INSERT INTO cooking_repair_queue_entry(
               bug_id, submission_id, submission_item_id, binding_id,
               position, queued_at
             ) VALUES (?, ?, ?, ?, 0, ?)`,
          )
          .run(
            bug.id,
            bug.submissionId,
            bug.submissionItemId,
            item.binding_id,
            now,
          );
        this.db
          .prepare(
            `UPDATE cooking_repair_queue
             SET version = version + 1, updated_at = ? WHERE submission_id = ?`,
          )
          .run(now, bug.submissionId);
        const update = this.db
          .prepare(
            `UPDATE cooking_bug
             SET stage = 'REPAIRING', report_locked_at = COALESCE(report_locked_at, ?),
                 version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND stage = 'WAITING_FOR_REPAIR'`,
          )
          .run(now, now, bug.id, parsed.expectedVersion);
        if (update.changes !== 1) throw staleBug();
        this.repairHooks.requested(bug.id, 0);
        return {
          action: 'BUG_REPAIR_REQUESTED',
          details: { submissionItemId: bug.submissionItemId, position: 0 },
        };
      },
    );
  }

  withdrawRepair(
    actorUserId: string,
    bugId: string,
    input: WithdrawRepairInput,
  ): BugMutationResult {
    const parsed = WithdrawRepairInputSchema.parse(input);
    return this.updateBug(
      actorUserId,
      bugId,
      parsed.mutationId,
      'BUG_REPAIR_WITHDRAW',
      (bug, access, now) => {
        if (bug.version !== parsed.expectedVersion) throw staleBug();
        if (bug.stage !== 'REPAIRING' || !bug.submissionItemId)
          throw new PlatformError('INVALID_TRANSITION', '当前缺陷不能撤回修复');
        const item = this.requireItem(bug.submissionId, bug.submissionItemId)!;
        if (
          actorUserId !== access.tester_user_id &&
          actorUserId !== item.responsible_user_id
        )
          throw new PlatformError(
            'PERMISSION_DENIED',
            '只有测试负责人或该工程负责人可以撤回修复',
          );
        const entry = this.db
          .prepare(
            `SELECT position FROM cooking_repair_queue_entry
             WHERE bug_id = ? AND submission_id = ?`,
          )
          .get(bug.id, bug.submissionId) as { position: number } | undefined;
        if (!entry)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '修复已开始，不能直接撤回',
          );
        this.repairHooks.withdrawn(bug.id);
        this.db
          .prepare('DELETE FROM cooking_repair_queue_entry WHERE bug_id = ?')
          .run(bug.id);
        this.db
          .prepare(
            `UPDATE cooking_repair_queue_entry
             SET position = position - 1
             WHERE submission_id = ? AND position > ?`,
          )
          .run(bug.submissionId, entry.position);
        this.db
          .prepare(
            `UPDATE cooking_repair_queue
             SET version = version + 1, updated_at = ? WHERE submission_id = ?`,
          )
          .run(now, bug.submissionId);
        const update = this.db
          .prepare(
            `UPDATE cooking_bug
             SET stage = 'WAITING_FOR_REPAIR', version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND stage = 'REPAIRING'`,
          )
          .run(now, bug.id, parsed.expectedVersion);
        if (update.changes !== 1) throw staleBug();
        return {
          action: 'BUG_REPAIR_WITHDRAWN',
          details: { previousPosition: entry.position },
        };
      },
    );
  }

  reorderQueue(
    actorUserId: string,
    submissionId: string,
    input: ReorderRepairQueueInput,
  ): RepairQueueMutationResult {
    const parsed = ReorderRepairQueueInputSchema.parse(input);
    const replay = this.hasRecordedMutation(parsed.mutationId);
    const result = this.writes.run({
      mutationId: parsed.mutationId,
      actorUserId,
      operation: 'REPAIR_QUEUE_REORDER',
      resourceType: 'REPAIR_QUEUE',
      resultSchema: RepairQueueMutationResultSchema,
      perform: () => {
        const access = this.requireAccess(actorUserId, submissionId);
        this.requireActive(access);
        if (
          actorUserId !== access.tester_user_id &&
          !this.isAnyResponsible(actorUserId, submissionId)
        )
          throw new PlatformError(
            'PERMISSION_DENIED',
            '当前成员不能调整修复队列',
          );
        const now = this.now().toISOString();
        this.ensureQueue(submissionId, now);
        const queue = this.db
          .prepare(
            'SELECT version FROM cooking_repair_queue WHERE submission_id = ?',
          )
          .get(submissionId) as { version: number };
        if (queue.version !== parsed.expectedVersion)
          throw new PlatformError(
            'STALE_STATE',
            '修复队列已更新，请刷新后重试',
          );
        const current = this.queueEntries(submissionId).map(
          ({ bug_id }) => bug_id,
        );
        if (
          new Set(parsed.bugIds).size !== parsed.bugIds.length ||
          current.length !== parsed.bugIds.length ||
          current.some((id) => !parsed.bugIds.includes(id))
        )
          throw new PlatformError(
            'VALIDATION_FAILED',
            '修复队列顺序与当前等待项不一致',
          );
        this.db
          .prepare(
            `UPDATE cooking_repair_queue_entry
             SET position = position + 1000000 WHERE submission_id = ?`,
          )
          .run(submissionId);
        parsed.bugIds.forEach((bugId, position) =>
          this.db
            .prepare(
              `UPDATE cooking_repair_queue_entry
               SET position = ? WHERE submission_id = ? AND bug_id = ?`,
            )
            .run(position, submissionId, bugId),
        );
        this.db
          .prepare(
            `UPDATE cooking_repair_queue
             SET version = version + 1, updated_at = ? WHERE submission_id = ?`,
          )
          .run(now, submissionId);
        this.repairHooks.reordered(submissionId);
        const revision = this.bumpRevision(submissionId, now);
        return {
          result: {
            submissionId,
            version: queue.version + 1,
            revision,
          },
          resourceId: submissionId,
          audits: [
            {
              projectId: access.project_id,
              action: 'REPAIR_QUEUE_REORDERED',
              targetType: 'REPAIR_QUEUE',
              targetId: submissionId,
              details: { bugIds: parsed.bugIds },
            },
          ],
        };
      },
    });
    if (!replay) this.onInvalidated(result.submissionId, result.revision);
    return result;
  }

  addFeedback(
    actorUserId: string,
    bugId: string,
    input: AddBugFeedbackInput,
  ): BugMutationResult {
    const parsed = AddBugFeedbackInputSchema.parse(input);
    return this.updateBug(
      actorUserId,
      bugId,
      parsed.mutationId,
      'BUG_FEEDBACK_ADD',
      (bug, access, now) => {
        if (bug.version !== parsed.expectedVersion) throw staleBug();
        if (!bug.reportLockedAt)
          throw new PlatformError(
            'INVALID_TRANSITION',
            '首次修复前请直接编辑缺陷报告',
          );
        const item = this.requireItem(bug.submissionId, bug.submissionItemId);
        const tester = actorUserId === access.tester_user_id;
        if (!tester && actorUserId !== item?.responsible_user_id)
          throw new PlatformError(
            'PERMISSION_DENIED',
            '当前成员不能补充此缺陷反馈',
          );
        this.requireBindableFiles(actorUserId, parsed.attachmentIds);
        const feedbackId = this.createId();
        this.db
          .prepare(
            `INSERT INTO cooking_bug_feedback(
               id, bug_id, kind, author_user_id, content, created_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            feedbackId,
            bug.id,
            tester ? 'TESTER_FEEDBACK' : 'DEVELOPER_NOTE',
            actorUserId,
            parsed.content,
            now,
          );
        this.bindAttachments(bug.id, feedbackId, parsed.attachmentIds, now);
        const update = this.db
          .prepare(
            `UPDATE cooking_bug SET version = version + 1, updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .run(now, bug.id, parsed.expectedVersion);
        if (update.changes !== 1) throw staleBug();
        return {
          action: 'BUG_FEEDBACK_ADDED',
          boundAttachmentIds: parsed.attachmentIds,
          unboundAttachmentIds: [],
          details: {
            feedbackId,
            kind: tester ? 'TESTER_FEEDBACK' : 'DEVELOPER_NOTE',
            attachmentCount: parsed.attachmentIds.length,
          },
        };
      },
    );
  }

  workspace(userId: string, submissionId: string): BugWorkspaceProjection {
    const access = this.requireAccess(userId, submissionId);
    const queueRow = this.db
      .prepare(
        'SELECT version FROM cooking_repair_queue WHERE submission_id = ?',
      )
      .get(submissionId) as { version: number } | undefined;
    const entries = this.queueEntries(submissionId);
    const queuePosition = new Map(
      entries.map(({ bug_id, position }) => [bug_id, position]),
    );
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
      const feedback = this.feedback(row.id);
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
          attachments: this.attachments(row.id, null),
        },
        createdBy: this.getUser(bug.createdByUserId),
        assignment: item
          ? {
              submissionItemId: item.id,
              engineeringName: item.engineering_name,
              responsibleUser: itemUser(item),
            }
          : null,
        feedback: feedback.map((entry) => ({
          id: entry.id,
          bugId: entry.bug_id,
          kind: entry.kind,
          authorUserId: entry.author_user_id,
          content: entry.content,
          attachments: this.attachments(row.id, entry.id),
          createdAt: entry.created_at,
        })),
        availableActions: this.availableActions(
          userId,
          access,
          bug,
          item,
          queuePosition.has(bug.id),
        ),
        presentation: {
          stageLabel: STAGE_LABELS[bug.stage],
          assignmentLabel: item?.engineering_name ?? '暂未确定工程',
          queuePosition: queuePosition.get(bug.id) ?? null,
        },
      };
    });
    return BugWorkspaceProjectionSchema.parse({
      availableActions:
        access.submission_status === 'ACTIVE' &&
        userId === access.tester_user_id
          ? ['CREATE_BUG']
          : [],
      repairQueue: {
        submissionId,
        version: queueRow?.version ?? 1,
        entries: entries.map((entry) => ({
          bugId: entry.bug_id,
          submissionItemId: entry.submission_item_id,
          position: entry.position,
          queuedAt: entry.queued_at,
        })),
        availableActions:
          access.submission_status === 'ACTIVE' &&
          (userId === access.tester_user_id ||
            this.isAnyResponsible(userId, submissionId))
            ? ['REORDER']
            : [],
      },
      bugs,
    });
  }

  requireAttachmentAccess(userId: string, fileId: string): void {
    const row = this.db
      .prepare(
        `SELECT bug.submission_id
         FROM cooking_bug_attachment attachment
         JOIN cooking_bug bug ON bug.id = attachment.bug_id
         WHERE attachment.file_id = ?`,
      )
      .get(fileId) as { submission_id: string } | undefined;
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
        `SELECT id, engineering_name, responsible_user_id,
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
          `SELECT file.uploaded_by_user_id, attachment.bug_id
           FROM platform_file file
           LEFT JOIN cooking_bug_attachment attachment
             ON attachment.file_id = file.id
           WHERE file.id = ?`,
        )
        .get(fileId) as
        { uploaded_by_user_id: string; bug_id: string | null } | undefined;
      if (
        !row ||
        row.uploaded_by_user_id !== actorUserId ||
        (row.bug_id && row.bug_id !== currentBugId)
      )
        throw new PlatformError(
          'VALIDATION_FAILED',
          '附件不存在、已被使用或不属于当前用户',
        );
    }
  }

  private bindAttachments(
    bugId: string,
    feedbackId: string | null,
    fileIds: string[],
    now: string,
  ): void {
    fileIds.forEach((fileId, position) =>
      this.db
        .prepare(
          `INSERT INTO cooking_bug_attachment(
             file_id, bug_id, feedback_id, position, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(fileId, bugId, feedbackId, position, now),
    );
  }

  private replaceReportAttachments(
    bugId: string,
    fileIds: string[],
    now: string,
  ): void {
    this.db
      .prepare(
        `DELETE FROM cooking_bug_attachment
         WHERE bug_id = ? AND feedback_id IS NULL`,
      )
      .run(bugId);
    this.bindAttachments(bugId, null, fileIds, now);
  }

  private reportAttachmentIds(bugId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT file_id FROM cooking_bug_attachment
           WHERE bug_id = ? AND feedback_id IS NULL ORDER BY position`,
        )
        .all(bugId) as Array<{ file_id: string }>
    ).map(({ file_id }) => file_id);
  }

  private attachments(
    bugId: string,
    feedbackId: string | null,
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
           AND (
             (? IS NULL AND attachment.feedback_id IS NULL) OR
             attachment.feedback_id = ?
           )
         ORDER BY attachment.position`,
      )
      .all(bugId, feedbackId, feedbackId) as Array<{
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

  private feedback(bugId: string): FeedbackRow[] {
    return this.db
      .prepare(
        `SELECT * FROM cooking_bug_feedback
         WHERE bug_id = ? ORDER BY created_at, id`,
      )
      .all(bugId) as FeedbackRow[];
  }

  private ensureQueue(submissionId: string, now: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO cooking_repair_queue(
           submission_id, version, updated_at
         ) VALUES (?, 1, ?)`,
      )
      .run(submissionId, now);
  }

  private queueEntries(submissionId: string): Array<{
    bug_id: string;
    submission_item_id: string;
    position: number;
    queued_at: string;
  }> {
    return this.db
      .prepare(
        `SELECT bug_id, submission_item_id, position, queued_at
         FROM cooking_repair_queue_entry
         WHERE submission_id = ?
         ORDER BY position, queued_at, bug_id`,
      )
      .all(submissionId) as Array<{
      bug_id: string;
      submission_item_id: string;
      position: number;
      queued_at: string;
    }>;
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
    item: ItemRow | null,
    queued: boolean,
  ) {
    if (access.submission_status !== 'ACTIVE') return [];
    const tester = userId === access.tester_user_id;
    const assignedResponsible = userId === item?.responsible_user_id;
    const anyResponsible = this.isAnyResponsible(userId, bug.submissionId);
    const actions: Array<
      | 'EDIT_REPORT'
      | 'ASSIGN'
      | 'REQUEST_REPAIR'
      | 'WITHDRAW_REPAIR'
      | 'ADD_FEEDBACK'
      | 'VERIFY_PASS'
      | 'VERIFY_FAIL'
      | 'REOPEN'
      | 'CANCEL'
    > = [];
    if (!bug.reportLockedAt) {
      if (tester) actions.push('EDIT_REPORT');
      if (tester || access.membership_role === 'OWNER' || anyResponsible)
        actions.push('ASSIGN');
      if (
        bug.stage === 'WAITING_FOR_REPAIR' &&
        bug.submissionItemId &&
        (tester || assignedResponsible)
      )
        actions.push('REQUEST_REPAIR');
    } else {
      if (tester || assignedResponsible) actions.push('ADD_FEEDBACK');
      if (
        bug.stage === 'REPAIRING' &&
        queued &&
        (tester || assignedResponsible)
      )
        actions.push('WITHDRAW_REPAIR');
    }
    if (tester && bug.stage === 'WAITING_FOR_VERIFICATION')
      actions.push('VERIFY_PASS', 'VERIFY_FAIL');
    if (tester && bug.stage === 'DONE') actions.push('REOPEN');
    if (
      tester &&
      ['WAITING_FOR_REPAIR', 'WAITING_FOR_UPDATE'].includes(bug.stage)
    )
      actions.push('CANCEL');
    if (
      tester &&
      bug.stage === 'REPAIRING' &&
      !this.hasActiveRepairExecution(bug.id)
    )
      actions.push('CANCEL');
    return actions;
  }

  private hasActiveRepairExecution(bugId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT execution.state
         FROM cooking_repair_attempt attempt
         JOIN platform_execution execution ON execution.id = attempt.execution_id
         WHERE attempt.bug_id = ? ORDER BY attempt.attempt DESC LIMIT 1`,
      )
      .get(bugId) as { state: string } | undefined;
    return Boolean(
      row && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(row.state),
    );
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
