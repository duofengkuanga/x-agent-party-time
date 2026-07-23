import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { controlPlane, controlPlaneFailure } from '@/lib/control-plane/server';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ dispatchId: string }> },
) {
  try {
    const { dispatchId } = await context.params;
    const idempotencyKey =
      request.headers.get('idempotency-key') ??
      `web-dispatch-close:${randomUUID()}`;
    return NextResponse.json({
      dispatch: await controlPlane().closeRepairDispatch(
        dispatchId,
        idempotencyKey,
      ),
    });
  } catch (error) {
    return controlPlaneFailure(error, '无法立即开始修复');
  }
}
