'use client';

import { useEffect, useId, useRef, useState } from 'react';

export function PassConfirmButton({
  disabled,
  message,
  onConfirm,
}: {
  disabled: boolean;
  message: string;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancel.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <span className="collab-pass-confirm" ref={root}>
      <button
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        ref={trigger}
        type="button"
      >
        通过
      </button>
      {open ? (
        <span
          aria-label="确认通过"
          className="collab-pass-confirm__panel"
          id={id}
          role="dialog"
        >
          <span>{message}</span>
          <span className="collab-pass-confirm__actions">
            <button
              onClick={(event) => {
                event.stopPropagation();
                setOpen(false);
                trigger.current?.focus();
              }}
              ref={cancel}
              type="button"
            >
              取消
            </button>
            <button
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                setOpen(false);
                onConfirm();
              }}
              type="button"
            >
              确认通过
            </button>
          </span>
        </span>
      ) : null}
    </span>
  );
}
