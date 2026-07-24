import { createHash } from 'node:crypto';
import {
  BugAttachmentMediaTypeSchema,
  ERROR_CODES,
  createAppError,
  type ParsedCreateBugCommand,
} from '@agent-party-time/shared';

const ALLOWED_MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  txt: 'text/plain',
  log: 'text/plain',
  json: 'application/json',
} as const;

export function decodeBugAttachment(
  attachment: ParsedCreateBugCommand['attachments'][number],
) {
  const extension = attachment.fileName.split('.').pop()?.toLowerCase();
  const allowed = extension
    ? ALLOWED_MEDIA_TYPES[extension as keyof typeof ALLOWED_MEDIA_TYPES]
    : undefined;
  if (
    !allowed ||
    BugAttachmentMediaTypeSchema.parse(attachment.mediaType) !== allowed
  )
    throw attachmentError(`附件 ${attachment.fileName} 的文件类型不受支持`);

  const content = Buffer.from(attachment.contentBase64, 'base64');
  if (
    content.toString('base64').replace(/=+$/, '') !==
      attachment.contentBase64.replace(/=+$/, '') ||
    content.byteLength !== attachment.sizeBytes
  )
    throw attachmentError(`附件 ${attachment.fileName} 内容或大小不合法`);

  const maximumBytes = allowed.startsWith('image/')
    ? 10 * 1024 * 1024
    : 2 * 1024 * 1024;
  if (content.byteLength > maximumBytes)
    throw attachmentError(`附件 ${attachment.fileName} 超过大小限制`);
  return content;
}

export function safeAttachmentName(name: string) {
  return (
    name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180) ||
    createHash('sha256').update(name).digest('hex').slice(0, 16)
  );
}

function attachmentError(message: string) {
  return createAppError({
    code: ERROR_CODES.configInvalid,
    category: 'validation',
    message,
    retryable: false,
  });
}
