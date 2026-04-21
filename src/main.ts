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
import { registerCOIServiceWorker } from "./coiBootstrap.js";
import { PSPEmulator }   from "./emulator.js";
import { scheduleAutoRestoreOnGameStart } from "./autoRestore.js";
import { SaveGameService } from "./saveService.js";
import { getCloudSaveManager } from "./cloudSaveSingleton.js";
import { getNetplayManager, peekNetplayManager } from "./netplaySingleton.js";
import { GameLibrary, getGameTierProfile, saveGameTierProfile, getGameGraphicsProfile } from "./library.js";
import { getSystemById } from "./systems.js";
import { BiosLibrary }   from "./bios.js";
import { SaveStateLibrary, AUTO_SAVE_SLOT } from "./saves.js";
import { detectCapabilitiesCached, formatDetailedSummary, scheduleIdleTask, getResolutionCoreOptions } from "./performance.js";
import { LEGACY_APP_GLOBALS, LEGACY_EVENTS, LEGACY_STORAGE_KEYS } from "./legacy.js";
import { gameCompatibilityDb } from "./compatibility.js";
import { buildDOM, initUI,
          transitionToLibrary, renderLibrary, openSettingsPanel,
          buildLandingControls, showTierDowngradePrompt,
          promptAutoSaveRestore,
          resolveSystemAndAdd,
          showError, showInfoToast, showLoadingOverlay,
          setLoadingMessage, setLoadingSubtitle,
          openEasyNetplayModal,
          TOUCH_CONTROLS_CHANGED_EVENT } from "./ui.js";
import { extractJoinCodeFromUrl } from "./netplay/signalingClient.js";
import { isTouchDevice } from "./touchControls.js";
import { sessionTracker } from "./sessionTracker.js";
// Initialize Chrome-specific performance optimizations early
import { optimizeChromePerformance } from "./performance.js";
optimizeChromePerformance();
import type { PerformanceMode, PerformanceTier } from "./performance.js";
import type { PostProcessEffect } from "./webgpuPostProcess.js";

const APP_NAME = "RetroOasis";
registerCOIServiceWorker();

export interface CloudLibraryConnection {
  id: string;
  provider: "gdrive" | "dropbox" | "onedrive" | "pcloud" | "webdav" | "blomp" | "box";
  name: string;
  enabled: boolean;
  /** JSON-stringified provider-specific settings (tokens, URLs, etc.) */
  config: string;
}

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
  /** Per-system touch control overrides. */
  touchControlsBySystem: Record<string, boolean>;
  /** Whether haptic feedback fires on virtual button presses (Android only). */
  hapticFeedback:  boolean;
  /** System-specific core option overrides (libretro keys). */
  coreOptions:     Record<string, string>;
  /**
   * Opacity of the on-screen touch buttons (0.1–1.0).
   * Lower values make the buttons more transparent so the game is easier to see.
   */
  touchOpacity: number;
  /**
   * Global scale factor for all on-screen buttons (0.5–2.0).
   * Values above 1 make buttons larger; values below 1 make them smaller.
   */
  touchButtonScale: number;
  /** Whether to lock screen orientation to landscape while a game runs. */
  orientationLock: boolean;
  /** Whether the built-in EmulatorJS Netplay feature is enabled. */
  netplayEnabled:  boolean;
  /** WebSocket URL of the EmulatorJS netplay signalling server. */
  netplayServerUrl: string;
  /** Player display name shown to others in a netplay room. Empty means anonymous. */
  netplayUsername: string;
  /** Whether verbose debug logging is written to the browser console. */
  verboseLogging:  boolean;
  /** Configured cloud library sources. */
  cloudLibraries:  CloudLibraryConnection[];
  /**
   * Audio enhancement filter type.
   * `"none"` disables filtering; `"lowpass"` reduces high-frequency crunch
   * common in PSP/N64 audio; `"highpass"` removes low-frequency rumble.
   */
  audioFilterType: "none" | "lowpass" | "highpass";
  /**
   * Audio filter cutoff frequency in Hz (20–20 000).
   * Only used when `audioFilterType` is not `"none"`. Default: 10 000 Hz.
   */
  audioFilterCutoff: number;
  /**
   * UI Visual Fidelity mode.
   * `"auto"`    — default behavior (performance-dependent)
   * `"quality"` — full blurs, animations, and high-res effects
   * `"lite"`    — simplified UI with blurs and heavy animations disabled
   */
  uiMode: "auto" | "quality" | "lite";
  /** Library layout mode: "grid", "list", or "compact". */
  libraryLayout: "grid" | "list" | "compact";
  /** Whether to group games by system in the library. */
  libraryGrouped: boolean;
  /**
   * Whether to record play sessions in the local play-history database.
   * When disabled, no new sessions are written; existing history is unaffected.
   */
  recordPlayHistory: boolean;
}

const STORAGE_KEY = LEGACY_STORAGE_KEYS.settings;

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
  touchControlsBySystem: {},
  hapticFeedback:  true,
  touchOpacity:    0.85,
  touchButtonScale: 1.0,
  orientationLock: true,
  netplayEnabled:  false,
  netplayServerUrl: "",
  netplayUsername: "",
  verboseLogging:  false,
  cloudLibraries:  [],
  audioFilterType: "none" as "none" | "lowpass" | "highpass",
  audioFilterCutoff: 10_000,
  uiMode: "auto",
  libraryLayout: "grid",
  libraryGrouped: true,
  coreOptions: {},
  recordPlayHistory: true,
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
      cloudLibraries: Array.isArray(parsed.cloudLibraries) ? parsed.cloudLibraries : DEFAULT_SETTINGS.cloudLibraries,
      useWebGPU: typeof parsed.useWebGPU === "boolean"
        ? parsed.useWebGPU
        : DEFAULT_SETTINGS.useWebGPU,
      postProcessEffect: (["none", "crt", "sharpen", "lcd", "bloom", "fxaa", "fsr", "grain", "retro", "colorgrade", "taa"] as PostProcessEffect[]).includes(parsed.postProcessEffect as PostProcessEffect)
        ? (parsed.postProcessEffect as PostProcessEffect)
        : DEFAULT_SETTINGS.postProcessEffect,
      autoSaveEnabled: typeof parsed.autoSaveEnabled === "boolean"
        ? parsed.autoSaveEnabled
        : DEFAULT_SETTINGS.autoSaveEnabled,
      touchControls: typeof parsed.touchControls === "boolean"
        ? parsed.touchControls
        : DEFAULT_SETTINGS.touchControls,
      touchControlsBySystem: (typeof parsed.touchControlsBySystem === "object" && parsed.touchControlsBySystem !== null && !Array.isArray(parsed.touchControlsBySystem))
        ? (parsed.touchControlsBySystem as Record<string, boolean>)
        : DEFAULT_SETTINGS.touchControlsBySystem,
      hapticFeedback: typeof parsed.hapticFeedback === "boolean"
        ? parsed.hapticFeedback
        : DEFAULT_SETTINGS.hapticFeedback,
      touchOpacity: typeof parsed.touchOpacity === "number"
        ? Math.max(0.1, Math.min(1, parsed.touchOpacity))
        : DEFAULT_SETTINGS.touchOpacity,
      touchButtonScale: typeof parsed.touchButtonScale === "number"
        ? Math.max(0.5, Math.min(2, parsed.touchButtonScale))
        : DEFAULT_SETTINGS.touchButtonScale,
      orientationLock: typeof parsed.orientationLock === "boolean"
        ? parsed.orientationLock
        : DEFAULT_SETTINGS.orientationLock,
      netplayEnabled: typeof parsed.netplayEnabled === "boolean"
        ? parsed.netplayEnabled
        : DEFAULT_SETTINGS.netplayEnabled,
      netplayServerUrl: typeof parsed.netplayServerUrl === "string"
        ? parsed.netplayServerUrl
        : DEFAULT_SETTINGS.netplayServerUrl,
      netplayUsername: typeof parsed.netplayUsername === "string"
        ? parsed.netplayUsername
        : DEFAULT_SETTINGS.netplayUsername,
      verboseLogging: typeof parsed.verboseLogging === "boolean"
        ? parsed.verboseLogging
        : DEFAULT_SETTINGS.verboseLogging,
      audioFilterType: (["none", "lowpass", "highpass"] as Array<Settings["audioFilterType"]>).includes(parsed.audioFilterType as Settings["audioFilterType"])
        ? (parsed.audioFilterType as Settings["audioFilterType"])
        : DEFAULT_SETTINGS.audioFilterType,
      audioFilterCutoff: typeof parsed.audioFilterCutoff === "number"
        ? Math.max(20, Math.min(20_000, parsed.audioFilterCutoff))
        : DEFAULT_SETTINGS.audioFilterCutoff,
      uiMode: (["auto", "quality", "lite"] as Array<Settings["uiMode"]>).includes(parsed.uiMode as Settings["uiMode"])
        ? (parsed.uiMode as Settings["uiMode"])
        : DEFAULT_SETTINGS.uiMode,
      coreOptions: (typeof parsed.coreOptions === "object" && parsed.coreOptions !== null)
        ? (parsed.coreOptions as Record<string, string>)
        : DEFAULT_SETTINGS.coreOptions,
      libraryLayout: (["grid", "list", "compact"] as Array<Settings["libraryLayout"]>).includes(parsed.libraryLayout as Settings["libraryLayout"])
        ? (parsed.libraryLayout as Settings["libraryLayout"])
        : DEFAULT_SETTINGS.libraryLayout,
      libraryGrouped: typeof parsed.libraryGrouped === "boolean"
        ? parsed.libraryGrouped
        : DEFAULT_SETTINGS.libraryGrouped,
      recordPlayHistory: typeof parsed.recordPlayHistory === "boolean"
        ? parsed.recordPlayHistory
        : DEFAULT_SETTINGS.recordPlayHistory,
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

function getTouchControlsDefaultForSystem(systemId: string | null, settings: Settings): boolean {
  if (!systemId) return settings.touchControls;
  const override = settings.touchControlsBySystem[systemId];
  if (typeof override === "boolean") return override;
  const system = getSystemById(systemId);
  if (system?.touchControlMode === "builtin") return false;
  return settings.touchControls;
}

function setTouchControlsPreferenceForSystem(
  settings: Settings,
  systemId: string | null,
  enabled: boolean,
): void {
  if (systemId) {
    settings.touchControlsBySystem = {
      ...settings.touchControlsBySystem,
      [systemId]: enabled,
    };
  } else {
    settings.touchControls = enabled;
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
  document.dispatchEvent(new CustomEvent(LEGACY_EVENTS.installPromptReady));
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

async function main(): Promise<void> {
  // 1. Build DOM
  const app = document.getElementById("app");
  if (!app) throw new Error("Root element #app not found");
  buildDOM(app);

  // 2. Detect hardware — use session cache to skip the GPU benchmark (~12ms)
  // on page navigations and soft-reloads within the same browser session.
  const deviceCaps = detectCapabilitiesCached();

  // 3. Load settings
  const settings = loadSettings();

  // UI-lite mode trims expensive visual effects on constrained devices or when
  // the user explicitly asks for lower data/motion usage.
  const navConnection = (navigator as Navigator & {
    connection?: { saveData?: boolean };
  }).connection;
  
  const updateUILite = () => {
    let useLiteUI = false;
    if (settings.uiMode === "lite") {
      useLiteUI = true;
    } else if (settings.uiMode === "quality") {
      useLiteUI = false;
    } else {
      // "auto" mode logic
      useLiteUI =
        deviceCaps.isLowSpec ||
        deviceCaps.connectionQuality === "slow" ||
        deviceCaps.prefersReducedMotion ||
        navConnection?.saveData === true;
    }
    document.documentElement.classList.toggle("lite-ui", useLiteUI);
  };
  updateUILite();

  // 4. Instantiate services
  const emulator      = new PSPEmulator("ejs-player");
  const library       = new GameLibrary();
  const biosLibrary   = new BiosLibrary();
  const saveLibrary   = new SaveStateLibrary();
  const cloudSaveManager = getCloudSaveManager();
  const saveService   = new SaveGameService({
    saveLibrary,
    emulator,
    cloudManager: cloudSaveManager,
    getCurrentGameContext: () => (currentGameId && currentSystemId)
      ? { gameId: currentGameId, gameName: settings.lastGameName ?? "Unknown", systemId: currentSystemId }
      : null,
  });
  
  // NetplayManager remains lazily instantiated by the singleton helper.
  // Don't instantiate yet — getNetplayManager() will do it on demand.

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
  if (settings.recordPlayHistory) {
    sessionTracker.warmUp().catch(() => {});
  }

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

  // 4b. Intelligent Warmup Strategy (Phase 5 Optimization)
  // Instead of flooding the idle queue immediately on landing, we gate heavy
  // GPU and WASM pre-warming behind "User Intent" (hovering the drop zone,
  // focusing the search, or interacting with the library). This ensures the
  // landing screen remains perfectly smooth on low-end hardware.
  let warmupsTriggered = false;
  const triggerWarmups = () => {
    if (warmupsTriggered) return;
    warmupsTriggered = true;

    console.info(`[${APP_NAME}] Play intent detected — triggering heavy warmups...`);
    
    // Defer blocking GPU warm-up work to idle time so it does not delay the
    // current interaction frame.
    scheduleIdleTask(() => emulator.preWarmWebGL());
    scheduleIdleTask(() => emulator.warmUpPSPPipeline());
    scheduleIdleTask(() => emulator.preWarmShaderCache().catch(() => {}));
    scheduleIdleTask(() => emulator.prefetchLoader());
    
    // Intelligent core preloading — top launched systems plus two heavy 3D cores
    scheduleIdleTask(() => emulator.prefetchTopSystems(2, 2));
  };

  // Listen for intent signals from the landing page
  const intentEvents = ["mouseover", "touchstart", "focusin"];
  const intentContainers = ["#drop-zone", "#library-grid", "#library-search"];
  
  intentContainers.forEach(sel => {
    const el = document.querySelector(sel);
    if (el) {
      intentEvents.forEach(evt => {
        el.addEventListener(evt, triggerWarmups, { once: true, passive: true });
      });
    }
  });

  // 5. Wire launch handler with warmup trigger
  let launchLock = false;

  const onLaunchGame = async (
    file: File,
    systemId: string,
    gameId?: string,
    tierOverride?: PerformanceTier
  ) => {
    if (launchLock) return;
    launchLock = true;

    // Trigger warmups if they haven't run yet
    triggerWarmups();

    // Cancel any stale pending restore handler
    pendingAutoRestoreCancel?.();
    pendingAutoRestoreCancel = null;

    const gameName = file.name.replace(/\.[^.]+$/, "");
    settings.lastGameName = gameName;
    saveSettings(settings);
    showLoadingOverlay();
    setLoadingMessage(`Starting ${gameName}…`);
    setLoadingSubtitle("Preparing the emulator and loading your game…");

    // Orientation lock
    if (settings.orientationLock && "orientation" in screen) {
      (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })
        .lock?.("landscape-primary")
        .catch(() => {});
    }

    // Touch controls
    if (isTouchDevice() && getTouchControlsDefaultForSystem(systemId, settings)) {
      const ejsContainer = document.getElementById("ejs-container");
      if (ejsContainer) {
        if (!touchOverlay) {
          const { TouchControlsOverlay } = await import("./touchControls.js");
          touchOverlay = new TouchControlsOverlay(
            ejsContainer, systemId, settings.hapticFeedback,
            settings.touchOpacity, settings.touchButtonScale,
          );
        } else {
          touchOverlay.setSystem(systemId);
          touchOverlay.setHapticEnabled(settings.hapticFeedback);
          touchOverlay.setOpacity(settings.touchOpacity);
          touchOverlay.setScale(settings.touchButtonScale);
        }
      }
    } else {
      touchOverlay?.hide();
    }

    currentGameFile     = file;
    currentGameFileName = file.name;
    currentSystemId     = systemId;
    currentGameId       = gameId ?? null;

    const compatibilityEntry =
      gameCompatibilityDb.lookup(gameId ?? "") ??
      gameCompatibilityDb.lookup(gameName);

    if (compatibilityEntry?.knownIssues?.length) {
      showInfoToast(`Compatibility note: ${compatibilityEntry.knownIssues[0]}`);
    }

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
      } catch {}
    }

    if (pendingAutoRestore) {
      const registration = scheduleAutoRestoreOnGameStart({
        emulator,
        stateBytes: pendingAutoRestore,
        slot: AUTO_SAVE_SLOT,
        delayMs: 500,
        onConsumed: () => { pendingAutoRestoreCancel = null; },
      });
      pendingAutoRestoreCancel = () => {
        registration.cancel();
        pendingAutoRestoreCancel = null;
      };
    }

    const savedTier    = gameId ? getGameTierProfile(gameId) : null;
    const resolvedTier = tierOverride ?? savedTier ?? compatibilityEntry?.tierOverride ?? undefined;

    const gfxProfile = gameId ? getGameGraphicsProfile(gameId) : null;
    const coreSettingsOverride: Record<string, string> = { ...settings.coreOptions };
    if (gfxProfile) {
      if (gfxProfile.resolutionPreset) {
        const presetOptions = getResolutionCoreOptions(systemId, gfxProfile.resolutionPreset);
        Object.assign(coreSettingsOverride, presetOptions);
      }
      if (typeof gfxProfile.drsEnabled === "boolean") emulator.enableDRS(gfxProfile.drsEnabled);
    }

    let biosAsset: Blob | undefined;
    try {
      const primaryBios = await biosLibrary.getLaunchBiosAsset(systemId);
      if (primaryBios) biosAsset = primaryBios;
    } catch {}

    const nm = peekNetplayManager();
    if (nm) {
      nm.setEnabled(settings.netplayEnabled);
      nm.setServerUrl(settings.netplayServerUrl);
      nm.setUsername(settings.netplayUsername);
    }

    await emulator.launch({
      file,
      volume:              settings.volume,
      systemId,
      performanceMode:     settings.performanceMode,
      deviceCaps,
      tierOverride:        resolvedTier,
      coreSettingsOverride,
      biosAsset,
      netplayManager: peekNetplayManager() ?? undefined,
      gameId,
      skipExtensionCheck:  !!gameId,
    });

    if (gameId && cloudSaveManager.isConnected()) {
      void cloudSaveManager.syncGame(gameId, saveLibrary).then((r) => {
        if (r.errors > 0) {
          showInfoToast(`☁ Cloud sync had ${r.errors} error(s) — open Save States to retry.`);
        } else if (r.pulled > 0 || r.pushed > 0) {
          const parts: string[] = [];
          if (r.pulled > 0) parts.push(`↓ ${r.pulled} from cloud`);
          if (r.pushed > 0) parts.push(`↑ ${r.pushed} to cloud`);
          showInfoToast(`☁ Saves updated · ${parts.join(" · ")}`);
        }
      }).catch(() => {});
    }

    const materialised = emulator.getLaunchGameFile();
    if (materialised) {
      currentGameFile = materialised;
      currentGameFileName = materialised.name;
    }

    if (gfxProfile?.postEffect && emulator.state !== "error") {
      emulator.updatePostProcessConfig({ effect: gfxProfile.postEffect });
    }

    if (emulator.state === "error") {
      pendingAutoRestoreCancel?.();
      pendingAutoRestoreCancel = null;
      try {
        const orientation = screen.orientation as ScreenOrientation & { unlock?: () => void };
        orientation.unlock?.();
      } catch { /* orientation lock not supported */ }
    }

    launchLock = false;
  };


  // 5a. Wire patch application callback (patcher lazily loaded — not in initial bundle)
  const onApplyPatch = async (gameId: string, patchFile: File): Promise<void> => {
    const entry = await library.getGame(gameId);
    if (!entry) throw new Error("Game not found in library");
    if (!entry.blob) throw new Error("This game is currently in the cloud. Please launch it once to download it before applying patches.");

    const romBuffer   = await entry.blob.arrayBuffer();
    const patchBuffer = await patchFile.arrayBuffer();

    const { applyPatch } = await import("./patcher.js");
    const patched = applyPatch(romBuffer, patchBuffer);

    const patchedBlob = new Blob([patched], { type: entry.blob!.type });
    const patchedFile = new File([patchedBlob], entry.fileName, { type: entry.blob!.type });

    // Update the stored blob in-place so game identity (save states, tier
    // profile, history) is preserved.
    const updatedEntry = await library.updateGameFile(gameId, patchedFile);
    if (!updatedEntry) throw new Error("Game not found in library");

    console.info(
      `[${APP_NAME}] Patch applied: "${patchFile.name}" → "${entry.name}" ` +
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
    // Auto-save persistence is best-effort.
    void saveService.saveSlot(AUTO_SAVE_SLOT, {
      gameId: currentGameId,
      gameName: settings.lastGameName ?? "Unknown",
      systemId: currentSystemId,
    }).catch(() => {});
  };

  // 5c-ii. Wire play-time tracking: begin recording when the game is actually running.
  emulator.onGameStart = () => {
    if (settings.recordPlayHistory && currentGameId && currentSystemId) {
      sessionTracker.startSession(
        currentGameId,
        settings.lastGameName ?? "Unknown",
        currentSystemId,
      );
    }
  };

  // 5d. Wire auto tier downgrade — triggered by onLowFPS
  emulator.onLowFPS = async (averageFPS: number, currentTier: PerformanceTier | null) => {
    if (!currentTier || currentTier === "low") return; // already at minimum

    const tierOrder: PerformanceTier[] = ["low", "medium", "high", "ultra"];
    const idx = tierOrder.indexOf(currentTier);
    if (idx <= 0) return;
    const targetTier = tierOrder[idx - 1]!;

    const confirmed = await showTierDowngradePrompt(
      averageFPS,
      currentTier,
      targetTier
    );
    if (!confirmed) return;

    // Re-launch the current game at the lower tier
    if (!currentGameFile || !currentSystemId) return;

    try {
      showLoadingOverlay();
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
    document.dispatchEvent(new CustomEvent(LEGACY_EVENTS.resumeGame));
  };

  // 6b. Wire "return to library" — pauses and hides the emulator, shows library
  const onReturnToLibrary = (): void => {
    if (emulator.state !== "running" && emulator.state !== "paused") return;
    if (emulator.state === "running") emulator.pause();

    // End any in-progress play session before leaving the game view.
    void sessionTracker.endSession().catch(() => {});

    // Release orientation lock when leaving the game view
    try {
      (screen.orientation as ScreenOrientation & { unlock?: () => void }).unlock?.();
    } catch { /* not supported */ }

    // Hide touch controls overlay
    touchOverlay?.hide();

    transitionToLibrary();
    document.title = APP_NAME;

    void renderLibrary(library, settings, onLaunchGame, emulator, onApplyPatch);
    document.dispatchEvent(new CustomEvent(LEGACY_EVENTS.returnToLibrary));
  };

  // 7. Wire UI
  // Extract onSettingsChange as a named function so it can be reused by both
  // initUI and the post-game landing controls rebuild in retrovault:returnToLibrary.
  // Previously the event listeners used a simplified handler that skipped syncing
  // emulator state (WebGPU, post-process effects, touch controls, verbose logging).
  const onSettingsChange = (patch: Partial<Settings>): void => {
    Object.assign(settings, patch);
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
    // Sync opacity and scale changes immediately
    if (typeof patch.touchOpacity === "number" && touchOverlay) {
      touchOverlay.setOpacity(patch.touchOpacity);
    }
    if (typeof patch.touchButtonScale === "number" && touchOverlay) {
      touchOverlay.setScale(patch.touchButtonScale);
    }
    // Show or hide the touch controls overlay immediately when the setting changes
    // while a game is running so the user sees the effect without relaunching.
    if (typeof patch.touchControls === "boolean") {
      setTouchControlsPreferenceForSystem(settings, currentSystemId, patch.touchControls);
      void (async () => {
        if (!isTouchDevice()) return;

        if (getTouchControlsDefaultForSystem(currentSystemId, settings)) {
          if (!touchOverlay && currentSystemId && (emulator.state === "running" || emulator.state === "paused")) {
            const ejsContainer = document.getElementById("ejs-container");
            if (ejsContainer) {
              const { TouchControlsOverlay } = await import("./touchControls.js");
              touchOverlay = new TouchControlsOverlay(
                ejsContainer, currentSystemId, settings.hapticFeedback,
                settings.touchOpacity, settings.touchButtonScale,
              );
            }
          }
          if (touchOverlay) {
            if (currentSystemId) touchOverlay.setSystem(currentSystemId);
            touchOverlay.setHapticEnabled(settings.hapticFeedback);
            touchOverlay.setOpacity(settings.touchOpacity);
            touchOverlay.setScale(settings.touchButtonScale);
            touchOverlay.show();
          }
        } else {
          touchOverlay?.hide();
        }
        document.dispatchEvent(new CustomEvent(TOUCH_CONTROLS_CHANGED_EVENT));
      })();
    }
    // Sync verbose logging flag so debug output can be toggled without reload.
    if (typeof patch.verboseLogging === "boolean") {
      emulator.verboseLogging = patch.verboseLogging;
    }
    // Apply audio filter changes immediately if the worklet is running.
    if (patch.audioFilterType !== undefined || patch.audioFilterCutoff !== undefined) {
      const filterType = settings.audioFilterType;
      const cutoff     = settings.audioFilterCutoff;
      if (filterType === "none") {
        emulator.removeAudioFilter();
      } else {
        emulator.setAudioFilter(filterType, cutoff);
      }
    }
    // UI Mode change
    if (patch.uiMode !== undefined) {
      updateUILite();
    }
    saveSettings(settings);
  };

  initUI({
    emulator,
    library,
    biosLibrary,
    saveLibrary,
    saveService,
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
    getCurrentCoreOptions: () => settings.coreOptions,
    onUpdateCoreOption: (key, value) => {
      onSettingsChange({ coreOptions: { ...settings.coreOptions, [key]: value } });
    },
    getTouchOverlay:    () => touchOverlay,
    getNetplayManager,
    canInstallPWA,
    onInstallPWA:       promptPWAInstall,
  });

  // Handle core restart requests (e.g. from internal resolution changes)
  document.addEventListener(LEGACY_EVENTS.restartRequired, async () => {
    if (currentGameId && currentSystemId) {
      const entry = await library.getGame(currentGameId);
      if (entry) {
        const file = new File([entry.blob!], entry.fileName, { type: entry.blob!.type });
        void onLaunchGame(file, currentSystemId, currentGameId);
      }
    }
  });

  // End any in-progress play session when the page is closed or navigated away.
  // The IDB write is best-effort — modern browsers give async tasks a short
  // window to complete on unload, so most sessions will be persisted correctly.
  window.addEventListener("beforeunload", () => {
    void sessionTracker.endSession().catch(() => {});
  });

  // 8. If user returns to landing, rebuild landing header controls with a Resume button
  document.addEventListener(LEGACY_EVENTS.returnToLibrary, () => {
    const openPlayTogetherSettings = () => {
      document.dispatchEvent(new CustomEvent(LEGACY_EVENTS.closeEasyNetplay));
      openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, getNetplayManager, "multiplayer");
    };
    buildLandingControls(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, onResumeGame, saveLibrary, getNetplayManager, openPlayTogetherSettings);
  });

  document.addEventListener(LEGACY_EVENTS.openSettings, () => {
    openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, getNetplayManager);
  });

  // 8a. "Play Together" deep-link handling.
  //
  // A share-link generated by EasyNetplayManager.getShareLink() carries the
  // invite code in the `?join=<code>` query parameter.  When a recipient
  // opens such a link we auto-open the Play Together modal on the Join tab
  // with the code pre-filled, landing them one tap away from connecting.
  //
  // The `join` param is stripped from the URL after handling so a reload
  // doesn't keep re-triggering the modal.
  try {
    const joinCode = extractJoinCodeFromUrl(window.location.href);
    if (joinCode) {
      // Remove the parameter without reloading.
      const cleaned = new URL(window.location.href);
      cleaned.searchParams.delete("join");
      window.history.replaceState(null, "", cleaned.toString());

      // Defer opening until after the landing render settles, so the modal
      // overlay appears on top of a fully-initialised library view.  We use
      // a double rAF (one to wait for the current paint, one for the layout
      // to settle) rather than setTimeout(0) so the open is tied to the
      // rendering pipeline instead of event-loop timing heuristics.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        openEasyNetplayModal({
          netplayManager: peekNetplayManager() ?? undefined,
          currentGameName: settings.lastGameName,
          currentGameId: null,
          currentSystemId: null,
          initialJoinCode: joinCode,
          onOpenPlayTogetherSettings: () => {
            document.dispatchEvent(new CustomEvent(LEGACY_EVENTS.closeEasyNetplay));
            openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, getNetplayManager, "multiplayer");
          },
        });
      }));
    }
  } catch {
    // Malformed URLs / non-browser environments are non-fatal.
  }

  // 9. Dev helpers
  if (import.meta.env.DEV) {
    window[LEGACY_APP_GLOBALS.devConsole] = { emulator, library, biosLibrary, saveLibrary, settings, deviceCaps };
    console.info(`[${APP_NAME}] Dev mode. Access \`window.${LEGACY_APP_GLOBALS.devConsole}\` in the console.`);
    console.info("Device capabilities:", deviceCaps);
    console.info(`Hardware tier: ${deviceCaps.tier} (GPU score: ${deviceCaps.gpuBenchmarkScore}/100)`);
    console.info(formatDetailedSummary(deviceCaps));
    console.info("Settings:", settings);
  }

  // 10. Cross-origin isolation warning
  setTimeout(() => {
    if (!self.crossOriginIsolated) {
      console.warn(
        `[${APP_NAME}] Page is NOT cross-origin isolated.\n` +
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
  main().catch(err => {
    console.error(`[${APP_NAME}] Fatal startup error:`, err);
    alert(`${APP_NAME} failed to start. Check console for details.`);
  });
}
