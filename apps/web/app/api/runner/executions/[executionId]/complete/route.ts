import { handleExecutionComplete } from '@/server/execution/http';
import { cookingExecutionService } from '@/features/cooking/repair/application/server';
import { runnerService } from '@/server/runner/server';

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
