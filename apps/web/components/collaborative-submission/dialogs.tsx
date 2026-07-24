'use client';

import Link from 'next/link';
import { useEffect, useState, useTransition, type FormEvent } from 'react';
import type {
  CollaborativeCommand,
  ProjectSummary,
} from '@agent-party-time/shared/control-plane';
import type { CurrentUser } from '@/lib/auth/core';
import {
  collaborativeCommand,
  fileUpload,
  formatBytes,
  loadProjectCatalog,
  messageOf,
  requestJson,
} from './client';
import {
  DEPLOYMENT_TYPE_LABELS,
  ENGINEERING_TYPE_LABELS,
  type CreateItemDraft,
  type ItemCatalog,
  type SubmissionItem,
} from './model';

export function SubmissionComposer({
  currentUser,
  registeredUsers,
  onClose,
  onCreated,
}: {
  currentUser: CurrentUser;
  registeredUsers: CurrentUser[];
  onClose: () => void;
  onCreated: (submissionId: string) => Promise<void>;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState('');
  const [catalog, setCatalog] = useState<ItemCatalog[]>([]);
  const [items, setItems] = useState<CreateItemDraft[]>([]);
  const [title, setTitle] = useState('');
  const [requirementDescription, setRequirementDescription] = useState('');
  const [testerUserId, setTesterUserId] = useState(
    registeredUsers.find((user) => user.accountType === 'TESTER')?.id ?? '',
  );
  const [loading, setLoading] = useState(true);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void requestJson<{ items?: ProjectSummary[]; error?: string }>(
      '/api/control-plane/projects',
    )
      .then((result) => setProjects(result.items ?? []))
      .catch((requestError) =>
        setError(messageOf(requestError, '无法读取项目')),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!projectId) {
      setCatalog([]);
      setItems([]);
      return;
    }
    setLoading(true);
    void loadProjectCatalog(projectId)
      .then(({ catalog: nextCatalog }) => {
        setCatalog(nextCatalog);
        setItems([]);
        setError(null);
      })
      .catch((requestError) =>
        setError(messageOf(requestError, '无法读取工程提测配置')),
      )
      .finally(() => setLoading(false));
  }, [projectId]);

  function addEngineering(engineeringId: string) {
    const entry = catalog.find(
      (candidate) => candidate.engineering.id === engineeringId,
    );
    if (!entry || items.some((item) => item.engineeringId === engineeringId))
      return;
    const developerId =
      entry.engineering.members.find(
        (member) =>
          member.role === 'OWNER' && member.user.accountType === 'DEVELOPER',
      )?.user.id ?? currentUser.id;
    const binding =
      entry.bindings.find(
        (candidate) => candidate.developer.id === developerId,
      ) ?? entry.bindings[0];
    setItems((current) => [
      ...current,
      {
        engineeringId,
        responsibleDeveloperUserId: binding?.developer.id ?? developerId,
        bindingId: binding?.id ?? '',
        targetBranch: 'develop',
        environmentId: entry.engineering.environments[0]?.id ?? '',
      },
    ]);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      try {
        const result = await collaborativeCommand({
          kind: 'submission.create',
          projectId,
          title,
          requirementDescription,
          testerUserId,
          items,
        });
        if (!result.submission) throw new Error('控制平面未返回新提测单');
        await onCreated(result.submission.id);
      } catch (requestError) {
        setError(messageOf(requestError, '无法创建提测单'));
      }
    });
  }

  const available = catalog.filter(
    (entry) =>
      !items.some((item) => item.engineeringId === entry.engineering.id),
  );
  const canSubmit =
    projectId &&
    title.trim() &&
    requirementDescription.trim() &&
    testerUserId &&
    items.length > 0 &&
    items.every(
      (item) =>
        item.bindingId &&
        item.environmentId &&
        item.responsibleDeveloperUserId &&
        item.targetBranch.trim(),
    );

  return (
    <DialogShell onClose={onClose} title="创建多工程提测单">
      <form className="collab-form" onSubmit={submit}>
        <div className="collab-form__grid">
          <label>
            <span>私密项目</span>
            <select
              disabled={loading}
              onChange={(event) => setProjectId(event.target.value)}
              required
              value={projectId}
            >
              <option value="">选择项目</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title ?? project.slug}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>唯一测试负责人</span>
            <select
              onChange={(event) => setTesterUserId(event.target.value)}
              required
              value={testerUserId}
            >
              {registeredUsers
                .filter((user) => user.accountType === 'TESTER')
                .map((tester) => (
                  <option key={tester.id} value={tester.id}>
                    {tester.displayName}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <label>
          <span>提测标题</span>
          <input
            maxLength={160}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：订单结算链路协作提测"
            required
            value={title}
          />
        </label>
        <label>
          <span>需求说明</span>
          <textarea
            maxLength={12_000}
            onChange={(event) => setRequirementDescription(event.target.value)}
            placeholder="说明本次提测范围、入口和关键验收目标"
            required
            rows={4}
            value={requirementDescription}
          />
        </label>
        <section className="collab-form__items">
          <div className="collab-section-label">
            <span>工程提测项</span>
            <small>首个缺陷创建后技术配置锁定</small>
          </div>
          {items.map((item, index) => {
            const entry = catalog.find(
              (candidate) => candidate.engineering.id === item.engineeringId,
            );
            if (!entry) return null;
            return (
              <CreateItemRow
                entry={entry}
                item={item}
                key={item.engineeringId}
                onChange={(next) =>
                  setItems((current) =>
                    current.map((candidate, candidateIndex) =>
                      candidateIndex === index ? next : candidate,
                    ),
                  )
                }
                onRemove={() =>
                  setItems((current) =>
                    current.filter(
                      (_, candidateIndex) => candidateIndex !== index,
                    ),
                  )
                }
              />
            );
          })}
          {available.length ? (
            <label className="collab-add-engineering">
              <span>添加工程</span>
              <select
                onChange={(event) => {
                  addEngineering(event.target.value);
                  event.currentTarget.value = '';
                }}
                value=""
              >
                <option value="">＋ 选择一个工程</option>
                {available.map((entry) => (
                  <option
                    key={entry.engineering.id}
                    value={entry.engineering.id}
                  >
                    {entry.engineering.displayName} ·{' '}
                    {ENGINEERING_TYPE_LABELS[entry.engineering.type]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {!loading && projectId && catalog.length === 0 ? (
            <div className="collab-form__blocked">
              <div>
                <strong>还不能创建提测单</strong>
                <p>
                  当前项目没有可用于提测的工程，请先完成工程与本机 Agent 绑定。
                </p>
              </div>
              <Link href={`/cooking/projects?project=${projectId}`}>
                去配置
              </Link>
            </div>
          ) : null}
        </section>
        {!loading && projects.length === 0 ? (
          <div className="collab-form__blocked">
            <div>
              <strong>还没有项目</strong>
              <p>先创建项目，再添加工程与测试环境。</p>
            </div>
            <Link href="/cooking/projects">新建项目</Link>
          </div>
        ) : null}
        {error ? <p className="collab-form__error">{error}</p> : null}
        <div className="collab-dialog__actions">
          <button onClick={onClose} type="button">
            取消
          </button>
          <button className="collab-primary" disabled={!canSubmit || pending}>
            {pending ? '创建中…' : '创建并锁定环境'}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

function CreateItemRow({
  entry,
  item,
  onChange,
  onRemove,
}: {
  entry: ItemCatalog;
  item: CreateItemDraft;
  onChange: (item: CreateItemDraft) => void;
  onRemove?: () => void;
}) {
  const selectableMembers = entry.engineering.members.flatMap((member) =>
    entry.bindings.some((binding) => binding.developer.id === member.user.id)
      ? [{ ...member.user, engineeringRole: member.role }]
      : [],
  );
  const selectedBinding = entry.bindings.find(
    (binding) => binding.developer.id === item.responsibleDeveloperUserId,
  );

  return (
    <article className="collab-create-item">
      <header>
        <div>
          <b>{ENGINEERING_TYPE_LABELS[entry.engineering.type]}</b>
          <h3>{entry.engineering.displayName}</h3>
        </div>
        {onRemove ? (
          <button onClick={onRemove} type="button">
            移除
          </button>
        ) : null}
      </header>
      <div className="collab-form__grid collab-form__grid--four">
        <label>
          <span>负责人</span>
          <select
            className="collab-select--truncate"
            onChange={(event) => {
              const developerId = event.target.value;
              const binding = entry.bindings.find(
                (candidate) => candidate.developer.id === developerId,
              );
              onChange({
                ...item,
                responsibleDeveloperUserId: developerId,
                bindingId: binding?.id ?? '',
              });
            }}
            title={
              selectableMembers.find(
                (developer) => developer.id === item.responsibleDeveloperUserId,
              )?.displayName ?? '请选择负责人'
            }
            value={item.responsibleDeveloperUserId}
          >
            {selectableMembers.length === 0 ? (
              <option value="">暂无已绑定 Agent 的工程成员</option>
            ) : null}
            {selectableMembers.map((developer) => {
              const roleLabel =
                developer.engineeringRole === 'OWNER'
                  ? '工程负责人'
                  : '工程成员';
              const label = `${developer.displayName} · ${roleLabel}`;
              return (
                <option key={developer.id} title={label} value={developer.id}>
                  {label}
                </option>
              );
            })}
          </select>
        </label>
        <label>
          <span>Agent 绑定</span>
          <input
            aria-readonly="true"
            readOnly
            title={
              selectedBinding
                ? `agent@${selectedBinding.repositoryName}`
                : '未绑定 Agent（需先绑定）'
            }
            value={
              selectedBinding
                ? `agent@${selectedBinding.repositoryName}`
                : '未绑定 Agent（需先绑定）'
            }
          />
        </label>
        <label>
          <span>目标分支</span>
          <input
            onChange={(event) =>
              onChange({ ...item, targetBranch: event.target.value })
            }
            value={item.targetBranch}
          />
        </label>
        <label>
          <span>测试环境</span>
          <select
            className="collab-select--truncate"
            onChange={(event) =>
              onChange({ ...item, environmentId: event.target.value })
            }
            title={(() => {
              const environment = entry.engineering.environments.find(
                (candidate) => candidate.id === item.environmentId,
              );
              return environment
                ? `${environment.displayName} · ${
                    DEPLOYMENT_TYPE_LABELS[environment.deploymentType]
                  }`
                : '请选择测试环境';
            })()}
            value={item.environmentId}
          >
            {entry.engineering.environments.map((environment) => (
              <option
                key={environment.id}
                title={`${environment.displayName} · ${
                  DEPLOYMENT_TYPE_LABELS[environment.deploymentType]
                }`}
                value={environment.id}
              >
                {environment.displayName} ·{' '}
                {DEPLOYMENT_TYPE_LABELS[environment.deploymentType]}
              </option>
            ))}
          </select>
        </label>
      </div>
    </article>
  );
}

export function ExternalFailureDialog({
  batchId,
  mutate,
  onClose,
  onSubmitted,
}: {
  batchId: string;
  mutate: (
    command: CollaborativeCommand,
    message: string | null,
  ) => Promise<boolean>;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [feedback, setFeedback] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      try {
        const attachments = await Promise.all(files.map(fileUpload));
        mutate(
          {
            kind: 'update.external_failure',
            batchId,
            feedback,
            attachments,
          },
          '持续集成与部署失败证据已提交，Codex 恢复任务已排队。',
        );
        onSubmitted();
      } catch (requestError) {
        setError(messageOf(requestError, '无法读取失败附件'));
      }
    });
  }

  return (
    <DialogShell onClose={onClose} title="外部更新失败">
      <form className="collab-form" onSubmit={submit}>
        <label>
          <span>失败说明</span>
          <textarea
            onChange={(event) => setFeedback(event.target.value)}
            required
            rows={5}
            value={feedback}
          />
        </label>
        <label>
          <span>日志 / 截图附件</span>
          <input
            accept="image/png,image/jpeg,image/webp,text/plain,application/json"
            multiple
            onChange={(event) =>
              setFiles(Array.from(event.target.files ?? []).slice(0, 5))
            }
            type="file"
          />
        </label>
        {error ? <p className="collab-form__error">{error}</p> : null}
        <div className="collab-dialog__actions">
          <button onClick={onClose} type="button">
            取消
          </button>
          <button
            className="collab-primary"
            disabled={pending || !feedback.trim()}
          >
            提交并恢复 Codex
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

function DialogShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="collab-dialog-backdrop" role="presentation">
      <section aria-modal="true" className="collab-dialog" role="dialog">
        <header>
          <h2>{title}</h2>
          <button aria-label="关闭" onClick={onClose} type="button">
            ×
          </button>
        </header>
        <div className="collab-dialog__body">{children}</div>
      </section>
    </div>
  );
}
