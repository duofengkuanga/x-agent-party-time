import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { PlatformError } from '@/server/errors';
import { EngineeringIdentifierSchema } from '../contract';
import { engineeringActionError } from './action-error';

describe('engineeringActionError', () => {
  test('保留可直接展示的中文字段校验原因', () => {
    const parsed = EngineeringIdentifierSchema.safeParse('Web');
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('预期稳定标识校验失败');

    expect(engineeringActionError(parsed.error)).toEqual({
      code: 'VALIDATION_FAILED',
      message:
        '工程标识只能使用中文、小写字母、数字和连字符，并以中文或小写字母开头',
      status: 400,
    });
  });

  test('隐藏非中文 Zod 细节并保留已有平台错误', () => {
    const parsed = z.uuid().safeParse('invalid');
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('预期 UUID 校验失败');

    expect(engineeringActionError(parsed.error)).toEqual({
      code: 'VALIDATION_FAILED',
      message: '提交内容不完整或格式不正确，请检查后重试。',
      status: 400,
    });
    expect(
      engineeringActionError(
        new PlatformError('RESOURCE_CONFLICT', '工程标识已存在'),
      ),
    ).toEqual({
      code: 'RESOURCE_CONFLICT',
      message: '工程标识已存在',
      status: 409,
    });
  });

  test('未知异常继续使用服务错误兜底', () => {
    expect(engineeringActionError(new Error('database unavailable'))).toEqual({
      code: 'INTERNAL_ERROR',
      message: '服务暂时不可用，请稍后重试。',
      status: 500,
    });
  });
});
