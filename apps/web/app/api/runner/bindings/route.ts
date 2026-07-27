import { bindingService } from '@/features/cooking/application/server';
import { handleRunnerBindings } from '@/server/runner/http';
import { runnerService } from '@/server/runner/server';

export async function GET(request: Request): Promise<Response> {
  return handleRunnerBindings(request, runnerService(), (runnerId) =>
    bindingService()
      .listBindingsForRunner(runnerId)
      .map(({ id }) => ({ bindingId: id })),
  );
}
