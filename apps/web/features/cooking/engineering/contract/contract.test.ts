import { describe, expect, test } from 'bun:test';
import {
  DeploymentMethodSchema,
  EngineeringIdentifierSchema,
  RepositoryUrlSchema,
} from './index';

describe('EngineeringIdentifier', () => {
  test('接受稳定短标识并拒绝大小写、空格和连续分隔符', () => {
    expect(EngineeringIdentifierSchema.parse('web')).toBe('web');
    expect(EngineeringIdentifierSchema.parse('admin-web')).toBe('admin-web');
    expect(() => EngineeringIdentifierSchema.parse('Web')).toThrow();
    expect(() => EngineeringIdentifierSchema.parse('admin web')).toThrow();
    expect(() => EngineeringIdentifierSchema.parse('admin--web')).toThrow();
  });
});

describe('DeploymentMethod', () => {
  test('LOCAL_SCRIPT 必须且只能携带非空 command', () => {
    expect(
      DeploymentMethodSchema.parse({
        kind: 'LOCAL_SCRIPT',
        command: 'bun run deploy:test',
      }),
    ).toEqual({ kind: 'LOCAL_SCRIPT', command: 'bun run deploy:test' });
    expect(() =>
      DeploymentMethodSchema.parse({ kind: 'LOCAL_SCRIPT' }),
    ).toThrow();
    expect(() =>
      DeploymentMethodSchema.parse({ kind: 'LOCAL_SCRIPT', command: '   ' }),
    ).toThrow();
  });

  test('CI_CD 不允许 command 或冗余确认字段', () => {
    expect(DeploymentMethodSchema.parse({ kind: 'CI_CD' })).toEqual({
      kind: 'CI_CD',
    });
    expect(() =>
      DeploymentMethodSchema.parse({ kind: 'CI_CD', command: 'deploy' }),
    ).toThrow();
    expect(() =>
      DeploymentMethodSchema.parse({
        kind: 'CI_CD',
        manualConfirmationRequired: true,
      }),
    ).toThrow();
  });
});

describe('RepositoryUrl', () => {
  test('接受常见远程仓库地址且拒绝本机路径', () => {
    expect(RepositoryUrlSchema.parse('https://example.com/team/app.git')).toBe(
      'https://example.com/team/app.git',
    );
    expect(RepositoryUrlSchema.parse('git@example.com:team/app.git')).toBe(
      'https://example.com/team/app.git',
    );
    expect(() => RepositoryUrlSchema.parse('/Users/me/app')).toThrow();
  });
});
