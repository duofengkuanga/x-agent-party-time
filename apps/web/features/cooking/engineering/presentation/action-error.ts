import { ZodError } from 'zod';
import { publicError } from '@/server/errors';

const GENERIC_VALIDATION_MESSAGE = '提交内容不完整或格式不正确，请检查后重试。';

export function engineeringActionError(
  error: unknown,
): ReturnType<typeof publicError> {
  if (!(error instanceof ZodError)) return publicError(error);
  const detailedMessage = error.issues.find(({ message }) =>
    /\p{Script=Han}/u.test(message),
  )?.message;
  return {
    code: 'VALIDATION_FAILED',
    message: detailedMessage ?? GENERIC_VALIDATION_MESSAGE,
    status: 400,
  };
}
