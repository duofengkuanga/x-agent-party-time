import type { RepairService } from '@/cooking/repair/server/repair-service';
import { TestSubmissionWriteStore } from '@/cooking/submissions/server/test-submission-write-store';
import type { AppDatabase } from '@/platform/database';
import { ExecutionService } from '@/platform/execution/service';
import { randomUUID } from 'node:crypto';
import { BugLifecycleCommands } from './bug-lifecycle-commands';
import { CleanupService } from './cleanup-service';
import { LifecycleQueries } from './lifecycle-queries';
import { SubmissionClosure } from './submission-closure';

export class LifecycleService {
  private readonly writes: TestSubmissionWriteStore;
  private readonly queries: LifecycleQueries;
  private readonly cleanup: CleanupService;
  private readonly closure: SubmissionClosure;
  private readonly bugCommands: BugLifecycleCommands;
  readonly retryCleanup: CleanupService['retryCleanup'] = (...args) =>
    this.cleanup.retryCleanup(...args);
  readonly resolveCleanupInteraction: CleanupService['resolveCleanupInteraction'] = (
    ...args
  ) => this.cleanup.resolveCleanupInteraction(...args);
  readonly projectExecution: CleanupService['projectExecution'] = (...args) =>
    this.cleanup.projectExecution(...args);
  readonly workspace: LifecycleQueries['workspace'] = (...args) =>
    this.queries.workspace(...args);
  readonly cleanupInteractions: LifecycleQueries['cleanupInteractions'] = (...args) =>
    this.queries.cleanupInteractions(...args);
  readonly closeSubmission: SubmissionClosure['closeSubmission'] = (...args) =>
    this.closure.closeSubmission(...args);

  constructor(
    db: AppDatabase,
    repairs: RepairService,
    executions: ExecutionService = new ExecutionService(db),
    now: () => Date = () => new Date(),
    createId: () => string = randomUUID,
    onInvalidated: (submissionId: string, revision: number) => void = () => {},
  ) {
    this.queries = new LifecycleQueries(db);
    this.writes = new TestSubmissionWriteStore(db, now, createId, onInvalidated);
    this.bugCommands = new BugLifecycleCommands(
      db,
      repairs,
      this.queries,
      this.writes,
      now,
      createId,
    );
    this.cleanup = new CleanupService(db, executions, this.writes, now, createId);
    this.closure = new SubmissionClosure(
      db,
      this.queries,
      this.cleanup,
      this.writes,
      now,
    );
  }

  readonly verifyBug: BugLifecycleCommands['verifyBug'] = (...args) =>
    this.bugCommands.verifyBug(...args);
  readonly reopenBug: BugLifecycleCommands['reopenBug'] = (...args) =>
    this.bugCommands.reopenBug(...args);
  readonly cancelBug: BugLifecycleCommands['cancelBug'] = (...args) =>
    this.bugCommands.cancelBug(...args);
  readonly restoreBug: BugLifecycleCommands['restoreBug'] = (...args) =>
    this.bugCommands.restoreBug(...args);
  readonly archiveBug: BugLifecycleCommands['archiveBug'] = (...args) =>
    this.bugCommands.archiveBug(...args);
  readonly unarchiveBug: BugLifecycleCommands['unarchiveBug'] = (...args) =>
    this.bugCommands.unarchiveBug(...args);
}
