import { handleWaitInteraction } from '@/platform/execution/http';
import { executionService } from '@/platform/execution/server';
import { runnerService } from '@/platform/runner/server';

export async function POST(
  request: Request,
  context: { params: Promise<{ interactionId: string }> },
): Promise<Response> {
  return handleWaitInteraction(
    request,
    (await context.params).interactionId,
    runnerService(),
    executionService(),
  );
}
