import { bugService } from '@/features/cooking/application/server';
import { handleBugDelete } from '@/server/runner/http';
import { runnerService } from '@/server/runner/server';

export async function POST(request: Request): Promise<Response> {
  return handleBugDelete(request, runnerService(), bugService());
}
