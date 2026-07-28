import { bindingRequestService } from '@/features/cooking/application/server';
import { handleRunnerBindingWorkCompletion } from '@/server/runner/http';
import { runnerService } from '@/server/runner/server';

export async function POST(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
): Promise<Response> {
  const { requestId } = await context.params;
  return handleRunnerBindingWorkCompletion(
    request,
    requestId,
    runnerService(),
    (runnerId, id, completion) =>
      bindingRequestService().complete(runnerId, id, completion),
  );
}
