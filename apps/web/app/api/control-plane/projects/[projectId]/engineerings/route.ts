import { NextResponse } from 'next/server';
import { ProjectIdSchema } from '@agent-party-time/shared/control-plane';
import { currentUser } from '@/lib/auth/server';
import { prepareEngineeringCreation } from '@/lib/control-plane/engineering-create';
import {
  controlPlaneFailure,
  controlPlaneForUser,
} from '@/lib/control-plane/server';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const user = await currentUser();
    if (!user) return unauthenticated();
    const projectId = ProjectIdSchema.parse((await context.params).projectId);
    const includeArchived =
      new URL(request.url).searchParams.get('includeArchived') !== 'false';
    return NextResponse.json({
      items: await controlPlaneForUser(user).listEngineerings(
        projectId,
        includeArchived,
      ),
    });
  } catch (error) {
    return controlPlaneFailure(error, '无法读取工程目录');
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
    const idempotencyKey =
      request.headers.get('idempotency-key') ??
      `web-engineering:${crypto.randomUUID()}`;
    const input = await prepareEngineeringCreation(
      await request.json(),
      projectId,
      idempotencyKey,
    );
    const engineering = await controlPlaneForUser(user).createEngineering(
      input,
      idempotencyKey,
    );
    return NextResponse.json({ engineering }, { status: 201 });
  } catch (error) {
    return controlPlaneFailure(error, '无法创建工程');
  }
}

function unauthenticated() {
  return NextResponse.json({ error: '请先登录' }, { status: 401 });
}
