import { handleRunnerSelfRevocation } from '@/platform/runner/http';
import { runnerService } from '@/platform/runner/server';

export async function DELETE(request: Request): Promise<Response> {
  return handleRunnerSelfRevocation(request, runnerService());
}
