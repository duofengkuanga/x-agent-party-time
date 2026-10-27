'use client';

import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

export function EngineeringCreateModal({
  children,
  onClose,
  open,
}: {
  children: ReactNode;
  onClose: () => void;
  open: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      element.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
    } else if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      aria-labelledby={titleId}
      className="engineering-create-modal"
      onClose={onClose}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          event.currentTarget.close();
      }}
      ref={dialog}
    >
      <header>
        <h2 id={titleId}>加入工程</h2>
        <button
          aria-label="关闭加入工程"
          onClick={() => dialog.current?.close()}
          type="button"
        >
          ×
        </button>
      </header>
      <div className="engineering-create-modal__body">{children}</div>
    </dialog>
  );
}

export function EngineeringCreateCancel() {
  const { pending } = useFormStatus();
  return (
    <button
      disabled={pending}
      onClick={(event) => event.currentTarget.closest('dialog')?.close()}
      type="button"
    >
      取消
    </button>
  );
}
