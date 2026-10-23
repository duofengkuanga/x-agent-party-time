import type { SubmissionAccessRow, SubmissionItemRow } from './submissionQueries';
import type { AppDatabase } from '@/server/database/index';
import { PlatformError } from '@/server/platform/errors/index';
import {
  EnvironmentConflictSchema,
  type EnvironmentConflict,
  type EnvironmentTakeover,
} from '../../contracts/submissions/submission';

export function environmentOwned(db: AppDatabase, itemId: string): boolean {
  return Boolean(
    db.get(
      'SELECT 1 FROM submission_environment_lock WHERE submission_item_id = ?',
      itemId,
    ),
  );
}

export function environmentReady(db: AppDatabase, itemId: string): boolean {
  return Boolean(
    db.get(
      'SELECT 1 FROM submission_environment_lock WHERE submission_item_id = ? AND deployment_confirmed = 1',
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
      `SELECT 1 FROM submission_update_batch batch
    WHERE batch.submission_item_id = ? AND (
      batch.state IN ('READY', 'RUNNING', 'WAITING_EXTERNAL') OR
      EXISTS (SELECT 1 FROM submission_update_attempt attempt JOIN platform_execution execution ON execution.id = attempt.execution_id
        WHERE attempt.batch_id = batch.id AND execution.state IN ('QUEUED', 'CLAIMED', 'RUNNING', 'WAITING_FOR_INTERACTION', 'WAITING_TO_RESUME', 'CANCEL_REQUESTED')) OR
      EXISTS (SELECT 1 FROM submission_update_session_sync sync JOIN platform_execution execution ON execution.id = sync.execution_id
        WHERE sync.batch_id = batch.id AND execution.state IN ('QUEUED', 'CLAIMED', 'RUNNING', 'WAITING_FOR_INTERACTION', 'WAITING_TO_RESUME', 'CANCEL_REQUESTED'))
    ) LIMIT 1`,
      itemId,
    ),
  );
}

export function environmentAccessForItem(
  db: AppDatabase,
  userId: string,
  submission: SubmissionAccessRow,
  item: Pick<SubmissionItemRow, 'id' | 'environment_id' | 'responsible_user_id'>,
) {
  const lock = db.get<{ deployment_confirmed: number }>(
    'SELECT deployment_confirmed FROM submission_environment_lock WHERE submission_item_id = ?',
    item.id,
  );
  const owned = Boolean(lock);
  const deploymentConfirmed = lock?.deployment_confirmed === 1;
  const inactive =
    submission.status !== 'ACTIVE'
      ? new PlatformError('INVALID_TRANSITION', '已关闭提测单不能切换环境')
      : null;
  const acquireBlocker =
    inactive ??
    (submission.membership_role !== 'OWNER' &&
    ![
      submission.tester_user_id,
      submission.created_by_user_id,
      item.responsible_user_id,
    ].includes(userId)
      ? new PlatformError(
          'PERMISSION_DENIED',
          '只有提测参与者或项目所有者可以取得环境使用权',
        )
      : owned
        ? new PlatformError('STALE_STATE', '当前提测项已取得环境，请刷新后重试')
        : null);
  const confirmBlocker =
    inactive ??
    (userId !== item.responsible_user_id
      ? new PlatformError('PERMISSION_DENIED', '只有对应工程负责人可以确认部署')
      : !owned
        ? new PlatformError(
            'RESOURCE_CONFLICT',
            '此提测项已暂停使用环境，请先重新取得环境使用权',
          )
        : deploymentConfirmed
          ? new PlatformError(
              'INVALID_TRANSITION',
              '当前提测版本已确认部署，无需重复确认',
            )
          : environmentBusy(db, item.id)
            ? new PlatformError('RESOURCE_CONFLICT', '更新或部署尚未结束，暂时不能确认')
            : null);
  return {
    view: {
      owned,
      deploymentConfirmed,
      conflict: owned ? null : environmentConflict(db, userId, item.environment_id),
      canAcquire: !acquireBlocker,
      canConfirmDeployment: !confirmBlocker,
    },
    blockers: { ACQUIRE: acquireBlocker, CONFIRM_DEPLOYMENT: confirmBlocker },
  };
}

export function environmentConflict(
  db: AppDatabase,
  userId: string,
  environmentId: string,
): EnvironmentConflict | null {
  const row = db.get(
    `SELECT lock.submission_id, lock.submission_item_id,
      submission.title, submission.workspace_revision, submission.tester_user_id,
      item.environment_name, engineering.name engineering_name, tester.display_name tester_name, membership.role
    FROM submission_environment_lock lock
    JOIN submission_item item ON item.id = lock.submission_item_id
    JOIN platform_engineering engineering ON engineering.id = item.engineering_id
    JOIN test_submission submission ON submission.id = lock.submission_id
    JOIN platform_project_membership membership ON membership.project_id = submission.project_id AND membership.user_id = ?
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

// The caller's transaction includes the new item (if any), takeover and new ownership.
export function acquireEnvironment(
  db: AppDatabase,
  userId: string,
  item: Pick<
    SubmissionItemRow,
    'id' | 'submission_id' | 'environment_id' | 'engineering_id'
  >,
  now: string,
  mode: 'INITIAL' | 'REACQUIRE',
  expected: EnvironmentTakeover | undefined,
): string[] {
  if (expected && expected.environmentId !== item.environment_id)
    throw new PlatformError('VALIDATION_FAILED', '环境切换确认与当前提测项不匹配');
  const previous = environmentConflict(db, userId, item.environment_id);
  if (previous) {
    if (!expected)
      throw new PlatformError('RESOURCE_CONFLICT', '所选环境已被其他活动提测单占用');
    if (
      expected.submissionItemId !== previous.submissionItemId ||
      expected.expectedRevision !== previous.expectedRevision
    )
      throw new PlatformError('STALE_STATE', '环境使用情况已变化，请重新确认');
    if (previous.blockedReason)
      throw new PlatformError('RESOURCE_CONFLICT', previous.blockedReason);
    db.run(
      'DELETE FROM submission_environment_lock WHERE environment_id = ? AND submission_item_id = ?',
      [item.environment_id, previous.submissionItemId],
    );
  } else if (expected) {
    throw new PlatformError('STALE_STATE', '环境使用情况已变化，请重新确认');
  }
  db.run(
    `INSERT INTO submission_environment_lock(
       environment_id, engineering_id, submission_id, submission_item_id, created_at, deployment_confirmed
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      item.environment_id,
      item.engineering_id,
      item.submission_id,
      item.id,
      now,
      mode === 'INITIAL' && !previous ? 1 : 0,
    ],
  );
  return environmentObservers(db, item.environment_id, item.submission_id);
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
      `SELECT DISTINCT item.submission_id FROM submission_item item
    JOIN test_submission submission ON submission.id = item.submission_id
    WHERE item.environment_id = ? AND item.submission_id != ? AND submission.status = 'ACTIVE'`,
      environmentId,
      exceptSubmissionId,
    )
    .map((row) => row.submission_id);
}
