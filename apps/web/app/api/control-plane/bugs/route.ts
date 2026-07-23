import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { CreateBugCommandSchema } from '@agent-party-time/shared/control-plane';
import { controlPlane, controlPlaneFailure } from '@/lib/control-plane/server';
import { sanitizeBugDetail } from '@/lib/control-plane/public';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const projectId = new URL(request.url).searchParams.get('projectId');
    if (!projectId)
      return NextResponse.json({ error: '缺少 projectId' }, { status: 400 });
    return NextResponse.json({
      items: await controlPlane().listBugs(projectId),
    });
  } catch (error) {
    return controlPlaneFailure(error, '无法读取 Bug 列表');
  }
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const files = form.getAll('attachments').filter(isFile);
    const attachments = await Promise.all(
      files.map(async (file) => ({
        fileName: file.name,
        mediaType: mediaTypeFor(file),
        sizeBytes: file.size,
        contentBase64: Buffer.from(await file.arrayBuffer()).toString('base64'),
      })),
    );
    const input = CreateBugCommandSchema.parse({
      projectId: text(form, 'projectId'),
      title: text(form, 'title'),
      operationPath: text(form, 'operationPath'),
      actualResult: text(form, 'actualResult'),
      expectedResult: text(form, 'expectedResult'),
      supplementalDescription: text(form, 'supplementalDescription') || null,
      attachments,
    });
    const idempotencyKey =
      request.headers.get('idempotency-key') ?? `web-bug:${randomUUID()}`;
    const bug = await controlPlane().createBug(input, idempotencyKey);
    return NextResponse.json({ bug: sanitizeBugDetail(bug) }, { status: 201 });
  } catch (error) {
    return controlPlaneFailure(error, 'Bug 创建失败');
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
  return (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      txt: 'text/plain',
      log: 'text/plain',
      json: 'application/json',
    }[extension ?? ''] ?? file.type
  );
}
