'use client';

import { useEffect, useId, useLayoutEffect, useRef } from 'react';

type ConfirmationAction =
  | { submit: true; onConfirm?: never }
  | { submit?: false; onConfirm: () => void };

export type PopconfirmProps = ConfirmationAction & {
  label: string;
  title: string;
  description?: string;
  confirmLabel: string;
  pendingLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  pending?: boolean;
  error?: string | null;
  presentation?: 'popover' | 'inline';
  triggerClassName?: string;
};

/** Controlled confirmation UI. Callers own mutation, pending, error, and navigation. */
export function Popconfirm(props: PopconfirmProps) {
  const {
    label,
    title,
    description,
    confirmLabel,
    pendingLabel,
    open,
    onOpenChange,
    disabled = false,
    pending = false,
    error,
    presentation = 'popover',
    triggerClassName,
  } = props;
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLSpanElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const initialized = useRef(false);
  const floating = presentation === 'popover';

  function positionPopup() {
    if (!trigger.current || !popup.current?.matches(':popover-open')) return;
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

  useLayoutEffect(() => {
    const panel = popup.current;
    if (!panel) return;
    if (floating) {
      if (!initialized.current && !open && panel.matches(':popover-open')) {
        initialized.current = true;
        onOpenChange(true);
        positionPopup();
        return;
      }
      initialized.current = true;
      if (open && !panel.matches(':popover-open')) panel.showPopover();
      else if (!open && panel.matches(':popover-open')) panel.hidePopover();
      if (open) positionPopup();
    }
    if (open && !pending && !panel.contains(document.activeElement))
      cancel.current?.focus();
  }, [open, floating, pending, error, onOpenChange]);

  useEffect(() => {
    if (!open || !floating) return;
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
  }, [open, floating]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !trigger.current?.contains(event.target) &&
        !popup.current?.contains(event.target)
      )
        onOpenChange(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (floating && !popup.current?.matches(':popover-open')) return;
      event.preventDefault();
      event.stopPropagation();
      if (floating) popup.current?.hidePopover();
      onOpenChange(false);
      trigger.current?.focus();
    };
    if (!floating) document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open, floating, onOpenChange]);

  return (
    <>
      <button
        aria-controls={floating || open ? id : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`popconfirm__trigger ${triggerClassName ?? ''}`}
        disabled={disabled || pending}
        onClick={(event) => {
          event.stopPropagation();
          if (!floating) onOpenChange(!open);
        }}
        popoverTarget={floating ? id : undefined}
        ref={trigger}
        type="button"
      >
        {label}
      </button>
      {floating || open ? (
        <span
          aria-busy={pending}
          aria-describedby={description ? `${id}-description` : undefined}
          aria-labelledby={`${id}-title`}
          className={`popconfirm popconfirm--${presentation}`}
          id={id}
          key={presentation}
          onToggle={
            floating
              ? (event) => {
                  const visible = event.currentTarget.matches(':popover-open');
                  onOpenChange(visible);
                  if (visible) {
                    positionPopup();
                    if (
                      !pending &&
                      !event.currentTarget.contains(document.activeElement)
                    )
                      cancel.current?.focus();
                  }
                }
              : undefined
          }
          popover={floating ? 'auto' : undefined}
          ref={popup}
          role="dialog"
        >
          <strong className="popconfirm__title" id={`${id}-title`}>
            {title}
          </strong>
          {description ? (
            <span className="popconfirm__description" id={`${id}-description`}>
              {description}
            </span>
          ) : null}
          {error ? (
            <span className="popconfirm__error" role="alert">
              {error}
            </span>
          ) : null}
          <span className="popconfirm__actions">
            <button
              autoFocus
              disabled={pending}
              onClick={(event) => {
                event.stopPropagation();
                if (floating) popup.current?.hidePopover();
                onOpenChange(false);
                trigger.current?.focus();
              }}
              popoverTarget={floating ? id : undefined}
              popoverTargetAction={floating ? 'hide' : undefined}
              ref={cancel}
              type="button"
            >
              取消
            </button>
            <button
              disabled={disabled || pending}
              onClick={(event) => {
                event.stopPropagation();
                if (props.submit !== true) {
                  props.onConfirm();
                }
              }}
              type={props.submit ? 'submit' : 'button'}
            >
              {pending ? pendingLabel : confirmLabel}
            </button>
          </span>
        </span>
      ) : null}
    </>
  );
}
