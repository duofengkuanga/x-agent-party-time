import { handleOpenInteraction } from '@/platform/execution/http';
import { cookingExecutionService } from '@/cooking/runtime/repair';
import { runnerService } from '@/platform/runner/server';

export async function POST(
  request: Request,
  context: { params: Promise<{ executionId: string }> },
): Promise<Response> {
  return handleOpenInteraction(
    request,
    (await context.params).executionId,
    runnerService(),
    cookingExecutionService(),
  );
}
