import { describe, expect, test } from 'bun:test';
import { PlatformError, publicError } from './index';

describe('publicError', () => {
  test('保留明确的 Platform 错误', () => {
    expect(publicError(new PlatformError('NOT_FOUND', '资源不存在'))).toEqual({
      code: 'NOT_FOUND',
      message: '资源不存在',
      status: 404,
    });
  });

  test('隐藏 SQLite、路径与 Stack Trace 等内部错误', () => {
    const result = publicError(
      new Error('SQLITE_CONSTRAINT at /Users/private/server.sqlite'),
    );
    expect(result).toEqual({
      code: 'INTERNAL_ERROR',
      message: '服务暂时不可用，请稍后重试。',
      status: 500,
    });
    expect(JSON.stringify(result)).not.toContain('SQLITE');
    expect(JSON.stringify(result)).not.toContain('/Users/private');
  });
});
