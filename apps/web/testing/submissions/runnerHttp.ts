import { applicationRunnerFetch } from '@/server/runtime/runnerHttp';
import type { AppDatabase } from '@/server/database/index';
import type { ExecutionService } from '@/server/platform/execution/service';
import { LocalFileStore } from '@/server/platform/files/localFileStore';
import type { RunnerService } from '@/server/platform/runner/service';
import { join } from 'node:path';

export function testRunnerFetch(fixture: {
  database: AppDatabase;
  directory: string;
  runners: RunnerService;
  executions: ExecutionService;
}): ReturnType<typeof applicationRunnerFetch> {
  return applicationRunnerFetch(fixture.database, {
    runners: fixture.runners,
    executions: fixture.executions,
    files: new LocalFileStore(fixture.database, join(fixture.directory, 'files')),
    prepare: () => {},
  });
}
