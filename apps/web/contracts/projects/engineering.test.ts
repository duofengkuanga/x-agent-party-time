import { describe, expect, test } from 'bun:test';
import {
  DeploymentScriptSchema,
  EngineeringIdentifierSchema,
  RepositoryUrlSchema,
} from './engineering';

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

test('部署脚本必须提供非空命令，并拒绝旧的部署方式字段', () => {
  expect(DeploymentScriptSchema.parse({ command: ' bun run deploy:test ' })).toEqual({
    command: 'bun run deploy:test',
  });
  expect(DeploymentScriptSchema.safeParse({ command: '   ' }).success).toBe(false);
  expect(DeploymentScriptSchema.safeParse({ kind: 'CI_CD' }).success).toBe(false);
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
