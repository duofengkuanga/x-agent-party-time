import { randomUUID } from 'node:crypto';
import { BugService } from '@/cooking/bugs/server/bugService';
import { BugLifecycleCommands } from '@/cooking/lifecycle/server/bugLifecycleCommands';
import { CleanupService } from '@/cooking/lifecycle/server/cleanupService';
import { LifecycleQueries } from '@/cooking/lifecycle/server/lifecycleQueries';
import { SubmissionClosure } from '@/cooking/lifecycle/server/submissionClosure';
import { RepairService } from '@/cooking/repair/server/repairService';
import { SubmissionService } from '@/cooking/submissions/server/submissionService';
import { TestSubmissionWriteStore } from '@/cooking/submissions/server/testSubmissionWriteStore';
import { UpdateService } from '@/cooking/update/server/updateService';
import { CookingWorkspaceService } from '@/cooking/submissions/server/workspaceService';
import type { AppDatabase } from '@/platform/database';
import { ExecutionService } from '@/platform/execution/service';
import { cookingExecutionProjection } from './executionProjection';

/** The single composition root for the delivery workflow, including tests. */
export function createCooking(
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
    cookingExecutionProjection(db, {
      BUG_REPAIR: repairs.projectExecution,
      UPDATE_BATCH: updates.projectExecution,
      CLEANUP: lifecycle.projectExecution,
    }),
  );
  const workspace = new CookingWorkspaceService(
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
