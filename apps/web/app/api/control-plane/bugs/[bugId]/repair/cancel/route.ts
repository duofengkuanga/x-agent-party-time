import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { sanitizeRepairAttempt } from '@/lib/control-plane/public';
import { controlPlane, controlPlaneFailure } from '@/lib/control-plane/server';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ bugId: string }> },
) {
  try {
    const { bugId } = await context.params;
    const idempotencyKey =
      request.headers.get('idempotency-key') ??
      `web-repair-cancel:${randomUUID()}`;
    const result = await controlPlane().cancelRepairAttempt(
      bugId,
      idempotencyKey,
    );
    return NextResponse.json({
      ...result,
      attempt: sanitizeRepairAttempt(result.attempt),
    });
  } catch (error) {
    return controlPlaneFailure(error, '无法取消修复');
  }
}
