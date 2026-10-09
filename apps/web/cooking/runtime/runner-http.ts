import { BindingService } from '@/cooking/bindings/server/binding-service';
import { BindingRequestService } from '@/cooking/bindings/server/binding-request-service';
import { database, type AppDatabase } from '@/platform/database';
import { executionFileStore } from '@/platform/execution/files';
import { runnerFetch, type RunnerHttpServices } from '@/platform/runner/router';
import { runnerService } from '@/platform/runner/server';
import {
  cookingExecutionService,
  prepareDueUpdateExecutions,
} from './services';

export function cookingRunnerFetch(
  db: AppDatabase,
  services: Omit<RunnerHttpServices, 'bindings'>,
): ReturnType<typeof runnerFetch> {
  const bindings = new BindingService(db);
  const requests = new BindingRequestService(db, bindings);
  return runnerFetch({
    ...services,
    bindings: {
      list: (runnerId) =>
        bindings
          .listBindingsForRunner(runnerId)
          .map(({ id }) => ({ bindingId: id })),
      confirm: bindings.confirmRepository.bind(bindings),
      claim: requests.claimNext.bind(requests),
      complete: requests.complete.bind(requests),
    },
  });
}

export async function handleRunnerRequest(request: Request): Promise<Response> {
  return cookingRunnerFetch(database(), {
    runners: runnerService(),
    executions: cookingExecutionService(),
    files: executionFileStore(),
    prepare: prepareDueUpdateExecutions,
  })(request);
}
