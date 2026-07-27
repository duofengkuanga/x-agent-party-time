import { currentUser } from '@/server/auth/server';
import { PlatformError, publicError } from '@/server/errors';
import {
  bugService,
  cookingFileStore,
} from '@/features/cooking/application/server';
import { updateService } from '@/features/cooking/update/application/server';

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
      if (!(error instanceof PlatformError) || error.code !== 'NOT_FOUND')
        throw error;
      updateService().requireExternalAttachmentAccess(user.id, fileId);
    }
    const { file, bytes } = await cookingFileStore().read(fileId);
    return new Response(Uint8Array.from(bytes).buffer, {
      headers: {
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
        'content-length': String(file.sizeBytes),
        'content-type': file.mediaType,
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
