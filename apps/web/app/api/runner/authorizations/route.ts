import { handleRunnerAuthorizationCreate } from '@/server/runner/http';
import { runnerService } from '@/server/runner/server';

export async function POST(request: Request): Promise<Response> {
  return handleRunnerAuthorizationCreate(request, runnerService());
}
