import { handleBugDelete } from '@/server/submissions/bugs/http';
import { bugService } from '@/server/runtime/services';

import { runnerService } from '@/server/runtime/runner';

export async function POST(request: Request): Promise<Response> {
  return handleBugDelete(request, runnerService(), bugService());
}
