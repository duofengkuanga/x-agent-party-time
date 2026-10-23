import { database } from '@/server/database/index';
import { ExecutionService } from '@/server/platform/execution/service';
import { RunnerService } from '../platform/runner/service';

export function runnerService(): RunnerService {
  const appDatabase = database();
  const executions = new ExecutionService(appDatabase);
  return new RunnerService(
    appDatabase,
    undefined,
    undefined,
    undefined,
    undefined,
    executions.hasActiveExecutions,
  );
}
