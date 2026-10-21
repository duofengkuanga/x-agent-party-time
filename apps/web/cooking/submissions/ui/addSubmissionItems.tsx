'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { createClientId } from '@/cooking/shared/ui/clientId';
import { messageOf } from '@/cooking/shared/ui/actionError';
import type { CookingWorkspaceSnapshot } from '@/cooking/workspace/contract';
import type {
  EnvironmentConflict,
  SubmissionCreationCatalog,
} from '../contract';
import {
  addSubmissionItemsAction,
  loadSubmissionCreationCatalogAction,
} from '../server/actions';
import {
  createItemDraft,
  ItemEditor,
  normalizeItemDraft,
  engineeringIsReady,
  itemDraftIsValid,
  type ItemDraft,
} from './itemEditor';
import { DiscardDraft } from '@/cooking/shared/ui/discardDraft';
import {
  EnvironmentConfirmation,
  EnvironmentConflicts,
} from './environmentConfirmation';

export function AddSubmissionItems({
  view,
}: {
  view: CookingWorkspaceSnapshot['submission'];
}) {
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [opened, setOpened] = useState(false);
  const [pending, setPending] = useState(false);
  const [project, setProject] = useState<
    SubmissionCreationCatalog[number] | null
  >(null);
  const [draft, setDraft] = useState<ItemDraft | null>(null);
  const savedDraft = useRef<ItemDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<EnvironmentConflict[]>([]);
  const [confirm, setConfirm] = useState(false);
  const selectedIds = view.items.map((item) => item.engineering.id);
  useEffect(() => {
    if (!opened) return;
    const element = dialog.current;
    element?.showModal();
    closeButton.current?.focus();
    return () => element?.close();
  }, [opened]);
  useEffect(() => {
    if (project) closeButton.current?.focus();
  }, [project]);

  async function open() {
    setOpened(true);
    setPending(true);
    setError(null);
    setProject(null);
    setDraft(null);
    setConflicts([]);
    try {
      const result = await loadSubmissionCreationCatalogAction();
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      const project =
        result.catalog.find(
          (entry) => entry.projectId === view.submission.projectId,
        ) ?? null;
      setProject(project);
      const saved = savedDraft.current;
      const engineering = project?.engineerings.find(
        ({ id }) => id === saved?.engineeringId && !selectedIds.includes(id),
      );
      const next =
        project &&
        saved &&
        engineering &&
        engineeringIsReady(engineering, view.tester.id)
          ? normalizeItemDraft(project, saved, view.tester.id, engineering.id)
          : project
            ? createItemDraft(project, view.tester.id, selectedIds)
            : null;
      savedDraft.current = next;
      setDraft(next);
    } catch (error) {
      setError(messageOf(error, '读取工程配置失败，请重试。'));
    } finally {
      setPending(false);
    }
  }

  async function submit(takeover = false) {
    if (!draft || !project || !itemDraftIsValid(project, draft, view.tester.id))
      return;
    if (!takeover) {
      const conflict = project.engineerings
        .find(({ id }) => id === draft.engineeringId)
        ?.environments.find(({ id }) => id === draft.environmentId)?.conflict;
      if (conflict) {
        setConflicts([conflict]);
        return;
      }
    }
    setPending(true);
    setError(null);
    try {
      const { key: _key, ...item } = draft;
      const result = await addSubmissionItemsAction(view.submission.id, {
        mutationId: createClientId(),
        expectedVersion: view.submission.version,
        items: [item],
        environmentTakeovers: takeover
          ? conflicts.map(
              ({ environmentId, submissionItemId, expectedRevision }) => ({
                environmentId,
                submissionItemId,
                expectedRevision,
              }),
            )
          : undefined,
      });
      if (!result.ok) {
        setConflicts(result.conflicts ?? []);
        setError(result.conflicts?.length ? null : result.error.message);
        return;
      }
      setOpened(false);
      savedDraft.current = null;
      router.refresh();
    } catch (error) {
      setError(messageOf(error, '追加工程失败，请稍后重试。'));
    } finally {
      setPending(false);
      setConfirm(false);
    }
  }

  return (
    <>
      <button
        className="collab-add-items-trigger"
        ref={trigger}
        type="button"
        disabled={pending || view.items.length >= 20}
        aria-expanded={opened}
        onClick={() => void open()}
      >
        追加工程
      </button>
      {opened
        ? createPortal(
            <dialog
              ref={dialog}
              className="collab-dialog collab-add-items-dialog"
              aria-modal="true"
              aria-labelledby="add-submission-items-title"
              onCancel={(event) => {
                event.preventDefault();
                if (!pending) setOpened(false);
              }}
            >
              <header>
                <h2 id="add-submission-items-title">追加工程</h2>
                <button
                  ref={closeButton}
                  aria-label="关闭追加工程"
                  type="button"
                  disabled={pending}
                  onClick={() => setOpened(false)}
                >
                  ×
                </button>
              </header>
              <form
                className="collab-form collab-dialog__body"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                {pending && !project ? (
                  <p role="status">正在读取工程配置…</p>
                ) : null}
                {!pending && !draft && !error ? (
                  <p>
                    没有可追加的工程，请先在项目中配置工程、环境和 Agent 绑定。
                  </p>
                ) : null}
                {project && draft ? (
                  <fieldset disabled={pending}>
                    <ItemEditor
                      showHeading={false}
                      draft={draft}
                      index={view.items.length}
                      project={project}
                      testerUserId={view.tester.id}
                      selectedEngineeringIds={selectedIds}
                      onRemove={null}
                      onChange={(next) => {
                        setDraft(next);
                        savedDraft.current = next;
                        setConflicts([]);
                        setError(null);
                      }}
                    />
                  </fieldset>
                ) : null}
                {error ? <p role="alert">{error}</p> : null}
                <EnvironmentConflicts conflicts={conflicts} />
                <div className="collab-dialog__actions">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => setOpened(false)}
                  >
                    暂存并关闭
                  </button>
                  {draft ? (
                    <DiscardDraft
                      disabled={pending}
                      onDiscard={() => {
                        savedDraft.current = null;
                        setOpened(false);
                      }}
                    />
                  ) : null}
                  {!draft && error ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => void open()}
                    >
                      重新读取
                    </button>
                  ) : null}
                  <button
                    type="submit"
                    disabled={
                      pending ||
                      !draft ||
                      !project ||
                      !itemDraftIsValid(project, draft, view.tester.id)
                    }
                  >
                    {pending ? '正在处理…' : '追加工程'}
                  </button>
                  {conflicts.length ? (
                    <button
                      type="button"
                      disabled={
                        pending ||
                        conflicts.some((value) => value.blockedReason)
                      }
                      onClick={() => setConfirm(true)}
                    >
                      优先使用此环境
                    </button>
                  ) : null}
                </div>
              </form>
            </dialog>,
            trigger.current?.closest('.collab-shell') ?? document.body,
          )
        : null}
      {confirm ? (
        <EnvironmentConfirmation
          title={view.submission.title}
          conflicts={conflicts}
          pending={pending}
          confirmLabel="切换环境并追加工程"
          onConfirm={() => void submit(true)}
          onClose={() => setConfirm(false)}
        />
      ) : null}
    </>
  );
}
