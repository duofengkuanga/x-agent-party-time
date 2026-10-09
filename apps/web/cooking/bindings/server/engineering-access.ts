import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';

export function requireBindingEngineering(
  db: AppDatabase,
  actorUserId: string,
  engineeringId: string,
): { project_id: string } {
  const engineering = db.get(
    `SELECT engineering.project_id, engineering.archived_at
       FROM cooking_engineering engineering
       JOIN cooking_engineering_membership membership
         ON membership.engineering_id = engineering.id
        AND membership.user_id = ?
       WHERE engineering.id = ?`,
    actorUserId,
    engineeringId,
  ) as { project_id: string; archived_at: string | null } | undefined;
  if (!engineering) throw new PlatformError('NOT_FOUND', '工程不存在或你不是工程成员');
  if (engineering.archived_at)
    throw new PlatformError('INVALID_TRANSITION', '已归档工程不能建立绑定');
  return engineering;
}
