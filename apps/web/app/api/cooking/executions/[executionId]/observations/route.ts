import { currentUser } from '@/platform/auth/server';
import { database } from '@/platform/database';
import { ExecutionObservations } from '@/platform/execution/observations';
import { cookingObservationAccess } from '@/cooking/runtime/observationAccess';
import { handleObservationRead } from '@/platform/execution/observationHttp';

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
    new ExecutionObservations(db, cookingObservationAccess(db)),
  );
}
