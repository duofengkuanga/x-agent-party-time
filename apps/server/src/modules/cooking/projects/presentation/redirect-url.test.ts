import { describe, expect, test } from 'bun:test';
import { messageRedirectPath } from './redirect-url';

describe('messageRedirectPath', () => {
  test('对 Server Action 响应头中的中文消息和动态路径进行安全编码', () => {
    expect(
      messageRedirectPath('/cooking/projects/项目/一', 'success', '项目已创建'),
    ).toBe(
      '/cooking/projects/%E9%A1%B9%E7%9B%AE/%E4%B8%80?success=%E9%A1%B9%E7%9B%AE%E5%B7%B2%E5%88%9B%E5%BB%BA',
    );
    expect(messageRedirectPath('/cooking', 'error', '邀请不存在')).toBe(
      '/cooking?error=%E9%82%80%E8%AF%B7%E4%B8%8D%E5%AD%98%E5%9C%A8',
    );
  });
});
