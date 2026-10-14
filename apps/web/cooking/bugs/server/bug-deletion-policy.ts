import type { Bug } from '../contract';
import type { AccessRow } from './bug-queries';

export function canDeleteUnassignedBug(
  userId: string,
  access: AccessRow,
  bug: Bug,
  anyResponsible: boolean,
): boolean {
  return (
    access.submission_status === 'ACTIVE' &&
    (userId === access.tester_user_id || anyResponsible) &&
    bug.submissionItemId === null &&
    bug.stage === 'WAITING_FOR_REPAIR' &&
    !bug.reportLockedAt &&
    !bug.collaborationLocked &&
    !bug.transferredAt &&
    !bug.archivedAt
  );
}
