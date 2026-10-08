import { expect, test } from 'bun:test';
import { UserSchema } from '@/platform/auth/contract';
import { parseRow } from './row-mapper';

test('用户记录映射只读取公开 Schema 的字段', () => {
  const row = {
    id: 'fixture-user',
    username: 'fixture-user',
    display_name: '测试用户',
    created_at: '2026-07-27T00:00:00.000Z',
  };
  Object.defineProperty(row, 'password_hash', {
    enumerable: true,
    get() {
      throw new Error('额外字段不应被读取');
    },
  });

  expect(parseRow(UserSchema, row)).toEqual({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    createdAt: row.created_at,
  });
});
