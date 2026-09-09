'use client';

import {
  SIDEBAR_COOKIE_NAME,
  clampSidebarWidth,
} from '@/cooking/shared/ui/sidebar-width';

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
