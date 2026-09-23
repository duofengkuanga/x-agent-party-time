import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import {
  EnvironmentConflictSchema,
  type EnvironmentConflict,
  type EnvironmentTakeover,
} from '../contract';

export function environmentOwned(db: AppDatabase, itemId: string): boolean {
  return Boolean(
    db.get(
      'SELECT 1 FROM cooking_submission_environment_lock WHERE submission_item_id = ?',
      itemId,
    ),
  );
}

export function environmentReady(db: AppDatabase, itemId: string): boolean {
  return Boolean(
    db.get(
      'SELECT 1 FROM cooking_submission_environment_lock WHERE submission_item_id = ? AND deployment_confirmed = 1',
      itemId,
    ),
  );
}

export function requireEnvironment(
  db: AppDatabase,
  itemId: string,
  verification = false,
): void {
  if (!environmentOwned(db, itemId))
    throw new PlatformError(
      'RESOURCE_CONFLICT',
      '此提测项已暂停使用环境，请先重新取得环境使用权',
    );
  if (verification && !environmentReady(db, itemId))
    throw new PlatformError(
      'INVALID_TRANSITION',
      '请工程负责人先确认当前提测版本已部署，再进行测试验证',
    );
}

export function environmentBusy(db: AppDatabase, itemId: string): boolean {
  return Boolean(
    db.get(
      `SELECT 1 FROM cooking_update_batch batch
    WHERE batch.submission_item_id = ? AND (
      batch.state IN ('READY', 'RUNNING', 'WAITING_EXTERNAL') OR
      EXISTS (SELECT 1 FROM cooking_update_attempt attempt JOIN platform_execution execution ON execution.id = attempt.execution_id
        WHERE attempt.batch_id = batch.id AND execution.state IN ('QUEUED', 'CLAIMED', 'RUNNING', 'WAITING_FOR_INTERACTION', 'WAITING_TO_RESUME', 'CANCEL_REQUESTED')) OR
      EXISTS (SELECT 1 FROM cooking_update_session_sync sync JOIN platform_execution execution ON execution.id = sync.execution_id
        WHERE sync.batch_id = batch.id AND execution.state IN ('QUEUED', 'CLAIMED', 'RUNNING', 'WAITING_FOR_INTERACTION', 'WAITING_TO_RESUME', 'CANCEL_REQUESTED'))
    ) LIMIT 1`,
      itemId,
    ),
  );
}

export function environmentConflict(
  db: AppDatabase,
  userId: string,
  environmentId: string,
): EnvironmentConflict | null {
  const row = db.get(
    `SELECT lock.submission_id, lock.submission_item_id,
      submission.title, submission.workspace_revision, submission.tester_user_id,
      item.environment_name, item.engineering_name, tester.display_name tester_name, membership.role
    FROM cooking_submission_environment_lock lock
    JOIN cooking_submission_item item ON item.id = lock.submission_item_id
    JOIN cooking_test_submission submission ON submission.id = lock.submission_id
    JOIN cooking_project_membership membership ON membership.project_id = submission.project_id AND membership.user_id = ?
    JOIN platform_user tester ON tester.id = submission.tester_user_id
    WHERE lock.environment_id = ?`,
    userId,
    environmentId,
  ) as
    | {
        submission_id: string;
        submission_item_id: string;
        title: string;
        workspace_revision: number;
        tester_user_id: string;
        environment_name: string;
        engineering_name: string;
        tester_name: string;
        role: string;
      }
    | undefined;
  if (!row) return null;
  const permitted = row.role === 'OWNER' || row.tester_user_id === userId;
  const blockedReason = !permitted
    ? '只有项目所有者或当前占用提测单的测试负责人可以切换环境'
    : environmentBusy(db, row.submission_item_id)
      ? '原提测项正在更新或等待部署结果，结束后才能切换环境'
      : null;
  return EnvironmentConflictSchema.parse({
    environmentId,
    environmentName: row.environment_name,
    engineeringName: row.engineering_name,
    submissionId: row.submission_id,
    submissionItemId: row.submission_item_id,
    submissionTitle: row.title,
    testerName: row.tester_name,
    expectedRevision: row.workspace_revision,
    blockedReason,
  });
}

// Caller owns the write transaction. The observed owner and revision are a compare-and-swap token.
export function releaseEnvironmentForTakeover(
  db: AppDatabase,
  userId: string,
  environmentId: string,
  expected: EnvironmentTakeover | undefined,
): EnvironmentConflict | null {
  const conflict = environmentConflict(db, userId, environmentId);
  if (!conflict) {
    if (expected)
      throw new PlatformError('STALE_STATE', '环境使用情况已变化，请重新确认');
    return null;
  }
  if (!expected)
    throw new PlatformError(
      'RESOURCE_CONFLICT',
      '所选环境已被其他活动提测单占用',
    );
  if (
    expected.submissionItemId !== conflict.submissionItemId ||
    expected.expectedRevision !== conflict.expectedRevision
  )
    throw new PlatformError('STALE_STATE', '环境使用情况已变化，请重新确认');
  if (conflict.blockedReason)
    throw new PlatformError('RESOURCE_CONFLICT', conflict.blockedReason);
  db.prepare(
    'DELETE FROM cooking_submission_environment_lock WHERE environment_id = ? AND submission_item_id = ?',
  ).run(environmentId, conflict.submissionItemId);
  return conflict;
}

export function environmentObservers(
  db: AppDatabase,
  environmentId: string,
  exceptSubmissionId: string,
): string[] {
  return db
    .all<{
      submission_id: string;
    }>(
      `SELECT DISTINCT item.submission_id FROM cooking_submission_item item
    JOIN cooking_test_submission submission ON submission.id = item.submission_id
    WHERE item.environment_id = ? AND item.submission_id != ? AND submission.status = 'ACTIVE'`,
      environmentId,
      exceptSubmissionId,
    )
    .map((row) => row.submission_id);
}
