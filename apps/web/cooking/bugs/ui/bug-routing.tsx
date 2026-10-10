'use client';

import { useState } from 'react';
import type { BugView, RouteBugInput } from '../contract';
import { routeBugAction } from '../server/actions';
import { createClientId } from '@/cooking/shared/ui/client-id';
import { useWorkspaceMutation } from './use-workspace-mutation';

export function BugRouting({
  bug,
  onChanged,
}: {
  bug: BugView;
  onChanged: (revision: number, message: string) => void;
}) {
  const { error, pending, run } = useWorkspaceMutation(onChanged);
  const [targetId, setTargetId] = useState(bug.routing.targets[0]?.id ?? '');
  const [confirmation, setConfirmation] = useState<
    RouteBugInput['kind'] | null
  >(null);
  const [mutationId, setMutationId] = useState(createClientId);
  const target = bug.routing.targets.find(({ id }) => id === targetId);
  if (
    !target ||
    bug.collaborationLocked ||
    bug.transferredAt ||
    ['DONE', 'CANCELLED'].includes(bug.stage)
  )
    return null;
  const side = target.type === 'FRONTEND' ? '前端' : '后端';
  return (
    <section
      className="collab-bug-detail-section collab-form"
      aria-label="人工工程流转"
    >
      <h3>人工处理</h3>
      <p>阅读修复结果后，判断是否需要其他工程处理。</p>
      <label>
        <span>目标工程</span>
        <select
          aria-label="目标工程"
          value={targetId}
          disabled={pending || confirmation !== null}
          onChange={(event) => setTargetId(event.target.value)}
        >
          {bug.routing.targets.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {confirmation ? (
        <div role="group" aria-label="确认工程流转">
          <p>
            {confirmation === 'TRANSFER'
              ? '确认后将关闭本单，并创建关联新单自动排队修复。关闭不代表验收通过。'
              : '确认后将保留本单，并创建另一工程的关联单自动排队修复。原会话后续由工程负责人手动继续。'}
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirmation(null)}
          >
            取消
          </button>
          <button
            type="button"
            disabled={
              pending ||
              Boolean(
                confirmation === 'TRANSFER'
                  ? bug.routing.transferReason
                  : bug.routing.collaborationReason,
              )
            }
            onClick={() =>
              run(
                () =>
                  routeBugAction(bug.id, {
                    mutationId,
                    expectedVersion: bug.version,
                    targetSubmissionItemId: targetId,
                    kind: confirmation,
                  }),
                confirmation === 'TRANSFER'
                  ? '原单已转交关闭，新单已进入修复队列。'
                  : '已创建协作单并进入修复队列，原单保留。',
                () => setConfirmation(null),
              )
            }
          >
            {pending
              ? '处理中…'
              : confirmation === 'TRANSFER'
                ? '确认转交'
                : '确认增加协作'}
          </button>
        </div>
      ) : (
        <div>
          <button
            type="button"
            disabled={pending || Boolean(bug.routing.transferReason)}
            title={bug.routing.transferReason ?? undefined}
            onClick={() => {
              setMutationId(createClientId());
              setConfirmation('TRANSFER');
            }}
          >
            转交{side}
          </button>
          <button
            type="button"
            disabled={pending || Boolean(bug.routing.collaborationReason)}
            title={bug.routing.collaborationReason ?? undefined}
            onClick={() => {
              setMutationId(createClientId());
              setConfirmation('COLLABORATE');
            }}
          >
            增加{side}协作
          </button>
        </div>
      )}
      {bug.routing.collaborationReason ? (
        <p>{bug.routing.collaborationReason}</p>
      ) : bug.routing.transferReason ? (
        <p>{bug.routing.transferReason}</p>
      ) : null}
      {error ? (
        <p role="alert" className="collab-form__error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
