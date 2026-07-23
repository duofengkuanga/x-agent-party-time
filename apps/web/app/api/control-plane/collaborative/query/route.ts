import { NextResponse } from 'next/server';
import { CollaborativeQuerySchema } from '@agent-party-time/shared/control-plane';
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
    const input = CollaborativeQuerySchema.parse(await request.json());
    return NextResponse.json(
      await controlPlaneForUser(user).collaborativeQuery(input),
    );
  } catch (error) {
    return controlPlaneFailure(error, '无法读取协作提测数据');
  }
}

function unauthenticated() {
  return NextResponse.json({ error: '请先登录' }, { status: 401 });
}
