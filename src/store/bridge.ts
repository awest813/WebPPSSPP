/**
 * src/store/bridge.ts — Bridge helpers for wiring the RetroOasisStore into
 * the rest of the application.
 *
 * The store is introduced as a *reactive observation layer* alongside the
 * existing `Settings` object in `main.ts`. This module provides the pure,
 * unit-testable glue for keeping the two in sync without forcing an
 * invasive rewrite of every consumer.
 *
 * Responsibilities:
 *  1. Hydrate the `settings` slice from a `Settings`-shaped object at
 *     startup, via a single atomic `batch()` so subscribers see exactly
 *     one notification.
 *  2. Mirror partial `Settings` patches (from `onSettingsChange`) into
 *     the store so subscribers see the same writes that `saveSettings`
 *     flushes to `localStorage`.
 *  3. Convert between the DOM `RTCIceServer` shape (used by `NetplayManager`
 *     and `PeerDataChannel`) and the plain `NetplayIceServer` shape stored
 *     in `SettingsSlice`, so the store remains usable in non-browser
 *     contexts (tests, tooling).
 */
import type { RetroOasisStore, SettingsSlice, NetplayIceServer } from "./RetroOasisStore.js";

/**
 * Settings-shaped input for hydrating the store. Deliberately typed
 * structurally (not imported from `main.ts`) so this module can be
 * reused from tests without pulling in the full application graph.
 */
export type SettingsShape = SettingsSlice;

/** Keys on `SettingsSlice` — used to filter arbitrary `Settings` patches. */
const SETTINGS_KEYS: ReadonlyArray<keyof SettingsSlice> = [
  "volume",
  "lastGameName",
  "performanceMode",
  "showFPS",
  "showAudioVis",
  "useWebGPU",
  "postProcessEffect",
  "autoSaveEnabled",
  "touchControls",
  "touchControlsBySystem",
  "hapticFeedback",
  "touchOpacity",
  "touchButtonScale",
  "orientationLock",
  "netplayEnabled",
  "netplayServerUrl",
  "netplayUsername",
  "netplayIceServers",
  "verboseLogging",
  "cloudLibraries",
  "audioFilterType",
  "audioFilterCutoff",
  "uiMode",
  "libraryLayout",
  "libraryGrouped",
  "recordPlayHistory",
  "coreOptions",
];

/**
 * Populate `store.settings` from a full `Settings`-shaped object in a
 * single atomic batch.  Subscribers are notified exactly once.
 *
 * Unknown properties on `settings` (not in {@link SettingsSlice}) are
 * silently ignored, so legacy stored settings with extra fields do not
 * crash startup.
 */
export function hydrateSettingsIntoStore(
  settings: Partial<SettingsShape>,
  store: RetroOasisStore,
): void {
  const src = settings as Record<string, unknown>;
  const patch: Partial<SettingsSlice> = {};
  for (const key of SETTINGS_KEYS) {
    if (key in src) {
      // Index signature-safe assignment; `SETTINGS_KEYS` is exhaustive over
      // `SettingsSlice`, so this is typed correctly at the call site.
      (patch as Record<string, unknown>)[key] = src[key];
    }
  }
  store.batch(() => {
    store.set("settings", patch);
  });
}

/**
 * Mirror a partial `Settings` patch (as produced by `onSettingsChange` in
 * `main.ts`) into the store.  Only keys that exist on {@link SettingsSlice}
 * are forwarded; unknown keys are dropped.
 *
 * Returns `true` if at least one key was mirrored, `false` otherwise.
 * Consumers can use the return value to skip a no-op notification round,
 * though `store.set` with an empty patch is also safe.
 */
export function mirrorSettingsPatchToStore(
  patch: Partial<SettingsShape>,
  store: RetroOasisStore,
): boolean {
  const src = patch as Record<string, unknown>;
  const forwarded: Partial<SettingsSlice> = {};
  let touched = false;
  for (const key of SETTINGS_KEYS) {
    if (key in src) {
      (forwarded as Record<string, unknown>)[key] = src[key];
      touched = true;
    }
  }
  if (touched) store.set("settings", forwarded);
  return touched;
}

// ── ICE server shape conversion ───────────────────────────────────────────

/**
 * Convert a list of DOM `RTCIceServer` objects to the plain
 * {@link NetplayIceServer} shape stored in `SettingsSlice`.
 *
 * The conversion is shallow: `urls`, `username`, and `credential` are
 * copied verbatim; any additional DOM-only fields are dropped.
 */
export function toNetplayIceServers(servers: ReadonlyArray<RTCIceServer>): NetplayIceServer[] {
  return servers.map((s) => {
    const out: NetplayIceServer = { urls: s.urls };
    if (typeof s.username === "string") out.username = s.username;
    if (typeof s.credential === "string") out.credential = s.credential;
    return out;
  });
}

/**
 * Convert a list of stored {@link NetplayIceServer} entries back to DOM
 * `RTCIceServer` objects suitable for passing to
 * `NetplayManager.setIceServers()` or `RTCPeerConnection`.
 */
export function fromNetplayIceServers(servers: ReadonlyArray<NetplayIceServer>): RTCIceServer[] {
  return servers.map((s) => {
    const out: RTCIceServer = { urls: s.urls };
    if (typeof s.username === "string") out.username = s.username;
    if (typeof s.credential === "string") out.credential = s.credential;
    return out;
  });
}
