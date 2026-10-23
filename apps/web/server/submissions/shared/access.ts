import type { AppDatabase } from '@/server/database/index';
import { PlatformError } from '@/server/platform/errors/index';

export function requireSubmissionAccess(
  db: AppDatabase,
  userId: string,
  submissionId: string,
): void {
  const membership = db.get(
    `
    SELECT 1 FROM test_submission submission
    JOIN platform_project_membership membership
      ON membership.project_id = submission.project_id
    WHERE submission.id = ? AND membership.user_id = ?
  `,
    submissionId,
    userId,
  );
  if (!membership) throw new PlatformError('NOT_FOUND', '提测单不存在');
}
