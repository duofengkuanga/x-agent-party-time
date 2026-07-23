import { NextResponse, type NextRequest } from 'next/server';
import { readSessionToken } from '@/lib/auth/core';
import { SESSION_COOKIE_NAME, sessionSecret } from '@/lib/auth/config';

export async function proxy(request: NextRequest) {
  const user = await readSessionToken(
    request.cookies.get(SESSION_COOKIE_NAME)?.value,
    sessionSecret(),
  );
  const isLogin = request.nextUrl.pathname === '/login';

  if (!user) {
    if (isLogin) return NextResponse.next();
    if (request.nextUrl.pathname.startsWith('/api/'))
      return NextResponse.json({ error: '请先登录' }, { status: 401 });

    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set(
      'next',
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
    );
    return NextResponse.redirect(loginUrl);
  }

  if (isLogin) return NextResponse.redirect(new URL('/cooking', request.url));

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-agent-party-time-user-id', user.id);
  requestHeaders.set('x-agent-party-time-account-type', user.accountType);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
