'use client';
import {
  BugStorageButton,
  StoredBugList,
  type BugStorageKind,
} from './bug-storage';
import { useWorkspaceMutation } from './use-workspace-mutation';

import {
  archiveBugAction,
  cancelBugAction,
  reopenBugAction,
  restoreBugAction,
  unarchiveBugAction,
  verifyBugAction,
} from '@/cooking/lifecycle/server/actions';
import { createClientId } from '@/cooking/shared/ui/client-id';
import type { CookingWorkspaceSnapshot } from '@/cooking/workspace/contract';
import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from 'react';
import type { BugView } from '../contract';
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
} from './board-model';

import { BugCard, UpdateBatchCard } from './bug-card';

import { BugDrawer } from './bug-drawer';
import { BugReworkDialog } from './bug-editor';

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
  const activeBugs = snapshot.bugs.filter(
    ({ stage, archivedAt }) => stage !== 'CANCELLED' && !archivedAt,
  );
  const cancelledBugs = snapshot.bugs.filter(
    ({ stage }) => stage === 'CANCELLED',
  );
  const archivedBugs = snapshot.bugs.filter(({ archivedAt }) => archivedAt);
  const feedbackBug =
    snapshot.bugs.find(({ id }) => id === feedbackIntent?.bugId) ?? null;
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

  function cancelBug(bug: BugView) {
    run(
      () =>
        cancelBugAction(bug.id, {
          mutationId: createClientId(),
          expectedVersion: bug.version,
        }),
      `${bugLabel(bug)} 已取消。`,
      (result) => {
        const version = bugVersionOf(result);
        if (!version) return;
        setUndoAction({
          message: `${bugLabel(bug)} 已取消。`,
          successMessage: `${bugLabel(bug)} 已恢复到待修复。`,
          command: () =>
            restoreBugAction(bug.id, {
              mutationId: createClientId(),
              expectedVersion: version,
            }),
        });
      },
      null,
    );
  }

  function archiveBug(bug: BugView) {
    run(
      () =>
        archiveBugAction(bug.id, {
          mutationId: createClientId(),
          expectedVersion: bug.version,
        }),
      `${bugLabel(bug)} 已归档。`,
      (result) => {
        const version = bugVersionOf(result);
        if (!version) return;
        setUndoAction({
          message: `${bugLabel(bug)} 已归档。`,
          successMessage: `${bugLabel(bug)} 已移出归档。`,
          command: () =>
            unarchiveBugAction(bug.id, {
              mutationId: createClientId(),
              expectedVersion: version,
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
          onStore={cancelBug}
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
            onStore={archiveBug}
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
      <div className="collab-board">
        {STATUS_COLUMNS.map((column) => {
          const bugs = activeBugs.filter(
            ({ stage }) => stage === column.status,
          );
          const batches =
            column.status === 'UPDATING'
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
            <section
              className="collab-column"
              data-drop-target={
                acceptsDrop && dropTarget === column.status ? 'true' : undefined
              }
              key={column.status}
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
                  {column.status === 'UPDATING'
                    ? batches.length.toString().padStart(2, '0')
                    : bugs.length.toString().padStart(2, '0')}
                </b>
              </header>
              <div className="collab-column__cards">
                {column.status === 'UPDATING'
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
                      const draggable = Boolean(
                        dragTransition(bug, 'REPAIRING') ||
                        dragTransition(bug, 'DONE') ||
                        bug.availableActions.includes('CANCEL') ||
                        bug.availableActions.includes('ARCHIVE'),
                      );
                      const visual = snapshot.visualByBug[bug.id]!;
                      const pendingDelivery = pendingDeliveryFor(bug, snapshot);
                      return (
                        <BugCard
                          bug={bug}
                          draggable={!pending && draggable}
                          dragging={draggingBugId === bug.id}
                          eligibleAt={pendingDelivery?.eligibleAt}
                          key={bug.id}
                          onDragEnd={() => {
                            clearDraggingBug();
                          }}
                          onDragStart={(event) => {
                            const dragPreview = document.createElement('span');
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
                          onOpen={() =>
                            setDrawer({ mode: 'view', bugId: bug.id })
                          }
                          onReopen={() => {
                            setError(null);
                            setFeedbackIntent({
                              bugId: bug.id,
                              kind: 'REOPEN',
                            });
                          }}
                          onRequestRework={() => {
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
                {(column.status === 'UPDATING'
                  ? batches.length
                  : bugs.length) === 0 ? (
                  <p className="collab-column__empty">暂无卡片</p>
                ) : null}
              </div>
            </section>
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
          onChanged={(revision, message) => {
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
          snapshot={snapshot}
        />
      ) : null}
      {feedbackBug && feedbackIntent ? (
        <BugReworkDialog
          bug={feedbackBug}
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
                feedbackIntent.kind === 'VERIFY_FAIL'
                  ? verifyBugAction(feedbackBug.id, formData)
                  : reopenBugAction(feedbackBug.id, formData),
              `${bugLabel(feedbackBug)} 已带反馈重新进入修复。`,
              () => setFeedbackIntent(null),
            );
          }}
          pending={pending}
        />
      ) : null}
    </section>
  );
}
