import { handleOpenInteraction } from '@/platform/execution/http';
import { executionService } from '@/platform/execution/server';
import { runnerService } from '@/platform/runner/server';

export async function POST(
  request: Request,
  context: { params: Promise<{ executionId: string }> },
): Promise<Response> {
  return handleOpenInteraction(
    request,
    (await context.params).executionId,
    runnerService(),
    executionService(),
  );
}
