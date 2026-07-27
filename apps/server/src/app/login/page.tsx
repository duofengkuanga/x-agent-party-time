import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentUser, safeRedirectPath } from '@/platform/auth/server';
import { LoginForm } from './login-form';

export const metadata: Metadata = {
  title: '入场 — Agent Party Time',
  description: '登录 Agent Party Time 协作现场。',
};

const LOGIN_ACCOUNTS = [
  {
    id: 'user-xujiequan',
    username: 'xujiequan',
    displayName: '徐捷泉',
    accountType: 'DEVELOPER',
  },
  {
    id: 'user-zhoumingbo',
    username: 'zhoumingbo',
    displayName: '周明波',
    accountType: 'DEVELOPER',
  },
  {
    id: 'user-tianguohui',
    username: 'tianguohui',
    displayName: '田国会',
    accountType: 'TESTER',
  },
] as const;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const [user, params] = await Promise.all([currentUser(), searchParams]);
  if (user) redirect('/cooking');
  return (
    <LoginForm
      accounts={LOGIN_ACCOUNTS}
      next={safeRedirectPath(params.next) ?? '/cooking'}
    />
  );
}
