import type { AppDatabase } from '@/server/database/index';
import { PlatformError } from '@/server/platform/errors/index';
import { requireSubmissionAccess } from '@/server/submissions/shared/access';
import type { ObservationAccess } from '@/server/platform/execution/observations';

/** Submissions own business access; the generic observation store does not. */
export function submissionObservationAccess(db: AppDatabase): ObservationAccess {
  return (userId, executionId, mode) => {
    const source = db.get<{ submission_id: string; responsible_user_id: string }>(
      `
      SELECT bug.submission_id,item.responsible_user_id
      FROM submission_repair_attempt attempt JOIN submission_bug bug ON bug.id=attempt.bug_id
      JOIN submission_item item ON item.id=bug.submission_item_id WHERE attempt.execution_id=?
      UNION ALL
      SELECT batch.submission_id,item.responsible_user_id
      FROM submission_update_attempt attempt JOIN submission_update_batch batch ON batch.id=attempt.batch_id
      JOIN submission_item item ON item.id=batch.submission_item_id WHERE attempt.execution_id=?
      UNION ALL
      SELECT bug.submission_id,item.responsible_user_id
      FROM submission_repair_session_sync sync JOIN submission_bug bug ON bug.id=sync.bug_id
      JOIN submission_item item ON item.id=bug.submission_item_id WHERE sync.execution_id=?
      UNION ALL
      SELECT batch.submission_id,item.responsible_user_id
      FROM submission_update_session_sync sync JOIN submission_update_batch batch ON batch.id=sync.batch_id
      JOIN submission_item item ON item.id=batch.submission_item_id WHERE sync.execution_id=?
    `,
      executionId,
      executionId,
      executionId,
      executionId,
    );
    if (!source) throw new PlatformError('NOT_FOUND', '执行不存在或无权访问');
    requireSubmissionAccess(db, userId, source.submission_id);
    if (mode === 'read' && source.responsible_user_id !== userId)
      throw new PlatformError('NOT_FOUND', '执行不存在或无权访问');
  };
}
