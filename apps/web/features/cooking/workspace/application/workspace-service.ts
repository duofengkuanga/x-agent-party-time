import type { SubmissionService } from '@/features/cooking/submissions/application/submission-service';
import type { BugService } from '@/features/cooking/bugs/application/bug-service';
import type { RepairService } from '@/features/cooking/repair/application/repair-service';
import type { UpdateService } from '@/features/cooking/update/application/update-service';
import type { LifecycleService } from '@/features/cooking/lifecycle/application/lifecycle-service';
import type { LifecycleWorkspaceProjection } from '@/features/cooking/lifecycle/contract';
import type { BugWorkspaceProjection } from '@/features/cooking/bugs/contract';
import type { RepairWorkspaceProjection } from '@/features/cooking/repair/contract';
import type { UpdateWorkspaceProjection } from '@/features/cooking/update/contract';
import type { CookingVisualPresentation } from '@/features/cooking/shared/contract';
import { PlatformError } from '@/server/errors';
import {
  CookingWorkspaceSnapshotSchema,
  type CookingWorkspaceSnapshot,
} from '../contract';

export class CookingWorkspaceService {
  constructor(
    private readonly submissions: SubmissionService,
    private readonly bugs: BugService,
    private readonly repairs: RepairService,
    private readonly updates: UpdateService,
    private readonly lifecycle: Pick<LifecycleService, 'workspace'> = {
      workspace: () => emptyLifecycleProjection(),
    },
  ) {}

  getWorkspace(userId: string, submissionId: string): CookingWorkspaceSnapshot {
    if (!this.submissions.canAccessSubmission(userId, submissionId))
      this.submissions.getWorkspace(userId, submissionId);
    this.updates.prepareDueExecutions();
    const submission = this.submissions.getWorkspace(userId, submissionId);
    const bugs = this.bugs.workspace(userId, submissionId);
    const repairs = this.repairs.workspace(userId, submissionId);
    const updates = this.updates.workspace(userId, submissionId);
    const lifecycle = this.lifecycle.workspace(userId, submissionId);
    return CookingWorkspaceSnapshotSchema.parse({
      ...submission,
      ...bugs,
      ...repairs,
      ...updates,
      ...lifecycle,
      visualByBug: deriveBugVisuals(bugs, repairs, updates),
    });
  }

  canAccessSubmission(userId: string, submissionId: string): boolean {
    return this.submissions.canAccessSubmission(userId, submissionId);
  }
}

function deriveBugVisuals(
  bugs: BugWorkspaceProjection,
  repairs: RepairWorkspaceProjection,
  updates: UpdateWorkspaceProjection,
): Record<string, CookingVisualPresentation> {
  return Object.fromEntries(
    bugs.bugs.map((bug) => {
      if (bug.stage === 'REPAIRING') {
        const visual = repairs.repairByBug[bug.id]?.presentation.visual;
        if (!visual)
          throw new PlatformError(
            'INTERNAL_ERROR',
            '修复中 Bug 缺少 Repair visual state',
          );
        return [bug.id, visual];
      }
      if (bug.stage === 'WAITING_FOR_UPDATE')
        return [
          bug.id,
          {
            state: 'QUEUED_FOR_ENGINEERING',
            label: '等待统一更新',
            symbol: '…',
            aheadCount: 0,
          },
        ];
      if (bug.stage === 'UPDATING') {
        const batches = updates.updateBatches.filter(
          (batch) =>
            batch.state !== 'COMPLETED' &&
            batch.entries.some((entry) => entry.bugId === bug.id),
        );
        if (batches.length !== 1)
          throw new PlatformError(
            'INTERNAL_ERROR',
            '更新中 Bug 必须且只能属于一个活动 Batch',
          );
        return [bug.id, batches[0]!.presentation.visual];
      }
      return [
        bug.id,
        {
          state: 'IDLE',
          label: bug.presentation.stageLabel,
          symbol: '·',
        },
      ];
    }),
  );
}

function emptyLifecycleProjection(): LifecycleWorkspaceProjection {
  return {
    verificationsByBug: {},
    cleanups: [],
    cleanupInteractions: [],
    timeline: [],
  };
}
