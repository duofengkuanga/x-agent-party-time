import { randomUUID } from 'node:crypto';
import { respondProjectInvitationAction } from '@/cooking/projects/server/actions';

export function InvitationForm({
  buttonClassName,
  decision,
  invitationId,
  label,
  returnTo,
  version,
}: {
  buttonClassName?: string;
  decision: 'ACCEPT' | 'REJECT';
  invitationId: string;
  label: string;
  returnTo?: string;
  version: number;
}) {
  return (
    <form action={respondProjectInvitationAction}>
      <input name="mutationId" type="hidden" value={randomUUID()} />
      <input name="invitationId" type="hidden" value={invitationId} />
      <input name="expectedVersion" type="hidden" value={version} />
      <input name="decision" type="hidden" value={decision} />
      {returnTo ? (
        <input name="returnTo" type="hidden" value={returnTo} />
      ) : null}
      <button className={buttonClassName} type="submit">
        {label}
      </button>
    </form>
  );
}
