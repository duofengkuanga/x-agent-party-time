import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import {
  ControlPlaneClientError,
  HttpControlPlaneAdapter,
} from '@agent-party-time/control-plane-client';
import { DEFAULTS } from '@agent-party-time/shared/config';
import type { CurrentUser } from '@/lib/auth/core';

export function controlPlane() {
  return new HttpControlPlaneAdapter({
    baseUrl:
      process.env.AGENT_PARTY_TIME_CONTROL_PLANE_URL ??
      DEFAULTS.controlPlaneUrl,
    timeoutMs: 30_000,
  });
}

export function controlPlaneForUser(user: CurrentUser) {
  return new HttpControlPlaneAdapter({
    baseUrl:
      process.env.AGENT_PARTY_TIME_CONTROL_PLANE_URL ??
      DEFAULTS.controlPlaneUrl,
    timeoutMs: 30_000,
    actor: {
      kind: 'user',
      userId: user.id,
      accountType: user.accountType,
    },
  });
}

export function controlPlaneFailure(error: unknown, fallback: string) {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const message =
      issue && /[\u3400-\u9fff]/u.test(issue.message)
        ? issue.message
        : '提交内容不完整或格式不正确';
    return NextResponse.json(
      { message, error: message, code: 'config.invalid' },
      { status: 400 },
    );
  }
  if (error instanceof ControlPlaneClientError)
    return NextResponse.json(
      {
        message: error.appError.message,
        error: error.appError.message,
        code: error.appError.code,
      },
      {
        status:
          error.appError.category === 'authentication'
            ? 401
            : error.appError.category === 'permission'
              ? 403
              : error.appError.category === 'not_found'
                ? 404
                : error.appError.category === 'conflict'
                  ? 409
                  : error.appError.category === 'validation'
                    ? 400
                    : 503,
      },
    );
  return NextResponse.json(
    { message: fallback, error: fallback, code: 'internal.unexpected' },
    { status: 500 },
  );
}
