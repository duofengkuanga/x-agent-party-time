'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { createClientId } from '@/features/cooking/shared/client-id';
import type { User } from '@/server/auth/contract';
import type { SubmissionCreationCatalog } from '../contract';
import { createSubmissionAction } from './actions';

type CatalogProject = SubmissionCreationCatalog[number];
type CatalogEngineering = CatalogProject['engineerings'][number];

type ItemDraft = {
  key: string;
  engineeringId: string;
  responsibleUserId: string;
  bindingId: string;
  targetBranch: string;
  environmentId: string;
};

export function SubmissionComposer({
  catalog,
  currentUser,
  onClose,
  onCreated,
}: {
  catalog: SubmissionCreationCatalog;
  currentUser: User;
  onClose: () => void;
  onCreated: (submissionId: string) => void;
}) {
  const initialProject = catalog[0] ?? null;
  const initialTesterId =
    initialProject?.members.find(({ id }) => id !== currentUser.id)?.id ??
    initialProject?.members[0]?.id ??
    '';
  const [projectId, setProjectId] = useState(initialProject?.projectId ?? '');
  const [title, setTitle] = useState('');
  const [requirementDescription, setRequirementDescription] = useState('');
  const [testerUserId, setTesterUserId] = useState(initialTesterId);
  const [items, setItems] = useState<ItemDraft[]>(() => {
    if (!initialProject) return [];
    const first = createItemDraft(initialProject, initialTesterId, []);
    return first ? [first] : [];
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const project = useMemo(
    () =>
      catalog.find((candidate) => candidate.projectId === projectId) ?? null,
    [catalog, projectId],
  );

  function changeProject(nextProjectId: string) {
    const nextProject =
      catalog.find((candidate) => candidate.projectId === nextProjectId) ??
      null;
    const nextTesterId =
      nextProject?.members.find(({ id }) => id !== currentUser.id)?.id ??
      nextProject?.members[0]?.id ??
      '';
    setProjectId(nextProjectId);
    setTesterUserId(nextTesterId);
    const first = nextProject
      ? createItemDraft(nextProject, nextTesterId, [])
      : null;
    setItems(first ? [first] : []);
    setError(null);
  }

  function changeTester(nextTesterId: string) {
    setTesterUserId(nextTesterId);
    if (!project) return;
    setItems((current) =>
      current.map((item) =>
        normalizeItemDraft(project, item, nextTesterId, item.engineeringId),
      ),
    );
  }

  function updateItem(key: string, update: (item: ItemDraft) => ItemDraft) {
    setItems((current) =>
      current.map((item) => (item.key === key ? update(item) : item)),
    );
  }

  async function submit() {
    if (!project) {
      setError('请先选择项目。');
      return;
    }
    if (!items.length) {
      setError('至少需要一个配置完整的提测工程。');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await createSubmissionAction(project.projectId, {
        mutationId: createClientId(),
        title,
        requirementDescription,
        testerUserId,
        items: items.map(
          ({
            engineeringId,
            responsibleUserId,
            bindingId,
            targetBranch,
            environmentId,
          }) => ({
            engineeringId,
            responsibleUserId,
            bindingId,
            targetBranch,
            environmentId,
          }),
        ),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      onCreated(result.result.id);
    } catch (actionError) {
      setError(messageOf(actionError, '创建提测单失败，请稍后重试。'));
    } finally {
      setPending(false);
    }
  }

  const selectedEngineeringIds = items.map(
    ({ engineeringId }) => engineeringId,
  );
  const canAddItem = Boolean(
    project?.engineerings.some(
      (engineering) =>
        !selectedEngineeringIds.includes(engineering.id) &&
        engineeringIsReady(engineering, testerUserId),
    ),
  );

  return (
    <div className="collab-dialog-backdrop" role="presentation">
      <section
        aria-labelledby="submission-composer-title"
        aria-modal="true"
        className="collab-dialog"
        role="dialog"
      >
        <header>
          <div>
            <h2 id="submission-composer-title">创建提测单</h2>
          </div>
          <button aria-label="关闭创建提测单" onClick={onClose} type="button">
            ×
          </button>
        </header>
        <div className="collab-dialog__body">
          {catalog.length ? (
            <form
              className="collab-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <div className="collab-form__grid">
                <label>
                  <span>项目</span>
                  <select
                    onChange={(event) => changeProject(event.target.value)}
                    value={projectId}
                  >
                    {catalog.map((candidate) => (
                      <option
                        key={candidate.projectId}
                        value={candidate.projectId}
                      >
                        {candidate.projectName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>测试负责人</span>
                  <select
                    onChange={(event) => changeTester(event.target.value)}
                    required
                    value={testerUserId}
                  >
                    {project?.members.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.displayName}
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
                  placeholder="例如：结算流程联调"
                  required
                  value={title}
                />
              </label>
              <label>
                <span>需求说明</span>
                <textarea
                  maxLength={8_000}
                  onChange={(event) =>
                    setRequirementDescription(event.target.value)
                  }
                  placeholder="说明本次提测范围与验收重点"
                  required
                  rows={4}
                  value={requirementDescription}
                />
              </label>

              {project && items.length ? (
                <div className="collab-form__items">
                  {items.map((item, index) => (
                    <ItemEditor
                      draft={item}
                      index={index}
                      key={item.key}
                      onChange={(next) => updateItem(item.key, () => next)}
                      onRemove={
                        items.length > 1
                          ? () =>
                              setItems((current) =>
                                current.filter(
                                  (candidate) => candidate.key !== item.key,
                                ),
                              )
                          : null
                      }
                      project={project}
                      selectedEngineeringIds={selectedEngineeringIds}
                      testerUserId={testerUserId}
                    />
                  ))}
                </div>
              ) : (
                <div className="collab-form__blocked">
                  <div>
                    <strong>当前项目还不能创建提测单</strong>
                    <p>
                      至少需要一个工程成员、可用 Agent 绑定
                      和测试环境，且测试负责人不能同时负责提测项。
                    </p>
                  </div>
                  <Link href="/cooking/projects">前往配置</Link>
                </div>
              )}

              <button
                className="collab-add-engineering"
                disabled={!canAddItem}
                onClick={() => {
                  if (!project) return;
                  const next = createItemDraft(
                    project,
                    testerUserId,
                    selectedEngineeringIds,
                  );
                  if (next) setItems((current) => [...current, next]);
                }}
                type="button"
              >
                ＋ 添加提测工程
              </button>

              {error ? (
                <p className="collab-form__error" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="collab-dialog__actions">
                <button disabled={pending} onClick={onClose} type="button">
                  取消
                </button>
                <button
                  className="collab-primary"
                  disabled={pending || !items.length}
                  type="submit"
                >
                  {pending ? '正在创建…' : '创建提测单'}
                </button>
              </div>
            </form>
          ) : (
            <div className="collab-form__blocked">
              <div>
                <strong>还没有可用项目</strong>
                <p>请先创建项目并完成工程、Agent 绑定和环境配置。</p>
              </div>
              <Link href="/cooking/projects">前往配置</Link>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function ItemEditor({
  draft,
  index,
  onChange,
  onRemove,
  project,
  selectedEngineeringIds,
  testerUserId,
}: {
  draft: ItemDraft;
  index: number;
  onChange: (next: ItemDraft) => void;
  onRemove: (() => void) | null;
  project: CatalogProject;
  selectedEngineeringIds: string[];
  testerUserId: string;
}) {
  const engineering =
    project.engineerings.find(({ id }) => id === draft.engineeringId) ??
    project.engineerings[0]!;
  const responsibleMembers = engineering.members.filter(
    ({ id }) => id !== testerUserId,
  );
  const bindings = engineering.bindings.filter(
    ({ userId }) => userId === draft.responsibleUserId,
  );
  return (
    <article className="collab-create-item">
      <header>
        <div>
          <b>{String(index + 1).padStart(2, '0')}</b>
          <h3>提测工程</h3>
        </div>
        {onRemove ? (
          <button onClick={onRemove} type="button">
            移除
          </button>
        ) : null}
      </header>
      <div className="collab-form__grid collab-form__grid--four">
        <label>
          <span>工程</span>
          <select
            onChange={(event) =>
              onChange(
                normalizeItemDraft(
                  project,
                  draft,
                  testerUserId,
                  event.target.value,
                ),
              )
            }
            value={draft.engineeringId}
          >
            {project.engineerings.map((candidate) => (
              <option
                disabled={
                  !engineeringIsReady(candidate, testerUserId) ||
                  (candidate.id !== draft.engineeringId &&
                    selectedEngineeringIds.includes(candidate.id))
                }
                key={candidate.id}
                value={candidate.id}
              >
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>开发负责人</span>
          <select
            onChange={(event) => {
              const responsibleUserId = event.target.value;
              const bindingId =
                engineering.bindings.find(
                  (binding) => binding.userId === responsibleUserId,
                )?.id ?? '';
              onChange({ ...draft, responsibleUserId, bindingId });
            }}
            required
            value={draft.responsibleUserId}
          >
            {responsibleMembers.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Agent 绑定</span>
          <select
            onChange={(event) =>
              onChange({ ...draft, bindingId: event.target.value })
            }
            required
            value={draft.bindingId}
          >
            {bindings.map((binding) => (
              <option key={binding.id} value={binding.id}>
                {binding.runnerName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>目标分支</span>
          <input
            maxLength={240}
            onChange={(event) =>
              onChange({ ...draft, targetBranch: event.target.value })
            }
            required
            value={draft.targetBranch}
          />
        </label>
        <label>
          <span>测试环境</span>
          <select
            onChange={(event) =>
              onChange({ ...draft, environmentId: event.target.value })
            }
            required
            value={draft.environmentId}
          >
            {engineering.environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </article>
  );
}

function createItemDraft(
  project: CatalogProject,
  testerUserId: string,
  selectedEngineeringIds: string[],
): ItemDraft | null {
  const engineering = project.engineerings.find(
    (candidate) =>
      !selectedEngineeringIds.includes(candidate.id) &&
      engineeringIsReady(candidate, testerUserId),
  );
  if (!engineering) return null;
  const responsible = engineering.members.find(
    (member) =>
      member.id !== testerUserId &&
      engineering.bindings.some((binding) => binding.userId === member.id),
  )!;
  return {
    key: createClientId(),
    engineeringId: engineering.id,
    responsibleUserId: responsible.id,
    bindingId: engineering.bindings.find(
      (binding) => binding.userId === responsible.id,
    )!.id,
    targetBranch: 'main',
    environmentId: engineering.environments[0]!.id,
  };
}

function normalizeItemDraft(
  project: CatalogProject,
  current: ItemDraft,
  testerUserId: string,
  engineeringId: string,
): ItemDraft {
  const engineering = project.engineerings.find(
    (candidate) => candidate.id === engineeringId,
  )!;
  const responsible =
    engineering.members.find(
      (member) =>
        member.id === current.responsibleUserId &&
        member.id !== testerUserId &&
        engineering.bindings.some((binding) => binding.userId === member.id),
    ) ??
    engineering.members.find(
      (member) =>
        member.id !== testerUserId &&
        engineering.bindings.some((binding) => binding.userId === member.id),
    );
  return {
    ...current,
    engineeringId,
    responsibleUserId: responsible?.id ?? '',
    bindingId:
      engineering.bindings.find((binding) => binding.userId === responsible?.id)
        ?.id ?? '',
    environmentId: engineering.environments.some(
      (environment) => environment.id === current.environmentId,
    )
      ? current.environmentId
      : (engineering.environments[0]?.id ?? ''),
  };
}

function engineeringIsReady(
  engineering: CatalogEngineering,
  testerUserId: string,
): boolean {
  return (
    engineering.environments.length > 0 &&
    engineering.members.some(
      (member) =>
        member.id !== testerUserId &&
        engineering.bindings.some((binding) => binding.userId === member.id),
    )
  );
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
