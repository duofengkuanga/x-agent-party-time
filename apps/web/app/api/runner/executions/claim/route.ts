import { handleExecutionClaim } from '@/server/execution/http';
import { executionService } from '@/server/execution/server';
import { runnerService } from '@/server/runner/server';
import { prepareDueUpdateExecutions } from '@/features/cooking/update/application/server';

export async function POST(request: Request): Promise<Response> {
  return handleExecutionClaim(
    request,
    runnerService(),
    executionService(),
    prepareDueUpdateExecutions,
  );
}
