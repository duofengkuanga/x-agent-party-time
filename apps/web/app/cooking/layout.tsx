import type { ReactNode } from 'react';
import { currentUser } from '@/platform/auth/server';
import { projectService } from '@/cooking/runtime/services';
import { AccountInvitationNotifications } from '@/cooking/projects/ui/account-invitation-notifications';
import { CookingShell } from '@/cooking/ui/cooking-shell';
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
