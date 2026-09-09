import { bindingRequestService } from '@/cooking/runtime/services';
import { handleRunnerBindingWorkClaim } from '@/platform/runner/http';
import { runnerService } from '@/platform/runner/server';

export async function POST(request: Request): Promise<Response> {
  return handleRunnerBindingWorkClaim(request, runnerService(), (runnerId) =>
    bindingRequestService().claimNext(runnerId),
  );
}
