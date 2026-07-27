import { database } from '@/server/database';
import { ExecutionService } from '@/server/execution/service';
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
