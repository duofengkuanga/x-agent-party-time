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
  title: string;
  operationPath: string;
  actualResult: string;
  expectedResult: string;
  keptActualResultAttachmentIds: string[];
  keptExpectedResultAttachmentIds: string[];
  actualResultFiles: File[];
  expectedResultFiles: File[];
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
    title: saved?.title ?? bug?.report.title ?? '',
    operationPath: saved?.operationPath ?? bug?.report.operationPath ?? '',
    actualResult: saved?.actualResult ?? bug?.report.actualResult ?? '',
    expectedResult: saved?.expectedResult ?? bug?.report.expectedResult ?? '',
    keptActualResultAttachmentIds:
      saved?.keptActualResultAttachmentIds ??
      bug?.report.actualResultAttachments.map(({ id }) => id) ??
      [],
    keptExpectedResultAttachmentIds:
      saved?.keptExpectedResultAttachmentIds ??
      bug?.report.expectedResultAttachments.map(({ id }) => id) ??
      [],
    actualResultFiles: saved?.actualResultFiles ?? [],
    expectedResultFiles: saved?.expectedResultFiles ?? [],
    submissionItemId,
    frontItemId,
    backItemId,
    joint: Boolean(saved?.joint && frontItemId && backItemId),
  };
}
