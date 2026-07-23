import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { controlPlane, controlPlaneFailure } from '@/lib/control-plane/server';
import { sanitizeDeploymentBatch } from '@/lib/control-plane/public';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ bugId: string }> },
) {
  try {
    const { bugId } = await context.params;
    const idempotencyKey =
      request.headers.get('idempotency-key') ??
      `web-deployment-enqueue:${randomUUID()}`;
    const result = await controlPlane().enqueueBugForDeployment(
      bugId,
      idempotencyKey,
    );
    return NextResponse.json({
      bug: result.bug,
      batch: sanitizeDeploymentBatch(result.batch),
    });
  } catch (error) {
    return controlPlaneFailure(error, '无法加入部署批次');
  }
}
