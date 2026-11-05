import { createClientId } from '@/app/(pages)/(main)/components/clientId';
import type { SubmissionWorkspaceSnapshot } from '@/contracts/submissions/workspace';
import type { BugView } from '../../../../../../contracts/submissions/bug';

export type BugOwnershipDraft = {
  submissionItemId: string;
  joint: boolean;
  frontItemId: string;
  backItemId: string;
};
export type BugFormDraft = BugOwnershipDraft & {
  mutationId: string;
  expectedVersion: number | null;
  description: string;
  keptAttachmentIds: string[];
  files: File[];
};
export type BugRegistration = {
  ownership: BugOwnershipDraft;
};

export function createBugFormDraft(
  bug: BugView | null,
  snapshot: SubmissionWorkspaceSnapshot,
  saved: BugFormDraft | null,
  preferred: BugOwnershipDraft | null,
): BugFormDraft {
  const items = snapshot.submission.items;
  const preferredOwnership = saved ?? (!bug ? preferred : null);
  const frontend = items.filter(({ engineering }) => engineering.type === 'FRONTEND');
  const backend = items.filter(({ engineering }) => engineering.type === 'BACKEND');
  const frontItemId =
    frontend.find(
      ({ id }) => id === preferredOwnership?.frontItemId || id === bug?.submissionItemId,
    )?.id ??
    frontend[0]?.id ??
    '';
  const backItemId =
    backend.find(
      ({ id }) => id === preferredOwnership?.backItemId || id === bug?.submissionItemId,
    )?.id ??
    backend[0]?.id ??
    '';
  const submissionItemId =
    preferredOwnership &&
    (preferredOwnership.submissionItemId === '' ||
      items.some(({ id }) => id === preferredOwnership.submissionItemId))
      ? preferredOwnership.submissionItemId
      : bug
        ? (bug.submissionItemId ?? '')
        : (items[0]?.id ?? '');
  return {
    mutationId: saved?.mutationId ?? createClientId(),
    expectedVersion: saved?.expectedVersion ?? bug?.version ?? null,
    description: saved?.description ?? bug?.report.description ?? '',
    keptAttachmentIds:
      saved?.keptAttachmentIds ?? bug?.report.attachments.map(({ id }) => id) ?? [],
    files: saved?.files ?? [],
    submissionItemId,
    frontItemId,
    backItemId,
    joint: Boolean(saved?.joint && frontItemId && backItemId),
  };
}
