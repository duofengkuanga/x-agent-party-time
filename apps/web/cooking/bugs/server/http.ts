import { jsonOperation } from '@/platform/http/responses';
import { bearerCredential } from '@/platform/runner/http';
import type { RunnerService } from '@/platform/runner/service';
import type { BugService } from './bug-service';
import { BugDeleteRequestSchema, BugDeleteResponseSchema } from '../contract';

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
