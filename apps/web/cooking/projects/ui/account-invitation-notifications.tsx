import type { ReceivedProjectInvitation } from '../contract';
import { InvitationForm } from './invitation-form';

export function AccountInvitationNotifications({
  invitations,
}: {
  invitations: ReceivedProjectInvitation[];
}) {
  if (!invitations.length) return null;

  return (
    <section className="collab-account-menu__notifications">
      <header>
        <span>项目邀请</span>
        <small>{invitations.length} 条待处理</small>
      </header>
      <div className="collab-account-menu__invitation-list">
        {invitations.map(
          ({ invitation, invitedByDisplayName, projectName }) => (
            <article key={invitation.id}>
              <span>{invitedByDisplayName} 邀请你加入项目</span>
              <strong>{projectName}</strong>
              <p>接受后，你可以参与该项目的工程配置与提测协作。</p>
              <div>
                <InvitationForm
                  decision="REJECT"
                  invitationId={invitation.id}
                  label="拒绝"
                  returnTo="/cooking/projects"
                  version={invitation.version}
                />
                <InvitationForm
                  buttonClassName="collab-account-menu__accept"
                  decision="ACCEPT"
                  invitationId={invitation.id}
                  label="接受"
                  returnTo="/cooking/projects"
                  version={invitation.version}
                />
              </div>
            </article>
          ),
        )}
      </div>
    </section>
  );
}
