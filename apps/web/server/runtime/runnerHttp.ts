import { createBindingService } from './projects';
import { BindingRequestService } from '@/server/platform/projects/engineering/bindingRequestService';
import { database, type AppDatabase } from '@/server/database/index';
import { runnerFetch, type RunnerHttpServices } from '@/server/platform/runner/router';
import { runnerService } from '@/server/runtime/runner';
import {
  submissionExecutionService,
  applicationFileStore,
  prepareDueUpdateExecutions,
} from './services';
import { ExecutionObservations } from '@/server/platform/execution/observations';
import { handleObservationUpload } from '@/server/platform/execution/observationHttp';
import { startObservationMaintenance } from '@/server/platform/execution/observationMaintenance';
import { submissionObservationAccess } from '../submissions/observationAccess';

export function applicationRunnerFetch(
  db: AppDatabase,
  services: Omit<RunnerHttpServices, 'bindings'>,
): ReturnType<typeof runnerFetch> {
  const bindings = createBindingService(db);
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
  const observations = new ExecutionObservations(db, submissionObservationAccess(db));
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
  return applicationRunnerFetch(db, {
    runners: runnerService(),
    executions: submissionExecutionService(),
    files: applicationFileStore(),
    prepare: prepareDueUpdateExecutions,
  })(request);
}
