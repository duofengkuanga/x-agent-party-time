import { redirect } from 'next/navigation';
import { currentUser } from '@/server/auth/server';

export default async function HomePage() {
  redirect((await currentUser()) ? '/cooking' : '/login');
}
