'use client';

import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import type { JsonValue } from '@agent-party-time/execution-contract';
import type { CookingWorkspaceSnapshot } from '@/features/cooking/workspace/contract';
import type {
  CookingInteractionView,
  CookingVisualPresentation,
} from '@/features/cooking/shared/contract';
import {
  cancelBugAction,
  reopenBugAction,
  retryCleanupAction,
  verifyBugAction,
  type BugLifecycleActionResult,
  type CleanupActionResult,
} from '@/features/cooking/lifecycle/presentation/actions';
import type { BugRepairView } from '@/features/cooking/repair/contract';
import {
  continueRepairAction,
  resolveRepairInteractionAction,
  stopRepairExecutionAction,
  type RepairActionResult,
} from '@/features/cooking/repair/presentation/actions';
import type { UpdateBatchView } from '@/features/cooking/update/contract';
import {
  cancelUpdateBatchAction,
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
                  const visual = snapshot.visualByBug[bug.id]!;
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
                      visual={visual}
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
  visual,
}: {
  bug: BugView;
  draggable: boolean;
  dragging: boolean;
  onDragEnd: () => void;
  onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
  onOpen: () => void;
  visual: CookingVisualPresentation;
}) {
  return (
    <article
      aria-label={`${bugLabel(bug)}，${visual.label}`}
      className={`collab-bug-card${draggable ? ' collab-bug-card--draggable' : ''}`}
      data-dragging={dragging ? 'true' : undefined}
      data-stage={bug.stage}
      data-visual-state={visual.state}
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
      <span aria-hidden="true" className="collab-bug-card__state">
        {visual.symbol}
      </span>
      <small>
        {bugLabel(bug)} · {bug.presentation.assignmentLabel}
      </small>
      <h3>{bug.report.title}</h3>
      {visual.state !== 'IDLE' ? (
        <strong className="collab-bug-card__attention">{visual.label}</strong>
      ) : null}
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
        <header
          className={
            drawer.mode === 'view' ? 'collab-bug-drawer__chrome' : undefined
          }
        >
          {drawer.mode === 'view' ? (
            <small>缺陷详情</small>
          ) : (
            <div>
              <small>{bug ? bugLabel(bug) : '新缺陷'}</small>
              <h2>{drawerTitle(drawer.mode, bug)}</h2>
            </div>
          )}
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
  const [detailView, setDetailView] = useState<'progress' | 'report'>(
    'progress',
  );
  const [feedback, setFeedback] = useState('');
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
  const visual = snapshot.visualByBug[bug.id]!;
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
  const verifications = snapshot.verificationsByBug[bug.id] ?? [];
  const cleanup = snapshot.cleanups.find(
    (candidate) =>
      candidate.reason === 'BUG_CANCELLED' && candidate.subjectId === bug.id,
  );
  const canResolveInteraction = Boolean(
    repair?.timeline.some(
      (node) =>
        node.kind === 'REPAIR_ATTEMPT' &&
        node.interactions.some(
          (interaction) =>
            interaction.state === 'PENDING' && interaction.canResolve,
        ),
    ) ||
    updateBatch?.interactions.some(
      (interaction) =>
        interaction.state === 'PENDING' && interaction.canResolve,
    ),
  );
  const needsCurrentUserAction = Boolean(
    canResolveInteraction ||
    repair?.availableActions.includes('RETRY_REPAIR') ||
    bug.availableActions.some((action) =>
      ['REQUEST_REPAIR', 'VERIFY_PASS', 'VERIFY_FAIL'].includes(action),
    ),
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
    <div
      className="collab-dialog__body collab-bug-drawer__body"
      data-detail-view={detailView}
    >
      <header className="collab-bug-detail-hero">
        <div>
          <small>{bugLabel(bug)}</small>
          <h2>{bug.report.title}</h2>
        </div>
        <dl>
          <Detail label="当前阶段">
            <span
              aria-label={visual.label}
              className="collab-current-visual"
              data-visual-state={visual.state}
            >
              <span aria-hidden="true">{visual.symbol}</span>
              {visual.label}
            </span>
          </Detail>
          <Detail label="工程">
            {bug.assignment?.engineeringName ?? '暂未分配'}
          </Detail>
          <Detail label="负责人">
            {bug.assignment?.responsibleUser.displayName ?? '暂未分配'}
          </Detail>
          <Detail label="需要当前用户处理">
            {needsCurrentUserAction ? '是' : '否'}
          </Detail>
        </dl>
        <nav aria-label="缺陷详情视图" className="collab-bug-detail-tabs">
          <button
            aria-current={detailView === 'progress' ? 'page' : undefined}
            onClick={() => setDetailView('progress')}
            type="button"
          >
            进展
          </button>
          <button
            aria-current={detailView === 'report' ? 'page' : undefined}
            onClick={() => setDetailView('report')}
            type="button"
          >
            缺陷资料
          </button>
        </nav>
      </header>
      <BugReportDetails bug={bug} onEdit={onEdit} />
      {repair ? (
        <RepairAttemptDetails
          bug={bug}
          pending={pending}
          repair={repair}
          run={run}
        />
      ) : null}
      {pendingDelivery ? (
        <section className="collab-bug-detail-section">
          <h3>待统一更新</h3>
          <p>
            最新候选已记录；静默截止时间：
            {formatDateTime(pendingDelivery.eligibleAt)}
          </p>
        </section>
      ) : null}
      {updateBatch ? (
        <UpdateBatchDetails batch={updateBatch} pending={pending} run={run} />
      ) : null}
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
                  '缺陷已提交自动修复。',
                )
              }
              type="button"
            >
              开始自动修复
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
      {bug.availableActions.includes('ADD_FEEDBACK') &&
      !['REPAIRING', 'WAITING_FOR_UPDATE', 'UPDATING'].includes(bug.stage) ? (
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

function BugReportDetails({
  bug,
  onEdit,
}: {
  bug: BugView;
  onEdit: (() => void) | null;
}) {
  const canEdit = Boolean(onEdit);
  return (
    <div className="collab-bug-report">
      <section className="collab-bug-detail-section">
        <header>
          <div>
            <h3>原始缺陷报告</h3>
            <p>
              {bug.reportLockedAt
                ? '修复开始后，原始报告已永久冻结。后续问题请在验证或重新打开时记录。'
                : '自动修复开始前可以修正报告内容。'}
            </p>
          </div>
          {canEdit ? (
            <button onClick={onEdit!} type="button">
              {bug.availableActions.includes('EDIT_REPORT')
                ? '编辑缺陷资料'
                : '修改问题归属'}
            </button>
          ) : null}
        </header>
        <dl className="collab-bug-detail-list">
          <Detail label="问题归属">{bug.presentation.assignmentLabel}</Detail>
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
    </div>
  );
}

function RepairAttemptDetails({
  bug,
  pending,
  repair,
  run,
}: {
  bug: BugView;
  pending: boolean;
  repair: BugRepairView;
  run: (
    command: () => Promise<WorkspaceActionResult>,
    message: string,
    afterSuccess?: () => void,
  ) => void;
}) {
  const latestNode = repair.timeline.at(-1);
  const latestNodeRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    latestNodeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [
    latestNode?.id,
    latestNode?.kind === 'REPAIR_ATTEMPT'
      ? latestNode.executionState
      : latestNode?.kind,
  ]);
  return (
    <section className="collab-bug-detail-section collab-progress-timeline">
      <header>
        <div>
          <h3>缺陷进展</h3>
          <p>{repair.presentation.statusLabel}</p>
        </div>
      </header>
      <ol className="collab-repair-timeline">
        {repair.timeline.map((node, index) => (
          <li
            data-node-kind={node.kind}
            key={node.id}
            ref={index === repair.timeline.length - 1 ? latestNodeRef : null}
          >
            <span aria-hidden="true" className="collab-repair-timeline__mark" />
            {node.kind === 'BUG_REGISTERED' ? (
              <article>
                <header>
                  <strong>缺陷已登记</strong>
                  <time>{formatDateTime(node.occurredAt)}</time>
                </header>
                <p>原始报告已进入待修复阶段。</p>
              </article>
            ) : (
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
                    {formatDateTime(
                      node.finishedAt ?? node.startedAt ?? node.queuedAt,
                    )}
                  </time>
                </header>
                {node.interactions.map((interaction) => (
                  <CookingInteractionRecord
                    interaction={interaction}
                    key={interaction.id}
                    onResolve={(resolution) =>
                      resolveRepairInteractionAction(interaction.id, {
                        mutationId: crypto.randomUUID(),
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
                    <Detail label="Agent">{node.agentName}</Detail>
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
                              <strong>
                                {validationStatusLabel(validation.status)}
                              </strong>
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
                        {node.result.rawSummary ? (
                          <p>{node.result.rawSummary}</p>
                        ) : null}
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
                        {node.result.rawSummary ? (
                          <p>{node.result.rawSummary}</p>
                        ) : null}
                        {node.result.failureCode ? (
                          <code>{node.result.failureCode}</code>
                        ) : null}
                      </details>
                    ) : null}
                    {index === repair.timeline.length - 1 &&
                    repair.availableActions.includes('RETRY_REPAIR') ? (
                      <button
                        disabled={pending}
                        onClick={() =>
                          run(
                            () =>
                              continueRepairAction(bug.id, {
                                mutationId: crypto.randomUUID(),
                                expectedVersion: bug.version,
                              }),
                            '已在原修复会话中重新执行。',
                          )
                        }
                        type="button"
                      >
                        重新执行修复
                      </button>
                    ) : null}
                  </>
                )}
              </article>
            )}
          </li>
        ))}
      </ol>
    </section>
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
  pending,
  run,
}: {
  batch: UpdateBatchView;
  pending: boolean;
  run: (
    command: () => Promise<WorkspaceActionResult>,
    message: string,
    afterSuccess?: () => void,
  ) => void;
}) {
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
      {batch.interactions.length ? (
        <>
          <h3>更新例外处理</h3>
          <ol className="collab-update-interactions">
            {batch.interactions.map((interaction) => (
              <li key={interaction.id}>
                <CookingInteractionRecord
                  interaction={interaction}
                  onResolve={(resolution) =>
                    resolveUpdateInteractionAction(interaction.id, {
                      mutationId: crypto.randomUUID(),
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
        </>
      ) : null}
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
      message: `${bugLabel(bug)} 已提交自动修复。`,
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

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
