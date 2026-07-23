import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { ContinueBugRepairCommandSchema } from '@agent-party-time/shared/control-plane';
import { controlPlane, controlPlaneFailure } from '@/lib/control-plane/server';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ bugId: string }> },
) {
  try {
    const [{ bugId }, body] = await Promise.all([
      context.params,
      request.json(),
    ]);
    const input = ContinueBugRepairCommandSchema.parse({ ...body, bugId });
    const idempotencyKey =
      request.headers.get('idempotency-key') ??
      `web-repair-continue:${randomUUID()}`;
    const result = await controlPlane().continueBugRepair(
      input,
      idempotencyKey,
    );
    return NextResponse.json(result);
  } catch (error) {
    return controlPlaneFailure(error, '无法继续修复');
  }
}
