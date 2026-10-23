import { jsonOperation } from '@/server/platform/http/responses';
import { bearerCredential } from '@/server/platform/runner/http';
import type { RunnerService } from '@/server/platform/runner/service';
import type { BugService } from './bugService';
import {
  BugDeleteRequestSchema,
  BugDeleteResponseSchema,
} from '../../../contracts/submissions/bug';

export async function handleBugDelete(
  request: Request,
  runners: Pick<RunnerService, 'authenticateCredential'>,
  bugs: Pick<BugService, 'deleteBugs'>,
): Promise<Response> {
  return jsonOperation(
    BugDeleteResponseSchema,
    async () => {
      const credential = bearerCredential(request);
      runners.authenticateCredential(credential);
      const body = BugDeleteRequestSchema.parse(await request.json());
      return bugs.deleteBugs(body);
    },
    { operation: '删除缺陷' },
  );
}
