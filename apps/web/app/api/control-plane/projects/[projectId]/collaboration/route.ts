import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  CreateProjectInvitationCommandSchema,
  ProjectIdSchema,
  RemoveProjectMemberCommandSchema,
  RevokeProjectInvitationCommandSchema,
} from '@agent-party-time/shared/control-plane';
import { currentUser } from '@/lib/auth/server';
import {
  controlPlaneFailure,
  controlPlaneForUser,
} from '@/lib/control-plane/server';

export const dynamic = 'force-dynamic';

const DeleteCollaborationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('invitation'), invitationId: z.uuid() }),
  z.object({ kind: z.literal('member'), userId: z.string().min(1).max(80) }),
]);

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const user = await currentUser();
    if (!user) return unauthenticated();
    const projectId = ProjectIdSchema.parse((await context.params).projectId);
    return NextResponse.json(
      await controlPlaneForUser(user).getProjectCollaboration(projectId),
    );
  } catch (error) {
    return controlPlaneFailure(error, '无法读取项目成员');
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const user = await currentUser();
    if (!user) return unauthenticated();
    const projectId = ProjectIdSchema.parse((await context.params).projectId);
    const body = (await request.json()) as { inviteeUserId?: unknown };
    const input = CreateProjectInvitationCommandSchema.parse({
      projectId,
      inviteeUserId: body.inviteeUserId,
    });
    const invitation = await controlPlaneForUser(user).createProjectInvitation(
      input,
      request.headers.get('idempotency-key') ??
        `web-project-invitation:${crypto.randomUUID()}`,
    );
    return NextResponse.json({ invitation }, { status: 201 });
  } catch (error) {
    return controlPlaneFailure(error, '无法创建项目邀请');
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const user = await currentUser();
    if (!user) return unauthenticated();
    const projectId = ProjectIdSchema.parse((await context.params).projectId);
    const input = DeleteCollaborationSchema.parse(await request.json());
    const client = controlPlaneForUser(user);
    const idempotencyKey =
      request.headers.get('idempotency-key') ??
      `web-project-collaboration-delete:${crypto.randomUUID()}`;
    if (input.kind === 'invitation') {
      const command = RevokeProjectInvitationCommandSchema.parse({
        invitationId: input.invitationId,
      });
      const invitation = await client.revokeProjectInvitation(
        command.invitationId,
        idempotencyKey,
      );
      return NextResponse.json({ invitation });
    }
    const command = RemoveProjectMemberCommandSchema.parse({
      projectId,
      userId: input.userId,
    });
    await client.removeProjectMember(command, idempotencyKey);
    return NextResponse.json({ removed: true });
  } catch (error) {
    return controlPlaneFailure(error, '无法更新项目成员');
  }
}

function unauthenticated() {
  return NextResponse.json({ error: '请先登录' }, { status: 401 });
}
