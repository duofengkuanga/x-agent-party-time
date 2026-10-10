import type { AppDatabase } from '@/platform/database';
import type { Bug } from '../contract';

export function bugRoutingPolicy(db: AppDatabase, bug: Bug, actorUserId: string) {
  const source = db.get(
    `SELECT item.engineering_type, item.responsible_user_id, submission.tester_user_id, submission.status
     FROM cooking_test_submission submission
     LEFT JOIN cooking_submission_item item ON item.id = ? WHERE submission.id = ?`,
    bug.submissionItemId,
    bug.submissionId,
  ) as {
    engineering_type: string | null;
    responsible_user_id: string | null;
    tester_user_id: string;
    status: string;
  };
  const authorized =
    actorUserId === source.tester_user_id || actorUserId === source.responsible_user_id;
  const targets =
    authorized && source.engineering_type
      ? db.all<{ id: string; name: string; type: 'FRONTEND' | 'BACKEND' }>(
          `SELECT id, engineering_name name, engineering_type type FROM cooking_submission_item
     WHERE submission_id = ? AND engineering_type != ? ORDER BY position`,
          bug.submissionId,
          source.engineering_type,
        )
      : [];
  const latest = db.get(
    'SELECT finished_at FROM cooking_repair_attempt WHERE bug_id = ? ORDER BY attempt DESC LIMIT 1',
    bug.id,
  ) as { finished_at: string | null } | undefined;
  const active = db.get(
    `SELECT 1 FROM platform_execution WHERE state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND id IN (
       SELECT execution_id FROM cooking_repair_attempt WHERE bug_id = ?
       UNION SELECT execution_id FROM cooking_repair_session_sync WHERE bug_id = ?
       UNION SELECT attempt.execution_id FROM cooking_update_attempt attempt JOIN cooking_update_batch_entry entry ON entry.batch_id = attempt.batch_id WHERE entry.bug_id = ?
       UNION SELECT sync.execution_id FROM cooking_update_session_sync sync JOIN cooking_update_batch_entry entry ON entry.batch_id = sync.batch_id WHERE entry.bug_id = ?
     ) LIMIT 1`,
    bug.id,
    bug.id,
    bug.id,
    bug.id,
  );
  const reason = !authorized
    ? '只有测试负责人或原工程负责人可以操作'
    : source.status !== 'ACTIVE'
      ? '已关闭提测单不能操作'
      : bug.collaborationLocked
        ? '前后端关联单不能转交或增加协作'
        : bug.transferredAt || ['DONE', 'CANCELLED'].includes(bug.stage)
          ? '已结束的缺陷不能操作'
          : !targets.length
            ? '当前提测单没有可用的另一端工程'
            : active || bug.stage === 'UPDATING'
              ? '请等待当前修复、更新或同步任务结束'
              : !latest?.finished_at
                ? '请先完成一次自动修复，再判断工程归属'
                : null;
  const pending = db.get(
    'SELECT pending_commits_json, pending_manual_operations_json FROM cooking_bug_repair_context WHERE bug_id = ?',
    bug.id,
  ) as
    { pending_commits_json: string; pending_manual_operations_json: string } | undefined;
  const hasPending =
    pending &&
    (JSON.parse(pending.pending_commits_json).length > 0 ||
      JSON.parse(pending.pending_manual_operations_json).length > 0);
  return {
    targets,
    transferReason: reason ?? (hasPending ? '请先处理待交付改动，不能转交' : null),
    collaborationReason: reason,
  };
}
