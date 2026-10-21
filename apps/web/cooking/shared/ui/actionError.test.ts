import { describe, expect, test } from 'bun:test';
import { messageOf } from './actionError';

describe('操作错误提示', () => {
  test.each([
    'Failed to fetch',
    'Load failed',
    'NetworkError when attempting to fetch resource.',
  ])('explains uncertain results after transport failure: %s', (message) => {
    const visible = messageOf(new TypeError(message), '无法保存。');
    expect(visible).toContain('未收到服务器响应');
    expect(visible).toContain('先核对');
    expect(visible).not.toContain(message);
  });

  test('explains a known request size rejection without confusing it with a file limit', () => {
    const visible = messageOf(new Error('Body exceeded 1 MB limit.'), '无法保存。');
    expect(visible).toContain('整次提交');
    expect(visible).toContain('服务端');
  });

  test('explains stale actions without exposing their internal identifiers', () => {
    const error = new Error(
      'Server Action "internal-action-id" was not found on the server.',
    );
    error.name = 'UnrecognizedActionError';
    const visible = messageOf(error, '无法保存。');
    expect(visible).toContain('页面版本');
    expect(visible).toContain('保留');
    expect(visible).not.toContain('internal-action-id');
  });

  test('does not expose arbitrary internal errors', () => {
    expect(
      messageOf(new Error('private server path /internal/store'), '无法保存。'),
    ).not.toContain('/internal/store');
  });
});
