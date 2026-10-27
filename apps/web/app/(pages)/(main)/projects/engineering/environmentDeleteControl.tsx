'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { deleteEnvironmentAction } from '@/app/actions/projects/engineering';

export function EnvironmentDeleteControl({
  engineeringId,
  environmentId,
  environmentName,
  expectedVersion,
  mutationId,
  projectId,
}: {
  engineeringId: string;
  environmentId: string;
  environmentName: string;
  expectedVersion: number;
  mutationId: string;
  projectId: string;
}) {
  return (
    <form
      action={deleteEnvironmentAction}
      className="environment-direct-delete"
    >
      <input name="engineeringId" type="hidden" value={engineeringId} />
      <input name="environmentId" type="hidden" value={environmentId} />
      <input name="expectedVersion" type="hidden" value={expectedVersion} />
      <input name="mutationId" type="hidden" value={mutationId} />
      <input name="projectId" type="hidden" value={projectId} />
      <EnvironmentDeleteConfirmation name={environmentName} />
    </form>
  );
}

function EnvironmentDeleteConfirmation({ name }: { name: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const { pending } = useFormStatus();

  function positionPopup() {
    if (!trigger.current || !popup.current) return;
    const box = trigger.current.getBoundingClientRect();
    const panel = popup.current;
    if (box.bottom <= 0 || box.top >= window.innerHeight) {
      panel.hidePopover();
      return;
    }
    const above = box.top - 20;
    const below = window.innerHeight - box.bottom - 20;
    panel.style.maxHeight = `${Math.max(0, above, below)}px`;
    const { width, height } = panel.getBoundingClientRect();
    const upwards = above >= height || above >= below;
    panel.style.left = `${Math.max(12, Math.min(box.right - width, window.innerWidth - width - 12))}px`;
    panel.style.top = `${Math.max(12, upwards ? box.top - height - 8 : box.bottom + 8)}px`;
  }

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', positionPopup);
    window.addEventListener('scroll', positionPopup, true);
    return () => {
      window.removeEventListener('resize', positionPopup);
      window.removeEventListener('scroll', positionPopup, true);
    };
  }, [open]);

  return (
    <>
      <button
        aria-controls={id}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={pending}
        popoverTarget={id}
        ref={trigger}
        type="button"
      >
        删除环境
      </button>
      <div
        aria-busy={pending}
        aria-describedby={`${id}-description`}
        aria-labelledby={`${id}-title`}
        className="environment-delete-popconfirm"
        id={id}
        onToggle={(event) => {
          const visible = event.newState === 'open';
          setOpen(visible);
          if (visible) {
            positionPopup();
            cancel.current?.focus();
          }
        }}
        popover="auto"
        ref={popup}
        role="dialog"
      >
        <strong id={`${id}-title`}>删除“{name}”？</strong>
        <p id={`${id}-description`}>
          删除后无法恢复。已用于提测的环境不能删除。
        </p>
        <div className="environment-delete-popconfirm__actions">
          <button
            disabled={pending}
            onClick={() => {
              popup.current?.hidePopover();
              trigger.current?.focus();
            }}
            ref={cancel}
            type="button"
          >
            取消
          </button>
          <button disabled={pending} type="submit">
            {pending ? '正在删除…' : '确认删除'}
          </button>
        </div>
      </div>
    </>
  );
}
