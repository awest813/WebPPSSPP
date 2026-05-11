import { getSystemById } from "../systems.js";

/** Minimal settings shape for resolving per-system on-screen control defaults. */
export interface TouchControlsPreferenceSettings {
  touchControls: boolean;
  touchControlsBySystem: Record<string, boolean>;
}

/**
 * Effective on/off for the overlay: per-system override, then built-in touch cores, then global default.
 */
export function getTouchControlsDefaultForSystem(
  systemId: string | null | undefined,
  settings: TouchControlsPreferenceSettings,
): boolean {
  const id = typeof systemId === "string" ? systemId.trim() || null : systemId ?? null;
  if (!id) return settings.touchControls;
  const override = settings.touchControlsBySystem[id];
  if (typeof override === "boolean") return override;
  const system = getSystemById(id);
  if (system?.touchControlMode === "builtin") return false;
  return settings.touchControls;
}

/** Persist preference for the active system without clobbering the global default when scoped to a game. */
export function setTouchControlsPreferenceForSystem(
  settings: TouchControlsPreferenceSettings,
  systemId: string | null | undefined,
  enabled: boolean,
): void {
  const id = typeof systemId === "string" ? systemId.trim() || null : systemId ?? null;
  if (id) {
    settings.touchControlsBySystem = {
      ...settings.touchControlsBySystem,
      [id]: enabled,
    };
  } else {
    settings.touchControls = enabled;
  }
}

/** True when the primary input is a touchscreen (not a mouse). */
export function isTouchDevice(): boolean {
  return (
    "ontouchstart" in window ||
    navigator.maxTouchPoints > 0
  );
}

/** True when the viewport is currently in portrait orientation. */
export function isPortrait(): boolean {
  if (typeof window === "undefined") return false;
  try {
    // matchMedia is widely supported and more reliable than window.innerWidth/Height
    // comparisons when the virtual keyboard is open.
    return window.matchMedia("(orientation: portrait)").matches;
  } catch {
    // Fallback for environments where matchMedia is unavailable (e.g. jsdom in tests).
    return window.innerHeight > window.innerWidth;
  }
}
