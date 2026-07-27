import { handleWaitInteraction } from '@/server/execution/http';
import { executionService } from '@/server/execution/server';
import { runnerService } from '@/server/runner/server';

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
