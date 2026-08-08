export const SIDEBAR_COOKIE_NAME = 'agent_party_time_collab_sidebar_width';
export const SIDEBAR_DEFAULT_WIDTH = 320;
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 560;
export const STAGE_MIN_WIDTH = 480;

export function clampSidebarWidth(width: number): number {
  if (typeof window === 'undefined')
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
  const viewportMaximum = Math.max(
    SIDEBAR_MIN_WIDTH,
    window.innerWidth - STAGE_MIN_WIDTH,
  );
  return Math.round(
    Math.min(
      SIDEBAR_MAX_WIDTH,
      viewportMaximum,
      Math.max(SIDEBAR_MIN_WIDTH, width),
    ),
  );
}

export function readSidebarWidth(value: string | null | undefined): number {
  const stored = Number(value);
  return clampSidebarWidth(
    Number.isFinite(stored) && stored > 0 ? stored : SIDEBAR_DEFAULT_WIDTH,
  );
}
