import { NextResponse } from 'next/server';
import {
  CreateProjectCommandSchema,
  RenameProjectCommandSchema,
} from '@agent-party-time/shared/control-plane';
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
      items: await controlPlaneForUser(user).listProjects(),
    });
  } catch (error) {
    return controlPlaneFailure(error, '无法读取项目');
  }
}

export async function POST(request: Request) {
  try {
    const user = await currentUser();
    if (!user) return unauthenticated();
    const input = CreateProjectCommandSchema.parse(await request.json());
    const idempotencyKey =
      request.headers.get('idempotency-key') ??
      `web-project:${crypto.randomUUID()}`;
    const project = await controlPlaneForUser(user).createProject(
      input,
      idempotencyKey,
    );
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    return controlPlaneFailure(error, '无法创建项目');
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await currentUser();
    if (!user) return unauthenticated();
    const input = RenameProjectCommandSchema.parse(await request.json());
    const project = await controlPlaneForUser(user).renameProject(
      input.projectId,
      input.title,
    );
    return NextResponse.json({ project });
  } catch (error) {
    return controlPlaneFailure(error, '无法修改项目');
  }
}

function unauthenticated() {
  return NextResponse.json({ error: '请先登录' }, { status: 401 });
}
