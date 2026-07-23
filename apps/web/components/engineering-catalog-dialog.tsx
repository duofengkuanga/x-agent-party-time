'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
  type FormEvent,
} from 'react';
import type {
  EngineeringBindingSummary,
  EngineeringDetail,
  EngineeringEnvironmentInput,
  EngineeringSummary,
  ProjectMemberSummary,
  ProjectSummary,
} from '@agent-party-time/shared/control-plane';
import type { CurrentUser } from '@/lib/auth/core';

interface Draft {
  id: string | null;
  slug: string;
  displayName: string;
  type: 'FRONTEND' | 'BACKEND';
  repositoryUrl: string;
  ownerUserId: string;
  memberUserIds: string[];
  environments: EngineeringEnvironmentInput[];
}

interface ApiErrorPayload {
  message?: string;
  error?: string;
}

type ApiResult<T extends object = object> = T & ApiErrorPayload;

const EMPTY_ENVIRONMENT: EngineeringEnvironmentInput = {
  slug: 'test',
  displayName: '测试环境',
  deploymentType: 'LOCAL_SCRIPT',
  localScriptCommand: '',
};

export function EngineeringCatalogDialog({
  project,
  currentUser,
  onClose,
}: {
  project: ProjectSummary;
  currentUser: CurrentUser;
  onClose: () => void;
}) {
  const [items, setItems] = useState<EngineeringSummary[]>([]);
  const [projectMembers, setProjectMembers] = useState<ProjectMemberSummary[]>(
    [],
  );
  const [detail, setDetail] = useState<EngineeringDetail | null>(null);
  const [bindings, setBindings] = useState<EngineeringBindingSummary[]>([]);
  const [repositoryPath, setRepositoryPath] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    const [catalogResponse, collaborationResponse] = await Promise.all([
      fetch(`/api/control-plane/projects/${project.id}/engineerings`, {
        cache: 'no-store',
      }),
      fetch(`/api/control-plane/projects/${project.id}/collaboration`, {
        cache: 'no-store',
      }),
    ]);
    const catalog = (await catalogResponse.json()) as ApiResult<{
      items?: EngineeringSummary[];
    }>;
    const collaboration = (await collaborationResponse.json()) as ApiResult<{
      members?: ProjectMemberSummary[];
    }>;
    if (!catalogResponse.ok)
      throw new Error(apiMessage(catalog, '无法读取工程目录'));
    if (!collaborationResponse.ok)
      throw new Error(apiMessage(collaboration, '无法读取项目成员'));
    setItems(catalog.items ?? []);
    setProjectMembers(collaboration.members ?? []);
  }, [project.id]);

  useEffect(() => {
    void load()
      .catch((requestError) =>
        setError(messageOf(requestError, '无法读取工程目录')),
      )
      .finally(() => setLoading(false));
  }, [load]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose]);

  const groups = useMemo(
    () => ({
      FRONTEND: items.filter((item) => item.type === 'FRONTEND'),
      BACKEND: items.filter((item) => item.type === 'BACKEND'),
    }),
    [items],
  );
  const developers = projectMembers.filter(
    (member) => member.user.accountType === 'DEVELOPER',
  );

  async function openDetail(item: EngineeringSummary) {
    if (!item.canViewTechnicalConfiguration) return;
    try {
      const [response, bindingsResponse] = await Promise.all([
        fetch(`/api/control-plane/engineerings/${item.id}`, {
          cache: 'no-store',
        }),
        fetch(`/api/control-plane/engineerings/${item.id}/bindings`, {
          cache: 'no-store',
        }),
      ]);
      const result = (await response.json()) as ApiResult<{
        engineering?: EngineeringDetail;
      }>;
      if (!response.ok || !result.engineering)
        throw new Error(apiMessage(result, '无法读取工程配置'));
      const bindingResult = (await bindingsResponse.json()) as ApiResult<{
        items?: EngineeringBindingSummary[];
      }>;
      if (!bindingsResponse.ok)
        throw new Error(apiMessage(bindingResult, '无法读取 Agent 绑定'));
      setDetail(result.engineering);
      setBindings(bindingResult.items ?? []);
      setRepositoryPath('');
      setDraft(null);
      setError(null);
    } catch (requestError) {
      setError(messageOf(requestError, '无法读取工程配置'));
    }
  }

  function bindAgent(engineering: EngineeringDetail) {
    startTransition(async () => {
      try {
        const response = await fetch('/api/runner/engineering-bindings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            engineeringId: engineering.id,
            repositoryPath,
          }),
        });
        const result = (await response.json()) as ApiResult<{
          binding?: EngineeringBindingSummary;
        }>;
        if (!response.ok || !result.binding)
          throw new Error(apiMessage(result, 'Agent 绑定失败'));
        setBindings((current) => [
          ...current.filter((item) => item.id !== result.binding!.id),
          result.binding!,
        ]);
        setRepositoryPath('');
        setError(null);
      } catch (requestError) {
        setError(messageOf(requestError, 'Agent 绑定失败'));
      }
    });
  }

  function createDraft() {
    setDetail(null);
    setDraft({
      id: null,
      slug: '',
      displayName: '',
      type: 'FRONTEND',
      repositoryUrl: '',
      ownerUserId: currentUser.id,
      memberUserIds: [],
      environments: [{ ...EMPTY_ENVIRONMENT }],
    });
  }

  function editDraft(engineering: EngineeringDetail) {
    setDraft({
      id: engineering.id,
      slug: engineering.slug,
      displayName: engineering.displayName,
      type: engineering.type,
      repositoryUrl: engineering.repositoryUrl,
      ownerUserId:
        engineering.members.find((member) => member.role === 'OWNER')?.user
          .id ?? currentUser.id,
      memberUserIds: engineering.members
        .filter((member) => member.role === 'MEMBER')
        .map((member) => member.user.id),
      environments: engineering.environments.map((environment) => ({
        id: environment.id,
        slug: environment.slug,
        displayName: environment.displayName,
        deploymentType: environment.deploymentType,
        localScriptCommand: environment.localScriptCommand,
      })),
    });
    setDetail(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    startTransition(async () => {
      try {
        const body = {
          ...(draft.id ? { action: 'update' as const } : {}),
          slug: draft.slug,
          displayName: draft.displayName,
          type: draft.type,
          repositoryUrl: draft.repositoryUrl,
          ownerUserId: draft.ownerUserId,
          memberUserIds: draft.memberUserIds.filter(
            (userId) => userId !== draft.ownerUserId,
          ),
          environments: draft.environments.map((environment) => ({
            ...environment,
            localScriptCommand:
              environment.deploymentType === 'LOCAL_SCRIPT'
                ? environment.localScriptCommand
                : null,
          })),
        };
        const response = await fetch(
          draft.id
            ? `/api/control-plane/engineerings/${draft.id}`
            : `/api/control-plane/projects/${project.id}/engineerings`,
          {
            method: draft.id ? 'PATCH' : 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': `web-engineering:${crypto.randomUUID()}`,
            },
            body: JSON.stringify(body),
          },
        );
        const result = (await response.json()) as ApiResult<{
          engineering?: EngineeringDetail;
        }>;
        if (!response.ok || !result.engineering)
          throw new Error(apiMessage(result, '工程保存失败'));
        await load();
        setDraft(null);
        setDetail(result.engineering);
        setError(null);
      } catch (requestError) {
        setError(messageOf(requestError, '工程保存失败'));
      }
    });
  }

  function changeArchive(engineering: EngineeringDetail, archived: boolean) {
    startTransition(async () => {
      try {
        const response = await fetch(
          `/api/control-plane/engineerings/${engineering.id}`,
          {
            method: 'PATCH',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': `web-engineering-archive:${crypto.randomUUID()}`,
            },
            body: JSON.stringify({ action: 'archive', archived }),
          },
        );
        const result = (await response.json()) as ApiResult;
        if (!response.ok)
          throw new Error(apiMessage(result, '工程归档状态修改失败'));
        await load();
        setDetail(null);
        setError(null);
      } catch (requestError) {
        setError(messageOf(requestError, '工程归档状态修改失败'));
      }
    });
  }

  function removeEngineering(engineering: EngineeringDetail) {
    if (!window.confirm(`确认删除未被使用的工程“${engineering.displayName}”？`))
      return;
    startTransition(async () => {
      try {
        const response = await fetch(
          `/api/control-plane/engineerings/${engineering.id}`,
          {
            method: 'DELETE',
            headers: {
              'idempotency-key': `web-engineering-delete:${crypto.randomUUID()}`,
            },
          },
        );
        const result = (await response.json()) as ApiResult;
        if (!response.ok) throw new Error(apiMessage(result, '工程删除失败'));
        await load();
        setDetail(null);
        setError(null);
      } catch (requestError) {
        setError(messageOf(requestError, '工程删除失败'));
      }
    });
  }

  return (
    <div
      className="repair-overlay engineering-catalog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <section
        aria-labelledby="engineering-catalog-title"
        aria-modal="true"
        className="bug-dialog engineering-catalog-dialog"
        role="dialog"
      >
        <header className="engineering-dialog__header">
          <div>
            <p className="repair-kicker">{project.title ?? project.slug}</p>
            <h2 id="engineering-catalog-title">工程目录</h2>
          </div>
          <button
            aria-label="关闭工程目录"
            className="engineering-dialog__close"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </header>

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {loading ? (
          <p className="collaboration-loading">正在读取工程目录…</p>
        ) : draft ? (
          <EngineeringEditor
            developers={developers}
            draft={draft}
            pending={pending}
            referenced={Boolean(
              draft.id &&
              items.find((item) => item.id === draft.id)?.firstReferencedAt,
            )}
            setDraft={setDraft}
            submit={submit}
          />
        ) : detail ? (
          <EngineeringDetailView
            bindings={bindings}
            canBind={
              detail.members.some(
                (member) => member.user.id === currentUser.id,
              ) &&
              !bindings.some(
                (binding) => binding.developer.id === currentUser.id,
              )
            }
            currentBinding={bindings.find(
              (binding) => binding.developer.id === currentUser.id,
            )}
            detail={detail}
            onArchive={(archived) => changeArchive(detail, archived)}
            onBack={() => setDetail(null)}
            onDelete={() => removeEngineering(detail)}
            onEdit={() => editDraft(detail)}
            onBind={() => bindAgent(detail)}
            pending={pending}
            repositoryPath={repositoryPath}
            setRepositoryPath={setRepositoryPath}
          />
        ) : (
          <div className="engineering-catalog">
            <div className="engineering-catalog__intro">
              <p>按代码仓库维护工程、成员与测试环境。</p>
              {project.memberRole === 'OWNER' ? (
                <button
                  className="repair-primary"
                  onClick={createDraft}
                  type="button"
                >
                  新建工程
                </button>
              ) : null}
            </div>
            {(['FRONTEND', 'BACKEND'] as const).map((type) => (
              <section className="engineering-group" key={type}>
                <div className="collaboration-section-title">
                  <span>{type === 'FRONTEND' ? '前端工程' : '后端工程'}</span>
                  <small>{groups[type].length} 个</small>
                </div>
                {groups[type].length ? (
                  <div className="engineering-list">
                    {groups[type].map((item) => (
                      <button
                        className="engineering-card"
                        disabled={!item.canViewTechnicalConfiguration}
                        key={item.id}
                        onClick={() => void openDetail(item)}
                        type="button"
                      >
                        <span>{item.slug}</span>
                        <strong>{item.displayName}</strong>
                        <small>
                          {item.archivedAt
                            ? '已归档'
                            : item.memberRole === 'OWNER'
                              ? '工程负责人'
                              : item.memberRole === 'MEMBER'
                                ? '工程成员'
                                : item.canManage
                                  ? '项目负责人可管理'
                                  : '仅目录信息'}
                        </small>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="collaboration-empty">暂无此类工程。</p>
                )}
              </section>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function EngineeringEditor({
  draft,
  developers,
  referenced,
  pending,
  setDraft,
  submit,
}: {
  draft: Draft;
  developers: ProjectMemberSummary[];
  referenced: boolean;
  pending: boolean;
  setDraft: (draft: Draft | null) => void;
  submit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  function patch(next: Partial<Draft>) {
    setDraft({ ...draft, ...next });
  }
  function patchEnvironment(
    index: number,
    next: Partial<EngineeringEnvironmentInput>,
  ) {
    patch({
      environments: draft.environments.map((environment, itemIndex) =>
        itemIndex === index ? { ...environment, ...next } : environment,
      ),
    });
  }
  return (
    <form className="engineering-editor" onSubmit={submit}>
      <div className="engineering-editor__heading">
        <div>
          <strong>{draft.id ? '编辑工程' : '新建工程'}</strong>
          <small>配置仓库、成员与测试环境</small>
        </div>
      </div>
      <div className="engineering-editor__grid">
        <label>
          <span>显示名称</span>
          <input
            maxLength={120}
            onChange={(event) => patch({ displayName: event.target.value })}
            required
            value={draft.displayName}
          />
        </label>
        <label>
          <span>稳定标识</span>
          <input
            disabled={referenced}
            maxLength={64}
            onChange={(event) => patch({ slug: event.target.value })}
            pattern="[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?"
            required
            value={draft.slug}
          />
          {referenced ? <small>已被提测引用，不能修改</small> : null}
        </label>
        <label>
          <span>工程类型</span>
          <select
            onChange={(event) =>
              patch({ type: event.target.value as Draft['type'] })
            }
            value={draft.type}
          >
            <option value="FRONTEND">前端工程</option>
            <option value="BACKEND">后端工程</option>
          </select>
        </label>
        <label className="field-wide">
          <span>非敏感 Git 仓库地址</span>
          <input
            onChange={(event) => patch({ repositoryUrl: event.target.value })}
            placeholder="git@example.com:team/repository.git"
            required
            value={draft.repositoryUrl}
          />
        </label>
        <label>
          <span>工程负责人</span>
          <select
            onChange={(event) => patch({ ownerUserId: event.target.value })}
            value={draft.ownerUserId}
          >
            {developers.map((member) => (
              <option key={member.user.id} value={member.user.id}>
                {member.user.displayName}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="field-wide">
          <legend>工程成员</legend>
          {developers
            .filter((member) => member.user.id !== draft.ownerUserId)
            .map((member) => (
              <label className="inline-check" key={member.user.id}>
                <input
                  checked={draft.memberUserIds.includes(member.user.id)}
                  onChange={(event) =>
                    patch({
                      memberUserIds: event.target.checked
                        ? [...draft.memberUserIds, member.user.id]
                        : draft.memberUserIds.filter(
                            (userId) => userId !== member.user.id,
                          ),
                    })
                  }
                  type="checkbox"
                />
                <span>{member.user.displayName}</span>
              </label>
            ))}
        </fieldset>
      </div>

      <section className="engineering-environments">
        <div className="collaboration-section-title">
          <span>测试环境与更新方式</span>
          <button
            onClick={() =>
              patch({
                environments: [
                  ...draft.environments,
                  {
                    ...EMPTY_ENVIRONMENT,
                    slug: `test-${draft.environments.length + 1}`,
                  },
                ],
              })
            }
            type="button"
          >
            + 添加环境
          </button>
        </div>
        {draft.environments.map((environment, index) => (
          <article key={environment.id ?? index}>
            <label>
              <span>环境名称</span>
              <input
                onChange={(event) =>
                  patchEnvironment(index, { displayName: event.target.value })
                }
                required
                value={environment.displayName}
              />
            </label>
            <label>
              <span>环境标识</span>
              <input
                onChange={(event) =>
                  patchEnvironment(index, { slug: event.target.value })
                }
                required
                value={environment.slug}
              />
            </label>
            <label>
              <span>更新方式</span>
              <select
                onChange={(event) =>
                  patchEnvironment(index, {
                    deploymentType: event.target
                      .value as EngineeringEnvironmentInput['deploymentType'],
                    localScriptCommand: null,
                  })
                }
                value={environment.deploymentType}
              >
                <option value="LOCAL_SCRIPT">本地脚本自动更新</option>
                <option value="CI_CD">CI/CD 人工确认</option>
              </select>
            </label>
            {environment.deploymentType === 'LOCAL_SCRIPT' ? (
              <label className="field-wide">
                <span>部署命令</span>
                <input
                  onChange={(event) =>
                    patchEnvironment(index, {
                      localScriptCommand: event.target.value,
                    })
                  }
                  placeholder="bun run deploy:test"
                  required
                  value={environment.localScriptCommand ?? ''}
                />
                <small>
                  不要填写 Token、密码或密钥；请在 Agent 本机使用环境变量。
                </small>
              </label>
            ) : (
              <p className="engineering-environment-note">
                外部 CI/CD 完成构建与人工部署后，由开发人员回到系统确认结果。
              </p>
            )}
            {draft.environments.length > 1 ? (
              <button
                className="engineering-remove-environment"
                onClick={() =>
                  patch({
                    environments: draft.environments.filter(
                      (_, itemIndex) => itemIndex !== index,
                    ),
                  })
                }
                type="button"
              >
                移除环境
              </button>
            ) : null}
          </article>
        ))}
      </section>
      <div className="dialog-actions">
        <button onClick={() => setDraft(null)} type="button">
          返回目录
        </button>
        <button className="repair-primary" disabled={pending} type="submit">
          {pending ? '保存中…' : draft.id ? '保存工程' : '创建工程'}
        </button>
      </div>
    </form>
  );
}

function EngineeringDetailView({
  bindings,
  canBind,
  currentBinding,
  detail,
  pending,
  onBack,
  onEdit,
  onArchive,
  onDelete,
  onBind,
  repositoryPath,
  setRepositoryPath,
}: {
  bindings: EngineeringBindingSummary[];
  canBind: boolean;
  currentBinding?: EngineeringBindingSummary;
  detail: EngineeringDetail;
  pending: boolean;
  onBack: () => void;
  onEdit: () => void;
  onArchive: (archived: boolean) => void;
  onDelete: () => void;
  onBind: () => void;
  repositoryPath: string;
  setRepositoryPath: (value: string) => void;
}) {
  return (
    <div className="engineering-detail">
      <div className="engineering-detail__headline">
        <div>
          <span>{detail.type === 'FRONTEND' ? '前端工程' : '后端工程'}</span>
          <h3>{detail.displayName}</h3>
          <small>/{detail.slug}</small>
        </div>
        {detail.archivedAt ? <em>已归档</em> : <em>使用中</em>}
      </div>
      <dl>
        <div>
          <dt>仓库地址</dt>
          <dd>{detail.repositoryUrl}</dd>
        </div>
        <div>
          <dt>工程成员</dt>
          <dd>
            {detail.members
              .map(
                (member) =>
                  `${member.user.displayName}（${member.role === 'OWNER' ? '负责人' : '成员'}）`,
              )
              .join('、')}
          </dd>
        </div>
      </dl>
      <section className="engineering-detail__environments">
        <div className="collaboration-section-title">
          <span>测试环境</span>
          <small>{detail.environments.length} 个</small>
        </div>
        {detail.environments.map((environment) => (
          <article key={environment.id}>
            <div>
              <strong>{environment.displayName}</strong>
              <small>/{environment.slug}</small>
            </div>
            <span>
              {environment.deploymentType === 'LOCAL_SCRIPT'
                ? '本地脚本自动更新'
                : 'CI/CD 人工确认'}
            </span>
            {environment.localScriptCommand ? (
              <code>{environment.localScriptCommand}</code>
            ) : null}
          </article>
        ))}
      </section>
      <section className="engineering-detail__bindings">
        <div className="collaboration-section-title">
          <span>Agent 绑定</span>
          <small>{bindings.length} 个</small>
        </div>
        {bindings.length ? (
          <ul>
            {bindings.map((binding) => (
              <li key={binding.id}>
                <span>
                  <strong>{binding.developer.displayName}</strong>
                  <small>agent@{binding.repositoryName}</small>
                </span>
                <em>
                  {binding.runner.availability === 'online' ? '在线' : '离线'}
                </em>
              </li>
            ))}
          </ul>
        ) : (
          <p className="collaboration-empty">还没有开发人员绑定本机 Agent。</p>
        )}
        {currentBinding ? (
          <p className="collaboration-empty">
            你已绑定 agent@{currentBinding.repositoryName}，绑定后不能更换。
          </p>
        ) : canBind && !detail.archivedAt ? (
          <div className="engineering-binding-form">
            <label>
              <span>本机工程目录</span>
              <input
                onChange={(event) => setRepositoryPath(event.target.value)}
                placeholder="/absolute/path/to/project"
                value={repositoryPath}
              />
              <small>路径仅保存在本机 Agent，不会上传到协作中心。</small>
            </label>
            <button
              disabled={pending || !repositoryPath.trim()}
              onClick={onBind}
              type="button"
            >
              {pending ? '绑定中…' : '绑定 Agent'}
            </button>
          </div>
        ) : null}
      </section>
      <div className="dialog-actions engineering-detail__actions">
        <button onClick={onBack} type="button">
          返回目录
        </button>
        {detail.canManage ? (
          <>
            {!detail.firstReferencedAt ? (
              <button disabled={pending} onClick={onDelete} type="button">
                删除工程
              </button>
            ) : null}
            <button
              disabled={pending}
              onClick={() => onArchive(!detail.archivedAt)}
              type="button"
            >
              {detail.archivedAt ? '恢复工程' : '归档工程'}
            </button>
            <button
              className="repair-primary"
              disabled={pending}
              onClick={onEdit}
              type="button"
            >
              编辑配置
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function apiMessage(result: ApiErrorPayload, fallback: string) {
  return result.message ?? result.error ?? fallback;
}
