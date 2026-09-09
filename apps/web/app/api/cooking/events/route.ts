import { currentUser } from '@/platform/auth/server';
import { workspaceService } from '@/cooking/runtime/services';
import { workspaceEvents } from '@/cooking/submissions/server/workspace-events';
import { handleWorkspaceEvents } from '@/cooking/submissions/server/http';

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
