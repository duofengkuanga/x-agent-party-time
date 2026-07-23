import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { ContinueDeploymentBatchCommandSchema } from '@agent-party-time/shared/control-plane';
import { controlPlane, controlPlaneFailure } from '@/lib/control-plane/server';
import { sanitizeDeploymentBatch } from '@/lib/control-plane/public';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ batchId: string }> },
) {
  try {
    const [{ batchId }, body] = await Promise.all([
      context.params,
      request.json(),
    ]);
    const input = ContinueDeploymentBatchCommandSchema.parse({
      ...body,
      batchId,
    });
    const idempotencyKey =
      request.headers.get('idempotency-key') ??
      `web-deployment-continue:${randomUUID()}`;
    const batch = await controlPlane().continueDeploymentBatch(
      input,
      idempotencyKey,
    );
    return NextResponse.json({ batch: sanitizeDeploymentBatch(batch) });
  } catch (error) {
    return controlPlaneFailure(error, '无法继续部署');
  }
}
