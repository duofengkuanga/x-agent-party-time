import { handleExecutionComplete } from '@/platform/execution/http';
import { cookingExecutionService } from '@/modules/cooking/repair/application/server';
import { runnerService } from '@/platform/runner/server';

export async function POST(
  request: Request,
  context: { params: Promise<{ executionId: string }> },
): Promise<Response> {
  return handleExecutionComplete(
    request,
    (await context.params).executionId,
    runnerService(),
    cookingExecutionService(),
  );
}
