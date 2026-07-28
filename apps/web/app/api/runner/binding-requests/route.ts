import { bindingRequestService } from '@/features/cooking/application/server';
import { handleRunnerBindingWorkClaim } from '@/server/runner/http';
import { runnerService } from '@/server/runner/server';

export async function POST(request: Request): Promise<Response> {
  return handleRunnerBindingWorkClaim(request, runnerService(), (runnerId) =>
    bindingRequestService().claimNext(runnerId),
  );
}
