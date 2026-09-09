import { redirect } from 'next/navigation';
import { currentUser } from '@/platform/auth/server';

export default async function HomePage() {
  redirect((await currentUser()) ? '/cooking' : '/login');
}
