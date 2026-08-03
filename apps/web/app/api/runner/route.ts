import { handleRunnerSelfRevocation } from '@/server/runner/http';
import { runnerService } from '@/server/runner/server';

export async function DELETE(request: Request): Promise<Response> {
  return handleRunnerSelfRevocation(request, runnerService());
}
