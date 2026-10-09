import { cookingRunnerFetch } from '@/cooking/runtime/runner-http';
import type { AppDatabase } from '@/platform/database';
import type { ExecutionService } from '@/platform/execution/service';
import { LocalFileStore } from '@/platform/files/local-file-store';
import type { RunnerService } from '@/platform/runner/service';
import { join } from 'node:path';

export function testRunnerFetch(fixture: {
  database: AppDatabase;
  directory: string;
  runners: RunnerService;
  executions: ExecutionService;
}): ReturnType<typeof cookingRunnerFetch> {
  return cookingRunnerFetch(fixture.database, {
    runners: fixture.runners,
    executions: fixture.executions,
    files: new LocalFileStore(fixture.database, join(fixture.directory, 'files')),
    prepare: () => {},
  });
}
