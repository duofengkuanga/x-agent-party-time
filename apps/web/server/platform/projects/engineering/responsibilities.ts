import type { AppDatabase } from '@/server/database/index';

export function projectMemberHasEngineeringResponsibilities(
  database: AppDatabase,
  projectId: string,
  userId: string,
): boolean {
  return Boolean(
    database.get(
      `SELECT 1 present
         FROM platform_engineering_membership membership
         JOIN platform_engineering engineering
           ON engineering.id = membership.engineering_id
         WHERE engineering.project_id = ? AND membership.user_id = ?
         LIMIT 1`,
      projectId,
      userId,
    ),
  );
}
