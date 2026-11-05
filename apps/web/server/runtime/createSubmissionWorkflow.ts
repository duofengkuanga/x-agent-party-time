import { deliveryEnvironmentAvailable } from '@/server/submissions/environmentAccess';
import { randomUUID } from 'node:crypto';
import { BugService } from '@/server/submissions/bugs/bugService';
import { BugLifecycleCommands } from '@/server/submissions/lifecycle/bugLifecycleCommands';
import { CleanupService } from '@/server/submissions/lifecycle/cleanupService';
import { LifecycleQueries } from '@/server/submissions/lifecycle/lifecycleQueries';
import { SubmissionClosure } from '@/server/submissions/lifecycle/submissionClosure';
import { resolvePersonAgentRepair } from '@/server/submissions/repair/personAgentScope';
import { RepairService } from '@/server/submissions/repair/repairService';
import { SubmissionService } from '@/server/submissions/submissionService';
import { TestSubmissionWriteStore } from '@/server/submissions/testSubmissionWriteStore';
import { UpdateService } from '@/server/submissions/update/updateService';
import { SubmissionWorkspaceService } from '@/server/submissions/workspaceService';
import type { AppDatabase } from '@/server/database/index';
import { ExecutionService } from '@/server/platform/execution/service';
import { submissionExecutionProjection } from '../submissions/executionProjection';

/** The single composition root for the delivery workflow, including tests. */
export function createSubmissionWorkflow(
  db: AppDatabase,
  options: {
    now?: () => Date;
    publish?: (submissionId: string, revision: number) => void;
    ids?: { repair?: () => string; update?: () => string };
  } = {},
) {
  const { now = () => new Date(), publish, ids } = options;
  const commands = new ExecutionService(db, now);
  const updates = new UpdateService(db, commands, now, ids?.update, publish);
  const repairs = new RepairService(db, commands, now, ids?.repair, publish, {
    candidateAvailable: updates.recordCandidateAvailable,
    candidateReconsidered: updates.recalculatePendingDeliveryForBug,
  });
  const lifecycleQueries = new LifecycleQueries(db);
  const lifecycleWrites = new TestSubmissionWriteStore(db, now, randomUUID, publish);
  const bugCommands = new BugLifecycleCommands(
    db,
    repairs,
    lifecycleQueries,
    lifecycleWrites,
    now,
    randomUUID,
  );
  const cleanup = new CleanupService(
    db,
    commands,
    lifecycleQueries,
    lifecycleWrites,
    now,
    randomUUID,
  );
  const closure = new SubmissionClosure(db, cleanup, lifecycleWrites, now);
  const lifecycle = {
    verifyBug: bugCommands.verifyBug.bind(bugCommands),
    reopenBug: bugCommands.reopenBug.bind(bugCommands),
    reviewLinkedBugs: bugCommands.reviewLinkedBugs.bind(bugCommands),
    archiveLinkedBugs: bugCommands.archiveLinkedBugs.bind(bugCommands),
    unarchiveLinkedBugs: bugCommands.unarchiveLinkedBugs.bind(bugCommands),
    cancelBug: bugCommands.cancelBug.bind(bugCommands),
    restoreBug: bugCommands.restoreBug.bind(bugCommands),
    archiveBug: bugCommands.archiveBug.bind(bugCommands),
    unarchiveBug: bugCommands.unarchiveBug.bind(bugCommands),
    retryCleanup: cleanup.retryCleanup.bind(cleanup),
    resolveCleanupInteraction: cleanup.resolveCleanupInteraction.bind(cleanup),
    projectExecution: cleanup.projectExecution,
    workspace: lifecycleQueries.workspace.bind(lifecycleQueries),
    cleanupInteractions: lifecycleQueries.cleanupInteractions.bind(lifecycleQueries),
    closeSubmission: closure.closeSubmission.bind(closure),
  } as const;
  const bugs = new BugService(db, now, undefined, publish, {
    requested: repairs.createInitialExecution.bind(repairs),
  });
  const submissions = new SubmissionService(db, now, undefined, publish);
  const executions = new ExecutionService(
    db,
    now,
    undefined,
    undefined,
    undefined,
    submissionExecutionProjection(db, {
      BUG_REPAIR: repairs.projectExecution,
      UPDATE_BATCH: updates.projectExecution,
      CLEANUP: lifecycle.projectExecution,
    }),
    (execution) => {
      if (
        execution.owner.namespace === 'submissions' &&
        execution.owner.kind === 'UPDATE_BATCH'
      ) {
        const batch = db.get<{ submission_item_id: string }>(
          `SELECT batch.submission_item_id FROM submission_update_attempt attempt
            JOIN submission_update_batch batch ON batch.id = attempt.batch_id
            WHERE attempt.id = ? AND batch.delivery_scope_json IS NOT NULL`,
          execution.owner.id,
        );
        if (batch && !deliveryEnvironmentAvailable(db, batch.submission_item_id))
          return false;
      }
      return resolvePersonAgentRepair(db, execution, now);
    },
  );
  const workspace = new SubmissionWorkspaceService(
    submissions,
    bugs,
    repairs,
    updates,
    lifecycle,
  );
  return {
    submissions,
    bugs,
    repairs,
    updates,
    lifecycle,
    executions,
    workspace,
  };
}
