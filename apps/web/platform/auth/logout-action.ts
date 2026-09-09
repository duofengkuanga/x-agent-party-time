'use server';

import { redirect } from 'next/navigation';
import { destroyCurrentSession } from '@/platform/auth/server';

export async function logoutAction(): Promise<never> {
  await destroyCurrentSession();
  redirect('/login');
}
