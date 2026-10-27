'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import type { InteractiveActionResult } from '@/app/actions/actionTransport';

export function ActionPopconfirm({
  action,
  children,
  className,
  confirmLabel,
  description,
  label,
  pendingLabel,
  successPath,
  title,
  triggerClassName,
}: {
  action: (data: FormData) => Promise<InteractiveActionResult<unknown>>;
  children: ReactNode;
  className: string;
  confirmLabel: string;
  description: string;
  label: string;
  pendingLabel: string;
  successPath?: string;
  title: string;
  triggerClassName?: string;
}) {
  const popup = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  return (
    <form
      action={async (data) => {
        setError(null);
        try {
          const result = await action(data);
          if (!result.ok) {
            setError(result.error.message);
            if (popup.current && !popup.current.matches(':popover-open'))
              popup.current.showPopover();
            return;
          }
          popup.current?.hidePopover();
          if (successPath) router.replace(successPath);
          else router.refresh();
        } catch {
          setError('操作未完成，请检查连接后重试。');
          if (popup.current && !popup.current.matches(':popover-open'))
            popup.current.showPopover();
        }
      }}
      className={className}
    >
      {children}
      <ActionConfirmation
        confirmLabel={confirmLabel}
        description={description}
        error={error}
        label={label}
        pendingLabel={pendingLabel}
        popup={popup}
        title={title}
        triggerClassName={triggerClassName}
      />
    </form>
  );
}

function ActionConfirmation({
  confirmLabel,
  description,
  error,
  label,
  pendingLabel,
  popup,
  title,
  triggerClassName,
}: {
  confirmLabel: string;
  description: string;
  error: string | null;
  label: string;
  pendingLabel: string;
  popup: { current: HTMLDivElement | null };
  title: string;
  triggerClassName?: string;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
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
    positionPopup();
    const observer = new ResizeObserver(positionPopup);
    for (
      let element: Element | null = trigger.current;
      element;
      element = element.parentElement
    )
      observer.observe(element);
    if (popup.current) observer.observe(popup.current);
    window.addEventListener('resize', positionPopup);
    window.addEventListener('scroll', positionPopup, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', positionPopup);
      window.removeEventListener('scroll', positionPopup, true);
    };
  }, [open, error]);

  return (
    <>
      <button
        aria-controls={id}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`action-popconfirm__trigger ${triggerClassName ?? ''}`}
        disabled={pending}
        popoverTarget={id}
        ref={trigger}
        type="button"
      >
        {label}
      </button>
      <div
        aria-busy={pending}
        aria-describedby={`${id}-description`}
        aria-labelledby={`${id}-title`}
        className="action-popconfirm"
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
        <strong id={`${id}-title`}>{title}</strong>
        <p id={`${id}-description`}>{description}</p>
        {error ? <p role="alert">{error}</p> : null}
        <div className="action-popconfirm__actions">
          <button
            autoFocus
            disabled={pending}
            onClick={() => {
              popup.current?.hidePopover();
              trigger.current?.focus();
            }}
            popoverTarget={id}
            popoverTargetAction="hide"
            ref={cancel}
            type="button"
          >
            取消
          </button>
          <button disabled={pending} type="submit">
            {pending ? pendingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}
