'use client';

import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type DragEvent as ReactDragEvent,
} from 'react';
import { createClientId } from '@/cooking/shared/ui/client-id';
import type { CookingWorkspaceSnapshot } from '@/cooking/workspace/contract';
import {
  archiveBugAction,
  cancelBugAction,
  reopenBugAction,
  restoreBugAction,
  unarchiveBugAction,
  verifyBugAction,
} from '@/cooking/lifecycle/server/actions';
import type { BugView } from '../contract';
import type {
  Drawer,
  BugFeedbackIntent,
  MainStage,
  UndoAction,
  WorkspaceActionResult,
} from './board-model';

import {
  TRANSIENT_NOTICE_MS,
  messageOf,
  bugLabel,
  bugVersionOf,
  dragTransition,
  STATUS_COLUMNS,
  pendingDeliveryFor,
  formatDateTime,
} from './board-model';

import { UpdateBatchCard, BugCard } from './bug-card';

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
  const [showCancelled, setShowCancelled] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [feedbackIntent, setFeedbackIntent] =
    useState<BugFeedbackIntent | null>(null);
  const [draggingBugId, setDraggingBugId] = useState<string | null>(null);
  const draggingBugIdRef = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<MainStage | null>(null);
  const [cancelDropActive, setCancelDropActive] = useState(false);
  const [archiveDropActive, setArchiveDropActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null);
  const [pending, startTransition] = useTransition();
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
  const cancelDropEligible =
    draggingBug?.availableActions.includes('CANCEL') ?? false;
  const archiveDropEligible =
    draggingBug?.availableActions.includes('ARCHIVE') ?? false;

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

  function run(
    command: () => Promise<WorkspaceActionResult>,
    message: string,
    onSuccess?: (result: WorkspaceActionResult) => void,
    noticeMessage: string | null = message,
  ): void {
    startTransition(async () => {
      try {
        const result = await command();
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setError(null);
        onSuccess?.(result);
        onChanged(result.result.revision, noticeMessage);
      } catch (actionError) {
        setError(messageOf(actionError, '操作失败，请稍后重试。'));
      }
    });
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

  function dropIntoCancelled(event: ReactDragEvent<HTMLElement>) {
    const bug = draggedBugFrom(event);
    if (!bug?.availableActions.includes('CANCEL')) return;
    event.preventDefault();
    clearDraggingBug();
    cancelBug(bug);
  }

  function dropIntoArchive(event: ReactDragEvent<HTMLElement>) {
    const bug = draggedBugFrom(event);
    if (!bug?.availableActions.includes('ARCHIVE')) return;
    event.preventDefault();
    clearDraggingBug();
    archiveBug(bug);
  }

  return (
    <section className="collab-board-section">
      <div className="collab-section-label collab-board-heading">
        <button
          aria-label={
            cancelDropEligible && draggingBug
              ? `拖到这里取消 ${bugLabel(draggingBug)}，当前共 ${cancelledBugs.length} 条已取消缺陷`
              : `查看已取消缺陷，共 ${cancelledBugs.length} 条`
          }
          className={`collab-storage-button collab-storage-button--icon collab-storage-button--cancelled${cancelDropEligible ? ' is-active' : ''}`}
          data-drop-eligible={cancelDropEligible ? 'true' : undefined}
          data-drop-target={cancelDropActive ? 'true' : undefined}
          onClick={() => setShowCancelled(true)}
          onDragEnter={(event) => {
            if (draggedBugFrom(event)?.availableActions.includes('CANCEL'))
              setCancelDropActive(true);
          }}
          onDragLeave={() => setCancelDropActive(false)}
          onDragOver={(event) => {
            if (!draggedBugFrom(event)?.availableActions.includes('CANCEL'))
              return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setCancelDropActive(true);
          }}
          onDrop={dropIntoCancelled}
          title="已取消缺陷"
          type="button"
        >
          <span aria-hidden="true" className="collab-storage-button__glyph">
            🗑
          </span>
          <span
            aria-hidden="true"
            className="collab-storage-button__drop-label"
          >
            {cancelDropActive ? '🖐 松开即可取消' : '拖到这里取消'}
          </span>
          {cancelledBugs.length ? (
            <sup aria-hidden="true">{cancelledBugs.length}</sup>
          ) : null}
        </button>
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
          <button
            aria-label={
              archiveDropEligible && draggingBug
                ? `拖到这里归档 ${bugLabel(draggingBug)}，当前共 ${archivedBugs.length} 条归档缺陷`
                : `查看归档缺陷，共 ${archivedBugs.length} 条`
            }
            className={`collab-storage-button collab-storage-button--icon collab-storage-button--archived${archiveDropEligible ? ' is-active' : ''}`}
            data-drop-eligible={archiveDropEligible ? 'true' : undefined}
            data-drop-target={archiveDropActive ? 'true' : undefined}
            onClick={() => setShowArchive(true)}
            onDragEnter={(event) => {
              if (draggedBugFrom(event)?.availableActions.includes('ARCHIVE'))
                setArchiveDropActive(true);
            }}
            onDragLeave={() => setArchiveDropActive(false)}
            onDragOver={(event) => {
              if (!draggedBugFrom(event)?.availableActions.includes('ARCHIVE'))
                return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setArchiveDropActive(true);
            }}
            onDrop={dropIntoArchive}
            title="归档缺陷"
            type="button"
          >
            <span aria-hidden="true" className="collab-storage-button__glyph">
              🗄
            </span>
            <span
              aria-hidden="true"
              className="collab-storage-button__drop-label"
            >
              {archiveDropActive ? '🖐 松开即可归档' : '拖到这里归档'}
            </span>
            {archivedBugs.length ? (
              <sup aria-hidden="true">{archivedBugs.length}</sup>
            ) : null}
          </button>
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

      {showCancelled ? (
        <div
          className="collab-dialog-backdrop collab-drawer-scrim"
          role="presentation"
        >
          <section
            aria-label="已取消缺陷"
            aria-modal="true"
            className="collab-dialog collab-bug-drawer"
            role="dialog"
          >
            <header>
              <div>
                <h2>已取消缺陷</h2>
              </div>
              <button
                aria-label="关闭已取消缺陷列表"
                onClick={() => setShowCancelled(false)}
                type="button"
              >
                ×
              </button>
            </header>
            <div className="collab-dialog__body collab-bug-drawer__body">
              {cancelledBugs.length ? (
                <ul className="collab-stored-bug-list">
                  {cancelledBugs.map((bug) => (
                    <li key={bug.id}>
                      <button
                        onClick={() => {
                          setShowCancelled(false);
                          setDrawer({ mode: 'view', bugId: bug.id });
                        }}
                        type="button"
                      >
                        <strong>
                          {bugLabel(bug)} · {bug.report.title}
                        </strong>
                        <small>
                          {bug.presentation.assignmentLabel} · 已取消
                        </small>
                        <small>{formatDateTime(bug.updatedAt)}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="collab-bug-detail-empty">暂无已取消缺陷</p>
              )}
            </div>
          </section>
        </div>
      ) : null}
      {showArchive ? (
        <div
          className="collab-dialog-backdrop collab-drawer-scrim"
          role="presentation"
        >
          <section
            aria-label="归档缺陷"
            aria-modal="true"
            className="collab-dialog collab-bug-drawer"
            role="dialog"
          >
            <header>
              <div>
                <small>完成整理</small>
                <h2>归档缺陷</h2>
              </div>
              <button
                aria-label="关闭归档缺陷列表"
                onClick={() => setShowArchive(false)}
                type="button"
              >
                ×
              </button>
            </header>
            <div className="collab-dialog__body collab-bug-drawer__body">
              {archivedBugs.length ? (
                <ul className="collab-stored-bug-list">
                  {archivedBugs.map((bug) => (
                    <li key={bug.id}>
                      <button
                        onClick={() => {
                          setShowArchive(false);
                          setDrawer({ mode: 'view', bugId: bug.id });
                        }}
                        type="button"
                      >
                        <strong>
                          {bugLabel(bug)} · {bug.report.title}
                        </strong>
                        <small>
                          {bug.presentation.assignmentLabel} · 已归档
                        </small>
                        <small>
                          {formatDateTime(bug.archivedAt ?? bug.updatedAt)}
                        </small>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="collab-bug-detail-empty">暂无归档缺陷</p>
              )}
            </div>
          </section>
        </div>
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
