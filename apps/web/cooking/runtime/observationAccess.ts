import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import { requireSubmissionAccess } from '@/cooking/shared/server/access';
import type { ObservationAccess } from '@/platform/execution/observations';

/** Cooking owns business access; the generic observation store does not. */
export function cookingObservationAccess(db: AppDatabase): ObservationAccess {
  return (userId, executionId, mode) => {
    const source = db.get<{ submission_id: string; responsible_user_id: string }>(
      `
      SELECT bug.submission_id,item.responsible_user_id
      FROM cooking_repair_attempt attempt JOIN cooking_bug bug ON bug.id=attempt.bug_id
      JOIN cooking_submission_item item ON item.id=bug.submission_item_id WHERE attempt.execution_id=?
      UNION ALL
      SELECT batch.submission_id,item.responsible_user_id
      FROM cooking_update_attempt attempt JOIN cooking_update_batch batch ON batch.id=attempt.batch_id
      JOIN cooking_submission_item item ON item.id=batch.submission_item_id WHERE attempt.execution_id=?
      UNION ALL
      SELECT bug.submission_id,item.responsible_user_id
      FROM cooking_repair_session_sync sync JOIN cooking_bug bug ON bug.id=sync.bug_id
      JOIN cooking_submission_item item ON item.id=bug.submission_item_id WHERE sync.execution_id=?
      UNION ALL
      SELECT batch.submission_id,item.responsible_user_id
      FROM cooking_update_session_sync sync JOIN cooking_update_batch batch ON batch.id=sync.batch_id
      JOIN cooking_submission_item item ON item.id=batch.submission_item_id WHERE sync.execution_id=?
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
