import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { controlPlane, controlPlaneFailure } from '@/lib/control-plane/server';
import { sanitizeDeploymentBatch } from '@/lib/control-plane/public';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ batchId: string }> },
) {
  try {
    const { batchId } = await context.params;
    const idempotencyKey =
      request.headers.get('idempotency-key') ??
      `web-deployment-cancel:${randomUUID()}`;
    const batch = await controlPlane().cancelDeploymentBatch(
      batchId,
      idempotencyKey,
    );
    return NextResponse.json({ batch: sanitizeDeploymentBatch(batch) });
  } catch (error) {
    return controlPlaneFailure(error, '无法取消部署批次');
  }
}
