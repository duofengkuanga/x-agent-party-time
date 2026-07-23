import 'server-only';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSessionToken, type CurrentUser } from './core';
import { SESSION_COOKIE_NAME, sessionSecret } from './config';

export async function currentUser(): Promise<CurrentUser | null> {
  const cookieStore = await cookies();
  return readSessionToken(
    cookieStore.get(SESSION_COOKIE_NAME)?.value,
    sessionSecret(),
  );
}

export async function requireCurrentUser(): Promise<CurrentUser> {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}
