import { bindingService } from '@/features/cooking/application/server';
import {
  handleRunnerBindingConfirmation,
  handleRunnerBindings,
} from '@/server/runner/http';
import { runnerService } from '@/server/runner/server';

export async function GET(request: Request): Promise<Response> {
  return handleRunnerBindings(request, runnerService(), (runnerId) =>
    bindingService()
      .listBindingsForRunner(runnerId)
      .map(({ id }) => ({ bindingId: id })),
  );
}

export async function POST(request: Request): Promise<Response> {
  return handleRunnerBindingConfirmation(
    request,
    runnerService(),
    (runnerId, bindingId, repositoryUrl) =>
      bindingService().confirmRepository(runnerId, bindingId, repositoryUrl),
  );
}
