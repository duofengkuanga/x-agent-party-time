import { describe, expect, test } from 'bun:test';
import {
  normalizeRepositoryUrl,
  RunnerBindingConfirmationRequestSchema,
} from '@agent-party-time/runner-contract';

describe('仓库逻辑地址', () => {
  test('跨协议、用户名和尾缀归一为同一仓库身份', () => {
    const expected = 'https://github.com/Team/Project.git';
    expect(normalizeRepositoryUrl('git@GitHub.com:Team/Project.git')).toBe(
      expected,
    );
    expect(normalizeRepositoryUrl('ssh://git@github.com/Team/Project/')).toBe(
      expected,
    );
    expect(
      normalizeRepositoryUrl('ssh://git@github.com:22/Team/Project.git'),
    ).toBe(expected);
    expect(
      normalizeRepositoryUrl(
        'https://secret@github.com/Team/Project.git?access_token=hidden',
      ),
    ).toBe(expected);
  });

  test('确认协议拒绝本机路径并只输出规范化地址', () => {
    expect(
      RunnerBindingConfirmationRequestSchema.parse({
        bindingId: '00000000-0000-4000-8000-000000000001',
        repositoryUrl: 'git@example.com:team/app',
      }),
    ).toEqual({
      bindingId: '00000000-0000-4000-8000-000000000001',
      repositoryUrl: 'https://example.com/team/app.git',
    });
    expect(() => normalizeRepositoryUrl('/Users/me/app')).toThrow();
    expect(() =>
      RunnerBindingConfirmationRequestSchema.parse({
        bindingId: '00000000-0000-4000-8000-000000000001',
        repositoryUrl: 'https://example.com/team/app.git',
        localPath: '/Users/me/app',
      }),
    ).toThrow();
  });
});
