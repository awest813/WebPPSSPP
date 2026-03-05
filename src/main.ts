/**
 * main.ts — Application entry point
 *
 * Responsibilities:
 *   1. Build the DOM
 *   2. Detect device capabilities (once, at startup)
 *   3. Load settings from localStorage
 *   4. Instantiate PSPEmulator and GameLibrary
 *   5. Wire the UI via initUI()
 *   6. Handle game launch requests (from library cards or file drop)
 *   7. Handle "return to library" (page is NOT reloaded — EJS is hidden)
 *   8. Persist settings changes
 *   9. Preconnect to CDN and prefetch loader for faster game launches
 *
 * Persistence:
 *   - Settings (volume, performanceMode, etc.) → localStorage (small, sync)
 *   - ROM blobs → IndexedDB via GameLibrary (large, async)
 *   - Save states → IndexedDB managed by EmulatorJS internally
 */

import "./style.css";
import { PSPEmulator }   from "./emulator.js";
import { scheduleAutoRestoreOnGameStart } from "./autoRestore.js";
import { GameLibrary, getGameTierProfile, saveGameTierProfile } from "./library.js";
import { BiosLibrary }   from "./bios.js";
import { SaveStateLibrary, saveStateKey, AUTO_SAVE_SLOT, createThumbnail, stateBytesToBlob } from "./saves.js";
import { detectCapabilitiesCached, checkBatteryStatus, formatDetailedSummary, scheduleIdleTask } from "./performance.js";
import { buildDOM, initUI, showLanding,
         hideEjsContainer, renderLibrary, openSettingsPanel,
         buildLandingControls, showTierDowngradePrompt,
         promptAutoSaveRestore,
         resolveSystemAndAdd,
         showError } from "./ui.js";
import { isTouchDevice } from "./touchControls.js";
import { NetplayManager } from "./multiplayer.js";
import type { PerformanceMode, PerformanceTier } from "./performance.js";
import type { PostProcessEffect } from "./webgpuPostProcess.js";

// ── Settings schema ───────────────────────────────────────────────────────────

export interface Settings {
  volume:          number;
  lastGameName:    string | null;
  performanceMode: PerformanceMode;
  /** Whether to show the FPS overlay while a game is running. */
  showFPS:         boolean;
  /** Whether to show the audio visualiser in the FPS overlay panel. */
  showAudioVis:    boolean;
  /** Whether to prefer WebGPU when available (experimental). */
  useWebGPU:       boolean;
  /** Active WebGPU post-processing effect. */
  postProcessEffect: PostProcessEffect;
  /** Whether to auto-save on tab close / visibility hidden. */
  autoSaveEnabled: boolean;
  /** Whether to show touch controls on touch-capable devices. */
  touchControls:   boolean;
  /** Whether haptic feedback fires on virtual button presses (Android only). */
  hapticFeedback:  boolean;
  /** Whether to lock screen orientation to landscape while a game runs. */
  orientationLock: boolean;
  /** Whether the built-in EmulatorJS Netplay feature is enabled. */
  netplayEnabled:  boolean;
  /** WebSocket URL of the EmulatorJS netplay signalling server. */
  netplayServerUrl: string;
  /** Whether verbose debug logging is written to the browser console. */
  verboseLogging:  boolean;
}

const STORAGE_KEY = "retrovault-settings";

const DEFAULT_SETTINGS: Settings = {
  volume:          0.7,
  lastGameName:    null,
  performanceMode: "auto",
  showFPS:         false,
  showAudioVis:    false,
  useWebGPU:       false,
  postProcessEffect: "none" as PostProcessEffect,
  autoSaveEnabled: true,
  touchControls:   isTouchDevice(),
  hapticFeedback:  true,
  orientationLock: true,
  netplayEnabled:  false,
  netplayServerUrl: "",
  verboseLogging:  false,
};

// ── Persistence ───────────────────────────────────────────────────────────────

function loadSettings(): Settings {
  try {
    const raw    = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const validModes: PerformanceMode[] = ["auto", "performance", "quality"];
    return {
      volume: typeof parsed.volume === "number"
        ? Math.max(0, Math.min(1, parsed.volume))
        : DEFAULT_SETTINGS.volume,
      lastGameName: typeof parsed.lastGameName === "string"
        ? parsed.lastGameName
        : null,
      performanceMode: validModes.includes(parsed.performanceMode as PerformanceMode)
        ? (parsed.performanceMode as PerformanceMode)
        : DEFAULT_SETTINGS.performanceMode,
      showFPS: typeof parsed.showFPS === "boolean"
        ? parsed.showFPS
        : DEFAULT_SETTINGS.showFPS,
      showAudioVis: typeof parsed.showAudioVis === "boolean"
        ? parsed.showAudioVis
        : DEFAULT_SETTINGS.showAudioVis,
      useWebGPU: typeof parsed.useWebGPU === "boolean"
        ? parsed.useWebGPU
        : DEFAULT_SETTINGS.useWebGPU,
      postProcessEffect: (["none", "crt", "sharpen", "lcd", "bloom", "fxaa"] as PostProcessEffect[]).includes(parsed.postProcessEffect as PostProcessEffect)
        ? (parsed.postProcessEffect as PostProcessEffect)
        : DEFAULT_SETTINGS.postProcessEffect,
      autoSaveEnabled: typeof parsed.autoSaveEnabled === "boolean"
        ? parsed.autoSaveEnabled
        : DEFAULT_SETTINGS.autoSaveEnabled,
      touchControls: typeof parsed.touchControls === "boolean"
        ? parsed.touchControls
        : DEFAULT_SETTINGS.touchControls,
      hapticFeedback: typeof parsed.hapticFeedback === "boolean"
        ? parsed.hapticFeedback
        : DEFAULT_SETTINGS.hapticFeedback,
      orientationLock: typeof parsed.orientationLock === "boolean"
        ? parsed.orientationLock
        : DEFAULT_SETTINGS.orientationLock,
      netplayEnabled: typeof parsed.netplayEnabled === "boolean"
        ? parsed.netplayEnabled
        : DEFAULT_SETTINGS.netplayEnabled,
      netplayServerUrl: typeof parsed.netplayServerUrl === "string"
        ? parsed.netplayServerUrl
        : DEFAULT_SETTINGS.netplayServerUrl,
      verboseLogging: typeof parsed.verboseLogging === "boolean"
        ? parsed.verboseLogging
        : DEFAULT_SETTINGS.verboseLogging,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    showError("Could not persist settings to localStorage.");
  }
}

// ── PWA install prompt ────────────────────────────────────────────────────────

/**
 * The `beforeinstallprompt` event fires on Chrome/Edge/Android when the PWA
 * install criteria are met. We capture it here and expose a function that the
 * UI can call to show the native install dialog.
 *
 * `promptPWAInstall` is set globally so the Settings panel can access it
 * without requiring the UI module to import from main (circular dep).
 */
declare global {
  interface Window {
    __retrovault?: Record<string, unknown>;
    __pwaInstallPrompt?: () => Promise<void>;
  }
}

let _deferredInstallEvent: { prompt(): Promise<void> } | null = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  _deferredInstallEvent = e as unknown as { prompt(): Promise<void> };
  // Notify any already-rendered settings panel that the install button can appear
  document.dispatchEvent(new CustomEvent("retrovault:installPromptReady"));
});

/** Call from the UI to show the browser's "Add to Home Screen" dialog. */
export async function promptPWAInstall(): Promise<boolean> {
  if (!_deferredInstallEvent) return false;
  await _deferredInstallEvent.prompt();
  _deferredInstallEvent = null;
  return true;
}

/** True when the PWA install prompt is available. */
export function canInstallPWA(): boolean {
  return _deferredInstallEvent !== null;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function main(): void {
  // 1. Build DOM
  const app = document.getElementById("app");
  if (!app) throw new Error("Root element #app not found");
  buildDOM(app);

  // 2. Detect hardware — use session cache to skip the GPU benchmark (~12ms)
  // on page navigations and soft-reloads within the same browser session.
  const deviceCaps = detectCapabilitiesCached();

  // 3. Load settings
  const settings = loadSettings();

  // 4. Instantiate services
  const emulator      = new PSPEmulator("ejs-player");
  const library       = new GameLibrary();
  const biosLibrary   = new BiosLibrary();
  const saveLibrary   = new SaveStateLibrary();
  const netplayManager = new NetplayManager();

  // Propagate verbose logging from settings into the emulator so debug
  // information is written to the console when the user enables it.
  emulator.verboseLogging = settings.verboseLogging;

  // Track the currently loaded game for tier-downgrade re-launch
  let currentGameId:   string | null = null;
  let currentGameFile: File | Blob | null = null;
  let currentGameFileName: string | null = null;
  let currentSystemId: string | null = null;
  let pendingAutoRestoreCancel: (() => void) | null = null;

  // Lazy-create the touch controls overlay only when a game starts on a touch device
  let touchOverlay: import("./touchControls.js").TouchControlsOverlay | null = null;

  // 4a. Preconnect to CDN early for faster game launches
  emulator.preconnect();

  // Pre-warm IndexedDB connections to eliminate cold-open latency
  library.warmUp().catch(() => {});
  biosLibrary.warmUp().catch(() => {});
  saveLibrary.warmUp().catch(() => {});

  // Pre-warm WebGPU if the user has opted in and it is available.
  // Use low-power mode on low-spec devices to conserve energy and prefer
  // the integrated GPU, which is usually more efficient on such hardware.
  if (settings.useWebGPU && deviceCaps.webgpuAvailable) {
    const webgpuPowerPref = deviceCaps.isLowSpec ? "low-power" : "high-performance";
    emulator.preWarmWebGPU(webgpuPowerPref).then(() => {
      // Apply stored post-processing effect after device is ready
      if (settings.postProcessEffect !== "none") {
        emulator.setPostProcessEffect(settings.postProcessEffect);
      }
    }).catch(() => {});
  }

  // Defer blocking GPU warm-up work to idle time so it does not delay the
  // first render frame. preWarmWebGL and warmUpPSPPipeline each create a
  // throwaway WebGL context and compile shaders, which blocks the main
  // thread for up to ~20ms on slower devices.
  scheduleIdleTask(() => emulator.preWarmWebGL());
  scheduleIdleTask(() => emulator.warmUpPSPPipeline());
  scheduleIdleTask(() => emulator.preWarmShaderCache().catch(() => {}));
  scheduleIdleTask(() => emulator.prefetchLoader());

  // 4b. Battery status — asynchronously check if the device is low on battery.
  // If so, auto-switch to "performance" mode when the user hasn't made a manual
  // choice. This is particularly valuable on Chromebooks (always Chrome, always
  // has Battery API) where sustained emulation drains the battery quickly.
  checkBatteryStatus().then(battery => {
    if (!battery) return;
    if (battery.isLowBattery && settings.performanceMode === "auto") {
      settings.performanceMode = "performance";
      saveSettings(settings);
      console.info(
        `[RetroVault] Low battery (${Math.round((battery.level ?? 0) * 100)}%) detected. ` +
        "Auto-switched to Performance mode to conserve power."
      );
    }
  }).catch(() => { /* Battery API unavailable or denied — ignore silently */ });

  // 5. Wire launch callback
  const onLaunchGame = async (
    file: File,
    systemId: string,
    gameId?: string,
    tierOverride?: PerformanceTier
  ): Promise<void> => {
    // Cancel any stale pending restore handler from an earlier launch attempt.
    pendingAutoRestoreCancel?.();
    pendingAutoRestoreCancel = null;

    const gameName = file.name.replace(/\.[^.]+$/, "");
    settings.lastGameName = gameName;
    saveSettings(settings);

    // Orientation lock — auto-lock to landscape on mobile when a game starts.
    // Gracefully ignored on desktop and iOS (which lacks the lock API).
    if (settings.orientationLock && "orientation" in screen) {
      (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })
        .lock?.("landscape-primary")
        .catch(() => { /* not supported on this device/browser */ });
    }

    // Touch controls — lazily initialise and attach to the EJS container.
    if (settings.touchControls && isTouchDevice()) {
      const ejsContainer = document.getElementById("ejs-container");
      if (ejsContainer) {
        if (!touchOverlay) {
          const { TouchControlsOverlay } = await import("./touchControls.js");
          touchOverlay = new TouchControlsOverlay(ejsContainer, systemId, settings.hapticFeedback);
        } else {
          touchOverlay.setSystem(systemId);
          touchOverlay.setHapticEnabled(settings.hapticFeedback);
        }
      }
    }

    // Update current-game tracking for tier-downgrade re-launch
    currentGameFile     = file;
    currentGameFileName = file.name;
    currentSystemId     = systemId;
    currentGameId       = gameId ?? null;

    // Check for auto-save restore opportunity
    let pendingAutoRestore: Uint8Array | null = null;
    if (gameId && settings.autoSaveEnabled) {
      try {
        const shouldRestore = await promptAutoSaveRestore(saveLibrary, gameId);
        if (shouldRestore) {
          const autoState = await saveLibrary.getState(gameId, AUTO_SAVE_SLOT);
          if (autoState?.stateData) {
            pendingAutoRestore = new Uint8Array(await autoState.stateData.arrayBuffer());
          }
        }
      } catch {
        // Auto-save restore is best-effort
      }
    }

    // One-shot auto-restore: inject via a listener that removes itself after firing,
    // avoiding the stale-handler leak of monkey-patching emulator.onGameStart.
    if (pendingAutoRestore) {
      const registration = scheduleAutoRestoreOnGameStart({
        emulator,
        stateBytes: pendingAutoRestore,
        slot: AUTO_SAVE_SLOT,
        delayMs: 500,
        onConsumed: () => {
          pendingAutoRestoreCancel = null;
        },
      });
      pendingAutoRestoreCancel = () => {
        registration.cancel();
        pendingAutoRestoreCancel = null;
      };
    }

    // Apply per-game tier profile if no explicit override was requested
    const savedTier    = gameId ? getGameTierProfile(gameId) : null;
    const resolvedTier = tierOverride ?? savedTier ?? undefined;

    // Resolve BIOS URL for systems that need it (PS1, Saturn, Dreamcast, Lynx)
    let biosUrl: string | undefined;
    try {
      const primaryBios = await biosLibrary.getPrimaryBiosUrl(systemId);
      if (primaryBios) {
        biosUrl = primaryBios;
      }
    } catch {
      // BIOS lookup failure is non-fatal — emulator may run without BIOS
    }

    // Sync netplay settings from app settings into the manager before launch
    netplayManager.setEnabled(settings.netplayEnabled);
    netplayManager.setServerUrl(settings.netplayServerUrl);

    await emulator.launch({
      file,
      volume:              settings.volume,
      systemId,
      performanceMode:     settings.performanceMode,
      deviceCaps,
      tierOverride:        resolvedTier,
      biosUrl,
      netplayManager,
      gameId,
      // When a game already exists in the library the user may have manually
      // reassigned its system type.  Trust their choice and skip the extension
      // check so the emulator doesn't refuse to launch the file.
      skipExtensionCheck:  !!gameId,
    });

    // launch() reports failures via state/onError instead of throwing.
    // Ensure failed launches don't leave stale pending restore handlers or
    // unreferenced blob URLs.
    if (emulator.state === "error") {
      pendingAutoRestoreCancel?.();
      pendingAutoRestoreCancel = null;
      // Defensive revoke: for preflight failures the emulator never stores
      // the biosUrl, so we must revoke it here.  For mid-launch failures
      // the emulator revokes it itself (in its catch block), making this
      // call a safe no-op.
      if (biosUrl) URL.revokeObjectURL(biosUrl);
    }
  };

  // 5a. Wire patch application callback (patcher lazily loaded — not in initial bundle)
  const onApplyPatch = async (gameId: string, patchFile: File): Promise<void> => {
    const entry = await library.getGame(gameId);
    if (!entry) throw new Error("Game not found in library");

    const romBuffer   = await entry.blob.arrayBuffer();
    const patchBuffer = await patchFile.arrayBuffer();

    const { applyPatch } = await import("./patcher.js");
    const patched = applyPatch(romBuffer, patchBuffer);

    const patchedBlob = new Blob([patched], { type: entry.blob.type });
    const patchedFile = new File([patchedBlob], entry.fileName, { type: entry.blob.type });

    // Update the stored blob in-place so game identity (save states, tier
    // profile, history) is preserved.
    const updatedEntry = await library.updateGameFile(gameId, patchedFile);
    if (!updatedEntry) throw new Error("Game not found in library");

    console.info(
      `[RetroVault] Patch applied: "${patchFile.name}" → "${entry.name}" ` +
      `(${entry.size} → ${updatedEntry.size} bytes)`
    );
  };

  // 5b. Wire the unified file-chosen handler (handles archives, patches, ROMs, m3u)
  const onFileChosen = async (file: File): Promise<void> => {
    await resolveSystemAndAdd(file, library, settings, onLaunchGame, emulator, onApplyPatch);
  };

  // 5c. Wire auto-save persistence
  emulator.onAutoSave = () => {
    if (!settings.autoSaveEnabled || !currentGameId || !currentSystemId) return;
    // Capture IDs synchronously at the time the save is triggered — by the
    // time the async work completes a new game may have been launched.
    const gameIdAtSave   = currentGameId;
    const systemIdAtSave = currentSystemId;
    const gameName = settings.lastGameName ?? "Unknown";
    void (async () => {
      try {
        const screenshot = await emulator.captureScreenshotAsync();
        const thumbnail  = screenshot ? await createThumbnail(screenshot) : null;
        const stateBytes = emulator.readStateData(AUTO_SAVE_SLOT);
        const stateData  = stateBytesToBlob(stateBytes);

        await saveLibrary.saveState({
          id:         saveStateKey(gameIdAtSave, AUTO_SAVE_SLOT),
          gameId:     gameIdAtSave,
          gameName,
          systemId:   systemIdAtSave,
          slot:       AUTO_SAVE_SLOT,
          label:      "Auto-Save",
          timestamp:  Date.now(),
          thumbnail,
          stateData,
          isAutoSave: true,
        });
      } catch {
        // Auto-save persistence is best-effort
      }
    })();
  };

  // 5d. Wire auto tier downgrade — triggered by onLowFPS
  emulator.onLowFPS = async (averageFPS: number, currentTier: PerformanceTier | null) => {
    if (!currentTier || currentTier === "low") return; // already at minimum

    const tierOrder: PerformanceTier[] = ["low", "medium", "high", "ultra"];
    const idx = tierOrder.indexOf(currentTier);
    if (idx <= 0) return;
    const targetTier = tierOrder[idx - 1];

    const confirmed = await showTierDowngradePrompt(
      averageFPS,
      currentTier,
      targetTier
    );
    if (!confirmed) return;

    // Re-launch the current game at the lower tier
    if (!currentGameFile || !currentSystemId) return;

    try {
      const file = currentGameFile instanceof File
        ? currentGameFile
        : new File([currentGameFile], currentGameFileName ?? "game.bin");

      // Persist the downgraded tier so subsequent launches use it automatically
      if (currentGameId) {
        saveGameTierProfile(currentGameId, targetTier);
      }

      await onLaunchGame(file, currentSystemId, currentGameId ?? undefined, targetTier);
    } catch {
      // Re-launch failed — user can try manually
    }
  };

  // 6a. Resume a paused game — shows the emulator, hides library
  const onResumeGame = (): void => {
    if (emulator.state !== "paused") return;
    emulator.resume();
    document.dispatchEvent(new CustomEvent("retrovault:resumeGame"));
  };

  // 6b. Wire "return to library" — pauses and hides the emulator, shows library
  const onReturnToLibrary = (): void => {
    if (emulator.state !== "running" && emulator.state !== "paused") return;
    if (emulator.state === "running") emulator.pause();

    // Release orientation lock when leaving the game view
    try {
      (screen.orientation as ScreenOrientation & { unlock?: () => void }).unlock?.();
    } catch { /* not supported */ }

    // Hide touch controls overlay
    touchOverlay?.hide();

    hideEjsContainer();
    showLanding();
    document.title = "RetroVault";

    void renderLibrary(library, settings, onLaunchGame, emulator, onApplyPatch);
    document.dispatchEvent(new CustomEvent("retrovault:returnToLibrary"));
  };

  // 7. Wire UI
  // Extract onSettingsChange as a named function so it can be reused by both
  // initUI and the post-game landing controls rebuild in retrovault:returnToLibrary.
  // Previously the event listeners used a simplified handler that skipped syncing
  // emulator state (WebGPU, post-process effects, touch controls, verbose logging).
  const onSettingsChange = (patch: Partial<Settings>): void => {
    Object.assign(settings, patch);
    saveSettings(settings);
    if (patch.useWebGPU && deviceCaps.webgpuAvailable && !emulator.webgpuAvailable) {
      const webgpuPowerPref = deviceCaps.isLowSpec ? "low-power" : "high-performance";
      emulator.preWarmWebGPU(webgpuPowerPref).then(() => {
        if (settings.postProcessEffect !== "none") {
          emulator.setPostProcessEffect(settings.postProcessEffect);
        }
      }).catch(() => {});
    }
    if (patch.postProcessEffect !== undefined) {
      emulator.setPostProcessEffect(patch.postProcessEffect);
    }
    // Sync haptic feedback setting to the active overlay in real time
    if (typeof patch.hapticFeedback === "boolean" && touchOverlay) {
      touchOverlay.setHapticEnabled(patch.hapticFeedback);
    }
    // Show or hide the touch controls overlay immediately when the setting changes
    // while a game is running so the user sees the effect without relaunching.
    if (typeof patch.touchControls === "boolean") {
      void (async () => {
        if (!isTouchDevice()) return;

        if (patch.touchControls) {
          if (!touchOverlay && currentSystemId && (emulator.state === "running" || emulator.state === "paused")) {
            const ejsContainer = document.getElementById("ejs-container");
            if (ejsContainer) {
              const { TouchControlsOverlay } = await import("./touchControls.js");
              touchOverlay = new TouchControlsOverlay(ejsContainer, currentSystemId, settings.hapticFeedback);
            }
          }
          if (touchOverlay) {
            if (currentSystemId) touchOverlay.setSystem(currentSystemId);
            touchOverlay.setHapticEnabled(settings.hapticFeedback);
            touchOverlay.show();
          }
        } else {
          touchOverlay?.hide();
        }
      })();
    }
    // Sync verbose logging flag so debug output can be toggled without reload.
    if (typeof patch.verboseLogging === "boolean") {
      emulator.verboseLogging = patch.verboseLogging;
    }
  };

  initUI({
    emulator,
    library,
    biosLibrary,
    saveLibrary,
    netplayManager,
    settings,
    deviceCaps,
    onLaunchGame,
    onApplyPatch,
    onFileChosen,
    onSettingsChange,
    onReturnToLibrary,
    getCurrentGameId:   () => currentGameId,
    getCurrentGameName: () => settings.lastGameName,
    getCurrentSystemId: () => currentSystemId,
    getTouchOverlay:    () => touchOverlay,
    canInstallPWA,
    onInstallPWA:       promptPWAInstall,
  });

  // 8. If user returns to landing, rebuild landing header controls with a Resume button
  document.addEventListener("retrovault:returnToLibrary", () => {
    buildLandingControls(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, onResumeGame, saveLibrary, netplayManager);
  });

  document.addEventListener("retrovault:openSettings", () => {
    openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, netplayManager);
  });

  // 9. Dev helpers
  if (import.meta.env.DEV) {
    window.__retrovault = { emulator, library, biosLibrary, saveLibrary, settings, deviceCaps };
    console.info("[RetroVault] Dev mode. Access `window.__retrovault` in the console.");
    console.info("Device capabilities:", deviceCaps);
    console.info(`Hardware tier: ${deviceCaps.tier} (GPU score: ${deviceCaps.gpuBenchmarkScore}/100)`);
    console.info(formatDetailedSummary(deviceCaps));
    console.info("Settings:", settings);
  }

  // 10. Cross-origin isolation warning
  setTimeout(() => {
    if (!self.crossOriginIsolated) {
      console.warn(
        "[RetroVault] Page is NOT cross-origin isolated.\n" +
        "SharedArrayBuffer is unavailable — PSP (PPSSPP) games will fail.\n" +
        "Other systems (NES, SNES, GBA, etc.) are not affected.\n" +
        "Ensure coi-serviceworker.js is registered and the page has been reloaded."
      );
    }
  }, 2000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
