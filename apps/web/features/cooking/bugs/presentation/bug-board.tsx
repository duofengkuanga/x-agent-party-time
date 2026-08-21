'use client';

import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { JsonValue } from '@agent-party-time/execution-contract';
import { createClientId } from '@/features/cooking/shared/client-id';
import type {
  BugProgressTimelineNode,
  CookingWorkspaceSnapshot,
} from '@/features/cooking/workspace/contract';
import type {
  CookingInteractionView,
  CookingVisualPresentation,
} from '@/features/cooking/shared/contract';
import {
  archiveBugAction,
  cancelBugAction,
  reopenBugAction,
  restoreBugAction,
  unarchiveBugAction,
  verifyBugAction,
  type BugLifecycleActionResult,
} from '@/features/cooking/lifecycle/presentation/actions';
import type { BugRepairView } from '@/features/cooking/repair/contract';
import {
  resolveRepairInteractionAction,
  synchronizeRepairSessionAction,
  type RepairActionResult,
} from '@/features/cooking/repair/presentation/actions';
import type { UpdateBatchView } from '@/features/cooking/update/contract';
import {
  freezeUpdateNowAction,
  reportExternalDeploymentAction,
  resolveUpdateInteractionAction,
  synchronizeUpdateSessionAction,
  type UpdateActionResult,
} from '@/features/cooking/update/presentation/actions';
import type { BugView } from '../contract';
import {
  assignBugAction,
  createBugAction,
  requestRepairAction,
  updateBugReportAction,
  type BugActionResult,
} from './actions';

const STATUS_COLUMNS = [
  { status: 'WAITING_FOR_REPAIR', label: '待修复', note: '录入' },
  { status: 'REPAIRING', label: '修复中', note: '修复' },
  { status: 'WAITING_FOR_UPDATE', label: '待更新', note: '批次' },
  { status: 'UPDATING', label: '更新中', note: '交付' },
  { status: 'WAITING_FOR_VERIFICATION', label: '待验证', note: '测试' },
  { status: 'DONE', label: '已完成', note: '完成' },
] as const;
const TRANSIENT_NOTICE_MS = 3_000;
const ATTACHMENT_ACCEPT =
  'image/png,image/jpeg,image/webp,text/plain,application/json';
const ATTACHMENT_MEDIA_TYPES = new Set(ATTACHMENT_ACCEPT.split(','));
const IMAGE_ATTACHMENT_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);
const MAX_ATTACHMENT_FILES = 5;

type StoredAttachment = BugView['report']['actualResultAttachments'][number];
type ImagePreview = { name: string; src: string };

type MainStage = (typeof STATUS_COLUMNS)[number]['status'];
type Drawer =
  | { mode: 'create' }
  | { mode: 'view' | 'edit'; bugId: string }
  | { mode: 'batch'; batchId: string };
type WorkspaceActionResult =
  | BugActionResult
  | RepairActionResult
  | UpdateActionResult
  | BugLifecycleActionResult;

type UndoAction = {
  message: string;
  successMessage: string;
  command: () => Promise<WorkspaceActionResult>;
};

type BugFeedbackIntent = {
  bugId: string;
  kind: 'VERIFY_FAIL' | 'REOPEN';
};

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

function BugCard({
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

function BugReworkDialog({
  bug,
  error,
  kind,
  onCancel,
  onSubmit,
  pending,
}: {
  bug: BugView;
  error: string | null;
  kind: BugFeedbackIntent['kind'];
  onCancel: () => void;
  onSubmit: (formData: FormData) => void;
  pending: boolean;
}) {
  const [feedback, setFeedback] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const reopening = kind === 'REOPEN';
  const title = reopening ? '重新打开' : '不通过并返修';
  return (
    <div
      className="collab-dialog-backdrop collab-drawer-scrim"
      role="presentation"
    >
      <form
        aria-label={title}
        aria-modal="true"
        className="collab-dialog collab-bug-rework-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData();
          formData.set('mutationId', createClientId());
          formData.set('expectedVersion', String(bug.version));
          formData.set('feedback', feedback);
          files.forEach((file) => formData.append('attachments', file));
          onSubmit(formData);
        }}
        role="dialog"
      >
        <header>
          <div>
            <small>{reopening ? '完成状态复核' : '验证结果'}</small>
            <h2>{title}</h2>
          </div>
          <button
            aria-label={reopening ? '关闭重新打开表单' : '关闭返修表单'}
            onClick={onCancel}
            type="button"
          >
            ×
          </button>
        </header>
        <div className="collab-dialog__body collab-form collab-bug-rework-dialog__body">
          <p>{bug.report.title}</p>
          <label>
            <span>{reopening ? '重新出现的问题' : '仍然存在的问题'}</span>
            <textarea
              autoFocus
              maxLength={8_000}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder={
                reopening
                  ? '描述问题重新出现的情况，开发将据此继续修复'
                  : '描述复现结果，开发将据此进入下一轮修复'
              }
              rows={4}
              value={feedback}
            />
          </label>
          <AttachmentPicker files={files} onChange={setFiles} />
          {error ? (
            <p className="collab-form__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="collab-dialog__actions">
          <button onClick={onCancel} type="button">
            取消
          </button>
          <button disabled={pending || !feedback.trim()} type="submit">
            {pending ? '提交中…' : reopening ? '确认重新打开' : '确认返修'}
          </button>
        </footer>
      </form>
    </div>
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

function UpdateBatchCard({
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

function BugDrawer({
  drawer,
  onChanged,
  onClose,
  onEdit,
  snapshot,
}: {
  drawer: Drawer;
  onChanged: (revision: number, message: string) => void;
  onClose: () => void;
  onEdit: (bugId: string) => void;
  snapshot: CookingWorkspaceSnapshot;
}) {
  const bug =
    drawer.mode === 'create' || drawer.mode === 'batch'
      ? null
      : (snapshot.bugs.find(({ id }) => id === drawer.bugId) ?? null);
  const batch =
    drawer.mode === 'batch'
      ? (snapshot.updateBatches.find(({ id }) => id === drawer.batchId) ?? null)
      : null;
  const summaryOnly =
    snapshot.submission.submission.testerUserId === snapshot.currentUser.id;
  if (drawer.mode !== 'create' && drawer.mode !== 'batch' && !bug) return null;
  if (drawer.mode === 'batch' && !batch) return null;
  const viewing = drawer.mode === 'view' || drawer.mode === 'batch';
  return (
    <div
      className="collab-dialog-backdrop collab-drawer-scrim"
      role="presentation"
    >
      <section
        aria-label={
          drawer.mode === 'batch'
            ? '统一更新批次详情'
            : drawerTitle(drawer.mode, bug)
        }
        aria-modal="true"
        className="collab-dialog collab-bug-drawer"
        role="dialog"
      >
        <header className={viewing ? 'collab-bug-drawer__chrome' : undefined}>
          {viewing ? (
            <small>
              {drawer.mode === 'batch' ? '统一更新批次详情' : '缺陷详情'}
            </small>
          ) : (
            <div>
              <small>{bug ? bugLabel(bug) : '新缺陷'}</small>
              <h2>{drawerTitle(drawer.mode, bug)}</h2>
            </div>
          )}
          <div className="collab-bug-drawer__chrome-actions">
            <button aria-label="关闭详情抽屉" onClick={onClose} type="button">
              ×
            </button>
          </div>
        </header>
        {drawer.mode === 'batch' ? (
          <UpdateBatchDetails
            batch={batch!}
            onChanged={onChanged}
            summaryOnly={summaryOnly}
          />
        ) : drawer.mode === 'view' ? (
          <BugDetail
            bug={bug!}
            onChanged={onChanged}
            onEdit={
              bug!.availableActions.some((action) =>
                ['EDIT_REPORT', 'ASSIGN'].includes(action),
              )
                ? () => onEdit(bug!.id)
                : null
            }
            snapshot={snapshot}
          />
        ) : (
          <BugForm
            bug={bug}
            onCancel={onClose}
            onChanged={onChanged}
            snapshot={snapshot}
          />
        )}
      </section>
    </div>
  );
}

function BugForm({
  bug,
  onCancel,
  onChanged,
  snapshot,
}: {
  bug: BugView | null;
  onCancel: () => void;
  onChanged: (revision: number, message: string) => void;
  snapshot: CookingWorkspaceSnapshot;
}) {
  const canEditReport = !bug || bug.availableActions.includes('EDIT_REPORT');
  const canAssign = !bug || bug.availableActions.includes('ASSIGN');
  const frontendItems = snapshot.submission.items.filter(
    ({ engineering }) => engineering.type === 'FRONTEND',
  );
  const backendItems = snapshot.submission.items.filter(
    ({ engineering }) => engineering.type === 'BACKEND',
  );
  const [submissionItemId, setSubmissionItemId] = useState(
    bug?.submissionItemId ?? '',
  );
  const [title, setTitle] = useState(bug?.report.title ?? '');
  const [operationPath, setOperationPath] = useState(
    bug?.report.operationPath ?? '',
  );
  const [actualResult, setActualResult] = useState(
    bug?.report.actualResult ?? '',
  );
  const [expectedResult, setExpectedResult] = useState(
    bug?.report.expectedResult ?? '',
  );
  const [keptActualResultAttachmentIds, setKeptActualResultAttachmentIds] =
    useState(bug?.report.actualResultAttachments.map(({ id }) => id) ?? []);
  const [keptExpectedResultAttachmentIds, setKeptExpectedResultAttachmentIds] =
    useState(bug?.report.expectedResultAttachments.map(({ id }) => id) ?? []);
  const [actualResultFiles, setActualResultFiles] = useState<File[]>([]);
  const [expectedResultFiles, setExpectedResultFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  function submit(event: FormEvent) {
    event.preventDefault();
    startSaving(async () => {
      try {
        if (bug && !canEditReport) {
          const result = await assignBugAction(bug.id, {
            mutationId: createClientId(),
            expectedVersion: bug.version,
            submissionItemId: submissionItemId || null,
          });
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          onChanged(result.result.revision, '问题归属已更新。');
          return;
        }
        const formData = new FormData();
        formData.set('mutationId', createClientId());
        if (bug) formData.set('expectedVersion', String(bug.version));
        formData.set('submissionItemId', submissionItemId);
        formData.set('title', title);
        formData.set('operationPath', operationPath);
        formData.set('actualResult', actualResult);
        formData.set('expectedResult', expectedResult);
        for (const fileId of keptActualResultAttachmentIds)
          formData.append('existingActualResultAttachmentIds', fileId);
        for (const fileId of keptExpectedResultAttachmentIds)
          formData.append('existingExpectedResultAttachmentIds', fileId);
        for (const file of actualResultFiles)
          formData.append('actualResultAttachments', file);
        for (const file of expectedResultFiles)
          formData.append('expectedResultAttachments', file);
        const result = bug
          ? await updateBugReportAction(bug.id, formData)
          : await createBugAction(snapshot.submission.submission.id, formData);
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        onChanged(
          result.result.revision,
          bug ? '缺陷已保存。' : '缺陷已登记。',
        );
      } catch (submitError) {
        setError(messageOf(submitError, '无法保存缺陷。'));
      }
    });
  }

  return (
    <>
      <form
        className="collab-dialog__body collab-form collab-bug-drawer__body collab-bug-form"
        id="collab-bug-form"
        onSubmit={submit}
      >
        <fieldset disabled={!canAssign || saving}>
          <legend>问题归属</legend>
          <label>
            <span>具体工程</span>
            <select
              onChange={(event) => setSubmissionItemId(event.target.value)}
              value={submissionItemId}
            >
              <option value="">暂不确定</option>
              {frontendItems.length ? (
                <optgroup label="前端">
                  {frontendItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.engineering.name}（{item.engineering.identifier}）
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {backendItems.length ? (
                <optgroup label="后端">
                  {backendItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.engineering.name}（{item.engineering.identifier}）
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </label>
        </fieldset>
        <fieldset disabled={!canEditReport || saving}>
          <legend>缺陷内容</legend>
          <label>
            <span>标题</span>
            <input
              maxLength={240}
              onChange={(event) => setTitle(event.target.value)}
              required
              value={title}
            />
          </label>
          <div className="collab-form__grid collab-bug-form__grid">
            <fieldset className="collab-bug-result-field">
              <legend>预期结果</legend>
              <label>
                <span>文本说明</span>
                <textarea
                  maxLength={8_000}
                  onChange={(event) => setExpectedResult(event.target.value)}
                  rows={4}
                  value={expectedResult}
                />
              </label>
              <AttachmentPicker
                ariaLabel="预期结果附件"
                existingAttachments={bug?.report.expectedResultAttachments}
                files={expectedResultFiles}
                keptExistingIds={keptExpectedResultAttachmentIds}
                onChange={setExpectedResultFiles}
                onExistingChange={setKeptExpectedResultAttachmentIds}
              />
            </fieldset>
            <fieldset className="collab-bug-result-field">
              <legend>实际结果</legend>
              <label>
                <span>文本说明</span>
                <textarea
                  maxLength={8_000}
                  onChange={(event) => setActualResult(event.target.value)}
                  rows={4}
                  value={actualResult}
                />
              </label>
              <AttachmentPicker
                ariaLabel="实际结果附件"
                existingAttachments={bug?.report.actualResultAttachments}
                files={actualResultFiles}
                keptExistingIds={keptActualResultAttachmentIds}
                onChange={setActualResultFiles}
                onExistingChange={setKeptActualResultAttachmentIds}
              />
            </fieldset>
          </div>
          <label>
            <span>操作路径</span>
            <textarea
              maxLength={8_000}
              onChange={(event) => setOperationPath(event.target.value)}
              rows={3}
              value={operationPath}
            />
          </label>
        </fieldset>
        {error ? (
          <p className="collab-form__error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
      <footer className="collab-dialog__actions collab-bug-drawer__actions">
        <button onClick={onCancel} type="button">
          取消
        </button>
        <button
          disabled={saving || (!canEditReport && !canAssign)}
          form="collab-bug-form"
          type="submit"
        >
          {saving ? '保存中…' : bug ? '保存修改' : '登记缺陷'}
        </button>
      </footer>
    </>
  );
}

function BugDetail({
  bug,
  onChanged,
  onEdit,
  snapshot,
}: {
  bug: BugView;
  onChanged: (revision: number, message: string) => void;
  onEdit: (() => void) | null;
  snapshot: CookingWorkspaceSnapshot;
}) {
  const [detailView, setDetailView] = useState<'repair' | 'update'>('repair');
  const [copied, setCopied] = useState(false);
  const [verificationFeedback, setVerificationFeedback] = useState('');
  const [verificationFiles, setVerificationFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const detailBodyRef = useRef<HTMLDivElement>(null);
  const verificationFileInput = useRef<HTMLInputElement>(null);
  const repair = snapshot.repairByBug[bug.id] ?? null;
  const progress = snapshot.progressByBug[bug.id] ?? [];
  const repairProgress = progress.filter(
    (node) => node.kind !== 'UPDATE_BATCH',
  );
  const updateProgress = progress.filter(
    (node) => node.kind === 'UPDATE_BATCH',
  );
  const visual = snapshot.visualByBug[bug.id]!;
  const submissionItemId = bug.assignment?.submissionItemId ?? null;
  const pendingDelivery = pendingDeliveryFor(bug, snapshot);
  const updateBatch = [...snapshot.updateBatches]
    .reverse()
    .find((candidate) =>
      candidate.entries.some((entry) => entry.bugId === bug.id),
    );
  const summaryOnly =
    snapshot.submission.submission.testerUserId === snapshot.currentUser.id;
  const canResolveInteraction = Boolean(
    repair?.timeline.some(
      (node) =>
        node.kind === 'REPAIR_ATTEMPT' &&
        node.interactions.some(
          (interaction) =>
            interaction.state === 'PENDING' && interaction.canResolve,
        ),
    ) ||
    updateBatch?.timeline.some(
      (node) =>
        node.kind === 'UPDATE_ATTEMPT' &&
        node.interactions.some(
          (interaction) =>
            interaction.state === 'PENDING' && interaction.canResolve,
        ),
    ),
  );
  const needsCurrentUserAction = Boolean(
    canResolveInteraction ||
    repair?.availableActions.includes('SYNC_SESSION') ||
    bug.availableActions.some((action) =>
      ['REQUEST_REPAIR', 'VERIFY_PASS', 'VERIFY_FAIL'].includes(action),
    ),
  );

  function showDetailView(view: 'repair' | 'update') {
    setDetailView(view);
    window.requestAnimationFrame(() => {
      if (!detailBodyRef.current) return;
      detailBodyRef.current
        .querySelector<HTMLElement>(`[data-progress-kind="${view}"]`)
        ?.scrollIntoView({ block: 'start' });
    });
  }

  function run(
    command: () => Promise<WorkspaceActionResult>,
    message: string,
    afterSuccess?: () => void,
  ) {
    startTransition(async () => {
      try {
        const result = await command();
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setError(null);
        afterSuccess?.();
        onChanged(result.result.revision, message);
      } catch (actionError) {
        setError(messageOf(actionError, '操作失败，请稍后重试。'));
      }
    });
  }

  return (
    <div
      className="collab-dialog__body collab-bug-drawer__body"
      data-detail-view={detailView}
      ref={detailBodyRef}
    >
      <header className="collab-bug-detail-hero">
        <div className="collab-bug-detail-hero__title">
          <h2 title={bug.report.title}>{bug.report.title}</h2>
          {onEdit ? (
            <button onClick={onEdit} type="button">
              {bug.availableActions.includes('EDIT_REPORT')
                ? '编辑资料'
                : '调整归属'}
            </button>
          ) : null}
        </div>
        <dl>
          <Detail label="当前状态">
            <span
              aria-label={visual.label}
              className="collab-current-visual"
              data-visual-state={visual.state}
            >
              <span aria-hidden="true">{visual.symbol}</span>
              {visual.label}
            </span>
          </Detail>
          <Detail label="问题归属">
            {bug.assignment
              ? `${bug.assignment.engineeringType === 'FRONTEND' ? '前端' : '后端'} · ${bug.assignment.engineeringName}`
              : '暂未确定'}
          </Detail>
          {bug.assignment ? (
            <Detail label="负责人">
              {bug.assignment.responsibleUser.displayName}
            </Detail>
          ) : null}
          {needsCurrentUserAction ? (
            <Detail label="当前责任">
              <strong>需要你处理</strong>
            </Detail>
          ) : null}
          {bug.report.expectedResult ||
          bug.report.expectedResultAttachments.length ? (
            <Detail label="预期结果">
              <BugResultDetail
                attachments={bug.report.expectedResultAttachments}
                text={bug.report.expectedResult}
              />
            </Detail>
          ) : null}
          {bug.report.actualResult ||
          bug.report.actualResultAttachments.length ? (
            <Detail label="实际结果">
              <BugResultDetail
                attachments={bug.report.actualResultAttachments}
                text={bug.report.actualResult}
              />
            </Detail>
          ) : null}
          {bug.report.operationPath ? (
            <Detail label="操作路径">
              <span
                className="collab-bug-detail-fact"
                title={bug.report.operationPath}
              >
                {bug.report.operationPath}
              </span>
            </Detail>
          ) : null}
          <Detail label="缺陷 ID">
            <span className="collab-bug-id">
              <code>{bug.id}</code>
              <button
                aria-label="复制删除命令"
                onClick={() => {
                  void navigator.clipboard.writeText(
                    `xapt bugs delete ${bug.id}`,
                  );
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1600);
                }}
                type="button"
              >
                {copied ? '已复制' : '复制'}
              </button>
            </span>
          </Detail>
        </dl>
      </header>
      <nav aria-label="缺陷进展视图" className="collab-bug-detail-tabs">
        <button
          aria-current={detailView === 'repair' ? 'page' : undefined}
          onClick={() => showDetailView('repair')}
          type="button"
        >
          修复进展
        </button>
        <button
          aria-current={detailView === 'update' ? 'page' : undefined}
          onClick={() => showDetailView('update')}
          type="button"
        >
          更新进展
        </button>
      </nav>
      <div data-progress-kind="repair">
        {repairProgress.length ? (
          <RepairAttemptDetails
            bug={bug}
            pending={pending}
            repair={repair}
            run={run}
            summaryOnly={summaryOnly}
            timeline={repairProgress}
          />
        ) : (
          <section className="collab-bug-detail-section">
            <h3>修复进展</h3>
            <p className="collab-bug-detail-empty">暂无修复记录</p>
          </section>
        )}
      </div>
      <div data-progress-kind="update">
        {updateBatch ? (
          <UpdateBatchDetails
            batch={updateBatch}
            embedded
            onChanged={onChanged}
            summaryOnly={summaryOnly}
          />
        ) : updateProgress.length ? (
          <RepairAttemptDetails
            bug={bug}
            pending={pending}
            repair={repair}
            run={run}
            summaryOnly={summaryOnly}
            timeline={updateProgress}
          />
        ) : !pendingDelivery ? (
          <section className="collab-bug-detail-section">
            <h3>更新进展</h3>
            <p className="collab-bug-detail-empty">暂无更新记录</p>
          </section>
        ) : null}
      </div>
      {pendingDelivery ? (
        <section
          className="collab-bug-detail-section"
          data-progress-kind="update"
        >
          <h3>待统一更新</h3>
          <p>
            最新候选已记录；静默截止时间：
            {formatDateTime(pendingDelivery.eligibleAt)}
            （<UpdateCountdown eligibleAt={pendingDelivery.eligibleAt} />）
          </p>
        </section>
      ) : null}
      {bug.availableActions.includes('REQUEST_REPAIR') ? (
        <section
          className="collab-bug-detail-section"
          data-progress-kind="repair"
        >
          <h3>修复操作</h3>
          <button
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  requestRepairAction(bug.id, {
                    mutationId: createClientId(),
                    expectedVersion: bug.version,
                  }),
                '缺陷已提交自动修复。',
              )
            }
            type="button"
          >
            开始自动修复
          </button>
        </section>
      ) : null}
      {pendingDelivery?.availableActions.includes('FREEZE_NOW') ? (
        <section
          className="collab-bug-detail-section"
          data-progress-kind="update"
        >
          <h3>更新操作</h3>
          <button
            disabled={pending || !submissionItemId}
            onClick={() =>
              run(
                () =>
                  freezeUpdateNowAction(submissionItemId!, {
                    mutationId: createClientId(),
                  }),
                '当前待更新缺陷已冻结为统一更新批次。',
              )
            }
            type="button"
          >
            立即统一更新
          </button>
        </section>
      ) : null}
      {bug.availableActions.includes('REOPEN') ? (
        <section
          className="collab-bug-detail-section"
          data-progress-kind="repair"
        >
          <h3>重新打开</h3>
          <div className="collab-form collab-bug-verification">
            <textarea
              maxLength={8_000}
              onChange={(event) => setVerificationFeedback(event.target.value)}
              placeholder="描述重新出现的问题"
              rows={3}
              value={verificationFeedback}
            />
            <AttachmentPicker
              files={verificationFiles}
              inputRef={verificationFileInput}
              onChange={setVerificationFiles}
            />
            <button
              disabled={pending || !verificationFeedback.trim()}
              onClick={() => {
                const formData = new FormData();
                formData.set('mutationId', createClientId());
                formData.set('expectedVersion', String(bug.version));
                formData.set('feedback', verificationFeedback);
                verificationFiles.forEach((file) =>
                  formData.append('attachments', file),
                );
                run(
                  () => reopenBugAction(bug.id, formData),
                  '缺陷已重新打开并进入修复。',
                  () => {
                    setVerificationFeedback('');
                    setVerificationFiles([]);
                    if (verificationFileInput.current)
                      verificationFileInput.current.value = '';
                  },
                );
              }}
              type="button"
            >
              重新打开
            </button>
          </div>
        </section>
      ) : null}
      {bug.availableActions.includes('RESTORE') ? (
        <section
          className="collab-bug-detail-section"
          data-progress-kind="repair"
        >
          <h3>恢复缺陷</h3>
          <p>恢复后回到待修复，原始缺陷资料仍可继续编辑。</p>
          <button
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  restoreBugAction(bug.id, {
                    mutationId: createClientId(),
                    expectedVersion: bug.version,
                  }),
                '缺陷已恢复到待修复。',
              )
            }
            type="button"
          >
            恢复到待修复
          </button>
        </section>
      ) : null}
      {bug.availableActions.includes('UNARCHIVE') ? (
        <section
          className="collab-bug-detail-section"
          data-progress-kind="repair"
        >
          <h3>移出归档</h3>
          <p>移出后仍保持已完成，并重新显示在看板中。</p>
          <button
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  unarchiveBugAction(bug.id, {
                    mutationId: createClientId(),
                    expectedVersion: bug.version,
                  }),
                '缺陷已移出归档。',
              )
            }
            type="button"
          >
            移出归档
          </button>
        </section>
      ) : null}
      {error ? (
        <p className="collab-form__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function BugResultDetail({
  attachments,
  text,
}: {
  attachments: StoredAttachment[];
  text?: string;
}) {
  return (
    <div className="collab-bug-result-detail">
      {text ? (
        <span className="collab-bug-detail-fact" title={text}>
          {text}
        </span>
      ) : null}
      {attachments.length ? (
        <ul className="collab-bug-detail-attachments">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <AttachmentLink attachment={attachment} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function RepairAttemptDetails({
  bug,
  pending,
  repair,
  run,
  summaryOnly,
  timeline,
}: {
  bug: BugView;
  pending: boolean;
  repair: BugRepairView | null;
  run: (
    command: () => Promise<WorkspaceActionResult>,
    message: string,
    afterSuccess?: () => void,
  ) => void;
  summaryOnly: boolean;
  timeline: BugProgressTimelineNode[];
}) {
  const latestRepairAttemptId = [...timeline]
    .reverse()
    .find((node) => node.kind === 'REPAIR_ATTEMPT')?.id;
  const isUpdateTimeline = timeline.every(
    (node) => node.kind === 'UPDATE_BATCH',
  );
  return (
    <section
      className="collab-bug-detail-section collab-progress-timeline"
      data-summary-only={summaryOnly ? 'true' : undefined}
    >
      <header>
        <div>
          <h3>{isUpdateTimeline ? '更新进展' : '修复进展'}</h3>
          <p>
            {isUpdateTimeline
              ? '按批次从旧到新记录。'
              : '按修复生命周期从旧到新记录。'}
          </p>
        </div>
      </header>
      <ol className="collab-repair-timeline">
        {timeline.map((node) => (
          <li data-node-kind={node.kind} key={node.id}>
            <span aria-hidden="true" className="collab-repair-timeline__mark" />
            <BugProgressNode
              bug={bug}
              latestRepairAttemptId={latestRepairAttemptId}
              node={node}
              pending={pending}
              repair={repair}
              run={run}
              summaryOnly={summaryOnly}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

function BugProgressNode({
  bug,
  latestRepairAttemptId,
  node,
  pending,
  repair,
  run,
  summaryOnly,
}: {
  bug: BugView;
  latestRepairAttemptId: string | undefined;
  node: BugProgressTimelineNode;
  pending: boolean;
  repair: BugRepairView | null;
  run: (
    command: () => Promise<WorkspaceActionResult>,
    message: string,
    afterSuccess?: () => void,
  ) => void;
  summaryOnly: boolean;
}) {
  if (summaryOnly) return <BugProgressSummaryNode node={node} />;
  if (node.kind === 'BUG_REGISTERED')
    return (
      <article>
        <header>
          <strong>缺陷已登记</strong>
          <time>{formatDateTime(node.occurredAt)}</time>
        </header>
        <p>原始报告已进入待修复阶段。</p>
      </article>
    );
  if (node.kind === 'UPDATE_BATCH')
    return (
      <article>
        <header>
          <strong>已进入统一更新批次</strong>
          <time>{formatDateTime(node.occurredAt)}</time>
        </header>
        <p>
          {node.statusLabel} · 共 {node.bugCount} 条缺陷
        </p>
        <span
          aria-label={node.visual.label}
          className="collab-current-visual collab-progress-visual"
          data-visual-state={node.visual.state}
        >
          <span aria-hidden="true">{node.visual.symbol}</span>
          {node.visual.label}
        </span>
      </article>
    );
  if (node.kind === 'VERIFICATION')
    return (
      <article>
        <header>
          <strong>
            第 {node.round} 轮验证
            {node.result === 'PASSED' ? '已通过' : '未通过'}
          </strong>
          <time>{formatDateTime(node.createdAt)}</time>
        </header>
        {node.comment ? <p>{node.comment}</p> : <p>测试负责人未补充说明。</p>}
        {node.result === 'FAILED' && node.repairAttempt ? (
          <strong>已进入第 {node.repairAttempt} 轮修复</strong>
        ) : null}
        <ProgressAttachments attachments={node.attachments} />
      </article>
    );
  if (node.kind === 'REOPEN')
    return (
      <article>
        <header>
          <strong>第 {node.round} 次重新打开</strong>
          <time>{formatDateTime(node.createdAt)}</time>
        </header>
        <p>{node.feedback}</p>
        <strong>已进入第 {node.repairAttempt} 轮修复</strong>
        <ProgressAttachments attachments={node.attachments} />
      </article>
    );
  if (node.kind === 'CANCELLED' || node.kind === 'RESTORED')
    return (
      <article>
        <header>
          <strong>
            {node.kind === 'CANCELLED' ? '缺陷已取消' : '缺陷已恢复到待修复'}
          </strong>
          <time>{formatDateTime(node.createdAt)}</time>
        </header>
        <p>
          {node.kind === 'CANCELLED'
            ? '缺陷已移出主看板，可从已取消缺陷中恢复。'
            : '原始资料已重新开放编辑，尚未自动开始修复。'}
        </p>
      </article>
    );
  if (node.kind !== 'REPAIR_ATTEMPT') return null;
  return (
    <RepairAttemptTimelineArticle
      bug={bug}
      isLatestRepairAttempt={node.id === latestRepairAttemptId}
      node={node}
      pending={pending}
      repair={repair}
      run={run}
    />
  );
}

function BugProgressSummaryNode({ node }: { node: BugProgressTimelineNode }) {
  let title: string;
  let occurredAt: string;
  if (node.kind === 'BUG_REGISTERED') {
    title = '缺陷已登记';
    occurredAt = node.occurredAt;
  } else if (node.kind === 'REPAIR_ATTEMPT') {
    title = `第 ${node.attempt} 轮修复${
      node.result?.outcome === 'COMPLETED'
        ? '已完成'
        : node.result?.outcome === 'FAILED'
          ? '未完成'
          : '进行中'
    }`;
    occurredAt = node.finishedAt ?? node.startedAt ?? node.queuedAt;
  } else if (node.kind === 'UPDATE_BATCH') {
    title = `统一更新 · ${node.visual.label}`;
    occurredAt = node.occurredAt;
  } else if (node.kind === 'VERIFICATION') {
    title = `第 ${node.round} 轮验证${
      node.result === 'PASSED' ? '已通过' : '未通过，已返修'
    }`;
    occurredAt = node.createdAt;
  } else if (node.kind === 'REOPEN') {
    title = `第 ${node.round} 次重新打开，已返修`;
    occurredAt = node.createdAt;
  } else {
    title = node.kind === 'CANCELLED' ? '缺陷已取消' : '缺陷已恢复到待修复';
    occurredAt = node.createdAt;
  }
  return (
    <article className="collab-progress-summary">
      <header>
        <strong>{title}</strong>
        <time>{formatDateTime(occurredAt)}</time>
      </header>
    </article>
  );
}

function RepairAttemptTimelineArticle({
  bug,
  isLatestRepairAttempt,
  node,
  pending,
  repair,
  run,
}: {
  bug: BugView;
  isLatestRepairAttempt: boolean;
  node: Extract<BugProgressTimelineNode, { kind: 'REPAIR_ATTEMPT' }>;
  pending: boolean;
  repair: BugRepairView | null;
  run: (
    command: () => Promise<WorkspaceActionResult>,
    message: string,
    afterSuccess?: () => void,
  ) => void;
}) {
  return (
    <article>
      <header>
        <strong>
          第 {node.attempt} 轮修复
          {node.result?.outcome === 'COMPLETED'
            ? '已完成'
            : node.result?.outcome === 'FAILED'
              ? '未完成'
              : '进行中'}
        </strong>
        <time>
          {formatDateTime(node.finishedAt ?? node.startedAt ?? node.queuedAt)}
        </time>
      </header>
      <dl className="collab-bug-detail-list collab-session-facts">
        {node.sessionId ? (
          <Detail label="修复会话 ID">{node.sessionId}</Detail>
        ) : null}
        <Detail label="Agent">{node.agentName}</Detail>
      </dl>
      {node.interactions.map((interaction) => (
        <CookingInteractionRecord
          interaction={interaction}
          key={interaction.id}
          onResolve={(resolution) =>
            resolveRepairInteractionAction(interaction.id, {
              mutationId: createClientId(),
              expectedVersion: bug.version,
              resolution,
            })
          }
          pending={pending}
          run={run}
        />
      ))}
      {!node.result ? (
        <dl className="collab-bug-detail-list">
          <Detail label="处理状态">
            {['CLAIMED', 'RUNNING'].includes(node.executionState)
              ? '正在自动处理'
              : repairStateLabel(node.executionState)}
          </Detail>
          <Detail label="开始时间">
            {node.startedAt
              ? formatDateTime(node.startedAt)
              : '等待 Agent 开始'}
          </Detail>
        </dl>
      ) : node.result.outcome === 'COMPLETED' ? (
        <>
          <TimelineList
            emptyLabel="Codex 未报告具体修改"
            items={node.result.changes}
            title="修改内容"
          />
          <div className="collab-repair-validations">
            <h4>检查结果</h4>
            {node.result.validations.length ? (
              <ul>
                {node.result.validations.map((validation) => (
                  <li
                    data-validation-status={validation.status}
                    key={`${validation.name}:${validation.status}`}
                  >
                    <strong>{validationStatusLabel(validation.status)}</strong>
                    <span>{validation.name}</span>
                    {validation.detail ? (
                      <small>{validation.detail}</small>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Codex 未报告检查项</p>
            )}
          </div>
          {node.result.warnings.length ? (
            <TimelineList items={node.result.warnings} title="警告" />
          ) : null}
          <p className="collab-repair-commit-count">
            已记录 {node.result.commitCount} 个候选提交
          </p>
          {node.result.rawSummary || node.result.commits ? (
            <details>
              <summary>技术详情与 Codex 完整结论</summary>
              {node.result.rawSummary ? <p>{node.result.rawSummary}</p> : null}
              {node.result.commits?.length ? (
                <ol>
                  {node.result.commits.map((commit) => (
                    <li key={commit}>
                      <code>{commit}</code>
                    </li>
                  ))}
                </ol>
              ) : null}
            </details>
          ) : null}
        </>
      ) : (
        <>
          <dl className="collab-bug-detail-list">
            <Detail label="失败阶段">{node.result.failedStep}</Detail>
            <Detail label="失败原因">{node.result.reason}</Detail>
          </dl>
          <TimelineList
            emptyLabel="无"
            items={node.result.completedActions}
            title="已完成事项"
          />
          <TimelineList
            emptyLabel="无"
            items={node.result.pendingActions}
            title="未执行事项"
          />
          {node.result.rawSummary || node.result.failureCode ? (
            <details>
              <summary>技术详情与 Codex 完整结论</summary>
              {node.result.rawSummary ? <p>{node.result.rawSummary}</p> : null}
              {node.result.failureCode ? (
                <code>{node.result.failureCode}</code>
              ) : null}
            </details>
          ) : null}
          {isLatestRepairAttempt &&
          repair?.availableActions.includes('SYNC_SESSION') ? (
            <>
              {repair.synchronizationError ? (
                <p>{repair.synchronizationError}</p>
              ) : null}
              <button
                disabled={pending}
                onClick={() =>
                  run(
                    () =>
                      synchronizeRepairSessionAction(bug.id, {
                        mutationId: createClientId(),
                        expectedVersion: bug.version,
                      }),
                    '正在同步原修复会话状态。',
                  )
                }
                type="button"
              >
                同步状态
              </button>
            </>
          ) : null}
        </>
      )}
    </article>
  );
}

function ProgressAttachments({
  attachments,
}: {
  attachments: StoredAttachment[];
}) {
  if (!attachments.length) return null;
  return (
    <ul className="collab-attachments collab-bug-attachments">
      {attachments.map((attachment) => (
        <li key={attachment.id}>
          <AttachmentLink attachment={attachment} />
        </li>
      ))}
    </ul>
  );
}

function TimelineList({
  emptyLabel = '无',
  items,
  title,
}: {
  emptyLabel?: string;
  items: string[];
  title: string;
}) {
  return (
    <div className="collab-repair-result-list">
      <h4>{title}</h4>
      {items.length ? (
        <ul>
          {items.map((item, index) => (
            <li key={`${index}:${item}`}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>{emptyLabel}</p>
      )}
    </div>
  );
}

function validationStatusLabel(
  status: 'PASSED' | 'FAILED' | 'SKIPPED',
): string {
  return {
    PASSED: '通过',
    FAILED: '未通过',
    SKIPPED: '未执行',
  }[status];
}

function UpdateBatchDetails({
  batch,
  embedded = false,
  onChanged,
  summaryOnly = false,
}: {
  batch: UpdateBatchView;
  embedded?: boolean;
  onChanged: (revision: number, message: string) => void;
  summaryOnly?: boolean;
}) {
  const [externalOutcome, setExternalOutcome] = useState<
    'SUCCEEDED' | 'FAILED'
  >('SUCCEEDED');
  const [externalSummary, setExternalSummary] = useState('');
  const [externalFiles, setExternalFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const externalFileInput = useRef<HTMLInputElement>(null);

  function run(
    command: () => Promise<WorkspaceActionResult>,
    message: string,
    afterSuccess?: () => void,
  ) {
    startTransition(async () => {
      try {
        const result = await command();
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setError(null);
        afterSuccess?.();
        onChanged(result.result.revision, message);
      } catch (actionError) {
        setError(messageOf(actionError, '操作失败，请稍后重试。'));
      }
    });
  }

  const batchFacts = (
    <dl>
      <Detail label="批次状态">{batch.presentation.statusLabel}</Detail>
      <Detail label="当前状态">
        <span
          aria-label={batch.presentation.visual.label}
          className="collab-current-visual"
          data-visual-state={batch.presentation.visual.state}
        >
          <span aria-hidden="true">{batch.presentation.visual.symbol}</span>
          {batch.presentation.visual.label}
        </span>
      </Detail>
      <Detail label="目标分支">{batch.targetBranch}</Detail>
      <Detail label="部署方式">{deploymentLabel(batch.deploymentKind)}</Detail>
      <Detail label="环境">{batch.environmentName}</Detail>
      {batch.hasManualDatabaseOperation ? (
        <Detail label="数据库操作">请人工执行代码仓库中的 SQL</Detail>
      ) : null}
    </dl>
  );

  return (
    <div
      className={`collab-update-batch-detail${embedded ? ' collab-update-batch-detail--embedded' : ' collab-dialog__body collab-bug-drawer__body'}`}
    >
      {!embedded && !summaryOnly ? (
        <header className="collab-bug-detail-hero">
          <div>
            <small>共享更新对象</small>
            <h2>{batch.engineeringName} · 统一更新批次</h2>
          </div>
          {batchFacts}
        </header>
      ) : null}
      {error ? (
        <p className="collab-form__error" role="alert">
          {error}
        </p>
      ) : null}
      {!embedded && !summaryOnly ? (
        <section className="collab-bug-detail-section">
          <h3>冻结范围</h3>
          <p>
            {formatDateTime(batch.frozenAt)} 冻结，共 {batch.entries.length}{' '}
            条缺陷。批次完成后会分别回到待验证。
          </p>
          <UpdateBatchEntries batch={batch} embedded={false} />
        </section>
      ) : null}
      <section
        className="collab-bug-detail-section collab-progress-timeline collab-update-batch-progress"
        data-summary-only={summaryOnly ? 'true' : undefined}
      >
        <header>
          <div>
            <h3>{embedded || summaryOnly ? '更新进展' : '批次进展'}</h3>
            <p>
              {embedded || summaryOnly
                ? '按批次从旧到新记录。'
                : `${batch.engineeringName} 的统一更新执行记录。`}
            </p>
          </div>
        </header>
        <ol className="collab-repair-timeline collab-update-timeline">
          {batch.timeline.map((node) => {
            if (summaryOnly)
              return <UpdateProgressSummaryNode key={node.id} node={node} />;
            if (node.kind === 'BATCH_FORMED')
              return (
                <li data-node-kind={node.kind} key={node.id}>
                  <span
                    aria-hidden="true"
                    className="collab-repair-timeline__mark"
                  />
                  <article>
                    <header>
                      <strong>统一更新批次已形成</strong>
                      <time>{formatDateTime(node.occurredAt)}</time>
                    </header>
                    {embedded ? (
                      <>
                        <p>
                          已冻结 {node.bugCount}{' '}
                          条缺陷，更新完成后分别回到待验证。
                        </p>
                        <details className="collab-update-scope">
                          <summary>
                            冻结范围 · {batch.entries.length} 条缺陷
                          </summary>
                          <UpdateBatchEntries batch={batch} embedded />
                        </details>
                      </>
                    ) : (
                      <p>已冻结 {node.bugCount} 条缺陷。</p>
                    )}
                  </article>
                </li>
              );
            if (node.kind === 'EXTERNAL_REPORT')
              return (
                <li data-node-kind={node.kind} key={node.id}>
                  <span
                    aria-hidden="true"
                    className="collab-repair-timeline__mark"
                    data-outcome={node.outcome}
                  />
                  <article>
                    <header>
                      <strong>
                        第 {node.round} 轮外部部署
                        {node.outcome === 'SUCCEEDED' ? '成功' : '失败'}
                      </strong>
                      <time>{formatDateTime(node.occurredAt)}</time>
                    </header>
                    {node.summary ? <p>{node.summary}</p> : null}
                    {node.attachments.length ? (
                      <ul className="collab-attachments collab-bug-attachments">
                        {node.attachments.map((attachment) => (
                          <li key={attachment.id}>
                            <AttachmentLink attachment={attachment} />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </article>
                </li>
              );
            return (
              <li data-node-kind={node.kind} key={node.id}>
                <span
                  aria-hidden="true"
                  className="collab-repair-timeline__mark"
                  data-outcome={node.result?.outcome}
                />
                <article>
                  <header>
                    <strong>{updateAttemptLabel(node)}</strong>
                    <time>{formatDateTime(node.queuedAt)}</time>
                  </header>
                  {node.sessionId ? (
                    <dl className="collab-bug-detail-list collab-session-facts">
                      <Detail label="更新会话 ID">{node.sessionId}</Detail>
                    </dl>
                  ) : null}
                  {node.result?.outcome === 'FAILED' ? (
                    <>
                      <div className="collab-structured-failure">
                        <header>
                          <span>本轮中断</span>
                          <strong>{node.result.failedStep}</strong>
                        </header>
                        <p>
                          <span>失败原因</span>
                          {node.result.reason}
                        </p>
                      </div>
                      <div className="collab-update-attempt-results">
                        <DetailList
                          kind="completed"
                          items={node.result.completedActions}
                          title="已完成操作"
                        />
                        <div
                          className="collab-repair-validations"
                          data-result-kind="validation"
                        >
                          <h4>验证结果</h4>
                          {node.result.validations.length ? (
                            <ul>
                              {node.result.validations.map(
                                (validation, index) => (
                                  <li
                                    data-validation-status={validation.status}
                                    key={`${validation.name}:${index}`}
                                  >
                                    <strong>
                                      {validationLabel(validation.status)}
                                    </strong>
                                    <span>{validation.name}</span>
                                    {validation.detail ? (
                                      <small>{validation.detail}</small>
                                    ) : null}
                                  </li>
                                ),
                              )}
                            </ul>
                          ) : (
                            <p>Codex 未报告验证项</p>
                          )}
                        </div>
                        {node.result.warnings.length ? (
                          <DetailList
                            kind="warning"
                            items={node.result.warnings}
                            title="提醒"
                          />
                        ) : null}
                        <DetailList
                          kind="pending"
                          items={node.result.pendingActions}
                          title="待处理事项"
                        />
                      </div>
                    </>
                  ) : node.result ? (
                    <>
                      <div className="collab-update-attempt-results">
                        <DetailList
                          kind="completed"
                          items={node.result.completedActions}
                          title="已完成操作"
                        />
                        <div
                          className="collab-repair-validations"
                          data-result-kind="validation"
                        >
                          <h4>验证结果</h4>
                          {node.result.validations.length ? (
                            <ul>
                              {node.result.validations.map(
                                (validation, index) => (
                                  <li
                                    data-validation-status={validation.status}
                                    key={`${validation.name}:${index}`}
                                  >
                                    <strong>
                                      {validationLabel(validation.status)}
                                    </strong>
                                    <span>{validation.name}</span>
                                    {validation.detail ? (
                                      <small>{validation.detail}</small>
                                    ) : null}
                                  </li>
                                ),
                              )}
                            </ul>
                          ) : (
                            <p>Codex 未报告验证项</p>
                          )}
                        </div>
                        {node.result.warnings.length ? (
                          <DetailList
                            kind="warning"
                            items={node.result.warnings}
                            title="提醒"
                          />
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <dl className="collab-bug-detail-list">
                      <Detail label="处理状态">
                        {repairStateLabel(node.executionState)}
                      </Detail>
                    </dl>
                  )}
                  {node.interactions.length ? (
                    <ol className="collab-update-interactions">
                      {node.interactions.map((interaction) => (
                        <li key={interaction.id}>
                          <CookingInteractionRecord
                            interaction={interaction}
                            onResolve={(resolution) =>
                              resolveUpdateInteractionAction(interaction.id, {
                                mutationId: createClientId(),
                                expectedVersion: batch.version,
                                resolution,
                              })
                            }
                            pending={pending}
                            run={run}
                          />
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {node.result?.rawSummary ||
                  (node.result?.outcome === 'FAILED' &&
                    node.result.failureCode) ? (
                    <details className="collab-technical-details">
                      <summary>技术详情与 Codex 完整结论</summary>
                      {node.result.rawSummary ? (
                        <p>{node.result.rawSummary}</p>
                      ) : null}
                      {node.result.outcome === 'FAILED' &&
                      node.result.failureCode ? (
                        <code>{node.result.failureCode}</code>
                      ) : null}
                    </details>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ol>
      </section>
      {!summaryOnly && batch.availableActions.length ? (
        <section className="collab-bug-detail-section">
          <h3>批次操作</h3>
          {batch.availableActions.includes('SYNC_SESSION') ? (
            <>
              {batch.synchronizationError ? (
                <p>{batch.synchronizationError}</p>
              ) : null}
              <button
                disabled={pending}
                onClick={() =>
                  run(
                    () =>
                      synchronizeUpdateSessionAction(batch.id, {
                        mutationId: createClientId(),
                        expectedVersion: batch.version,
                      }),
                    '正在同步原统一更新会话状态。',
                  )
                }
                type="button"
              >
                同步状态
              </button>
            </>
          ) : null}
          {batch.availableActions.includes('REPORT_EXTERNAL') ? (
            <div className="collab-form collab-bug-verification">
              <label>
                <span>外部更新结果</span>
                <select
                  onChange={(event) =>
                    setExternalOutcome(
                      event.target.value as 'SUCCEEDED' | 'FAILED',
                    )
                  }
                  value={externalOutcome}
                >
                  <option value="SUCCEEDED">外部更新成功</option>
                  <option value="FAILED">外部更新失败</option>
                </select>
              </label>
              <textarea
                maxLength={8_000}
                onChange={(event) => setExternalSummary(event.target.value)}
                placeholder={
                  externalOutcome === 'FAILED'
                    ? '说明持续集成或部署失败原因'
                    : '可补充外部更新结果'
                }
                rows={3}
                value={externalSummary}
              />
              <AttachmentPicker
                files={externalFiles}
                inputRef={externalFileInput}
                onChange={setExternalFiles}
              />
              <button
                disabled={
                  pending ||
                  (externalOutcome === 'FAILED' && !externalSummary.trim())
                }
                onClick={() => {
                  const formData = new FormData();
                  formData.set('mutationId', createClientId());
                  formData.set('expectedVersion', String(batch.version));
                  formData.set('outcome', externalOutcome);
                  formData.set('summary', externalSummary);
                  externalFiles.forEach((file) =>
                    formData.append('attachments', file),
                  );
                  run(
                    () => reportExternalDeploymentAction(batch.id, formData),
                    externalOutcome === 'SUCCEEDED'
                      ? '外部更新已确认成功，缺陷进入待验证。'
                      : '外部更新失败记录已追加，可重新执行原批次。',
                    () => {
                      setExternalSummary('');
                      setExternalFiles([]);
                      if (externalFileInput.current)
                        externalFileInput.current.value = '';
                    },
                  );
                }}
                type="button"
              >
                提交外部结果
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function UpdateProgressSummaryNode({
  node,
}: {
  node: UpdateBatchView['timeline'][number];
}) {
  const title =
    node.kind === 'BATCH_FORMED'
      ? '统一更新批次已形成'
      : node.kind === 'EXTERNAL_REPORT'
        ? `第 ${node.round} 轮外部部署${node.outcome === 'SUCCEEDED' ? '成功' : '失败'}`
        : updateAttemptLabel(node);
  const occurredAt =
    node.kind === 'UPDATE_ATTEMPT' ? node.queuedAt : node.occurredAt;
  const outcome =
    node.kind === 'EXTERNAL_REPORT'
      ? node.outcome
      : node.kind === 'UPDATE_ATTEMPT'
        ? node.result?.outcome
        : undefined;
  return (
    <li data-node-kind={node.kind}>
      <span
        aria-hidden="true"
        className="collab-repair-timeline__mark"
        data-outcome={outcome}
      />
      <article className="collab-progress-summary">
        <header>
          <strong>{title}</strong>
          <time>{formatDateTime(occurredAt)}</time>
        </header>
      </article>
    </li>
  );
}

function AttachmentPicker({
  ariaLabel = '添加附件',
  existingAttachments = [],
  files,
  inputRef,
  keptExistingIds = [],
  onChange,
  onExistingChange,
}: {
  ariaLabel?: string;
  existingAttachments?: StoredAttachment[];
  files: File[];
  inputRef?: RefObject<HTMLInputElement | null>;
  keptExistingIds?: string[];
  onChange: (files: File[]) => void;
  onExistingChange?: (attachmentIds: string[]) => void;
}) {
  const fallbackInputRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const resolvedInputRef = inputRef ?? fallbackInputRef;
  const activeExisting = existingAttachments.filter((attachment) =>
    keptExistingIds.includes(attachment.id),
  );
  const removedExisting = existingAttachments.filter(
    (attachment) => !keptExistingIds.includes(attachment.id),
  );
  const availableNewFileSlots = Math.max(
    0,
    MAX_ATTACHMENT_FILES - activeExisting.length,
  );

  function addFiles(incoming: File[]) {
    const supported = incoming.filter((file) =>
      ATTACHMENT_MEDIA_TYPES.has(file.type),
    );
    if (incoming.length && !supported.length) {
      setNotice('仅支持 PNG、JPG、WEBP、TXT 和 JSON 文件。');
      return;
    }
    const next = [...files];
    for (const file of supported) {
      if (
        next.some(
          (existing) =>
            existing.name === file.name &&
            existing.size === file.size &&
            existing.type === file.type,
        )
      )
        continue;
      if (next.length === availableNewFileSlots) break;
      next.push(file);
    }
    setNotice(
      supported.length > next.length - files.length ||
        files.length + supported.length > availableNewFileSlots
        ? '最多添加 5 个附件，超出的文件没有加入。'
        : supported.length < incoming.length
          ? '部分文件格式不支持，已加入可用附件。'
          : null,
    );
    onChange(next);
  }

  function pasteFiles(event: ReactClipboardEvent<HTMLDivElement>) {
    const pasted = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!pasted.length) return;
    event.preventDefault();
    addFiles(pasted);
  }

  return (
    <div
      aria-label={ariaLabel}
      className="collab-attachment-picker"
      onPaste={pasteFiles}
      role="group"
      tabIndex={0}
    >
      <input
        accept={ATTACHMENT_ACCEPT}
        aria-hidden="true"
        className="collab-attachment-picker__input"
        multiple
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
        ref={resolvedInputRef}
        tabIndex={-1}
        type="file"
      />
      <div className="collab-attachment-picker__prompt">
        <span>
          <strong>粘贴附件</strong>
          <small>复制截图或文件后，在这里按 ⌘V / Ctrl+V</small>
        </span>
        <button onClick={() => resolvedInputRef.current?.click()} type="button">
          选择本地文件
        </button>
      </div>
      {activeExisting.length || files.length ? (
        <ul className="collab-attachment-picker__files">
          {activeExisting.map((attachment) => (
            <li data-source="existing" key={attachment.id}>
              <AttachmentLink attachment={attachment} />
              <button
                aria-label={`移除附件 ${attachment.originalName}`}
                onClick={() =>
                  onExistingChange?.(
                    keptExistingIds.filter((id) => id !== attachment.id),
                  )
                }
                type="button"
              >
                移除
              </button>
            </li>
          ))}
          {files.map((file, index) => (
            <li
              data-source="new"
              key={`${file.name}:${file.size}:${file.lastModified}:${index}`}
            >
              <PendingAttachmentLink file={file} />
              <button
                aria-label={`移除附件 ${file.name}`}
                onClick={() =>
                  onChange(files.filter((_, fileIndex) => fileIndex !== index))
                }
                type="button"
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <small className="collab-attachment-picker__empty">
          尚未添加附件 · 最多 5 个，单个不超过 10 MB
        </small>
      )}
      {removedExisting.length ? (
        <div className="collab-attachment-picker__removed">
          {removedExisting.map((attachment) => (
            <span key={attachment.id}>
              已移除「{attachment.originalName}」
              <button
                onClick={() => {
                  if (
                    activeExisting.length + files.length >=
                    MAX_ATTACHMENT_FILES
                  ) {
                    setNotice('最多保留 5 个附件，请先移除其他附件。');
                    return;
                  }
                  onExistingChange?.([...keptExistingIds, attachment.id]);
                }}
                type="button"
              >
                撤销
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {notice ? (
        <small className="collab-attachment-picker__notice" role="status">
          {notice}
        </small>
      ) : null}
    </div>
  );
}

function PendingAttachmentLink({ file }: { file: File }) {
  const image = IMAGE_ATTACHMENT_MEDIA_TYPES.has(file.type);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    if (!image) {
      setImageUrl(null);
      return;
    }
    const nextImageUrl = URL.createObjectURL(file);
    setImageUrl(nextImageUrl);
    return () => URL.revokeObjectURL(nextImageUrl);
  }, [file, image]);

  return (
    <>
      <span className="collab-attachment-file">
        {imageUrl ? (
          <button
            aria-label={`查看图片 ${file.name}`}
            className="collab-attachment-file__thumb"
            onClick={() => setPreview(true)}
            type="button"
          >
            <img alt="" src={imageUrl} />
          </button>
        ) : (
          <span aria-hidden="true" className="collab-attachment-file__kind">
            文件
          </span>
        )}
        <span className="collab-attachment-file__meta">
          {imageUrl ? (
            <button
              className="collab-attachment-file__name"
              onClick={() => setPreview(true)}
              title={file.name}
              type="button"
            >
              {file.name}
            </button>
          ) : (
            <strong title={file.name}>{file.name}</strong>
          )}
          <small>{formatBytes(file.size)} · 新添加</small>
        </span>
      </span>
      {preview && imageUrl ? (
        <ImagePreviewDialog
          name={file.name}
          onClose={() => setPreview(false)}
          src={imageUrl}
        />
      ) : null}
    </>
  );
}

function ImagePreviewDialog({
  name,
  onClose,
  src,
}: ImagePreview & { onClose: () => void }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return createPortal(
    <div
      aria-label={`查看图片 ${name}`}
      aria-modal="true"
      className="collab-image-preview"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
    >
      <figure>
        <figcaption>
          <strong title={name}>{name}</strong>
          <span>
            <a download={name} href={src}>
              保存图片
            </a>
            <button onClick={onClose} ref={closeButtonRef} type="button">
              关闭
            </button>
          </span>
        </figcaption>
        <img alt={name} src={src} />
      </figure>
    </div>,
    document.body,
  );
}

function UpdateBatchEntries({
  batch,
  embedded,
}: {
  batch: UpdateBatchView;
  embedded: boolean;
}) {
  return (
    <ol className="collab-repair-records collab-update-scope__entries">
      {batch.entries.map((entry) => (
        <li key={entry.bugId}>
          <strong>
            {embedded ? (
              entry.bugTitle
            ) : (
              <>
                缺陷-{String(entry.bugShortId).padStart(3, '0')} ·{' '}
                {entry.bugTitle}
              </>
            )}
          </strong>
          {entry.commits?.length ? (
            <details>
              <summary>{entry.commits.length} 个候选 Commit</summary>
              <ol className="collab-repair-records">
                {entry.commits.map((commit) => (
                  <li key={commit}>
                    <code>{commit}</code>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function DetailList({
  items,
  kind,
  title,
}: {
  items: string[];
  kind: 'completed' | 'pending' | 'warning';
  title: string;
}) {
  return (
    <section className="collab-update-result-list" data-result-kind={kind}>
      <h4>{title}</h4>
      <ul>
        {items.map((item, index) => (
          <li key={`${item}:${index}`}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function CookingInteractionRecord({
  interaction,
  onResolve,
  pending,
  run,
}: {
  interaction: CookingInteractionView;
  onResolve: (resolution: JsonValue) => Promise<WorkspaceActionResult>;
  pending: boolean;
  run: (
    command: () => Promise<WorkspaceActionResult>,
    message: string,
    afterSuccess?: () => void,
  ) => void;
}) {
  const [answers, setAnswers] = useState<
    Record<string, { selected: string; custom: string }>
  >({});
  const resolved = interaction.state === 'RESOLVED';
  if (!interaction.request)
    return (
      <article
        className="collab-interaction-record"
        data-state={interaction.state}
      >
        <strong>
          {resolved ? '工程负责人已处理 Codex 请求' : '等待工程负责人处理'}
        </strong>
        <p>技术参数仅向对应工程负责人展示。</p>
      </article>
    );
  if (interaction.kind === 'APPROVAL') {
    const request = interaction.request;
    return (
      <article
        className="collab-interaction-record"
        data-state={interaction.state}
      >
        <header>
          <strong>{request.title}</strong>
          <time>{formatDateTime(interaction.createdAt)}</time>
        </header>
        {request.purpose ? <p>{request.purpose}</p> : null}
        <dl className="collab-bug-detail-list">
          {request.command ? (
            <Detail label="命令摘要">
              <code>{request.command}</code>
            </Detail>
          ) : null}
          {request.permissions ? (
            <Detail label="权限摘要">
              <ul className="collab-permission-summary">
                {permissionSummary(request.permissions).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </Detail>
          ) : null}
        </dl>
        {resolved ? (
          <p className="collab-interaction-resolution">
            实际决定：{approvalResolutionLabel(interaction.resolution)}
          </p>
        ) : interaction.canResolve ? (
          <div className="collab-interaction-actions">
            <button
              disabled={pending}
              onClick={() =>
                run(
                  () => onResolve(approvalResolution(request, 'DECLINED')),
                  '已拒绝 Codex 请求。',
                )
              }
              type="button"
            >
              拒绝
            </button>
            <button
              data-primary="true"
              disabled={pending}
              onClick={() =>
                run(
                  () => onResolve(approvalResolution(request, 'ACCEPTED_ONCE')),
                  '已仅允许这一次。',
                )
              }
              type="button"
            >
              仅允许这一次
            </button>
            <button
              aria-describedby={`session-scope-${interaction.id}`}
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    onResolve(
                      approvalResolution(request, 'ACCEPTED_FOR_SESSION'),
                    ),
                  '已允许本次 Codex 会话。',
                )
              }
              type="button"
            >
              本次会话允许
            </button>
            <small id={`session-scope-${interaction.id}`}>
              仅对当前修复或更新会话后续同类请求生效。
            </small>
          </div>
        ) : null}
      </article>
    );
  }
  const answerValues = Object.fromEntries(
    interaction.request.questions.map((question) => {
      const draft = answers[question.id];
      return [
        question.id,
        draft?.selected === '__custom__' || draft?.selected === '__text__'
          ? draft.custom.trim()
          : (draft?.selected.trim() ?? ''),
      ];
    }),
  );
  return (
    <article
      className="collab-interaction-record"
      data-state={interaction.state}
    >
      <header>
        <strong>Codex 请求补充信息</strong>
        <time>{formatDateTime(interaction.createdAt)}</time>
      </header>
      {resolved ? (
        <dl className="collab-bug-detail-list">
          {interaction.request.questions.map((question) => (
            <Detail key={question.id} label={question.header}>
              {interaction.resolution?.answers[question.id]?.join('、') ??
                '未记录回答'}
            </Detail>
          ))}
        </dl>
      ) : interaction.canResolve ? (
        <div className="collab-interaction-questions">
          {interaction.request.questions.map((question) => (
            <fieldset key={question.id}>
              <legend>{question.header}</legend>
              <p>{question.question}</p>
              {question.options.map((option) => (
                <label key={option.value}>
                  <input
                    checked={answers[question.id]?.selected === option.value}
                    name={`question-${interaction.id}-${question.id}`}
                    onChange={() =>
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: {
                          selected: option.value,
                          custom: current[question.id]?.custom ?? '',
                        },
                      }))
                    }
                    type="radio"
                    value={option.value}
                  />
                  <span>{option.label}</span>
                  {option.description ? (
                    <small>{option.description}</small>
                  ) : null}
                </label>
              ))}
              {question.options.length ? (
                <label>
                  <input
                    checked={answers[question.id]?.selected === '__custom__'}
                    name={`question-${interaction.id}-${question.id}`}
                    onChange={() =>
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: {
                          selected: '__custom__',
                          custom: current[question.id]?.custom ?? '',
                        },
                      }))
                    }
                    type="radio"
                    value="__custom__"
                  />
                  <span>自定义回答</span>
                </label>
              ) : null}
              {question.options.length === 0 ||
              answers[question.id]?.selected === '__custom__' ? (
                <textarea
                  aria-label={`${question.header}的回答`}
                  maxLength={4_000}
                  onChange={(event) =>
                    setAnswers((current) => ({
                      ...current,
                      [question.id]: {
                        selected: question.options.length
                          ? '__custom__'
                          : '__text__',
                        custom: event.target.value,
                      },
                    }))
                  }
                  rows={3}
                  value={answers[question.id]?.custom ?? ''}
                />
              ) : null}
            </fieldset>
          ))}
          <button
            disabled={
              pending ||
              Object.values(answerValues).some((answer) => !answer.trim())
            }
            onClick={() =>
              run(
                () =>
                  onResolve({
                    answers: Object.fromEntries(
                      Object.entries(answerValues).map(([id, answer]) => [
                        id,
                        { answers: [answer] },
                      ]),
                    ),
                  }),
                '回答已提交给 Codex。',
                () => setAnswers({}),
              )
            }
            type="button"
          >
            统一提交回答
          </button>
        </div>
      ) : null}
    </article>
  );
}

function Detail({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function AttachmentLink({ attachment }: { attachment: StoredAttachment }) {
  const [preview, setPreview] = useState(false);
  const downloadUrl = `/api/cooking/attachments/${attachment.id}`;
  const imageUrl = `${downloadUrl}?preview=1`;
  const image = IMAGE_ATTACHMENT_MEDIA_TYPES.has(attachment.mediaType);

  return (
    <>
      <span className="collab-attachment-file">
        {image ? (
          <button
            aria-label={`查看图片 ${attachment.originalName}`}
            className="collab-attachment-file__thumb"
            onClick={() => setPreview(true)}
            type="button"
          >
            <img alt="" src={imageUrl} />
          </button>
        ) : (
          <span aria-hidden="true" className="collab-attachment-file__kind">
            文件
          </span>
        )}
        <span className="collab-attachment-file__meta">
          {image ? (
            <button
              className="collab-attachment-file__name"
              onClick={() => setPreview(true)}
              title={attachment.originalName}
              type="button"
            >
              {attachment.originalName}
            </button>
          ) : (
            <a href={downloadUrl} title={attachment.originalName}>
              {attachment.originalName}
            </a>
          )}
          <small>{formatBytes(attachment.sizeBytes)}</small>
        </span>
      </span>
      {preview ? (
        <ImagePreviewDialog
          name={attachment.originalName}
          onClose={() => setPreview(false)}
          src={imageUrl}
        />
      ) : null}
    </>
  );
}

function dragTransition(bug: BugView, target: MainStage) {
  if (
    target === 'REPAIRING' &&
    bug.stage === 'WAITING_FOR_REPAIR' &&
    bug.availableActions.includes('REQUEST_REPAIR')
  )
    return {
      command: () =>
        requestRepairAction(bug.id, {
          mutationId: createClientId(),
          expectedVersion: bug.version,
        }),
      message: `${bugLabel(bug)} 已提交自动修复。`,
    };
  if (
    target === 'DONE' &&
    bug.stage === 'WAITING_FOR_VERIFICATION' &&
    bug.availableActions.includes('VERIFY_PASS')
  )
    return {
      command: () => {
        const formData = new FormData();
        formData.set('mutationId', createClientId());
        formData.set('expectedVersion', String(bug.version));
        formData.set('result', 'PASSED');
        return verifyBugAction(bug.id, formData);
      },
      message: `${bugLabel(bug)} 已验证完成。`,
    };
  return null;
}

function drawerTitle(mode: Drawer['mode'], bug: BugView | null): string {
  if (mode === 'create') return '登记缺陷';
  if (mode === 'edit') return '编辑缺陷';
  if (mode === 'batch') return '统一更新批次详情';
  return bug?.report.title ?? '缺陷详情';
}

function bugLabel(bug: BugView): string {
  return `缺陷-${String(bug.shortId).padStart(3, '0')}`;
}

function pendingDeliveryFor(bug: BugView, snapshot: CookingWorkspaceSnapshot) {
  const submissionItemId = bug.assignment?.submissionItemId;
  return submissionItemId
    ? snapshot.pendingDeliveries.find(
        (candidate) => candidate.submissionItemId === submissionItemId,
      )
    : undefined;
}

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  if (totalSeconds <= 0) return '正在准备统一更新';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} 秒后开始更新`;
  if (seconds === 0) return `${minutes} 分钟后开始更新`;
  return `${minutes} 分 ${seconds} 秒后开始更新`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value));
}

function deploymentLabel(kind: UpdateBatchView['deploymentKind']): string {
  return kind === 'LOCAL_SCRIPT' ? '本地脚本部署' : '持续集成部署';
}

function engineeringTypeLabel(
  engineeringType?: NonNullable<BugView['assignment']>['engineeringType'],
): string {
  if (!engineeringType) return '待分配';
  return engineeringType === 'FRONTEND' ? '前端' : '后端';
}

function updateAttemptLabel(
  attempt: Extract<
    UpdateBatchView['timeline'][number],
    { kind: 'UPDATE_ATTEMPT' }
  >,
): string {
  if (attempt.result?.outcome === 'COMPLETED')
    return `第 ${attempt.attempt} 轮统一更新已完成`;
  if (attempt.result?.outcome === 'PUSHED')
    return `第 ${attempt.attempt} 轮已 Push，等待外部结果`;
  if (attempt.result?.outcome === 'FAILED')
    return `第 ${attempt.attempt} 轮统一更新未完成`;
  return `第 ${attempt.attempt} 轮统一更新进行中`;
}

function validationLabel(status: 'PASSED' | 'FAILED' | 'SKIPPED'): string {
  return {
    PASSED: '通过',
    FAILED: '失败',
    SKIPPED: '跳过',
  }[status];
}

function repairStateLabel(
  state: Extract<
    BugRepairView['timeline'][number],
    { kind: 'REPAIR_ATTEMPT' }
  >['executionState'],
): string {
  return {
    QUEUED: '等待 Agent',
    CLAIMED: '正在准备修复',
    RUNNING: '正在修复',
    WAITING_FOR_INTERACTION: '等待工程负责人处理',
    WAITING_TO_RESUME: '等待继续',
    CANCEL_REQUESTED: '正在停止',
    SUCCEEDED: '修复已完成',
    FAILED: '修复未完成',
    CANCELLED: '修复已停止',
  }[state];
}

type ApprovalRequest = NonNullable<
  Extract<CookingInteractionView, { kind: 'APPROVAL' }>['request']
>;

function approvalResolution(
  request: ApprovalRequest,
  decision: 'DECLINED' | 'ACCEPTED_ONCE' | 'ACCEPTED_FOR_SESSION',
): JsonValue {
  if (request.type === 'PERMISSION')
    return decision === 'DECLINED'
      ? { permissions: {}, scope: 'turn' }
      : {
          permissions: request.permissions ?? {},
          scope: decision === 'ACCEPTED_ONCE' ? 'turn' : 'session',
        };
  return {
    decision:
      decision === 'DECLINED'
        ? 'decline'
        : decision === 'ACCEPTED_ONCE'
          ? 'accept'
          : 'acceptForSession',
  };
}

function approvalResolutionLabel(
  resolution: 'DECLINED' | 'ACCEPTED_ONCE' | 'ACCEPTED_FOR_SESSION' | null,
): string {
  return resolution
    ? {
        DECLINED: '已拒绝',
        ACCEPTED_ONCE: '仅允许这一次',
        ACCEPTED_FOR_SESSION: '本次会话允许',
      }[resolution]
    : '已由工程负责人处理';
}

function permissionSummary(value: JsonValue): string[] {
  const labels: Record<string, string> = {
    fileSystem: '文件系统',
    network: '网络访问',
    hosts: '目标主机',
    root: '作用范围',
    mode: '操作方式',
    enabled: '启用状态',
  };
  const values: Record<string, string> = {
    true: '已启用',
    false: '未启用',
    read: '读取',
    write: '写入',
  };
  const valueLabel = (item: JsonValue): string => {
    if (Array.isArray(item))
      return item.length ? item.map(valueLabel).join('、') : '无';
    if (item && typeof item === 'object')
      return Object.entries(item)
        .map(
          ([key, child]) => `${labels[key] ?? '权限项'} ${valueLabel(child)}`,
        )
        .join('；');
    return values[String(item)] ?? String(item);
  };
  const walk = (item: JsonValue, path: string[]): string[] => {
    if (Array.isArray(item))
      return [`${path.join(' / ')}：${valueLabel(item)}`];
    if (item && typeof item === 'object')
      return Object.entries(item).flatMap(([key, child]) =>
        walk(child, [...path, labels[key] ?? '权限项']),
      );
    return [`${path.join(' / ')}：${values[String(item)] ?? String(item)}`];
  };
  const items = walk(value, []);
  return items.length ? items : ['未提供可展示的权限范围'];
}

function stopCardAction(action: () => void) {
  return (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    action();
  };
}

function bugVersionOf(result: WorkspaceActionResult): number | null {
  return result.ok && 'bugVersion' in result.result
    ? result.result.bugVersion
    : null;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
