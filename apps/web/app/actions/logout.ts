'use server';

import { redirect } from 'next/navigation';
import { destroyCurrentSession } from '@/app/auth';

export async function logoutAction(): Promise<never> {
  await destroyCurrentSession();
  redirect('/login');
}
