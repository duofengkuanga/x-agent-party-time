'use client';

import type { FormEvent } from 'react';
import { deleteEngineeringBindingAction } from '@/features/cooking/bindings/presentation/actions';

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
  function confirmDelete(event: FormEvent<HTMLFormElement>): void {
    if (
      !window.confirm(
        '删除后，这台 Agent 会清理本机仓库映射。已用于提测或任务的绑定不能删除。确定继续吗？',
      )
    )
      event.preventDefault();
  }

  return (
    <form action={deleteEngineeringBindingAction} onSubmit={confirmDelete}>
      <input name="bindingId" type="hidden" value={bindingId} />
      <input name="confirmed" type="hidden" value="yes" />
      <input name="engineeringId" type="hidden" value={engineeringId} />
      <input name="mutationId" type="hidden" value={mutationId} />
      <input name="projectId" type="hidden" value={projectId} />
      <button type="submit">删除绑定</button>
    </form>
  );
}
