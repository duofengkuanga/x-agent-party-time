import { bindingService } from '@/cooking/runtime/services';
import {
  handleRunnerBindingConfirmation,
  handleRunnerBindings,
} from '@/platform/runner/http';
import { runnerService } from '@/platform/runner/server';

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
