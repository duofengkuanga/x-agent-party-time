import type { ReactNode } from 'react';
import { requireCurrentUser } from '@/server/auth/server';
import { projectService } from '@/features/cooking/application/server';
import { AccountInvitationNotifications } from '@/features/cooking/projects/presentation/account-invitation-notifications';
import { CookingShell } from '@/features/cooking/presentation/cooking-shell';
import './cooking.css';

export default async function CookingLayout({
  children,
}: {
  children: ReactNode;
}) {
  const currentUser = await requireCurrentUser();
  const invitations = projectService().listReceivedInvitations(currentUser.id);
  return (
    <CookingShell
      accountNotifications={
        <AccountInvitationNotifications invitations={invitations} />
      }
      currentUser={currentUser}
    >
      {children}
    </CookingShell>
  );
}
