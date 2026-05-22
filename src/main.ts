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
import { diagInfo } from "./diagnosticLog.js";
import { registerCOIServiceWorker } from "./coiBootstrap.js";
import { PSPEmulator }   from "./emulator.js";
import { scheduleAutoRestoreOnGameStart } from "./autoRestore.js";
import { SaveGameService } from "./saveService.js";
import { getCloudSaveManager } from "./cloudSaveSingleton.js";
import { getNetplayManager, peekNetplayManager } from "./netplaySingleton.js";
import { GameLibrary, getGameTierProfile, saveGameTierProfile, getGameGraphicsProfile } from "./library.js";
import { BiosLibrary, BIOS_REQUIREMENTS }   from "./bios.js";
import { SaveStateLibrary, AUTO_SAVE_SLOT } from "./saves.js";
import {
  detectCapabilitiesCached,
  formatDetailedSummary,
  scheduleIdleTask,
  getResolutionCoreOptions,
  getResolutionLadder,
  inferDynamicResolutionScalingDefault,
  isChromebookLowRamProfile,
  resolveTier,
} from "./performance.js";
import { LEGACY_APP_GLOBALS, LEGACY_EVENTS, LEGACY_STORAGE_KEYS } from "./legacy.js";
import { gameCompatibilityDb } from "./compatibility.js";
import { buildDOM, initUI,
          transitionToLibrary, renderLibrary, openSettingsPanel,
          buildLandingControls, showTierDowngradePrompt,
          promptAutoSaveRestore,
          resolveSystemAndAdd,
          showError, showInfoToast, showLoadingOverlay, hideLoadingOverlay,
          setLoadingMessage, setLoadingSubtitle,
          openEasyNetplayModal } from "./ui.js";
import { extractJoinCodeFromUrl } from "./netplay/signalingClient.js";
import { sessionTracker } from "./sessionTracker.js";
import { store } from "./store/index.js";
import type { NetplayIceServer } from "./store/index.js";
import {
  hydrateSettingsIntoStore,
  mirrorSettingsPatchToStore,
  fromNetplayIceServers,
} from "./store/bridge.js";
// Initialize Chrome-specific performance optimizations early
import { optimizeBrowserPerformance } from "./performance.js";
optimizeBrowserPerformance();
import { requestPersistentStorage, installStoragePressureListener, startStorageMonitoring, checkStorageQuota, getStorageWarning } from "./storage.js";

/**
 * Notify the service worker about gaming state so it can defer SW updates
 * while a game is running (preserving COI headers and SharedArrayBuffer).
 */
function notifyServiceWorkerGamingState(gaming: boolean): void {
  try {
    navigator.serviceWorker?.controller?.postMessage({
      type: "retro-oasis-gaming-status",
      gaming,
    });
  } catch {
    // Non-critical — service worker may not be active.
  }
}
import type { Settings } from "./types/settings.js";
export type { Settings } from "./types/settings.js";
import type { PerformanceMode, PerformanceTier } from "./performance.js";
import {
  parsePostProcessEffect,
  pickShellPerGamePostEffect,
  resolveWebGpuPostProcessEffectForShell,
  shouldWebGpuPostCaptureEmulatorGlCanvas,
  type PostProcessEffect,
  type WebGpuGlCapturePolicyInput,
} from "./webgpuPostProcess.js";
import { getApiKeyStore } from "./ui/coverArtRegistry.js";
import { parseRAKey } from "./raCredentials.js";
import { installWebGlContextPolicy } from "./webglContextPolicy.js";
import { getSystemById } from "./systems.js";

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
// Settings interface is defined in src/types/settings.ts and re-exported above.

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
  coreOptions: {},
  orientationLock: true,
  netplayEnabled:  false,
  netplayServerUrl: "",
  netplayUsername: "",
  netplayIceServers: [],
  verboseLogging:  false,
  cloudLibraries:  [],
  audioFilterType: "none" as "none" | "lowpass" | "highpass",
  audioFilterCutoff: 10_000,
  uiMode: "auto",
  libraryLayout: "grid",
  libraryGrouped: true,
  recordPlayHistory: true,
  dynamicResolutionScaling: false,
  uiScale: 1.0,
};

// ── Persistence ───────────────────────────────────────────────────────────────

function loadSettings(deviceCaps?: import("./performance.js").DeviceCapabilities): Settings {
  try {
    const raw    = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const s = { ...DEFAULT_SETTINGS };
      if (deviceCaps) {
        s.dynamicResolutionScaling = inferDynamicResolutionScalingDefault(deviceCaps);
        if (isChromebookLowRamProfile(deviceCaps)) {
          s.performanceMode = "performance";
        }
      }
      return s;
    }
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
      postProcessEffect: parsePostProcessEffect(parsed.postProcessEffect)
        ?? DEFAULT_SETTINGS.postProcessEffect,
      autoSaveEnabled: typeof parsed.autoSaveEnabled === "boolean"
        ? parsed.autoSaveEnabled
        : DEFAULT_SETTINGS.autoSaveEnabled,
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
      netplayIceServers: Array.isArray(parsed.netplayIceServers)
        ? (parsed.netplayIceServers as NetplayIceServer[]).filter(
            (s): s is NetplayIceServer =>
              !!s && typeof s === "object" &&
              (typeof s.urls === "string" || Array.isArray(s.urls)),
          )
        : DEFAULT_SETTINGS.netplayIceServers,
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
      dynamicResolutionScaling: typeof parsed.dynamicResolutionScaling === "boolean"
        ? parsed.dynamicResolutionScaling
        : (deviceCaps
          ? inferDynamicResolutionScalingDefault(deviceCaps)
          : DEFAULT_SETTINGS.dynamicResolutionScaling),
      uiScale: typeof parsed.uiScale === "number" && parsed.uiScale >= 0.5 && parsed.uiScale <= 2.0
        ? Math.round(parsed.uiScale * 100) / 100
        : DEFAULT_SETTINGS.uiScale,
    };
  } catch {
    const s = { ...DEFAULT_SETTINGS };
    if (deviceCaps) s.dynamicResolutionScaling = inferDynamicResolutionScalingDefault(deviceCaps);
    return s;
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    showError("Could not persist settings to localStorage.");
  }
}

/**
 * Align {@link NetplayManager} with persisted {@link Settings} so EmulatorJS
 * receives correct globals on launch even when the manager had not been loaded yet
 * (the singleton is lazy — previously we only synced when `peekNetplayManager()`
 * was already non-null, which skipped first-time launches).
 */
async function syncNetplayManagerFromSettings(s: Settings): Promise<void> {
  const nm = await getNetplayManager();
  nm.setEnabled(s.netplayEnabled);
  nm.setServerUrl(s.netplayServerUrl);
  nm.setUsername(s.netplayUsername);
  const ice = fromNetplayIceServers(s.netplayIceServers);
  if (ice.length > 0) nm.setIceServers(ice);
  else nm.resetIceServers();
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
    "__retro-oasis"?: Record<string, unknown>;
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

function wirePwaFileLaunchQueue(onFileChosen: (file: File) => Promise<void>): void {
  try {
    const w = window as unknown as {
      launchQueue?: {
        setConsumer: (
          cb: (params: { files?: readonly FileSystemFileHandle[] }) => void | Promise<void>,
        ) => void;
      };
    };
    if (!w.launchQueue?.setConsumer) return;
    w.launchQueue.setConsumer(async (params) => {
      const files = params.files;
      if (!files?.length) return;
      for (const handle of files) {
        try {
          const file = await handle.getFile();
          await onFileChosen(file);
        } catch {
          /* ignore invalid handles */
        }
      }
    });
  } catch {
    /* Launch Queue unsupported */
  }
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

  // 3. Request persistent storage early — prevents ChromeOS from evicting
  //    IndexedDB data (ROMs, saves, BIOS) under quota pressure.
  const persistGranted = await requestPersistentStorage();
  installStoragePressureListener();
  if (!persistGranted && deviceCaps.isChromOS) {
    console.warn("[RetroOasis] Persistent storage denied — data may be evicted under quota pressure. Enable a cloud backup provider in Settings → Cloud.");
  }

  // 4. Monitor storage and warn when quota is dangerously low.
  startStorageMonitoring(async () => {
    const quota = await checkStorageQuota();
    const warning = getStorageWarning(quota);
    if (warning) showInfoToast(warning.message, "warning");
  });

  // 5. Load settings
  const settings = loadSettings(deviceCaps);

  // Hydrate the RetroOasisStore from the loaded settings in a single atomic
  // batch so any pre-wired subscribers see exactly one notification.  The
  // `Settings` object remains the authoritative source for the imperative
  // code paths below; the store is a reactive observation layer kept in
  // sync via `mirrorSettingsPatchToStore` inside `onSettingsChange`.
  hydrateSettingsIntoStore(settings, store);

  // Prime NetplayManager from Settings once at boot so `peekNetplayManager()` and
  // Play Together UI match persisted relay / ICE / username before any game launch.
  await syncNetplayManagerFromSettings(settings);

  // UI-lite mode trims expensive visual effects on constrained devices or when
  // the user explicitly asks for lower data/motion usage.
  const navConnection = (navigator as Navigator & {
    connection?: { saveData?: boolean };
  }).connection;
  
  const updateUILite = () => {
    let useLiteUI = false;
    const chromebookLowRam = isChromebookLowRamProfile(deviceCaps);
    if (settings.uiMode === "lite") {
      useLiteUI = true;
    } else if (settings.uiMode === "quality") {
      useLiteUI = false;
    } else {
      // "auto" mode logic
      useLiteUI =
        deviceCaps.isLowSpec ||
        chromebookLowRam ||
        deviceCaps.connectionQuality === "slow" ||
        deviceCaps.prefersReducedMotion ||
        navConnection?.saveData === true;
    }
    document.documentElement.classList.toggle("lite-ui", useLiteUI);
  };
  updateUILite();

  /** Installed PWA / Chrome OS window-controls-overlay — hook for CSS if needed */
  try {
    const pwaChrome =
      window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: window-controls-overlay)").matches;
    document.documentElement.classList.toggle("pwa-standalone", pwaChrome);
  } catch {
    /* ignore */
  }

  // 4. Instantiate services
  const emulator      = new PSPEmulator("ejs-player");
  emulator.onPostProcessorFallback = () => {
    showInfoToast("WebGPU post-processing was disabled due to instability.", "warning");
  };
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
  
  // NetplayManager is instantiated during `syncNetplayManagerFromSettings` at boot
  // and on demand elsewhere via `getNetplayManager()`.

  // Bridge `store.settings.netplayIceServers` → `NetplayManager.setIceServers()`
  // so any consumer that writes ICE servers through the store (e.g. the
  // Multiplayer-tab UI) has its change reflected in the live manager used
  // by peer connections.  The manager is lazy-loaded: if it isn't resident
  // yet we defer the sync until the async factory resolves.
  // A JSON-serialised snapshot avoids redundant `setIceServers` calls on
  // unrelated settings-slice mutations (the subscription fires for every
  // `store.set("settings", …)`, not just ICE changes).
  let lastIceServersSnapshot: string = JSON.stringify(
    store.get("settings").netplayIceServers,
  );
  store.subscribe("settings", (s) => {
    const serialized = JSON.stringify(s.netplayIceServers);
    if (serialized === lastIceServersSnapshot) return;
    lastIceServersSnapshot = serialized;
    const ice = fromNetplayIceServers(s.netplayIceServers);
    const nm = peekNetplayManager();
    if (nm) {
      nm.setIceServers(ice);
    } else {
      void getNetplayManager().then((m) => m.setIceServers(ice)).catch(() => {});
    }
  });

  // Propagate verbose logging from settings into the emulator so debug
  // information is written to the console when the user enables it.
  emulator.verboseLogging = settings.verboseLogging;

  // Track the currently loaded game for tier-downgrade re-launch
  let currentGameId:   string | null = null;
  let currentGameFile: File | Blob | null = null;
  let currentGameFileName: string | null = null;
  let currentSystemId: string | null = null;
  /** Per-game graphics profile `postEffect` for the active session; cleared when returning to the library. */
  let sessionGamePostEffectOverride: PostProcessEffect | null | undefined;
  let pendingAutoRestoreCancel: (() => void) | null = null;

  /** Inputs shared by WebGL `preserveDrawingBuffer` policy and {@link resolveWebGpuPostProcessEffectForShell}. */
  const webGpuGlCaptureInput = (
    tier: PerformanceTier,
    perGamePostEffect: PostProcessEffect | null | undefined,
  ): WebGpuGlCapturePolicyInput => ({
    useWebGPU: settings.useWebGPU,
    webgpuAvailable: emulator.webgpuAvailable,
    settingsPostEffect: settings.postProcessEffect,
    perGamePostEffect,
    systemId: currentSystemId,
    tier,
    caps: deviceCaps,
  });

  // Global WebGL context attributes: `powerPreference` from Graphics Mode + optional
  // `preserveDrawingBuffer` when WebGPU post will sample the emulator GL canvas.
  installWebGlContextPolicy(() => {
    const tier =
      emulator.activeTier ?? resolveTier(settings.performanceMode, deviceCaps);
    const forcePreserveDrawingBuffer = shouldWebGpuPostCaptureEmulatorGlCanvas(
      webGpuGlCaptureInput(tier, sessionGamePostEffectOverride),
    );
    return {
      performanceMode: settings.performanceMode,
      deviceCaps,
      forcePreserveDrawingBuffer,
    };
  });


  /**
   * Applies WebGPU post-processing via {@link resolveWebGpuPostProcessEffectForShell}.
   * `perGameEffectOverride`: pass when you have an explicit snapshot (e.g. first sync after launch);
   * otherwise `sessionGamePostEffectOverride` is used. `tierHint` helps defer policy right after
   * Graphics Mode changes, before `emulator.activeTier` reflects the new tier.
   */
  const syncEmulatorPostProcessFromSettings = (
    perGameEffectOverride?: PostProcessEffect | null,
    opts?: { tierHint?: PerformanceTier },
  ): void => {
    const tier =
      opts?.tierHint ??
      emulator.activeTier ??
      resolveTier(settings.performanceMode, deviceCaps);

    const perGameMerged = pickShellPerGamePostEffect(
      perGameEffectOverride,
      sessionGamePostEffectOverride,
    );

    emulator.setPostProcessEffect(
      resolveWebGpuPostProcessEffectForShell(
        webGpuGlCaptureInput(tier, perGameMerged),
      ),
    );
  };

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
    const webgpuPowerPref = (deviceCaps.isLowSpec || deviceCaps.isChromOS) ? "low-power" : "high-performance";
    emulator.preWarmWebGPU(webgpuPowerPref).then(() => {
      syncEmulatorPostProcessFromSettings();
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

    diagInfo(settings.verboseLogging, `[${APP_NAME}] Play intent detected — triggering heavy warmups...`);
    
    // Defer blocking GPU warm-up work to idle time so it does not delay the
    // current interaction frame.
    scheduleIdleTask(() => emulator.preWarmWebGL());
    scheduleIdleTask(() => emulator.warmUpPSPPipeline());
    scheduleIdleTask(() => emulator.warmUpDreamcastPipeline());
    scheduleIdleTask(() => emulator.warmUp2DPipeline());
    scheduleIdleTask(() => emulator.preWarmShaderCache().catch(() => {}));
    scheduleIdleTask(() => emulator.prefetchLoader());
    
    // Intelligent core preloading — launch history, heavy 3D blobs, then common 2D cores
    scheduleIdleTask(() => emulator.prefetchTopSystems(2, 2, 2));
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

    const launchSystem = getSystemById(systemId);
    try {
      const biosReady = await biosLibrary.isBiosReady(systemId);
      if (!biosReady) {
        const requiredNames = (BIOS_REQUIREMENTS[systemId] ?? [])
          .filter(req => req.required)
          .map(req => req.fileName);
        const startupFileHint = requiredNames.length > 0
          ? `Upload one of these startup files in Settings -> System Files: ${requiredNames.join(", ")}.`
          : "Upload the required startup file in Settings -> System Files.";
        hideLoadingOverlay();
        showError(
          `${launchSystem?.name ?? systemId} needs a BIOS/startup file before this game can load.\n\n` +
          startupFileHint
        );
        launchLock = false;
        return;
      }
    } catch {
      // If the readiness check itself fails, continue with the best-effort BIOS lookup below.
    }

    // Orientation lock
    if (settings.orientationLock && "orientation" in screen) {
      (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })
        .lock?.("landscape-primary")
        .catch(() => {});
    }

    currentGameFile     = file;
    currentGameFileName = file.name;
    currentSystemId     = systemId;
    currentGameId       = gameId ?? null;

    // Reflect session context in the RetroOasisStore so subscribers can
    // observe the active game without prop-drilling through main.ts.
    store.batch(() => {
      store.set("session", {
        gameId:   currentGameId,
        gameName: gameName,
        systemId: currentSystemId,
        phase:    "loading",
      });
    });

    const compatibilityEntry =
      gameCompatibilityDb.lookup(gameId ?? "") ??
      gameCompatibilityDb.lookup(gameName);

    if (compatibilityEntry?.knownIssues?.length) {
      showInfoToast(`Compatibility note: ${compatibilityEntry.knownIssues[0]}`);
    }

    if (gameId && cloudSaveManager.isConnected()) {
      setLoadingSubtitle("Checking local and cloud save states before launch…");
      try {
        const result = await cloudSaveManager.syncGame(gameId, saveLibrary);
        if (result.errors > 0) {
          console.warn(
            `[${APP_NAME}] Cloud save-state sync completed with slot errors before launch.`,
            result,
          );
          showInfoToast(`Cloud sync had ${result.errors} error(s) — open the Save States panel to retry.`);
        } else if (result.pulled > 0 || result.pushed > 0) {
          const parts: string[] = [];
          if (result.pulled > 0) parts.push(`${result.pulled} pulled from cloud`);
          if (result.pushed > 0) parts.push(`${result.pushed} uploaded to cloud`);
          showInfoToast(`Save states updated · ${parts.join(" · ")}`);
        }
      } catch (error) {
        console.warn(
          `[${APP_NAME}] Cloud save-state sync failed before launch; continuing with local save states.`,
          error,
        );
      }
      setLoadingSubtitle("Preparing the emulator and loading your game…");
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
      } catch {
        // Auto-restore prompt or state read failed — launch game without restoring.
      }
    }

    if (pendingAutoRestore) {
      const registration = scheduleAutoRestoreOnGameStart({
        emulator,
        stateBytes: pendingAutoRestore,
        slot: AUTO_SAVE_SLOT,
        delayMs: 500,
        onConsumed: () => { pendingAutoRestoreCancel = null; },
        onError: () => {
          showInfoToast("Auto-restore failed — your save could not be loaded.", "error");
        },
      });
      pendingAutoRestoreCancel = () => {
        registration.cancel();
        pendingAutoRestoreCancel = null;
      };
    }

    const savedTier    = gameId ? getGameTierProfile(gameId) : null;
    const resolvedTier = tierOverride ?? savedTier ?? compatibilityEntry?.tierOverride ?? undefined;

    const gfxProfile = gameId ? getGameGraphicsProfile(gameId) : null;
    sessionGamePostEffectOverride = gfxProfile?.postEffect;
    const coreSettingsOverride: Record<string, string> = { ...settings.coreOptions };
    if (gfxProfile) {
      if (gfxProfile.resolutionPreset) {
        const presetOptions = getResolutionCoreOptions(systemId, gfxProfile.resolutionPreset);
        Object.assign(coreSettingsOverride, presetOptions);
      }
    }

    if (typeof gfxProfile?.drsEnabled === "boolean") {
      emulator.enableDRS(gfxProfile.drsEnabled);
    } else {
      const ladder = getResolutionLadder(systemId);
      const canDrs = ladder !== null && ladder.values.length > 1;
      emulator.enableDRS(canDrs && settings.dynamicResolutionScaling);
    }

    let biosAsset: Blob | undefined;
    try {
      const primaryBios = await biosLibrary.getLaunchBiosAsset(systemId);
      if (primaryBios) biosAsset = primaryBios;
    } catch {
      // BIOS asset lookup failed — launch without BIOS (best-effort).
    }

    await syncNetplayManagerFromSettings(settings);

    const apiStore = getApiKeyStore();
    const raState = apiStore.getState("retroachievements");
    const raCreds = (launchSystem?.hasAchievements && raState.enabled && raState.key)
      ? parseRAKey(raState.key)
      : null;

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
      achievements: raCreds ? {
        username: raCreds.username,
        apiKey: raCreds.apiKey,
        hardcore: true, // Default to hardcore for Oasis users
      } : undefined,
    });

    const materialised = emulator.getLaunchGameFile();
    if (materialised) {
      currentGameFile = materialised;
      currentGameFileName = materialised.name;
    }

    if (emulator.state !== "error") {
      syncEmulatorPostProcessFromSettings(gfxProfile?.postEffect);
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

    diagInfo(
      settings.verboseLogging,
      `[${APP_NAME}] Patch applied: "${patchFile.name}" → "${entry.name}" ` +
      `(${entry.size} → ${updatedEntry.size} bytes)`,
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
    // Flip the session slice to "running" so observers can gate UI that
    // only applies once the core has actually booted.
    store.set("session", { phase: "running" });
    // Tell the service worker to defer updates while gaming (preserves COI/SAB).
    notifyServiceWorkerGamingState(true);
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

    // Tell the service worker it can now apply any pending updates.
    notifyServiceWorkerGamingState(false);

    // End any in-progress play session before leaving the game view.
    void sessionTracker.endSession().catch(() => {});

    // Reset the session slice so observers know the game view is gone.
    store.batch(() => {
      store.set("session", {
        gameId:   null,
        gameName: null,
        systemId: null,
        phase:    "idle",
      });
    });

    // Release orientation lock when leaving the game view
    try {
      (screen.orientation as ScreenOrientation & { unlock?: () => void }).unlock?.();
    } catch { /* not supported */ }

    transitionToLibrary();
    document.title = APP_NAME;
    sessionGamePostEffectOverride = undefined;

    void renderLibrary(library, settings, onLaunchGame, emulator, onApplyPatch);
    document.dispatchEvent(new CustomEvent(LEGACY_EVENTS.returnToLibrary));
  };

  // 7. Wire UI
  // Extract onSettingsChange as a named function so it can be reused by both
  // initUI and the post-game landing controls rebuild in retro-oasis:returnToLibrary.
  // Previously the event listeners used a simplified handler that skipped syncing
  // emulator state (WebGPU, post-process effects, touch controls, verbose logging).
  const onSettingsChange = (patch: Partial<Settings>): void => {
    const playingOrPaused =
      emulator.state === "running" || emulator.state === "paused";
    Object.assign(settings, patch);
    if (
      patch.useWebGPU !== undefined ||
      patch.postProcessEffect !== undefined ||
      patch.performanceMode !== undefined
    ) {
      const postSyncOpts =
        patch.performanceMode !== undefined
          ? { tierHint: resolveTier(settings.performanceMode, deviceCaps) }
          : undefined;
      const needAsyncPrewarm =
        settings.useWebGPU && deviceCaps.webgpuAvailable && !emulator.webgpuAvailable;
      if (needAsyncPrewarm) {
        const webgpuPowerPref = (deviceCaps.isLowSpec || deviceCaps.isChromOS) ? "low-power" : "high-performance";
        emulator.preWarmWebGPU(webgpuPowerPref).then(() => {
          syncEmulatorPostProcessFromSettings(undefined, postSyncOpts);
        }).catch(() => {});
      } else {
        syncEmulatorPostProcessFromSettings(undefined, postSyncOpts);
      }
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
    if (typeof patch.dynamicResolutionScaling === "boolean" && playingOrPaused && currentSystemId) {
      const ladder = getResolutionLadder(currentSystemId);
      const canDrs = ladder !== null && ladder.values.length > 1;
      // Always sync (including off) so we never leave stale DRS when switching tiers or unsupported systems.
      emulator.enableDRS(canDrs && settings.dynamicResolutionScaling);
    }
    // Keep NetplayManager storage in sync with persisted Settings whenever
    // multiplayer-related fields change (including imports / programmatic patches).
    if (
      patch.netplayEnabled !== undefined ||
      patch.netplayServerUrl !== undefined ||
      patch.netplayUsername !== undefined ||
      patch.netplayIceServers !== undefined
    ) {
      void syncNetplayManagerFromSettings(settings).catch(() => {});
    }
    // Mirror the patch into the RetroOasisStore so subscribers react to the
    // same change that `saveSettings` persists to localStorage.
    mirrorSettingsPatchToStore(patch, store);
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
    getNetplayManager,
    canInstallPWA,
    onInstallPWA:       promptPWAInstall,
  });

  // Handle core restart requests (e.g. from internal resolution changes)
  const onRestartRequired = async () => {
    if (currentGameId && currentSystemId) {
      const entry = await library.getGame(currentGameId);
      if (entry && entry.blob) {
        const file = new File([entry.blob], entry.fileName, { type: entry.blob.type });
        void onLaunchGame(file, currentSystemId, currentGameId);
      }
    }
  };
  document.addEventListener(LEGACY_EVENTS.restartRequired, onRestartRequired);

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
        void syncNetplayManagerFromSettings(settings).then(() => {
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
        }).catch(() => {});
      }));
    }
  } catch {
    // Malformed URLs / non-browser environments are non-fatal.
  }

  // 8b. Web Share Target — pick up any ROM files deposited by the service
  //     worker when this app was opened from the OS share sheet.
  //     The service worker stores shared files under `/_shared/<filename>` in
  //     the "retro-oasis-shared-roms" cache; we retrieve and process them here,
  //     then delete the cached entries so they're not replayed on the next load.
  try {
    const shareCache = await caches.open("retro-oasis-shared-roms");
    const sharedKeys = await shareCache.keys();
    if (sharedKeys.length > 0) {
      for (const req of sharedKeys) {
        const resp = await shareCache.match(req);
        if (!resp) continue;
        const filename = resp.headers.get("X-Share-Filename") ?? req.url.split("/").pop() ?? "rom";
        const blob = await resp.blob();
        const file = new File([blob], decodeURIComponent(filename), { type: blob.type });
        void onFileChosen(file);
        await shareCache.delete(req);
      }
    }
  } catch {
    // Non-fatal — caches API unavailable in some environments.
  }

  wirePwaFileLaunchQueue(onFileChosen);

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
    showError(`${APP_NAME} failed to start. Check the browser console for details.`);
  });
}
