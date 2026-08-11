import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '@/server/database';
import type { CookingWriteInput } from '@/features/cooking/shared/write-store';
import { CookingWriteStore } from '@/features/cooking/shared/write-store';

type WorkspaceInvalidation = {
  submissionId: string;
  revision: number;
};

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

  run<T>(
    input: CookingWriteInput<T> & {
      invalidation: (result: T) => WorkspaceInvalidation;
    },
  ): T {
    const { invalidation, ...write } = input;
    const tracked = this.writes.runTracked(write);
    if (!tracked.replayed) {
      const event = invalidation(tracked.result);
      this.onInvalidated(event.submissionId, event.revision);
    }
    return tracked.result;
  }

  bumpRevision(submissionId: string, updatedAt: string): number {
    return (
      this.db
        .prepare(
          `UPDATE cooking_test_submission
           SET workspace_revision = workspace_revision + 1, updated_at = ?
           WHERE id = ? RETURNING workspace_revision revision`,
        )
        .get(updatedAt, submissionId) as { revision: number }
    ).revision;
  }

  bumpRevisionForBug(bugId: string, updatedAt: string): number {
    return (
      this.db
        .prepare(
          `UPDATE cooking_test_submission
           SET workspace_revision = workspace_revision + 1, updated_at = ?
           WHERE id = (SELECT submission_id FROM cooking_bug WHERE id = ?)
           RETURNING workspace_revision revision`,
        )
        .get(updatedAt, bugId) as { revision: number }
    ).revision;
  }

  bumpActiveRevision(submissionId: string, updatedAt: string): number | null {
    const row = this.db
      .prepare(
        `UPDATE cooking_test_submission
         SET workspace_revision = workspace_revision + 1, updated_at = ?
         WHERE id = ? AND status = 'ACTIVE'
         RETURNING workspace_revision revision`,
      )
      .get(updatedAt, submissionId) as { revision: number } | undefined;
    return row?.revision ?? null;
  }

  publishInvalidation(submissionId: string, revision: number): void {
    this.onInvalidated(submissionId, revision);
  }
}
