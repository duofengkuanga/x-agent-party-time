import { BindingService } from '@/cooking/engineering/server/bindingService';
import { BindingRequestService } from '@/cooking/engineering/server/bindingRequestService';
import { database, type AppDatabase } from '@/platform/database';
import { runnerFetch, type RunnerHttpServices } from '@/platform/runner/router';
import { runnerService } from '@/platform/runner/server';
import {
  cookingExecutionService,
  cookingFileStore,
  prepareDueUpdateExecutions,
} from './services';
import { ExecutionObservations } from '@/platform/execution/observations';
import { handleObservationUpload } from '@/platform/execution/observationHttp';
import { startObservationMaintenance } from '@/platform/execution/observationMaintenance';
import { cookingObservationAccess } from './observationAccess';

export function cookingRunnerFetch(
  db: AppDatabase,
  services: Omit<RunnerHttpServices, 'bindings'>,
): ReturnType<typeof runnerFetch> {
  const bindings = new BindingService(db);
  const requests = new BindingRequestService(db, bindings);
  const base = runnerFetch({
    ...services,
    bindings: {
      list: (runnerId) =>
        bindings.listBindingsForRunner(runnerId).map(({ id }) => ({ bindingId: id })),
      confirm: bindings.confirmRepository.bind(bindings),
      claim: requests.claimNext.bind(requests),
      complete: requests.complete.bind(requests),
    },
  });
  const observations = new ExecutionObservations(db, cookingObservationAccess(db));
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const match = /^\/api\/runner\/executions\/([^/]+)\/observations$/u.exec(
      new URL(request.url).pathname,
    );
    if (match) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      let executionId: string;
      try {
        executionId = decodeURIComponent(match[1]!);
      } catch {
        return new Response(null, { status: 400 });
      }
      return handleObservationUpload(
        request,
        executionId,
        services.runners,
        observations,
      );
    }
    return base(request);
  };
}

export async function handleRunnerRequest(request: Request): Promise<Response> {
  const db = database();
  startObservationMaintenance(db);
  return cookingRunnerFetch(db, {
    runners: runnerService(),
    executions: cookingExecutionService(),
    files: cookingFileStore(),
    prepare: prepareDueUpdateExecutions,
  })(request);
}
