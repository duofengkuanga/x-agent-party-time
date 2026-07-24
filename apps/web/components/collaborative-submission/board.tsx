'use client';

import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from 'react';
import type {
  CollaborativeCommand,
  EngineeringBindingSummary,
  EngineeringDetail,
  SubmissionBug,
  SubmissionRepairTask,
  SubmissionUpdateBatch,
  TestSubmissionDetail,
  TestSubmissionSummary,
} from '@agent-party-time/shared/control-plane';
import type { CurrentUser } from '@/lib/auth/core';
import {
  bugLabel,
  formatCompactDate,
  formatDateTime,
  requestJson,
} from './client';
import {
  DEPLOYMENT_TYPE_LABELS,
  ENGINEERING_TYPE_LABELS,
  STATUS_COLUMNS,
  SUBMISSION_STATUS_LABELS,
  UPDATE_BATCH_STATE_LABELS,
  type BugStatus,
  type CreateItemDraft,
  type ItemCatalog,
  type SubmissionItem,
  type WorkspaceSnapshot,
} from './model';
import { ExternalFailureDialog } from './dialogs';
import { BugDrawer, type BugDrawerState } from './bug-drawer';

export function SubmissionRail({
  currentUser,
  submissions,
  selectedId,
  snapshot,
  loading,
  refreshing,
  includeClosed,
  detailOpen,
  collapsed,
  pending,
  mutate,
  onSelect,
  onOpenDetails,
  onBackToList,
  onToggleCollapsed,
  onRefresh,
  onCreate,
  onCloseSubmission,
  onIncludeClosedChange,
}: {
  currentUser: CurrentUser;
  submissions: TestSubmissionSummary[];
  selectedId: string | null;
  snapshot: WorkspaceSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  includeClosed: boolean;
  detailOpen: boolean;
  collapsed: boolean;
  pending: boolean;
  mutate: (
    command: CollaborativeCommand,
    message: string | null,
  ) => Promise<boolean>;
  onSelect: (id: string) => void;
  onOpenDetails: (id: string) => void;
  onBackToList: () => void;
  onToggleCollapsed: () => void;
  onRefresh: () => void;
  onCreate: () => void;
  onCloseSubmission: () => void;
  onIncludeClosedChange: (value: boolean) => void;
}) {
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const collapseButtonRef = useRef<HTMLButtonElement>(null);
  const canCloseSubmission =
    currentUser.accountType === 'TESTER' &&
    snapshot?.submission.status === 'ACTIVE' &&
    snapshot.bugs.every((bug) => bug.status === 'DONE');

  function collapseRail() {
    onToggleCollapsed();
    requestAnimationFrame(() => expandButtonRef.current?.focus());
  }

  function expandRail() {
    onToggleCollapsed();
    requestAnimationFrame(() => collapseButtonRef.current?.focus());
  }

  return (
    <aside
      className={`collab-rail${detailOpen ? ' collab-rail--detail' : ''}`}
      id="collab-submission-rail"
      data-collapsed={collapsed ? 'true' : undefined}
    >
      <button
        aria-hidden={!collapsed}
        aria-label="展开提测单侧边栏"
        className="collab-rail__expand"
        onClick={expandRail}
        ref={expandButtonRef}
        tabIndex={collapsed ? 0 : -1}
        type="button"
      >
        <span>提测单</span>
        <b>›</b>
      </button>

      <div
        aria-hidden={collapsed}
        className="collab-rail__expanded"
        inert={collapsed}
      >
        {detailOpen ? (
          <>
            <div className="collab-rail__detail-toolbar">
              <button onClick={onBackToList} type="button">
                ← 返回列表
              </button>
              <button
                aria-label="收起提测单侧边栏"
                onClick={collapseRail}
                ref={collapseButtonRef}
                type="button"
              >
                ‹
              </button>
            </div>
            <label className="collab-rail__switcher">
              <span>切换提测单</span>
              <select
                onChange={(event) => onSelect(event.target.value)}
                value={selectedId ?? ''}
              >
                {submissions.map((submission) => (
                  <option key={submission.id} value={submission.id}>
                    {submission.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="collab-rail__detail-body">
              {snapshot?.submission.id === selectedId ? (
                <SubmissionHeader
                  currentUser={currentUser}
                  mutate={mutate}
                  snapshot={snapshot}
                />
              ) : (
                <p className="collab-rail__detail-loading">
                  正在加载提测单详情…
                </p>
              )}
            </div>
            {currentUser.accountType === 'TESTER' &&
            snapshot?.submission.status === 'ACTIVE' ? (
              <div className="collab-rail__detail-footer">
                <button
                  disabled={!canCloseSubmission || pending}
                  onClick={onCloseSubmission}
                  type="button"
                >
                  关闭提测单
                </button>
                {!canCloseSubmission ? (
                  <small>所有缺陷完成后可关闭</small>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="collab-rail__heading">
              <h2>提测单</h2>
              <div className="collab-rail__heading-actions">
                <button
                  aria-label="刷新"
                  disabled={refreshing}
                  onClick={onRefresh}
                  type="button"
                >
                  {refreshing ? '…' : '↻'}
                </button>
                <button
                  aria-label="收起提测单侧边栏"
                  onClick={collapseRail}
                  ref={collapseButtonRef}
                  type="button"
                >
                  ‹
                </button>
              </div>
            </div>
            <label className="collab-check">
              <input
                checked={includeClosed}
                onChange={(event) =>
                  onIncludeClosedChange(event.target.checked)
                }
                type="checkbox"
              />
              <span>包含已关闭提测单</span>
            </label>
            <nav className="collab-submission-list" aria-label="提测单列表">
              {submissions.map((submission) => (
                <article
                  className="collab-submission-card"
                  data-selected={
                    submission.id === selectedId ? 'true' : undefined
                  }
                  key={submission.id}
                >
                  <button
                    aria-current={
                      submission.id === selectedId ? 'page' : undefined
                    }
                    className="collab-submission-card__select"
                    onClick={() => onSelect(submission.id)}
                    type="button"
                  >
                    <span className="collab-submission-list__meta">
                      <b>
                        {submission.status === 'ACTIVE' ? '进行中' : '已关闭'}
                      </b>
                      <time>{formatCompactDate(submission.updatedAt)}</time>
                    </span>
                    <strong>{submission.title}</strong>
                    <small>
                      {submission.tester.displayName} · {submission.itemCount}{' '}
                      工程
                    </small>
                  </button>
                  <button
                    aria-label={`查看${submission.title}详情`}
                    className="collab-submission-card__details"
                    onClick={() => onOpenDetails(submission.id)}
                    type="button"
                  >
                    详情
                  </button>
                </article>
              ))}
              {!loading && submissions.length === 0 ? (
                <p className="collab-rail__empty">
                  {currentUser.accountType === 'TESTER'
                    ? '还没有分配给你的提测单。'
                    : '还没有协作提测单。'}
                </p>
              ) : null}
            </nav>
            {currentUser.accountType === 'DEVELOPER' ? (
              <button
                className="collab-primary collab-rail__create"
                onClick={onCreate}
              >
                ＋ 创建多工程提测
              </button>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}

export function SubmissionHeader({
  currentUser,
  snapshot,
  mutate,
}: {
  currentUser: CurrentUser;
  snapshot: WorkspaceSnapshot;
  mutate: (
    command: CollaborativeCommand,
    message: string | null,
  ) => Promise<boolean>;
}) {
  const { submission, bugs } = snapshot;
  function canConfigure(item: SubmissionItem) {
    return (
      Boolean(item.technical) &&
      !item.lockedAt &&
      currentUser.id === item.responsibleDeveloper.id &&
      submission.status === 'ACTIVE'
    );
  }

  return (
    <header className="collab-submission-header">
      <dl className="collab-submission-facts">
        <div>
          <dt>项目</dt>
          <dd>{submission.projectTitle}</dd>
        </div>
        <div>
          <dt>提测状态</dt>
          <dd>{SUBMISSION_STATUS_LABELS[submission.status]}</dd>
        </div>
        <div>
          <dt>需求说明</dt>
          <dd>{submission.requirementDescription}</dd>
        </div>
        <div>
          <dt>测试负责人</dt>
          <dd>{submission.tester.displayName}</dd>
        </div>
        <div>
          <dt>总缺陷个数</dt>
          <dd>{bugs.length}</dd>
        </div>
        <div>
          <dt>创建时间</dt>
          <dd>{formatDateTime(submission.createdAt)}</dd>
        </div>
      </dl>

      <div className="collab-submission-projects">
        <table aria-label="提测工程配置">
          <thead>
            <tr>
              <th>工程</th>
              <th>项目类型</th>
              <th>开发负责人</th>
              <th>目标分支</th>
              <th>测试环境 / 部署方式</th>
            </tr>
          </thead>
          <tbody>
            {submission.items.map((item) => (
              <SubmissionEngineeringRow
                canConfigure={canConfigure(item)}
                item={item}
                key={item.id}
                mutate={mutate}
              />
            ))}
          </tbody>
        </table>
      </div>
    </header>
  );
}

function SubmissionEngineeringRow({
  item,
  canConfigure,
  mutate,
}: {
  item: SubmissionItem;
  canConfigure: boolean;
  mutate: (
    command: CollaborativeCommand,
    message: string | null,
  ) => Promise<boolean>;
}) {
  const [entry, setEntry] = useState<ItemCatalog | null>(null);
  const [draft, setDraft] = useState<CreateItemDraft>(() => ({
    engineeringId: item.engineeringId,
    responsibleDeveloperUserId: item.responsibleDeveloper.id,
    bindingId: item.technical?.bindingId ?? '',
    targetBranch: item.technical?.targetBranch ?? item.testTarget.targetBranch,
    environmentId: item.technical?.environment.id ?? '',
  }));
  const [saveState, setSaveState] = useState<
    'idle' | 'pending' | 'saving' | 'saved' | 'incomplete' | 'error'
  >('idle');
  const saveTimerRef = useRef<number | null>(null);
  const saveVersionRef = useRef(0);
  const activeRef = useRef(true);
  const lastSavedKeyRef = useRef(draftKey(draft));

  useEffect(
    () => () => {
      activeRef.current = false;
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!canConfigure) return;
    void Promise.all([
      requestJson<{ engineering?: EngineeringDetail; error?: string }>(
        `/api/control-plane/engineerings/${item.engineeringId}`,
      ),
      requestJson<{ items?: EngineeringBindingSummary[]; error?: string }>(
        `/api/control-plane/engineerings/${item.engineeringId}/bindings`,
      ),
    ])
      .then(([detail, bindings]) => {
        if (!detail.engineering) throw new Error('工程详情不存在');
        setEntry({
          engineering: detail.engineering,
          bindings: bindings.items ?? [],
        });
      })
      .catch(() => setSaveState('error'));
  }, [canConfigure, item.engineeringId]);

  function draftKey(value: CreateItemDraft) {
    return JSON.stringify({
      bindingId: value.bindingId,
      environmentId: value.environmentId,
      responsibleDeveloperUserId: value.responsibleDeveloperUserId,
      targetBranch: value.targetBranch.trim(),
    });
  }

  function canAutoSave(value: CreateItemDraft) {
    return Boolean(
      value.bindingId &&
      value.environmentId &&
      value.responsibleDeveloperUserId &&
      value.targetBranch.trim(),
    );
  }

  async function persistDraft(value: CreateItemDraft) {
    const key = draftKey(value);
    if (key === lastSavedKeyRef.current) return;
    if (!canAutoSave(value)) {
      if (activeRef.current) setSaveState('incomplete');
      return;
    }

    const version = ++saveVersionRef.current;
    if (activeRef.current) setSaveState('saving');
    const saved = await mutate(
      {
        kind: 'submission.item.update',
        submissionItemId: item.id,
        responsibleDeveloperUserId: value.responsibleDeveloperUserId,
        bindingId: value.bindingId,
        targetBranch: value.targetBranch.trim(),
        environmentId: value.environmentId,
      },
      null,
    );
    if (version !== saveVersionRef.current) return;
    if (!saved) {
      if (activeRef.current) setSaveState('error');
      return;
    }
    lastSavedKeyRef.current = key;
    if (activeRef.current) setSaveState('saved');
  }

  useEffect(() => {
    if (!entry) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    const key = draftKey(draft);
    if (key === lastSavedKeyRef.current) {
      setSaveState('idle');
      return;
    }
    if (!canAutoSave(draft)) {
      setSaveState('incomplete');
      return;
    }
    setSaveState('pending');
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void persistDraft(draft);
    }, 350);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [draft, entry]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!canConfigure) {
    return (
      <tr>
        <td data-label="工程">{item.engineeringDisplayName}</td>
        <td data-label="项目类型">
          {ENGINEERING_TYPE_LABELS[item.engineeringType]}
        </td>
        <td data-label="开发负责人">{item.responsibleDeveloper.displayName}</td>
        <td data-label="目标分支">
          <code>{item.testTarget.targetBranch}</code>
        </td>
        <td data-label="测试环境 / 部署方式">
          {item.technical
            ? `${item.testTarget.environment.displayName} · ${
                DEPLOYMENT_TYPE_LABELS[
                  item.technical.environment.deploymentType
                ]
              }`
            : item.testTarget.environment.displayName}
        </td>
      </tr>
    );
  }

  const selectedEnvironment = entry?.engineering.environments.find(
    (environment) => environment.id === draft.environmentId,
  );
  const selectableMembers =
    entry?.engineering.members.flatMap((member) =>
      entry.bindings.some((binding) => binding.developer.id === member.user.id)
        ? [{ ...member.user, engineeringRole: member.role }]
        : [],
    ) ?? [];

  return (
    <tr aria-busy={saveState === 'saving' ? 'true' : undefined}>
      <td data-label="工程">{item.engineeringDisplayName}</td>
      <td data-label="项目类型">
        {ENGINEERING_TYPE_LABELS[item.engineeringType]}
      </td>
      <td data-label="开发负责人">
        <select
          aria-label={`${item.engineeringDisplayName} 开发负责人`}
          className="collab-table-select"
          disabled={!entry}
          onChange={(event) => {
            const developerId = event.target.value;
            const binding = entry?.bindings.find(
              (candidate) => candidate.developer.id === developerId,
            );
            setDraft((current) => ({
              ...current,
              responsibleDeveloperUserId: developerId,
              bindingId: binding?.id ?? '',
            }));
          }}
          value={draft.responsibleDeveloperUserId}
        >
          {selectableMembers.length === 0 ? (
            <option value="">暂无已绑定 Agent 的工程成员</option>
          ) : null}
          {selectableMembers.map((member) => {
            const roleLabel =
              member.engineeringRole === 'OWNER' ? '工程负责人' : '工程成员';
            const label = `${member.displayName} · ${roleLabel}`;
            return (
              <option key={member.id} title={label} value={member.id}>
                {label}
              </option>
            );
          })}
        </select>
      </td>
      <td data-label="目标分支">
        <input
          aria-label={`${item.engineeringDisplayName} 目标分支`}
          className="collab-table-input"
          disabled={!entry}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              targetBranch: event.target.value,
            }))
          }
          value={draft.targetBranch}
        />
      </td>
      <td data-label="测试环境 / 部署方式">
        <select
          aria-label={`${item.engineeringDisplayName} 测试环境`}
          className="collab-table-select"
          disabled={!entry}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              environmentId: event.target.value,
            }))
          }
          title={
            selectedEnvironment
              ? `${selectedEnvironment.displayName} · ${
                  DEPLOYMENT_TYPE_LABELS[selectedEnvironment.deploymentType]
                }`
              : '正在读取测试环境'
          }
          value={draft.environmentId}
        >
          {entry?.engineering.environments.map((environment) => {
            const label = `${environment.displayName} · ${
              DEPLOYMENT_TYPE_LABELS[environment.deploymentType]
            }`;
            return (
              <option key={environment.id} title={label} value={environment.id}>
                {label}
              </option>
            );
          })}
        </select>
      </td>
    </tr>
  );
}

export function DeveloperOperations({
  currentUser,
  snapshot,
  pending,
  mutate,
}: {
  currentUser: CurrentUser;
  snapshot: WorkspaceSnapshot;
  pending: boolean;
  mutate: (
    command: CollaborativeCommand,
    message: string | null,
  ) => Promise<boolean>;
}) {
  const operationalItems = snapshot.submission.items.filter(
    (item) => item.technical,
  );
  if (operationalItems.length === 0) return null;
  return (
    <div className="collab-board-statuses">
      {operationalItems.map((item) => (
        <EngineeringOperationCard
          currentUser={currentUser}
          item={item}
          key={item.id}
          mutate={mutate}
          pending={pending}
          repairTasks={snapshot.repairQueues[item.id] ?? []}
          snapshot={snapshot}
          updateBatches={snapshot.updateBatches[item.id] ?? []}
        />
      ))}
    </div>
  );
}

function EngineeringOperationCard({
  currentUser,
  item,
  repairTasks,
  updateBatches,
  snapshot,
  pending,
  mutate,
}: {
  currentUser: CurrentUser;
  item: SubmissionItem;
  repairTasks: SubmissionRepairTask[];
  updateBatches: SubmissionUpdateBatch[];
  snapshot: WorkspaceSnapshot;
  pending: boolean;
  mutate: (
    command: CollaborativeCommand,
    message: string | null,
  ) => Promise<boolean>;
}) {
  const [failureBatchId, setFailureBatchId] = useState<string | null>(null);
  const [continueFeedback, setContinueFeedback] = useState('');
  const activeBatch = updateBatches.find((batch) =>
    ['QUEUED', 'RUNNING', 'WAITING_EXTERNAL', 'FAILED'].includes(batch.state),
  );
  const waitingCandidates = snapshot.bugs.filter(
    (bug) =>
      bug.submissionItemId === item.id && bug.status === 'WAITING_FOR_UPDATE',
  );
  const latestCandidateAt = waitingCandidates.reduce(
    (latest, bug) => Math.max(latest, new Date(bug.updatedAt).getTime()),
    0,
  );
  const quietDeadline = latestCandidateAt ? latestCandidateAt + 120_000 : null;
  const canOperate =
    currentUser.id === item.responsibleDeveloper.id &&
    snapshot.submission.status === 'ACTIVE';
  const technical = item.technical;
  const needsActionToolbar =
    activeBatch?.state === 'WAITING_EXTERNAL' ||
    activeBatch?.state === 'FAILED' ||
    !canOperate;

  return (
    <article className="collab-board-status">
      <h2>{item.engineeringDisplayName}</h2>
      <dl className="collab-board-status__facts">
        {technical ? (
          <>
            <div>
              <dt>修复队列</dt>
              <dd>
                <RepairQueue
                  bugs={snapshot.bugs}
                  canOperate={canOperate}
                  item={item}
                  mutate={mutate}
                  pending={pending}
                  repairTasks={repairTasks}
                />
              </dd>
            </div>
            <div>
              <dt>待更新</dt>
              <dd className="collab-engineering-field__stack">
                {waitingCandidates.length ? (
                  <>
                    <strong>
                      {waitingCandidates.length} 个候选 ·{' '}
                      {quietDeadline
                        ? quietCountdown(quietDeadline)
                        : '等待冻结'}
                    </strong>
                    <ul className="collab-engineering-field__list">
                      {waitingCandidates.map((bug) => (
                        <li key={bug.id}>
                          <span>{bugLabel(snapshot.bugs, bug.id)}</span>
                          {bug.candidateCommit ? (
                            <code>{bug.candidateCommit.slice(0, 10)}</code>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <small>暂无待更新候选</small>
                )}
              </dd>
            </div>
            <div>
              <dt>更新批次</dt>
              <dd className="collab-engineering-field__stack">
                {activeBatch ? (
                  <>
                    <strong>
                      {UPDATE_BATCH_STATE_LABELS[activeBatch.state]}
                    </strong>
                    <small>
                      {activeBatch.bugIds.length} 个缺陷 ·{' '}
                      {activeBatch.candidateCommits.length} 个候选提交
                    </small>
                    {activeBatch.externalFailure ? (
                      <p className="collab-engineering-field__feedback">
                        {activeBatch.externalFailure}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <small>暂无进行中的更新批次</small>
                )}
              </dd>
            </div>
          </>
        ) : null}
      </dl>
      {technical && needsActionToolbar ? (
        <div className="collab-board-status__actions">
          {activeBatch?.state === 'WAITING_EXTERNAL' ? (
            <div className="collab-board-status__action-buttons">
              <button
                disabled={!canOperate || pending}
                onClick={() =>
                  mutate(
                    {
                      kind: 'update.external_confirm',
                      batchId: activeBatch.id,
                    },
                    '持续集成与部署的外部更新已确认完成。',
                  )
                }
                type="button"
              >
                确认外部更新
              </button>
              <button
                disabled={!canOperate}
                onClick={() => setFailureBatchId(activeBatch.id)}
                type="button"
              >
                反馈失败
              </button>
            </div>
          ) : null}
          {activeBatch?.state === 'FAILED' ? (
            <div className="collab-update-continue">
              <textarea
                onChange={(event) => setContinueFeedback(event.target.value)}
                placeholder="说明已处理事项或下一步要求；将在原 Codex 会话中输入“继续”"
                rows={3}
                value={continueFeedback}
              />
              <button
                disabled={
                  !canOperate || pending || continueFeedback.trim().length === 0
                }
                onClick={() =>
                  mutate(
                    {
                      kind: 'update.continue',
                      batchId: activeBatch.id,
                      feedback: continueFeedback,
                    },
                    '原更新批次已排队，将在原 Codex 会话中继续。',
                  )
                }
                type="button"
              >
                在原会话中继续
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {failureBatchId ? (
        <ExternalFailureDialog
          batchId={failureBatchId}
          onClose={() => setFailureBatchId(null)}
          onSubmitted={() => setFailureBatchId(null)}
          mutate={mutate}
        />
      ) : null}
    </article>
  );
}

function RepairQueue({
  item,
  repairTasks,
  bugs,
  canOperate,
  pending,
  mutate,
}: {
  item: SubmissionItem;
  repairTasks: SubmissionRepairTask[];
  bugs: SubmissionBug[];
  canOperate: boolean;
  pending: boolean;
  mutate: (
    command: CollaborativeCommand,
    message: string | null,
  ) => Promise<boolean>;
}) {
  const running = repairTasks.find((task) => task.state === 'RUNNING');
  const queued = repairTasks.filter((task) => task.state === 'QUEUED');

  function move(index: number, offset: -1 | 1) {
    const next = queued.map((task) => task.bugId);
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    mutate(
      {
        kind: 'repair_queue.reorder',
        submissionItemId: item.id,
        bugIds: next,
      },
      `${item.engineeringDisplayName} 修复队列已重排。`,
    );
  }

  return (
    <div className="collab-repair-queue">
      {running ? (
        <div className="collab-queue-item collab-queue-item--running">
          <b>执行中</b>
          <span>{bugLabel(bugs, running.bugId)}</span>
        </div>
      ) : null}
      {queued.map((task, index) => (
        <div className="collab-queue-item" key={task.id}>
          <b>{String(index + 1).padStart(2, '0')}</b>
          <span>{bugLabel(bugs, task.bugId)}</span>
          <button
            aria-label="上移"
            disabled={!canOperate || pending || index === 0}
            onClick={() => move(index, -1)}
            type="button"
          >
            ↑
          </button>
          <button
            aria-label="下移"
            disabled={!canOperate || pending || index === queued.length - 1}
            onClick={() => move(index, 1)}
            type="button"
          >
            ↓
          </button>
        </div>
      ))}
      {!running && queued.length === 0 ? <small>队列为空</small> : null}
    </div>
  );
}

function quietCountdown(deadline: number) {
  const remaining = Math.max(0, deadline - Date.now());
  if (remaining === 0) return '静默期已满足，等待执行器冻结';
  const seconds = Math.ceil(remaining / 1_000);
  const minutes = Math.floor(seconds / 60);
  return `静默期 ${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

type CollaborativeDragTransition = {
  command: CollaborativeCommand;
  message: string;
};

function collaborativeDragTransition(
  bug: SubmissionBug,
  targetStatus: BugStatus,
  currentUser: CurrentUser,
  submissionStatus: TestSubmissionDetail['status'],
): CollaborativeDragTransition | null {
  if (submissionStatus !== 'ACTIVE' || bug.status === targetStatus) return null;
  const label = bug.shortId.replace(/^BUG-/, '缺陷-');
  const canEnqueueRepair =
    currentUser.accountType === 'DEVELOPER' ||
    (currentUser.accountType === 'TESTER' &&
      bug.createdByUserId === currentUser.id);

  if (
    canEnqueueRepair &&
    bug.status === 'WAITING_FOR_REPAIR' &&
    bug.submissionItemId &&
    targetStatus === 'REPAIRING'
  )
    return {
      command: {
        kind: 'repair_task.enqueue',
        bugId: bug.id,
        insertAtFront: true,
      },
      message: `${label} 已加入修复队列。`,
    };

  if (
    canEnqueueRepair &&
    bug.status === 'REPAIRING' &&
    ['QUEUED', 'PREPARING'].includes(bug.repairActivity ?? '') &&
    targetStatus === 'WAITING_FOR_REPAIR'
  )
    return {
      command: { kind: 'repair_task.withdraw', bugId: bug.id },
      message: `${label} 已撤回修复队列。`,
    };

  if (
    currentUser.accountType === 'TESTER' &&
    bug.status === 'WAITING_FOR_VERIFICATION' &&
    targetStatus === 'DONE'
  )
    return {
      command: { kind: 'bug.move', bugId: bug.id, targetStatus: 'DONE' },
      message: `${label} 已验证完成。`,
    };

  return null;
}

export function BugBoard({
  currentUser,
  snapshot,
  pending,
  mutate,
  onBugSaved,
}: {
  currentUser: CurrentUser;
  snapshot: WorkspaceSnapshot;
  pending: boolean;
  mutate: (
    command: CollaborativeCommand,
    message: string | null,
  ) => Promise<boolean>;
  onBugSaved: (bugId: string, message: string) => Promise<void>;
}) {
  const canCreateBug =
    currentUser.accountType === 'TESTER' &&
    snapshot.submission.status === 'ACTIVE';
  const [draggingBugId, setDraggingBugId] = useState<string | null>(null);
  const [dropTargetStatus, setDropTargetStatus] = useState<BugStatus | null>(
    null,
  );
  const [bugDrawer, setBugDrawer] = useState<BugDrawerState | null>(null);
  const draggingBug = snapshot.bugs.find((bug) => bug.id === draggingBugId);

  function finishDrag() {
    setDraggingBugId(null);
    setDropTargetStatus(null);
  }

  function dropBug(
    event: ReactDragEvent<HTMLElement>,
    targetStatus: BugStatus,
  ) {
    const bugId =
      event.dataTransfer.getData('application/x-collaborative-bug-id') ||
      draggingBugId;
    const bug = snapshot.bugs.find((candidate) => candidate.id === bugId);
    if (!bug) return;
    const transition = collaborativeDragTransition(
      bug,
      targetStatus,
      currentUser,
      snapshot.submission.status,
    );
    if (!transition) return;
    event.preventDefault();
    finishDrag();
    void mutate(transition.command, transition.message);
  }

  return (
    <section className="collab-board-section">
      <div className="collab-section-label collab-board-heading">
        <span>{snapshot.submission.title} · 缺陷看板</span>
        <DeveloperOperations
          currentUser={currentUser}
          mutate={mutate}
          pending={pending}
          snapshot={snapshot}
        />
        <div className="collab-board-heading__actions">
          <small>每 3 秒同步控制平面</small>
          {canCreateBug ? (
            <button
              disabled={pending}
              onClick={() => setBugDrawer({ mode: 'create' })}
              type="button"
            >
              ＋ 登记缺陷
            </button>
          ) : null}
        </div>
      </div>
      <div className="collab-board">
        {STATUS_COLUMNS.map((column) => {
          const bugs = snapshot.bugs.filter(
            (bug) => bug.status === column.status,
          );
          const acceptsDrop = Boolean(
            draggingBug &&
            collaborativeDragTransition(
              draggingBug,
              column.status,
              currentUser,
              snapshot.submission.status,
            ),
          );
          return (
            <section
              className="collab-column"
              data-drop-target={
                acceptsDrop && dropTargetStatus === column.status
                  ? 'true'
                  : undefined
              }
              key={column.status}
              onDragEnter={() => {
                if (acceptsDrop) setDropTargetStatus(column.status);
              }}
              onDragLeave={(event) => {
                if (
                  event.relatedTarget instanceof Node &&
                  event.currentTarget.contains(event.relatedTarget)
                )
                  return;
                if (dropTargetStatus === column.status)
                  setDropTargetStatus(null);
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
                {bugs.map((bug) => (
                  <BugCard
                    bug={bug}
                    draggable={
                      !pending &&
                      STATUS_COLUMNS.some(
                        (candidate) =>
                          candidate.status !== bug.status &&
                          collaborativeDragTransition(
                            bug,
                            candidate.status,
                            currentUser,
                            snapshot.submission.status,
                          ),
                      )
                    }
                    dragging={draggingBugId === bug.id}
                    key={bug.id}
                    onDragEnd={finishDrag}
                    onDragStart={(event) => {
                      setDraggingBugId(bug.id);
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData(
                        'application/x-collaborative-bug-id',
                        bug.id,
                      );
                    }}
                    onOpen={() => setBugDrawer({ mode: 'view', bugId: bug.id })}
                  />
                ))}
                {bugs.length === 0 ? (
                  <p className="collab-column__empty">暂无卡片</p>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>

      {bugDrawer ? (
        <BugDrawer
          currentUser={currentUser}
          drawer={bugDrawer}
          mutate={mutate}
          onClose={() => setBugDrawer(null)}
          onEdit={(bugId) => setBugDrawer({ mode: 'edit', bugId })}
          onSaved={async (bugId, message) => {
            await onBugSaved(bugId, message);
            setBugDrawer({ mode: 'view', bugId });
          }}
          pending={pending}
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
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  bug: SubmissionBug;
  draggable: boolean;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}) {
  const visualState = bugVisualState(bug);
  return (
    <article
      aria-label={`${bug.title}，${bugVisualLabel(bug)}`}
      className={`collab-bug-card${draggable ? ' collab-bug-card--draggable' : ''}`}
      data-dragging={dragging ? 'true' : undefined}
      data-visual-state={visualState}
      draggable={draggable}
      onClick={onOpen}
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <span aria-hidden="true" className="collab-bug-card__state" />
      <h3>{bug.title}</h3>
    </article>
  );
}

function bugVisualState(bug: SubmissionBug) {
  if (bug.status === 'WAITING_FOR_REPAIR' && bug.latestRepairFailed)
    return 'failed';
  if (bug.repairActivity === 'QUEUED') return 'queued';
  if (bug.repairActivity === 'PREPARING') return 'preparing';
  if (bug.repairActivity === 'RUNNING') return 'running';
  if (bug.repairActivity === 'WAITING_INTERACTION')
    return 'waiting-interaction';
  return 'idle';
}

function bugVisualLabel(bug: SubmissionBug) {
  if (bug.status === 'WAITING_FOR_REPAIR' && bug.latestRepairFailed)
    return '最近一次修复失败';
  if (bug.repairActivity === 'QUEUED') return '等待修复';
  if (bug.repairActivity === 'PREPARING') return '正在启动修复';
  if (bug.repairActivity === 'RUNNING') return 'Codex 正在修复';
  if (bug.repairActivity === 'WAITING_INTERACTION') return '等待开发负责人处理';
  return '缺陷卡片';
}
