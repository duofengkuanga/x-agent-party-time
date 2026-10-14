'use client';

import { useRef, useState } from 'react';
import { createClientId } from '@/cooking/shared/ui/client-id';
import type { BugView, DeleteUnassignedBugInput } from '../contract';
import { deleteUnassignedBugAction } from '../server/actions';
import { bugLabel } from './board-model';
import type { RunTesterAction } from './tester-bug-detail';

export function BugDeleteControl({
  bug,
  error,
  pending,
  run,
  onClearError,
  onDeleted,
}: {
  bug: BugView;
  error: string | null;
  pending: boolean;
  run: RunTesterAction;
  onClearError: () => void;
  onDeleted: () => void;
}) {
  const [confirmation, setConfirmation] =
    useState<DeleteUnassignedBugInput | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!bug.availableActions.includes('DELETE')) return null;
  return (
    <section
      className="collab-form collab-bug-delete-control"
      aria-label="删除待分配缺陷"
      aria-busy={pending}
    >
      {confirmation ? (
        <>
          <p>
            确认删除“{bug.report.title}
            ”？缺陷资料及附件将从提测单中移除，删除后无法恢复。
          </p>
          {error ? (
            <p className="collab-form__error" role="alert">
              {error}
            </p>
          ) : null}
          {pending ? <span role="status">正在删除…</span> : null}
          <div
            className="collab-routing-actions"
            role="group"
            aria-label="确认删除缺陷"
          >
            <button
              autoFocus
              disabled={pending}
              type="button"
              onClick={() => {
                onClearError();
                setConfirmation(null);
                window.requestAnimationFrame(() => trigger.current?.focus());
              }}
            >
              取消
            </button>
            <button
              disabled={pending}
              type="button"
              onClick={() =>
                run(
                  () => deleteUnassignedBugAction(bug.id, confirmation),
                  `${bugLabel(bug)} 已删除。`,
                  onDeleted,
                )
              }
            >
              确认删除
            </button>
          </div>
        </>
      ) : (
        <div className="collab-routing-actions">
          <button
            ref={trigger}
            disabled={pending}
            type="button"
            onClick={() => {
              onClearError();
              setConfirmation({
                mutationId: createClientId(),
                expectedVersion: bug.version,
              });
            }}
          >
            删除缺陷
          </button>
        </div>
      )}
    </section>
  );
}
