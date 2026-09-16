import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';

export function requireSubmissionAccess(
  db: AppDatabase,
  userId: string,
  submissionId: string,
): void {
  const membership = db
    .prepare(
      `
    SELECT 1 FROM cooking_test_submission submission
    JOIN cooking_project_membership membership
      ON membership.project_id = submission.project_id
    WHERE submission.id = ? AND membership.user_id = ?
  `,
    )
    .get(submissionId, userId);
  if (!membership) throw new PlatformError('NOT_FOUND', '提测单不存在');
}

export function requireProjectMember(
  db: AppDatabase,
  userId: string,
  projectId: string,
): { role: 'OWNER' | 'MEMBER' } {
  const membership = db
    .prepare(
      `
    SELECT role FROM cooking_project_membership
    WHERE project_id = ? AND user_id = ?
  `,
    )
    .get(projectId, userId) as { role: 'OWNER' | 'MEMBER' } | null;
  if (!membership) throw new PlatformError('NOT_FOUND', '项目不存在或无权访问');
  return membership;
}
