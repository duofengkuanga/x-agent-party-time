import { database } from '@/platform/database';
import { ExecutionService } from '@/platform/execution/service';
import { RunnerService } from './service';

export function runnerService(): RunnerService {
  const appDatabase = database();
  const executions = new ExecutionService(appDatabase);
  return new RunnerService(
    appDatabase,
    undefined,
    undefined,
    undefined,
    undefined,
    (runnerId) => executions.hasActiveExecutions(runnerId),
  );
}
