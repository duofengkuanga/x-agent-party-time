import { currentUser } from '@/app/auth';
import { workspaceService } from '@/server/runtime/services';
import { workspaceEvents } from '@/server/submissions/workspaceEvents';
import { handleWorkspaceEvents } from '@/server/submissions/http';

export async function GET(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user)
    return Response.json(
      { error: { code: 'NOT_AUTHENTICATED', message: '请先登录。' } },
      { status: 401 },
    );
  return handleWorkspaceEvents(request, user.id, workspaceService(), workspaceEvents());
}
