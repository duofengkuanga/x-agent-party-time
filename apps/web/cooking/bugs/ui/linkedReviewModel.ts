import type { BugView } from '../contract';

export type LinkedReviewPair = {
  frontend: BugView;
  backend: BugView;
  primary: BugView;
  ready: boolean;
  column: 'WAITING_FOR_VERIFICATION' | 'DONE';
};

const reviewStage = (stage: BugView['stage']) =>
  stage === 'WAITING_FOR_VERIFICATION' || stage === 'DONE';

export function linkedReviewPairFor(
  bug: BugView,
  bugs: BugView[],
): LinkedReviewPair | null {
  const relation = bug.relatedBugs.find(
    ({ id, kind }) => id && (kind === 'JOINT' || kind === 'COLLABORATION'),
  );
  const peer = bugs.find(({ id }) => id === relation?.id);
  if (!peer || peer.submissionId !== bug.submissionId) return null;
  if (!peer.relatedBugs.some(({ id }) => id === bug.id)) return null;
  const frontend = bug.assignment?.engineeringType === 'FRONTEND' ? bug : peer;
  const backend = frontend === bug ? peer : bug;
  if (
    frontend.assignment?.engineeringType !== 'FRONTEND' ||
    backend.assignment?.engineeringType !== 'BACKEND'
  )
    return null;
  return {
    frontend,
    backend,
    primary: bug.shortId < peer.shortId ? bug : peer,
    ready:
      !frontend.archivedAt &&
      !backend.archivedAt &&
      reviewStage(frontend.stage) &&
      reviewStage(backend.stage),
    column:
      frontend.stage === 'WAITING_FOR_VERIFICATION' ||
      backend.stage === 'WAITING_FOR_VERIFICATION'
        ? 'WAITING_FOR_VERIFICATION'
        : 'DONE',
  };
}

export function linkedReviewBlockedReason(
  bug: BugView,
  pair: LinkedReviewPair | null,
): string | null {
  if (!pair || pair.ready) return null;
  const peer = pair.frontend.id === bug.id ? pair.backend : pair.frontend;
  const engineering = peer.assignment?.engineeringType === 'FRONTEND' ? '前端' : '后端';
  if (peer.archivedAt) return `关联的${engineering}缺陷已归档，请先移出归档后再验收。`;
  if (!reviewStage(peer.stage))
    return `关联的${engineering}缺陷仍在${peer.presentation.stageLabel}，请等它进入待验证或已完成后再操作。`;
  return '请等前端和后端关联缺陷都进入待验证或已完成后再操作。';
}
