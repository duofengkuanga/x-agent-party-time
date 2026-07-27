'use server';

import { redirect } from 'next/navigation';
import {
  authService,
  establishSession,
  safeRedirectPath,
} from '@/server/auth/server';
import { logger } from '@/server/logging';

export type LoginState = { error: string | null };

export async function loginAction(
  _previousState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const username = String(formData.get('username') ?? '');
  const password = String(formData.get('password') ?? '');

  try {
    const user = await authService().authenticate(username, password);
    if (!user) return { error: '用户名或密码不正确，请检查后再试。' };
    await establishSession(user.id);
    const next = safeRedirectPath(String(formData.get('next') ?? ''));
    redirect(next && next !== '/' ? next : '/cooking');
  } catch (error) {
    if (isRedirectError(error)) throw error;
    logger.error('auth.login_failed', error, { username });
    return { error: '登录暂时失败，请稍后重试。' };
  }
}

function isRedirectError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'digest' in error &&
    typeof error.digest === 'string' &&
    error.digest.startsWith('NEXT_REDIRECT')
  );
}
