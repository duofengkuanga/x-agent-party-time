import { BugService } from '@/cooking/bugs/server/bug-service';
import { LifecycleService } from '@/cooking/lifecycle/server/lifecycle-service';
import { RepairService } from '@/cooking/repair/server/repair-service';
import { SubmissionService } from '@/cooking/submissions/server/submission-service';
import { UpdateService } from '@/cooking/update/server/update-service';
import { CookingWorkspaceService } from '@/cooking/workspace/server/workspace-service';
import type { AppDatabase } from '@/platform/database';
import { ExecutionService } from '@/platform/execution/service';
import { cookingExecutionProjection } from './execution-projection';

/** The single composition root for the delivery workflow, including tests. */
export function createCooking(
  db: AppDatabase,
  options: {
    now?: () => Date;
    publish?: (submissionId: string, revision: number) => void;
    ids?: { repair?: () => string; update?: () => string };
  } = {},
) {
  const { now, publish, ids } = options;
  const commands = new ExecutionService(db, now);
  const updates = new UpdateService(db, commands, now, ids?.update, publish);
  const repairs = new RepairService(db, commands, now, ids?.repair, publish, {
    candidateAvailable: (bugId, at) =>
      updates.recordCandidateAvailable(bugId, at),
    candidateReconsidered: (bugId) =>
      updates.recalculatePendingDeliveryForBug(bugId),
  });
  const lifecycle = new LifecycleService(
    db,
    repairs,
    commands,
    now,
    undefined,
    publish,
  );
  const bugs = new BugService(db, now, undefined, publish, {
    requested: (bugId) => repairs.createInitialExecution(bugId),
  });
  const submissions = new SubmissionService(db, now, undefined, publish);
  const executions = new ExecutionService(
    db,
    now,
    undefined,
    undefined,
    undefined,
    cookingExecutionProjection(db, {
      BUG_REPAIR: repairs,
      UPDATE_BATCH: updates,
      CLEANUP: lifecycle,
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
