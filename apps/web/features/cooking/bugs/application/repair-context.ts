import type { AppDatabase } from '@/server/database';
import { PlatformError } from '@/server/errors';
import { z } from 'zod';

const BugReportAttachmentSchema = z.object({
  id: z.string().min(1),
  originalName: z.string().min(1),
});

const BugRepairContextSchema = z.object({
  bugId: z.string().min(1),
  submissionId: z.string().min(1),
  submissionTitle: z.string().min(1),
  requirementDescription: z.string(),
  engineeringName: z.string().min(1),
  repositoryUrl: z.string().min(1),
  targetBranch: z.string().min(1),
  runnerId: z.string().min(1),
  bindingId: z.string().min(1),
  report: z.object({
    title: z.string().min(1),
    operationPath: z.string().nullable(),
    actualResult: z.string().nullable(),
    expectedResult: z.string().nullable(),
    attachments: z.object({
      actualResult: z.array(BugReportAttachmentSchema),
      expectedResult: z.array(BugReportAttachmentSchema),
    }),
  }),
  feedback: z.array(z.string().min(1)),
});

export type BugReportAttachment = z.infer<typeof BugReportAttachmentSchema>;
export type BugRepairContext = z.infer<typeof BugRepairContextSchema>;

type ContextRow = {
  bug_id: string;
  submission_id: string;
  title: string;
  operation_path: string | null;
  actual_result: string | null;
  expected_result: string | null;
  submission_title: string;
  requirement_description: string;
  engineering_name: string;
  repository_url: string;
  target_branch: string;
  runner_id: string;
  binding_id: string;
};

type AttachmentRow = {
  id: string;
  original_name: string;
  role: 'ACTUAL_RESULT' | 'EXPECTED_RESULT';
};

export class BugRepairContextService {
  constructor(private readonly db: AppDatabase) {}

  get(bugId: string): BugRepairContext {
    const row = this.db
      .prepare(
        `SELECT bug.id bug_id, bug.submission_id, bug.title, bug.operation_path,
                bug.actual_result, bug.expected_result,
                submission.title submission_title,
                submission.requirement_description,
                item.engineering_name, item.repository_url, item.target_branch,
                item.binding_id, binding.runner_id
         FROM cooking_bug bug
         JOIN cooking_test_submission submission ON submission.id = bug.submission_id
         JOIN cooking_submission_item item ON item.id = bug.submission_item_id
         JOIN cooking_engineering_binding binding ON binding.id = item.binding_id
         WHERE bug.id = ?`,
      )
      .get(bugId) as ContextRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', 'Repair Bug 不存在');
    const attachments = this.db
      .prepare(
        `SELECT file.id, file.original_name, attachment.role
         FROM cooking_bug_attachment attachment
         JOIN platform_file file ON file.id = attachment.file_id
         WHERE attachment.bug_id = ?
         ORDER BY CASE attachment.role
           WHEN 'ACTUAL_RESULT' THEN 0
           WHEN 'EXPECTED_RESULT' THEN 1
         END, attachment.position`,
      )
      .all(bugId) as AttachmentRow[];
    const actualResult = attachments
      .filter(({ role }) => role === 'ACTUAL_RESULT')
      .map(mapAttachment);
    const expectedResult = attachments
      .filter(({ role }) => role === 'EXPECTED_RESULT')
      .map(mapAttachment);
    const feedback = (
      this.db
        .prepare(
          `SELECT content FROM (
             SELECT comment content, created_at, id
             FROM cooking_verification_record
             WHERE bug_id = ? AND result = 'FAILED'
             UNION ALL
             SELECT feedback content, created_at, id
             FROM cooking_reopen_record WHERE bug_id = ?
           ) ORDER BY created_at, id`,
        )
        .all(bugId, bugId) as Array<{ content: string }>
    ).map(({ content }) => content);

    return BugRepairContextSchema.parse({
      bugId: row.bug_id,
      submissionId: row.submission_id,
      submissionTitle: row.submission_title,
      requirementDescription: row.requirement_description,
      engineeringName: row.engineering_name,
      repositoryUrl: row.repository_url,
      targetBranch: row.target_branch,
      runnerId: row.runner_id,
      bindingId: row.binding_id,
      report: {
        title: row.title,
        operationPath: row.operation_path,
        actualResult: row.actual_result,
        expectedResult: row.expected_result,
        attachments: { actualResult, expectedResult },
      },
      feedback,
    });
  }
}

function mapAttachment(row: AttachmentRow): BugReportAttachment {
  return { id: row.id, originalName: row.original_name };
}
