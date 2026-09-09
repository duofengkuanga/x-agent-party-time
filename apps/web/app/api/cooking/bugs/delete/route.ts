import { handleBugDelete } from '@/cooking/bugs/server/http';
import { bugService } from '@/cooking/runtime/services';

import { runnerService } from '@/platform/runner/server';

export async function POST(request: Request): Promise<Response> {
  return handleBugDelete(request, runnerService(), bugService());
}
