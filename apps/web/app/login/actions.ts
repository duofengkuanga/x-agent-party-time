'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  authenticateDemoUser,
  createSessionToken,
  safeRedirectPath,
} from '@/lib/auth/core';
import {
  SESSION_COOKIE_NAME,
  SESSION_DURATION_MS,
  sessionSecret,
} from '@/lib/auth/config';

export interface LoginState {
  error: string | null;
}

export async function login(
  _previousState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const username = String(formData.get('username') ?? '');
  const password = String(formData.get('password') ?? '');
  const user = authenticateDemoUser(username, password);

  if (!user) return { error: '用户名或密码不正确，请检查后再试。' };

  const expiresAt = Date.now() + SESSION_DURATION_MS;
  const token = await createSessionToken(user.id, sessionSecret(), expiresAt);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: new Date(expiresAt),
  });

  const requestedPath = safeRedirectPath(String(formData.get('next') ?? ''));
  redirect(requestedPath && requestedPath !== '/' ? requestedPath : '/cooking');
}
