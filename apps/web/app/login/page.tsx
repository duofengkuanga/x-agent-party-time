import type { Metadata } from 'next';
import { currentUser } from '@/lib/auth/server';
import { DEMO_USERS, safeRedirectPath } from '@/lib/auth/core';
import { redirect } from 'next/navigation';
import { LoginExperience } from '@/components/login-experience';

export const metadata: Metadata = {
  title: '入场 — Agent Party Time',
  description: '登录 Agent Party Time 协作现场。',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const [user, params] = await Promise.all([currentUser(), searchParams]);
  if (user) redirect('/cooking');

  return (
    <LoginExperience
      accounts={DEMO_USERS.map(
        ({ password: _password, ...account }) => account,
      )}
      nextPath={safeRedirectPath(params.next) ?? ''}
    />
  );
}
