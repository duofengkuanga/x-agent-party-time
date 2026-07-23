import { NextResponse } from 'next/server';
import { EngineeringIdSchema } from '@agent-party-time/shared/control-plane';
import { currentUser } from '@/lib/auth/server';
import {
  controlPlaneFailure,
  controlPlaneForUser,
} from '@/lib/control-plane/server';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ engineeringId: string }> },
) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: '请先登录' }, { status: 401 });
    const engineeringId = EngineeringIdSchema.parse(
      (await context.params).engineeringId,
    );
    return NextResponse.json({
      items:
        await controlPlaneForUser(user).listEngineeringBindings(engineeringId),
    });
  } catch (error) {
    return controlPlaneFailure(error, '无法读取 Agent 绑定');
  }
}
