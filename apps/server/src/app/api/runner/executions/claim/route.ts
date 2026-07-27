import { handleExecutionClaim } from '@/platform/execution/http';
import { executionService } from '@/platform/execution/server';
import { runnerService } from '@/platform/runner/server';

export async function POST(request: Request): Promise<Response> {
  return handleExecutionClaim(request, runnerService(), executionService());
}
