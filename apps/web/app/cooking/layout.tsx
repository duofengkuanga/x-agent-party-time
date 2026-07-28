import type { ReactNode } from 'react';
import { currentUser } from '@/server/auth/server';
import { projectService } from '@/features/cooking/application/server';
import { AccountInvitationNotifications } from '@/features/cooking/projects/presentation/account-invitation-notifications';
import { CookingShell } from '@/features/cooking/presentation/cooking-shell';
import './cooking.css';

export default async function CookingLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await currentUser();
  if (!user) return children;
  const invitations = projectService().listReceivedInvitations(user.id);
  return (
    <CookingShell
      accountNotifications={
        <AccountInvitationNotifications invitations={invitations} />
      }
      currentUser={user}
    >
      {children}
    </CookingShell>
  );
}
