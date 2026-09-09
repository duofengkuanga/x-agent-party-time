import { handleRunnerPair } from '@/platform/runner/http';
import { runnerService } from '@/platform/runner/server';

export async function POST(request: Request): Promise<Response> {
  return handleRunnerPair(request, runnerService());
}
