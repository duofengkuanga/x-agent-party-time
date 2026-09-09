import { bindingRequestService } from '@/cooking/runtime/services';
import { handleRunnerBindingWorkCompletion } from '@/platform/runner/http';
import { runnerService } from '@/platform/runner/server';

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
