import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  EngineeringIdSchema,
  SetEngineeringArchiveCommandSchema,
  UpdateEngineeringCommandSchema,
} from '@agent-party-time/shared/control-plane';
import { currentUser } from '@/lib/auth/server';
import {
  controlPlaneFailure,
  controlPlaneForUser,
} from '@/lib/control-plane/server';

export const dynamic = 'force-dynamic';

const ArchiveEngineeringSchema = z.object({
  action: z.literal('archive'),
  archived: z.boolean(),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ engineeringId: string }> },
) {
  try {
    const user = await currentUser();
    if (!user) return unauthenticated();
    const engineeringId = EngineeringIdSchema.parse(
      (await context.params).engineeringId,
    );
    return NextResponse.json({
      engineering:
        await controlPlaneForUser(user).getEngineering(engineeringId),
    });
  } catch (error) {
    return controlPlaneFailure(error, '无法读取工程配置');
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ engineeringId: string }> },
) {
  try {
    const user = await currentUser();
    if (!user) return unauthenticated();
    const engineeringId = EngineeringIdSchema.parse(
      (await context.params).engineeringId,
    );
    const body = await request.json();
    const client = controlPlaneForUser(user);
    const idempotencyKey =
      request.headers.get('idempotency-key') ??
      `web-engineering-update:${crypto.randomUUID()}`;
    const archive = ArchiveEngineeringSchema.safeParse(body);
    if (archive.success) {
      const command = SetEngineeringArchiveCommandSchema.parse({
        engineeringId,
        archived: archive.data.archived,
      });
      return NextResponse.json({
        engineering: await client.setEngineeringArchived(
          command.engineeringId,
          command.archived,
          idempotencyKey,
        ),
      });
    }
    const existing = await client.getEngineering(engineeringId);
    const engineering = await client.updateEngineering(
      UpdateEngineeringCommandSchema.parse({
        ...(body as Record<string, unknown>),
        engineeringId,
        slug: existing.slug,
        repositoryUrl: existing.repositoryUrl,
      }),
      idempotencyKey,
    );
    return NextResponse.json({ engineering });
  } catch (error) {
    return controlPlaneFailure(error, '无法修改工程');
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ engineeringId: string }> },
) {
  try {
    const user = await currentUser();
    if (!user) return unauthenticated();
    const engineeringId = EngineeringIdSchema.parse(
      (await context.params).engineeringId,
    );
    await controlPlaneForUser(user).deleteEngineering(
      engineeringId,
      request.headers.get('idempotency-key') ??
        `web-engineering-delete:${crypto.randomUUID()}`,
    );
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return controlPlaneFailure(error, '无法删除工程');
  }
}

function unauthenticated() {
  return NextResponse.json(
    { message: '请先登录', error: '请先登录' },
    { status: 401 },
  );
}
