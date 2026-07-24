'use client';

import {
  useEffect,
  useMemo,
  useState,
  useTransition,
  type FormEvent,
} from 'react';
import type {
  CodexInteractionRequest,
  CollaborativeCommand,
  SubmissionBug,
} from '@agent-party-time/shared/control-plane';
import type { CurrentUser } from '@/lib/auth/core';
import {
  collaborativeCommand,
  downloadAttachment,
  fileUpload,
  formatBytes,
  formatDateTime,
  messageOf,
} from './client';
import {
  ENGINEERING_TYPE_LABELS,
  STATUS_COLUMNS,
  type SubmissionItem,
  type WorkspaceSnapshot,
} from './model';

export type BugDrawerState =
  { mode: 'create' } | { mode: 'view' | 'edit'; bugId: string };

export function BugDrawer({
  currentUser,
  drawer,
  snapshot,
  pending,
  mutate,
  onClose,
  onEdit,
  onSaved,
}: {
  currentUser: CurrentUser;
  drawer: BugDrawerState;
  snapshot: WorkspaceSnapshot;
  pending: boolean;
  mutate: (
    command: CollaborativeCommand,
    message: string | null,
  ) => Promise<boolean>;
  onClose: () => void;
  onEdit: (bugId: string) => void;
  onSaved: (bugId: string, message: string) => Promise<void>;
}) {
  const bug =
    drawer.mode === 'create'
      ? null
      : (snapshot.bugs.find((candidate) => candidate.id === drawer.bugId) ??
        null);
  const interaction = bug ? findBugInteraction(bug, snapshot) : undefined;
  const canEditContent = Boolean(
    bug &&
    bug.status === 'WAITING_FOR_REPAIR' &&
    bug.createdByUserId === currentUser.id,
  );
  const canEditAssignment = Boolean(
    bug &&
    bug.status === 'WAITING_FOR_REPAIR' &&
    (bug.createdByUserId === currentUser.id ||
      currentUser.accountType === 'DEVELOPER'),
  );

  if (drawer.mode !== 'create' && !bug) return null;

  return (
    <div className="collab-drawer-scrim" role="presentation">
      <section
        aria-label={drawerTitle(drawer.mode, bug)}
        aria-modal="true"
        className="collab-bug-drawer"
        role="dialog"
      >
        <header>
          <div>
            <small>{drawer.mode === 'create' ? '新缺陷' : bug!.shortId}</small>
            <h2>{drawerTitle(drawer.mode, bug)}</h2>
          </div>
          <button aria-label="关闭缺陷抽屉" onClick={onClose} type="button">
            ×
          </button>
        </header>

        {drawer.mode === 'view' ? (
          <BugView
            bug={bug!}
            currentUser={currentUser}
            interaction={interaction}
            mutate={mutate}
            onEdit={
              canEditContent || canEditAssignment ? () => onEdit(bug!.id) : null
            }
            pending={pending}
            snapshot={snapshot}
          />
        ) : (
          <BugForm
            bug={bug}
            canEditAssignment={drawer.mode === 'create' || canEditAssignment}
            canEditContent={drawer.mode === 'create' || canEditContent}
            items={snapshot.submission.items}
            mode={drawer.mode}
            onCancel={onClose}
            onSaved={onSaved}
            submissionId={snapshot.submission.id}
          />
        )}
      </section>
    </div>
  );
}

export function findBugInteraction(
  bug: SubmissionBug,
  snapshot: WorkspaceSnapshot,
) {
  const repairTask = Object.values(snapshot.repairQueues)
    .flat()
    .find((task) => task.bugId === bug.id);
  const updateBatch = bug.submissionItemId
    ? (snapshot.updateBatches[bug.submissionItemId] ?? []).find(
        (batch) =>
          batch.bugIds.includes(bug.id) &&
          ['QUEUED', 'RUNNING', 'WAITING_EXTERNAL', 'FAILED'].includes(
            batch.state,
          ),
      )
    : undefined;
  const execution =
    bug.status === 'UPDATING' && updateBatch
      ? { kind: 'UPDATE', id: updateBatch.id }
      : repairTask
        ? { kind: 'REPAIR', id: repairTask.id }
        : null;
  if (!execution) return undefined;
  return Object.values(snapshot.interactions)
    .flat()
    .find(
      (candidate) =>
        candidate.executionKind === execution.kind &&
        candidate.executionId === execution.id,
    );
}

function BugForm({
  mode,
  bug,
  items,
  submissionId,
  canEditContent,
  canEditAssignment,
  onCancel,
  onSaved,
}: {
  mode: 'create' | 'edit';
  bug: SubmissionBug | null;
  items: SubmissionItem[];
  submissionId: string;
  canEditContent: boolean;
  canEditAssignment: boolean;
  onCancel: () => void;
  onSaved: (bugId: string, message: string) => Promise<void>;
}) {
  const [engineeringType, setEngineeringType] = useState<
    '' | 'FRONTEND' | 'BACKEND'
  >(bug?.engineeringType ?? '');
  const [submissionItemId, setSubmissionItemId] = useState(
    bug?.submissionItemId ?? '',
  );
  const [title, setTitle] = useState(bug?.title ?? '');
  const [operationPath, setOperationPath] = useState(bug?.operationPath ?? '');
  const [actualResult, setActualResult] = useState(bug?.actualResult ?? '');
  const [expectedResult, setExpectedResult] = useState(
    bug?.expectedResult ?? '',
  );
  const [supplementalDescription, setSupplementalDescription] = useState(
    bug?.supplementalDescription ?? '',
  );
  const [existingAttachmentIds, setExistingAttachmentIds] = useState(
    bug?.attachments.map((attachment) => attachment.id) ?? [],
  );
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const filteredItems = useMemo(
    () =>
      engineeringType
        ? items.filter((item) => item.engineeringType === engineeringType)
        : [],
    [engineeringType, items],
  );

  useEffect(() => {
    if (
      submissionItemId &&
      !filteredItems.some((item) => item.id === submissionItemId)
    )
      setSubmissionItemId('');
  }, [filteredItems, submissionItemId]);

  function submit(event: FormEvent) {
    event.preventDefault();
    startSaving(async () => {
      try {
        if (!canEditContent && bug) {
          const result = await collaborativeCommand({
            kind: 'bug.assign',
            bugId: bug.id,
            engineeringType: engineeringType || null,
            submissionItemId: submissionItemId || null,
          });
          await onSaved(result.bug!.id, '问题归属已更新。');
          return;
        }
        const attachments = await Promise.all(files.map(fileUpload));
        const result = await collaborativeCommand(
          mode === 'create'
            ? {
                kind: 'bug.create',
                submissionId,
                engineeringType: engineeringType || null,
                submissionItemId: submissionItemId || null,
                title,
                operationPath,
                actualResult,
                expectedResult,
                supplementalDescription,
                attachments,
              }
            : {
                kind: 'bug.update',
                bugId: bug!.id,
                engineeringType: engineeringType || null,
                submissionItemId: submissionItemId || null,
                title,
                operationPath,
                actualResult,
                expectedResult,
                supplementalDescription,
                existingAttachmentIds,
                attachments,
              },
        );
        await onSaved(
          result.bug!.id,
          mode === 'create' ? '缺陷已登记。' : '缺陷已保存。',
        );
      } catch (requestError) {
        setError(messageOf(requestError, '无法保存缺陷'));
      }
    });
  }

  return (
    <form className="collab-bug-drawer__body collab-bug-form" onSubmit={submit}>
      <fieldset disabled={!canEditAssignment || saving}>
        <legend>问题归属</legend>
        <div className="collab-bug-form__grid">
          <label>
            <span>问题类型</span>
            <select
              onChange={(event) => {
                setEngineeringType(
                  event.target.value as '' | 'FRONTEND' | 'BACKEND',
                );
                setSubmissionItemId('');
              }}
              value={engineeringType}
            >
              <option value="">暂不确定</option>
              <option value="FRONTEND">前端</option>
              <option value="BACKEND">后端</option>
            </select>
          </label>
          <label>
            <span>具体工程</span>
            <select
              disabled={!engineeringType || !canEditAssignment || saving}
              onChange={(event) => setSubmissionItemId(event.target.value)}
              value={submissionItemId}
            >
              <option value="">暂不确定</option>
              {filteredItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.engineeringDisplayName}
                </option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>

      <fieldset disabled={!canEditContent || saving}>
        <legend>缺陷内容</legend>
        <label>
          <span>标题</span>
          <input
            onChange={(event) => setTitle(event.target.value)}
            required
            value={title}
          />
        </label>
        <label>
          <span>操作路径</span>
          <textarea
            onChange={(event) => setOperationPath(event.target.value)}
            rows={3}
            value={operationPath}
          />
        </label>
        <div className="collab-bug-form__grid">
          <label>
            <span>实际结果</span>
            <textarea
              onChange={(event) => setActualResult(event.target.value)}
              rows={4}
              value={actualResult}
            />
          </label>
          <label>
            <span>预期结果</span>
            <textarea
              onChange={(event) => setExpectedResult(event.target.value)}
              rows={4}
              value={expectedResult}
            />
          </label>
        </div>
        <label>
          <span>补充说明</span>
          <textarea
            onChange={(event) => setSupplementalDescription(event.target.value)}
            rows={3}
            value={supplementalDescription}
          />
        </label>
        {bug?.attachments.length ? (
          <ul className="collab-bug-attachments">
            {bug.attachments.map((attachment) => {
              const kept = existingAttachmentIds.includes(attachment.id);
              return (
                <li
                  data-removed={kept ? undefined : 'true'}
                  key={attachment.id}
                >
                  <button
                    onClick={() => void downloadAttachment(attachment.id)}
                    type="button"
                  >
                    {attachment.fileName}
                  </button>
                  <small>{formatBytes(attachment.sizeBytes)}</small>
                  <button
                    onClick={() =>
                      setExistingAttachmentIds((current) =>
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
        {files.length ? (
          <ul className="collab-bug-attachments">
            {files.map((file) => (
              <li key={`${file.name}:${file.lastModified}`}>
                <span>{file.name}</span>
                <small>{formatBytes(file.size)}</small>
              </li>
            ))}
          </ul>
        ) : null}
      </fieldset>

      {error ? <p className="collab-form__error">{error}</p> : null}
      <footer className="collab-bug-drawer__actions">
        <button onClick={onCancel} type="button">
          取消
        </button>
        <button disabled={saving || (!canEditContent && !canEditAssignment)}>
          {saving ? '保存中…' : mode === 'create' ? '登记缺陷' : '保存修改'}
        </button>
      </footer>
    </form>
  );
}

function BugView({
  bug,
  currentUser,
  snapshot,
  interaction,
  pending,
  mutate,
  onEdit,
}: {
  bug: SubmissionBug;
  currentUser: CurrentUser;
  snapshot: WorkspaceSnapshot;
  interaction?: CodexInteractionRequest;
  pending: boolean;
  mutate: (
    command: CollaborativeCommand,
    message: string | null,
  ) => Promise<boolean>;
  onEdit: (() => void) | null;
}) {
  const item = snapshot.submission.items.find(
    (candidate) => candidate.id === bug.submissionItemId,
  );
  const statusLabel =
    STATUS_COLUMNS.find((column) => column.status === bug.status)?.label ??
    bug.status;
  const [feedback, setFeedback] = useState('');

  return (
    <div className="collab-bug-drawer__body">
      {interaction ? (
        <InteractionPanel
          interaction={interaction}
          mutate={mutate}
          pending={pending}
        />
      ) : null}

      <section className="collab-bug-detail-section">
        <header>
          <h3>缺陷信息</h3>
          {onEdit ? (
            <button onClick={onEdit} type="button">
              {bug.createdByUserId === currentUser.id
                ? '编辑缺陷'
                : '修改问题归属'}
            </button>
          ) : null}
        </header>
        <dl className="collab-bug-detail-list">
          <Detail label="问题归属">
            {bug.engineeringType
              ? `${ENGINEERING_TYPE_LABELS[bug.engineeringType]} · ${item?.engineeringDisplayName ?? '具体工程暂不确定'}`
              : '暂不确定'}
          </Detail>
          <Detail label="当前状态">{statusLabel}</Detail>
          <Detail label="标题">{bug.title}</Detail>
          {bug.operationPath ? (
            <Detail label="操作路径">{bug.operationPath}</Detail>
          ) : null}
          {bug.actualResult ? (
            <Detail label="实际结果">{bug.actualResult}</Detail>
          ) : null}
          {bug.expectedResult ? (
            <Detail label="预期结果">{bug.expectedResult}</Detail>
          ) : null}
          {bug.supplementalDescription ? (
            <Detail label="补充说明">{bug.supplementalDescription}</Detail>
          ) : null}
        </dl>
      </section>

      <section className="collab-bug-detail-section">
        <h3>附件</h3>
        {bug.attachments.length ? (
          <ul className="collab-bug-attachments">
            {bug.attachments.map((attachment) => (
              <li key={attachment.id}>
                <button
                  onClick={() => void downloadAttachment(attachment.id)}
                  type="button"
                >
                  {attachment.fileName}
                </button>
                <small>{formatBytes(attachment.sizeBytes)}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="collab-bug-detail-empty">没有附件</p>
        )}
      </section>

      {bug.repairRecords.length ? (
        <section className="collab-bug-detail-section">
          <h3>修复运行记录</h3>
          <ol className="collab-repair-records">
            {[...bug.repairRecords].reverse().map((record) => (
              <li key={record.id}>
                <header>
                  <strong>{repairRecordTitle(record)}</strong>
                  <time dateTime={record.createdAt}>
                    {formatDateTime(record.createdAt)}
                  </time>
                </header>
                <p>{record.summary}</p>
                {record.candidateCommit ? (
                  <code>{record.candidateCommit}</code>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {currentUser.accountType === 'TESTER' &&
      bug.status === 'WAITING_FOR_VERIFICATION' ? (
        <section className="collab-bug-detail-section">
          <h3>验证结果</h3>
          <div className="collab-bug-verification">
            <button
              disabled={pending}
              onClick={() =>
                void mutate(
                  { kind: 'bug.move', bugId: bug.id, targetStatus: 'DONE' },
                  '缺陷已验证完成。',
                )
              }
              type="button"
            >
              验证通过
            </button>
            <textarea
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="描述仍然存在的问题与复现结果"
              rows={3}
              value={feedback}
            />
            <button
              disabled={pending || !feedback.trim()}
              onClick={() =>
                void mutate(
                  {
                    kind: 'repair_task.enqueue',
                    bugId: bug.id,
                    feedback,
                    insertAtFront: true,
                  },
                  '缺陷已带反馈重新进入修复。',
                )
              }
              type="button"
            >
              验证失败并返修
            </button>
          </div>
        </section>
      ) : null}

      {currentUser.accountType === 'TESTER' && bug.status === 'DONE' ? (
        <section className="collab-bug-detail-section">
          <h3>重新打开</h3>
          <div className="collab-bug-verification">
            <textarea
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="描述重新出现的问题"
              rows={3}
              value={feedback}
            />
            <button
              disabled={pending || !feedback.trim()}
              onClick={() =>
                void mutate(
                  {
                    kind: 'repair_task.enqueue',
                    bugId: bug.id,
                    feedback,
                    insertAtFront: true,
                  },
                  '缺陷已重新打开。',
                )
              }
              type="button"
            >
              重新打开
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function InteractionPanel({
  interaction,
  pending,
  mutate,
}: {
  interaction: CodexInteractionRequest;
  pending: boolean;
  mutate: (
    command: CollaborativeCommand,
    message: string | null,
  ) => Promise<boolean>;
}) {
  const questions = userInputQuestions(interaction);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <section className="collab-bug-detail-section collab-bug-interaction">
      <h3>待处理 Codex 交互</h3>
      <p>{interactionTitle(interaction)}</p>
      {interaction.kind === 'PERMISSION' ? (
        <>
          <dl className="collab-bug-detail-list">
            {interactionPermissionDetails(interaction).map(([label, value]) => (
              <Detail key={label} label={label}>
                {value}
              </Detail>
            ))}
          </dl>
          <div className="collab-bug-drawer__actions">
            <button
              disabled={pending}
              onClick={() =>
                void mutate(
                  {
                    kind: 'interaction.resolve',
                    interactionId: interaction.id,
                    action: 'DECLINE',
                  },
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
                void mutate(
                  {
                    kind: 'interaction.resolve',
                    interactionId: interaction.id,
                    action: 'ACCEPT_FOR_SESSION',
                  },
                  '已允许本次会话。',
                )
              }
              type="button"
            >
              本次会话允许
            </button>
          </div>
        </>
      ) : (
        <div className="collab-bug-verification">
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
              void mutate(
                {
                  kind: 'interaction.resolve',
                  interactionId: interaction.id,
                  action: 'ANSWER',
                  answers: Object.fromEntries(
                    Object.entries(answers).map(([id, answer]) => [
                      id,
                      [answer.trim()],
                    ]),
                  ),
                },
                '回答已提交给 Codex。',
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

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function drawerTitle(mode: BugDrawerState['mode'], bug: SubmissionBug | null) {
  if (mode === 'create') return '登记缺陷';
  if (mode === 'edit') return '编辑缺陷';
  return bug?.title ?? '查看缺陷';
}

function repairRecordTitle(record: SubmissionBug['repairRecords'][number]) {
  if (record.phase === 'STARTUP') return '启动失败';
  return {
    READY: '修复完成',
    NEEDS_INPUT: '需要补充信息',
    BLOCKED: '修复受阻',
    FAILED: 'Codex 执行失败',
    INFRASTRUCTURE_ERROR: 'Codex 运行错误',
  }[record.outcome];
}

function interactionTitle(interaction: CodexInteractionRequest) {
  if (interaction.kind === 'USER_INPUT') return 'Codex 正在等待你的回答';
  return {
    'item/commandExecution/requestApproval': 'Codex 请求执行命令',
    'item/fileChange/requestApproval': 'Codex 请求扩展文件写入范围',
    'item/permissions/requestApproval': 'Codex 请求权限',
    'item/tool/requestUserInput': 'Codex 正在等待用户输入',
  }[interaction.method];
}

function interactionPermissionDetails(
  interaction: CodexInteractionRequest,
): Array<[string, string]> {
  if (interaction.kind !== 'PERMISSION') return [];
  const values: Array<[string, unknown]> = [
    ['原因', interaction.payload.reason],
    ['命令', interaction.payload.command],
    ['工作目录', interaction.payload.cwd],
    ['写入范围', interaction.payload.grantRoot],
    ['权限', interaction.payload.permissions],
  ];
  return values.flatMap(([label, value]) => {
    if (value === null || value === undefined || value === '') return [];
    return [[label, typeof value === 'string' ? value : JSON.stringify(value)]];
  });
}

function userInputQuestions(interaction: CodexInteractionRequest) {
  if (interaction.kind !== 'USER_INPUT') return [];
  const value = interaction.payload.questions;
  if (!Array.isArray(value)) return [];
  return value.flatMap((question) => {
    if (!question || typeof question !== 'object') return [];
    const record = question as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.question !== 'string')
      return [];
    return [
      {
        id: record.id,
        question: record.question,
        header: typeof record.header === 'string' ? record.header : '',
      },
    ];
  });
}
