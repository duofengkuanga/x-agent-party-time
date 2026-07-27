import type { SubmissionService } from '@/modules/cooking/submissions/application/submission-service';
import type { BugService } from '@/modules/cooking/bugs/application/bug-service';
import {
  CookingWorkspaceSnapshotSchema,
  type CookingWorkspaceSnapshot,
} from '../contract';

export class CookingWorkspaceService {
  constructor(
    private readonly submissions: SubmissionService,
    private readonly bugs: BugService,
  ) {}

  getWorkspace(userId: string, submissionId: string): CookingWorkspaceSnapshot {
    return CookingWorkspaceSnapshotSchema.parse({
      ...this.submissions.getWorkspace(userId, submissionId),
      ...this.bugs.workspace(userId, submissionId),
    });
  }

  canAccessSubmission(userId: string, submissionId: string): boolean {
    return this.submissions.canAccessSubmission(userId, submissionId);
  }
}
