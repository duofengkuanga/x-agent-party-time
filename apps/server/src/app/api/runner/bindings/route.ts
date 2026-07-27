import { bindingService } from '@/modules/cooking/application/server';
import { handleRunnerBindings } from '@/platform/runner/http';
import { runnerService } from '@/platform/runner/server';

export async function GET(request: Request): Promise<Response> {
  return handleRunnerBindings(request, runnerService(), (runnerId) =>
    bindingService()
      .listBindingsForRunner(runnerId)
      .map(({ id }) => ({ bindingId: id })),
  );
}
