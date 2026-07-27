'use server';

import { redirect } from 'next/navigation';
import { destroyCurrentSession } from '@/server/auth/server';

export async function logoutAction(): Promise<never> {
  await destroyCurrentSession();
  redirect('/login');
}
