'use client';

import { useEffect, useState, type DragEvent as ReactDragEvent } from 'react';
import type { CookingVisualPresentation } from '@/cooking/shared/contract';
import type { UpdateBatchView } from '@/cooking/update/contract';
import type { BugView } from '../contract';
import {
  engineeringTypeLabel,
  stopCardAction,
  formatCountdown,
} from './board-model';

export function BugCard({
  bug,
  draggable,
  dragging,
  eligibleAt,
  onDragEnd,
  onDragStart,
  onOpen,
  onReopen,
  onRequestRework,
  visual,
}: {
  bug: BugView;
  draggable: boolean;
  dragging: boolean;
  eligibleAt?: string;
  onDragEnd: () => void;
  onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
  onOpen: () => void;
  onReopen: () => void;
  onRequestRework: () => void;
  visual: CookingVisualPresentation;
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
            ['VERIFY_FAIL', 'REOPEN'].includes(action),
          ) ? (
            <div className="collab-bug-card__actions">
              {bug.availableActions.includes('VERIFY_FAIL') ? (
                <button onClick={stopCardAction(onRequestRework)} type="button">
                  不通过并返修
                </button>
              ) : null}
              {bug.availableActions.includes('REOPEN') ? (
                <button onClick={stopCardAction(onReopen)} type="button">
                  重新打开
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </footer>
    </article>
  );
}

export function UpdateCountdown({ eligibleAt }: { eligibleAt: string }) {
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
