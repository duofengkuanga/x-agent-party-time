import type { AppDatabase } from '@/platform/database';

export function projectMemberHasSubmissionResponsibilities(
  database: AppDatabase,
  projectId: string,
  userId: string,
): boolean {
  return Boolean(
    database.get(
      `SELECT 1 present
         FROM cooking_test_submission submission
         LEFT JOIN cooking_submission_item item
           ON item.submission_id = submission.id
          AND item.responsible_user_id = ?
         WHERE submission.project_id = ?
           AND submission.status = 'ACTIVE'
           AND (submission.tester_user_id = ? OR item.id IS NOT NULL)
         LIMIT 1`,
      userId,
      projectId,
      userId,
    ),
  );
}

export function submissionReferencesEngineering(
  database: AppDatabase,
  engineeringId: string,
): boolean {
  return Boolean(
    database.get(
      `SELECT 1 present
         FROM cooking_submission_item item
         JOIN cooking_test_submission submission
           ON submission.id = item.submission_id
          AND submission.status = 'ACTIVE'
         WHERE item.engineering_id = ?
         LIMIT 1`,
      engineeringId,
    ),
  );
}

export function submissionReferencesEnvironment(
  database: AppDatabase,
  environmentId: string,
): boolean {
  return Boolean(
    database.get(
      `SELECT 1 present
         FROM cooking_submission_item item
         JOIN cooking_test_submission submission ON submission.id = item.submission_id
         WHERE item.environment_id = ? AND submission.status = 'ACTIVE'
         LIMIT 1`,
      environmentId,
    ),
  );
}

export function engineeringMemberHasSubmissionResponsibilities(
  database: AppDatabase,
  engineeringId: string,
  userId: string,
): boolean {
  return Boolean(
    database.get(
      `SELECT 1 present
         FROM cooking_submission_item item
         JOIN cooking_test_submission submission
           ON submission.id = item.submission_id
          AND submission.status = 'ACTIVE'
         WHERE item.engineering_id = ?
           AND item.responsible_user_id = ?
         LIMIT 1`,
      engineeringId,
      userId,
    ),
  );
}
