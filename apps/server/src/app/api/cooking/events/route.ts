import { currentUser } from '@/platform/auth/server';
import { workspaceService } from '@/modules/cooking/application/server';
import { workspaceEvents } from '@/modules/cooking/submissions/application/workspace-events';
import { handleWorkspaceEvents } from '@/modules/cooking/submissions/presentation/http';

export async function GET(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user)
    return Response.json(
      { error: { code: 'NOT_AUTHENTICATED', message: '请先登录。' } },
      { status: 401 },
    );
  return handleWorkspaceEvents(
    request,
    user.id,
    workspaceService(),
    workspaceEvents(),
  );
}
