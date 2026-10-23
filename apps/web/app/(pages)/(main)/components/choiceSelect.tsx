'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

export type ChoiceOption = { value: string; label: string };

export function ChoiceSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: ChoiceOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef({ text: '', time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));

  function positionMenu() {
    if (!trigger.current || !menu.current) return;
    const box = trigger.current.getBoundingClientRect();
    const popup = menu.current;
    if (
      box.bottom <= 0 ||
      box.top >= window.innerHeight ||
      trigger.current.matches(':disabled')
    ) {
      popup.hidePopover();
      setOpen(false);
      return;
    }
    const width = Math.min(box.width, window.innerWidth - 16);
    popup.style.width = `${width}px`;
    const below = window.innerHeight - box.bottom - 14;
    const above = box.top - 14;
    const height = Math.min(popup.scrollHeight + 2, 280);
    const upwards = below < height && above > below;
    const maxHeight = Math.max(0, Math.min(280, upwards ? above : below));
    popup.style.maxHeight = `${maxHeight}px`;
    popup.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`;
    popup.style.top = `${upwards ? box.top - Math.min(height, maxHeight) - 6 : box.bottom + 6}px`;
  }

  function closeMenu() {
    menu.current?.hidePopover();
    setOpen(false);
  }

  function openMenu(index = Math.max(0, selectedIndex)) {
    if (trigger.current?.matches(':disabled')) return;
    setActive(index);
    menu.current?.showPopover();
    positionMenu();
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || trigger.current?.matches(':disabled')) {
      closeMenu();
      return;
    }
    closeMenu();
    if (option.value !== value) onChange(option.value);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
    } else if (event.key === 'Tab') {
      if (open) choose(activeIndex);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(activeIndex);
      else openMenu();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openMenu();
      else
        setActive(
          (activeIndex +
            (event.key === 'ArrowDown' ? 1 : -1) +
            options.length) %
            options.length,
        );
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      openMenu(event.key === 'Home' ? 0 : options.length - 1);
    } else if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      const now = Date.now();
      const text =
        (now - search.current.time < 700 ? search.current.text : '') +
        event.key.toLocaleLowerCase();
      search.current = { text, time: now };
      const prefix = [...text].every((character) => character === text[0])
        ? text[0]!
        : text;
      const start = open ? activeIndex : selectedIndex;
      for (let step = 1; step <= options.length; step++) {
        const index = (start + step + options.length) % options.length;
        if (options[index]!.label.toLocaleLowerCase().startsWith(prefix)) {
          openMenu(index);
          break;
        }
      }
    }
  }

  useEffect(() => {
    if (!open) return;
    const reposition = () => positionMenu();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !menu.current) return;
    positionMenu();
    const option = menu.current.children[activeIndex] as
      HTMLElement | undefined;
    if (!option) return;
    const popup = menu.current;
    if (option.offsetTop < popup.scrollTop) popup.scrollTop = option.offsetTop;
    else if (
      option.offsetTop + option.offsetHeight >
      popup.scrollTop + popup.clientHeight
    )
      popup.scrollTop =
        option.offsetTop + option.offsetHeight - popup.clientHeight;
  });

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="choice-select__trigger"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open ? `${id}-option-${activeIndex}` : undefined}
        disabled={disabled || options.length === 0}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (open) closeMenu();
        }}
      >
        <span className="choice-select__value">
          {options[selectedIndex]?.label ?? `请选择${label}`}
        </span>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16">
          <path
            d="m4 6 4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
      </button>
      <div
        ref={menu}
        id={`${id}-list`}
        className="choice-select__menu"
        popover="auto"
        role="listbox"
        aria-label={label}
        onToggle={(event) => setOpen(event.newState === 'open')}
        onPointerDown={(event) => event.preventDefault()}
      >
        {options.map((option, index) => (
          <div
            id={`${id}-option-${index}`}
            key={option.value}
            className="choice-select__option"
            role="option"
            aria-selected={option.value === value}
            data-active={index === activeIndex}
            onPointerMove={() => setActive(index)}
            onClick={() => choose(index)}
          >
            <span>{option.label}</span>
            {option.value === value ? (
              <svg
                aria-hidden="true"
                width="14"
                height="14"
                viewBox="0 0 16 16"
              >
                <path
                  d="m3 8 3 3 7-7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}
