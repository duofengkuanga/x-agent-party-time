import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { CollaborativeCommandSchema } from '@agent-party-time/shared/control-plane';
import type { ControlPlanePort } from '@agent-party-time/control-plane-client';
import { currentUser } from '@/lib/auth/server';
import {
  controlPlaneFailure,
  controlPlaneForUser,
} from '@/lib/control-plane/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const user = await currentUser();
    if (!user) return unauthenticated();
    const input = CollaborativeCommandSchema.parse(await request.json());
    const client: ControlPlanePort = controlPlaneForUser(user);
    const result = await client.collaborativeCommand(
      input,
      request.headers.get('idempotency-key') ??
        `web-collaborative:${input.kind}:${randomUUID()}`,
    );
    return NextResponse.json(result);
  } catch (error) {
    return controlPlaneFailure(error, '无法执行协作提测操作');
  }
}

function unauthenticated() {
  return NextResponse.json({ error: '请先登录' }, { status: 401 });
}
