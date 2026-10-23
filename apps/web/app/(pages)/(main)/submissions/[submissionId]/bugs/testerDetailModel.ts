import type { BugView } from '../../../../../../contracts/submissions/bug';
import type { SubmissionWorkspaceSnapshot } from '@/contracts/submissions/workspace';

export function testerBugStatus(
  bug: BugView,
  snapshot: SubmissionWorkspaceSnapshot,
): string {
  const responsible = bug.assignment?.responsibleUser.displayName ?? '工程负责人';
  const item = snapshot.submission.items.find(({ id }) => id === bug.submissionItemId);
  const visual = snapshot.visualByBug[bug.id];
  if (bug.transferredAt) return '已转交关联缺陷继续处理，此关闭不代表验收通过。';
  if (bug.stage === 'DONE') return '已验收通过，确认问题解决。';
  if (bug.stage === 'CANCELLED') return '缺陷已取消。';
  if (snapshot.submission.submission.status === 'CLOSED')
    return '提测已关闭，仅可查看缺陷资料。';
  if (bug.stage === 'WAITING_FOR_REPAIR')
    return bug.assignment
      ? '资料已保存，确认后可以开始修复。'
      : '请先确认问题归属，再开始修复。';
  if (bug.stage === 'REPAIRING') {
    switch (visual.state) {
      case 'FAILED':
        return `修复遇到问题，等待${responsible}处理。`;
      case 'NEEDS_APPROVAL':
      case 'NEEDS_INPUT':
        return `修复需要确认，等待${responsible}处理。`;
      case 'QUEUED_FOR_ENGINEERING':
        return '已提交修复，正在等待处理。';
      case 'WAITING_TO_RESUME':
        return `修复暂时中断，等待${responsible}恢复处理。`;
      default:
        return `${responsible}正在处理，当前无需你操作。`;
    }
  }
  if (item && !item.environmentAccess.owned)
    return '测试环境正由其他提测使用，当前暂不可复测。';
  if (item && !item.environmentAccess.deploymentConfirmed)
    return `等待${responsible}确认测试环境，当前暂不可复测。`;
  if (bug.stage === 'WAITING_FOR_UPDATE') return '修复已完成，测试环境更新后才能复测。';
  if (bug.stage === 'UPDATING') {
    const waitingForConfirmation = snapshot.updateBatches.some(
      (batch) =>
        batch.state === 'WAITING_EXTERNAL' &&
        batch.entries.some((entry) => entry.bugId === bug.id),
    );
    if (waitingForConfirmation) return `等待${responsible}确认环境更新结果，请稍后复测。`;
    if (visual.state === 'FAILED') return `环境更新遇到问题，等待${responsible}处理。`;
    if (visual.state === 'NEEDS_APPROVAL' || visual.state === 'NEEDS_INPUT')
      return `环境更新需要${responsible}确认，请稍后复测。`;
    if (visual.state === 'WAITING_TO_RESUME')
      return `环境更新暂时中断，等待${responsible}恢复处理。`;
    return '测试环境正在更新，请稍后复测。';
  }
  return item && bug.availableActions.includes('VERIFY_PASS')
    ? `可以在${item.environment.name}复测。`
    : '当前暂不可复测。';
}

export function latestTesterFeedback(
  bugId: string,
  snapshot: SubmissionWorkspaceSnapshot,
) {
  return [
    ...(snapshot.verificationsByBug[bugId] ?? [])
      .filter(({ result }) => result === 'FAILED')
      .map(({ comment, attachments, createdAt }) => ({
        text: comment,
        attachments,
        createdAt,
      })),
    ...(snapshot.reopensByBug[bugId] ?? []).map(
      ({ feedback, attachments, createdAt }) => ({
        text: feedback,
        attachments,
        createdAt,
      }),
    ),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

export function linkedReviewPairFor(bug: BugView, bugs: BugView[]) {
  const review = bug.linkedReview;
  const peer = bugs.find(({ id }) => id === review?.relatedBugId);
  if (!review || !peer) return null;
  const frontend = bug.assignment?.engineeringType === 'FRONTEND' ? bug : peer;
  return {
    frontend,
    backend: frontend === bug ? peer : bug,
    primary: bug.shortId < peer.shortId ? bug : peer,
    ready: !review.blockedReason,
    column: review.column,
  };
}

export type LinkedReviewPair = NonNullable<ReturnType<typeof linkedReviewPairFor>>;
