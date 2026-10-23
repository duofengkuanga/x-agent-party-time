import { redirect } from 'next/navigation';
import { currentUser } from '@/app/auth';

export default async function HomePage() {
  redirect((await currentUser()) ? '/submissions' : '/login');
}
