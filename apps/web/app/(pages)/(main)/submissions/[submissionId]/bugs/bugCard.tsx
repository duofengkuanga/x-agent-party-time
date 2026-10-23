'use client';

import { useEffect, useState, type DragEvent as ReactDragEvent } from 'react';
import type { SubmissionVisualPresentation as SubmissionVisualPresentation } from '@/contracts/shared';
import type { UpdateBatchView } from '@/contracts/submissions/update';
import type { BugView } from '../../../../../../contracts/submissions/bug';
import {
  engineeringTypeLabel,
  stopCardAction,
  formatCountdown,
} from './boardModel';
import { PassConfirmButton } from './passConfirmButton';

export function BugCard({
  blockedReason,
  bug,
  draggable,
  dragging,
  eligibleAt,
  onDragEnd,
  onDragStart,
  onArchive,
  onOpen,
  onReopen,
  onRequestRework,
  onVerifyPass,
  pending,
  visual,
}: {
  blockedReason?: string | null;
  bug: BugView;
  draggable: boolean;
  dragging: boolean;
  eligibleAt?: string;
  onDragEnd: () => void;
  onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
  onArchive: () => void;
  onOpen: () => void;
  onReopen: () => void;
  onRequestRework: () => void;
  onVerifyPass: () => void;
  pending: boolean;
  visual: SubmissionVisualPresentation;
}) {
  return (
    <article
      className={`collab-bug-card${draggable ? ' collab-bug-card--draggable' : ''}`}
      data-dragging={dragging ? 'true' : undefined}
      data-stage={bug.stage}
      data-visual-state={visual.state}
      draggable={draggable}
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
    >
      <button
        aria-label={`${bug.report.title}，${engineeringTypeLabel(bug.assignment?.engineeringType)}，${visual.label}`}
        className="collab-bug-card__open"
        onClick={onOpen}
        type="button"
      />
      <span aria-hidden="true" className="collab-bug-card__state">
        {visual.symbol}
      </span>
      <h3>{bug.report.title}</h3>
      {blockedReason ? (
        <p className="collab-bug-card__blocked">{blockedReason}</p>
      ) : null}
      <footer className="collab-bug-card__footer">
        <small className="collab-bug-card__type">
          {engineeringTypeLabel(bug.assignment?.engineeringType)}
        </small>
        <div className="collab-bug-card__footer-end">
          {visual.state !== 'IDLE' ? (
            <strong className="collab-bug-card__attention">
              {visual.label}
              {eligibleAt ? (
                <span className="collab-bug-card__countdown">
                  <UpdateCountdown eligibleAt={eligibleAt} />
                </span>
              ) : null}
            </strong>
          ) : null}
          {bug.availableActions.some((action) =>
            ['VERIFY_PASS', 'VERIFY_FAIL', 'REOPEN'].includes(action),
          ) ? (
            <div
              aria-busy={pending}
              className={`collab-bug-card__actions${bug.availableActions.includes('VERIFY_PASS') ? ' collab-bug-card__verification' : ''}`}
            >
              {bug.availableActions.includes('VERIFY_PASS') ? (
                <PassConfirmButton
                  disabled={pending}
                  message="确认这张缺陷已通过测试？"
                  onConfirm={onVerifyPass}
                />
              ) : null}
              {bug.availableActions.includes('VERIFY_FAIL') ? (
                <button
                  disabled={pending}
                  onClick={stopCardAction(onRequestRework)}
                  type="button"
                >
                  还有问题
                </button>
              ) : null}
              {bug.availableActions.includes('REOPEN') ? (
                <button
                  disabled={pending}
                  onClick={stopCardAction(onReopen)}
                  type="button"
                >
                  重新打开
                </button>
              ) : null}
              {bug.availableActions.includes('ARCHIVE') ? (
                <button
                  disabled={pending}
                  onClick={stopCardAction(onArchive)}
                  type="button"
                >
                  归档
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </footer>
    </article>
  );
}

export function LinkedReviewCard({
  backend,
  frontend,
  onOpen,
  onIssue,
  onArchive,
  onVerifyPass,
  pending,
}: {
  backend: BugView;
  frontend: BugView;
  onOpen: () => void;
  onIssue: () => void;
  onArchive: () => void;
  onVerifyPass: () => void;
  pending: boolean;
}) {
  const review = frontend.linkedReview!;
  const waiting = review.column === 'WAITING_FOR_VERIFICATION';
  return (
    <article
      className="collab-bug-card collab-linked-review-card"
      data-stage={waiting ? 'WAITING_FOR_VERIFICATION' : 'DONE'}
      data-visual-state="IDLE"
    >
      <button
        aria-label={`${frontend.report.title}，前端和后端关联缺陷详情`}
        className="collab-bug-card__open"
        onClick={onOpen}
        type="button"
      />
      <span aria-hidden="true" className="collab-bug-card__state">
        ·
      </span>
      <h3>{frontend.report.title}</h3>
      <div className="collab-linked-review-card__sides">
        {[frontend, backend].map((bug) => (
          <div key={bug.id}>
            <span>{engineeringTypeLabel(bug.assignment?.engineeringType)}</span>
            <span>{bug.presentation.stageLabel}</span>
          </div>
        ))}
      </div>
      {review.blockedReason ? (
        <p className="collab-bug-card__blocked">{review.blockedReason}</p>
      ) : null}
      <footer className="collab-bug-card__footer">
        <small className="collab-bug-card__type">前端＋后端</small>
        {!review.blockedReason ? (
          <div className="collab-bug-card__actions" aria-busy={pending}>
            {waiting ? (
              <PassConfirmButton
                disabled={pending}
                message="确认前端和后端的待验证缺陷都已通过测试？已完成的缺陷保持原状。"
                onConfirm={onVerifyPass}
              />
            ) : null}
            <button disabled={pending} onClick={onIssue} type="button">
              {waiting ? '还有问题' : '重新打开'}
            </button>
            {!waiting ? (
              <button disabled={pending} onClick={onArchive} type="button">
                归档
              </button>
            ) : null}
          </div>
        ) : null}
      </footer>
    </article>
  );
}

function UpdateCountdown({ eligibleAt }: { eligibleAt: string }) {
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  useEffect(() => {
    const update = () =>
      setRemainingMs(new Date(eligibleAt).getTime() - Date.now());
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [eligibleAt]);
  if (remainingMs === null) return null;
  return formatCountdown(remainingMs);
}

export function UpdateBatchCard({
  batch,
  engineeringType,
  onOpen,
}: {
  batch: UpdateBatchView;
  engineeringType?: NonNullable<BugView['assignment']>['engineeringType'];
  onOpen: () => void;
}) {
  const visual = batch.presentation.visual;
  const primaryEntry = batch.entries[0]!;
  return (
    <article
      className="collab-bug-card collab-update-batch-card"
      data-stage="UPDATING"
      data-visual-state={visual.state}
    >
      <button
        aria-label={`${primaryEntry.bugTitle}，${engineeringTypeLabel(engineeringType)}，${visual.label}`}
        className="collab-bug-card__open"
        onClick={onOpen}
        type="button"
      />
      <span aria-hidden="true" className="collab-bug-card__state">
        {visual.symbol}
      </span>
      <h3>{primaryEntry.bugTitle}</h3>
      {batch.entries.length > 1 ? (
        <small className="collab-update-batch-card__more">
          同批另含 {batch.entries.length - 1} 条缺陷
        </small>
      ) : null}
      <footer className="collab-bug-card__footer">
        <small className="collab-bug-card__type">
          {engineeringTypeLabel(engineeringType)}
        </small>
        <div className="collab-bug-card__footer-end">
          <strong className="collab-bug-card__attention">{visual.label}</strong>
        </div>
      </footer>
    </article>
  );
}
