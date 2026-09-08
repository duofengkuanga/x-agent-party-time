import { logger } from '@/server/logging';
import { PlatformError, type PlatformErrorCode } from './platform-error';

export { PlatformError, type PlatformErrorCode } from './platform-error';

export function publicError(
  error: unknown,
  operation?: string,
): {
  code: PlatformErrorCode;
  message: string;
  status: number;
} {
  if (error instanceof PlatformError)
    return { code: error.code, message: error.message, status: error.status };
  const diagnosticId = crypto.randomUUID();
  const diagnostic = classifyUnexpectedError(error);
  logger.error('platform.unexpected_error', error, {
    diagnosticId,
    category: diagnostic.category,
    operation,
    sqliteErrno: diagnostic.sqliteErrno,
  });
  return {
    code: 'INTERNAL_ERROR',
    message: `${operation ? `${operation}失败：` : ''}${diagnostic.message}（诊断编号：${diagnosticId}）`,
    status: diagnostic.status,
  };
}

// Classify structured error codes only: raw messages and stacks may contain secrets.
function classifyUnexpectedError(error: unknown): {
  category: 'BUSY' | 'DATA_INTEGRITY' | 'STORAGE' | 'UNKNOWN';
  message: string;
  status: number;
  sqliteErrno?: number;
} {
  const sqliteErrno =
    error instanceof Error &&
    error.name === 'SQLiteError' &&
    'errno' in error &&
    typeof error.errno === 'number' &&
    Number.isSafeInteger(error.errno) &&
    error.errno >= 0
      ? error.errno
      : undefined;
  // SQLite extended result codes keep the primary result in the low byte.
  const primary = sqliteErrno === undefined ? undefined : sqliteErrno & 0xff;
  if (primary === 5 || primary === 6)
    return {
      category: 'BUSY',
      sqliteErrno,
      status: 503,
      message: '服务正在处理其他数据操作，本次请求未能完成。请稍后重试。',
    };
  if (primary === 19)
    return {
      category: 'DATA_INTEGRITY',
      sqliteErrno,
      status: 500,
      message:
        '数据一致性校验失败，操作未能完成。请提供诊断编号联系维护者检查数据关系，不要反复重试。',
    };
  if (primary !== undefined && [8, 10, 11, 13, 14, 26].includes(primary))
    return {
      category: 'STORAGE',
      sqliteErrno,
      status: 500,
      message:
        '服务无法读写所需数据。请提供诊断编号联系维护者检查存储空间和访问权限。',
    };
  return {
    category: 'UNKNOWN',
    sqliteErrno,
    status: 500,
    message:
      '操作遇到内部异常，未能确认结果。请先刷新确认当前状态；若仍有问题，请提供诊断编号联系维护者。',
  };
}
