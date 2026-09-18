export const DEFAULT_UI_FONT_SIZE = 14;
export const MIN_UI_FONT_SIZE = 12;
export const MAX_UI_FONT_SIZE = 20;

/** Keep persisted or programmatic values inside the range exposed by Settings. */
export function normaliseUiFontSize(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_UI_FONT_SIZE;
  return Math.max(MIN_UI_FONT_SIZE, Math.min(MAX_UI_FONT_SIZE, Math.round(numeric)));
}

/**
 * Publish the UI font size without scaling the workspace. Editor and terminal
 * typography are excluded in CSS and continue to use their dedicated stores.
 */
export function applyUiFontSize(
  value: unknown,
  root: Pick<HTMLElement, 'style'> = document.documentElement,
): number {
  const size = normaliseUiFontSize(value);
  root.style.setProperty('--ui-font-size', `${size}px`);
  return size;
}
