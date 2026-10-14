'use client';

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

const STORAGE_KEY = 'cooking-board-column-widths:v1';
const COLUMN_COUNT = 6;
const DIVIDER_WIDTH = 10;
const MIN_COLUMN_WIDTH = 140;
const DEFAULT_WIDTHS = Array<number>(COLUMN_COUNT).fill(1);

type DragState = {
  index: number;
  pointerId: number;
  startX: number;
  startWidths: number[];
};

function validWidths(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === COLUMN_COUNT &&
    value.every(
      (width) =>
        typeof width === 'number' && Number.isFinite(width) && width > 0,
    )
  );
}

export function resizeAdjacentColumns(
  widths: number[],
  index: number,
  delta: number,
): number[] {
  if (
    widths[index] === undefined ||
    widths[index + 1] === undefined ||
    !Number.isFinite(delta)
  )
    return widths;
  const next = [...widths];
  let remaining = Math.abs(delta);
  if (delta > 0) {
    for (
      let position = index + 1;
      position < next.length && remaining > 0;
      position++
    ) {
      const taken = Math.min(
        remaining,
        Math.max(0, next[position]! - MIN_COLUMN_WIDTH),
      );
      next[position] -= taken;
      remaining -= taken;
    }
    next[index] += delta - remaining;
  } else if (delta < 0) {
    for (let position = index; position >= 0 && remaining > 0; position--) {
      const taken = Math.min(
        remaining,
        Math.max(0, next[position]! - MIN_COLUMN_WIDTH),
      );
      next[position] -= taken;
      remaining -= taken;
    }
    next[index + 1] += -delta - remaining;
  }
  return next;
}

export function useBoardColumnWidths() {
  const boardRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<DragState | null>(null);
  const [widths, setWidths] = useState(DEFAULT_WIDTHS);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (validWidths(parsed)) setWidths(parsed);
      }
    } catch (error) {
      console.warn('无法读取看板列宽偏好', error);
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
    } catch (error) {
      console.warn('无法保存看板列宽偏好', error);
    }
  }, [restored, widths]);

  const columnPixels = () =>
    [
      ...(boardRef.current?.querySelectorAll<HTMLElement>(
        ':scope > .collab-column',
      ) ?? []),
    ].map((column) => column.getBoundingClientRect().width);

  const onPointerDown = (
    index: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    const startWidths = columnPixels();
    if (startWidths.length !== COLUMN_COUNT) return;
    dragging.current = {
      index,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidths,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = dragging.current;
    if (!active || active.pointerId !== event.pointerId) return;
    setWidths(
      resizeAdjacentColumns(
        active.startWidths,
        active.index,
        event.clientX - active.startX,
      ),
    );
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging.current?.pointerId !== event.pointerId) return;
    dragging.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = dragging.current;
    if (!active || active.pointerId !== event.pointerId) return;
    setWidths(active.startWidths);
    dragging.current = null;
  };

  const onKeyDown = (
    index: number,
    event: React.KeyboardEvent<HTMLDivElement>,
  ) => {
    const pixels = columnPixels();
    if (pixels.length !== COLUMN_COUNT) return;
    const step = event.shiftKey ? 48 : 16;
    const delta =
      event.key === 'ArrowLeft'
        ? -step
        : event.key === 'ArrowRight'
          ? step
          : event.key === 'Home'
            ? -pixels[index]!
            : event.key === 'End'
              ? pixels[index + 1]!
              : null;
    if (delta === null) return;
    event.preventDefault();
    setWidths(resizeAdjacentColumns(pixels, index, delta));
  };

  return {
    boardRef,
    template: widths
      .map((width) => `minmax(${MIN_COLUMN_WIDTH}px, ${width}fr)`)
      .join(` ${DIVIDER_WIDTH}px `),
    widths,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onKeyDown,
    reset: () => setWidths([...DEFAULT_WIDTHS]),
  };
}

export function BoardColumnDivider({
  index,
  leftLabel,
  rightLabel,
  resize,
}: {
  index: number;
  leftLabel: string;
  rightLabel: string;
  resize: ReturnType<typeof useBoardColumnWidths>;
}) {
  const left = resize.widths[index] ?? 1;
  const right = resize.widths[index + 1] ?? 1;
  return (
    <div
      aria-label={`调整${leftLabel}与${rightLabel}的列宽`}
      aria-orientation="vertical"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round((left / (left + right)) * 100)}
      className="collab-board__resize-handle"
      onDoubleClick={resize.reset}
      onKeyDown={(event) => resize.onKeyDown(index, event)}
      onPointerCancel={resize.onPointerCancel}
      onPointerDown={(event) => resize.onPointerDown(index, event)}
      onPointerMove={resize.onPointerMove}
      onPointerUp={resize.onPointerUp}
      role="separator"
      tabIndex={0}
      title="拖拽调整列宽，双击恢复等宽"
    />
  );
}
