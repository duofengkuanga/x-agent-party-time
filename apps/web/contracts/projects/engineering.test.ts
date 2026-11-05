import { EnvironmentKeySchema } from '@agent-party-time/execution-contract';
import { describe, expect, test } from 'bun:test';
import { EngineeringIdentifierSchema, RepositoryUrlSchema } from './engineering';

describe('EngineeringIdentifier', () => {
  test('接受中文或稳定短标识并拒绝大写、空格和连续分隔符', () => {
    expect(EngineeringIdentifierSchema.parse('大屏')).toBe('大屏');
    expect(EngineeringIdentifierSchema.parse('土壤大屏-85')).toBe('土壤大屏-85');
    expect(EngineeringIdentifierSchema.parse('web')).toBe('web');
    expect(EngineeringIdentifierSchema.parse('admin-web')).toBe('admin-web');
    expect(() => EngineeringIdentifierSchema.parse('Web')).toThrow();
    expect(() => EngineeringIdentifierSchema.parse('admin web')).toThrow();
    expect(() => EngineeringIdentifierSchema.parse('admin--web')).toThrow();
  });
});

test('环境标识接受数字和短标识，拒绝空值、大小写混用及不完整分隔符', () => {
  expect(EnvironmentKeySchema.parse('84')).toBe('84');
  expect(EnvironmentKeySchema.parse('pre-release')).toBe('pre-release');
  for (const invalid of ['', 'DEV-84', 'dev--84', 'dev-'])
    expect(EnvironmentKeySchema.safeParse(invalid).success).toBe(false);
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
