import { handleExecutionRenew } from '@/server/execution/http';
import { executionService } from '@/server/execution/server';
import { runnerService } from '@/server/runner/server';

export async function POST(
  request: Request,
  context: { params: Promise<{ executionId: string }> },
): Promise<Response> {
  return handleExecutionRenew(
    request,
    (await context.params).executionId,
    runnerService(),
    executionService(),
  );
}
