import { currentUser } from '@/app/auth';
import { PlatformError, publicError } from '@/server/platform/errors/index';
import { bugService, applicationFileStore } from '@/server/runtime/services';
import { updateService } from '@/server/runtime/services';

export async function GET(
  _request: Request,
  context: { params: Promise<{ fileId: string }> },
): Promise<Response> {
  const user = await currentUser();
  if (!user)
    return Response.json(
      { error: { code: 'NOT_AUTHENTICATED', message: '请先登录。' } },
      { status: 401 },
    );
  try {
    const { fileId } = await context.params;
    try {
      bugService().requireAttachmentAccess(user.id, fileId);
    } catch (error) {
      if (!(error instanceof PlatformError) || error.code !== 'NOT_FOUND') throw error;
      updateService().requireExternalAttachmentAccess(user.id, fileId);
    }
    const { file, bytes } = await applicationFileStore().read(fileId);
    const previewRequested =
      new URL(_request.url).searchParams.get('preview') === '1' &&
      file.mediaType.startsWith('image/');
    return new Response(Uint8Array.from(bytes).buffer, {
      headers: {
        'cache-control': 'private, no-store',
        'content-disposition': `${previewRequested ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
        'content-length': String(file.sizeBytes),
        'content-type': file.mediaType,
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    const visible = publicError(error);
    return Response.json(
      { error: { code: visible.code, message: visible.message } },
      { status: visible.status, headers: { 'cache-control': 'no-store' } },
    );
  }
}
