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
  type BugProgressTimelineNode,
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
      progressByBug: deriveBugProgress(bugs, repairs, updates, lifecycle),
    });
  }

  canAccessSubmission(userId: string, submissionId: string): boolean {
    return this.submissions.canAccessSubmission(userId, submissionId);
  }
}

function deriveBugProgress(
  bugs: BugWorkspaceProjection,
  repairs: RepairWorkspaceProjection,
  updates: UpdateWorkspaceProjection,
  lifecycle: LifecycleWorkspaceProjection,
): Record<string, BugProgressTimelineNode[]> {
  return Object.fromEntries(
    bugs.bugs.map((bug) => {
      const repairTimeline = repairs.repairByBug[bug.id]?.timeline ?? [
        {
          id: `registered:${bug.id}`,
          kind: 'BUG_REGISTERED' as const,
          occurredAt: bug.createdAt,
        },
      ];
      const updateNodes = updates.updateBatches
        .filter((batch) =>
          batch.entries.some((entry) => entry.bugId === bug.id),
        )
        .map((batch) => ({
          id: `update-batch:${batch.id}:${bug.id}`,
          kind: 'UPDATE_BATCH' as const,
          batchId: batch.id,
          batchState: batch.state,
          bugCount: batch.entries.length,
          statusLabel: batch.presentation.statusLabel,
          visual: batch.presentation.visual,
          occurredAt: batch.frozenAt,
        }));
      const verificationNodes = (
        lifecycle.verificationsByBug[bug.id] ?? []
      ).map((verification) => ({
        ...verification,
        kind: 'VERIFICATION' as const,
      }));
      const reopenNodes = (lifecycle.reopensByBug[bug.id] ?? []).map(
        (reopen) => ({ ...reopen, kind: 'REOPEN' as const }),
      );
      const transitionNodes = lifecycle.transitionsByBug[bug.id] ?? [];
      const timeline: BugProgressTimelineNode[] = [
        ...repairTimeline,
        ...updateNodes,
        ...verificationNodes,
        ...reopenNodes,
        ...transitionNodes,
      ];
      return [bug.id, [...timeline].sort(compareBugProgressNodes)];
    }),
  );
}

function compareBugProgressNodes(
  left: BugProgressTimelineNode,
  right: BugProgressTimelineNode,
): number {
  return (
    progressOccurredAt(left).localeCompare(progressOccurredAt(right)) ||
    progressOrder(left) - progressOrder(right) ||
    left.id.localeCompare(right.id)
  );
}

function progressOccurredAt(node: BugProgressTimelineNode): string {
  if (node.kind === 'REPAIR_ATTEMPT') return node.queuedAt;
  if ('createdAt' in node) return node.createdAt;
  return node.occurredAt;
}

function progressOrder(node: BugProgressTimelineNode): number {
  return {
    BUG_REGISTERED: 0,
    UPDATE_BATCH: 10,
    VERIFICATION: 20,
    REOPEN: 20,
    CANCELLED: 20,
    RESTORED: 20,
    REPAIR_ATTEMPT: 30,
  }[node.kind];
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
    reopensByBug: {},
    transitionsByBug: {},
    cleanups: [],
    cleanupInteractions: [],
    timeline: [],
  };
}
