import { currentUser } from '@/platform/auth/server';
import { submissionService } from '@/modules/cooking/application/server';
import { handleWorkspaceSnapshot } from '@/modules/cooking/submissions/presentation/http';

export async function GET(
  _request: Request,
  context: { params: Promise<{ submissionId: string }> },
): Promise<Response> {
  const user = await currentUser();
  if (!user)
    return Response.json(
      { error: { code: 'NOT_AUTHENTICATED', message: '请先登录。' } },
      { status: 401 },
    );
  const { submissionId } = await context.params;
  return handleWorkspaceSnapshot(submissionId, user.id, submissionService());
}
