import { handleWaitInteraction } from '@/platform/execution/http';
import { cookingExecutionService } from '@/cooking/runtime/repair';
import { runnerService } from '@/platform/runner/server';

export async function POST(
  request: Request,
  context: { params: Promise<{ interactionId: string }> },
): Promise<Response> {
  return handleWaitInteraction(
    request,
    (await context.params).interactionId,
    runnerService(),
    cookingExecutionService(),
  );
}
