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
import { GameLibrary, getGameTierProfile, saveGameTierProfile } from "./library.js";
import { BiosLibrary }   from "./bios.js";
import { detectCapabilities, checkBatteryStatus } from "./performance.js";
import { buildDOM, initUI, showLanding,
         hideEjsContainer, renderLibrary, openSettingsPanel,
         buildLandingControls, showTierDowngradePrompt,
         resolveSystemAndAdd } from "./ui.js";
import { applyPatch } from "./patcher.js";
import type { PerformanceMode, PerformanceTier } from "./performance.js";

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
}

const STORAGE_KEY = "retrovault-settings";

const DEFAULT_SETTINGS: Settings = {
  volume:          0.7,
  lastGameName:    null,
  performanceMode: "auto",
  showFPS:         false,
  showAudioVis:    false,
  useWebGPU:       false,
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
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    console.warn("[retrovault] Could not persist settings to localStorage.");
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function main(): void {
  // 1. Build DOM
  const app = document.getElementById("app");
  if (!app) throw new Error("Root element #app not found");
  buildDOM(app);

  // 2. Detect hardware
  const deviceCaps = detectCapabilities();

  // 3. Load settings
  const settings = loadSettings();

  // 4. Instantiate services
  const emulator    = new PSPEmulator("ejs-player");
  const library     = new GameLibrary();
  const biosLibrary = new BiosLibrary();

  // Track the currently loaded game for tier-downgrade re-launch
  let currentGameId:   string | null = null;
  let currentGameFile: File | Blob | null = null;
  let currentGameFileName: string | null = null;
  let currentSystemId: string | null = null;

  // 4a. Preconnect to CDN early for faster game launches
  emulator.preconnect();

  // Pre-warm WebGL so first game launch doesn't stall on GPU driver init
  emulator.preWarmWebGL();

  // Pre-warm the PSP pipeline cache (PSP-representative shader patterns)
  emulator.warmUpPSPPipeline();

  // Pre-warm IndexedDB connections to eliminate cold-open latency
  library.warmUp().catch(() => {});
  biosLibrary.warmUp().catch(() => {});

  // Pre-warm WebGPU if the user has opted in and it is available
  if (settings.useWebGPU && deviceCaps.webgpuAvailable) {
    emulator.preWarmWebGPU().catch(() => {});
  }

  // In idle time: load and pre-compile cached shaders from previous sessions
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback?.(() => emulator.preWarmShaderCache().catch(() => {}));
    window.requestIdleCallback?.(() => emulator.prefetchLoader());
  } else {
    setTimeout(() => emulator.preWarmShaderCache().catch(() => {}), 3000);
    setTimeout(() => emulator.prefetchLoader(), 2000);
  }

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
    const gameName = file.name.replace(/\.[^.]+$/, "");
    settings.lastGameName = gameName;
    saveSettings(settings);

    // Update current-game tracking for tier-downgrade re-launch
    currentGameFile     = file;
    currentGameFileName = file.name;
    currentSystemId     = systemId;
    currentGameId       = gameId ?? null;

    // Apply per-game tier profile if no explicit override was requested
    const savedTier    = gameId ? getGameTierProfile(gameId) : null;
    const resolvedTier = tierOverride ?? savedTier ?? undefined;

    // Resolve BIOS URL for systems that need it (PS1, Saturn, Dreamcast, Lynx)
    let biosUrl: string | undefined;
    try {
      const primaryBios = await biosLibrary.getPrimaryBiosUrl(systemId);
      if (primaryBios) {
        biosUrl = primaryBios;
        // Blob URL will be revoked by PSPEmulator._revokeBlobUrl on teardown
      }
    } catch {
      // BIOS lookup failure is non-fatal — emulator may run without BIOS
    }

    await emulator.launch({
      file,
      volume:          settings.volume,
      systemId,
      performanceMode: settings.performanceMode,
      deviceCaps,
      tierOverride:    resolvedTier,
      biosUrl,
    });
  };

  // 5a. Wire patch application callback
  const onApplyPatch = async (gameId: string, patchFile: File): Promise<void> => {
    const entry = await library.getGame(gameId);
    if (!entry) throw new Error("Game not found in library");

    const romBuffer   = await entry.blob.arrayBuffer();
    const patchBuffer = await patchFile.arrayBuffer();
    const patched     = applyPatch(romBuffer, patchBuffer);

    const patchedBlob = new Blob([patched], { type: entry.blob.type });
    const patchedFile = new File([patchedBlob], entry.fileName, { type: entry.blob.type });

    // Update the stored blob in the library
    await library.removeGame(gameId);
    const newEntry = await library.addGame(patchedFile, entry.systemId);
    console.info(
      `[RetroVault] Patch applied: "${patchFile.name}" → "${entry.name}" ` +
      `(${entry.size} → ${newEntry.size} bytes)`
    );
  };

  // 5b. Wire the unified file-chosen handler (handles archives, patches, ROMs, m3u)
  const onFileChosen = async (file: File): Promise<void> => {
    await resolveSystemAndAdd(file, library, settings, onLaunchGame, emulator, onApplyPatch);
  };

  // 5a. Wire auto tier downgrade — triggered by onLowFPS
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
    hideEjsContainer();
    showLanding();
    document.title = "RetroVault";

    void renderLibrary(library, settings, onLaunchGame, emulator, onApplyPatch);
    document.dispatchEvent(new CustomEvent("retrovault:returnToLibrary"));
  };

  // 7. Wire UI
  initUI({
    emulator,
    library,
    biosLibrary,
    settings,
    deviceCaps,
    onLaunchGame,
    onApplyPatch,
    onFileChosen,
    onSettingsChange: (patch) => {
      Object.assign(settings, patch);
      saveSettings(settings);
      // If the user enables WebGPU, kick off the pre-warm immediately
      if (patch.useWebGPU && deviceCaps.webgpuAvailable && !emulator.webgpuAvailable) {
        emulator.preWarmWebGPU().catch(() => {});
      }
    },
    onReturnToLibrary,
  });

  // 8. If user returns to landing, rebuild landing header controls with a Resume button
  document.addEventListener("retrovault:returnToLibrary", () => {
    buildLandingControls(settings, deviceCaps, library, biosLibrary, (patch) => {
      Object.assign(settings, patch);
      saveSettings(settings);
    }, emulator, onLaunchGame, onResumeGame);
  });

  document.addEventListener("retrovault:openSettings", () => {
    openSettingsPanel(settings, deviceCaps, library, biosLibrary, (patch) => {
      Object.assign(settings, patch);
      saveSettings(settings);
    }, emulator, onLaunchGame);
  });

  // 9. Dev helpers
  if (import.meta.env.DEV) {
    window.__retrovault = { emulator, library, biosLibrary, settings, deviceCaps };
    console.info("[RetroVault] Dev mode. Access `window.__retrovault` in the console.");
    console.info("Device capabilities:", deviceCaps);
    console.info(`Hardware tier: ${deviceCaps.tier} (GPU score: ${deviceCaps.gpuBenchmarkScore}/100)`);
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
