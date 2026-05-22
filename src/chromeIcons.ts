/**
 * Shared inline SVG glyphs for UI chrome (stroke icons follow currentColor).
 * Centralizes vectors so we avoid emoji in controls, toasts, and status surfaces.
 */

export const ICON_CLOSE_X_SVG = `<svg class="icon-close-x" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;

export const ICON_ALERT_TRIANGLE_SVG = `<svg class="ui-inline-icon ui-inline-icon--alert" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 17h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

export const ICON_TOAST_SUCCESS_SVG = `<svg class="info-toast__glyph" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const ICON_TOAST_INFO_SVG = `<svg class="info-toast__glyph" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M12 16v-4M12 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

export const ICON_TOAST_WARN_SVG = `<svg class="info-toast__glyph" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

export const ICON_TOAST_ERROR_SVG = `<svg class="info-toast__glyph info-toast__glyph--error" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;

/** Controller silhouette — library cards, multiplayer banners, system fallback when no asset URL. */
export const ICON_GAMEPAD_DECOR_SVG = `<svg class="ui-decor-gamepad" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="2" y="7" width="20" height="10" rx="4" stroke="currentColor" stroke-width="2"/><path d="M7 13h.01M9 11v4M7 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="17" cy="13" r="1.25" fill="currentColor"/><circle cx="15" cy="11" r="1.25" fill="currentColor"/></svg>`;

export const ICON_GRID_ALL_SVG = `<svg class="sys-filter-chip__glyph" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="3" width="7" height="7" stroke="currentColor" stroke-width="2"/><rect x="14" y="3" width="7" height="7" stroke="currentColor" stroke-width="2"/><rect x="14" y="14" width="7" height="7" stroke="currentColor" stroke-width="2"/><rect x="3" y="14" width="7" height="7" stroke="currentColor" stroke-width="2"/></svg>`;

export const ONBOARD_ICON_FAST_SVG = `<svg class="onboarding__glyph" viewBox="0 0 24 24" fill="none" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;

export const ONBOARD_ICON_INPUTS_SVG = `<svg class="onboarding__glyph" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="2" y="7" width="20" height="10" rx="4" stroke="currentColor" stroke-width="2"/><path d="M7 13h.01M9 11v4M7 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="17" cy="13" r="1.25" fill="currentColor"/><circle cx="15" cy="11" r="1.25" fill="currentColor"/></svg>`;

export const ONBOARD_ICON_LOCK_SVG = `<svg class="onboarding__glyph" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" stroke-width="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

export const ICON_ROTATE_PHONE_SVG = `<svg class="rotate-hint__glyph" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="2" width="14" height="20" rx="3" stroke="currentColor" stroke-width="2"/><path d="M9 18h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

export const ICON_BATTERY_SVG = `<svg class="footer-battery__glyph" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="2" y="7" width="18" height="10" rx="2" stroke="currentColor" stroke-width="2"/><path d="M22 11v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M6 11h7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

export const ICON_TROPHY_SVG = `<svg class="game-card__ach-glyph" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v3a5 5 0 0 1-10 0V4zM7 4H5a2 2 0 0 0-2 2v1c0 1.5 1.5 3 3.5 3M17 4h2a2 2 0 0 1 2 2v1c0 1.5-1.5 3-3.5 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** Inline SVG strings produced by this module (leading whitespace allowed). */
export function isSvgMarkup(s: string): boolean {
  return /^\s*<svg\b/i.test(s);
}

export const INFO_TOAST_ICON_HTML: Record<"success" | "info" | "warning" | "error", string> = {
  success: ICON_TOAST_SUCCESS_SVG,
  info: ICON_TOAST_INFO_SVG,
  warning: ICON_TOAST_WARN_SVG,
  error: ICON_TOAST_ERROR_SVG,
};
