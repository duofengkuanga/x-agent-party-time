'use client';
import {
  BugStorageButton,
  StoredBugList,
  type BugStorageKind,
} from './bug-storage';
import { useWorkspaceMutation } from './use-workspace-mutation';

import {
  archiveBugAction,
  archiveLinkedBugsAction,
  cancelBugAction,
  reopenBugAction,
  reviewLinkedBugsAction,
  restoreBugAction,
  unarchiveBugAction,
  unarchiveLinkedBugsAction,
  verifyBugAction,
} from '@/cooking/lifecycle/server/actions';
import { createClientId } from '@/cooking/shared/ui/client-id';
import type { CookingWorkspaceSnapshot } from '@/cooking/workspace/contract';
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
} from 'react';
import type { BugView } from '../contract';
import type { BugFormDraft, BugOwnershipDraft } from './bug-form-draft';
import type {
  BugFeedbackIntent,
  Drawer,
  MainStage,
  UndoAction,
} from './board-model';

import {
  STATUS_COLUMNS,
  TRANSIENT_NOTICE_MS,
  bugLabel,
  bugVersionOf,
  dragTransition,
  pendingDeliveryFor,
  verificationPassTransition,
} from './board-model';

import { BugCard, LinkedReviewCard, UpdateBatchCard } from './bug-card';
import {
  linkedReviewBlockedReason,
  linkedReviewPairFor,
  type LinkedReviewPair,
} from './linked-review-model';

import { BugDrawer } from './bug-drawer';
import { BugReworkDialog } from './bug-editor';
import {
  BoardColumnDivider,
  useBoardColumnWidths,
} from './board-column-resize';

const STORAGE_TRANSITIONS = {
  cancelled: {
    apply: cancelBugAction,
    undo: restoreBugAction,
    message: '已取消。',
    undoMessage: '已恢复到待修复。',
  },
  archived: {
    apply: archiveBugAction,
    undo: unarchiveBugAction,
    message: '已归档。',
    undoMessage: '已移出归档。',
  },
} as const;

export function BugBoard({
  onChanged,
  snapshot,
  syncLabel,
}: {
  onChanged: (revision: number, message: string | null) => void;
  snapshot: CookingWorkspaceSnapshot;
  syncLabel: string;
}) {
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const reportDrafts = useRef(new Map<string, BugFormDraft>());
  const registeredOwnership = useRef<BugOwnershipDraft | null>(null);
  const reportDraftKey = drawer?.mode === 'edit' ? drawer.bugId : 'create';
  const saveReportDraft = useCallback(
    (draft: BugFormDraft) => {
      reportDrafts.current.set(reportDraftKey, draft);
    },
    [reportDraftKey],
  );
  const [storage, setStorage] = useState<BugStorageKind | null>(null);
  const [feedbackIntent, setFeedbackIntent] =
    useState<BugFeedbackIntent | null>(null);
  const [draggingBugId, setDraggingBugId] = useState<string | null>(null);
  const draggingBugIdRef = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<MainStage | null>(null);
  const [cancelDropActive, setCancelDropActive] = useState(false);
  const [archiveDropActive, setArchiveDropActive] = useState(false);
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null);
  const { error, setError, pending, run } = useWorkspaceMutation(onChanged);
  const columnResize = useBoardColumnWidths();
  const testerView =
    snapshot.currentUser.id === snapshot.submission.submission.testerUserId;
  const activeBugs = snapshot.bugs.filter(
    ({ stage, archivedAt }) => stage !== 'CANCELLED' && !archivedAt,
  );
  const linkedReviewPairs = testerView
    ? activeBugs.flatMap((bug) => {
        const pair = linkedReviewPairFor(bug, snapshot.bugs);
        return pair?.ready && pair.primary.id === bug.id ? [pair] : [];
      })
    : [];
  const groupedBugIds = new Set(
    linkedReviewPairs.flatMap(({ frontend, backend }) => [
      frontend.id,
      backend.id,
    ]),
  );
  const cancelledBugs = snapshot.bugs.filter(
    ({ stage }) => stage === 'CANCELLED',
  );
  const archivedBugs = snapshot.bugs.filter(({ archivedAt }) => archivedAt);
  const feedbackBug =
    snapshot.bugs.find(({ id }) => id === feedbackIntent?.bugId) ?? null;
  const feedbackPair = feedbackBug
    ? linkedReviewPairFor(feedbackBug, snapshot.bugs)
    : null;
  const draggingBug = snapshot.bugs.find(({ id }) => id === draggingBugId);

  useEffect(() => {
    if (!undoAction) return;
    const timeout = window.setTimeout(
      () => setUndoAction(null),
      TRANSIENT_NOTICE_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [undoAction]);

  function draggedBugFrom(event: ReactDragEvent<HTMLElement>) {
    const bugId =
      event.dataTransfer.getData('application/x-cooking-bug-id') ||
      draggingBugIdRef.current ||
      draggingBugId;
    return snapshot.bugs.find(({ id }) => id === bugId);
  }

  function clearDraggingBug() {
    draggingBugIdRef.current = null;
    setDraggingBugId(null);
    setDropTarget(null);
    setCancelDropActive(false);
    setArchiveDropActive(false);
  }

  function storeBug(bug: BugView, kind: BugStorageKind) {
    const transition = STORAGE_TRANSITIONS[kind];
    const message = `${bugLabel(bug)} ${transition.message}`;
    run(
      () =>
        transition.apply(bug.id, {
          mutationId: createClientId(),
          expectedVersion: bug.version,
        }),
      message,
      (result) => {
        const version = bugVersionOf(result);
        if (!version) return;
        setUndoAction({
          message,
          successMessage: `${bugLabel(bug)} ${transition.undoMessage}`,
          command: () =>
            transition.undo(bug.id, {
              mutationId: createClientId(),
              expectedVersion: version,
            }),
        });
      },
      null,
    );
  }

  function archiveLinkedPair(pair: LinkedReviewPair) {
    const related =
      pair.frontend.id === pair.primary.id ? pair.backend : pair.frontend;
    const message = '前后端关联缺陷已归档。';
    run(
      () =>
        archiveLinkedBugsAction(pair.primary.id, {
          mutationId: createClientId(),
          expectedVersion: pair.primary.version,
          relatedExpectedVersion: related.version,
        }),
      message,
      (result) => {
        if (!result.ok || !('bugVersions' in result.result)) return;
        const [expectedVersion, relatedExpectedVersion] =
          result.result.bugVersions;
        setUndoAction({
          message,
          successMessage: '前后端关联缺陷已移出归档。',
          command: () =>
            unarchiveLinkedBugsAction(pair.primary.id, {
              mutationId: createClientId(),
              expectedVersion: expectedVersion!,
              relatedExpectedVersion: relatedExpectedVersion!,
            }),
        });
      },
      null,
    );
  }

  function dropBug(event: ReactDragEvent<HTMLElement>, stage: MainStage) {
    const bug = draggedBugFrom(event);
    if (!bug) return;
    const transition = dragTransition(bug, stage);
    if (!transition) return;
    event.preventDefault();
    clearDraggingBug();
    if (stage === 'DONE') {
      setDrawer({ mode: 'view', bugId: bug.id });
      return;
    }
    run(transition.command, transition.message);
  }

  return (
    <section className="collab-board-section">
      <div className="collab-section-label collab-board-heading">
        <BugStorageButton
          kind="cancelled"
          count={cancelledBugs.length}
          draggingBug={draggingBug}
          active={cancelDropActive}
          setActive={setCancelDropActive}
          draggedBugFrom={draggedBugFrom}
          clearDraggingBug={clearDraggingBug}
          onOpen={() => setStorage('cancelled')}
          onStore={(bug) => storeBug(bug, 'cancelled')}
        />
        <span>{snapshot.submission.submission.title} · 缺陷看板</span>
        <div className="collab-board-heading__actions">
          <small>{syncLabel}</small>
          {snapshot.availableActions.includes('CREATE_BUG') ? (
            <button
              disabled={pending}
              onClick={() => setDrawer({ mode: 'create' })}
              type="button"
            >
              ＋ 登记缺陷
            </button>
          ) : null}
          <BugStorageButton
            kind="archived"
            count={archivedBugs.length}
            draggingBug={draggingBug}
            active={archiveDropActive}
            setActive={setArchiveDropActive}
            draggedBugFrom={draggedBugFrom}
            clearDraggingBug={clearDraggingBug}
            onOpen={() => setStorage('archived')}
            onStore={(bug) => storeBug(bug, 'archived')}
          />
        </div>
      </div>
      {error ? (
        <div className="collab-banner collab-banner--error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)} type="button">
            ×
          </button>
        </div>
      ) : null}
      {undoAction ? (
        <div className="collab-banner" role="status">
          <span>{undoAction.message}</span>
          <button
            disabled={pending}
            onClick={() =>
              run(undoAction.command, undoAction.successMessage, () =>
                setUndoAction(null),
              )
            }
            type="button"
          >
            撤销
          </button>
        </div>
      ) : null}
      <div
        className="collab-board"
        ref={columnResize.boardRef}
        style={{ '--board-columns': columnResize.template } as CSSProperties}
      >
        {STATUS_COLUMNS.map((column, index) => {
          const bugs = activeBugs.filter(
            ({ id, stage }) =>
              stage === column.status && !groupedBugIds.has(id),
          );
          const reviewPairs = linkedReviewPairs.filter(
            ({ column: reviewColumn }) => reviewColumn === column.status,
          );
          const showBatches = column.status === 'UPDATING' && !testerView;
          const batches = showBatches
            ? snapshot.updateBatches.filter(
                (batch) =>
                  ['READY', 'RUNNING', 'WAITING_EXTERNAL', 'FAILED'].includes(
                    batch.state,
                  ) &&
                  batch.entries.some((entry) =>
                    bugs.some((bug) => bug.id === entry.bugId),
                  ),
              )
            : [];
          const acceptsDrop = Boolean(
            draggingBug && dragTransition(draggingBug, column.status),
          );
          return (
            <Fragment key={column.status}>
              <section
                className="collab-column"
                data-drop-target={
                  acceptsDrop && dropTarget === column.status
                    ? 'true'
                    : undefined
                }
                onDragEnter={() => {
                  if (acceptsDrop) setDropTarget(column.status);
                }}
                onDragLeave={(event) => {
                  if (
                    event.relatedTarget instanceof Node &&
                    event.currentTarget.contains(event.relatedTarget)
                  )
                    return;
                  if (dropTarget === column.status) setDropTarget(null);
                }}
                onDragOver={(event) => {
                  if (!acceptsDrop) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(event) => dropBug(event, column.status)}
              >
                <header>
                  <span>{column.note}</span>
                  <h2>{column.label}</h2>
                  <b>
                    {showBatches
                      ? batches.length.toString().padStart(2, '0')
                      : (bugs.length + reviewPairs.length)
                          .toString()
                          .padStart(2, '0')}
                  </b>
                </header>
                <div className="collab-column__cards">
                  {showBatches
                    ? batches.map((batch) => {
                        const engineeringType = snapshot.bugs.find(
                          ({ id }) => id === batch.entries[0]?.bugId,
                        )?.assignment?.engineeringType;
                        return (
                          <UpdateBatchCard
                            batch={batch}
                            engineeringType={engineeringType}
                            key={batch.id}
                            onOpen={() =>
                              setDrawer({ mode: 'batch', batchId: batch.id })
                            }
                          />
                        );
                      })
                    : bugs.map((bug) => {
                        const pair = testerView
                          ? linkedReviewPairFor(bug, snapshot.bugs)
                          : null;
                        const blockedReason = linkedReviewBlockedReason(
                          bug,
                          pair,
                        );
                        const draggable = Boolean(
                          (!pair &&
                            (dragTransition(bug, 'REPAIRING') ||
                              dragTransition(bug, 'DONE'))) ||
                          bug.availableActions.includes('CANCEL') ||
                          bug.availableActions.includes('ARCHIVE'),
                        );
                        const visual = snapshot.visualByBug[bug.id]!;
                        const pendingDelivery = pendingDeliveryFor(
                          bug,
                          snapshot,
                        );
                        return (
                          <BugCard
                            bug={bug}
                            blockedReason={blockedReason}
                            draggable={!pending && draggable}
                            dragging={draggingBugId === bug.id}
                            eligibleAt={pendingDelivery?.eligibleAt}
                            key={bug.id}
                            pending={pending}
                            onArchive={() => storeBug(bug, 'archived')}
                            onVerifyPass={() => {
                              if (blockedReason) {
                                setError(blockedReason);
                                return;
                              }
                              const transition =
                                verificationPassTransition(bug);
                              if (transition)
                                run(transition.command, transition.message);
                            }}
                            onDragEnd={() => {
                              clearDraggingBug();
                            }}
                            onDragStart={(event) => {
                              const dragPreview =
                                document.createElement('span');
                              dragPreview.className = 'collab-bug-drag-preview';
                              dragPreview.setAttribute('aria-hidden', 'true');
                              dragPreview.textContent = '✊';
                              document.body.append(dragPreview);
                              event.dataTransfer.setDragImage(
                                dragPreview,
                                14,
                                14,
                              );
                              window.requestAnimationFrame(() =>
                                dragPreview.remove(),
                              );
                              draggingBugIdRef.current = bug.id;
                              setDraggingBugId(bug.id);
                              event.dataTransfer.effectAllowed = 'move';
                              event.dataTransfer.setData(
                                'application/x-cooking-bug-id',
                                bug.id,
                              );
                            }}
                            onOpen={() => {
                              setError(null);
                              setDrawer({ mode: 'view', bugId: bug.id });
                            }}
                            onReopen={() => {
                              if (blockedReason) {
                                setError(blockedReason);
                                return;
                              }
                              setError(null);
                              setFeedbackIntent({
                                bugId: bug.id,
                                kind: 'REOPEN',
                              });
                            }}
                            onRequestRework={() => {
                              if (blockedReason) {
                                setError(blockedReason);
                                return;
                              }
                              setError(null);
                              setFeedbackIntent({
                                bugId: bug.id,
                                kind: 'VERIFY_FAIL',
                              });
                            }}
                            visual={visual}
                          />
                        );
                      })}
                  {reviewPairs.map((pair) => (
                    <LinkedReviewCard
                      backend={pair.backend}
                      frontend={pair.frontend}
                      key={pair.primary.id}
                      pending={pending}
                      onArchive={() => archiveLinkedPair(pair)}
                      onOpen={() => {
                        setError(null);
                        setDrawer({ mode: 'view', bugId: pair.primary.id });
                      }}
                      onVerifyPass={() => {
                        const other =
                          pair.frontend.id === pair.primary.id
                            ? pair.backend
                            : pair.frontend;
                        const formData = new FormData();
                        formData.set('mutationId', createClientId());
                        formData.set(
                          'expectedVersion',
                          String(pair.primary.version),
                        );
                        formData.set(
                          'relatedExpectedVersion',
                          String(other.version),
                        );
                        formData.set('decision', 'PASSED');
                        run(
                          () =>
                            reviewLinkedBugsAction(pair.primary.id, formData),
                          '前后端关联缺陷已完成本次验收。',
                        );
                      }}
                      onIssue={() => {
                        setError(null);
                        setFeedbackIntent({
                          bugId: pair.primary.id,
                          kind:
                            pair.column === 'DONE' ? 'REOPEN' : 'VERIFY_FAIL',
                        });
                      }}
                    />
                  ))}
                  {(showBatches
                    ? batches.length
                    : bugs.length + reviewPairs.length) === 0 ? (
                    <p className="collab-column__empty">暂无卡片</p>
                  ) : null}
                </div>
              </section>
              {index < STATUS_COLUMNS.length - 1 ? (
                <BoardColumnDivider
                  index={index}
                  leftLabel={column.label}
                  rightLabel={STATUS_COLUMNS[index + 1]!.label}
                  resize={columnResize}
                />
              ) : null}
            </Fragment>
          );
        })}
      </div>

      {storage ? (
        <StoredBugList
          kind={storage}
          bugs={storage === 'cancelled' ? cancelledBugs : archivedBugs}
          onClose={() => setStorage(null)}
          onOpen={(bugId) => setDrawer({ mode: 'view', bugId })}
        />
      ) : null}
      {drawer ? (
        <BugDrawer
          drawer={drawer}
          error={error}
          pending={pending}
          run={run}
          savedDraft={reportDrafts.current.get(reportDraftKey) ?? null}
          preferredOwnership={registeredOwnership.current}
          onDraftChange={saveReportDraft}
          onClearError={() => setError(null)}
          onOpenBatch={(batchId) => {
            setError(null);
            setDrawer({ mode: 'batch', batchId });
          }}
          onChanged={(revision, message, registration) => {
            if (drawer.mode === 'create' || drawer.mode === 'edit')
              reportDrafts.current.delete(reportDraftKey);
            if (registration)
              registeredOwnership.current = registration.ownership;
            setDrawer(
              drawer.mode === 'create'
                ? null
                : drawer.mode === 'edit'
                  ? { mode: 'view', bugId: drawer.bugId }
                  : drawer,
            );
            onChanged(revision, message);
          }}
          onClose={() => setDrawer(null)}
          onEdit={(bugId) => setDrawer({ mode: 'edit', bugId })}
          onOpen={(bugId) => {
            setError(null);
            setDrawer({ mode: 'view', bugId });
          }}
          snapshot={snapshot}
        />
      ) : null}
      {feedbackBug && feedbackIntent ? (
        <BugReworkDialog
          bug={feedbackBug}
          pair={feedbackPair}
          error={error}
          kind={feedbackIntent.kind}
          onCancel={() => {
            setError(null);
            setFeedbackIntent(null);
          }}
          onSubmit={(formData) => {
            if (feedbackIntent.kind === 'VERIFY_FAIL')
              formData.set('result', 'FAILED');
            run(
              () =>
                feedbackPair?.ready
                  ? reviewLinkedBugsAction(feedbackBug.id, formData)
                  : feedbackIntent.kind === 'VERIFY_FAIL'
                    ? verifyBugAction(feedbackBug.id, formData)
                    : reopenBugAction(feedbackBug.id, formData),
              feedbackPair?.ready
                ? '已按所选归属提交返修，未选中的待验证缺陷继续等待。'
                : `${bugLabel(feedbackBug)} 已带反馈重新进入修复。`,
              () => setFeedbackIntent(null),
            );
          }}
          pending={pending}
        />
      ) : null}
    </section>
  );
}
