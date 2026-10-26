'use client';

import { useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { deleteEngineeringBindingAction } from '@/app/actions/projects/engineering';

export function BindingDeleteForm({
  bindingId,
  engineeringId,
  mutationId,
  projectId,
}: {
  bindingId: string;
  engineeringId: string;
  mutationId: string;
  projectId: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  return (
    <form action={deleteEngineeringBindingAction}>
      <input name="bindingId" type="hidden" value={bindingId} />
      <input name="confirmed" type="hidden" value="yes" />
      <input name="engineeringId" type="hidden" value={engineeringId} />
      <input name="mutationId" type="hidden" value={mutationId} />
      <input name="projectId" type="hidden" value={projectId} />
      {confirming ? (
        <BindingDeleteConfirmation
          onCancel={() => {
            setConfirming(false);
            window.requestAnimationFrame(() => trigger.current?.focus());
          }}
        />
      ) : (
        <button
          aria-expanded={false}
          onClick={() => setConfirming(true)}
          ref={trigger}
          type="button"
        >
          删除绑定
        </button>
      )}
    </form>
  );
}

function BindingDeleteConfirmation({ onCancel }: { onCancel: () => void }) {
  const { pending } = useFormStatus();
  return (
    <div
      aria-busy={pending}
      aria-label="确认删除绑定"
      className="binding-delete-confirmation"
      role="group"
    >
      <p>删除后，Agent 会清理本机仓库映射。已用于提测或任务的绑定不能删除。</p>
      <div>
        <button disabled={pending} onClick={onCancel} type="button">
          取消删除
        </button>
        <button disabled={pending} type="submit">
          {pending ? '正在删除…' : '确认删除绑定'}
        </button>
      </div>
      {pending ? <p role="status">正在删除绑定…</p> : null}
    </div>
  );
}
