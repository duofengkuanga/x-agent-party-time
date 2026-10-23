import type { AppDatabase } from '@/server/database';
import { PlatformError } from '@/server/platform/errors';

export function requireProjectMember(
  db: AppDatabase,
  userId: string,
  projectId: string,
): { role: 'OWNER' | 'MEMBER' } {
  const membership = db.get(
    `
    SELECT role FROM platform_project_membership
    WHERE project_id = ? AND user_id = ?
  `,
    projectId,
    userId,
  ) as { role: 'OWNER' | 'MEMBER' } | null;
  if (!membership) throw new PlatformError('NOT_FOUND', '项目不存在或无权访问');
  return membership;
}
