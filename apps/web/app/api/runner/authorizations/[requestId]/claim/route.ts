import { handleRunnerAuthorizationClaim } from '@/platform/runner/http';
import { runnerService } from '@/platform/runner/server';

export async function POST(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
): Promise<Response> {
  const { requestId } = await context.params;
  return handleRunnerAuthorizationClaim(request, requestId, runnerService());
}
