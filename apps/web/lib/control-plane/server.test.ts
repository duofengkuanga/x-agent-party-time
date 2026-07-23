import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { ControlPlaneClientError } from '@agent-party-time/control-plane-client';
import { createAppError } from '@agent-party-time/shared/control-plane';
import { controlPlaneFailure } from './server';

describe('controlPlaneFailure', () => {
  test('returns the concrete business message with a compatible error field', async () => {
    const response = controlPlaneFailure(
      new ControlPlaneClientError(
        createAppError({
          code: 'engineering.environment_invalid',
          category: 'validation',
          message: '测试环境不属于当前工程',
          retryable: false,
        }),
      ),
      '无法修改工程',
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: 'engineering.environment_invalid',
      message: '测试环境不属于当前工程',
      error: '测试环境不属于当前工程',
    });
  });

  test('uses a concrete Chinese schema message when available', async () => {
    const schema = z.object({
      slug: z.string().min(1, '工程标识不能为空'),
    });
    let validationError: unknown;
    try {
      schema.parse({ slug: '' });
    } catch (error) {
      validationError = error;
    }

    const response = controlPlaneFailure(validationError, '无法修改工程');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: 'config.invalid',
      message: '工程标识不能为空',
      error: '工程标识不能为空',
    });
  });

  test('returns a safe fallback message for an unexpected error', async () => {
    const response = controlPlaneFailure(
      new Error('database secret'),
      '无法修改工程',
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: 'internal.unexpected',
      message: '无法修改工程',
      error: '无法修改工程',
    });
  });
});
