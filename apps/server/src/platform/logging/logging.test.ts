import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { logger } from './index';

const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe('logger', () => {
  test('递归隐藏密码、Session Token、本机路径和错误消息', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    spies.push(errorSpy);

    logger.error(
      'platform.failed',
      new Error('token=raw-token /Users/private/server.sqlite'),
      {
        username: 'user-one',
        nested: {
          password: 'raw-password',
          sessionToken: 'raw-token',
          filePath: '/Users/private/file',
        },
      },
    );

    const line = String(errorSpy.mock.calls[0]?.[0]);
    expect(line).toContain('platform.failed');
    expect(line).toContain('user-one');
    expect(line).not.toContain('raw-password');
    expect(line).not.toContain('raw-token');
    expect(line).not.toContain('/Users/private');
  });
});
