'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { createClientId } from '@/cooking/shared/ui/client-id';
import { messageOf } from '@/cooking/shared/ui/action-error';
import type { CookingWorkspaceSnapshot } from '@/cooking/workspace/contract';
import type {
  EnvironmentConflict,
  SubmissionCreationCatalog,
} from '../contract';
import {
  addSubmissionItemsAction,
  loadSubmissionCreationCatalogAction,
} from '../server/actions';
import { createItemDraft, ItemEditor, type ItemDraft } from './item-editor';
import {
  EnvironmentConfirmation,
  EnvironmentConflicts,
} from './environment-confirmation';

export function AddSubmissionItems({
  view,
}: {
  view: CookingWorkspaceSnapshot['submission'];
}) {
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [opened, setOpened] = useState(false);
  const [pending, setPending] = useState(false);
  const [project, setProject] = useState<
    SubmissionCreationCatalog[number] | null
  >(null);
  const [draft, setDraft] = useState<ItemDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<EnvironmentConflict[]>([]);
  const [confirm, setConfirm] = useState(false);
  const selectedIds = view.items.map((item) => item.engineering.id);
  useEffect(() => {
    if (!opened) return;
    const element = dialog.current;
    element?.showModal();
    heading.current?.focus();
    return () => element?.close();
  }, [opened]);

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
      setDraft(
        project ? createItemDraft(project, view.tester.id, selectedIds) : null,
      );
    } catch (error) {
      setError(messageOf(error, '读取工程配置失败，请重试。'));
    } finally {
      setPending(false);
    }
  }

  async function submit(takeover = false) {
    if (!draft) return;
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
                <h2 id="add-submission-items-title" ref={heading} tabIndex={-1}>
                  追加提测工程
                </h2>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setOpened(false)}
                >
                  关闭
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
                      draft={draft}
                      index={view.items.length}
                      project={project}
                      testerUserId={view.tester.id}
                      selectedEngineeringIds={selectedIds}
                      onRemove={null}
                      onChange={(next) => {
                        setDraft(next);
                        setConflicts([]);
                        setError(null);
                      }}
                    />
                  </fieldset>
                ) : null}
                {error ? <p role="alert">{error}</p> : null}
                <EnvironmentConflicts conflicts={conflicts} />
                <div className="collab-dialog__actions">
                  {!draft && error ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => void open()}
                    >
                      重新读取
                    </button>
                  ) : null}
                  <button type="submit" disabled={pending || !draft}>
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
