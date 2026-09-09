import type { AppDatabase } from '@/platform/database';

export function projectMemberHasEngineeringResponsibilities(
  database: AppDatabase,
  projectId: string,
  userId: string,
): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 present
         FROM cooking_engineering_membership membership
         JOIN cooking_engineering engineering
           ON engineering.id = membership.engineering_id
         WHERE engineering.project_id = ? AND membership.user_id = ?
         LIMIT 1`,
      )
      .get(projectId, userId),
  );
}
