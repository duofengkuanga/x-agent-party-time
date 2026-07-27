import type { AppDatabase } from '@/server/database';

export function projectMemberHasSubmissionResponsibilities(
  database: AppDatabase,
  projectId: string,
  userId: string,
): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 present
         FROM cooking_test_submission submission
         LEFT JOIN cooking_submission_item item
           ON item.submission_id = submission.id
          AND item.responsible_user_id = ?
         WHERE submission.project_id = ?
           AND submission.status = 'ACTIVE'
           AND (submission.tester_user_id = ? OR item.id IS NOT NULL)
         LIMIT 1`,
      )
      .get(userId, projectId, userId),
  );
}

export function submissionReferencesEngineering(
  database: AppDatabase,
  engineeringId: string,
): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 present
         FROM cooking_submission_item item
         JOIN cooking_test_submission submission
           ON submission.id = item.submission_id
          AND submission.status = 'ACTIVE'
         WHERE item.engineering_id = ?
         LIMIT 1`,
      )
      .get(engineeringId),
  );
}

export function submissionReferencesEnvironment(
  database: AppDatabase,
  environmentId: string,
): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 present
         FROM cooking_submission_environment_lock
         WHERE environment_id = ?
         LIMIT 1`,
      )
      .get(environmentId),
  );
}

export function engineeringMemberHasSubmissionResponsibilities(
  database: AppDatabase,
  engineeringId: string,
  userId: string,
): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 present
         FROM cooking_submission_item item
         JOIN cooking_test_submission submission
           ON submission.id = item.submission_id
          AND submission.status = 'ACTIVE'
         WHERE item.engineering_id = ?
           AND item.responsible_user_id = ?
         LIMIT 1`,
      )
      .get(engineeringId, userId),
  );
}
