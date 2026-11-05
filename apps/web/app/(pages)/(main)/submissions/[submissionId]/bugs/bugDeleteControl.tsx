'use client';

import { useState } from 'react';
import { createClientId } from '@/app/(pages)/(main)/components/clientId';
import { Popconfirm } from '@/app/(pages)/(main)/components/popconfirm';
import type {
  BugView,
  DeleteWaitingBugInput,
} from '../../../../../../contracts/submissions/bug';
import { deleteWaitingBugAction } from '../../../../../actions/submissions/bugs';
import { bugLabel } from './boardModel';
import type { RunTesterAction } from './testerBugDetail';

export function BugDeleteControl({
  bug,
  className = 'collab-form collab-bug-delete-control',
  error,
  pending,
  run,
  onClearError,
  onDeleted,
}: {
  bug: BugView;
  className?: string;
  error: string | null;
  pending: boolean;
  run: RunTesterAction;
  onClearError: () => void;
  onDeleted?: () => void;
}) {
  const [confirmation, setConfirmation] =
    useState<DeleteWaitingBugInput | null>(null);
  if (!bug.availableActions.includes('DELETE')) return null;
  return (
    <section
      className={className}
      aria-label="删除待修复缺陷"
      aria-busy={pending}
    >
      <Popconfirm
        label="删除缺陷"
        title={`确认删除“${bug.report.description.slice(0, 120)}”？`}
        description={`缺陷资料及附件将从提测单中移除，删除后无法恢复。${bug.relatedBugs.length ? '仅删除当前缺陷，关联缺陷保留。' : ''}`}
        confirmLabel="确认删除"
        pendingLabel="正在删除…"
        open={confirmation !== null}
        pending={pending}
        error={error}
        onOpenChange={(open) => {
          if (pending) return;
          onClearError();
          setConfirmation(
            open
              ? { mutationId: createClientId(), expectedVersion: bug.version }
              : null,
          );
        }}
        onConfirm={() => {
          if (!confirmation) return;
          run(
            () => deleteWaitingBugAction(bug.id, confirmation),
            `${bugLabel(bug)} 已删除。`,
            () => {
              setConfirmation(null);
              onDeleted?.();
            },
          );
        }}
      />
    </section>
  );
}
