import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { PlatformError, publicError } from './index';

let errorLog: ReturnType<typeof spyOn<typeof console, 'error'>>;
beforeEach(() => {
  errorLog = spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorLog.mockRestore());

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
      message: expect.stringMatching(/内部异常.*诊断编号：/u),
      status: 500,
    });
    expect(JSON.stringify(result)).not.toContain('SQLITE');
    expect(JSON.stringify(result)).not.toContain('/Users/private');
  });
});

test('真实外键错误提供分类、处理建议和可关联的安全诊断日志', () => {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys=ON');
  db.run('CREATE TABLE parent(id INTEGER PRIMARY KEY)');
  db.run(
    'CREATE TABLE child(parent_id INTEGER REFERENCES parent(id) ON DELETE RESTRICT)',
  );
  db.run('INSERT INTO parent VALUES (1)');
  db.run('INSERT INTO child VALUES (1)');
  let failure: unknown;
  try {
    db.run('DELETE FROM parent');
  } catch (error) {
    failure = error;
  }
  db.close();
  expect(failure).toBeInstanceOf(Error);
  const result = publicError(failure);
  expect(result.status).toBe(500);
  expect(result.message).toContain('数据一致性校验失败');
  expect(result.message).toContain('不要反复重试');
  const entry = JSON.parse(String(errorLog.mock.calls.at(-1)?.[0]));
  expect(entry.category).toBe('DATA_INTEGRITY');
  expect(entry.sqliteErrno).toBe(1811);
  expect(result.message).toContain(entry.diagnosticId);
  expect(entry.diagnosticId).toMatch(/^[0-9a-f-]{36}$/u);
});

test.each([5, 6, 517])('繁忙错误 %s 明确允许稍后重试', (errno) => {
  const error = Object.assign(new Error('private details'), {
    name: 'SQLiteError',
    errno,
  });
  const result = publicError(error);
  expect(result.status).toBe(503);
  expect(result.message).toContain('稍后重试');
  expect(result.message).not.toContain('private details');
});

test('存储错误不会建议重复提交或泄露内部内容', () => {
  const result = publicError(
    Object.assign(new Error('sensitive internal detail'), {
      name: 'SQLiteError',
      errno: 13,
    }),
  );
  expect(result.message).toContain('存储空间和访问权限');
  expect(result.message).not.toContain('sensitive');
  expect(JSON.stringify(errorLog.mock.calls)).not.toContain('sensitive');
});
