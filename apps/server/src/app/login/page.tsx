import { redirect } from 'next/navigation';
import { currentUser, safeRedirectPath } from '@/platform/auth/server';
import { LoginForm } from './login-form';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (await currentUser()) redirect('/cooking');
  const params = await searchParams;
  return (
    <main className="login-page">
      <LoginForm next={safeRedirectPath(params.next) ?? '/cooking'} />
    </main>
  );
}
