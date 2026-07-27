import type { SubmissionService } from '@/modules/cooking/submissions/application/submission-service';
import type { BugService } from '@/modules/cooking/bugs/application/bug-service';
import type { RepairService } from '@/modules/cooking/repair/application/repair-service';
import type { UpdateService } from '@/modules/cooking/update/application/update-service';
import type { LifecycleService } from '@/modules/cooking/lifecycle/application/lifecycle-service';
import type { LifecycleWorkspaceProjection } from '@/modules/cooking/lifecycle/contract';
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
    return CookingWorkspaceSnapshotSchema.parse({
      ...this.submissions.getWorkspace(userId, submissionId),
      ...this.bugs.workspace(userId, submissionId),
      ...this.repairs.workspace(userId, submissionId),
      ...this.updates.workspace(userId, submissionId),
      ...this.lifecycle.workspace(userId, submissionId),
    });
  }

  canAccessSubmission(userId: string, submissionId: string): boolean {
    return this.submissions.canAccessSubmission(userId, submissionId);
  }
}

function emptyLifecycleProjection(): LifecycleWorkspaceProjection {
  return {
    verificationsByBug: {},
    cleanups: [],
    cleanupInteractions: [],
    timeline: [],
  };
}
