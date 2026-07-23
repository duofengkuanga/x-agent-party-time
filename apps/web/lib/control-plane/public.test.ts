import { describe, expect, test } from 'bun:test';
import { sanitizePublicText } from './public';

describe('public control-plane result sanitization', () => {
  test('redacts local paths, terminal escapes, and raw CLI events', () => {
    const text = [
      '\u001B[31mfailed\u001B[0m at /Users/test/work/app/src/index.ts:42',
      'Windows path C:\\work\\app\\debug.log',
      '{"type":"thread.started","thread_id":"secret-session"}',
    ].join('\n');

    const sanitized = sanitizePublicText(text);

    expect(sanitized).not.toContain('/Users/test');
    expect(sanitized).not.toContain('C:\\work');
    expect(sanitized).not.toContain('secret-session');
    expect(sanitized).not.toContain('\u001B');
    expect(sanitized).toContain('[本地路径已隐藏]');
    expect(sanitized).toContain('[原始日志已隐藏]');
    expect(sanitizePublicText('/mnt/data/project/output.log')).toBe(
      '[本地路径已隐藏]',
    );
    expect(
      sanitizePublicText('{"type":"item.completed","item":{"id":"1"}}'),
    ).toBe('[原始日志已隐藏]');
  });
});
