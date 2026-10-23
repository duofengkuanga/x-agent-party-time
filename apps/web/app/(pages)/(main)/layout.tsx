import type { ReactNode } from 'react';
import { currentUser } from '@/app/auth';
import { projectService } from '@/server/runtime/services';
import { AccountInvitationNotifications } from '@/app/(pages)/(main)/projects/components/accountInvitationNotifications';
import { AppShell } from '@/app/(pages)/(main)/components/appShell';
import './main.css';

export default async function MainLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await currentUser();
  if (!user) return children;
  const invitations = projectService().listReceivedInvitations(user.id);
  return (
    <AppShell
      accountNotifications={
        <AccountInvitationNotifications invitations={invitations} />
      }
      currentUser={user}
    >
      {children}
    </AppShell>
  );
}
