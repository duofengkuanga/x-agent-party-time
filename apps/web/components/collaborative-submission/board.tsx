'use client';

import { useState } from 'react';
import type {
  CodexInteractionRequest,
  CollaborativeCommand,
  SubmissionBug,
  SubmissionRepairTask,
  SubmissionUpdateBatch,
  TestSubmissionDetail,
  TestSubmissionSummary,
} from '@agent-party-time/shared/control-plane';
import type { CurrentUser } from '@/lib/auth/core';
import {
  bugLabel,
  downloadAttachment,
  formatBytes,
  formatCompactDate,
  formatDateTime,
} from './client';
import {
  DEPLOYMENT_TYPE_LABELS,
  ENGINEERING_TYPE_LABELS,
  EXECUTION_KIND_LABELS,
  INTERACTION_KIND_LABELS,
  STATUS_COLUMNS,
  SUBMISSION_STATUS_LABELS,
  UPDATE_BATCH_STATE_LABELS,
  type SubmissionItem,
  type WorkspaceSnapshot,
} from './model';
import { ExternalFailureDialog, ItemConfigurationDialog } from './dialogs';

export function SubmissionRail({
  currentUser,
  submissions,
  selectedId,
  loading,
  refreshing,
  includeClosed,
  onSelect,
  onRefresh,
  onCreate,
  onIncludeClosedChange,
}: {
  currentUser: CurrentUser;
  submissions: TestSubmissionSummary[];
  selectedId: string | null;
  loading: boolean;
  refreshing: boolean;
  includeClosed: boolean;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onCreate: () => void;
  onIncludeClosedChange: (value: boolean) => void;
}) {
  return (
    <aside className="collab-rail">
      <div className="collab-rail__heading">
        <h2>提测单</h2>
        <button
          aria-label="刷新"
          disabled={refreshing}
          onClick={onRefresh}
          type="button"
        >
          {refreshing ? '…' : '↻'}
        </button>
      </div>
      <label className="collab-check">
        <input
          checked={includeClosed}
          onChange={(event) => onIncludeClosedChange(event.target.checked)}
          type="checkbox"
        />
        <span>包含已关闭提测单</span>
      </label>
      <nav className="collab-submission-list" aria-label="提测单列表">
        {submissions.map((submission) => (
          <button
            aria-current={submission.id === selectedId ? 'page' : undefined}
            key={submission.id}
            onClick={() => onSelect(submission.id)}
            type="button"
          >
            <span className="collab-submission-list__meta">
              <b>{submission.status === 'ACTIVE' ? '进行中' : '已关闭'}</b>
              <time>{formatCompactDate(submission.updatedAt)}</time>
            </span>
            <strong>{submission.title}</strong>
            <small>
              {submission.tester.displayName} · {submission.itemCount} 工程
            </small>
            <span className="collab-count-strip">
              <i>{submission.bugCounts.waitingForRepair}</i>
              <i>{submission.bugCounts.repairing}</i>
              <i>{submission.bugCounts.waitingForUpdate}</i>
              <i>{submission.bugCounts.updating}</i>
              <i>{submission.bugCounts.waitingForVerification}</i>
              <i>{submission.bugCounts.done}</i>
            </span>
          </button>
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
      ) : (
        <p className="collab-rail__privacy">
          测试视图已隐藏仓库、执行器、分支、命令、提交记录、会话与持续集成技术错误。
        </p>
      )}
    </aside>
  );
}

export function SubmissionHeader({
  currentUser,
  snapshot,
  pending,
  onCreateBug,
  onClose,
}: {
  currentUser: CurrentUser;
  snapshot: WorkspaceSnapshot;
  pending: boolean;
  onCreateBug: () => void;
  onClose: () => void;
}) {
  const { submission, bugs } = snapshot;
  const canClose =
    currentUser.accountType === 'TESTER' &&
    submission.status === 'ACTIVE' &&
    bugs.every((bug) => bug.status === 'DONE');
  return (
    <header className="collab-submission-header">
      <div className="collab-submission-header__copy">
        <p>
          <span>{SUBMISSION_STATUS_LABELS[submission.status]}</span>
          <b>#{submission.id.slice(0, 8)}</b>
        </p>
        <h1>{submission.title}</h1>
        <p className="collab-submission-header__description">
          {submission.requirementDescription}
        </p>
      </div>
      <dl className="collab-submission-facts">
        <div>
          <dt>测试负责人</dt>
          <dd>{submission.tester.displayName}</dd>
        </div>
        <div>
          <dt>工程 / 缺陷</dt>
          <dd>
            {submission.items.length} / {bugs.length}
          </dd>
        </div>
        <div>
          <dt>创建时间</dt>
          <dd>{formatDateTime(submission.createdAt)}</dd>
        </div>
      </dl>
      {currentUser.accountType === 'TESTER' &&
      submission.status === 'ACTIVE' ? (
        <div className="collab-submission-header__actions">
          <button className="collab-primary" onClick={onCreateBug}>
            ＋ 登记缺陷
          </button>
          <button
            disabled={!canClose || pending}
            onClick={onClose}
            type="button"
          >
            关闭提测单
          </button>
          {!canClose ? <small>所有缺陷完成后可关闭</small> : null}
        </div>
      ) : null}
    </header>
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
  mutate: (command: CollaborativeCommand, message: string) => Promise<boolean>;
}) {
  return (
    <section className="collab-operations">
      <div className="collab-section-label">
        <span>开发操作</span>
        <small>更新优先 · 交互等待释放执行槽 · 回答后下一调度点恢复</small>
      </div>
      <div className="collab-engineering-grid">
        {snapshot.submission.items.map((item) => (
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
    </section>
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
  mutate: (command: CollaborativeCommand, message: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
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

  return (
    <article className="collab-engineering-card">
      <header>
        <div>
          <span>{ENGINEERING_TYPE_LABELS[item.engineeringType]}</span>
          <h3>{item.engineeringDisplayName}</h3>
        </div>
        <b>
          {technical
            ? DEPLOYMENT_TYPE_LABELS[technical.environment.deploymentType]
            : '已隐藏'}
        </b>
      </header>
      {technical ? (
        <dl>
          <div>
            <dt>负责人</dt>
            <dd>{item.responsibleDeveloper.displayName}</dd>
          </div>
          <div>
            <dt>执行器</dt>
            <dd>{technical.runnerId.slice(0, 8)}</dd>
          </div>
          <div>
            <dt>目标分支</dt>
            <dd>{technical.targetBranch}</dd>
          </div>
          <div>
            <dt>环境</dt>
            <dd>{technical.environment.displayName}</dd>
          </div>
        </dl>
      ) : null}
      {!canOperate ? (
        <p className="collab-operation-owner">
          仅工程负责人 {item.responsibleDeveloper.displayName} 可操作
        </p>
      ) : null}
      <div className="collab-engineering-card__actions">
        <button
          disabled={!canOperate || pending || waitingCandidates.length === 0}
          onClick={() =>
            mutate(
              { kind: 'update.trigger', submissionItemId: item.id },
              `${item.engineeringDisplayName} 已冻结当前待更新列表。`,
            )
          }
          type="button"
        >
          立即更新
        </button>
        {!item.lockedAt && technical && canOperate ? (
          <button onClick={() => setEditing(true)} type="button">
            技术配置
          </button>
        ) : null}
      </div>
      <div className="collab-waiting-update">
        <span>等待更新</span>
        {waitingCandidates.length ? (
          <>
            <strong>
              {waitingCandidates.length} 个候选 ·{' '}
              {quietDeadline ? quietCountdown(quietDeadline) : '等待冻结'}
            </strong>
            <ul>
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
          <small>当前没有待冻结候选</small>
        )}
      </div>
      <RepairQueue
        bugs={snapshot.bugs}
        canOperate={canOperate}
        item={item}
        mutate={mutate}
        pending={pending}
        repairTasks={repairTasks}
      />
      <div className="collab-batch-status">
        <span>更新批次</span>
        {activeBatch ? (
          <>
            <strong>{UPDATE_BATCH_STATE_LABELS[activeBatch.state]}</strong>
            <small>
              {activeBatch.bugIds.length} 个缺陷 ·{' '}
              {activeBatch.candidateCommits.length} 个候选提交
            </small>
            {activeBatch.externalFailure ? (
              <p>{activeBatch.externalFailure}</p>
            ) : null}
            {activeBatch.state === 'WAITING_EXTERNAL' ? (
              <div>
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
            {activeBatch.state === 'FAILED' ? (
              <div className="collab-update-continue">
                <textarea
                  onChange={(event) => setContinueFeedback(event.target.value)}
                  placeholder="说明已处理事项或下一步要求；将在原 Codex 会话中输入“继续”"
                  rows={3}
                  value={continueFeedback}
                />
                <button
                  disabled={
                    !canOperate ||
                    pending ||
                    continueFeedback.trim().length === 0
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
          </>
        ) : (
          <small>暂无进行中的更新批次</small>
        )}
      </div>
      {editing && technical ? (
        <ItemConfigurationDialog
          item={item}
          onClose={() => setEditing(false)}
          onSaved={() => setEditing(false)}
          mutate={mutate}
        />
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
  mutate: (command: CollaborativeCommand, message: string) => Promise<boolean>;
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
      <span>修复队列</span>
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

function CodexInteractionSection({
  currentUser,
  snapshot,
  pending,
  mutate,
}: {
  currentUser: CurrentUser;
  snapshot: WorkspaceSnapshot;
  pending: boolean;
  mutate: (command: CollaborativeCommand, message: string) => Promise<boolean>;
}) {
  const interactions = snapshot.submission.items.flatMap((item) =>
    (snapshot.interactions[item.id] ?? []).map((interaction) => ({
      interaction,
      item,
    })),
  );
  if (interactions.length === 0) return null;
  return (
    <section className="collab-interactions">
      <div className="collab-section-label">
        <span>Codex 等待响应</span>
        <small>等待期间不占普通执行槽；不会取消或打断其他轮次</small>
      </div>
      <div className="collab-interaction-grid">
        {interactions.map(({ interaction, item }) => (
          <CodexInteractionCard
            canRespond={currentUser.id === item.responsibleDeveloper.id}
            interaction={interaction}
            item={item}
            key={interaction.id}
            mutate={mutate}
            pending={pending}
          />
        ))}
      </div>
    </section>
  );
}

function CodexInteractionCard({
  interaction,
  item,
  canRespond,
  pending,
  mutate,
}: {
  interaction: CodexInteractionRequest;
  item: SubmissionItem;
  canRespond: boolean;
  pending: boolean;
  mutate: (command: CollaborativeCommand, message: string) => Promise<boolean>;
}) {
  const questions = userInputQuestions(interaction);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const permissionDetails = interactionPermissionDetails(interaction);
  const answerReady =
    questions.length > 0 &&
    questions.every(
      (question) => (answers[question.id] ?? '').trim().length > 0,
    );

  return (
    <article className="collab-interaction-card">
      <header>
        <div>
          <span>{INTERACTION_KIND_LABELS[interaction.kind]}</span>
          <h3>{item.engineeringDisplayName}</h3>
        </div>
        <b>{EXECUTION_KIND_LABELS[interaction.executionKind]}</b>
      </header>
      <p>{interactionTitle(interaction)}</p>
      {permissionDetails.length ? (
        <dl>
          {permissionDetails.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {questions.map((question) => (
        <label key={question.id}>
          <span>{question.header || question.question}</span>
          <small>{question.question}</small>
          <input
            disabled={!canRespond || pending}
            list={
              question.options?.length
                ? `${interaction.id}-${question.id}`
                : undefined
            }
            onChange={(event) =>
              setAnswers((current) => ({
                ...current,
                [question.id]: event.target.value,
              }))
            }
            type={question.isSecret ? 'password' : 'text'}
            value={answers[question.id] ?? ''}
          />
          {question.options?.length ? (
            <datalist id={`${interaction.id}-${question.id}`}>
              {question.options.map((option) => (
                <option key={option.label} value={option.label}>
                  {option.description}
                </option>
              ))}
            </datalist>
          ) : null}
        </label>
      ))}
      {canRespond ? (
        interaction.kind === 'PERMISSION' ? (
          <div className="collab-interaction-actions">
            <button
              disabled={pending}
              onClick={() =>
                mutate(
                  {
                    kind: 'interaction.resolve',
                    interactionId: interaction.id,
                    action: 'DECLINE',
                  },
                  '已按 Codex 原生拒绝逻辑响应。',
                )
              }
              type="button"
            >
              拒绝
            </button>
            {supportsNativeAlwaysAllow(interaction) ? (
              <button
                className="collab-primary"
                disabled={pending}
                onClick={() =>
                  mutate(
                    {
                      kind: 'interaction.resolve',
                      interactionId: interaction.id,
                      action: 'ACCEPT_FOR_SESSION',
                    },
                    '已按 Codex 原生会话范围始终允许。',
                  )
                }
                type="button"
              >
                始终允许
              </button>
            ) : null}
          </div>
        ) : (
          <button
            className="collab-primary"
            disabled={pending || !answerReady}
            onClick={() =>
              mutate(
                {
                  kind: 'interaction.resolve',
                  interactionId: interaction.id,
                  action: 'ANSWER',
                  answers: Object.fromEntries(
                    questions.map((question) => [
                      question.id,
                      [(answers[question.id] ?? '').trim()],
                    ]),
                  ),
                },
                '用户输入已提交；当前运行轮次结束后优先恢复。',
              )
            }
            type="button"
          >
            提交回答
          </button>
        )
      ) : (
        <small className="collab-interaction-waiting">
          等待工程负责人 {item.responsibleDeveloper.displayName} 响应
        </small>
      )}
    </article>
  );
}

type UserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
};

function userInputQuestions(interaction: CodexInteractionRequest) {
  if (interaction.kind !== 'USER_INPUT') return [];
  const raw = interaction.payload.questions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((question): UserInputQuestion[] => {
    if (!question || typeof question !== 'object') return [];
    const value = question as Record<string, unknown>;
    if (typeof value.id !== 'string' || typeof value.question !== 'string')
      return [];
    const options = Array.isArray(value.options)
      ? value.options.flatMap((option) => {
          if (!option || typeof option !== 'object') return [];
          const candidate = option as Record<string, unknown>;
          return typeof candidate.label === 'string'
            ? [
                {
                  label: candidate.label,
                  description:
                    typeof candidate.description === 'string'
                      ? candidate.description
                      : '',
                },
              ]
            : [];
        })
      : null;
    return [
      {
        id: value.id,
        header: typeof value.header === 'string' ? value.header : '',
        question: value.question,
        isSecret: value.isSecret === true,
        options,
      },
    ];
  });
}

function interactionTitle(interaction: CodexInteractionRequest) {
  if (interaction.kind === 'USER_INPUT') return 'Codex 正在等待用户输入';
  return {
    'item/commandExecution/requestApproval': 'Codex 请求执行命令',
    'item/fileChange/requestApproval': 'Codex 请求扩展文件写入范围',
    'item/permissions/requestApproval': 'Codex 请求权限',
    'item/tool/requestUserInput': 'Codex 正在等待用户输入',
  }[interaction.method];
}

function supportsNativeAlwaysAllow(interaction: CodexInteractionRequest) {
  if (interaction.method !== 'item/commandExecution/requestApproval')
    return true;
  const available = interaction.payload.availableDecisions;
  if (!Array.isArray(available)) return true;
  return available.some((decision) => {
    if (decision === 'acceptForSession') return true;
    if (!decision || typeof decision !== 'object') return false;
    return (
      'acceptWithExecpolicyAmendment' in decision ||
      'applyNetworkPolicyAmendment' in decision
    );
  });
}

function interactionPermissionDetails(
  interaction: CodexInteractionRequest,
): Array<[string, string]> {
  if (interaction.kind !== 'PERMISSION') return [];
  const payload = interaction.payload;
  const values: Array<[string, unknown]> = [
    ['原因', payload.reason],
    ['命令', payload.command],
    ['工作目录', payload.cwd],
    ['写入范围', payload.grantRoot],
    ['权限', payload.permissions],
  ];
  return values.flatMap(([label, value]) => {
    if (value === null || value === undefined || value === '') return [];
    return [[label, typeof value === 'string' ? value : JSON.stringify(value)]];
  });
}

export function BugBoard({
  currentUser,
  snapshot,
  pending,
  mutate,
}: {
  currentUser: CurrentUser;
  snapshot: WorkspaceSnapshot;
  pending: boolean;
  mutate: (command: CollaborativeCommand, message: string) => Promise<boolean>;
}) {
  return (
    <section className="collab-board-section">
      <div className="collab-section-label">
        <span>六状态缺陷看板</span>
        <small>每 3 秒同步控制平面</small>
      </div>
      <CodexInteractionSection
        currentUser={currentUser}
        mutate={mutate}
        pending={pending}
        snapshot={snapshot}
      />
      <div className="collab-board">
        {STATUS_COLUMNS.map((column) => {
          const bugs = snapshot.bugs.filter(
            (bug) => bug.status === column.status,
          );
          return (
            <section className="collab-column" key={column.status}>
              <header>
                <span>{column.note}</span>
                <h2>{column.label}</h2>
                <b>{bugs.length.toString().padStart(2, '0')}</b>
              </header>
              <div className="collab-column__cards">
                {bugs.map((bug) => (
                  <BugCard
                    bug={bug}
                    currentUser={currentUser}
                    items={snapshot.submission.items}
                    key={bug.id}
                    mutate={mutate}
                    pending={pending}
                    submissionStatus={snapshot.submission.status}
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
    </section>
  );
}

function BugCard({
  bug,
  items,
  currentUser,
  submissionStatus,
  pending,
  mutate,
}: {
  bug: SubmissionBug;
  items: SubmissionItem[];
  currentUser: CurrentUser;
  submissionStatus: TestSubmissionDetail['status'];
  pending: boolean;
  mutate: (command: CollaborativeCommand, message: string) => Promise<boolean>;
}) {
  const [feedback, setFeedback] = useState('');
  const [triageItemId, setTriageItemId] = useState(items[0]?.id ?? '');
  const isDeveloper = currentUser.accountType === 'DEVELOPER';
  const active = submissionStatus === 'ACTIVE';

  return (
    <article className="collab-bug-card">
      <header>
        <b>{bug.shortId.replace(/^BUG-/, '缺陷-')}</b>
        <time>{formatCompactDate(bug.updatedAt)}</time>
      </header>
      <h3>{bug.title}</h3>
      <span className="collab-bug-card__engineering">
        {bug.engineeringDisplayName ?? '待开发分诊工程'}
      </span>
      <details>
        <summary>复现与期望</summary>
        <dl>
          <div>
            <dt>操作路径</dt>
            <dd>{bug.operationPath}</dd>
          </div>
          <div>
            <dt>实际结果</dt>
            <dd>{bug.actualResult}</dd>
          </div>
          <div>
            <dt>期望结果</dt>
            <dd>{bug.expectedResult}</dd>
          </div>
          {bug.supplementalDescription ? (
            <div>
              <dt>补充说明</dt>
              <dd>{bug.supplementalDescription}</dd>
            </div>
          ) : null}
        </dl>
      </details>
      {bug.latestFeedback ? (
        <p className="collab-bug-card__feedback">{bug.latestFeedback}</p>
      ) : null}
      {bug.attachments.length ? (
        <ul className="collab-attachments">
          {bug.attachments.map((attachment) => (
            <li key={attachment.id}>
              <button
                onClick={() => void downloadAttachment(attachment.id)}
                type="button"
              >
                ↧ {attachment.fileName}
              </button>
              <small>{formatBytes(attachment.sizeBytes)}</small>
            </li>
          ))}
        </ul>
      ) : null}
      {isDeveloper && bug.candidateCommit ? (
        <p className="collab-candidate">
          候选提交 <code>{bug.candidateCommit}</code>
        </p>
      ) : null}
      {active ? (
        <div className="collab-bug-card__actions">
          {isDeveloper &&
          bug.status === 'WAITING_FOR_REPAIR' &&
          !bug.submissionItemId ? (
            <>
              <select
                aria-label="分诊工程"
                onChange={(event) => setTriageItemId(event.target.value)}
                value={triageItemId}
              >
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.engineeringDisplayName}
                  </option>
                ))}
              </select>
              <button
                disabled={!triageItemId || pending}
                onClick={() =>
                  mutate(
                    {
                      kind: 'bug.triage',
                      bugId: bug.id,
                      submissionItemId: triageItemId,
                    },
                    `${bug.shortId.replace(/^BUG-/, '缺陷-')} 已完成工程分诊。`,
                  )
                }
                type="button"
              >
                确认分诊
              </button>
            </>
          ) : null}
          {isDeveloper &&
          bug.status === 'WAITING_FOR_REPAIR' &&
          bug.submissionItemId ? (
            <button
              className="collab-primary"
              disabled={pending}
              onClick={() =>
                mutate(
                  {
                    kind: 'bug.move',
                    bugId: bug.id,
                    targetStatus: 'REPAIRING',
                    insertAtFront: true,
                  },
                  `${bug.shortId.replace(/^BUG-/, '缺陷-')} 已加入修复队列。`,
                )
              }
              type="button"
            >
              立即开始修复
            </button>
          ) : null}
          {isDeveloper && bug.status === 'REPAIRING' ? (
            <button
              disabled={pending}
              onClick={() =>
                mutate(
                  {
                    kind: 'bug.move',
                    bugId: bug.id,
                    targetStatus: 'WAITING_FOR_REPAIR',
                    insertAtFront: false,
                  },
                  `${bug.shortId.replace(/^BUG-/, '缺陷-')} 已撤回待修复。`,
                )
              }
              type="button"
            >
              撤回排队
            </button>
          ) : null}
          {!isDeveloper && bug.status === 'WAITING_FOR_VERIFICATION' ? (
            <>
              <button
                className="collab-primary"
                disabled={pending}
                onClick={() =>
                  mutate(
                    {
                      kind: 'bug.move',
                      bugId: bug.id,
                      targetStatus: 'DONE',
                      insertAtFront: false,
                    },
                    `${bug.shortId.replace(/^BUG-/, '缺陷-')} 已验证完成。`,
                  )
                }
                type="button"
              >
                验证通过
              </button>
              <FeedbackAction
                feedback={feedback}
                label="验证失败并立即返修"
                onChange={setFeedback}
                onSubmit={() =>
                  mutate(
                    {
                      kind: 'bug.move',
                      bugId: bug.id,
                      targetStatus: 'REPAIRING',
                      feedback,
                      insertAtFront: true,
                    },
                    `${bug.shortId.replace(/^BUG-/, '缺陷-')} 已带反馈重新进入修复。`,
                  )
                }
                pending={pending}
              />
            </>
          ) : null}
          {!isDeveloper && bug.status === 'DONE' ? (
            <FeedbackAction
              feedback={feedback}
              label="重新打开"
              onChange={setFeedback}
              onSubmit={() =>
                mutate(
                  {
                    kind: 'bug.move',
                    bugId: bug.id,
                    targetStatus: 'REPAIRING',
                    feedback,
                    insertAtFront: true,
                  },
                  `${bug.shortId.replace(/^BUG-/, '缺陷-')} 已重新打开。`,
                )
              }
              pending={pending}
            />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function FeedbackAction({
  label,
  feedback,
  pending,
  onChange,
  onSubmit,
}: {
  label: string;
  feedback: string;
  pending: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="collab-feedback-action">
      <textarea
        onChange={(event) => onChange(event.target.value)}
        placeholder="必填：描述仍然存在的问题与复现结果"
        rows={3}
        value={feedback}
      />
      <button
        disabled={pending || feedback.trim().length === 0}
        onClick={onSubmit}
        type="button"
      >
        {label}
      </button>
    </div>
  );
}
