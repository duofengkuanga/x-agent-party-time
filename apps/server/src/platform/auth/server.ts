import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sessionDurationMs } from '@/platform/config';
import { database } from '@/platform/database';
import type { User } from './contract';
import { AuthService } from './service';

export const SESSION_COOKIE_NAME = 'agent_party_time_session';

export function authService(): AuthService {
  return new AuthService(database());
}

export async function currentUser(): Promise<User | null> {
  const cookieStore = await cookies();
  return authService().currentUser(cookieStore.get(SESSION_COOKIE_NAME)?.value);
}

export async function requireCurrentUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}

export async function establishSession(userId: string): Promise<void> {
  const session = authService().createSession(userId, sessionDurationMs());
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, session.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: new Date(session.expiresAt),
  });
}

export async function destroyCurrentSession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  authService().revokeSession(token);
  cookieStore.delete(SESSION_COOKIE_NAME);
}

export function safeRedirectPath(
  value: string | null | undefined,
): string | null {
  if (
    !value ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /%2f|%5c/iu.test(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    return null;
  return value;
}
