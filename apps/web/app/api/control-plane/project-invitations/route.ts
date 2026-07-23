import { NextResponse } from 'next/server';
import { RespondProjectInvitationCommandSchema } from '@agent-party-time/shared/control-plane';
import { currentUser } from '@/lib/auth/server';
import {
  controlPlaneFailure,
  controlPlaneForUser,
} from '@/lib/control-plane/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await currentUser();
    if (!user) return unauthenticated();
    return NextResponse.json({
      items: await controlPlaneForUser(user).listReceivedProjectInvitations(),
    });
  } catch (error) {
    return controlPlaneFailure(error, '无法读取项目邀请');
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await currentUser();
    if (!user) return unauthenticated();
    const input = RespondProjectInvitationCommandSchema.parse(
      await request.json(),
    );
    const invitation = await controlPlaneForUser(user).respondProjectInvitation(
      input,
      request.headers.get('idempotency-key') ??
        `web-project-invitation-response:${crypto.randomUUID()}`,
    );
    return NextResponse.json({ invitation });
  } catch (error) {
    return controlPlaneFailure(error, '无法处理项目邀请');
  }
}

function unauthenticated() {
  return NextResponse.json({ error: '请先登录' }, { status: 401 });
}
