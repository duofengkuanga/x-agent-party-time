import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { controlPlane, controlPlaneFailure } from '@/lib/control-plane/server';

export const dynamic = 'force-dynamic';

const RepairBoardCommandSchema = z.object({
  action: z.enum(['enqueue', 'return']),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ bugId: string }> },
) {
  try {
    const [{ bugId }, command] = await Promise.all([
      context.params,
      request.json().then((body) => RepairBoardCommandSchema.parse(body)),
    ]);
    const idempotencyKey =
      request.headers.get('idempotency-key') ??
      `web-repair:${command.action}:${randomUUID()}`;
    const result =
      command.action === 'enqueue'
        ? await controlPlane().enqueueBugForRepair(bugId, idempotencyKey)
        : await controlPlane().returnBugToWaiting(bugId, idempotencyKey);
    return NextResponse.json(result);
  } catch (error) {
    return controlPlaneFailure(error, '无法更新 Bug 修复状态');
  }
}
