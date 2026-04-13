export const MIN_SIDEBAR_WIDTH = 20;
export const MAX_SIDEBAR_WIDTH = 80;

export function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}
