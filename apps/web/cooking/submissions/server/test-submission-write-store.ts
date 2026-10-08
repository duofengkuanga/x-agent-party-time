import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '@/platform/database';
import type { CookingWriteInput } from '@/cooking/shared/server/write-store';
import { CookingWriteStore } from '@/cooking/shared/server/write-store';

type RevisionedWorkspace =
  | { revision: number; workspaceRevision?: never }
  | { workspaceRevision: number; revision?: never };

export class TestSubmissionWriteStore {
  private readonly writes: CookingWriteStore;

  constructor(
    private readonly db: AppDatabase,
    now: () => Date = () => new Date(),
    createId: () => string = randomUUID,
    private readonly onInvalidated: (
      submissionId: string,
      revision: number,
    ) => void = () => {},
  ) {
    this.writes = new CookingWriteStore(db, now, createId);
  }

  run<T extends RevisionedWorkspace>(
    input: CookingWriteInput<T> & {
      submissionId: (result: T) => string;
    },
  ): T {
    const tracked = this.writes.runTracked(input);
    if (!tracked.replayed)
      this.onInvalidated(
        input.submissionId(tracked.result),
        tracked.result.revision ?? tracked.result.workspaceRevision,
      );
    return tracked.result;
  }

  bumpRevision(submissionId: string, updatedAt: string): number {
    return (
      this.db.get(
        `UPDATE cooking_test_submission
           SET workspace_revision = workspace_revision + 1, updated_at = ?
           WHERE id = ? RETURNING workspace_revision revision`,
        updatedAt,
        submissionId,
      ) as { revision: number }
    ).revision;
  }

  bumpRevisionForBug(bugId: string, updatedAt: string): number {
    return (
      this.db.get(
        `UPDATE cooking_test_submission
           SET workspace_revision = workspace_revision + 1, updated_at = ?
           WHERE id = (SELECT submission_id FROM cooking_bug WHERE id = ?)
           RETURNING workspace_revision revision`,
        updatedAt,
        bugId,
      ) as { revision: number }
    ).revision;
  }

  bumpActiveRevision(submissionId: string, updatedAt: string): number | null {
    const row = this.db.get(
      `UPDATE cooking_test_submission
         SET workspace_revision = workspace_revision + 1, updated_at = ?
         WHERE id = ? AND status = 'ACTIVE'
         RETURNING workspace_revision revision`,
      updatedAt,
      submissionId,
    ) as { revision: number } | undefined;
    return row?.revision ?? null;
  }

  publishInvalidation(submissionId: string, revision: number): void {
    this.onInvalidated(submissionId, revision);
  }
}
