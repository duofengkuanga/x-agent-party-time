import type { ReactNode } from 'react';
import { requireCurrentUser } from '@/server/auth/server';
import { CookingShell } from '@/features/cooking/presentation/cooking-shell';
import './cooking.css';

export default async function CookingLayout({
  children,
}: {
  children: ReactNode;
}) {
  const currentUser = await requireCurrentUser();
  return <CookingShell currentUser={currentUser}>{children}</CookingShell>;
}
