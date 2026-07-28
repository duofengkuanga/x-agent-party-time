import { randomUUID } from 'node:crypto';
import type { ReceivedProjectInvitation } from '../contract';
import { respondProjectInvitationAction } from './actions';

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
                <InvitationResponseForm
                  decision="REJECT"
                  invitationId={invitation.id}
                  label="拒绝"
                  version={invitation.version}
                />
                <InvitationResponseForm
                  buttonClassName="collab-account-menu__accept"
                  decision="ACCEPT"
                  invitationId={invitation.id}
                  label="接受"
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

function InvitationResponseForm({
  buttonClassName,
  decision,
  invitationId,
  label,
  version,
}: {
  buttonClassName?: string;
  decision: 'ACCEPT' | 'REJECT';
  invitationId: string;
  label: string;
  version: number;
}) {
  return (
    <form action={respondProjectInvitationAction}>
      <input name="mutationId" type="hidden" value={randomUUID()} />
      <input name="invitationId" type="hidden" value={invitationId} />
      <input name="expectedVersion" type="hidden" value={version} />
      <input name="decision" type="hidden" value={decision} />
      <input name="returnTo" type="hidden" value="/cooking/projects" />
      <button className={buttonClassName} type="submit">
        {label}
      </button>
    </form>
  );
}
