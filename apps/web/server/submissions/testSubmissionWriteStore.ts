import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '@/server/database/index';
import type {
  MutationWriteInput,
  MutationWriteOutcome,
} from '@/server/platform/mutations/store';
import { MutationStore } from '@/server/platform/mutations/store';

type RevisionedWorkspace =
  | { revision: number; workspaceRevision?: never }
  | { workspaceRevision: number; revision?: never };

export class TestSubmissionWriteStore {
  private readonly writes: MutationStore;

  constructor(
    private readonly db: AppDatabase,
    now: () => Date = () => new Date(),
    createId: () => string = randomUUID,
    private readonly onInvalidated: (
      submissionId: string,
      revision: number,
    ) => void = () => {},
  ) {
    this.writes = new MutationStore(db, now, createId);
  }

  run<T extends RevisionedWorkspace>(
    input: Omit<MutationWriteInput<T>, 'perform'> & {
      submissionId: (result: T) => string;
      perform: () => MutationWriteOutcome<T> & {
        affectedSubmissions?: { ids: string[]; updatedAt: string };
      };
    },
  ): T {
    const invalidations = new Map<string, number>();
    const tracked = this.writes.runTracked({
      ...input,
      perform: () => {
        const outcome = input.perform();
        const affected = outcome.affectedSubmissions;
        if (affected?.ids.length) {
          const primaryId = input.submissionId(outcome.result);
          for (const id of new Set(affected.ids))
            if (id !== primaryId)
              invalidations.set(id, this.bumpRevision(id, affected.updatedAt));
        }
        return outcome;
      },
    });
    if (!tracked.replayed) {
      this.onInvalidated(
        input.submissionId(tracked.result),
        tracked.result.revision ?? tracked.result.workspaceRevision,
      );
      for (const [id, revision] of invalidations) this.onInvalidated(id, revision);
    }
    return tracked.result;
  }

  bumpRevision(submissionId: string, updatedAt: string): number {
    return (
      this.db.get(
        `UPDATE test_submission
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
        `UPDATE test_submission
           SET workspace_revision = workspace_revision + 1, updated_at = ?
           WHERE id = (SELECT submission_id FROM submission_bug WHERE id = ?)
           RETURNING workspace_revision revision`,
        updatedAt,
        bugId,
      ) as { revision: number }
    ).revision;
  }

  bumpActiveRevision(submissionId: string, updatedAt: string): number | null {
    const row = this.db.get(
      `UPDATE test_submission
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
