import { controlPlane, controlPlaneFailure } from '@/lib/control-plane/server';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ attachmentId: string }> },
) {
  try {
    const { attachmentId } = await context.params;
    const result = await controlPlane().getBugAttachment(attachmentId);
    return new Response(Buffer.from(result.contentBase64, 'base64'), {
      headers: {
        'cache-control': 'private, no-store',
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(result.attachment.fileName)}`,
        'content-type': result.attachment.mediaType,
      },
    });
  } catch (error) {
    return controlPlaneFailure(error, '无法读取附件');
  }
}
