'use client';

import Link from 'next/link';
import { useEffect, useState, useTransition, type FormEvent } from 'react';
import type {
  CollaborativeCommand,
  EngineeringBindingSummary,
  EngineeringDetail,
  ProjectMemberSummary,
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
  const [members, setMembers] = useState<ProjectMemberSummary[]>([]);
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
      setMembers([]);
      setItems([]);
      return;
    }
    setLoading(true);
    void loadProjectCatalog(projectId)
      .then(({ catalog: nextCatalog, members: nextMembers }) => {
        setCatalog(nextCatalog);
        setMembers(nextMembers);
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
                members={members}
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
                    {entry.engineering.displayName} · {entry.engineering.type}
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
  members,
  onChange,
  onRemove,
}: {
  entry: ItemCatalog;
  item: CreateItemDraft;
  members: ProjectMemberSummary[];
  onChange: (item: CreateItemDraft) => void;
  onRemove: () => void;
}) {
  const developerBindings = entry.bindings.filter((binding) =>
    members.some((member) => member.user.id === binding.developer.id),
  );
  const selectedBinding = developerBindings.find(
    (binding) => binding.developer.id === item.responsibleDeveloperUserId,
  );

  return (
    <article className="collab-create-item">
      <header>
        <div>
          <b>{ENGINEERING_TYPE_LABELS[entry.engineering.type]}</b>
          <h3>{entry.engineering.displayName}</h3>
        </div>
        <button onClick={onRemove} type="button">
          移除
        </button>
      </header>
      <div className="collab-form__grid collab-form__grid--four">
        <label>
          <span>负责人</span>
          <select
            onChange={(event) => {
              const developerId = event.target.value;
              const binding = developerBindings.find(
                (candidate) => candidate.developer.id === developerId,
              );
              onChange({
                ...item,
                responsibleDeveloperUserId: developerId,
                bindingId: binding?.id ?? '',
              });
            }}
            value={item.responsibleDeveloperUserId}
          >
            {[
              ...new Map(
                developerBindings.map((binding) => [
                  binding.developer.id,
                  binding.developer,
                ]),
              ).values(),
            ].map((developer) => (
              <option key={developer.id} value={developer.id}>
                {developer.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Agent 绑定</span>
          <input
            aria-readonly="true"
            readOnly
            value={
              selectedBinding ? `agent@${selectedBinding.repositoryName}` : ''
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
            onChange={(event) =>
              onChange({ ...item, environmentId: event.target.value })
            }
            value={item.environmentId}
          >
            {entry.engineering.environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
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

export function BugComposer({
  submissionId,
  items,
  onClose,
  onCreated,
}: {
  submissionId: string;
  items: SubmissionItem[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [submissionItemId, setSubmissionItemId] = useState('');
  const [title, setTitle] = useState('');
  const [operationPath, setOperationPath] = useState('');
  const [actualResult, setActualResult] = useState('');
  const [expectedResult, setExpectedResult] = useState('');
  const [supplementalDescription, setSupplementalDescription] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      try {
        const attachments = await Promise.all(files.map(fileUpload));
        await collaborativeCommand({
          kind: 'bug.create',
          submissionId,
          submissionItemId: submissionItemId || null,
          title,
          operationPath,
          actualResult,
          expectedResult,
          supplementalDescription: supplementalDescription || null,
          attachments,
        });
        await onCreated();
      } catch (requestError) {
        setError(messageOf(requestError, '无法登记缺陷'));
      }
    });
  }

  return (
    <DialogShell onClose={onClose} title="登记可复现缺陷">
      <form className="collab-form" onSubmit={submit}>
        <label>
          <span>所属工程</span>
          <select
            onChange={(event) => setSubmissionItemId(event.target.value)}
            value={submissionItemId}
          >
            <option value="">暂不确定，由开发分诊</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.engineeringDisplayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>缺陷标题</span>
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
            required
            rows={3}
            value={operationPath}
          />
        </label>
        <div className="collab-form__grid">
          <label>
            <span>实际结果</span>
            <textarea
              onChange={(event) => setActualResult(event.target.value)}
              required
              rows={4}
              value={actualResult}
            />
          </label>
          <label>
            <span>期望结果</span>
            <textarea
              onChange={(event) => setExpectedResult(event.target.value)}
              required
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
        <label>
          <span>附件（最多 5 个，单个不超过 10 兆字节）</span>
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
          <ul className="collab-form__file-list">
            {files.map((file) => (
              <li key={`${file.name}:${file.lastModified}`}>
                {file.name} · {formatBytes(file.size)}
              </li>
            ))}
          </ul>
        ) : null}
        {error ? <p className="collab-form__error">{error}</p> : null}
        <div className="collab-dialog__actions">
          <button onClick={onClose} type="button">
            取消
          </button>
          <button className="collab-primary" disabled={pending}>
            {pending ? '登记中…' : '登记缺陷'}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

export function ItemConfigurationDialog({
  item,
  mutate,
  onClose,
  onSaved,
}: {
  item: SubmissionItem;
  mutate: (command: CollaborativeCommand, message: string) => Promise<boolean>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [source] = useState(() => ({
    itemId: item.id,
    engineeringId: item.engineeringId,
    engineeringDisplayName: item.engineeringDisplayName,
  }));
  const [entry, setEntry] = useState<ItemCatalog | null>(null);
  const [draft, setDraft] = useState<CreateItemDraft>(() => ({
    engineeringId: item.engineeringId,
    responsibleDeveloperUserId: item.responsibleDeveloper.id,
    bindingId: item.technical?.bindingId ?? '',
    targetBranch: item.technical?.targetBranch ?? 'develop',
    environmentId: item.technical?.environment.id ?? '',
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([
      requestJson<{ engineering?: EngineeringDetail; error?: string }>(
        `/api/control-plane/engineerings/${source.engineeringId}`,
      ),
      requestJson<{ items?: EngineeringBindingSummary[]; error?: string }>(
        `/api/control-plane/engineerings/${source.engineeringId}/bindings`,
      ),
    ])
      .then(([detail, bindings]) => {
        if (!detail.engineering) throw new Error('工程详情不存在');
        setEntry({
          engineering: detail.engineering,
          bindings: bindings.items ?? [],
        });
      })
      .catch((requestError) =>
        setError(messageOf(requestError, '无法读取技术配置')),
      );
  }, [source.engineeringId]);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await mutate(
        {
          kind: 'submission.item.update',
          submissionItemId: source.itemId,
          responsibleDeveloperUserId: draft.responsibleDeveloperUserId,
          bindingId: draft.bindingId,
          targetBranch: draft.targetBranch,
          environmentId: draft.environmentId,
        },
        `${source.engineeringDisplayName} 技术配置已更新。`,
      );
      if (!saved) {
        setError('保存技术配置失败，请检查页面提示后重试。');
        return;
      }
      onSaved();
    } catch (requestError) {
      setError(messageOf(requestError, '保存技术配置失败'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogShell onClose={onClose} title="首个缺陷前技术配置">
      {entry ? (
        <div className="collab-form">
          <CreateItemRow
            entry={entry}
            item={draft}
            members={entry.engineering.members.map((member) => ({
              projectId: entry.engineering.projectId,
              user: member.user,
              role: member.role === 'OWNER' ? 'OWNER' : 'DEVELOPER',
              createdAt: member.createdAt,
              updatedAt: member.updatedAt,
            }))}
            onChange={setDraft}
            onRemove={onClose}
          />
          {error ? <p className="collab-form__error">{error}</p> : null}
          <div className="collab-dialog__actions">
            <button onClick={onClose} type="button">
              取消
            </button>
            <button
              className="collab-primary"
              disabled={saving}
              onClick={save}
              type="button"
            >
              {saving ? '保存中…' : '保存配置'}
            </button>
          </div>
        </div>
      ) : (
        <p className="collab-form__hint">{error ?? '正在读取工程配置…'}</p>
      )}
    </DialogShell>
  );
}

export function ExternalFailureDialog({
  batchId,
  mutate,
  onClose,
  onSubmitted,
}: {
  batchId: string;
  mutate: (command: CollaborativeCommand, message: string) => Promise<boolean>;
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
