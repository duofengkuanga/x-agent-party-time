import { ZodError } from 'zod';
import { PlatformError, publicError } from '@/platform/errors';

export function normalizeRequestError(error: unknown): unknown {
  if (error instanceof SyntaxError || error instanceof ZodError)
    return new PlatformError('VALIDATION_FAILED', '请求内容无效', {
      cause: error,
    });
  return error;
}

export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

export function errorResponse(error: unknown, operation?: string): Response {
  const visible = publicError(error, operation);
  return jsonResponse(
    { error: { code: visible.code, message: visible.message } },
    visible.status,
  );
}
