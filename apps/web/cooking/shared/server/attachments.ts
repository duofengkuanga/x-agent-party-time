import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';

/** Attachments belong to one report, verification, reopening or deployment. */
export function requireBindableFiles(
  db: AppDatabase,
  userId: string,
  fileIds: string[],
  currentBugId: string | null = null,
): void {
  const available = db.prepare(`
    SELECT 1 FROM platform_file file
    WHERE file.id = ? AND file.uploaded_by_user_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM cooking_bug_attachment
        WHERE file_id = file.id AND bug_id IS NOT ?
      )
      AND NOT EXISTS (SELECT 1 FROM cooking_verification_attachment WHERE file_id = file.id)
      AND NOT EXISTS (SELECT 1 FROM cooking_reopen_attachment WHERE file_id = file.id)
      AND NOT EXISTS (SELECT 1 FROM cooking_external_deployment_report_attachment WHERE file_id = file.id)
  `);
  for (const fileId of fileIds) {
    if (!available.get(fileId, userId, currentBugId))
      throw new PlatformError(
        'VALIDATION_FAILED',
        '附件不存在、已被使用或不属于当前用户',
      );
  }
}
