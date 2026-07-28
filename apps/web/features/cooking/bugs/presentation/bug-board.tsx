'use client';

import {
  useRef,
  useState,
  useTransition,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import type { JsonValue } from '@agent-party-time/execution-contract';
import type { CookingWorkspaceSnapshot } from '@/features/cooking/workspace/contract';
import {
  cancelBugAction,
  reopenBugAction,
  retryCleanupAction,
  verifyBugAction,
  type BugLifecycleActionResult,
  type CleanupActionResult,
} from '@/features/cooking/lifecycle/presentation/actions';
import type {
  BugRepairView,
  RepairInteractionView,
} from '@/features/cooking/repair/contract';
import {
  continueRepairAction,
  resolveRepairInteractionAction,
  stopRepairExecutionAction,
  type RepairActionResult,
} from '@/features/cooking/repair/presentation/actions';
import type {
  UpdateBatchView,
  UpdateInteractionView,
} from '@/features/cooking/update/contract';
import {
  cancelUpdateBatchAction,
  continueUpdateAction,
  freezeUpdateNowAction,
  reportExternalDeploymentAction,
  resolveUpdateInteractionAction,
  stopUpdateExecutionAction,
  type UpdateActionResult,
} from '@/features/cooking/update/presentation/actions';
import type { BugView } from '../contract';
import {
  addBugFeedbackAction,
  assignBugAction,
  createBugAction,
  reorderRepairQueueAction,
  requestRepairAction,
  updateBugReportAction,
  withdrawRepairAction,
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

type MainStage = (typeof STATUS_COLUMNS)[number]['status'];
type Drawer = { mode: 'create' } | { mode: 'view' | 'edit'; bugId: string };
type WorkspaceActionResult =
  | BugActionResult
  | RepairActionResult
  | UpdateActionResult
  | BugLifecycleActionResult
  | CleanupActionResult;

export function BugBoard({
  onChanged,
  snapshot,
  syncLabel,
}: {
  onChanged: (revision: number, message: string) => void;
  snapshot: CookingWorkspaceSnapshot;
  syncLabel: string;
}) {
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [draggingBugId, setDraggingBugId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<MainStage | null>(null);
  const [trashDropActive, setTrashDropActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const activeBugs = snapshot.bugs.filter(({ stage }) => stage !== 'CANCELLED');
  const cancelledBugs = snapshot.bugs.filter(
    ({ stage }) => stage === 'CANCELLED',
  );
  const draggingBug = snapshot.bugs.find(({ id }) => id === draggingBugId);

  function run(
    command: () => Promise<WorkspaceActionResult>,
    message: string,
    onSuccess?: () => void,
  ): void {
    startTransition(async () => {
      try {
        const result = await command();
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setError(null);
        onSuccess?.();
        onChanged(result.result.revision, message);
      } catch (actionError) {
        setError(messageOf(actionError, '操作失败，请稍后重试。'));
      }
    });
  }

  function dropBug(event: ReactDragEvent<HTMLElement>, stage: MainStage) {
    const bugId =
      event.dataTransfer.getData('application/x-cooking-bug-id') ||
      draggingBugId;
    const bug = snapshot.bugs.find(({ id }) => id === bugId);
    if (!bug) return;
    const transition = dragTransition(bug, stage);
    if (!transition) return;
    event.preventDefault();
    setDraggingBugId(null);
    setDropTarget(null);
    setTrashDropActive(false);
    run(transition.command, transition.message);
  }

  function dropIntoTrash(event: ReactDragEvent<HTMLElement>) {
    const bugId =
      event.dataTransfer.getData('application/x-cooking-bug-id') ||
      draggingBugId;
    const bug = snapshot.bugs.find(({ id }) => id === bugId);
    if (!bug?.availableActions.includes('CANCEL')) return;
    event.preventDefault();
    setDraggingBugId(null);
    setDropTarget(null);
    setTrashDropActive(false);
    run(
      () =>
        cancelBugAction(bug.id, {
          mutationId: crypto.randomUUID(),
          expectedVersion: bug.version,
        }),
      `${bugLabel(bug)} 已移入垃圾桶。`,
    );
  }

  return (
    <section className="collab-board-section">
      <div className="collab-section-label collab-board-heading">
        <span>{snapshot.submission.submission.title} · 缺陷看板</span>
        <div className="collab-board-heading__actions">
          <small>{syncLabel}</small>
          <button
            aria-label="查看全局修复队列"
            onClick={() => setQueueOpen(true)}
            type="button"
          >
            队列 {snapshot.repairQueue.entries.length}
          </button>
          <button
            aria-label="查看已取消 Bug"
            className="collab-trash-button"
            data-drop-target={trashDropActive ? 'true' : undefined}
            onClick={() => setShowTrash(true)}
            onDragEnter={() => {
              if (draggingBug?.availableActions.includes('CANCEL'))
                setTrashDropActive(true);
            }}
            onDragLeave={() => setTrashDropActive(false)}
            onDragOver={(event) => {
              if (!draggingBug?.availableActions.includes('CANCEL')) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }}
            onDrop={dropIntoTrash}
            type="button"
          >
            🗑 {cancelledBugs.length}
          </button>
          {snapshot.availableActions.includes('CREATE_BUG') ? (
            <button
              disabled={pending}
              onClick={() => setDrawer({ mode: 'create' })}
              type="button"
            >
              ＋ 登记缺陷
            </button>
          ) : null}
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
      <div className="collab-board">
        {STATUS_COLUMNS.map((column) => {
          const bugs = activeBugs.filter(
            ({ stage }) => stage === column.status,
          );
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
                <b>{bugs.length.toString().padStart(2, '0')}</b>
              </header>
              <div className="collab-column__cards">
                {bugs.map((bug) => {
                  const draggable = Boolean(
                    dragTransition(bug, 'WAITING_FOR_REPAIR') ||
                    dragTransition(bug, 'REPAIRING') ||
                    bug.availableActions.includes('CANCEL'),
                  );
                  return (
                    <BugCard
                      bug={bug}
                      draggable={!pending && draggable}
                      dragging={draggingBugId === bug.id}
                      key={bug.id}
                      onDragEnd={() => {
                        setDraggingBugId(null);
                        setDropTarget(null);
                        setTrashDropActive(false);
                      }}
                      onDragStart={(event) => {
                        setDraggingBugId(bug.id);
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData(
                          'application/x-cooking-bug-id',
                          bug.id,
                        );
                      }}
                      onOpen={() => setDrawer({ mode: 'view', bugId: bug.id })}
                    />
                  );
                })}
                {bugs.length === 0 ? (
                  <p className="collab-column__empty">暂无卡片</p>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>

      {showTrash ? (
        <div
          className="collab-dialog-backdrop collab-drawer-scrim"
          role="presentation"
        >
          <section
            aria-label="已取消 Bug"
            aria-modal="true"
            className="collab-dialog collab-bug-drawer"
            role="dialog"
          >
            <header>
              <div>
                <small>垃圾桶</small>
                <h2>已取消 Bug</h2>
              </div>
              <button
                aria-label="关闭已取消 Bug 列表"
                onClick={() => setShowTrash(false)}
                type="button"
              >
                ×
              </button>
            </header>
            <div className="collab-dialog__body collab-bug-drawer__body">
              {cancelledBugs.length ? (
                <ul className="collab-trash-list">
                  {cancelledBugs.map((bug) => (
                    <li key={bug.id}>
                      <button
                        onClick={() => {
                          setShowTrash(false);
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
                <p className="collab-bug-detail-empty">垃圾桶为空</p>
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
                : { mode: 'view', bugId: drawer.bugId },
            );
            onChanged(revision, message);
          }}
          onClose={() => setDrawer(null)}
          onEdit={(bugId) => setDrawer({ mode: 'edit', bugId })}
          snapshot={snapshot}
        />
      ) : null}
      {queueOpen ? (
        <RepairQueueDrawer
          onChanged={onChanged}
          onClose={() => setQueueOpen(false)}
          snapshot={snapshot}
        />
      ) : null}
    </section>
  );
}

function BugCard({
  bug,
  draggable,
  dragging,
  onDragEnd,
  onDragStart,
  onOpen,
}: {
  bug: BugView;
  draggable: boolean;
  dragging: boolean;
  onDragEnd: () => void;
  onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
  onOpen: () => void;
}) {
  return (
    <article
      aria-label={`${bugLabel(bug)}，${bug.presentation.stageLabel}`}
      className={`collab-bug-card${draggable ? ' collab-bug-card--draggable' : ''}`}
      data-dragging={dragging ? 'true' : undefined}
      data-visual-state={bug.stage === 'REPAIRING' ? 'queued' : 'default'}
      draggable={draggable}
      onClick={onOpen}
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <span aria-hidden="true" className="collab-bug-card__state" />
      <small>
        {bugLabel(bug)} · {bug.presentation.assignmentLabel}
      </small>
      <h3>{bug.report.title}</h3>
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
    drawer.mode === 'create'
      ? null
      : (snapshot.bugs.find(({ id }) => id === drawer.bugId) ?? null);
  if (drawer.mode !== 'create' && !bug) return null;
  return (
    <div
      className="collab-dialog-backdrop collab-drawer-scrim"
      role="presentation"
    >
      <section
        aria-label={drawerTitle(drawer.mode, bug)}
        aria-modal="true"
        className="collab-dialog collab-bug-drawer"
        role="dialog"
      >
        <header>
          <div>
            <small>{bug ? bugLabel(bug) : '新缺陷'}</small>
            <h2>{drawerTitle(drawer.mode, bug)}</h2>
          </div>
          <button aria-label="关闭缺陷抽屉" onClick={onClose} type="button">
            ×
          </button>
        </header>
        {drawer.mode === 'view' ? (
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
  const [notes, setNotes] = useState(bug?.report.notes ?? '');
  const [keptAttachmentIds, setKeptAttachmentIds] = useState(
    bug?.report.attachments.map(({ id }) => id) ?? [],
  );
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  function submit(event: FormEvent) {
    event.preventDefault();
    startSaving(async () => {
      try {
        if (bug && !canEditReport) {
          const result = await assignBugAction(bug.id, {
            mutationId: crypto.randomUUID(),
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
        formData.set('mutationId', crypto.randomUUID());
        if (bug) formData.set('expectedVersion', String(bug.version));
        formData.set('submissionItemId', submissionItemId);
        formData.set('title', title);
        formData.set('operationPath', operationPath);
        formData.set('actualResult', actualResult);
        formData.set('expectedResult', expectedResult);
        formData.set('notes', notes);
        for (const fileId of keptAttachmentIds)
          formData.append('existingAttachmentIds', fileId);
        for (const file of files) formData.append('attachments', file);
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
    <form
      className="collab-dialog__body collab-form collab-bug-drawer__body collab-bug-form"
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
            {snapshot.submission.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.engineering.name}
              </option>
            ))}
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
        <label>
          <span>操作路径</span>
          <textarea
            maxLength={8_000}
            onChange={(event) => setOperationPath(event.target.value)}
            rows={3}
            value={operationPath}
          />
        </label>
        <div className="collab-form__grid collab-bug-form__grid">
          <label>
            <span>实际结果</span>
            <textarea
              maxLength={8_000}
              onChange={(event) => setActualResult(event.target.value)}
              rows={4}
              value={actualResult}
            />
          </label>
          <label>
            <span>预期结果</span>
            <textarea
              maxLength={8_000}
              onChange={(event) => setExpectedResult(event.target.value)}
              rows={4}
              value={expectedResult}
            />
          </label>
        </div>
        <label>
          <span>补充说明</span>
          <textarea
            maxLength={8_000}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            value={notes}
          />
        </label>
        {bug?.report.attachments.length ? (
          <ul className="collab-attachments collab-bug-attachments">
            {bug.report.attachments.map((attachment) => {
              const kept = keptAttachmentIds.includes(attachment.id);
              return (
                <li
                  data-removed={kept ? undefined : 'true'}
                  key={attachment.id}
                >
                  <AttachmentLink attachment={attachment} />
                  <small>{formatBytes(attachment.sizeBytes)}</small>
                  <button
                    onClick={() =>
                      setKeptAttachmentIds((current) =>
                        kept
                          ? current.filter((id) => id !== attachment.id)
                          : [...current, attachment.id],
                      )
                    }
                    type="button"
                  >
                    {kept ? '移除' : '保留'}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        <label>
          <span>添加附件</span>
          <input
            accept="image/png,image/jpeg,image/webp,text/plain,application/json"
            multiple
            onChange={(event) =>
              setFiles(Array.from(event.target.files ?? []).slice(0, 5))
            }
            type="file"
          />
        </label>
      </fieldset>
      {error ? (
        <p className="collab-form__error" role="alert">
          {error}
        </p>
      ) : null}
      <footer className="collab-dialog__actions collab-bug-drawer__actions">
        <button onClick={onCancel} type="button">
          取消
        </button>
        <button disabled={saving || (!canEditReport && !canAssign)}>
          {saving ? '保存中…' : bug ? '保存修改' : '登记缺陷'}
        </button>
      </footer>
    </form>
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
  const [feedback, setFeedback] = useState('');
  const [continueContent, setContinueContent] = useState('');
  const [updateContinueContent, setUpdateContinueContent] = useState('');
  const [externalOutcome, setExternalOutcome] = useState<
    'SUCCEEDED' | 'FAILED'
  >('SUCCEEDED');
  const [externalSummary, setExternalSummary] = useState('');
  const [externalFiles, setExternalFiles] = useState<File[]>([]);
  const [verificationComment, setVerificationComment] = useState('');
  const [verificationFeedback, setVerificationFeedback] = useState('');
  const [verificationFiles, setVerificationFiles] = useState<File[]>([]);
  const [feedbackFiles, setFeedbackFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const feedbackFileInput = useRef<HTMLInputElement>(null);
  const externalFileInput = useRef<HTMLInputElement>(null);
  const verificationFileInput = useRef<HTMLInputElement>(null);
  const repair = snapshot.repairByBug[bug.id] ?? null;
  const interaction = snapshot.pendingInteractions.find(
    (candidate) => candidate.bugId === bug.id,
  );
  const submissionItemId = bug.assignment?.submissionItemId ?? null;
  const pendingDelivery = submissionItemId
    ? snapshot.pendingDeliveries.find(
        (candidate) => candidate.submissionItemId === submissionItemId,
      )
    : undefined;
  const updateBatch = [...snapshot.updateBatches]
    .reverse()
    .find((candidate) =>
      candidate.entries.some((entry) => entry.bugId === bug.id),
    );
  const updateInteraction = updateBatch
    ? snapshot.updateInteractions.find(
        (candidate) => candidate.batchId === updateBatch.id,
      )
    : undefined;
  const verifications = snapshot.verificationsByBug[bug.id] ?? [];
  const cleanup = snapshot.cleanups.find(
    (candidate) =>
      candidate.reason === 'BUG_CANCELLED' && candidate.subjectId === bug.id,
  );

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
    <div className="collab-dialog__body collab-bug-drawer__body">
      {interaction ? (
        <RepairInteractionPanel
          bug={bug}
          interaction={interaction}
          pending={pending}
          run={run}
        />
      ) : null}
      {updateBatch && updateInteraction ? (
        <UpdateInteractionPanel
          batch={updateBatch}
          interaction={updateInteraction}
          pending={pending}
          run={run}
        />
      ) : null}
      <section className="collab-bug-detail-section">
        <header>
          <h3>缺陷信息</h3>
          {onEdit ? (
            <button onClick={onEdit} type="button">
              {bug.availableActions.includes('EDIT_REPORT')
                ? '编辑缺陷'
                : '修改问题归属'}
            </button>
          ) : null}
        </header>
        <dl className="collab-bug-detail-list">
          <Detail label="问题归属">{bug.presentation.assignmentLabel}</Detail>
          <Detail label="当前状态">{bug.presentation.stageLabel}</Detail>
          <Detail label="标题">{bug.report.title}</Detail>
          {bug.report.operationPath ? (
            <Detail label="操作路径">{bug.report.operationPath}</Detail>
          ) : null}
          {bug.report.actualResult ? (
            <Detail label="实际结果">{bug.report.actualResult}</Detail>
          ) : null}
          {bug.report.expectedResult ? (
            <Detail label="预期结果">{bug.report.expectedResult}</Detail>
          ) : null}
          {bug.report.notes ? (
            <Detail label="补充说明">{bug.report.notes}</Detail>
          ) : null}
        </dl>
      </section>
      <section className="collab-bug-detail-section">
        <h3>附件</h3>
        {bug.report.attachments.length ? (
          <ul className="collab-attachments collab-bug-attachments">
            {bug.report.attachments.map((attachment) => (
              <li key={attachment.id}>
                <AttachmentLink attachment={attachment} />
                <small>{formatBytes(attachment.sizeBytes)}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="collab-bug-detail-empty">没有附件</p>
        )}
      </section>
      {repair ? <RepairAttemptDetails repair={repair} /> : null}
      {pendingDelivery ? (
        <section className="collab-bug-detail-section">
          <h3>待统一更新</h3>
          <p>
            最新候选已记录；静默截止时间：
            {formatDateTime(pendingDelivery.eligibleAt)}
          </p>
        </section>
      ) : null}
      {updateBatch ? <UpdateBatchDetails batch={updateBatch} /> : null}
      {bug.feedback.length ? (
        <section className="collab-bug-detail-section">
          <h3>反馈记录</h3>
          <ol className="collab-repair-records">
            {[...bug.feedback].reverse().map((entry) => (
              <li key={entry.id}>
                <header>
                  <strong>
                    {entry.kind === 'TESTER_FEEDBACK'
                      ? '测试反馈'
                      : entry.kind === 'DEVELOPER_NOTE'
                        ? '开发补充'
                        : '执行失败'}
                  </strong>
                  <time>{formatDateTime(entry.createdAt)}</time>
                </header>
                <p>{entry.content}</p>
                {entry.attachments.length ? (
                  <ul className="collab-attachments collab-bug-attachments">
                    {entry.attachments.map((attachment) => (
                      <li key={attachment.id}>
                        <AttachmentLink attachment={attachment} />
                        <small>{formatBytes(attachment.sizeBytes)}</small>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {verifications.length ? (
        <section className="collab-bug-detail-section">
          <h3>验证记录</h3>
          <ol className="collab-repair-records">
            {[...verifications].reverse().map((verification) => (
              <li key={verification.id}>
                <header>
                  <strong>
                    第 {verification.round} 轮 ·{' '}
                    {verification.result === 'PASSED'
                      ? '验证通过'
                      : '验证失败并返修'}
                  </strong>
                  <time>{formatDateTime(verification.createdAt)}</time>
                </header>
                {verification.comment ? <p>{verification.comment}</p> : null}
                {verification.attachments.length ? (
                  <ul className="collab-attachments collab-bug-attachments">
                    {verification.attachments.map((attachment) => (
                      <li key={attachment.id}>
                        <AttachmentLink attachment={attachment} />
                        <small>{formatBytes(attachment.sizeBytes)}</small>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {bug.availableActions.some((action) =>
        ['REQUEST_REPAIR', 'WITHDRAW_REPAIR'].includes(action),
      ) ||
      repair?.availableActions.includes('STOP_EXECUTION') ||
      repair?.availableActions.includes('CONTINUE_REPAIR') ||
      pendingDelivery?.availableActions.includes('FREEZE_NOW') ||
      updateBatch?.availableActions.length ? (
        <section className="collab-bug-detail-section">
          <h3>修复与更新操作</h3>
          {bug.availableActions.includes('REQUEST_REPAIR') ? (
            <button
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    requestRepairAction(bug.id, {
                      mutationId: crypto.randomUUID(),
                      expectedVersion: bug.version,
                    }),
                  '缺陷已加入全局修复队列。',
                )
              }
              type="button"
            >
              加入修复队列
            </button>
          ) : null}
          {bug.availableActions.includes('WITHDRAW_REPAIR') ? (
            <button
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    withdrawRepairAction(bug.id, {
                      mutationId: crypto.randomUUID(),
                      expectedVersion: bug.version,
                    }),
                  '缺陷已撤回待修复。',
                )
              }
              type="button"
            >
              撤回修复
            </button>
          ) : null}
          {repair?.availableActions.includes('STOP_EXECUTION') ? (
            <button
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    stopRepairExecutionAction(bug.id, {
                      mutationId: crypto.randomUUID(),
                      expectedVersion: bug.version,
                    }),
                  '已请求停止当前修复；Bug 仍保留在修复中。',
                )
              }
              type="button"
            >
              停止当前修复
            </button>
          ) : null}
          {repair?.availableActions.includes('CONTINUE_REPAIR') ? (
            <div className="collab-form collab-bug-verification">
              <textarea
                maxLength={8_000}
                onChange={(event) => setContinueContent(event.target.value)}
                placeholder="补充信息并在原修复会话中继续"
                rows={3}
                value={continueContent}
              />
              <button
                disabled={pending || !continueContent.trim()}
                onClick={() =>
                  run(
                    () =>
                      continueRepairAction(bug.id, {
                        mutationId: crypto.randomUUID(),
                        expectedVersion: bug.version,
                        content: continueContent,
                      }),
                    '补充信息已提交，正在原会话中继续修复。',
                    () => setContinueContent(''),
                  )
                }
                type="button"
              >
                继续修复
              </button>
            </div>
          ) : null}
          {pendingDelivery?.availableActions.includes('FREEZE_NOW') ? (
            <button
              disabled={pending || !submissionItemId}
              onClick={() =>
                run(
                  () =>
                    freezeUpdateNowAction(submissionItemId!, {
                      mutationId: crypto.randomUUID(),
                    }),
                  '当前待更新缺陷已冻结为统一更新批次。',
                )
              }
              type="button"
            >
              立即统一更新
            </button>
          ) : null}
          {updateBatch?.availableActions.includes('CANCEL_BATCH') ? (
            <button
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    cancelUpdateBatchAction(updateBatch.id, {
                      mutationId: crypto.randomUUID(),
                      expectedVersion: updateBatch.version,
                    }),
                  '更新批次已取消，候选提交回到待更新。',
                )
              }
              type="button"
            >
              取消更新批次
            </button>
          ) : null}
          {updateBatch?.availableActions.includes('STOP_EXECUTION') ? (
            <button
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    stopUpdateExecutionAction(updateBatch.id, {
                      mutationId: crypto.randomUUID(),
                      expectedVersion: updateBatch.version,
                    }),
                  '已请求停止当前统一更新。',
                )
              }
              type="button"
            >
              停止统一更新
            </button>
          ) : null}
          {updateBatch?.availableActions.includes('CONTINUE_UPDATE') ? (
            <div className="collab-form collab-bug-verification">
              <textarea
                maxLength={8_000}
                onChange={(event) =>
                  setUpdateContinueContent(event.target.value)
                }
                placeholder="补充信息并继续原更新批次"
                rows={3}
                value={updateContinueContent}
              />
              <button
                disabled={pending || !updateContinueContent.trim()}
                onClick={() =>
                  run(
                    () =>
                      continueUpdateAction(updateBatch.id, {
                        mutationId: crypto.randomUUID(),
                        expectedVersion: updateBatch.version,
                        content: updateContinueContent,
                      }),
                    '补充信息已提交，正在原更新会话中继续。',
                    () => setUpdateContinueContent(''),
                  )
                }
                type="button"
              >
                继续统一更新
              </button>
            </div>
          ) : null}
          {updateBatch?.availableActions.includes('REPORT_EXTERNAL') ? (
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
              <input
                accept="image/png,image/jpeg,image/webp,text/plain,application/json"
                multiple
                onChange={(event) =>
                  setExternalFiles(
                    Array.from(event.target.files ?? []).slice(0, 5),
                  )
                }
                ref={externalFileInput}
                type="file"
              />
              <button
                disabled={
                  pending ||
                  (externalOutcome === 'FAILED' && !externalSummary.trim())
                }
                onClick={() => {
                  const formData = new FormData();
                  formData.set('mutationId', crypto.randomUUID());
                  formData.set('expectedVersion', String(updateBatch.version));
                  formData.set('outcome', externalOutcome);
                  formData.set('summary', externalSummary);
                  externalFiles.forEach((file) =>
                    formData.append('attachments', file),
                  );
                  run(
                    () =>
                      reportExternalDeploymentAction(updateBatch.id, formData),
                    externalOutcome === 'SUCCEEDED'
                      ? '外部更新已确认成功，缺陷进入待验证。'
                      : '外部更新失败记录已追加，可在原批次继续。',
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
      {bug.availableActions.includes('ADD_FEEDBACK') ? (
        <section className="collab-bug-detail-section">
          <h3>补充反馈</h3>
          <div className="collab-form collab-bug-verification">
            <textarea
              maxLength={8_000}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="补充首次修复后的新信息"
              rows={3}
              value={feedback}
            />
            <input
              accept="image/png,image/jpeg,image/webp,text/plain,application/json"
              multiple
              onChange={(event) =>
                setFeedbackFiles(
                  Array.from(event.target.files ?? []).slice(0, 5),
                )
              }
              ref={feedbackFileInput}
              type="file"
            />
            <button
              disabled={pending || !feedback.trim()}
              onClick={() => {
                const formData = new FormData();
                formData.set('mutationId', crypto.randomUUID());
                formData.set('expectedVersion', String(bug.version));
                formData.set('content', feedback);
                feedbackFiles.forEach((file) =>
                  formData.append('attachments', file),
                );
                run(
                  () => addBugFeedbackAction(bug.id, formData),
                  '反馈已追加。',
                  () => {
                    setFeedback('');
                    setFeedbackFiles([]);
                    if (feedbackFileInput.current)
                      feedbackFileInput.current.value = '';
                  },
                );
              }}
              type="button"
            >
              追加反馈
            </button>
          </div>
        </section>
      ) : null}
      {bug.availableActions.some((action) =>
        ['VERIFY_PASS', 'VERIFY_FAIL'].includes(action),
      ) ? (
        <section className="collab-bug-detail-section">
          <h3>验证结果</h3>
          <div className="collab-form collab-bug-verification">
            {bug.availableActions.includes('VERIFY_PASS') ? (
              <>
                <textarea
                  maxLength={8_000}
                  onChange={(event) =>
                    setVerificationComment(event.target.value)
                  }
                  placeholder="可补充验证通过说明"
                  rows={2}
                  value={verificationComment}
                />
                <button
                  disabled={pending}
                  onClick={() => {
                    const formData = new FormData();
                    formData.set('mutationId', crypto.randomUUID());
                    formData.set('expectedVersion', String(bug.version));
                    formData.set('result', 'PASSED');
                    formData.set('comment', verificationComment);
                    run(
                      () => verifyBugAction(bug.id, formData),
                      '缺陷已验证完成。',
                      () => setVerificationComment(''),
                    );
                  }}
                  type="button"
                >
                  验证通过
                </button>
              </>
            ) : null}
            {bug.availableActions.includes('VERIFY_FAIL') ? (
              <>
                <textarea
                  maxLength={8_000}
                  onChange={(event) =>
                    setVerificationFeedback(event.target.value)
                  }
                  placeholder="描述仍然存在的问题与复现结果"
                  rows={3}
                  value={verificationFeedback}
                />
                <input
                  accept="image/png,image/jpeg,image/webp,text/plain,application/json"
                  multiple
                  onChange={(event) =>
                    setVerificationFiles(
                      Array.from(event.target.files ?? []).slice(0, 5),
                    )
                  }
                  ref={verificationFileInput}
                  type="file"
                />
                <button
                  disabled={pending || !verificationFeedback.trim()}
                  onClick={() => {
                    const formData = new FormData();
                    formData.set('mutationId', crypto.randomUUID());
                    formData.set('expectedVersion', String(bug.version));
                    formData.set('result', 'FAILED');
                    formData.set('feedback', verificationFeedback);
                    verificationFiles.forEach((file) =>
                      formData.append('attachments', file),
                    );
                    run(
                      () => verifyBugAction(bug.id, formData),
                      '缺陷已带反馈重新进入修复。',
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
                  验证失败并返修
                </button>
              </>
            ) : null}
          </div>
        </section>
      ) : null}
      {bug.availableActions.includes('REOPEN') ? (
        <section className="collab-bug-detail-section">
          <h3>重新打开</h3>
          <div className="collab-form collab-bug-verification">
            <textarea
              maxLength={8_000}
              onChange={(event) => setVerificationFeedback(event.target.value)}
              placeholder="描述重新出现的问题"
              rows={3}
              value={verificationFeedback}
            />
            <input
              accept="image/png,image/jpeg,image/webp,text/plain,application/json"
              multiple
              onChange={(event) =>
                setVerificationFiles(
                  Array.from(event.target.files ?? []).slice(0, 5),
                )
              }
              ref={verificationFileInput}
              type="file"
            />
            <button
              disabled={pending || !verificationFeedback.trim()}
              onClick={() => {
                const formData = new FormData();
                formData.set('mutationId', crypto.randomUUID());
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
      {bug.availableActions.includes('CANCEL') ? (
        <section className="collab-bug-detail-section">
          <h3>缺陷操作</h3>
          <button
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  cancelBugAction(bug.id, {
                    mutationId: crypto.randomUUID(),
                    expectedVersion: bug.version,
                  }),
                '缺陷已移入垃圾桶。',
              )
            }
            type="button"
          >
            取消缺陷
          </button>
        </section>
      ) : null}
      {cleanup ? (
        <section className="collab-bug-detail-section">
          <h3>取消与清理</h3>
          <dl className="collab-bug-detail-list">
            <Detail label="本地资源">{cleanup.presentation.statusLabel}</Detail>
          </dl>
          {cleanup.attempts.length ? (
            <ol className="collab-repair-records">
              {[...cleanup.attempts].reverse().map((attempt) => (
                <li key={attempt.id}>
                  <header>
                    <strong>第 {attempt.attempt} 次清理</strong>
                    <time>{formatDateTime(attempt.createdAt)}</time>
                  </header>
                  <p>
                    {attempt.summary ??
                      repairStateLabel(attempt.executionState)}
                  </p>
                  {attempt.technicalFailure ? (
                    <code>{attempt.technicalFailure}</code>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
          {cleanup.availableActions.includes('RETRY_CLEANUP') ? (
            <button
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    retryCleanupAction(cleanup.id, {
                      mutationId: crypto.randomUUID(),
                      expectedVersion: cleanup.version,
                    }),
                  '本地资源清理已重新排队。',
                )
              }
              type="button"
            >
              重试清理
            </button>
          ) : null}
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

function RepairAttemptDetails({ repair }: { repair: BugRepairView }) {
  return (
    <section className="collab-bug-detail-section">
      <h3>修复运行记录</h3>
      <p>{repair.presentation.statusLabel}</p>
      {repair.attempts.length ? (
        <ol className="collab-repair-records">
          {[...repair.attempts].reverse().map((attempt) => (
            <li key={attempt.id}>
              <header>
                <strong>第 {attempt.attempt} 次修复</strong>
                <time>{formatDateTime(attempt.createdAt)}</time>
              </header>
              <p>
                {attempt.summary ?? repairStateLabel(attempt.executionState)}
              </p>
              {attempt.technicalFailure ? (
                <code>{attempt.technicalFailure}</code>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="collab-bug-detail-empty">尚无运行记录</p>
      )}
      {repair.pendingCommits?.length ? (
        <>
          <h3>候选提交</h3>
          <ol className="collab-repair-records">
            {repair.pendingCommits.map((commit) => (
              <li key={commit}>
                <code>{commit}</code>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </section>
  );
}

function UpdateBatchDetails({ batch }: { batch: UpdateBatchView }) {
  return (
    <section className="collab-bug-detail-section">
      <h3>统一更新批次</h3>
      <p>{batch.presentation.statusLabel}</p>
      <dl className="collab-bug-detail-list">
        <Detail label="冻结时间">{formatDateTime(batch.frozenAt)}</Detail>
        <Detail label="冻结缺陷数">{batch.entries.length}</Detail>
      </dl>
      <ol className="collab-repair-records">
        {batch.entries.map((entry) => (
          <li key={entry.bugId}>
            <strong>
              缺陷-{String(entry.bugShortId).padStart(3, '0')} ·{' '}
              {entry.bugTitle}
            </strong>
            {entry.commits?.length ? (
              <ol className="collab-repair-records">
                {entry.commits.map((commit) => (
                  <li key={commit}>
                    <code>{commit}</code>
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        ))}
      </ol>
      {batch.attempts.length ? (
        <>
          <h3>更新运行记录</h3>
          <ol className="collab-repair-records">
            {[...batch.attempts].reverse().map((attempt) => (
              <li key={attempt.id}>
                <header>
                  <strong>第 {attempt.attempt} 次统一更新</strong>
                  <time>{formatDateTime(attempt.createdAt)}</time>
                </header>
                <p>
                  {attempt.summary ?? repairStateLabel(attempt.executionState)}
                </p>
                {attempt.technicalFailure ? (
                  <code>{attempt.technicalFailure}</code>
                ) : null}
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {batch.externalReports.length ? (
        <>
          <h3>外部更新记录</h3>
          <ol className="collab-repair-records">
            {[...batch.externalReports].reverse().map((report) => (
              <li key={report.id}>
                <header>
                  <strong>
                    第 {report.round} 次 ·{' '}
                    {report.outcome === 'SUCCEEDED'
                      ? '外部更新成功'
                      : '外部更新失败'}
                  </strong>
                  <time>{formatDateTime(report.createdAt)}</time>
                </header>
                {report.summary ? <p>{report.summary}</p> : null}
                {report.attachments.length ? (
                  <ul className="collab-attachments collab-bug-attachments">
                    {report.attachments.map((attachment) => (
                      <li key={attachment.id}>
                        <AttachmentLink attachment={attachment} />
                        <small>{formatBytes(attachment.sizeBytes)}</small>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </section>
  );
}

function RepairInteractionPanel({
  bug,
  interaction,
  pending,
  run,
}: {
  bug: BugView;
  interaction: RepairInteractionView;
  pending: boolean;
  run: (
    command: () => Promise<WorkspaceActionResult>,
    message: string,
    afterSuccess?: () => void,
  ) => void;
}) {
  const questions = repairInteractionQuestions(interaction);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (!interaction.canResolve || !interaction.payload)
    return (
      <section className="collab-bug-detail-section">
        <h3>修复等待处理</h3>
        <p>Codex 正在等待对应工程负责人处理。</p>
      </section>
    );
  return (
    <section className="collab-bug-detail-section">
      <h3>待处理 Codex 交互</h3>
      <p>{repairInteractionTitle(interaction)}</p>
      {interaction.kind === 'APPROVAL' ? (
        <>
          <dl className="collab-bug-detail-list">
            {repairInteractionDetails(interaction).map(([label, value]) => (
              <Detail key={label} label={label}>
                {value}
              </Detail>
            ))}
          </dl>
          <div className="collab-bug-drawer__actions">
            <button
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    resolveRepairInteractionAction(interaction.id, {
                      mutationId: crypto.randomUUID(),
                      expectedVersion: bug.version,
                      resolution: declineResolution(interaction),
                    }),
                  '已拒绝 Codex 请求。',
                )
              }
              type="button"
            >
              拒绝
            </button>
            <button
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    resolveRepairInteractionAction(interaction.id, {
                      mutationId: crypto.randomUUID(),
                      expectedVersion: bug.version,
                      resolution: acceptResolution(interaction),
                    }),
                  '已允许本次修复会话。',
                )
              }
              type="button"
            >
              本次会话允许
            </button>
          </div>
        </>
      ) : (
        <div className="collab-form collab-bug-verification">
          {questions.map((question) => (
            <label key={question.id}>
              <span>{question.header || question.question}</span>
              <small>{question.question}</small>
              <input
                onChange={(event) =>
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: event.target.value,
                  }))
                }
                value={answers[question.id] ?? ''}
              />
            </label>
          ))}
          <button
            disabled={
              pending ||
              questions.length === 0 ||
              questions.some((question) => !answers[question.id]?.trim())
            }
            onClick={() =>
              run(
                () =>
                  resolveRepairInteractionAction(interaction.id, {
                    mutationId: crypto.randomUUID(),
                    expectedVersion: bug.version,
                    resolution: {
                      answers: Object.fromEntries(
                        Object.entries(answers).map(([id, answer]) => [
                          id,
                          { answers: [answer.trim()] },
                        ]),
                      ),
                    },
                  }),
                '回答已提交给 Codex。',
                () => setAnswers({}),
              )
            }
            type="button"
          >
            提交回答
          </button>
        </div>
      )}
    </section>
  );
}

function UpdateInteractionPanel({
  batch,
  interaction,
  pending,
  run,
}: {
  batch: UpdateBatchView;
  interaction: UpdateInteractionView;
  pending: boolean;
  run: (
    command: () => Promise<WorkspaceActionResult>,
    message: string,
    afterSuccess?: () => void,
  ) => void;
}) {
  const questions = repairInteractionQuestions(interaction);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (!interaction.canResolve || !interaction.payload)
    return (
      <section className="collab-bug-detail-section">
        <h3>统一更新等待处理</h3>
        <p>Codex 正在等待对应工程负责人处理。</p>
      </section>
    );
  return (
    <section className="collab-bug-detail-section">
      <h3>待处理统一更新交互</h3>
      <p>{repairInteractionTitle(interaction)}</p>
      {interaction.kind === 'APPROVAL' ? (
        <>
          <dl className="collab-bug-detail-list">
            {repairInteractionDetails(interaction).map(([label, value]) => (
              <Detail key={label} label={label}>
                {value}
              </Detail>
            ))}
          </dl>
          <div className="collab-bug-drawer__actions">
            <button
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    resolveUpdateInteractionAction(interaction.id, {
                      mutationId: crypto.randomUUID(),
                      expectedVersion: batch.version,
                      resolution: declineResolution(interaction),
                    }),
                  '已拒绝统一更新请求。',
                )
              }
              type="button"
            >
              拒绝
            </button>
            <button
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    resolveUpdateInteractionAction(interaction.id, {
                      mutationId: crypto.randomUUID(),
                      expectedVersion: batch.version,
                      resolution: acceptResolution(interaction),
                    }),
                  '已允许本次统一更新会话。',
                )
              }
              type="button"
            >
              本次会话允许
            </button>
          </div>
        </>
      ) : (
        <div className="collab-form collab-bug-verification">
          {questions.map((question) => (
            <label key={question.id}>
              <span>{question.header || question.question}</span>
              <small>{question.question}</small>
              <input
                onChange={(event) =>
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: event.target.value,
                  }))
                }
                value={answers[question.id] ?? ''}
              />
            </label>
          ))}
          <button
            disabled={
              pending ||
              questions.length === 0 ||
              questions.some((question) => !answers[question.id]?.trim())
            }
            onClick={() =>
              run(
                () =>
                  resolveUpdateInteractionAction(interaction.id, {
                    mutationId: crypto.randomUUID(),
                    expectedVersion: batch.version,
                    resolution: {
                      answers: Object.fromEntries(
                        Object.entries(answers).map(([id, answer]) => [
                          id,
                          { answers: [answer.trim()] },
                        ]),
                      ),
                    },
                  }),
                '回答已提交给 Codex。',
                () => setAnswers({}),
              )
            }
            type="button"
          >
            提交回答
          </button>
        </div>
      )}
    </section>
  );
}

function RepairQueueDrawer({
  onChanged,
  onClose,
  snapshot,
}: {
  onChanged: (revision: number, message: string) => void;
  onClose: () => void;
  snapshot: CookingWorkspaceSnapshot;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const entries = snapshot.repairQueue.entries;
  const bugs = new Map(snapshot.bugs.map((bug) => [bug.id, bug]));

  function move(index: number, offset: -1 | 1) {
    const target = index + offset;
    if (target < 0 || target >= entries.length) return;
    const bugIds = entries.map(({ bugId }) => bugId);
    [bugIds[index], bugIds[target]] = [bugIds[target]!, bugIds[index]!];
    startTransition(async () => {
      try {
        const result = await reorderRepairQueueAction(
          snapshot.submission.submission.id,
          {
            mutationId: crypto.randomUUID(),
            expectedVersion: snapshot.repairQueue.version,
            bugIds,
          },
        );
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        onChanged(result.result.revision, '全局修复队列已重排。');
      } catch (actionError) {
        setError(messageOf(actionError, '无法调整修复队列。'));
      }
    });
  }

  return (
    <div
      className="collab-dialog-backdrop collab-drawer-scrim"
      role="presentation"
    >
      <section
        aria-label="全局修复队列"
        aria-modal="true"
        className="collab-dialog collab-bug-drawer"
        role="dialog"
      >
        <header>
          <div>
            <small>优先级</small>
            <h2>全局修复队列</h2>
          </div>
          <button aria-label="关闭全局修复队列" onClick={onClose} type="button">
            ×
          </button>
        </header>
        <div className="collab-dialog__body collab-bug-drawer__body">
          <div className="collab-repair-queue">
            {entries.map((entry, index) => (
              <div className="collab-queue-item" key={entry.bugId}>
                <b>{String(index + 1).padStart(2, '0')}</b>
                <span>
                  {bugs.get(entry.bugId)
                    ? bugLabel(bugs.get(entry.bugId)!)
                    : '未知缺陷'}
                </span>
                <button
                  aria-label="上移"
                  disabled={
                    pending ||
                    index === 0 ||
                    !snapshot.repairQueue.availableActions.includes('REORDER')
                  }
                  onClick={() => move(index, -1)}
                  type="button"
                >
                  ↑
                </button>
                <button
                  aria-label="下移"
                  disabled={
                    pending ||
                    index === entries.length - 1 ||
                    !snapshot.repairQueue.availableActions.includes('REORDER')
                  }
                  onClick={() => move(index, 1)}
                  type="button"
                >
                  ↓
                </button>
              </div>
            ))}
            {entries.length === 0 ? <small>队列为空</small> : null}
          </div>
          {error ? (
            <p className="collab-form__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </section>
    </div>
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

function AttachmentLink({
  attachment,
}: {
  attachment: BugView['report']['attachments'][number];
}) {
  return (
    <a href={`/api/cooking/attachments/${attachment.id}`}>
      {attachment.originalName}
    </a>
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
          mutationId: crypto.randomUUID(),
          expectedVersion: bug.version,
        }),
      message: `${bugLabel(bug)} 已加入全局修复队列。`,
    };
  if (
    target === 'WAITING_FOR_REPAIR' &&
    bug.stage === 'REPAIRING' &&
    bug.availableActions.includes('WITHDRAW_REPAIR')
  )
    return {
      command: () =>
        withdrawRepairAction(bug.id, {
          mutationId: crypto.randomUUID(),
          expectedVersion: bug.version,
        }),
      message: `${bugLabel(bug)} 已撤回待修复。`,
    };
  return null;
}

function drawerTitle(mode: Drawer['mode'], bug: BugView | null): string {
  if (mode === 'create') return '登记缺陷';
  if (mode === 'edit') return '编辑缺陷';
  return bug?.report.title ?? '缺陷详情';
}

function bugLabel(bug: BugView): string {
  return `缺陷-${String(bug.shortId).padStart(3, '0')}`;
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

function repairStateLabel(
  state: BugRepairView['attempts'][number]['executionState'],
): string {
  return {
    QUEUED: '等待 Agent',
    CLAIMED: '正在准备修复',
    RUNNING: '正在修复',
    WAITING_FOR_INTERACTION: '等待工程负责人处理',
    CANCEL_REQUESTED: '正在停止',
    SUCCEEDED: '修复已完成',
    FAILED: '修复未完成',
    CANCELLED: '修复已停止',
  }[state];
}

type CookingInteractionView = RepairInteractionView | UpdateInteractionView;

function repairInteractionTitle(interaction: CookingInteractionView): string {
  if (interaction.kind === 'USER_INPUT') return 'Codex 正在等待你的回答';
  return (
    {
      'item/commandExecution/requestApproval': 'Codex 请求执行命令',
      'item/fileChange/requestApproval': 'Codex 请求扩展文件写入范围',
      'item/permissions/requestApproval': 'Codex 请求权限',
    }[interaction.method ?? ''] ?? 'Codex 请求操作许可'
  );
}

function repairInteractionDetails(
  interaction: CookingInteractionView,
): Array<[string, string]> {
  const payload = asRecord(interaction.payload);
  const values: Array<[string, unknown]> = [
    ['原因', payload.reason],
    ['命令', payload.command],
    ['权限', payload.permissions],
  ];
  return values.flatMap(([label, value]) =>
    value === null || value === undefined || value === ''
      ? []
      : [[label, typeof value === 'string' ? value : JSON.stringify(value)]],
  );
}

function repairInteractionQuestions(interaction: CookingInteractionView) {
  const questions = asRecord(interaction.payload).questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((question) => {
    const value = asRecord(question);
    if (typeof value.id !== 'string' || typeof value.question !== 'string')
      return [];
    return [
      {
        id: value.id,
        question: value.question,
        header: typeof value.header === 'string' ? value.header : '',
      },
    ];
  });
}

function acceptResolution(interaction: CookingInteractionView): JsonValue {
  if (interaction.method === 'item/permissions/requestApproval')
    return {
      permissions:
        (asRecord(interaction.payload).permissions as JsonValue | undefined) ??
        {},
      scope: 'session',
    };
  return { decision: 'acceptForSession' };
}

function declineResolution(interaction: CookingInteractionView): JsonValue {
  return interaction.method === 'item/permissions/requestApproval'
    ? { permissions: {}, scope: 'turn' }
    : { decision: 'decline' };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
