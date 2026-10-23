import type { AppDatabase } from '@/server/database/index';

export function projectMemberHasSubmissionResponsibilities(
  database: AppDatabase,
  projectId: string,
  userId: string,
): boolean {
  return Boolean(
    database.get(
      `SELECT 1 present
         FROM test_submission submission
         LEFT JOIN submission_item item
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
         FROM submission_item item
         JOIN test_submission submission
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
         FROM submission_item item
         JOIN test_submission submission ON submission.id = item.submission_id
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
         FROM submission_item item
         JOIN test_submission submission
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

export function submissionReferencesBinding(
  database: AppDatabase,
  bindingId: string,
): boolean {
  return Boolean(
    database.get('SELECT 1 FROM submission_item WHERE binding_id = ? LIMIT 1', bindingId),
  );
}
