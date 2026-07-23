import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { BugAttachmentMediaTypeSchema } from '@agent-party-time/shared/control-plane';
import { controlPlane, controlPlaneFailure } from '@/lib/control-plane/server';

export const dynamic = 'force-dynamic';

const PassCommandSchema = z.object({ action: z.literal('pass') });

export async function POST(
  request: Request,
  context: { params: Promise<{ bugId: string }> },
) {
  try {
    const { bugId } = await context.params;
    const idempotencyKey =
      request.headers.get('idempotency-key') ??
      `web-verify:${randomUUID()}`;
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      PassCommandSchema.parse(await request.json());
      return NextResponse.json({
        bug: await controlPlane().verifyBugPassed(bugId, idempotencyKey),
      });
    }

    const form = await request.formData();
    const feedback = text(form, 'feedback');
    const files = form.getAll('attachments').filter(isFile);
    const attachments = await Promise.all(
      files.map(async (file) => ({
        fileName: file.name,
        mediaType: mediaTypeFor(file),
        sizeBytes: file.size,
        contentBase64: Buffer.from(await file.arrayBuffer()).toString('base64'),
      })),
    );
    return NextResponse.json(
      await controlPlane().verifyBugFailed(
        { bugId, feedback, attachments },
        idempotencyKey,
      ),
    );
  } catch (error) {
    return controlPlaneFailure(error, '无法提交验证结果');
  }
}

function text(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

function isFile(value: FormDataEntryValue): value is File {
  return typeof value !== 'string';
}

function mediaTypeFor(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  return BugAttachmentMediaTypeSchema.parse(
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      txt: 'text/plain',
      log: 'text/plain',
      json: 'application/json',
    }[extension ?? ''] ?? file.type,
  );
}
