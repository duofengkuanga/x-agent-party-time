import { currentUser } from '@/app/auth';
import { database } from '@/server/database/index';
import { ExecutionObservations } from '@/server/platform/execution/observations';
import { submissionObservationAccess } from '@/server/submissions/observationAccess';
import { handleObservationRead } from '@/server/platform/execution/observationHttp';

export async function GET(
  request: Request,
  context: { params: Promise<{ executionId: string }> },
): Promise<Response> {
  const user = await currentUser();
  if (!user)
    return Response.json(
      { error: { code: 'NOT_AUTHENTICATED', message: '请先登录。' } },
      { status: 401, headers: { 'cache-control': 'private, no-store' } },
    );
  const { executionId } = await context.params;
  const db = database();
  return handleObservationRead(
    request,
    user.id,
    executionId,
    new ExecutionObservations(db, submissionObservationAccess(db)),
  );
}
