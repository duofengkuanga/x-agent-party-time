'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { FormChoice } from '@/app/(pages)/(main)/components/formChoice';
import { DiscardDraft } from '@/app/(pages)/(main)/components/discardDraft';
import {
  createSubmissionDraft,
  preferredTester,
  submissionPreparationHint,
  type SubmissionDraft,
  type SubmissionContext,
} from './submissionDraft';
import type { User } from '@/contracts/auth';
import {
  EnvironmentConfirmation,
  EnvironmentConflicts,
} from './environmentConfirmation';
import type {
  EnvironmentConflict,
  SubmissionCreationCatalog,
} from '../../../../../contracts/submissions/submission';
import { createSubmissionAction } from '../../../../actions/submissions/submissions';
import {
  ItemEditor,
  createItemDraft,
  normalizeItemDraft,
  engineeringIsReady,
  type ItemDraft,
  availableTesterMembers,
  itemDraftIsValid,
} from './itemEditor';
import { messageOf } from '@/app/(pages)/(main)/components/actionError';

export function SubmissionComposer({
  catalog,
  currentUser,
  context,
  savedDraft,
  onDraftChange,
  onDiscard,
  onClose,
  onCreated,
}: {
  catalog: SubmissionCreationCatalog;
  currentUser: User;
  context: SubmissionContext;
  savedDraft: SubmissionDraft | null;
  onDraftChange: (draft: SubmissionDraft) => void;
  onDiscard: () => void;
  onClose: () => void;
  onCreated: (submissionId: string) => void;
}) {
  const [defaults] = useState(() =>
    createSubmissionDraft(catalog, currentUser.id, context, null),
  );
  const [initial] = useState(() =>
    savedDraft
      ? createSubmissionDraft(catalog, currentUser.id, context, savedDraft)
      : defaults,
  );
  const [projectId, setProjectId] = useState(initial.projectId);
  const [title, setTitle] = useState(initial.title);
  const [requirementDescription, setRequirementDescription] = useState(
    initial.requirementDescription,
  );
  const [testerUserId, setTesterUserId] = useState(initial.testerUserId);
  const [items, setItems] = useState<ItemDraft[]>(initial.items);
  useEffect(
    () =>
      onDraftChange({
        mutationId: initial.mutationId,
        projectId,
        title,
        requirementDescription,
        testerUserId,
        items,
      }),
    [
      initial.mutationId,
      projectId,
      title,
      requirementDescription,
      testerUserId,
      items,
      onDraftChange,
    ],
  );
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
    const nextTesterId = nextProject
      ? preferredTester(nextProject, currentUser.id, context)
      : '';
    setProjectId(nextProjectId);
    setTesterUserId(nextTesterId);
    const first = nextProject
      ? createItemDraft(nextProject, nextTesterId, [])
      : null;
    setItems(first ? [first] : []);
    setError(null);
  }

  function changeTester(nextTesterId: string) {
    if (
      !project ||
      !availableTesterMembers(
        project,
        items.map(({ engineeringId }) => engineeringId),
      ).some(({ id }) => id === nextTesterId)
    )
      return;
    setTesterUserId(nextTesterId);
    setItems((current) =>
      current.length
        ? current.map((item) =>
            normalizeItemDraft(project, item, nextTesterId, item.engineeringId),
          )
        : (() => {
            const first = createItemDraft(project, nextTesterId, []);
            return first ? [first] : [];
          })(),
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
    if (
      !items.length ||
      !items.every((item) => itemDraftIsValid(project, item, testerUserId))
    ) {
      setError('请补全提测工程、开发负责人、Agent、目标分支和环境。');
      return;
    }
    if (!takeover) {
      const occupied = items.flatMap(
        (item) =>
          project.engineerings
            .find(({ id }) => id === item.engineeringId)
            ?.environments.find(({ id }) => id === item.environmentId)
            ?.conflict ?? [],
      );
      if (occupied.length) {
        setConflicts(occupied);
        return;
      }
    }
    setPending(true);
    setError(null);
    try {
      const result = await createSubmissionAction(project.projectId, {
        mutationId: initial.mutationId,
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
  const hasDraftChanges = Boolean(
    title ||
    requirementDescription ||
    projectId !== defaults.projectId ||
    testerUserId !== defaults.testerUserId ||
    JSON.stringify(items.map(({ key: _key, ...item }) => item)) !==
      JSON.stringify(defaults.items.map(({ key: _key, ...item }) => item)),
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
                  <FormChoice
                    label="项目"
                    value={projectId}
                    onChange={(id) => {
                      setConflicts([]);
                      setError(null);
                      changeProject(id);
                    }}
                    options={catalog.map((candidate) => ({
                      value: candidate.projectId,
                      label: candidate.projectName,
                    }))}
                  />
                  <FormChoice
                    label="测试负责人"
                    value={testerUserId}
                    onChange={(id) => {
                      setConflicts([]);
                      setError(null);
                      changeTester(id);
                    }}
                    options={(project
                      ? availableTesterMembers(project, selectedEngineeringIds)
                      : []
                    ).map((member) => ({
                      value: member.id,
                      label: member.displayName,
                    }))}
                  />
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
                    rows={3}
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
                        onChange={(next) => {
                          setConflicts([]);
                          setError(null);
                          updateItem(item.key, () => next);
                        }}
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
                      <p>{submissionPreparationHint(project)}</p>
                    </div>
                    <Link href="/projects">前往配置</Link>
                  </div>
                )}

                {canAddItem ? (
                  <button
                    className="collab-add-engineering"
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
                ) : null}
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
                  暂存并关闭
                </button>
                {hasDraftChanges ? (
                  <DiscardDraft disabled={pending} onDiscard={onDiscard} />
                ) : null}
                <button
                  className="collab-primary"
                  disabled={
                    pending ||
                    !title.trim() ||
                    !requirementDescription.trim() ||
                    !project ||
                    !items.length ||
                    !items.every((item) =>
                      itemDraftIsValid(project, item, testerUserId),
                    )
                  }
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
              <Link href="/projects">前往配置</Link>
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
