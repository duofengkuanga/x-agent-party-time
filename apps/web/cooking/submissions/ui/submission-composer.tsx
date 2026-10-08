'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { createClientId } from '@/cooking/shared/ui/client-id';
import type { User } from '@/platform/auth/contract';
import {
  EnvironmentConfirmation,
  EnvironmentConflicts,
} from './environment-confirmation';
import type {
  EnvironmentConflict,
  SubmissionCreationCatalog,
} from '../contract';
import { createSubmissionAction } from '../server/actions';
import {
  ItemEditor,
  createItemDraft,
  normalizeItemDraft,
  engineeringIsReady,
  type ItemDraft,
} from './item-editor';
import { messageOf } from './workspace-feedback';

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
  const [conflicts, setConflicts] = useState<EnvironmentConflict[]>([]);
  const [confirmEnvironment, setConfirmEnvironment] = useState(false);
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

  async function submit(takeover = false) {
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
        environmentTakeovers: takeover
          ? conflicts.map(
              ({ environmentId, submissionItemId, expectedRevision }) => ({
                environmentId,
                submissionItemId,
                expectedRevision,
              }),
            )
          : undefined,
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
        setError(
          result.error.code === 'RESOURCE_CONFLICT' && result.conflicts?.length
            ? null
            : result.error.message,
        );
        setConflicts(result.conflicts ?? []);
        return;
      }
      onCreated(result.result.id);
    } catch (actionError) {
      setError(messageOf(actionError, '创建提测单失败，请稍后重试。'));
    } finally {
      setPending(false);
      setConfirmEnvironment(false);
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
          <button
            aria-label="关闭创建提测单"
            onClick={onClose}
            disabled={pending}
            type="button"
          >
            ×
          </button>
        </header>
        <div className="collab-dialog__body">
          {catalog.length ? (
            <form
              className="collab-form"
              onChange={() => {
                setConflicts([]);
                setError(null);
              }}
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <fieldset
                className="collab-composer-fields"
                disabled={pending || confirmEnvironment}
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
              </fieldset>
              {conflicts.length ? (
                <section className="collab-environment-notice" role="alert">
                  <h3>所选环境正在被其他提测单使用</h3>
                  <EnvironmentConflicts conflicts={conflicts} />
                  <p>优先使用后，原提测单的对应提测项将暂停更新和测试验证。</p>
                  <div className="collab-dialog__actions">
                    <button
                      type="button"
                      className="collab-primary"
                      disabled={
                        pending ||
                        conflicts.some((value) => value.blockedReason)
                      }
                      onClick={() => setConfirmEnvironment(true)}
                    >
                      优先使用此环境
                    </button>
                  </div>
                </section>
              ) : null}
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
      {confirmEnvironment ? (
        <EnvironmentConfirmation
          title={title}
          conflicts={conflicts}
          pending={pending}
          confirmLabel="确认切换并创建提测单"
          onClose={() => setConfirmEnvironment(false)}
          onConfirm={() => void submit(true)}
        />
      ) : null}
    </div>
  );
}
