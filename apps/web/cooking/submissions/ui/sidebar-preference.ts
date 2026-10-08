'use client';

import {
  SIDEBAR_COOKIE_NAME,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
} from '@/cooking/shared/ui/sidebar-width';
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

export const SIDEBAR_STORAGE_KEY = 'agent-party-time:collab-sidebar-width';

export const SIDEBAR_CHANGE_EVENT =
  'agent-party-time:collab-sidebar-width-change';

export function subscribeSidebarWidth(onStoreChange: () => void) {
  window.addEventListener(SIDEBAR_CHANGE_EVENT, onStoreChange);
  window.addEventListener('storage', onStoreChange);
  window.addEventListener('resize', onStoreChange);
  return () => {
    window.removeEventListener(SIDEBAR_CHANGE_EVENT, onStoreChange);
    window.removeEventListener('storage', onStoreChange);
    window.removeEventListener('resize', onStoreChange);
  };
}

export function getSidebarWidthSnapshot(serverFallback: number): number {
  const storedWidth = Number(window.localStorage.getItem(SIDEBAR_STORAGE_KEY));
  const base =
    Number.isFinite(storedWidth) && storedWidth > 0
      ? storedWidth
      : serverFallback;
  return clampSidebarWidth(base);
}

export function writeSidebarWidthCookie(width: number) {
  document.cookie = `${SIDEBAR_COOKIE_NAME}=${width}; path=/cooking; max-age=31536000`;
}

export function useSidebarWidth(initialSidebarWidth: number) {
  const storedSidebarWidth = useSyncExternalStore(
    subscribeSidebarWidth,
    () => getSidebarWidthSnapshot(initialSidebarWidth),
    () => initialSidebarWidth,
  );
  const [sidebarWidthOverride, setSidebarWidthOverride] = useState<
    number | null
  >(null);
  const sidebarWidth = sidebarWidthOverride ?? storedSidebarWidth;
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const sidebarDrag = useRef<{
    currentWidth: number;
    startWidth: number;
    startX: number;
  } | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (!stored) return;
    const storedWidth = Number(stored);
    if (!(Number.isFinite(storedWidth) && storedWidth > 0)) return;
    writeSidebarWidthCookie(clampSidebarWidth(storedWidth));
  }, []);

  function saveSidebarWidth(width: number) {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(width));
    writeSidebarWidthCookie(width);
    window.dispatchEvent(new Event(SIDEBAR_CHANGE_EVENT));
  }

  function beginSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || window.matchMedia('(max-width: 760px)').matches)
      return;
    sidebarDrag.current = {
      currentWidth: sidebarWidth,
      startWidth: sidebarWidth,
      startX: event.clientX,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setSidebarResizing(true);
  }

  function resizeSidebar(event: ReactPointerEvent<HTMLDivElement>) {
    if (!sidebarDrag.current) return;
    const nextWidth = clampSidebarWidth(
      sidebarDrag.current.startWidth +
        event.clientX -
        sidebarDrag.current.startX,
    );
    sidebarDrag.current.currentWidth = nextWidth;
    setSidebarWidthOverride(nextWidth);
  }

  function finishSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!sidebarDrag.current) return;
    const finalWidth = sidebarDrag.current.currentWidth;
    sidebarDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setSidebarWidthOverride(null);
    setSidebarResizing(false);
    saveSidebarWidth(finalWidth);
  }

  function cancelSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!sidebarDrag.current) return;
    sidebarDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setSidebarWidthOverride(null);
    setSidebarResizing(false);
  }

  function resizeSidebarWithKeyboard(
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    const step = event.shiftKey ? 32 : 16;
    const nextWidth =
      event.key === 'Home'
        ? SIDEBAR_MIN_WIDTH
        : event.key === 'End'
          ? clampSidebarWidth(SIDEBAR_MAX_WIDTH)
          : event.key === 'ArrowLeft'
            ? clampSidebarWidth(sidebarWidth - step)
            : event.key === 'ArrowRight'
              ? clampSidebarWidth(sidebarWidth + step)
              : null;
    if (nextWidth === null) return;
    event.preventDefault();
    saveSidebarWidth(nextWidth);
    setSidebarWidthOverride(null);
  }

  return {
    sidebarWidth,
    sidebarResizing,
    resizerHandlers: {
      onKeyDown: resizeSidebarWithKeyboard,
      onLostPointerCapture: finishSidebarResize,
      onPointerCancel: cancelSidebarResize,
      onPointerDown: beginSidebarResize,
      onPointerMove: resizeSidebar,
      onPointerUp: finishSidebarResize,
    },
  };
}
