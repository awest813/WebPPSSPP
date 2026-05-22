/**
 * emulator.ts — Multi-system EmulatorJS wrapper with performance enhancements
 *
 * EmulatorJS is loaded from the CDN at runtime by injecting a <script> tag for
 * "data/loader.js". It exposes its runtime entirely through globals:
 *   - window.EJS_*            config knobs (set BEFORE injecting loader.js)
 *   - window.EJS_emulator     the live EmulatorJS instance (set BY loader.js)
 *   - window.EJS_ready        callback – fires once the emulator UI is built
 *   - window.EJS_onGameStart  callback – fires once the game is actually running
 *
 * Performance enhancements:
 *   - Core preloading: <link rel="preconnect"> and prefetch hints for CDN
 *   - Per-system core prefetch: warm HTTP cache for EmulatorJS `*-wasm.data` blobs
 *   - ROM hand-off: File for EJS_gameUrl (on iOS, materialises into RAM first)
 *   - Tier-aware settings: picks the right core config per hardware tier
 *   - Audio latency adaptation: tunes audio buffer based on detected HW latency
 *   - Page Visibility API: auto-pauses when tab is hidden to save resources
 *   - WebGL context pre-warming: reduces cold-start jank on first launch
 *   - FPS monitoring: ring-buffer-based framerate tracking via rAF
 *   - Adaptive quality suggestions: logs warnings when sustained FPS is low
 *   - Memory-aware blob management: revokes URLs promptly, warns on large ROMs
 */

import { diagWarn } from "./diagnosticLog.js";
import { LEGACY_PERF_MARKS } from "./legacy.js";
import { getSystemById, type SystemInfo } from "./systems.js";
import {
  resolveMode, resolveTier, detectAudioCapabilities,
  isLikelyIOS, getSafariVersion,
  type PerformanceMode, type DeviceCapabilities, type PerformanceTier,
  MemoryMonitor,
  getResolutionLadder,
  ThermalMonitor,
  StartupProfiler,
  FpsPrediction,
  recordSystemLaunch,
  resolveCorePrefetchSystems,
} from "./performance.js";
import { shaderCache, GAME_WARMUP_WINDOW_MS } from "./shaderCache.js";
import { roomDisplayNameForKey, type NetplayManager } from "./multiplayer.js";
import {
  WebGPUPostProcessor,
  buildEffectPipeline,
  effectivePostProcessForSystem,
  POST_PROCESS_PIPELINE_WARMUP_EFFECTS,
  POST_PROCESS_WARMUP_BATCH_SIZE,
  type PostProcessConfig,
  type PostProcessEffect,
  DEFAULT_POST_PROCESS_CONFIG,
} from "./webgpuPostProcess.js";

// ── EJS global type declarations ─────────────────────────────────────────────

declare global {
  interface Window {
    EJS_player:        string;
    EJS_core:          string;
    EJS_gameUrl:       string | File;
    EJS_pathtodata:    string;
    EJS_gameName:      string;
    EJS_startOnLoaded: boolean;
    EJS_threads:       boolean;
    EJS_volume:        number;
    /**
     * EmulatorJS loader flag that forces the bundled source runtime in
     * data/src/*.js instead of emulator.min.js.
     */
    EJS_DEBUG_XX?:      boolean;
    /** EmulatorJS per-file URL overrides, keyed by basename. */
    EJS_paths?:         Record<string, string>;
    /** EmulatorJS loader default core options. */
    EJS_defaultOptions?: Record<string, string>;
    EJS_Settings?:     Record<string, string>;
    /** Optional EmulatorJS cheat database base URL. */
    EJS_cheatPath?:    string;
    /** Disable EmulatorJS's own beforeunload handler; RetroOasis owns auto-save UX. */
    EJS_disableAutoUnload?: boolean;
    /** Whether EmulatorJS should ask before the in-emulator exit action closes. */
    EJS_askBeforeExit?: boolean;
    /** Fixed interval in ms for EmulatorJS to flush in-game save files. */
    EJS_fixedSaveInterval?: number;
    /** Disable DOSBox Pure's generated BOOTUP.BAT helper. */
    EJS_disableBatchBootup?: boolean;
    /** Disable EmulatorJS-generated CUE wrappers for single-file disc images. */
    EJS_disableCue?:    boolean;
    EJS_biosUrl?:      string | File;
    /** Override path to the core `.data` bundle (absolute URL). Used for cores not on the CDN. */
    EJS_corePath?:     string;
    EJS_ready?:        () => void;
    EJS_onGameStart?:  () => void;
    EJS_onExit?:       () => void;
    EJS_emulator?:     EJSEmulatorInstance;
    /** Netplay signalling server WebSocket URL (set when netplay is active). */
    EJS_netplayServer?:     string;
    /** ICE server list forwarded to WebRTC peer connections. */
    EJS_netplayICEServers?: RTCIceServer[];
    /** Numeric room-scoping ID derived from the game's string identifier. */
    EJS_gameID?:            number;
    /** Canonical string room key used for compatibility discovery. */
    EJS_roomKey?:           string;
    /** Friendly room name presented by supported netplay UIs. */
    EJS_netplayRoom?:       string;
    /** Player display name shown to other participants in a netplay room. */
    EJS_playerName?:        string;
    /** Playwright-only marker that skips real EmulatorJS downloads during E2E. */
    _RETRO_OASIS_E2E_STUB?: boolean;
  }
}

// ── Core Bridge ─────────────────────────────────────────────────────────────

export interface VirtualFileSystem {
  exists(path: string): boolean;
  read(path: string): Uint8Array;
  write(path: string, data: Uint8Array): void;
  mkdir(path: string): void;
  unlink(path: string): void;
  readdir(path: string): string[];
  stat(path: string): { size: number } | null;
}

export interface ScreenshotOptions {
  format: "image/jpeg" | "image/png";
  quality?: number;
}

export interface InputEvent {
  playerIndex: number;
  buttonIndex: number;
  value: number;
}

export interface DiskInfo {
  current: number;
  count: number;
  label?: string;
}

/**
 * CoreBridge wraps the low-level EmulatorJS global instance to provide a 
 * robust, typed, and asynchronous interface for the frontend.
 * 
 * @example
 * ```typescript
 * const bridge = emulator.getBridge();
 * 
 * // Volume control
 * bridge.setVolume(0.8);
 * 
 * // Screenshot capture
 * const screenshot = await bridge.captureScreenshot({ format: 'image/jpeg', quality: 0.9 });
 * 
 * // VFS operations
 * const saveData = await bridge.fs.readAsync('/data/saves/mygame.sav');
 * await bridge.fs.writeAsync('/data/saves/mygame.sav', saveData);
 * ```
 */
export class CoreBridge {
  private _instance: EJSEmulatorInstance | null = null;
  private _canvas: HTMLCanvasElement | null = null;
  private _playerId: string;

  constructor(instance: EJSEmulatorInstance, playerId: string = "ejs-player") {
    this._instance = instance;
    this._playerId = playerId;
  }

  /** @internal */
  _setInstance(instance: EJSEmulatorInstance): void {
    this._instance = instance;
  }

  get instance(): EJSEmulatorInstance {
    if (!this._instance) throw new Error("Emulator core is not initialized.");
    return this._instance;
  }

  /**
   * Whether the core is currently initialized and ready.
   */
  get isReady(): boolean {
    return this._instance !== null;
  }

  /**
   * Virtual Filesystem Access.
   * Provides high-performance read/write paths for ROMs, BIOS, and save data.
   */
  get fs(): VirtualFileSystem {
    const fs = this.instance.Module?.FS;
    if (!fs) throw new Error("Emulator VFS is not available.");
    return {
      exists: (path: string) => fs.analyzePath(path).exists,
      read: (path: string) => fs.readFile(path),
      write: (path: string, data: Uint8Array) => fs.writeFile(path, data),
      mkdir: (path: string) => {
        if (!fs.analyzePath(path).exists) fs.mkdir?.(path);
      },
      unlink: (path: string) => {
        if (fs.analyzePath(path).exists) fs.unlink(path);
      },
      readdir: (path: string) => fs.readdir(path),
      stat: (path: string) => {
        try { return fs.stat(path); }
        catch { return null; }
      },
    };
  }

  /**
   * Async VFS read with error handling.
   * Returns null on failure instead of throwing.
   */
  async readFileAsync(path: string): Promise<Uint8Array | null> {
    try {
      return this.fs.read(path);
    } catch {
      return null;
    }
  }

  /**
   * Async VFS write with directory auto-creation.
   */
  async writeFileAsync(path: string, data: Uint8Array): Promise<boolean> {
    try {
      const dirMatch = path.match(/^(.+)\/[^/]+$/);
      if (dirMatch && dirMatch[1]) {
        const dir = dirMatch[1];
        this.fs.mkdir(dir);
      }
      this.fs.write(path, data);
      return true;
    } catch {
      return false;
    }
  }

  setVolume(v: number): void {
    this.instance.setVolume(v);
  }

  pause(): void {
    this.instance.pause?.();
  }

  resume(): void {
    this.instance.resume?.();
  }

  restart(): void {
    this.instance.gameManager?.restart();
  }

  /**
   * Quick Save/Load via internal EmulatorJS mechanism.
   * Slot 0 is usually the "auto" slot.
   */
  saveState(slot: number): boolean {
    return this.instance.gameManager?.quickSave(slot) ?? false;
  }

  loadState(slot: number): void {
    this.instance.gameManager?.quickLoad(slot);
  }

  /**
   * Access the Emscripten Audio Context for advanced visualizations
   * or latency monitoring.
   */
  get audioContext(): AudioContext | null {
    return this.instance.Module?.AL?.currentCtx?.audioCtx ?? null;
  }

  /**
   * Capture a screenshot from the emulator canvas.
   * Returns null if canvas is not available.
   */
  async captureScreenshot(options: ScreenshotOptions = { format: "image/jpeg", quality: 0.75 }): Promise<Blob | null> {
    const playerEl = document.getElementById(this._playerId);
    if (!playerEl) return null;
    
    const canvas = playerEl.querySelector("canvas");
    if (!canvas || canvas.width === 0 || canvas.height === 0) return null;

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => resolve(null), 5000);
      canvas.toBlob(
        (blob) => { clearTimeout(timeoutId); resolve(blob); },
        options.format,
        options.quality
      );
    });
  }

  /**
   * Get the canvas element used by the emulator.
   */
  getCanvas(): HTMLCanvasElement | null {
    if (this._canvas) return this._canvas;
    
    const playerEl = document.getElementById(this._playerId);
    if (!playerEl) return null;
    
    this._canvas = playerEl.querySelector("canvas");
    return this._canvas;
  }


  /**
   * Get current disk information for multi-disk games.
   */
  getDiskInfo(): DiskInfo | null {
    const gm = this.instance.gameManager;
    if (!gm?.getDiskCount) return null;
    
    const count = gm.getDiskCount();
    if (count <= 1) return null;
    
    return {
      current: gm.getCurrentDisk?.() ?? 0,
      count,
      label: gm.getDiskLabel?.(),
    };
  }

  /**
   * Swap to a specific disk (for multi-disc games).
   */
  swapDisk(diskIndex: number): void {
    this.instance.gameManager?.setCurrentDisk?.(diskIndex);
  }

  /**
   * Display a message overlay in the emulator.
   * @param message - Message to display
   * @param duration - Duration in milliseconds
   */
  displayMessage(message: string, duration: number = 3000): void {
    this.instance.displayMessage?.(message, duration);
  }

  /**
   * Get the current game name.
   */
  getGameName(): string | null {
    return this.instance.gameName ?? null;
  }

  /**
   * Get the core name being used.
   */
  getCoreName(): string | null {
    return this.instance.core ?? null;
  }

  /**
   * Check if save states are supported.
   */
  supportsStates(): boolean {
    return this.instance.gameManager?.supportsStates?.() ?? false;
  }

  /**
   * Get the save file data.
   */
  getSaveFile(): Uint8Array | null {
    return this.instance.gameManager?.getSaveFile?.() ?? null;
  }

  /**
   * Load save file data into the emulator.
   */
  loadSaveFile(data: Uint8Array): void {
    this.instance.gameManager?.loadSaveFile?.(data);
  }

  /**
   * Toggle the display of the emulator's built-in menu.
   */
  toggleMenu(): void {
    this.instance.toggleMenu?.();
  }

  /**
   * Take focus for keyboard input.
   */
  takeFocus(): void {
    this.instance.takeFocus?.();
  }

  /**
   * Check if the emulator is paused.
   */
  get isPaused(): boolean {
    return this.instance.paused ?? false;
  }

  /**
   * Get the current frame count.
   */
  get frameCount(): number {
    return this.instance.frameCount ?? 0;
  }
}

interface EJSEmulatorInstance {
  setVolume(volume: number): void;
  pause?(): void;
  resume?(): void;
  paused?: boolean;
  core?: string;
  gameName?: string;
  frameCount?: number;
  displayMessage?(message: string, duration: number): void;
  simulateKey?(key: string, pressed: boolean): void;
  takeFocus?(): void;
  toggleMenu?(): void;
  gameManager?: {
    restart(): void;
    quickSave(slot: number): boolean;
    quickLoad(slot: number): void;
    supportsStates(): boolean;
    getSaveFile?(): Uint8Array | null;
    loadSaveFile?(data: Uint8Array): void;
    simulateInput?(playerIndex: number, buttonIndex: number, value: number): void;
    getDiskCount?(): number;
    getCurrentDisk?(): number;
    getDiskLabel?(): string;
    setCurrentDisk?(index: number): void;
  };
  /** Emscripten module — used to access OpenAL audio and the virtual filesystem. */
  Module?: {
    AL?: {
      currentCtx?: {
        audioCtx?: AudioContext;
        sources?:  Record<string, { gain: GainNode }>;
      };
    };
    /** Emscripten virtual filesystem — available after core boot. */
    FS?: {
      readFile(path: string): Uint8Array;
      writeFile(path: string, data: Uint8Array): void;
      mkdir?(path: string, mode?: number): void;
      stat(path: string): { size: number };
      readdir(path: string): string[];
      unlink(path: string): void;
      analyzePath(path: string): { exists: boolean; object?: unknown };
    };
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const EJS_CDN_BASE = "https://cdn.emulatorjs.org/stable/data/";
export const EJS_NIGHTLY_CDN_BASE = "https://cdn.emulatorjs.org/nightly/data/";
export const EJS_DATA_BASE = new URL(/* @vite-ignore */ "../data/", import.meta.url).toString();

/** Warn when a ROM file exceeds this size (500 MB). */
const LARGE_ROM_THRESHOLD = 500 * 1024 * 1024;

// Adaptive quality thresholds — moved here so they are not reconstructed on
// every _checkAdaptiveQuality() call (which fires every ~10 frames).
const AQ_LOW_FPS_HZ   = 25;        // FPS floor before the timer starts
const AQ_TRIGGER_MS   = 10_000;    // sustained low-FPS window before alert
const AQ_COOLDOWN_MS  = 60_000;    // minimum gap between successive alerts

// Dynamic resolution scaling thresholds
const DRS_STEP_DOWN_FPS = 25;      // FPS floor that triggers a resolution step-down
const DRS_STEP_UP_FPS   = 55;      // FPS headroom required before stepping resolution back up
const DRS_STEP_DOWN_MS  = 2_000;   // sustained low-FPS window before stepping down (2 s)
const DRS_STEP_UP_MS    = 10_000;  // sustained good-FPS window before stepping up (10 s)

const DRS_SYSTEM_THRESHOLDS: Record<string, { stepDownFps: number; stepUpFps: number; stepDownMs: number; stepUpMs: number }> = {
  nds: {
    stepDownFps: 28,
    stepUpFps: 55,
    stepDownMs: 2_000,
    stepUpMs: 10_000,
  },
  segaDC: {
    stepDownFps: 22,
    stepUpFps: 45,
    stepDownMs: 3_000,
    stepUpMs: 15_000,
  },
  psp: {
    stepDownFps: 21,
    stepUpFps: 50,
    stepDownMs: 2_500,
    stepUpMs: 10_000,
  },
  /** N64 often hovers below full 60; step before the generic 25 fps floor bites. */
  n64: {
    stepDownFps: 24,
    stepUpFps: 52,
    stepDownMs: 2_500,
    stepUpMs: 12_000,
  },
  /** PS1 targets ~60/50; step down when averages suggest sustained GPU pressure. */
  psx: {
    stepDownFps: 26,
    stepUpFps: 54,
    stepDownMs: 2_000,
    stepUpMs: 10_000,
  },
};

let cachedWebGL2Support: boolean | null = null;

const PSP_RESOLUTION_STEPS = ["1", "2", "4", "8"];
const NDS_RESOLUTION_STEPS = ["256x192", "512x384", "768x576", "1024x768"];
const N64_RESOLUTION_STEPS = ["1", "2", "4"];
const PSX_RESOLUTION_STEPS = ["1x(native)", "2x", "4x", "8x", "16x"];
const DREAMCAST_RESOLUTION_STEPS = ["640x480", "1280x960", "1920x1440", "2560x1920"];

function clampLadderValue(value: string | undefined, ladder: readonly string[], maxIdx: number): string {
  const currentIdx = value ? ladder.indexOf(value) : 0;
  const safeCurrentIdx = currentIdx >= 0 ? currentIdx : 0;
  return ladder[Math.min(safeCurrentIdx, Math.max(0, maxIdx), ladder.length - 1)]!;
}

function parseAnisotropicValue(value: string | undefined): number {
  if (!value || value === "off") return 0;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatAnisotropicValue(value: number): string {
  return value <= 0 ? "off" : `${value}x`;
}

function clampThreadOption(
  value: string | undefined,
  caps: DeviceCapabilities,
  maxAllowed: number,
): string {
  const requested = parseInt(value ?? "1", 10);
  const safeRequested = Number.isFinite(requested) ? requested : 1;
  const cpuBudget = Math.max(1, caps.cpuCores > 2 ? caps.cpuCores - 1 : 1);
  return String(Math.max(1, Math.min(safeRequested, cpuBudget, maxAllowed)));
}

function emulatorJsBaseFileName(gameName: string): string {
  const invalidCharacters = /[#<$+%>!`&*'|{}/\\?"=@:^\r\n]/gi;
  return gameName.replace(invalidCharacters, "").trim();
}

/**
 * Reset the cached WebGL2 support flag. Exposed for unit tests only.
 * @internal
 */
export function clearWebGL2SupportCache(): void {
  cachedWebGL2Support = null;
}

/**
 * Maps RetroOasis system ids (`EJS_core`) to EmulatorJS stable CDN core blobs.
 *
 * Upstream packages each core as a single compressed `*-wasm.data` archive (see
 * `data/src/emulator.js` — `downloadGameCore`). Prefetching that file warms the
 * HTTP cache for the same URL the loader requests after reading
 * `cores/reports/<core>.json`. Paths are relative to `EJS_CDN_BASE`.
 *
 * We prefetch the common runtime variant for each core. Most cores use the
 * non-legacy, non-threaded `<core>-wasm.data` file; threaded-only cores use
 * their `-thread-wasm.data` package.
 */
const CORE_PREFETCH_MAP: Record<string, string> = {
  psp:        "cores/ppsspp-thread-wasm.data",
  n64:        "cores/mupen64plus_next-wasm.data",
  psx:        "cores/mednafen_psx_hw-wasm.data",
  nds:        "cores/desmume2015-wasm.data",
  gba:        "cores/mgba-wasm.data",
  gb:         "cores/gambatte-wasm.data",
  gbc:        "cores/gambatte-wasm.data",
  nes:        "cores/fceumm-wasm.data",
  snes:       "cores/snes9x-wasm.data",
  snesBsnes:  "cores/bsnes-wasm.data",
  segaMD:     "cores/genesis_plus_gx-wasm.data",
  segaMDWide: "cores/genesis_plus_gx_wide-wasm.data",
  segaGG:     "cores/genesis_plus_gx-wasm.data",
  segaMS:     "cores/genesis_plus_gx-wasm.data",
  arcade:     "cores/fbneo-wasm.data",
  segaSaturn: "cores/yabause-wasm.data",
  mame2003:   "cores/mame2003_plus-wasm.data",
  atari7800:  "cores/prosystem-wasm.data",
  intv:       "cores/freeintv-wasm.data",
  dos:        "cores/dosbox_pure-thread-wasm.data",
  lynx:       "cores/handy-wasm.data",
  ngp:        "cores/mednafen_ngp-wasm.data",
  atari2600:  "cores/stella2014-wasm.data",
  "3ds":      "cores/azahar-thread-wasm.data",
};

/**
 * Core-specific CDN channel overrides.
 *
 * RetroOasis currently ships the 4.3-pre-compatible source runtime, but keeps
 * most systems on stable core bundles. PPSSPP is the one deliberate exception:
 * upstream's 4.3-pre work materially improves PSP hardware rendering and
 * fast-forward behavior, and PPSSPP cores are not interchangeable across the
 * 4.2/4.3 boundary.
 */
const CORE_CDN_BASE_OVERRIDES: Record<string, string> = {
  ppsspp: EJS_NIGHTLY_CDN_BASE,
  azahar: EJS_NIGHTLY_CDN_BASE,
  bsnes: EJS_NIGHTLY_CDN_BASE,
  dosbox_pure: EJS_NIGHTLY_CDN_BASE,
  freeintv: EJS_NIGHTLY_CDN_BASE,
  genesis_plus_gx_wide: EJS_NIGHTLY_CDN_BASE,
};

function coreNameForSystem(system: SystemInfo, ejsSettings: Record<string, string>): string {
  if (ejsSettings.retroarch_core) return ejsSettings.retroarch_core;
  const relPath = CORE_PREFETCH_MAP[system.id];
  const fileName = relPath?.split("/").pop();
  if (fileName) {
    return fileName.replace(/(?:-thread)?(?:-legacy)?-wasm\.data$/, "");
  }
  return system.coreId ?? system.id;
}

function cdnBaseForCore(coreName: string): string {
  return CORE_CDN_BASE_OVERRIDES[coreName] ?? EJS_CDN_BASE;
}

/**
 * CDN / RetroArch wasm package name after applying `retroarch_core` overrides.
 * Matches the basename EmulatorJS downloads (`<name>-wasm.data`).
 */
export function wasmCorePackageNameFor(
  system: SystemInfo,
  ejsSettings: Record<string, string>,
): string {
  return coreNameForSystem(system, ejsSettings);
}

// ── State machine ─────────────────────────────────────────────────────────────

export type EmulatorState = "idle" | "loading" | "running" | "paused" | "error";

// ── FPS monitor ───────────────────────────────────────────────────────────────

export interface FPSSnapshot {
  /** Current instantaneous FPS. */
  current: number;
  /** Average FPS over the sampling window. */
  average: number;
  /** Minimum FPS seen in the sampling window. */
  min: number;
  /** Maximum FPS seen in the sampling window. */
  max: number;
  /** Number of dropped frames (below 50% of target). */
  droppedFrames: number;
  /**
   * 95th-percentile frame time in milliseconds over the sampling window.
   *
   * The P95 frame time is the value below which 95% of frames fall.
   * Unlike average frame time, P95 captures worst-case jank spikes:
   * a game running at 60 fps average but with occasional 100 ms hitches
   * will show a high P95 even though the average looks healthy.
   *
   * Example thresholds:
   *   ≤ 16 ms → smooth 60 fps even in the worst frames
   *   ≤ 33 ms → smooth 30 fps even in the worst frames
   *   > 50 ms → visible stutter / jank in most frames
   */
  p95FrameTimeMs: number;
}

// ── Diagnostic event log ──────────────────────────────────────────────────────

/**
 * A timestamped diagnostic event recorded during emulator operation.
 * Used by the debug panel to display a performance event timeline.
 */
export interface DiagnosticEvent {
  /** Unix timestamp (ms) when the event occurred. */
  timestamp: number;
  /** Category for filtering/display. */
  category: "performance" | "audio" | "render" | "system" | "error";
  /** Human-readable message. */
  message: string;
}

/**
 * Maximum number of diagnostic events retained in memory.
 * 200 balances useful debug history (~3 min of gameplay at 1 event/s) against
 * the ~40 KB peak memory footprint. The diagnostic timeline UI displays only
 * the last 20 events; the full buffer is exported with "Copy Debug Info".
 */
const MAX_DIAGNOSTIC_EVENTS = 200;

/**
 * FPS monitor using a fixed-size ring buffer to eliminate array
 * allocations and shift() overhead. The pre-allocated Float64Array
 * never grows or shrinks, producing zero GC pressure during gameplay.
 */
class FPSMonitor {
  private _rafId: number | null = null;
  private _lastTime = 0;
  private _droppedFrames = 0;
  private _targetFPS: number;
  private _running = false;
  private _enabled = false;
  private _onUpdate?: (snapshot: FPSSnapshot) => void;
  private _frameCount = 0;

  /**
   * Frames between `_onUpdate` callbacks.
   *
   * Starts at 10 (fires ~6×/s at 60 fps). Automatically widened to 30
   * (fires ~2×/s) after 3 consecutive healthy callbacks — reducing ring-buffer
   * scan overhead by ~66% during sustained normal gameplay. Narrows back to 10
   * immediately when FPS drops, keeping low-FPS detection prompt.
   * For 2D cores, set to 60 (~1×/s) via set2DMode(true) since they rarely
   * need adaptive quality adjustments.
   */
  private _callbackInterval = FPSMonitor._CALLBACK_INTERVAL_LOW;
  private _is2D = false;

  /**
   * Consecutive stable-FPS callback count for hysteresis.
   * The interval is widened only after this reaches the required count,
   * preventing oscillation when FPS hovers around the threshold.
   */
  private _stableCallbackCount = 0;

  /**
   * FPS threshold above which the callback interval is considered "stable"
   * and widened to CALLBACK_INTERVAL_STABLE to reduce CPU overhead.
   */
  private static readonly _FPS_STABLE_THRESHOLD = 55;
  private static readonly _CALLBACK_INTERVAL_LOW    = 10;
  private static readonly _CALLBACK_INTERVAL_STABLE = 30;
  private static readonly _CALLBACK_INTERVAL_2D     = 60;
  /** Consecutive stable callbacks required before widening the interval. */
  private static readonly _STABLE_COUNT_REQUIRED = 3;

  private readonly _windowSize: number;
  private readonly _ring: Float64Array;
  /**
   * Reusable scratch space for percentile calculations.
   *
   * This avoids allocating a temporary JS Array and comparator closure inside
   * getSnapshot(), which is called repeatedly from the render loop.
   */
  private readonly _sortedScratch: Float64Array;
  private _ringHead = 0;
  private _ringCount = 0;

  constructor(targetFPS = 60) {
    this._targetFPS = targetFPS;
    this._windowSize = 60;
    this._ring = new Float64Array(this._windowSize);
    this._sortedScratch = new Float64Array(this._windowSize);
    this._tick = this._tick.bind(this);
  }

  set onUpdate(cb: ((snapshot: FPSSnapshot) => void) | undefined) {
    this._onUpdate = cb;
  }

  get enabled(): boolean { return this._enabled; }

  start(): void {
    if (this._rafId !== null) return;
    this._ringHead = 0;
    this._ringCount = 0;
    this._droppedFrames = 0;
    this._frameCount = 0;
    this._callbackInterval = FPSMonitor._CALLBACK_INTERVAL_LOW;
    this._stableCallbackCount = 0;
    this._lastTime = performance.now();
    this._running = true;
    this._enabled = true;
    this._rafId = requestAnimationFrame(this._tick);
  }

  stop(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._running = false;
    this._enabled = false;
  }

  setCallbackEnabled(active: boolean): void {
    this._enabled = active;
    // NOTE: does not stop the rAF loop — the loop keeps running for accurate
    // stats even when the FPS overlay is hidden, allowing instant resume.
  }

  set2DMode(is2D: boolean): void {
    this._is2D = is2D;
    if (is2D) {
      this._callbackInterval = FPSMonitor._CALLBACK_INTERVAL_2D;
    }
  }

  getSnapshot(): FPSSnapshot {
    if (this._ringCount === 0) {
      return { current: 0, average: 0, min: 0, max: 0, droppedFrames: 0, p95FrameTimeMs: 0 };
    }

    const count = this._ringCount;
    const lastIdx = (this._ringHead - 1 + this._windowSize) % this._windowSize;
    const lastDelta = this._ring[lastIdx]!;
    const current = lastDelta > 0 ? 1000 / lastDelta : 0;

    let sum = 0;
    let maxDelta = 0;
    let minDelta = Infinity;
    // Copy into reusable scratch space for percentile computation.
    // NOTE: keep this allocation-free; getSnapshot() is called from rAF.
    let idx = this._ringHead - count;
    if (idx < 0) idx += this._windowSize;
    for (let i = 0; i < count; i++) {
      const d = this._ring[idx]!;
      this._sortedScratch[i] = d;
      sum += d;
      if (d > maxDelta) maxDelta = d;
      if (d > 0 && d < minDelta) minDelta = d;
      idx++;
      if (idx === this._windowSize) idx = 0;
    }

    const avgDelta = sum / count;
    const average = avgDelta > 0 ? 1000 / avgDelta : 0;
    const min = maxDelta > 0 ? 1000 / maxDelta : 0;
    const max = isFinite(minDelta) && minDelta > 0 ? 1000 / minDelta : 0;

    // P95 frame time: insertion-sort the scratch values ascending, then pick
    // the 95th-percentile element. N is capped at 60, so this is tiny and
    // consistently allocation-free (fewer GC spikes in long sessions).
    this._sortScratchAscending(count);
    const p95Idx = Math.max(0, Math.ceil(count * 0.95) - 1);
    const p95FrameTimeMs = Math.round(this._sortedScratch[p95Idx]!);

    return {
      current: Math.round(current),
      average: Math.round(average),
      min: Math.round(min),
      max: isFinite(max) ? Math.round(max) : 0,
      droppedFrames: this._droppedFrames,
      p95FrameTimeMs,
    };
  }

  private _sortScratchAscending(count: number): void {
    for (let i = 1; i < count; i++) {
      const value = this._sortedScratch[i]!;
      let j = i - 1;
      while (j >= 0 && this._sortedScratch[j]! > value) {
        this._sortedScratch[j + 1] = this._sortedScratch[j]!;
        j--;
      }
      this._sortedScratch[j + 1] = value;
    }
  }

  private _tick(now: number): void {
    const delta = now - this._lastTime;
    this._lastTime = now;

    if (delta > 0 && delta < 1000) {
      this._ring[this._ringHead] = delta;
      this._ringHead = (this._ringHead + 1) % this._windowSize;
      if (this._ringCount < this._windowSize) this._ringCount++;
      this._frameCount++;

      const targetInterval = 1000 / this._targetFPS;
      if (delta > targetInterval * 2) {
        this._droppedFrames++;
      }

      if (this._enabled && this._frameCount % this._callbackInterval === 0) {
        const snap = this.getSnapshot();
        this._onUpdate?.(snap);
        // Adapt callback frequency with hysteresis to avoid rapid oscillation
        // when FPS hovers around the stable threshold:
        //   - Narrow immediately when FPS drops (prompt low-FPS detection).
        //   - Widen only after 3 consecutive healthy callbacks (prevents flickering).
        if (snap.average >= FPSMonitor._FPS_STABLE_THRESHOLD) {
          this._stableCallbackCount++;
          if (this._stableCallbackCount >= FPSMonitor._STABLE_COUNT_REQUIRED) {
            this._callbackInterval = this._is2D
              ? FPSMonitor._CALLBACK_INTERVAL_2D
              : FPSMonitor._CALLBACK_INTERVAL_STABLE;
            this._stableCallbackCount = 0;
          }
        } else {
          this._stableCallbackCount = 0;
          this._callbackInterval = this._is2D
            ? FPSMonitor._CALLBACK_INTERVAL_2D
            : FPSMonitor._CALLBACK_INTERVAL_LOW;
        }
      }
    }

    // Re-schedule only when still running; stop() may have been called while
    // this callback was already in-flight.
    if (this._running) {
      this._rafId = requestAnimationFrame(this._tick);
    } else {
      // Clear the stale handle so start() can restart the loop if needed.
      this._rafId = null;
    }
  }
}

/**
 * Metadata captured from GPUAdapter.info (Chrome 113+) during preWarmWebGPU().
 * Fields reflect the GPUAdapterInfo dictionary from the WebGPU spec.
 */
export interface WebGPUAdapterInfo {
  /** GPU vendor string, e.g. "nvidia", "intel", "amd". */
  vendor: string;
  /** Microarchitecture family, e.g. "turing", "xe-lpg". */
  architecture: string;
  /** Device identifier string reported by the driver. */
  device: string;
  /** Human-readable description (driver-provided, may be empty). */
  description: string;
  /** True when the adapter is a software fallback (e.g. CPU-based SwiftShader). */
  isFallbackAdapter: boolean;
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface LaunchOptions {
  /** The ROM file or blob. Blob avoids the copy overhead of new File([blob]). */
  file: File | Blob;
  /** Original filename — required when file is a raw Blob. */
  fileName?: string;
  /** Volume 0–1. */
  volume: number;
  /** EmulatorJS core/system id, e.g. "psp", "nes", "gba". */
  systemId: string;
  /** Performance mode controlling EJS_Settings overrides. */
  performanceMode: PerformanceMode;
  /** Device capabilities result from detectCapabilities(). */
  deviceCaps: DeviceCapabilities;
  /**
   * Optional explicit tier override — bypasses the auto-detected tier.
   * Used by the auto-downgrade flow when re-launching at a lower quality tier.
   */
  tierOverride?: PerformanceTier;
  /**
   * Optional per-game core-option overrides merged on top of the tier settings.
   * Keys are RetroArch core-option names; values are string option values.
   * Typical use: resolution preset from the per-game graphics profile.
   */
  coreSettingsOverride?: Record<string, string>;
  /**
   * Raw Blob/File for the system BIOS (e.g. PS1 SCPH-5501, Saturn BIOS).
   * The emulator will create a temporary Object URL for EmulatorJS to read,
   * completely managing its lifecycle and tearing it down automatically to prevent leaks.
   */
  biosAsset?: Blob;
  /**
   * Optional NetplayManager instance. When provided and `isActive` is true,
   * the EmulatorJS netplay globals are set so the built-in Netplay button and
   * room browser become available in the emulator toolbar.
   */
  netplayManager?: NetplayManager;
  /**
   * The game's string identifier (e.g. from GameLibrary). Used to derive a
   * stable numeric EJS_gameID for netplay room scoping. Required when
   * `netplayManager` is active; ignored otherwise.
   */
  gameId?: string;
  /**
   * Optional RetroAchievements credentials. When provided, the emulator core
   * will be configured to track progress and unlock achievements on the fly.
   */
  achievements?: {
    username: string;
    apiKey: string;
    hardcore?: boolean;
  };
  /**
   * When true, skip the file-extension validation check in the emulator.
   *
   * Set this when launching a game that already exists in the library, where
   * the user may have manually reassigned the system via the "change system"
   * feature. In that case the file extension may not match the new system's
   * accepted extensions, but the user's explicit choice should be respected.
   */
  skipExtensionCheck?: boolean;
}

// ── PSPEmulator ───────────────────────────────────────────────────────────────

export class PSPEmulator {
  private _state: EmulatorState = "idle";
  private _blobUrl: string | null = null;
  private readonly _playerId: string;
  private _currentSystem: SystemInfo | null = null;
  private _fpsMonitor: FPSMonitor;
  private _visibilityHandler: (() => void) | null = null;
  private _beforeUnloadHandler: (() => void) | null = null;
  private _pageHideHandler: (() => void) | null = null;
  private _contextLossHandler: ((event: Event) => void) | null = null;
  private _pausedByVisibility = false;
  private _preconnected = false;
  private _activeTier: PerformanceTier | null = null;
  private _activeCoreSettings: Record<string, string> | null = null;
  private _biosUrl: string | File | null = null;
  private _prefetchedCores = new Set<string>();
  private _webglPreWarmed = false;
  private _pspPipelineWarmed = false;
  private _dcPipelineWarmed = false;
  private _2dPipelineWarmed = false;
  private _webgpuDevice: GPUDevice | null = null;
  private _webgpuPreWarmed = false;
  private _webgpuAdapterInfo: WebGPUAdapterInfo | null = null;
  private _postProcessor: WebGPUPostProcessor | null = null;
  private _postProcessConfig: PostProcessConfig = { ...DEFAULT_POST_PROCESS_CONFIG };
  private _audioWorkletCtx: AudioContext | null = null;
  private _audioWorkletCtxOwned = false;
  private _audioWorkletNode: AudioWorkletNode | null = null;
  private _audioAnalyserNode: AnalyserNode | null = null;
  /** Optional BiquadFilterNode wired between the worklet and the analyser/destination. */
  private _audioFilterNode: BiquadFilterNode | null = null;
  private _audioUnderruns = 0;
  private _audioLevel = 0;
  /** Timestamp (ms) of the last audio-underrun console.warn — rate-limits log spam. */
  private _lastAudioUnderrunWarnTime = 0;
  private _memoryMonitor: MemoryMonitor = new MemoryMonitor();
  /** Timestamp (ms) when sustained low FPS was first detected; 0 when FPS is healthy. */
  private _lowFPSStartTime = 0;
  private _bridge: CoreBridge | null = null;
  /**
   * Timestamp (ms) of the last low-FPS quality suggestion, to debounce warnings.
   * Initialised to -Infinity so the very first suggestion can always fire
   * regardless of how soon after page-load the game is launched (avoids the
   * 60-second page-age requirement that would arise from using 0 as the sentinel).
   */
  private _lastQualitySuggestionTime = Number.NEGATIVE_INFINITY;
  /** Timer ID for the launch watchdog — clears when the game starts or errors. */
  private _launchTimeoutId: ReturnType<typeof setTimeout> | null = null;
  /** Diagnostic event log for the debug panel timeline. */
  private _diagnosticLog: DiagnosticEvent[] = [];
  /** Called when WebGPU post-processing fails to activate despite being requested. */
  onPostProcessorFallback?: (reason: string) => void;
  /**
   * In-flight promise for the EmulatorJS loader script injection.
   * Cached so that concurrent `_loadScript()` calls share the same load
   * instead of double-injecting the script.
   */
  private _scriptLoadPromise: Promise<void> | null = null;

  // ── Dynamic resolution scaling (DRS) state ──────────────────────────────────
  /** Whether DRS is currently active for this emulator instance. */
  private _drsEnabled = false;
  /** Index into the current system's resolution ladder (0 = native). */
  private _drsCurrentStepIdx = 0;
  /** Timestamp (ms) when low FPS was first detected for DRS step-down; 0 = not tracking. */
  private _drsLowFPSStartTime = 0;
  /** Timestamp (ms) when good FPS was first detected for DRS step-up; 0 = not tracking. */
  private _drsHighFPSStartTime = 0;
  /** Number of DRS ladder steps available for the active system (0 = not supported). */
  private _drsTotalSteps = 0;

  // ── Phase 9: Thermal, startup profiler, FPS prediction ──────────────────────
  /** Thermal/compute pressure monitor — started once and kept alive. */
  private readonly _thermalMonitor: ThermalMonitor = new ThermalMonitor();
  /** Startup profiler for the current launch attempt. */
  private _startupProfiler: StartupProfiler = new StartupProfiler();
  /** FPS sustainability predictor for the first 5 s of gameplay. */
  private _fpsPrediction: FpsPrediction = new FpsPrediction();
  /** Whether onFpsPredictionUnsustainable has already fired for this game launch. */
  private _fpsPredictionFired = false;
  /** Timer ID for the per-game shader warmup window — cleared on teardown. */
  private _shaderWarmupTimerId: ReturnType<typeof setTimeout> | null = null;
  /**
   * The `File` passed to `EJS_gameUrl` after any iOS WebKit materialisation.
   * Exposed so callers (e.g. tier-downgrade relaunch) reuse the same payload.
   */
  private _launchGameFile: File | null = null;

  /** When true, emit detailed debug information to the browser console. */
  verboseLogging = false;

  onStateChange?: (state: EmulatorState) => void;
  onProgress?:    (msg:   string)        => void;
  onError?:       (msg:   string)        => void;
  onGameStart?:   ()                     => void;
  onFPSUpdate?:   (snapshot: FPSSnapshot) => void;
  /**
   * Fired when the FPS monitor detects sustained low performance.
   * Callers can surface this to the user (e.g. suggest switching to
   * Performance mode or a lower tier).
   */
  onLowFPS?:      (averageFPS: number, tier: PerformanceTier | null) => void | Promise<void>;
  /** Fired when an audio underrun is detected via the AudioWorklet processor. */
  onAudioUnderrun?: (count: number) => void;
  /** Fired periodically with the current RMS audio level (0–1) from the worklet. */
  onAudioLevel?: (rms: number) => void;
  /**
   * Fired when JS heap usage exceeds 80 % of the browser-reported limit.
   *
   * This callback is rate-limited to at most once every 30 seconds.
   * Callers can use it to warn the user about potential OOM conditions,
   * suggest restarting the game, or reduce quality settings.
   */
  onMemoryPressure?: (usedMB: number, limitMB: number) => void;
  /**
   * Fired when auto-save is triggered (tab close / visibility hidden).
   * The handler should persist the save state asynchronously.
   */
  onAutoSave?: () => void;
  /**
   * Fired when dynamic resolution scaling changes the internal resolution.
   *
   * The handler receives the option key (e.g. `"ppsspp_internal_resolution"`)
   * and the new value (e.g. `"2"`). The caller should apply this override to
   * the core options — typically by silently relaunching the game at the new
   * setting, or storing it in the per-game graphics profile for the next launch.
   *
   * `stepIdx` is the new step index (0 = native), `direction` is `"down"` when
   * resolution is reduced and `"up"` when it is raised.
   */
  onDRSChange?: (
    optionKey: string,
    optionValue: string,
    stepIdx: number,
    direction: "down" | "up",
  ) => void;

  /**
   * Fired when the FPS prediction window closes with a "not sustainable" result.
   *
   * This fires at most once per game launch (after the first ~5 s of gameplay)
   * when the predictor determines the current tier cannot sustain 60 fps.
   * Callers can use this to proactively offer a tier downgrade.
   *
   * @param averageFps     Mean FPS over the prediction window.
   * @param trendFpsPerS   FPS slope (fps/s). Negative = degrading performance.
   */
  onFpsPredictionUnsustainable?: (averageFps: number, trendFpsPerS: number) => void;

  /**
   * Fired when thermal/compute pressure transitions to a new level.
   *
   * Callers can use this to proactively suggest a tier downgrade when the
   * device is experiencing sustained CPU/thermal pressure ("serious" or "critical").
   *
   * @param state  New thermal pressure state.
   * @param prev   Previous thermal pressure state.
   */
  onThermalPressureChange?: (state: string, prev: string) => void;

  constructor(playerId: string) {
    this._playerId = playerId;
    this._fpsMonitor = new FPSMonitor(60);
    this._memoryMonitor.onPressure = (usedMB, limitMB) => {
      this.logDiagnostic(
        "performance",
        `Memory pressure: ${usedMB} MB used of ${limitMB} MB limit ` +
        `(${Math.round((usedMB / limitMB) * 100)}%)`
      );
      console.warn(
        `[RetroOasis] Memory pressure detected — JS heap at ${usedMB} MB ` +
        `of ${limitMB} MB limit (${Math.round((usedMB / limitMB) * 100)}%). ` +
        "Consider restarting the game or lowering quality settings."
      );
      this.onMemoryPressure?.(usedMB, limitMB);
    };
    this._thermalMonitor.onPressureChange = (state, prev) => {
      this.logDiagnostic("performance", `Thermal pressure: ${prev} → ${state}`);
      if (state === "serious" || state === "critical") {
        console.warn(`[RetroOasis] Thermal pressure elevated: ${state}. Performance may be throttled.`);
      }
      this.onThermalPressureChange?.(state, prev);
    };
    // Start thermal monitoring — it's a no-op when the API is unavailable
    this._thermalMonitor.start().catch(() => {});
  }

  get state(): EmulatorState { return this._state; }
  get currentSystem(): SystemInfo | null { return this._currentSystem; }
  get activeTier(): PerformanceTier | null { return this._activeTier; }
  /**
   * The resolved EJS_Settings object that was applied to the emulator core
   * during the most recent launch. Null when no game has been launched or
   * after the emulator is torn down.
   *
   * Useful for debugging: inspect this to confirm which PPSSPP/RetroArch
   * core options were actually forwarded to the emulator for the current session.
   */
  get activeCoreSettings(): Record<string, string> | null {
    return this._activeCoreSettings ? { ...this._activeCoreSettings } : null;
  }

  /**
   * The WASM package basename used for this session (e.g. `fceumm`, `mednafen_psx_hw`),
   * after `retroarch_core` and CDN path mapping. Mirrors `EJS_paths` / prefetch keys.
   * Null when no game is active.
   */
  get resolvedWasmCoreName(): string | null {
    const sys = this._currentSystem;
    if (!sys) return null;
    return wasmCorePackageNameFor(sys, this._activeCoreSettings ?? {});
  }
  /** True if a WebGPU device was successfully acquired during pre-warm. */
  get webgpuAvailable(): boolean { return this._webgpuDevice !== null; }
  /**
   * Adapter metadata captured during preWarmWebGPU().
   * Returns null if pre-warm has not run, is still in progress, or the adapter
   * did not expose GPUAdapterInfo (browsers prior to Chrome 113).
   */
  get webgpuAdapterInfo(): WebGPUAdapterInfo | null { return this._webgpuAdapterInfo; }
  /** The number of audio underruns detected since the last game launch. */
  get audioUnderruns(): number { return this._audioUnderruns; }
  /** The most recently reported RMS audio level (0–1) from the worklet. */
  get audioLevel(): number { return this._audioLevel; }
  /** The raw GPUDevice, if acquired. Null when WebGPU is unavailable or not yet warmed. */
  get webgpuDevice(): GPUDevice | null { return this._webgpuDevice; }
  /** True if the post-processing pipeline is actively rendering. */
  get postProcessActive(): boolean { return this._postProcessor?.active ?? false; }
  /** Current post-processing configuration. */
  get postProcessConfig(): PostProcessConfig { return { ...this._postProcessConfig }; }
  /** Whether dynamic resolution scaling is enabled. */
  get isDRSEnabled(): boolean { return this._drsEnabled; }
  /** Current DRS step index (0 = native resolution). */
  get drsCurrentStep(): number { return this._drsCurrentStepIdx; }

  /**
   * Compact DRS line for the FPS overlay (for example "DRS 2/4"), or null when
   * DRS is off, the system has no multi-step resolution ladder, or no game is running.
   */
  get drsOverlayHint(): string | null {
    if (!this._drsEnabled || !this._currentSystem?.id || this._drsTotalSteps <= 1) {
      return null;
    }
    return `DRS ${this._drsCurrentStepIdx + 1}/${this._drsTotalSteps}`;
  }

  /** Current thermal pressure state (requires Compute Pressure API). */
  get thermalPressureState(): string { return this._thermalMonitor.state; }
  /** Startup profiler for the most recent launch attempt. */
  get startupProfiler(): StartupProfiler { return this._startupProfiler; }

  /**
   * Get the CoreBridge instance for direct emulator access.
   * Returns null before the emulator is ready (EJS_ready callback fires).
   */
  get bridge(): CoreBridge | null { return this._bridge; }

  /**
   * Enable or disable Dynamic Resolution Scaling (DRS).
   *
   * When enabled, the emulator monitors FPS and fires `onDRSChange` when the
   * resolution should be stepped down (low FPS) or up (recovered FPS).
   * DRS only has effect for systems that have a resolution ladder (PSP, PS1,
   * N64, NDS, Dreamcast). For other systems this is a no-op.
   */
  enableDRS(enabled: boolean): void {
    this._drsEnabled = enabled;
    if (!enabled) {
      this._drsLowFPSStartTime  = 0;
      this._drsHighFPSStartTime = 0;
    }
  }

  /**
   * Diagnostic event log for the debug panel timeline.
   * Returns a shallow copy — safe to iterate without mutations leaking.
   */
  get diagnosticLog(): ReadonlyArray<DiagnosticEvent> { return [...this._diagnosticLog]; }

  /** Get the current FPS snapshot (call anytime while running). */
  getFPS(): FPSSnapshot { return this._fpsMonitor.getSnapshot(); }

  /**
   * The `MemoryMonitor` instance wired to this emulator.
   * Starts automatically when a game launches and stops on teardown.
   * Use this to read `usedHeapMB` / `heapLimitMB` for display in the UI.
   */
  get memoryMonitor(): MemoryMonitor { return this._memoryMonitor; }

  /**
   * Record a diagnostic event.
   * Capped at MAX_DIAGNOSTIC_EVENTS; oldest entries are evicted first.
   */
  logDiagnostic(category: DiagnosticEvent["category"], message: string): void {
    this._diagnosticLog.push({ timestamp: Date.now(), category, message });
    if (this._diagnosticLog.length > MAX_DIAGNOSTIC_EVENTS) {
      this._diagnosticLog.splice(0, this._diagnosticLog.length - MAX_DIAGNOSTIC_EVENTS);
    }
  }

  /** Clear all diagnostic events. */
  clearDiagnosticLog(): void { this._diagnosticLog.length = 0; }

  /**
   * Enable or disable FPS monitoring callbacks.
   *
   * When the FPS overlay is hidden there is no need to notify the UI every
   * 10 frames. Disabling reduces CPU overhead on low-spec devices (Chromebooks)
   * that are already under pressure. The underlying rAF loop keeps running so
   * stats remain accurate if the overlay is toggled back on.
   */
  setFPSMonitorEnabled(enabled: boolean): void {
    this._fpsMonitor.setCallbackEnabled(enabled);
  }

  // ── Preloading ────────────────────────────────────────────────────────────

  /**
   * Inject preconnect and dns-prefetch hints for the EmulatorJS CDN.
   * Call once at startup to reduce latency when a game is launched.
   */
  preconnect(): void {
    if (this._preconnected) return;
    this._preconnected = true;

    const cdnOrigin = new URL(EJS_CDN_BASE).origin;

    // DNS prefetch
    const dns = document.createElement("link");
    dns.rel = "dns-prefetch";
    dns.href = cdnOrigin;
    document.head.appendChild(dns);

    // Preconnect (includes TLS handshake)
    const pc = document.createElement("link");
    pc.rel = "preconnect";
    pc.href = cdnOrigin;
    pc.crossOrigin = "anonymous";
    document.head.appendChild(pc);
  }

  /**
   * Prefetch the EmulatorJS loader script so it's in the browser cache
   * before the user actually launches a game.
   */
  prefetchLoader(): void {
    const loaderUrl = `${EJS_DATA_BASE}loader.js`;
    if (document.querySelector(`link[href="${loaderUrl}"]`)) return;

    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = loaderUrl;
    link.as = "script";
    document.head.appendChild(link);
  }

  /**
   * Prefetch the EmulatorJS core blob for a specific system so it's in the
   * browser cache before launch. Cores ship as compressed `*-wasm.data`
   * archives on the CDN (not raw `.wasm` URLs).
   *
   * Call when the library contains games for that system or on card hover.
   */
  prefetchCore(systemId: string): void {
    if (this._prefetchedCores.has(systemId)) return;
    const relPath = CORE_PREFETCH_MAP[systemId];
    const system = getSystemById(systemId);
    // For systems not in the CDN map (e.g. Flycast/Dreamcast), fall back to the
    // system-level corePath which already contains the absolute bundle URL.
    const fallbackUrl = !relPath ? (system?.corePath ?? null) : null;
    if ((relPath && !system) || (!relPath && !fallbackUrl)) return;

    this._prefetchedCores.add(systemId);

    // Entries starting with "https://" are absolute URLs (e.g. external WASM cores);
    // all others are CDN-relative paths.
    const blobUrl = relPath
      ? (relPath.startsWith("https://") ? relPath : `${cdnBaseForCore(coreNameForSystem(system!, {}))}${relPath}`)
      : fallbackUrl!;

    if (!document.querySelector(`link[href="${blobUrl}"]`)) {
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.href = blobUrl;
      link.setAttribute("as", "fetch");
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
    }
  }

  /**
   * Prefetch the top N most-frequently-launched system cores using the
   * intelligent core preloading system.
   *
   * Call this once at app startup (in an idle callback) to warm the browser's
   * HTTP cache for the systems the user launches most often. This eliminates
   * the 5–15 s core download on subsequent launches.
   *
   * @param n  Maximum number of history-based systems to prefetch (default 2).
   * @param extraHeavy3D  Additional large 3D WASM cores to prefetch when not
   *   already covered (default 2). Set to 0 to only use launch history.
   * @param extraLight2D  Additional small 2D cores (`POPULAR_2D_CORE_PREFETCH_ORDER`
   *   in `performance.ts`). Default 0; startup uses `2` to warm NES/SNES after heavy cores.
   */
  prefetchTopSystems(n = 2, extraHeavy3D = 2, extraLight2D = 0): void {
    const systems = resolveCorePrefetchSystems(n, extraHeavy3D, extraLight2D);
    for (const systemId of systems) {
      this.prefetchCore(systemId);
    }
    if (systems.length > 0 && this.verboseLogging) {
      console.info(`[RetroOasis] Intelligent core preload: prefetching ${systems.join(", ")}`);
    }
  }

  /**
   * Pre-warm the WebGL driver and compile a minimal shader program to
   * eliminate cold-start GPU initialisation overhead on the first game launch.
   *
   * A plain `gl.clear()` call only warms the context creation path.
   * Compiling a vertex + fragment shader and performing a draw call forces
   * the GPU driver to also load its shader compiler and pipeline cache,
   * which is the largest source of first-frame jank on Windows (ANGLE/D3D)
   * and macOS (Metal via WebGL translation layer).
   *
   * If context creation fails, the warmed flag is cleared so a later call can
   * retry (same rationale as `preWarmWebGPU`).
   */
  preWarmWebGL(): void {
    if (this._webglPreWarmed) return;
    this._webglPreWarmed = true;

    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) {
      // Same pattern as preWarmWebGPU: allow retry if GL becomes available later
      // (extension enabled, GPU wakes from sleep, etc.).
      this._webglPreWarmed = false;
      return;
    }

    try {
      // Compile and link a minimal shader program to warm the shader compiler
      const vsSrc = "attribute vec2 p; void main(){ gl_Position=vec4(p,0,1); }";
      const fsSrc = "precision lowp float; void main(){ gl_FragColor=vec4(0); }";

      const vs = gl.createShader(gl.VERTEX_SHADER)!;
      gl.shaderSource(vs, vsSrc);
      gl.compileShader(vs);

      const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
      gl.shaderSource(fs, fsSrc);
      gl.compileShader(fs);

      // Record this shader pair in the cross-session cache
      shaderCache.record(vsSrc, fsSrc).catch(() => {});

      const prog = gl.createProgram()!;
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      gl.useProgram(prog);

      const buf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, 0,1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "p");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.flush();

      // Clean up and release the context — the GPU driver stays warm
      gl.deleteBuffer(buf);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteProgram(prog);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // Pre-warming is best-effort — always release the GL context.
      try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* ignore */ }
    }
  }

  /**
   * Compile a representative set of PSP GPU shader patterns to prime the
   * GPU driver's pipeline cache before the first rendered frame.
   *
   * PPSSPP (the PSP emulator core) generates shaders for each unique
   * combination of PSP GPU state: texture blending, alpha testing, vertex
   * skinning, fog, etc. Pre-compiling representative variants here exercises
   * the same GLSL → driver-binary path that PPSSPP will use, so on Windows
   * (ANGLE/D3D translation) and macOS (Metal translation layer) the driver
   * avoids a cold-compile stall on the first frames of gameplay.
   *
   * If no GL context can be created, the warmed flag is cleared for retry.
   */
  warmUpPSPPipeline(): void {
    if (this._pspPipelineWarmed) return;
    this._pspPipelineWarmed = true;

    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) {
      this._pspPipelineWarmed = false;
      return;
    }

    try {
      // PSP shader variants to pre-compile. Each pair represents a distinct
      // rendering state that PPSSPP commonly hits in the first few frames.
      const shaderVariants: Array<{ vs: string; fs: string; label: string }> = [
        {
          // Textured quad — the most common PSP draw call
          label: "textured-quad",
          vs: [
            "attribute vec2 a_pos;",
            "attribute vec2 a_uv;",
            "uniform mat4 u_mvp;",
            "varying vec2 v_uv;",
            "void main() {",
            "  v_uv = a_uv;",
            "  gl_Position = u_mvp * vec4(a_pos, 0.0, 1.0);",
            "}",
          ].join("\n"),
          fs: [
            "precision mediump float;",
            "varying vec2 v_uv;",
            "uniform sampler2D u_tex;",
            "void main() {",
            "  gl_FragColor = texture2D(u_tex, v_uv);",
            "}",
          ].join("\n"),
        },
        {
          // Textured + vertex colour + alpha blend
          label: "textured-vertex-color",
          vs: [
            "attribute vec3 a_pos;",
            "attribute vec2 a_uv;",
            "attribute vec4 a_color;",
            "uniform mat4 u_mvp;",
            "varying vec2 v_uv;",
            "varying vec4 v_color;",
            "void main() {",
            "  v_uv = a_uv;",
            "  v_color = a_color;",
            "  gl_Position = u_mvp * vec4(a_pos, 1.0);",
            "}",
          ].join("\n"),
          fs: [
            "precision mediump float;",
            "varying vec2 v_uv;",
            "varying vec4 v_color;",
            "uniform sampler2D u_tex;",
            "void main() {",
            "  vec4 t = texture2D(u_tex, v_uv);",
            "  gl_FragColor = t * v_color;",
            "}",
          ].join("\n"),
        },
        {
          // Flat-shaded primitive (UI elements, 2D sprites)
          label: "flat-color",
          vs: [
            "attribute vec3 a_pos;",
            "uniform mat4 u_mvp;",
            "uniform vec4 u_color;",
            "varying vec4 v_color;",
            "void main() {",
            "  v_color = u_color;",
            "  gl_Position = u_mvp * vec4(a_pos, 1.0);",
            "}",
          ].join("\n"),
          fs: [
            "precision mediump float;",
            "varying vec4 v_color;",
            "void main() {",
            "  gl_FragColor = v_color;",
            "}",
          ].join("\n"),
        },
        {
          // Fog + texture (3D scenes with atmospheric fog)
          label: "textured-fog",
          vs: [
            "attribute vec3 a_pos;",
            "attribute vec2 a_uv;",
            "uniform mat4 u_mvp;",
            "varying vec2 v_uv;",
            "varying float v_fog;",
            "uniform float u_fog_near;",
            "uniform float u_fog_far;",
            "void main() {",
            "  vec4 pos = u_mvp * vec4(a_pos, 1.0);",
            "  v_uv = a_uv;",
            "  float depth = clamp((pos.z - u_fog_near) / (u_fog_far - u_fog_near), 0.0, 1.0);",
            "  v_fog = depth;",
            "  gl_Position = pos;",
            "}",
          ].join("\n"),
          fs: [
            "precision mediump float;",
            "varying vec2 v_uv;",
            "varying float v_fog;",
            "uniform sampler2D u_tex;",
            "uniform vec4 u_fog_color;",
            "void main() {",
            "  vec4 t = texture2D(u_tex, v_uv);",
            "  gl_FragColor = mix(t, u_fog_color, v_fog);",
            "}",
          ].join("\n"),
        },
        {
          // Alpha test — discard fragments below threshold (used by many PSP effects)
          label: "alpha-test",
          vs: [
            "attribute vec3 a_pos;",
            "attribute vec2 a_uv;",
            "uniform mat4 u_mvp;",
            "varying vec2 v_uv;",
            "void main() {",
            "  v_uv = a_uv;",
            "  gl_Position = u_mvp * vec4(a_pos, 1.0);",
            "}",
          ].join("\n"),
          fs: [
            "precision mediump float;",
            "varying vec2 v_uv;",
            "uniform sampler2D u_tex;",
            "uniform float u_alpha_ref;",
            "void main() {",
            "  vec4 c = texture2D(u_tex, v_uv);",
            "  if (c.a < u_alpha_ref) discard;",
            "  gl_FragColor = c;",
            "}",
          ].join("\n"),
        },
        {
          // Vertex skinning (bone transforms) — used by virtually every PSP 3D character
          // and animated object. Pre-compiling this variant eliminates the cold-compile
          // stall that occurs on the first frame a skinned mesh is rendered, which is
          // the largest single source of first-frame jank in 3D PSP titles.
          label: "skinned-textured",
          vs: [
            "attribute vec3 a_pos;",
            "attribute vec2 a_uv;",
            "attribute vec4 a_weights;",
            "attribute vec4 a_indices;",
            "uniform mat4 u_bones[8];",
            "uniform mat4 u_mvp;",
            "varying vec2 v_uv;",
            "void main() {",
            "  mat4 skin = u_bones[int(a_indices.x)] * a_weights.x",
            "            + u_bones[int(a_indices.y)] * a_weights.y",
            "            + u_bones[int(a_indices.z)] * a_weights.z",
            "            + u_bones[int(a_indices.w)] * a_weights.w;",
            "  v_uv = a_uv;",
            "  gl_Position = u_mvp * skin * vec4(a_pos, 1.0);",
            "}",
          ].join("\n"),
          fs: [
            "precision mediump float;",
            "varying vec2 v_uv;",
            "uniform sampler2D u_tex;",
            "void main() {",
            "  gl_FragColor = texture2D(u_tex, v_uv);",
            "}",
          ].join("\n"),
        },
        {
          // Depth pre-pass (z-prepass) — used by PSP games with real-time shadows,
          // scene-depth queries, and ambient-occlusion approximations.
          // Pre-compiling this vertex-only pattern eliminates the cold-compile stall
          // that fires when the first depth-only geometry is submitted, which can
          // otherwise cause a visible hitch at the start of shadow-lit 3D levels.
          label: "depth-prepass",
          vs: [
            "attribute vec3 a_pos;",
            "uniform mat4 u_mvp;",
            "void main() {",
            "  gl_Position = u_mvp * vec4(a_pos, 1.0);",
            "}",
          ].join("\n"),
          fs: [
            "precision mediump float;",
            "void main() {",
            "  // depth-only pass: colour output is discarded by the colour mask",
            "  gl_FragColor = vec4(0.0);",
            "}",
          ].join("\n"),
        },
      ];

      for (const { vs: vsSrc, fs: fsSrc } of shaderVariants) {
        const vs = gl.createShader(gl.VERTEX_SHADER);
        if (!vs) continue;
        gl.shaderSource(vs, vsSrc);
        gl.compileShader(vs);

        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        if (!fs) { gl.deleteShader(vs); continue; }
        gl.shaderSource(fs, fsSrc);
        gl.compileShader(fs);

        const prog = gl.createProgram();
        if (!prog) { gl.deleteShader(vs); gl.deleteShader(fs); continue; }
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        gl.useProgram(prog);

        // Also record each variant in the shader cache for future pre-warm runs
        shaderCache.record(vsSrc, fsSrc).catch(() => {});

        gl.deleteShader(vs);
        gl.deleteShader(fs);
        gl.deleteProgram(prog);
      }

      gl.flush();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // Pipeline warm-up is best-effort — always release the GL context.
      try { gl?.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* ignore */ }
    }
  }

  warmUp2DPipeline(): void {
    if (this._2dPipelineWarmed) return;
    this._2dPipelineWarmed = true;

    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    let gl: WebGLRenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl");
      if (!gl) return;

      const vsSrc = `
        attribute vec2 a_pos;
        attribute vec2 a_uv;
        varying vec2 v_uv;
        void main() { v_uv = a_uv; gl_Position = vec4(a_pos, 0.0, 1.0); }
      `;

      const shaders: { vs: string; fs: string }[] = [
        {
          vs: vsSrc,
          fs: `precision mediump float;
               varying vec2 v_uv;
               uniform sampler2D u_tex;
               void main() { gl_FragColor = texture2D(u_tex, v_uv); }`,
        },
        {
          vs: vsSrc,
          fs: `precision mediump float;
               varying vec2 v_uv;
               uniform sampler2D u_tex;
               uniform float u_alpha;
               void main() { vec4 c = texture2D(u_tex, v_uv); gl_FragColor = vec4(c.rgb, c.a * u_alpha); }`,
        },
        {
          vs: vsSrc,
          fs: `precision mediump float;
               uniform vec4 u_color;
               void main() { gl_FragColor = u_color; }`,
        },
      ];

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 0, 0,
         1, -1, 1, 0,
        -1,  1, 0, 1,
         1,  1, 1, 1,
      ]), gl.STATIC_DRAW);

      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([255, 255, 255, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

      for (const { vs: vsSrc2, fs: fsSrc } of shaders) {
        const vs = gl.createShader(gl.VERTEX_SHADER);
        if (!vs) continue;
        gl.shaderSource(vs, vsSrc2);
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) { gl.deleteShader(vs); continue; }

        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        if (!fs) { gl.deleteShader(vs); continue; }
        gl.shaderSource(fs, fsSrc);
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) { gl.deleteShader(vs); gl.deleteShader(fs); continue; }

        const prog = gl.createProgram();
        if (!prog) { gl.deleteShader(vs); gl.deleteShader(fs); continue; }
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
          gl.deleteProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs); continue;
        }

        gl.useProgram(prog);
        const STRIDE = 4 * Float32Array.BYTES_PER_ELEMENT;
        const aPos = gl.getAttribLocation(prog, "a_pos");
        const aUV = gl.getAttribLocation(prog, "a_uv");
        if (aPos >= 0) {
          gl.enableVertexAttribArray(aPos);
          gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, STRIDE, 0);
        }
        if (aUV >= 0) {
          gl.enableVertexAttribArray(aUV);
          gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, STRIDE, 2 * Float32Array.BYTES_PER_ELEMENT);
        }

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        shaderCache.record(vsSrc2, fsSrc).catch(() => {});
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        gl.deleteProgram(prog);
      }

      gl.deleteTexture(tex);
      gl.deleteBuffer(buf);
      gl.flush();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      try { gl?.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* ignore */ }
    }
  }

  /**
   * GPU driver's pipeline cache before the first rendered Dreamcast frame.
   *
   * Flycast generates WebGL 2 shaders for each unique combination of PowerVR
   * rendering state: modifier volumes, palette-based texturing, alpha sorting
   * modes, fog, and depth-complexity handling. Pre-compiling representative
   * variants here exercises the same GLSL ES 3.00 → driver-binary path that
   * Flycast will use, so on Windows (ANGLE/D3D) and macOS (Metal) the driver
   * avoids a cold-compile stall on the first frames of Dreamcast gameplay.
   *
   * Unlike PSP warm-up, this method specifically requires WebGL 2 (GLSL ES 3.00)
   * because Flycast relies on features not available in WebGL 1 (multiple render
   * targets, integer textures, etc.). If `webgl2` is unavailable, the warmed
   * flag is cleared so a later call can retry.
   */
  warmUpDreamcastPipeline(): void {
    if (this._dcPipelineWarmed) return;
    this._dcPipelineWarmed = true;

    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const gl = canvas.getContext("webgl2");
    if (!gl) {
      this._dcPipelineWarmed = false;
      return;
    }

    try {
      const shaderVariants: Array<{ vs: string; fs: string; label: string }> = [
        {
          label: "dc-textured-quad",
          vs: [
            "#version 300 es",
            "layout(location=0) in vec2 a_pos;",
            "layout(location=1) in vec2 a_uv;",
            "uniform mat4 u_mvp;",
            "out vec2 v_uv;",
            "void main() {",
            "  v_uv = a_uv;",
            "  gl_Position = u_mvp * vec4(a_pos, 0.0, 1.0);",
            "}",
          ].join("\n"),
          fs: [
            "#version 300 es",
            "precision mediump float;",
            "in vec2 v_uv;",
            "uniform sampler2D u_tex;",
            "layout(location=0) out vec4 fragColor;",
            "void main() {",
            "  fragColor = texture(u_tex, v_uv);",
            "}",
          ].join("\n"),
        },
        {
          label: "dc-textured-alpha",
          vs: [
            "#version 300 es",
            "layout(location=0) in vec3 a_pos;",
            "layout(location=1) in vec2 a_uv;",
            "layout(location=2) in vec4 a_color;",
            "uniform mat4 u_mvp;",
            "out vec2 v_uv;",
            "out vec4 v_color;",
            "void main() {",
            "  v_uv = a_uv;",
            "  v_color = a_color;",
            "  gl_Position = u_mvp * vec4(a_pos, 1.0);",
            "}",
          ].join("\n"),
          fs: [
            "#version 300 es",
            "precision mediump float;",
            "in vec2 v_uv;",
            "in vec4 v_color;",
            "uniform sampler2D u_tex;",
            "layout(location=0) out vec4 fragColor;",
            "void main() {",
            "  vec4 t = texture(u_tex, v_uv);",
            "  fragColor = t * v_color;",
            "}",
          ].join("\n"),
        },
        {
          label: "dc-modifier-volume",
          vs: [
            "#version 300 es",
            "layout(location=0) in vec3 a_pos;",
            "uniform mat4 u_mvp;",
            "void main() {",
            "  gl_Position = u_mvp * vec4(a_pos, 1.0);",
            "}",
          ].join("\n"),
          fs: [
            "#version 300 es",
            "precision mediump float;",
            "uniform vec4 u_color;",
            "layout(location=0) out vec4 fragColor;",
            "void main() {",
            "  fragColor = u_color;",
            "}",
          ].join("\n"),
        },
        {
          label: "dc-textured-fog",
          vs: [
            "#version 300 es",
            "layout(location=0) in vec3 a_pos;",
            "layout(location=1) in vec2 a_uv;",
            "uniform mat4 u_mvp;",
            "uniform float u_fog_near;",
            "uniform float u_fog_far;",
            "out vec2 v_uv;",
            "out float v_fog;",
            "void main() {",
            "  vec4 pos = u_mvp * vec4(a_pos, 1.0);",
            "  v_uv = a_uv;",
            "  float depth = clamp((pos.z - u_fog_near) / (u_fog_far - u_fog_near), 0.0, 1.0);",
            "  v_fog = depth;",
            "  gl_Position = pos;",
            "}",
          ].join("\n"),
          fs: [
            "#version 300 es",
            "precision mediump float;",
            "in vec2 v_uv;",
            "in float v_fog;",
            "uniform sampler2D u_tex;",
            "uniform vec4 u_fog_color;",
            "layout(location=0) out vec4 fragColor;",
            "void main() {",
            "  vec4 t = texture(u_tex, v_uv);",
            "  fragColor = mix(t, u_fog_color, v_fog);",
            "}",
          ].join("\n"),
        },
        {
          label: "dc-alpha-test",
          vs: [
            "#version 300 es",
            "layout(location=0) in vec3 a_pos;",
            "layout(location=1) in vec2 a_uv;",
            "uniform mat4 u_mvp;",
            "out vec2 v_uv;",
            "void main() {",
            "  v_uv = a_uv;",
            "  gl_Position = u_mvp * vec4(a_pos, 1.0);",
            "}",
          ].join("\n"),
          fs: [
            "#version 300 es",
            "precision mediump float;",
            "in vec2 v_uv;",
            "uniform sampler2D u_tex;",
            "uniform float u_alpha_threshold;",
            "layout(location=0) out vec4 fragColor;",
            "void main() {",
            "  vec4 t = texture(u_tex, v_uv);",
            "  if (t.a < u_alpha_threshold) discard;",
            "  fragColor = t;",
            "}",
          ].join("\n"),
        },
        {
          label: "dc-palette-texture",
          vs: [
            "#version 300 es",
            "layout(location=0) in vec2 a_pos;",
            "layout(location=1) in vec2 a_uv;",
            "uniform mat4 u_mvp;",
            "out vec2 v_uv;",
            "void main() {",
            "  v_uv = a_uv;",
            "  gl_Position = u_mvp * vec4(a_pos, 0.0, 1.0);",
            "}",
          ].join("\n"),
          fs: [
            "#version 300 es",
            "precision mediump float;",
            "in vec2 v_uv;",
            "uniform sampler2D u_tex;",
            "uniform sampler2D u_palette;",
            "uniform int u_palette_index;",
            "layout(location=0) out vec4 fragColor;",
            "void main() {",
            "  float idx = texture(u_tex, v_uv).r;",
            "  vec2 palUv = vec2(idx, float(u_palette_index) / 4.0);",
            "  fragColor = texture(u_palette, palUv);",
            "}",
          ].join("\n"),
        },
        {
          label: "dc-flat-shaded",
          vs: [
            "#version 300 es",
            "layout(location=0) in vec3 a_pos;",
            "uniform mat4 u_mvp;",
            "uniform vec4 u_color;",
            "out vec4 v_color;",
            "void main() {",
            "  v_color = u_color;",
            "  gl_Position = u_mvp * vec4(a_pos, 1.0);",
            "}",
          ].join("\n"),
          fs: [
            "#version 300 es",
            "precision mediump float;",
            "in vec4 v_color;",
            "layout(location=0) out vec4 fragColor;",
            "void main() {",
            "  fragColor = v_color;",
            "}",
          ].join("\n"),
        },
      ];

      for (const { vs: vsSrc, fs: fsSrc } of shaderVariants) {
        const vs = gl.createShader(gl.VERTEX_SHADER);
        if (!vs) continue;
        gl.shaderSource(vs, vsSrc);
        gl.compileShader(vs);

        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        if (!fs) { gl.deleteShader(vs); continue; }
        gl.shaderSource(fs, fsSrc);
        gl.compileShader(fs);

        const prog = gl.createProgram();
        if (!prog) { gl.deleteShader(vs); gl.deleteShader(fs); continue; }
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        gl.useProgram(prog);

        shaderCache.record(vsSrc, fsSrc).catch(() => {});

        gl.deleteShader(vs);
        gl.deleteShader(fs);
        gl.deleteProgram(prog);
      }

      gl.flush();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      try { gl?.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* ignore */ }
    }
  }

  /**
   * Initialise a WebGPU adapter and device as an opt-in rendering path.
   *
   * Chrome 113+ exposes `navigator.gpu`. Acquiring a device here proves the
   * WebGPU stack is functional and warms up the browser's GPU process
   * connection, reducing the latency of the first WebGPU command on devices
   * where EmulatorJS eventually ships native WebGPU core support.
   *
   * Beyond the basic device acquisition this method also:
   *   - Captures GPUAdapterInfo (vendor, architecture, device name) for display
   *     in the Settings panel.
   *   - Pre-compiles a minimal WGSL render pipeline to warm the GPU shader
   *     compiler, reducing first-frame stalls when a WebGPU rendering path
   *     is eventually activated.
   *   - Submits a trivial compute pass to flush the GPU command queue.
   *
   * The acquired GPUDevice is held for the lifetime of the emulator instance
   * so it remains ready without repeated initialisation.
   *
   * @param powerPreference  "high-performance" (default) selects the discrete
   *   GPU on multi-GPU systems. Pass "low-power" on low-spec or low-battery
   *   devices to prefer the integrated GPU and conserve energy.
   */
  async preWarmWebGPU(
    powerPreference: "high-performance" | "low-power" = "high-performance"
  ): Promise<void> {
    if (this._webgpuPreWarmed) return;
    this._webgpuPreWarmed = true;

    try {
      const gpu = navigator.gpu;
      if (!gpu) {
        // Must reset — otherwise a later navigator.gpu polyfill / permission grant
        // could never retry pre-warm (flag stayed true with no device).
        this._webgpuPreWarmed = false;
        return;
      }

      const adapter = await gpu.requestAdapter({
        powerPreference,
      });
      if (!adapter) {
        this._webgpuPreWarmed = false;
        return;
      }

      // Capture adapter metadata (GPUAdapterInfo — Chrome 113+).
      if (adapter.info) {
        const adapterAny = adapter as GPUAdapter & { isFallbackAdapter?: boolean };
        this._webgpuAdapterInfo = {
          vendor:            adapter.info.vendor,
          architecture:      adapter.info.architecture,
          device:            adapter.info.device,
          description:       adapter.info.description,
          isFallbackAdapter: adapterAny.isFallbackAdapter ?? false,
        };
      }

      const requiredFeatures: GPUFeatureName[] = [];
      if (adapter.features?.has("timestamp-query")) {
        requiredFeatures.push("timestamp-query");
      }
      const device = await adapter.requestDevice(
        requiredFeatures.length > 0 ? { requiredFeatures } : undefined
      );
      this._webgpuDevice = device;

      // Pre-compile a minimal WGSL render pipeline to warm the GPU shader
      // compiler. This exercises the same WGSL → driver-native-binary path
      // that future WebGPU rendering will use, so the compiler's lazy
      // initialisation overhead is paid now rather than on the first game frame.
      try {
        const wgslModule = device.createShaderModule({
          code: [
            "@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {",
            "  var p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));",
            "  return vec4f(p[i], 0.0, 1.0);",
            "}",
            "@fragment fn fs() -> @location(0) vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }",
          ].join("\n"),
        });
        device.createRenderPipeline({
          layout:    "auto",
          vertex:    { module: wgslModule, entryPoint: "vs" },
          fragment:  { module: wgslModule, entryPoint: "fs", targets: [{ format: "bgra8unorm" }] },
          primitive: { topology: "triangle-list" },
        });
      } catch {
        // WGSL pipeline compilation is best-effort — the device is still
        // acquired and the queue submit below still warms the GPU process path.
      }

      // Valid empty command buffer — warms submission without relying on an
      // empty compute pass (some validation layers reject passes with no work).
      device.queue.submit([device.createCommandEncoder().finish()]);

      // Pre-compile post-process pipelines in small batches to avoid spiking
      // memory and shader-compiler contention when all effects kick off at once.
      try {
        const presentFormat = navigator.gpu.getPreferredCanvasFormat();
        const effects = POST_PROCESS_PIPELINE_WARMUP_EFFECTS;
        const batch = POST_PROCESS_WARMUP_BATCH_SIZE;
        for (let i = 0; i < effects.length; i += batch) {
          const slice = effects.slice(i, i + batch);
          await Promise.all(
            slice.map((effect) =>
              buildEffectPipeline(device, effect, presentFormat).catch(() => {}),
            ),
          );
        }
        await shaderCache.preCompileWGSL(device);
      } catch {
        // Post-process pipeline pre-compilation is best-effort
      }

      if (this.verboseLogging) {
        const adapterLabel =
          this._webgpuAdapterInfo?.device  ||
          this._webgpuAdapterInfo?.vendor  ||
          "unknown adapter";
        console.info(
          `[RetroOasis] WebGPU device acquired (${adapterLabel}) — ` +
          "GPU command queue and shader compiler warmed."
        );
      }
    } catch {
      // WebGPU unavailable or not yet supported — silently fall back to WebGL
      this._webgpuPreWarmed = false;
      this._webgpuDevice = null;
      this._webgpuAdapterInfo = null;
    }
  }

  /**
   * Set up an AudioWorkletNode for low-latency audio processing.
   *
   * The AudioWorklet runs in a dedicated thread separate from the main JS
   * thread, eliminating the latency added by ScriptProcessorNode's main-
   * thread scheduling. This reduces audio output latency by 1–2 render
   * quanta (~5–10 ms on 128-sample buffer devices).
   *
   * If the game's AudioContext is accessible via EJS_emulator.Module.AL,
   * we insert the worklet node between the AL source gain nodes and the
   * context destination. Otherwise we attach it to a standalone context
   * for monitoring purposes only.
   *
   * After setup the audio graph is:
   *   AL sources → workletNode (gain + metering) → analyserNode → destination
   *
   * @param workletBaseUrl  Fallback base URL for resolving `audio-processor.js`
   *                        when `window.location` is unavailable (tests).
   */
  async setupAudioWorklet(workletBaseUrl: string): Promise<boolean> {
    // Always clear first — cheap when idle, and guarantees no duplicate graphs
    // when this runs again after a failed attempt or a prior session.
    this._disconnectAudioWorklet();

    if (!("AudioWorkletNode" in window)) return false;

    // Hoist ctx/ctxOwned so the catch block can close a self-created context,
    // preventing AudioContext quota exhaustion (browsers cap at ~6 contexts).
    let ctx: AudioContext | undefined;
    let ctxOwned = false;

    try {
      // Prefer the game's OpenAL context so we're in the same audio graph
      const ejsCtx = window.EJS_emulator?.Module?.AL?.currentCtx?.audioCtx;
      const AudioContextCtor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return false;
      ctx = ejsCtx ?? new AudioContextCtor({ latencyHint: "interactive" });
      ctxOwned = !ejsCtx;

      // Resume a suspended context (may happen due to autoplay policy)
      if (ctx.state === "suspended") {
        await ctx.resume().catch(() => { /* best-effort */ });
      }

      const processorUrl =
        typeof window !== "undefined" && window.location?.href
          ? new URL("audio-processor.js", window.location.href).href
          : new URL("audio-processor.js", workletBaseUrl).href;
      await ctx.audioWorklet.addModule(processorUrl);

      const workletNode = new AudioWorkletNode(ctx, "retro-oasis-audio-processor");

      workletNode.port.onmessage = (e: MessageEvent<{ type: string; count: number; rms: number }>) =>
        this._onAudioWorkletMessage(e);

      // AnalyserNode sits after the worklet so the UI can visualise post-gain output
      const analyserNode = ctx.createAnalyser();
      analyserNode.fftSize = 256;
      analyserNode.smoothingTimeConstant = 0.75;

      if (ejsCtx) {
        // Connect worklet into the EJS audio graph
        const alCtx = window.EJS_emulator?.Module?.AL?.currentCtx;
        if (alCtx?.sources) {
          const gainNodes = Object.values(alCtx.sources).map(s => s.gain);
          gainNodes.forEach(g => {
            // Disconnect from the original destination to prevent the audio
            // signal from reaching ctx.destination through two paths (which
            // would double the volume). Ignore errors for nodes not yet
            // connected to the destination.
            try { (g as AudioNode).disconnect(ctx!.destination); } catch { /* not connected */ }
            g.connect(workletNode);
          });
        }
      }
      workletNode.connect(analyserNode);
      analyserNode.connect(ctx.destination);

      this._audioWorkletCtx  = ctx;
      this._audioWorkletCtxOwned = ctxOwned;
      this._audioWorkletNode = workletNode;
      this._audioAnalyserNode = analyserNode;

      if (this.verboseLogging) {
        console.info("[RetroOasis] AudioWorklet path active — reduced-latency audio enabled.");
      }
      return true;
    } catch {
      // AudioWorklet unavailable or module failed to load — fall back silently.
      // If we created the AudioContext ourselves, close it to avoid exhausting
      // the browser's AudioContext quota (typically capped at 6 contexts).
      if (ctxOwned && ctx) {
        ctx.close().catch(() => { /* best-effort */ });
      }
      return false;
    }
  }

  /**
   * Get the AudioContext used by the AudioWorklet (for AnalyserNode attachment).
   * Returns null if the worklet hasn't been set up or is unavailable.
   */
  getAudioContext(): AudioContext | null {
    return this._audioWorkletCtx;
  }

  /**
   * Get the AnalyserNode wired after the AudioWorklet output.
   * Use this to build frequency-domain or time-domain visualisers without
   * duplicating the audio graph wiring.
   * Returns null if the worklet hasn't been set up.
   */
  getAnalyserNode(): AnalyserNode | null {
    return this._audioAnalyserNode;
  }

  /**
   * Apply an audio enhancement filter to the audio output chain.
   *
   * Inserts a `BiquadFilterNode` between the AudioWorklet node (or source)
   * and the AnalyserNode/destination.  Calling this method while the worklet
   * is already running updates the filter parameters in real time without
   * restarting the audio graph.
   *
   * @param type      Web Audio BiquadFilter type.  Use `"lowpass"` to reduce
   *                  high-frequency "crunch" artefacts common in PSP/N64 audio,
   *                  `"highpass"` to roll off low-frequency rumble, or `"none"`
   *                  to remove any existing filter.
   * @param cutoffHz  Filter cutoff frequency in Hz (20–20 000).  Ignored when
   *                  type is `"none"`.  Typical values: 8 000–12 000 Hz for a
   *                  gentle lowpass that tames harshness without muddying.
   * @param resonance Optional Q factor (0.001–30).  Defaults to 0.707 (Butterworth
   *                  — maximally flat passband, no resonant peak).
   *
   * @returns `true` if the filter was applied successfully, `false` if the
   *          AudioContext is not available (worklet not yet set up).
   */
  setAudioFilter(
    type: "lowpass" | "highpass" | "bandpass" | "notch" | "none",
    cutoffHz: number,
    resonance = 0.707,
  ): boolean {
    const ctx = this._audioWorkletCtx;
    if (!ctx) return false;

    if (type === "none") {
      this._removeAudioFilter();
      return true;
    }

    const clampedCutoff = Math.max(20, Math.min(20_000, cutoffHz));
    const clampedQ     = Math.max(0.001, Math.min(30, resonance));

    if (this._audioFilterNode) {
      // Update in place — no reconnection needed for parameter changes.
      this._audioFilterNode.type      = type;
      this._audioFilterNode.frequency.setValueAtTime(clampedCutoff, ctx.currentTime);
      this._audioFilterNode.Q.setValueAtTime(clampedQ, ctx.currentTime);
      return true;
    }

    // Create and wire: workletNode → filterNode → analyserNode → destination
    const filter = ctx.createBiquadFilter();
    filter.type  = type;
    filter.frequency.setValueAtTime(clampedCutoff, ctx.currentTime);
    filter.Q.setValueAtTime(clampedQ, ctx.currentTime);

    try {
      if (this._audioWorkletNode && this._audioAnalyserNode) {
        this._audioWorkletNode.disconnect(this._audioAnalyserNode);
        this._audioWorkletNode.connect(filter);
        filter.connect(this._audioAnalyserNode);
      }
      this._audioFilterNode = filter;
    } catch {
      // Reconnection failed (e.g. nodes not connected yet) — discard safely.
      try { filter.disconnect(); } catch { /* ignore */ }
    }

    return true;
  }

  /**
   * Remove the audio enhancement filter previously applied via `setAudioFilter()`.
   * Reconnects the AudioWorklet node directly to the AnalyserNode.
   * No-op if no filter is currently active.
   */
  removeAudioFilter(): void {
    this._removeAudioFilter();
  }

  /** @internal */
  private _removeAudioFilter(): void {
    if (!this._audioFilterNode) return;

    try {
      if (this._audioWorkletNode && this._audioAnalyserNode) {
        this._audioWorkletNode.disconnect(this._audioFilterNode);
        this._audioFilterNode.disconnect(this._audioAnalyserNode);
        this._audioWorkletNode.connect(this._audioAnalyserNode);
      }
    } catch { /* ignore disconnection errors — graph may already be torn down */ }

    this._audioFilterNode = null;
  }

  /**
   * Pre-compile shader programs cached from previous sessions.
   * Call during startup in an idle callback — runs asynchronously.
   */
  async preWarmShaderCache(): Promise<void> {
    await shaderCache.preCompile();
  }

  /**
   * Fold WebGL/WebGPU capability data back into the heavy 3D cores.
   *
   * PSP, DS, N64, PS1, Saturn, Dreamcast, and future PS2 cores are sensitive to
   * texture size, framebuffer features, CPU thread pressure, and software
   * rasterizers. Tier settings express desired quality; this pass clamps them
   * to what the current browser GPU path can sustain.
   */
  private _applyHeavyCoreGpuOverrides(
    systemId: string,
    tier: PerformanceTier,
    caps: DeviceCapabilities,
    ejsSettings: Record<string, string>,
  ): void {
    if (
      systemId !== "psp" &&
      systemId !== "nds" &&
      systemId !== "n64" &&
      systemId !== "psx" &&
      systemId !== "segaSaturn" &&
      systemId !== "segaDC" &&
      systemId !== "ps2"
    ) return;

    const chromebookMediumHeavy3D =
      caps.isChromOS &&
      tier === "medium" &&
      (systemId === "psp" || systemId === "psx" || systemId === "n64" || systemId === "nds");

    const gpu = caps.gpuCaps;
    const weakWebGL =
      caps.isSoftwareGPU ||
      gpu.maxTextureSize < 4096 ||
      caps.estimatedVRAMMB < 256 ||
      caps.gpuBenchmarkScore < 35;
    const constrainedMemory = caps.isMobile || (caps.deviceMemoryGB !== null && caps.deviceMemoryGB <= 4);

    if (systemId === "psp") {
      let maxResIdx = tier === "ultra" ? 2 : tier === "high" ? 1 : 0;
      if (gpu.maxTextureSize < 8192 || caps.estimatedVRAMMB < 384 || constrainedMemory) {
        maxResIdx = Math.min(maxResIdx, 1);
      }
      if (weakWebGL) maxResIdx = 0;

      const previousRes = ejsSettings["ppsspp_internal_resolution"];
      const nextRes = clampLadderValue(previousRes, PSP_RESOLUTION_STEPS, maxResIdx);
      ejsSettings["ppsspp_internal_resolution"] = nextRes;

      if (!gpu.anisotropicFiltering || gpu.maxAnisotropy <= 1) {
        ejsSettings["ppsspp_gpu_anisotropic_filtering"] = "off";
      } else {
        const requested = parseAnisotropicValue(ejsSettings["ppsspp_gpu_anisotropic_filtering"]);
        const capped = Math.min(requested, Math.max(0, gpu.maxAnisotropy));
        ejsSettings["ppsspp_gpu_anisotropic_filtering"] = formatAnisotropicValue(capped);
      }

      if (weakWebGL || chromebookMediumHeavy3D) {
        Object.assign(ejsSettings, {
          ppsspp_auto_frameskip: "enabled",
          ppsspp_frameskip: ejsSettings["ppsspp_frameskip"] === "3" ? "3" : "2",
          ppsspp_texture_scaling_level: "1",
          ppsspp_texture_deposterize: "disabled",
          ppsspp_lower_resolution_for_effects: "2",
          ppsspp_lazy_texture_caching: "enabled",
          ppsspp_retain_changed_textures: "disabled",
          ppsspp_inflight_frames: "1",
          ppsspp_force_max_fps: "30",
        });
      } else if (constrainedMemory) {
        ejsSettings["ppsspp_texture_scaling_level"] = "1";
        ejsSettings["ppsspp_lazy_texture_caching"] = "enabled";
      }

      if (previousRes !== nextRes || weakWebGL || chromebookMediumHeavy3D) {
        this.logDiagnostic(
          "performance",
          `PSP WebGL clamp: res ${previousRes ?? "?"}->${nextRes}, ` +
          `webgl2=${gpu.webgl2}, maxTex=${gpu.maxTextureSize}, vram~${caps.estimatedVRAMMB}MB`
        );
      }
      return;
    }

    if (systemId === "nds") {
      let maxNdsResIdx = tier === "ultra" ? 3 : tier === "high" ? 1 : 0;
      if (gpu.maxTextureSize < 4096 || caps.estimatedVRAMMB < 256 || constrainedMemory) {
        maxNdsResIdx = Math.min(maxNdsResIdx, 1);
      }
      if (!gpu.webgl2 || weakWebGL || chromebookMediumHeavy3D) {
        maxNdsResIdx = 0;
        Object.assign(ejsSettings, {
          desmume_opengl_mode: "disabled",
          desmume_color_depth: "16-bit",
          desmume_gfx_edgemark: "disabled",
          desmume_gfx_linehack: "enabled",
          desmume_filtering: "none",
        });
        const currentFrameskip = parseInt(ejsSettings["desmume_frameskip"] ?? "0", 10);
        ejsSettings["desmume_frameskip"] = String(Math.max(Number.isFinite(currentFrameskip) ? currentFrameskip : 0, 1));
      }

      const previousNdsRes = ejsSettings["desmume_internal_resolution"];
      const nextNdsRes = clampLadderValue(previousNdsRes, NDS_RESOLUTION_STEPS, maxNdsResIdx);
      ejsSettings["desmume_internal_resolution"] = nextNdsRes;

      if (previousNdsRes !== nextNdsRes || !gpu.webgl2 || weakWebGL || chromebookMediumHeavy3D) {
        this.logDiagnostic(
          "performance",
          `NDS WebGL clamp: res ${previousNdsRes ?? "?"}->${nextNdsRes}, ` +
          `opengl=${ejsSettings["desmume_opengl_mode"] ?? "?"}, webgl2=${gpu.webgl2}, ` +
          `maxTex=${gpu.maxTextureSize}, vram~${caps.estimatedVRAMMB}MB`
        );
      }
      return;
    }

    if (systemId === "n64") {
      let maxN64ResIdx = tier === "ultra" ? 2 : tier === "high" ? 1 : 0;
      if (gpu.maxTextureSize < 8192 || caps.estimatedVRAMMB < 384 || constrainedMemory) {
        maxN64ResIdx = Math.min(maxN64ResIdx, 1);
      }
      if (weakWebGL) maxN64ResIdx = 0;

      const previousRes = ejsSettings["mupen64plus-resolution-factor"];
      const nextRes = clampLadderValue(previousRes, N64_RESOLUTION_STEPS, maxN64ResIdx);
      ejsSettings["mupen64plus-resolution-factor"] = nextRes;

      if (weakWebGL || chromebookMediumHeavy3D) {
        Object.assign(ejsSettings, {
          "mupen64plus-rdp-plugin": "rice",
          "mupen64plus-EnableFBEmulation": "False",
          "mupen64plus-EnableCopyColorToRDRAM": "Off",
          "mupen64plus-EnableCopyDepthToRDRAM": "Off",
          "mupen64plus-EnableCopyColorFromRDRAM": "False",
          "mupen64plus-EnableLOD": "False",
          "mupen64plus-EnableHWLighting": "False",
          "mupen64plus-txFilterMode": "None",
          "mupen64plus-txEnhancementMode": "As Is",
          "mupen64plus-txHiresEnable": "False",
          "mupen64plus-EnableN64DepthCompare": "False",
          "mupen64plus-MaxTxCacheSize": "1500",
        });
      } else if (constrainedMemory) {
        ejsSettings["mupen64plus-txFilterMode"] = "None";
        ejsSettings["mupen64plus-txHiresEnable"] = "False";
        ejsSettings["mupen64plus-MaxTxCacheSize"] = "2000";
      }

      if (previousRes !== nextRes || weakWebGL || chromebookMediumHeavy3D) {
        this.logDiagnostic(
          "performance",
          `N64 WebGL clamp: res ${previousRes ?? "?"}->${nextRes}, ` +
          `rdp=${ejsSettings["mupen64plus-rdp-plugin"] ?? "?"}, ` +
          `fb=${ejsSettings["mupen64plus-EnableFBEmulation"] ?? "?"}, ` +
          `webgl2=${gpu.webgl2}, maxTex=${gpu.maxTextureSize}, vram~${caps.estimatedVRAMMB}MB`
        );
      }
      return;
    }

    if (systemId === "psx") {
      let maxPsxResIdx = tier === "ultra" ? 2 : tier === "high" ? 1 : 0;
      if (gpu.maxTextureSize < 8192 || caps.estimatedVRAMMB < 384 || constrainedMemory) {
        maxPsxResIdx = Math.min(maxPsxResIdx, 1);
      }
      if (weakWebGL) maxPsxResIdx = 0;

      const previousRes = ejsSettings["beetle_psx_hw_internal_resolution"];
      const nextRes = clampLadderValue(previousRes, PSX_RESOLUTION_STEPS, maxPsxResIdx);
      ejsSettings["beetle_psx_hw_internal_resolution"] = nextRes;

      if (weakWebGL || chromebookMediumHeavy3D) {
        Object.assign(ejsSettings, {
          beetle_psx_hw_frame_duping: "enabled",
          beetle_psx_hw_filter: "nearest",
          beetle_psx_hw_dither_mode: "1x(native)",
          beetle_psx_hw_depth: "16bpp(native)",
          beetle_psx_hw_pgxp_mode: "disabled",
          beetle_psx_hw_pgxp_texture: "disabled",
          beetle_psx_hw_pgxp_vertex: "disabled",
          beetle_psx_hw_gte_overclock: "disabled",
          beetle_psx_hw_renderer_software_fb: "enabled",
          beetle_psx_hw_gpu_overclock: "1x(native)",
          beetle_psx_hw_super_sampling: "disabled",
          beetle_psx_hw_msaa: "disabled",
        });
      } else if (constrainedMemory) {
        ejsSettings["beetle_psx_hw_super_sampling"] = "disabled";
        ejsSettings["beetle_psx_hw_msaa"] = "disabled";
      }

      if (previousRes !== nextRes || weakWebGL || chromebookMediumHeavy3D) {
        this.logDiagnostic(
          "performance",
          `PS1 WebGL clamp: res ${previousRes ?? "?"}->${nextRes}, ` +
          `pgxp=${ejsSettings["beetle_psx_hw_pgxp_mode"] ?? "?"}, ` +
          `msaa=${ejsSettings["beetle_psx_hw_msaa"] ?? "?"}, ` +
          `webgl2=${gpu.webgl2}, maxTex=${gpu.maxTextureSize}, vram~${caps.estimatedVRAMMB}MB`
        );
      }
      return;
    }

    if (systemId === "segaSaturn") {
      const previousThreads = ejsSettings["yabause_numthreads"];
      const previousFrameskip = ejsSettings["yabause_frameskip"];
      const previousCart = ejsSettings["yabause_addon_cartridge"];

      const maxThreads = weakWebGL || constrainedMemory ? 2 : tier === "ultra" ? 6 : tier === "high" ? 4 : 2;
      ejsSettings["yabause_numthreads"] = clampThreadOption(previousThreads, caps, maxThreads);

      if (weakWebGL || caps.cpuCores <= 2 || caps.isMobile) {
        ejsSettings["yabause_frameskip"] = "enabled";
      }
      if (weakWebGL || constrainedMemory || caps.estimatedVRAMMB < 384) {
        ejsSettings["yabause_addon_cartridge"] = "none";
      }

      if (
        previousThreads !== ejsSettings["yabause_numthreads"] ||
        previousFrameskip !== ejsSettings["yabause_frameskip"] ||
        previousCart !== ejsSettings["yabause_addon_cartridge"]
      ) {
        this.logDiagnostic(
          "performance",
          `Saturn WebGL clamp: threads ${previousThreads ?? "?"}->${ejsSettings["yabause_numthreads"]}, ` +
          `frameskip=${ejsSettings["yabause_frameskip"] ?? "?"}, cart=${ejsSettings["yabause_addon_cartridge"] ?? "?"}, ` +
          `webgl2=${gpu.webgl2}, maxTex=${gpu.maxTextureSize}, vram~${caps.estimatedVRAMMB}MB`
        );
      }
      return;
    }

    if (systemId === "segaDC") {
      let maxDcResIdx = tier === "ultra" ? 2 : tier === "high" ? 1 : 0;
      if (gpu.maxTextureSize < 8192 || caps.estimatedVRAMMB < 384 || constrainedMemory) {
        maxDcResIdx = Math.min(maxDcResIdx, 1);
      }
      if (weakWebGL) maxDcResIdx = 0;

      const previousRes = ejsSettings["flycast_internal_resolution"];
      const nextRes = clampLadderValue(previousRes, DREAMCAST_RESOLUTION_STEPS, maxDcResIdx);
      ejsSettings["flycast_internal_resolution"] = nextRes;

      if (weakWebGL) {
        Object.assign(ejsSettings, {
          flycast_mipmapping: "disabled",
          flycast_anisotropic_filtering: "1",
          flycast_texupscale: "disabled",
          flycast_enable_rttb: "disabled",
          flycast_enable_purupuru: "disabled",
          flycast_dsp: "disabled",
          flycast_alpha_sorting: "per-strip (fast, least accurate)",
          flycast_frame_skipping: "enabled",
          flycast_widescreen_cheats: "disabled",
          flycast_widescreen_hack: "disabled",
        });
        if (caps.cpuCores <= 2 || caps.isMobile) {
          ejsSettings["flycast_threaded_rendering"] = "disabled";
        }
      } else if (constrainedMemory) {
        ejsSettings["flycast_texupscale"] = "disabled";
        ejsSettings["flycast_anisotropic_filtering"] = String(Math.min(
          parseInt(ejsSettings["flycast_anisotropic_filtering"] ?? "1", 10) || 1,
          2,
        ));
        if (caps.estimatedVRAMMB < 384) {
          ejsSettings["flycast_enable_rttb"] = "disabled";
        }
      }

      if (previousRes !== nextRes || weakWebGL) {
        this.logDiagnostic(
          "performance",
          `DC WebGL clamp: res ${previousRes ?? "?"}->${nextRes}, ` +
          `rttb=${ejsSettings["flycast_enable_rttb"] ?? "?"}, ` +
          `texup=${ejsSettings["flycast_texupscale"] ?? "?"}, ` +
          `frameskip=${ejsSettings["flycast_frame_skipping"] ?? "?"}, ` +
          `webgl2=${gpu.webgl2}, maxTex=${gpu.maxTextureSize}, vram~${caps.estimatedVRAMMB}MB`
        );
      }
      return;
    }

    const previousPs2Res = ejsSettings["pcsx2_internal_resolution"] ?? ejsSettings["play_internal_resolution"];
    if (weakWebGL || constrainedMemory || gpu.maxTextureSize < 8192) {
      if ("pcsx2_internal_resolution" in ejsSettings) ejsSettings["pcsx2_internal_resolution"] = "1x";
      if ("play_internal_resolution" in ejsSettings) ejsSettings["play_internal_resolution"] = "1x";
      if ("pcsx2_texture_filtering" in ejsSettings) ejsSettings["pcsx2_texture_filtering"] = "nearest";
      if ("pcsx2_blending_accuracy" in ejsSettings) ejsSettings["pcsx2_blending_accuracy"] = "basic";
      if ("pcsx2_frameskip" in ejsSettings) ejsSettings["pcsx2_frameskip"] = "enabled";
    }
    const nextPs2Res = ejsSettings["pcsx2_internal_resolution"] ?? ejsSettings["play_internal_resolution"];
    if (previousPs2Res !== nextPs2Res) {
      this.logDiagnostic(
        "performance",
        `PS2 WebGL clamp: res ${previousPs2Res ?? "?"}->${nextPs2Res ?? "?"}, ` +
        `webgl2=${gpu.webgl2}, maxTex=${gpu.maxTextureSize}, vram~${caps.estimatedVRAMMB}MB`
      );
    }
  }

  /**
   * Keep 2D cores responsive on weak browser paths without flattening the
   * richer high/ultra presets on capable machines.
   */
  private _applyLightCorePerformanceOverrides(
    systemId: string,
    tier: PerformanceTier,
    caps: DeviceCapabilities,
    ejsSettings: Record<string, string>,
  ): void {
    const weak2D =
      caps.isSoftwareGPU ||
      caps.isLowSpec ||
      caps.cpuCores <= 2 ||
      caps.gpuBenchmarkScore < 20;
    const constrained2D =
      weak2D ||
      caps.isMobile ||
      (caps.deviceMemoryGB !== null && caps.deviceMemoryGB <= 3);

    if (!constrained2D) return;

    const changes: string[] = [];
    const set = (key: string, value: string): void => {
      if (!(key in ejsSettings)) return;
      const previous = ejsSettings[key];
      if (previous === value) return;
      ejsSettings[key] = value;
      changes.push(`${key}=${previous ?? "?"}->${value}`);
    };

    switch (systemId) {
      case "nes":
        set("fceumm_sndquality", weak2D ? "Low" : "High");
        set("fceumm_no_sprite_limit", "disabled");
        set("fceumm_use_official_overclocking", "disabled");
        break;

      case "snes":
        set("snes9x_frameskip", "auto");
        set("snes9x_frameskip_threshold", "33");
        set("snes9x_audio_interpolation", "gaussian");
        set("snes9x_overclock_cycles", weak2D ? "disabled" : tier === "ultra" ? "compatible" : "disabled");
        set("snes9x_blargg_ntsc_filter", "disabled");
        break;

      case "gba":
        if (weak2D) set("mgba_frameskip", "1");
        set("mgba_color_correction", weak2D ? "disabled" : "Game Boy Advance");
        set("mgba_interframe_blending", "disabled");
        set("mgba_audio_buffer_size", weak2D ? "2048" : "1024");
        break;

      case "gb":
      case "gbc":
        set("gambatte_mix_frames", "disabled");
        set("gambatte_dark_filter_level", "0");
        break;

      case "segaMD":
      case "segaGG":
      case "segaMS":
        set("genesis_plus_gx_hq_fm", weak2D ? "disabled" : "enabled");
        set("genesis_plus_gx_cpu_overclock", "none");
        set("genesis_plus_gx_no_sprite_limit", "disabled");
        set("genesis_plus_gx_ym2612_improved", weak2D ? "disabled" : "enabled");
        set("genesis_plus_gx_blargg_ntsc_filter", "disabled");
        set("genesis_plus_gx_lcd_filter", "disabled");
        set("genesis_plus_gx_frame_skip", weak2D ? "2" : "1");
        set("genesis_plus_gx_cartridge_slot", "none");
        set("genesis_plus_gx_extern_cpu", "disabled");
        if (weak2D) set("genesis_plus_gx_sound_output", "mono");
        break;

      case "atari2600":
        set("stella_filter", "none");
        set("stella_phosphor_blend", weak2D ? "40" : "50");
        break;

      case "arcade":
        // Arcade now pins FBNeo; no MAME2003-specific low-spec clamps apply here.
        break;

      case "mame2003":
        set("mame2003-plus_frameskip", weak2D ? "1" : "0");
        set("mame2003-plus_sample_rate", weak2D ? "22050" : "30000");
        set("mame2003-plus_display_artwork", "disabled");
        set("mame2003-plus_art_resolution", "1");
        set("mame2003-plus_vector_resolution", "640x480");
        set("mame2003-plus_vector_antialias", "disabled");
        break;
    }

    if (changes.length > 0) {
      this.logDiagnostic(
        "performance",
        `2D core clamp (${systemId}): ${changes.slice(0, 6).join(", ")}`
      );
    }
  }

  private _syncDRSInitialStep(systemId: string, ejsSettings: Record<string, string>): void {
    const ladder = getResolutionLadder(systemId);
    this._drsTotalSteps = ladder ? ladder.values.length : 0;
    this._drsLowFPSStartTime = 0;
    this._drsHighFPSStartTime = 0;
    if (!ladder) {
      this._drsCurrentStepIdx = 0;
      return;
    }

    const selected = ejsSettings[ladder.key];
    const idx = selected ? ladder.values.indexOf(selected) : 0;
    this._drsCurrentStepIdx = idx >= 0 ? idx : 0;
    this.logDiagnostic(
      "performance",
      `DRS baseline: ${ladder.key}=${selected ?? ladder.values[0]} ` +
      `(step ${this._drsCurrentStepIdx}/${ladder.values.length - 1})`
    );
  }

  // ── launch ──────────────────────────────────────────────────────────────────

  async launch(opts: LaunchOptions): Promise<void> {
    if (this._state === "loading") {
      // The emulator is already loading — notify the caller without changing
      // state. Transitioning to "error" here would be incorrect because the
      // in-flight load is still active and will eventually reach "running".
      this.onError?.("Emulator is already loading. Please wait.");
      return;
    }

    if (this._state !== "idle") {
      this._teardown();
    }

    const system = getSystemById(opts.systemId);
    if (!system) {
      this._emitError(`Unknown system "${opts.systemId}".`);
      return;
    }

    this._currentSystem = system;

    // ── Pre-flight checks (conditional per system) ──────────────────────────
    if (system.needsThreads  && !this._checkSharedArrayBuffer()) return;
    if (system.needsWebGL2   && !this._checkWebGL2())            return;

    if (opts.systemId === "segaDC") {
      this.warmUpDreamcastPipeline();
    }

    if (!system.is3D) {
      this.warmUp2DPipeline();
    }

    // Derive the filename - Blob doesn't have .name, so accept it explicitly
    const fileName = opts.fileName
      ?? (opts.file instanceof File ? opts.file.name : "game.bin");

    if (!this._validateFileExt(fileName, system, opts.skipExtensionCheck)) return;

    // ── Large ROM warning ───────────────────────────────────────────────────
    if (opts.file.size > LARGE_ROM_THRESHOLD) {
      diagWarn(
        this.verboseLogging,
        `[RetroOasis] Large ROM detected (${(opts.file.size / 1024 / 1024).toFixed(0)} MB). ` +
        `This may cause memory pressure in the browser. Consider using a CSO/compressed format.`,
      );
    }

    this._setState("loading");
    this._launchGameFile = null;
    this._emit("onProgress", "Preparing game file…");
    if (system.experimental && system.stabilityNotice) {
      this.logDiagnostic("system", `${system.name}: ${system.stabilityNotice}`);
    }
    this.logDiagnostic("system", `Launching "${fileName}" on ${opts.systemId} (${(opts.file.size / 1024 / 1024).toFixed(1)} MB)`);

    // ── Startup profiler — reset and start timing the launch ────────────────
    this._startupProfiler.reset();
    this._fpsPrediction.reset();
    this._fpsPredictionFired = false;
    this._startupProfiler.begin("core_download");

    // Mark the launch start time for DevTools Performance timeline profiling.
    // Measures "retro-oasis:launch-to-ready" and "retro-oasis:ready-to-game-start"
    // will be recorded when EJS_ready and EJS_onGameStart fire respectively.
    try { performance.mark(LEGACY_PERF_MARKS.launch); } catch { /* best-effort */ }

    if (this.verboseLogging) {
      console.info(
        `[RetroOasis] Launching "${fileName}" on system "${opts.systemId}" ` +
        `(size: ${(opts.file.size / 1024 / 1024).toFixed(1)} MB, tier override: ${opts.tierOverride ?? "none"})`
      );
    }

    // ── Probe audio latency in parallel with game file preparation ─────────
    // detectAudioCapabilities() is async and short; running it before we reach
    // the EJS globals section means we can use the result to override the
    // audio buffer size if the hardware reports unusually high latency.
    const audioCapabilitiesPromise = detectAudioCapabilities();

    try {
      // Normalise to a File object so EmulatorJS uses its direct arrayBuffer()
      // path when loading the ROM.  Passing a File/Blob to EJS_gameUrl lets
      // EmulatorJS skip its internal fetch() call entirely — that fetch() is
      // unreliable on iOS Safari when a service worker is active (WebKit bug:
      // fetching blob: URLs from a SW-controlled page can silently fail,
      // causing games to stall in the loading screen forever).
      //
      // On iPhone/iPad, ROMs from the file picker or from IndexedDB are often
      // backed by opaque blob/file handles. Reading them asynchronously later
      // (after system dialogs, archive work, or a second launch) can fail or
      // stall. Eagerly copy into a fresh in-memory File once before EJS runs.
      let gameFile: File;
      if (isLikelyIOS()) {
        this._emit("onProgress", "Preparing game file for iOS…");
        const romBuf = await opts.file.arrayBuffer();
        gameFile = new File([romBuf], fileName, {
          type: opts.file.type || "application/octet-stream",
        });
        if (this.verboseLogging) {
          console.info(
            "[RetroOasis] iOS WebKit: materialised ROM into an in-memory File for stable reads."
          );
        }
      } else {
        gameFile = opts.file instanceof File
          ? opts.file
          : new File([opts.file], fileName, { type: opts.file.type });
      }
      this._launchGameFile = gameFile;
      const gameName = fileName.replace(/\.[^.]+$/, "");

      this._emit("onProgress", "Initialising EmulatorJS…");

      // ── Record launch count for intelligent core preloading ─────────────
      recordSystemLaunch(opts.systemId);

      // ── Per-game shader warmup: pre-compile shaders from previous sessions ─
      // Fire-and-forget — must never delay the launch or block the UI thread.
      if (opts.gameId) {
        shaderCache.preCompileForGame(opts.gameId).catch(() => {});
      }

      // ── Resolve performance settings (tier-aware) ───────────────────────
      // tierOverride bypasses auto-detection — used by the tier-downgrade flow
      const tier = opts.tierOverride ?? resolveTier(opts.performanceMode, opts.deviceCaps);
      this._activeTier = tier;
      this._resetAdaptiveQualityState();
      this.logDiagnostic("performance", `Resolved tier: ${tier}${opts.tierOverride ? " (override)" : ""}`);

      // DRS ladder length, baseline step index, and timers are applied in
      // _syncDRSInitialStep once ejsSettings are final.

      // Reset audio underrun counter, rate-limit timestamp, and level for the new session
      this._audioUnderruns = 0;
      this._lastAudioUnderrunWarnTime = 0;
      this._audioLevel = 0;

      let ejsSettings: Record<string, string>;

      if (system.tierSettings && system.tierSettings[tier]) {
        ejsSettings = { ...system.tierSettings[tier] };
      } else {
        const mode = resolveMode(opts.performanceMode, opts.deviceCaps);
        ejsSettings = mode === "performance"
          ? { ...system.perfSettings }
          : { ...system.qualitySettings };
      }

      // ── Per-game core settings overrides ─────────────────────────────────
      // Merge caller-supplied overrides (e.g. resolution preset from per-game
      // graphics profile) on top of the tier settings. These take precedence
      // over everything except audio adaptation, which follows below.
      if (opts.coreSettingsOverride && Object.keys(opts.coreSettingsOverride).length > 0) {
        Object.assign(ejsSettings, opts.coreSettingsOverride);
        this.logDiagnostic(
          "performance",
          `Per-game core overrides: ${JSON.stringify(opts.coreSettingsOverride)}`
        );
      }


      // Override the audio buffer size from tier defaults when the hardware
      // reports a different latency profile.  This prevents crackles on
      // Bluetooth/USB audio devices (high base latency) and allows the
      // minimum buffer on DACs with very low output latency.
      //
      // Applies to 3D and audio-sensitive cores: PSP, N64, PS1, GBA, NDS, and DC —
      // each exposes audio buffer or timing knobs that benefit from
      // hardware-aware tuning.
      const audioCaps = await audioCapabilitiesPromise;
      if (audioCaps && opts.systemId === "psp" && "ppsspp_audio_latency" in ejsSettings) {
        const tierLatency = ejsSettings["ppsspp_audio_latency"];
        const hwBufTier   = audioCaps.suggestedBufferTier;
        // Only promote to a larger buffer — never shrink below what the tier chose.
        // A tier that already chose "2" (large) stays at "2" regardless of hardware.
        const tierNumeric = parseInt(tierLatency, 10);
        const hwNumeric   = hwBufTier === "high" ? 2 : hwBufTier === "medium" ? 1 : 0;
        if (hwNumeric > tierNumeric) {
          ejsSettings["ppsspp_audio_latency"] = String(hwNumeric);
          if (this.verboseLogging) {
            console.info(
              `[RetroOasis] Audio: hardware latency (${audioCaps.baseLatencyMs?.toFixed(1)} ms) ` +
              `suggests buffer tier "${hwBufTier}"; upgrading ppsspp_audio_latency ` +
              `from ${tierLatency} → ${hwNumeric}.`
            );
          }
        }
      }

      // N64 audio adaptation: mupen64plus-audio-buffer-size can be increased
      // to prevent crackles on high-latency audio hardware.
      if (audioCaps && opts.systemId === "n64") {
        const hwBufTier = audioCaps.suggestedBufferTier;
        if (hwBufTier === "high") {
          ejsSettings["mupen64plus-audio-buffer-size"] = "2048";
          if (this.verboseLogging) {
            console.info(
              `[RetroOasis] Audio: high HW latency (${audioCaps.baseLatencyMs?.toFixed(1)} ms) ` +
              `— setting N64 audio buffer to 2048 samples.`
            );
          }
        }
      }

      // PS1 audio adaptation: beetle_psx_hw_cd_access_method can be forced to
      // "sync" on high-latency hardware to prevent audio desync from async
      // disc reads racing the audio output thread.
      if (audioCaps && opts.systemId === "psx" && audioCaps.suggestedBufferTier === "high") {
        if (ejsSettings["beetle_psx_hw_cd_access_method"] === "async") {
          ejsSettings["beetle_psx_hw_cd_access_method"] = "sync";
          if (this.verboseLogging) {
            console.info(
              `[RetroOasis] Audio: high HW latency (${audioCaps.baseLatencyMs?.toFixed(1)} ms) ` +
              `— switching PS1 CD access to sync for audio stability.`
            );
          }
        }
      }

      // GBA audio adaptation: mgba_audio_buffer_size maps sample-count to
      // hardware latency tier.  The tier default already picks an appropriate
      // size, but on high-latency hardware we always promote to the 4096-sample
      // buffer to prevent underruns regardless of what the tier selected.
      // On low-latency hardware we allow the tier default to stand unmodified.
      if (audioCaps && opts.systemId === "gba" && "mgba_audio_buffer_size" in ejsSettings) {
        const hwBufTier   = audioCaps.suggestedBufferTier;
        const tierSamples = parseInt(ejsSettings["mgba_audio_buffer_size"], 10);
        // High-latency hardware (Bluetooth/USB): always use 4096-sample buffer.
        // Medium-latency hardware:               use at least 1024 samples.
        // Low-latency hardware:                  let the tier choice stand.
        const minSamples = hwBufTier === "high" ? 4096 : hwBufTier === "medium" ? 1024 : 0;
        if (minSamples > tierSamples) {
          ejsSettings["mgba_audio_buffer_size"] = String(minSamples);
          this.logDiagnostic(
            "audio",
            `GBA audio buffer promoted ${tierSamples} → ${minSamples} samples (HW tier: ${hwBufTier})`
          );
          if (this.verboseLogging) {
            console.info(
              `[RetroOasis] Audio: hardware latency (${audioCaps.baseLatencyMs?.toFixed(1)} ms) ` +
              `suggests buffer tier "${hwBufTier}"; upgrading mgba_audio_buffer_size ` +
              `from ${tierSamples} → ${minSamples} samples.`
            );
          }
        }
      }

      // NDS audio adaptation: on high-latency hardware, disable advanced
      // timing emulation to decouple audio output from the DS CPU timing
      // model.  This prevents audio desync on Bluetooth/USB audio devices
      // where the output thread lags behind the emulated CPU clock.
      // advanced_timing is only forced off when it is currently "enabled"
      // (i.e. the tier selected it); lower tiers already have it disabled.
      if (audioCaps && opts.systemId === "nds" && audioCaps.suggestedBufferTier === "high") {
        if (ejsSettings["desmume_advanced_timing"] === "enabled") {
          ejsSettings["desmume_advanced_timing"] = "disabled";
          this.logDiagnostic(
            "audio",
            `NDS advanced_timing disabled for high-latency audio hardware (${audioCaps.baseLatencyMs?.toFixed(1)} ms)`
          );
          if (this.verboseLogging) {
            console.info(
              `[RetroOasis] Audio: high HW latency (${audioCaps.baseLatencyMs?.toFixed(1)} ms) ` +
              `— disabling NDS advanced_timing to prevent audio desync.`
            );
          }
        }
      }

      // Dreamcast audio adaptation: Flycast exposes a DSP option that adds audio
      // processing latency. On high-latency hardware (Bluetooth/USB), disabling
      // the DSP reduces total audio pipeline latency and prevents crackles and
      // desync. On low-latency hardware the DSP is safe to keep enabled for
      // better audio accuracy.
      if (audioCaps && opts.systemId === "segaDC" && audioCaps.suggestedBufferTier === "high") {
        if (ejsSettings["flycast_dsp"] === "enabled") {
          ejsSettings["flycast_dsp"] = "disabled";
          this.logDiagnostic(
            "audio",
            `DC DSP disabled for high-latency audio hardware (${audioCaps.baseLatencyMs?.toFixed(1)} ms)`
          );
          if (this.verboseLogging) {
            console.info(
              `[RetroOasis] Audio: high HW latency (${audioCaps.baseLatencyMs?.toFixed(1)} ms) ` +
              `— disabling DC DSP to reduce audio pipeline latency.`
            );
          }
        }
      }

      // ── NDS performance diagnostics ───────────────────────────────────────
      // Log key DeSmuME settings chosen for this session so they appear in
      // the diagnostic timeline and the browser console when verboseLogging is
      // enabled.  This makes it straightforward to correlate sluggish gameplay
      // reports with the active tier's frameskip / CPU-mode / resolution
      // without having to dig through EJS_Settings manually.
      this._applyHeavyCoreGpuOverrides(opts.systemId, tier, opts.deviceCaps, ejsSettings);
      this._applyLightCorePerformanceOverrides(opts.systemId, tier, opts.deviceCaps, ejsSettings);
      this._syncDRSInitialStep(opts.systemId, ejsSettings);

      {
        const effectivePost = effectivePostProcessForSystem(
          system.is3D === true,
          this._postProcessConfig.effect,
        );
        if (
          opts.deviceCaps.webgpuAvailable &&
          effectivePost !== "none" &&
          !this._webgpuDevice
        ) {
          const webgpuPowerPref = (opts.deviceCaps.isLowSpec || opts.deviceCaps.isChromOS)
            ? "low-power"
            : "high-performance";
          void this.preWarmWebGPU(webgpuPowerPref).catch(() => {});
        }
      }

      if (opts.systemId === "nds") {
        const dsFrameskip  = ejsSettings["desmume_frameskip"]            ?? "?";
        const dsCpuMode    = ejsSettings["desmume_cpu_mode"]             ?? "?";
        const dsResolution = ejsSettings["desmume_internal_resolution"]  ?? "?";
        const dsOpenGL     = ejsSettings["desmume_opengl_mode"]          ?? "?";
        const dsTiming     = ejsSettings["desmume_advanced_timing"]      ?? "?";
        const dsColorDepth = ejsSettings["desmume_color_depth"]          ?? "?";
        const dsPointer    = ejsSettings["desmume_pointer_type"]         ?? "?";
        const dsMicMode    = ejsSettings["desmume_mic_mode"]             ?? "?";
        this.logDiagnostic(
          "performance",
          `NDS tier=${tier}: cpu=${dsCpuMode} frameskip=${dsFrameskip} res=${dsResolution} opengl=${dsOpenGL} timing=${dsTiming} depth=${dsColorDepth} pointer=${dsPointer} mic=${dsMicMode}`
        );
        if (this.verboseLogging) {
          console.info(
            `[RetroOasis] DS performance settings — ` +
            `cpu_mode: ${dsCpuMode}, frameskip: ${dsFrameskip}, ` +
            `resolution: ${dsResolution}, opengl: ${dsOpenGL}, ` +
            `advanced_timing: ${dsTiming}, color_depth: ${dsColorDepth}, ` +
            `pointer_type: ${dsPointer}, mic_mode: ${dsMicMode}`
          );
        }
      }

      // ── PSP performance diagnostics ─────────────────────────────────────────
      // Log key PPSSPP settings chosen for this session.
      if (opts.systemId === "psp") {
        const pspResolution         = ejsSettings["ppsspp_internal_resolution"]   ?? "?";
        const pspAutoFrameskip       = ejsSettings["ppsspp_auto_frameskip"]        ?? "?";
        const pspFrameskip          = ejsSettings["ppsspp_frameskip"]              ?? "?";
        const pspCpuCore            = ejsSettings["ppsspp_cpu_core"]               ?? "?";
        const pspAnisotropic        = ejsSettings["ppsspp_gpu_anisotropic_filtering"] ?? "?";
        const pspTexScale           = ejsSettings["ppsspp_texture_scaling_level"]  ?? "?";
        const pspTexType            = ejsSettings["ppsspp_texture_scaling_type"]   ?? "?";
        const pspDeposterize        = ejsSettings["ppsspp_texture_deposterize"]   ?? "?";
        const pspLowerEffectsRes    = ejsSettings["ppsspp_lower_resolution_for_effects"] ?? "?";
        const pspMaxFps             = ejsSettings["ppsspp_force_max_fps"]         ?? "?";
        const pspCpuSpeed           = ejsSettings["ppsspp_change_emulated_psp_cpu_clock"] ?? "?";
        const pspAudioLatency       = ejsSettings["ppsspp_audio_latency"]          ?? "?";
        const pspBackend            = ejsSettings["ppsspp_rendering_mode"]         ?? "?";
        const pspDriver             = ejsSettings["ppsspp_gpu_driver"]             ?? "?";
        this.logDiagnostic(
          "performance",
          `PSP tier=${tier}: res=${pspResolution} fs=${pspAutoFrameskip}/${pspFrameskip} ` +
          `cpu=${pspCpuCore} af=${pspAnisotropic} tex=${pspTexScale}/${pspTexType} ` +
          `deposterize=${pspDeposterize} lowerfx=${pspLowerEffectsRes} maxfps=${pspMaxFps} ` +
          `cpuspeed=${pspCpuSpeed} audio=${pspAudioLatency} backend=${pspBackend} driver=${pspDriver}`
        );
        if (this.verboseLogging) {
          console.info(
            `[RetroOasis] PSP performance settings — ` +
            `resolution: ${pspResolution}, auto_frameskip: ${pspAutoFrameskip}, frameskip: ${pspFrameskip}, ` +
            `cpu_core: ${pspCpuCore}, anisotropic: ${pspAnisotropic}, texture_scaling: ${pspTexScale}/${pspTexType}, ` +
            `deposterize: ${pspDeposterize}, lower_resolution_for_effects: ${pspLowerEffectsRes}, ` +
            `force_max_fps: ${pspMaxFps}, cpu_clock: ${pspCpuSpeed}, audio_latency: ${pspAudioLatency}, ` +
            `rendering_mode: ${pspBackend}, gpu_driver: ${pspDriver}`
          );
        }
      }

      // ── N64 performance diagnostics ─────────────────────────────────────────
      if (opts.systemId === "n64") {
        const n64Res   = ejsSettings["mupen64plus-resolution-factor"]   ?? "?";
        const n64Rdp   = ejsSettings["mupen64plus-rdp-plugin"]          ?? "?";
        const n64Fb    = ejsSettings["mupen64plus-EnableFBEmulation"]  ?? "?";
        const n64Cpo   = ejsSettings["mupen64plus-CountPerOp"]         ?? "?";
        this.logDiagnostic(
          "performance",
          `N64 tier=${tier}: res=${n64Res} rdp=${n64Rdp} fbEmu=${n64Fb} CountPerOp=${n64Cpo}`
        );
        if (this.verboseLogging) {
          console.info(
            `[RetroOasis] N64 performance settings — ` +
            `resolution_factor: ${n64Res}, rdp: ${n64Rdp}, fb_emulation: ${n64Fb}, CountPerOp: ${n64Cpo}`
          );
        }
      }

      // ── PS1 performance diagnostics ─────────────────────────────────────────
      if (opts.systemId === "psx") {
        const psxIr    = ejsSettings["beetle_psx_hw_internal_resolution"] ?? "?";
        const psxDup   = ejsSettings["beetle_psx_hw_frame_duping"]       ?? "?";
        const psxPgxp  = ejsSettings["beetle_psx_hw_pgxp_mode"]          ?? "?";
        const psxMsaa  = ejsSettings["beetle_psx_hw_msaa"]               ?? "?";
        const psxDyn   = ejsSettings["beetle_psx_hw_cpu_dynarec"]        ?? "?";
        this.logDiagnostic(
          "performance",
          `PS1 tier=${tier}: ir=${psxIr} dup=${psxDup} pgxp=${psxPgxp} msaa=${psxMsaa} dyn=${psxDyn}`
        );
        if (this.verboseLogging) {
          console.info(
            `[RetroOasis] PS1 performance settings — ` +
            `internal_res: ${psxIr}, frame_duping: ${psxDup}, pgxp: ${psxPgxp}, msaa: ${psxMsaa}, dynarec: ${psxDyn}`
          );
        }
      }

      // ── Dreamcast performance diagnostics ────────────────────────────────
      // Log key Flycast settings chosen for this session.
      if (opts.systemId === "segaDC") {
        const dcResolution         = ejsSettings["flycast_internal_resolution"]   ?? "?";
        const dcThreaded           = ejsSettings["flycast_threaded_rendering"]    ?? "?";
        const dcMipmap             = ejsSettings["flycast_mipmapping"]            ?? "?";
        const dcAnisotropic        = ejsSettings["flycast_anisotropic_filtering"] ?? "?";
        const dcTexUpscale         = ejsSettings["flycast_texupscale"]            ?? "?";
        const dcEnableRttb         = ejsSettings["flycast_enable_rttb"]           ?? "?";
        const dcAlphaSorting       = ejsSettings["flycast_alpha_sorting"]         ?? "?";
        const dcFrameSkipping      = ejsSettings["flycast_frame_skipping"]        ?? "?";
        const dcDsp                = ejsSettings["flycast_dsp"]                   ?? "?";
        const dcCable              = ejsSettings["flycast_cable_type"]            ?? "?";
        const dcWidescreen         = ejsSettings["flycast_widescreen_hack"]       ?? "?";
        this.logDiagnostic(
          "performance",
          `DC tier=${tier}: ` +
          `res=${dcResolution} threaded=${dcThreaded} mipmap=${dcMipmap} ` +
          `af=${dcAnisotropic} texup=${dcTexUpscale} rttb=${dcEnableRttb} ` +
          `alpha=${dcAlphaSorting} frameskip=${dcFrameSkipping} ` +
          `dsp=${dcDsp} cable=${dcCable} ws=${dcWidescreen}`
        );
        if (this.verboseLogging) {
          console.info(
            `[RetroOasis] Dreamcast performance settings — ` +
            `resolution: ${dcResolution}, threaded_rendering: ${dcThreaded}, ` +
            `mipmapping: ${dcMipmap}, anisotropic_filtering: ${dcAnisotropic}, ` +
            `texupscale: ${dcTexUpscale}, enable_rttb: ${dcEnableRttb}, ` +
            `alpha_sorting: ${dcAlphaSorting}, frame_skipping: ${dcFrameSkipping}, ` +
            `dsp: ${dcDsp}, cable_type: ${dcCable}, widescreen_hack: ${dcWidescreen}`
          );
        }
      }

      // ── Set EJS globals ───────────────────────────────────────────────────
      this._revokeBlobUrl();
      window.EJS_player        = `#${this._playerId}`;
      window.EJS_core          = system.coreId ?? system.id;
      window.EJS_gameUrl       = gameFile;
      window.EJS_gameName      = gameName;
      window.EJS_pathtodata    = EJS_DATA_BASE;
      window.EJS_startOnLoaded = true;
      window.EJS_threads       = system.needsThreads;
      window.EJS_volume        = opts.volume;
      // The shipped data/ folder contains the source runtime files under
      // data/src/. If loader.js probes emulator.min.js first, Vite can serve
      // index.html for that missing file, which throws "Unexpected token '<'"
      // and leaves the launch stuck at "Initialising EmulatorJS...".
      window.EJS_DEBUG_XX      = true;

      // For cores not on the official CDN, point EJS at the external bundle URL.
      if (system.corePath) {
        window.EJS_corePath = system.corePath;
        delete window.EJS_paths;
      } else {
        delete window.EJS_corePath;
        const selectedCore = coreNameForSystem(system, ejsSettings);
        const coreCdnBase = cdnBaseForCore(selectedCore);
        window.EJS_paths = {
          [`${selectedCore}.json`]:                    `${coreCdnBase}cores/reports/${selectedCore}.json`,
          [`${selectedCore}-wasm.data`]:               `${coreCdnBase}cores/${selectedCore}-wasm.data`,
          [`${selectedCore}-legacy-wasm.data`]:        `${coreCdnBase}cores/${selectedCore}-legacy-wasm.data`,
          [`${selectedCore}-thread-wasm.data`]:        `${coreCdnBase}cores/${selectedCore}-thread-wasm.data`,
          [`${selectedCore}-thread-legacy-wasm.data`]: `${coreCdnBase}cores/${selectedCore}-thread-legacy-wasm.data`,
          ...(selectedCore === "ppsspp"
            ? { "ppsspp-assets.zip": `${coreCdnBase}cores/ppsspp-assets.zip` }
            : {}),
        };
      }

      window.EJS_disableAutoUnload = true;
      window.EJS_askBeforeExit = true;
      window.EJS_fixedSaveInterval = 30_000;
      window.EJS_disableBatchBootup = false;
      const launchExt = gameFile.name.split(".").pop()?.toLowerCase() ?? "";
      if (opts.systemId === "psx" && ["chd", "iso", "pbp"].includes(launchExt)) {
        window.EJS_disableCue = true;
      } else {
        delete window.EJS_disableCue;
      }

      if (opts.biosAsset instanceof Blob) {
        this._biosUrl = URL.createObjectURL(opts.biosAsset);
        window.EJS_biosUrl = this._biosUrl;
      } else {
        delete window.EJS_biosUrl;
        this._biosUrl = null;
      }

      // ── Netplay globals ───────────────────────────────────────────────────
      const netplay = opts.netplayManager;
      if (netplay?.isSupportedForSystem(opts.systemId) && opts.gameId) {
        const roomKey = netplay.roomKeyFor(opts.gameId, opts.systemId);
        window.EJS_netplayServer    = netplay.serverUrl;
        window.EJS_netplayICEServers = netplay.iceServers;
        window.EJS_gameID           = netplay.gameIdFor(opts.gameId, opts.systemId);
        window.EJS_roomKey          = roomKey;
        window.EJS_netplayRoom      = roomDisplayNameForKey(roomKey);
        const playerName = netplay.username.trim();
        if (playerName) window.EJS_playerName = playerName;
        else delete window.EJS_playerName;
      } else {
        delete window.EJS_netplayServer;
        delete window.EJS_netplayICEServers;
        delete window.EJS_gameID;
        delete window.EJS_roomKey;
        delete window.EJS_netplayRoom;
        delete window.EJS_playerName;
      }

      if (opts.achievements) {
        ejsSettings["cheevos_enable"] = "true";
        ejsSettings["cheevos_username"] = opts.achievements.username;
        ejsSettings["cheevos_password"] = opts.achievements.apiKey; // RA uses API key as pass for token auth
        if (opts.achievements.hardcore) {
          ejsSettings["cheevos_hardcore_mode_enable"] = "true";
        }
      }

      if (Object.keys(ejsSettings).length > 0) {
        window.EJS_defaultOptions = ejsSettings;
        window.EJS_Settings = ejsSettings;
        this._activeCoreSettings = ejsSettings;
      } else {
        delete window.EJS_defaultOptions;
        delete window.EJS_Settings;
        this._activeCoreSettings = null;
      }

      // ── Lifecycle callbacks ───────────────────────────────────────────────
      window.EJS_ready = () => {
        // Ignore stale callbacks from a torn-down/replaced core instance.
        if (this._state !== "loading") return;
        if (window.EJS_emulator) {
          this._bridge = new CoreBridge(window.EJS_emulator, this._playerId);
        }
        this._emit("onProgress", "Booting game…");
        // End core_download phase — the JS glue + WASM have loaded
        this._startupProfiler.end("core_download");
        this._startupProfiler.begin("first_frame");
        if (this.verboseLogging) {
          console.info("[RetroOasis] EJS_ready fired — core loaded, booting game.");
        }
        // Mark the moment the core finished loading — useful in DevTools timeline.
        try {
          performance.mark(LEGACY_PERF_MARKS.coreReady);
          performance.measure(LEGACY_PERF_MARKS.launchToReady, LEGACY_PERF_MARKS.launch, LEGACY_PERF_MARKS.coreReady);
        } catch { /* marks may be unavailable in some sandboxed contexts */ }
      };

      window.EJS_onGameStart = () => {
        // Ignore stale callbacks from a torn-down/replaced core instance.
        if (this._state !== "loading") return;
        // End first_frame phase
        this._startupProfiler.end("first_frame");
        const profSummary = this._startupProfiler.summary();
        this.logDiagnostic(
          "performance",
          `Startup: ${profSummary.totalMs.toFixed(0)} ms total` +
          (profSummary.slowest ? `, slowest: ${profSummary.slowest.phase} (${profSummary.slowest.durationMs.toFixed(0)} ms)` : "")
        );
        if (this.verboseLogging) {
          console.info("[RetroOasis] EJS_onGameStart fired — game is running.");
          for (const r of profSummary.records) {
            console.info(`[RetroOasis] startup phase ${r.phase}: ${r.durationMs.toFixed(0)} ms`);
          }
        }
        // Mark the moment the first game frame rendered.
        try {
          performance.mark(LEGACY_PERF_MARKS.gameStart);
          performance.measure(LEGACY_PERF_MARKS.readyToGameStart, LEGACY_PERF_MARKS.coreReady, LEGACY_PERF_MARKS.gameStart);
        } catch { /* marks may be unavailable or a previous mark was missing */ }
        this._setState("running");
        this._fpsMonitor.onUpdate = (snap) => {
          this.onFPSUpdate?.(snap);
          this._checkAdaptiveQuality(snap.average);
          // Feed FPS prediction with the current average FPS
          this._fpsPrediction.addSample(snap.average);
          if (this._fpsPrediction.isLocked && !this._fpsPredictionFired) {
            const pred = this._fpsPrediction.predict();
            if (pred && !pred.sustainable) {
              this._fpsPredictionFired = true;
              this.logDiagnostic(
                "performance",
                `FPS prediction: avg ${pred.averageFps.toFixed(1)} fps, ` +
                `trend ${pred.trendFpsPerS.toFixed(1)} fps/s — tier may be unsustainable`
              );
              this.onFpsPredictionUnsustainable?.(pred.averageFps, pred.trendFpsPerS);
            } else if (pred) {
              // Prediction complete and sustainable — no need to check further
              this._fpsPredictionFired = true;
            }
          }
        };
        this._fpsMonitor.start();
        this._fpsMonitor.set2DMode(!system.is3D);
        this._memoryMonitor.start();
        this._installVisibilityHandler();
        this._installContextLossHandler();

        if (!system.is3D) {
          try {
            this._memoryMonitor.start(30_000);
          } catch { /* best-effort */ }
        }

        // Low-latency AudioWorklet path (loads ./audio-processor.js from the app origin).
        try {
          const base =
            typeof URL !== "undefined" && typeof window !== "undefined" && window.location?.href
              ? new URL("/", window.location.href).href
              : "";
          void this.setupAudioWorklet(base || "http://localhost/");
        } catch {
          void this.setupAudioWorklet("http://localhost/");
        }

        // ── Per-game shader warmup: open recording window ─────────────────
        // Record shaders compiled during the first GAME_WARMUP_WINDOW_MS of
        // gameplay and associate them with this game. On the next launch we
        // will pre-compile those exact programs via preCompileForGame().
        if (opts.gameId) {
          shaderCache.beginWarmupWindow(opts.gameId);
          this.logDiagnostic(
            "performance",
            `Per-game shader warmup window opened for "${opts.gameId}" (${GAME_WARMUP_WINDOW_MS / 1000} s)`
          );
          if (this._shaderWarmupTimerId !== null) {
            clearTimeout(this._shaderWarmupTimerId);
          }
          this._shaderWarmupTimerId = setTimeout(() => {
            shaderCache.endWarmupWindow();
            this._shaderWarmupTimerId = null;
            this.logDiagnostic("performance", `Per-game shader warmup window closed for "${opts.gameId}"`);
          }, GAME_WARMUP_WINDOW_MS);
        }

        // Attach WebGPU post-processing if enabled and device is available
        if (this._webgpuDevice && this._postProcessConfig.effect !== "none") {
          requestAnimationFrame(() => this._attachPostProcessor());
        }

        this.onGameStart?.();
      };

      if (window._RETRO_OASIS_E2E_STUB) {
        window.EJS_emulator = {
          setVolume: () => {},
          pause: () => {},
          resume: () => {},
          gameManager: {
            restart: () => {},
            quickSave: () => true,
            quickLoad: () => {},
            supportsStates: () => true,
          },
        };
        window.EJS_ready?.();
        window.EJS_onGameStart?.();
        return;
      }

      // ── Inject / reuse loader.js ──────────────────────────────────────────
      await this._loadScript(`${EJS_DATA_BASE}loader.js`);

      // ── Launch watchdog ───────────────────────────────────────────────────
      // EJS_onGameStart fires asynchronously after the core and ROM load.
      // On slow connections the core download alone can take 30-60 seconds.
      // If neither EJS_onGameStart nor an error fires within the timeout,
      // the loading overlay would be permanently stuck — guard against that.
      const LAUNCH_TIMEOUT_MS = 120_000; // 2 minutes
      this._launchTimeoutId = setTimeout(() => {
        if (this._state === "loading") {
          this._emitError(
            "The game took too long to start.\n\n" +
            "The game core or ROM download may have stalled.\n" +
            "Please check your internet connection and try again."
          );
        }
      }, LAUNCH_TIMEOUT_MS);

    } catch (err) {
      this._launchGameFile = null;
      this._revokeBlobUrl();
      this._emitError(
        `Failed to start emulator: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ── Controls ────────────────────────────────────────────────────────────────

  reset(): void {
    const emu = window.EJS_emulator;
    if (emu?.gameManager?.restart) {
      try { emu.gameManager.restart(); }
      catch (e) {
        this._emitError(`Reset failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  quickSave(slot = 1): void {
    const emu = window.EJS_emulator;
    if (!emu?.gameManager?.supportsStates?.()) return;
    emu.gameManager?.quickSave(slot);
  }

  quickLoad(slot = 1): void {
    const emu = window.EJS_emulator;
    if (!emu?.gameManager?.supportsStates?.()) return;
    emu.gameManager?.quickLoad(slot);
  }

  /** True if the running core supports save states. */
  supportsStates(): boolean {
    return window.EJS_emulator?.gameManager?.supportsStates?.() ?? false;
  }

  /**
   * Try to read the most recent save state data from the emulator's
   * virtual filesystem. Returns null if FS access is unavailable or
   * no state file exists for the given slot.
   */
  readStateData(slot: number): Uint8Array | null {
    const emu = window.EJS_emulator;
    if (!emu?.Module?.FS) return null;

    const gameName = window.EJS_gameName;
    if (!gameName) return null;
    const safeGameName = emulatorJsBaseFileName(gameName) || gameName;
    const quickStatePath = `/${slot || 1}-quick.state`;

    // RetroArch-flavoured cores typically persist under /home/web_user/retroarch/states,
    // while some EmulatorJS runtimes expose the same save states under /data/states.
    // Keep /data/saves as a legacy fallback for older packaged layouts.
    const paths = [...new Set([
      quickStatePath,
      `/home/web_user/retroarch/states/${gameName}.state${slot}`,
      `/home/web_user/retroarch/states/${gameName}.state`,
      `/home/web_user/retroarch/states/${safeGameName}.state${slot}`,
      `/home/web_user/retroarch/states/${safeGameName}.state`,
      `/data/states/${gameName}.state${slot}`,
      `/data/states/${gameName}.state`,
      `/data/states/${safeGameName}.state${slot}`,
      `/data/states/${safeGameName}.state`,
      `/data/saves/${gameName}.state${slot}`,
      `/data/saves/${gameName}.state`,
      `/data/saves/${safeGameName}.state${slot}`,
      `/data/saves/${safeGameName}.state`,
    ])];

    for (const path of paths) {
      try {
        const analysis = emu.Module.FS.analyzePath(path);
        if (analysis.exists) {
          return emu.Module.FS.readFile(path);
        }
      } catch { /* path doesn't exist */ }
    }

    return null;
  }

  /**
   * Write save state data back to the emulator's virtual filesystem
   * so it can be loaded via quickLoad. Returns true on success.
   */
  writeStateData(slot: number, data: Uint8Array): boolean {
    const emu = window.EJS_emulator;
    if (!emu?.Module?.FS) return false;

    const gameName = window.EJS_gameName;
    if (!gameName) return false;
    const safeGameName = emulatorJsBaseFileName(gameName) || gameName;

    const basePaths = [
      "/home/web_user/retroarch/states",
      "/data/states",
    ];

    try {
      let writeSucceeded = false;
      try {
        emu.Module.FS.writeFile(`/${slot || 1}-quick.state`, data);
        writeSucceeded = true;
      } catch {
        // Continue to compatibility paths below.
      }
      for (const basePath of basePaths) {
        try {
          emu.Module.FS.stat(basePath);
        } catch {
          // Directory doesn't exist yet — create it before writing.
          try {
            emu.Module.FS.mkdir?.(basePath, 0o777);
          } catch {
            continue;
          }
        }
        emu.Module.FS.writeFile(`${basePath}/${gameName}.state${slot}`, data);
        if (safeGameName !== gameName) {
          emu.Module.FS.writeFile(`${basePath}/${safeGameName}.state${slot}`, data);
        }
        writeSucceeded = true;
      }
      return writeSucceeded;
    } catch {
      return false;
    }
  }

  /**
   * Capture a JPEG screenshot of the current game canvas.
   * Returns null if the canvas is not found or capture fails.
   */
  captureScreenshot(): Promise<Blob | null> {
    return new Promise((resolve) => {
      try {
        const playerEl = document.getElementById(this._playerId);
        if (!playerEl) { resolve(null); return; }
        const canvas = playerEl.querySelector("canvas");
        if (!canvas || canvas.width === 0 || canvas.height === 0) {
          resolve(null);
          return;
        }
        canvas.toBlob(
          (blob) => resolve(blob),
          "image/jpeg",
          0.75
        );
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * Resume the Web Audio output graph after autoplay policy or visibility suspension.
   * Safe to call repeatedly; no-ops when contexts are already running.
   */
  resumeAudioOutput(): void {
    const tryResume = (c: AudioContext | undefined | null) => {
      if (c?.state === "suspended") void c.resume().catch(() => { /* best-effort */ });
    };
    tryResume(this._audioWorkletCtx);
    type AlCtx = { audioCtx?: AudioContext };
    const alCtx = window.EJS_emulator?.Module?.AL?.currentCtx as AlCtx | undefined;
    tryResume(alCtx?.audioCtx);
  }

  setVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    if (this._bridge) {
      this._bridge.setVolume(clamped);
    } else {
      // Bridge not yet initialised; call EJS directly if available
      (window as Window & { EJS_emulator?: { setVolume?: (v: number) => void } }).EJS_emulator?.setVolume?.(clamped);
    }
    // Also update the worklet gain parameter so volume is reflected in the audio graph
    if (this._audioWorkletNode && this._audioWorkletCtx) {
      const gainParam = this._audioWorkletNode.parameters.get("gain");
      if (gainParam) gainParam.setValueAtTime(clamped, this._audioWorkletCtx.currentTime);
    }
  }

  pause(): void {
    if (this._state !== "running") return;
    this._bridge?.pause();
    this._fpsMonitor.stop();
    this._memoryMonitor.stop();
    this._setState("paused");
  }

  resume(): void {
    if (this._state !== "paused") return;
    this._bridge?.resume();
    this._fpsMonitor.start();
    this._memoryMonitor.start();
    this._setState("running");
  }

  /**
   * Enable or update WebGPU post-processing on the emulator canvas.
   *
   * Requires a prior successful preWarmWebGPU() call. The post-processor
   * creates an overlay canvas that displays the processed output while the
   * original WebGL canvas continues rendering underneath.
   *
   * Call with effect "none" to disable processing without tearing down
   * the pipeline (useful for quick toggling during gameplay).
   */
  setPostProcessEffect(effect: PostProcessEffect): void {
    this._postProcessConfig.effect = effect;

    if (this._postProcessor) {
      this._postProcessor.updateConfig({ effect });
    } else if (effect !== "none" && this._webgpuDevice && this._state === "running") {
      this._attachPostProcessor();
    }
  }

  /**
   * Update post-processing parameters (scanline intensity, curvature, etc.)
   * without changing the active effect.
   */
  updatePostProcessConfig(patch: Partial<PostProcessConfig>): void {
    Object.assign(this._postProcessConfig, patch);
    this._postProcessor?.updateConfig(patch);
  }

  /**
   * Capture a screenshot using the async WebGPU readback path.
   * Falls back to the synchronous canvas.toBlob() when the post-processor
   * is not active.
   */
  async captureScreenshotAsync(): Promise<Blob | null> {
    if (this._postProcessor?.active) {
      const blob = await this._postProcessor.captureScreenshotAsync();
      if (blob) return blob;
    }
    return this.captureScreenshot();
  }

  dispose(): void {
    this._teardown();
    this._detachPostProcessor();
    this._releaseWebGPUDevice();
  }

  /**
   * The ROM `File` last wired to EmulatorJS (`EJS_gameUrl`), after iOS-specific
   * materialisation. Null until the first `launch()` that reaches the EJS setup.
   */
  getLaunchGameFile(): File | null {
    return this._launchGameFile;
  }

  // ── Page Visibility ─────────────────────────────────────────────────────────

  /**
   * Auto-pause emulation when the browser tab is hidden.
   * This frees CPU/GPU resources and prevents unnecessary battery drain.
   * Also triggers auto-save when the tab becomes hidden.
   */
  private _installVisibilityHandler(): void {
    this._removeVisibilityHandler();

    this._visibilityHandler = () => {
      if (document.hidden && this._state === "running") {
        this._pausedByVisibility = true;
        this._triggerAutoSave();
        window.EJS_emulator?.pause?.();
        this._fpsMonitor.stop();
        this._memoryMonitor.stop();
        this._setState("paused");
      } else if (!document.hidden && this._pausedByVisibility && this._state === "paused") {
        this._pausedByVisibility = false;
        this._lowFPSStartTime = 0;   // prevent false-positive low-FPS alert after a hidden period
        // ChromeOS tab suspension clears audio; resume all contexts on wake
        this.resumeAudioOutput();
        window.EJS_emulator?.resume?.();
        this._fpsMonitor.start();
        this._memoryMonitor.start();
        this._setState("running");
      } else if (!document.hidden) {
        // Page became visible but wasn't explicitly paused-by-us (e.g. ChromeOS
        // background-tab suspension). Restore audio — the emulator may still have
        // its internal running state.
        this.resumeAudioOutput();
      }
    };

    this._beforeUnloadHandler = () => {
      if (this._state === "running" || this._state === "paused") {
        this._triggerAutoSave();
      }
    };

    // ChromeOS tab-discard fires `pagehide` before evicting the page; its
    // `beforeunload` counterpart may skip the auto-save in some ChromeOS versions.
    this._pageHideHandler = () => {
      if (this._state === "running" || this._state === "paused") {
        this._triggerAutoSave();
      }
    };

    document.addEventListener("visibilitychange", this._visibilityHandler);
    window.addEventListener("beforeunload", this._beforeUnloadHandler);
    window.addEventListener("pagehide", this._pageHideHandler);
  }

  private _removeVisibilityHandler(): void {
    if (this._visibilityHandler) {
      document.removeEventListener("visibilitychange", this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._beforeUnloadHandler) {
      window.removeEventListener("beforeunload", this._beforeUnloadHandler);
      this._beforeUnloadHandler = null;
    }
    if (this._pageHideHandler) {
      window.removeEventListener("pagehide", this._pageHideHandler);
      this._pageHideHandler = null;
    }
    this._pausedByVisibility = false;
  }

  /**
   * Trigger the auto-save callback. Called on tab close / visibility hidden.
   * The actual persistence is handled by the callback owner (main.ts).
   */
  private _triggerAutoSave(): void {
    try {
      this.quickSave(0);
      this.onAutoSave?.();
    } catch {
      // Auto-save is best-effort — must never interfere with teardown
    }
  }

  // ── WebGL context loss ───────────────────────────────────────────────────────

  /**
   * Listen for WebGL context loss on the emulator canvas.
   *
   * On memory-constrained devices (Chromebooks, phones) the browser may
   * reclaim the GPU context under pressure. When this happens we emit a
   * user-visible error and reset to idle so the user can relaunch.
   */
  private _installContextLossHandler(): void {
    this._removeContextLossHandler();

    const playerEl = document.getElementById(this._playerId);
    if (!playerEl) return;

    const canvas = playerEl.querySelector("canvas");
    if (!canvas) return;

    this._contextLossHandler = (event?: Event) => {
      event?.preventDefault();
      this._fpsMonitor.stop();
      this._removeVisibilityHandler();
      this._emitError(
        "WebGL context lost — the GPU ran out of memory or was reset.\n\n" +
        "This can happen on low-memory devices under heavy load.\n" +
        "Return to the library and relaunch the game to recover."
      );
    };

    canvas.addEventListener("webglcontextlost", this._contextLossHandler);
  }

  private _removeContextLossHandler(): void {
    if (!this._contextLossHandler) return;
    const playerEl = document.getElementById(this._playerId);
    const canvas = playerEl?.querySelector("canvas");
    if (canvas) {
      canvas.removeEventListener("webglcontextlost", this._contextLossHandler);
    }
    this._contextLossHandler = null;
  }

  // ── Adaptive quality monitoring ──────────────────────────────────────────────

  /**
   * Called every ~10 frames with the current average FPS.
   *
   * If the average stays below 25 FPS for more than 10 consecutive seconds
   * the game is definitively struggling on this hardware. We fire `onLowFPS`
   * so the UI layer can surface a "Switch to Performance mode?" suggestion.
   * A 60-second cooldown prevents spamming the user during loading screens.
   *
   * When DRS is enabled, sustained low FPS triggers a resolution step-down after a
   * short window (defaults in {@link DRS_SYSTEM_THRESHOLDS} per PSP / PS1 / N64 /
   * NDS / DC). Recovery uses a separate step-up FPS and dwell time per system.
   */
  private _checkAdaptiveQuality(averageFPS: number): void {
    const now = performance.now();

    if (averageFPS > 0 && averageFPS < AQ_LOW_FPS_HZ) {
      if (this._lowFPSStartTime === 0) {
        this._lowFPSStartTime = now;
      }
      if (
        now - this._lowFPSStartTime >= AQ_TRIGGER_MS &&
        now - this._lastQualitySuggestionTime > AQ_COOLDOWN_MS
      ) {
        this._lastQualitySuggestionTime = now;
        this._lowFPSStartTime = 0;
        if (this.verboseLogging) {
          console.warn(
            `[RetroOasis] Sustained low FPS (avg ${averageFPS.toFixed(1)} fps) ` +
            `detected on tier "${this._activeTier ?? "unknown"}". ` +
            "Consider switching to Performance mode for a smoother experience."
          );
        }
        void this.onLowFPS?.(Math.round(averageFPS), this._activeTier);
      }
    } else {
      this._lowFPSStartTime = 0;
    }

    // ── DRS tracking ──────────────────────────────────────────────────────
    if (this._drsEnabled && this._drsTotalSteps > 1) {
      this._checkDRS(averageFPS, now);
    }
  }

  /**
   * Check whether DRS should step the resolution down or up.
   * Separated from _checkAdaptiveQuality for clarity.
   * @internal Exposed as private for testing.
   */
  private _checkDRS(averageFPS: number, now: number): void {
    const systemId = this._currentSystem?.id ?? "";
    const ladder   = getResolutionLadder(systemId);
    if (!ladder) return;

    const thresholds = DRS_SYSTEM_THRESHOLDS[systemId];
    const stepDownFps = thresholds?.stepDownFps ?? DRS_STEP_DOWN_FPS;
    const stepUpFps   = thresholds?.stepUpFps   ?? DRS_STEP_UP_FPS;
    const stepDownMs  = thresholds?.stepDownMs   ?? DRS_STEP_DOWN_MS;
    const stepUpMs    = thresholds?.stepUpMs     ?? DRS_STEP_UP_MS;

    if (averageFPS > 0 && averageFPS < stepDownFps) {
      if (this._drsLowFPSStartTime === 0) {
        this._drsLowFPSStartTime = now === 0 ? Number.EPSILON : now;
      }
      this._drsHighFPSStartTime = 0;

      if (
        now - this._drsLowFPSStartTime >= stepDownMs &&
        this._drsCurrentStepIdx > 0
      ) {
        this._drsLowFPSStartTime = 0;
        this._drsCurrentStepIdx--;
        const newValue = ladder.values[this._drsCurrentStepIdx]!;
        this.logDiagnostic(
          "performance",
          `DRS step-down → ${ladder.key}=${newValue} (step ${this._drsCurrentStepIdx}/${ladder.values.length - 1})`
        );
        if (this.verboseLogging) {
          console.info(
            `[RetroOasis] DRS: low FPS (${averageFPS.toFixed(1)}) — stepping down ` +
            `${ladder.key} to "${newValue}" (step ${this._drsCurrentStepIdx}).`
          );
        }
        this.onDRSChange?.(ladder.key, newValue, this._drsCurrentStepIdx, "down");
      }
    } else if (averageFPS >= stepUpFps && this._drsCurrentStepIdx < ladder.values.length - 1) {
      if (this._drsHighFPSStartTime === 0) {
        this._drsHighFPSStartTime = now === 0 ? Number.EPSILON : now;
      }
      this._drsLowFPSStartTime = 0;

      if (now - this._drsHighFPSStartTime >= stepUpMs) {
        this._drsHighFPSStartTime = 0;
        this._drsCurrentStepIdx++;
        const newValue = ladder.values[this._drsCurrentStepIdx]!;
        this.logDiagnostic(
          "performance",
          `DRS step-up → ${ladder.key}=${newValue} (step ${this._drsCurrentStepIdx}/${ladder.values.length - 1})`
        );
        if (this.verboseLogging) {
          console.info(
            `[RetroOasis] DRS: good FPS (${averageFPS.toFixed(1)}) — stepping up ` +
            `${ladder.key} to "${newValue}" (step ${this._drsCurrentStepIdx}).`
          );
        }
        this.onDRSChange?.(ladder.key, newValue, this._drsCurrentStepIdx, "up");
      }
    } else {
      // FPS is in the acceptable range — reset both timers
      this._drsLowFPSStartTime  = 0;
      this._drsHighFPSStartTime = 0;
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _setState(s: EmulatorState): void {
    // Clear the launch watchdog whenever we leave the loading state.
    if (s !== "loading" && this._launchTimeoutId !== null) {
      clearTimeout(this._launchTimeoutId);
      this._launchTimeoutId = null;
    }
    this._state = s;
    this.onStateChange?.(s);
  }

  private _emit(cb: "onProgress" | "onError", msg: string): void {
    if (cb === "onProgress") this.onProgress?.(msg);
    else                     this.onError?.(msg);
  }

  private _emitError(msg: string): void {
    this._setState("error");
    this.onError?.(msg);
  }

  private _validateFileExt(fileName: string, system: SystemInfo, skipCheck?: boolean): boolean {
    if (skipCheck) return true;
    // Use lastIndexOf to correctly handle filenames without dots (split(".").pop()
    // would return the whole name, not an empty string, for extensionless files).
    // Also reject filenames that are just "." or end with "." (empty extension).
    const dotIdx = fileName.lastIndexOf(".");
    const ext = (dotIdx > 0 && dotIdx < fileName.length - 1)
      ? fileName.substring(dotIdx + 1).toLowerCase()
      : "";
    if (!system.extensions.includes(ext)) {
      this._emitError(
        `Unsupported file type ".${ext}" for ${system.name}.\n` +
        `Accepted formats: ${system.extensions.map(e => `.${e}`).join(", ")}`
      );
      return false;
    }
    return true;
  }

  private _checkSharedArrayBuffer(): boolean {
    if (typeof SharedArrayBuffer !== "undefined") return true;

    // iOS: all browsers on iOS/iPadOS use WebKit and lack the `credentialless`
    // COEP value needed for cross-origin isolation, so SharedArrayBuffer is
    // unavailable for PSP on iOS regardless of server headers.
    if (isLikelyIOS()) {
      this._emitError(
        "PSP emulation is not supported on iPhone/iPad.\n\n" +
        "iOS Safari and Chrome (both WebKit-based) do not yet support the " +
        "cross-origin isolation required for PSP's multi-threading.\n\n" +
        "• Many other systems work great on iPhone/iPad: try NES, SNES, GBA, N64, and more.\n" +
        "• For PSP: use a desktop browser such as Chrome or Firefox on a Mac or PC."
      );
      return false;
    }

    // Desktop Safari: `credentialless` COEP was added in Safari 17. Earlier
    // versions cannot achieve cross-origin isolation and therefore cannot run
    // PSP. Safari 17+ should work once the correct COOP/COEP headers are
    // served — if it still fails, the service worker may not have activated yet.
    const safariVersion = getSafariVersion();
    if (safariVersion !== null) {
      if (safariVersion < 17) {
        this._emitError(
          `PSP emulation requires Safari 17 or later (you appear to be on Safari ${safariVersion}).\n\n` +
          "Safari added support for the required cross-origin isolation in version 17.\n\n" +
          "• Update Safari in System Settings → General → Software Update.\n" +
          "• Or switch to Chrome or Firefox for PSP emulation."
        );
      } else {
        this._emitError(
          "PSP emulation is not available in this browser session.\n\n" +
          "Safari 17+ supports PSP, but SharedArrayBuffer is not available — " +
          "this usually means the Cross-Origin Isolation headers are missing.\n\n" +
          "• Try reloading the page — the service worker may still be activating.\n" +
          "• In production: ensure coi-serviceworker.js is installed and responding.\n" +
          "• Check that COOP and COEP headers are set on the server."
        );
      }
      return false;
    }

    this._emitError(
      "SharedArrayBuffer is not available.\n\n" +
      "This system requires worker threads, which need Cross-Origin Isolation " +
      "(COOP + COEP headers).\n\n" +
      "• In dev: make sure you are running `npm run dev`.\n" +
      "• In production: coi-serviceworker.js should activate automatically.\n" +
      "• Try reloading the page once the service worker is registered."
    );
    return false;
  }

  private _checkWebGL2(): boolean {
    if (cachedWebGL2Support === null) {
      try {
        const canvas = document.createElement("canvas");
        cachedWebGL2Support = !!canvas.getContext("webgl2");
      } catch {
        cachedWebGL2Support = false;
      }
    }

    if (cachedWebGL2Support) return true;

    const experimentalNotice = this._currentSystem?.experimental && this._currentSystem.stabilityNotice
      ? `\n\n${this._currentSystem.stabilityNotice}`
      : "";

    this._emitError(
      "WebGL 2 is not available in your browser.\n\n" +
      "This system requires WebGL 2 for rendering. Please:\n" +
      "• Use Chrome 58+ or Firefox 51+.\n" +
      "• Enable hardware acceleration in browser settings.\n" +
      "• Update your GPU drivers." +
      experimentalNotice
    );
    return false;
  }

  /**
   * Tear down the current EJS session so a new game can be launched.
   * Removes the injected loader script, clears the player element, and
   * resets all EJS globals so the loader re-initialises cleanly.
   */
  private _teardown(): void {
    // Cancel any pending launch watchdog before resetting state.
    if (this._launchTimeoutId !== null) {
      clearTimeout(this._launchTimeoutId);
      this._launchTimeoutId = null;
    }
    // Cancel any active per-game shader warmup window.
    if (this._shaderWarmupTimerId !== null) {
      clearTimeout(this._shaderWarmupTimerId);
      this._shaderWarmupTimerId = null;
    }
    shaderCache.endWarmupWindow();
    this._fpsMonitor.stop();
    this._memoryMonitor.stop();
    this._removeVisibilityHandler();
    this._removeContextLossHandler();
    this._resetAdaptiveQualityState();
    this._detachPostProcessor();
    this._revokeBlobUrl();
    this._disconnectAudioWorklet();
    // Reset per-session audio counters so a new game starts from zero.
    this._audioUnderruns = 0;
    this._lastAudioUnderrunWarnTime = 0;
    document.querySelector("script[data-ejs-loader]")?.remove();
    const playerEl = document.getElementById(this._playerId);
    if (playerEl) playerEl.innerHTML = "";
    this._bridge = null;
    const ejsWindow = window as Partial<Window>;
    delete ejsWindow.EJS_emulator;
    delete ejsWindow.EJS_ready;
    delete ejsWindow.EJS_onGameStart;
    delete ejsWindow.EJS_onExit;
    delete ejsWindow.EJS_player;
    delete ejsWindow.EJS_core;
    delete ejsWindow.EJS_gameUrl;
    delete ejsWindow.EJS_gameName;
    delete ejsWindow.EJS_pathtodata;
    delete ejsWindow.EJS_startOnLoaded;
    delete ejsWindow.EJS_threads;
    delete ejsWindow.EJS_volume;
    delete ejsWindow.EJS_DEBUG_XX;
    delete ejsWindow.EJS_paths;
    delete ejsWindow.EJS_biosUrl;
    delete ejsWindow.EJS_corePath;
    delete ejsWindow.EJS_cheatPath;
    delete ejsWindow.EJS_disableAutoUnload;
    delete ejsWindow.EJS_askBeforeExit;
    delete ejsWindow.EJS_fixedSaveInterval;
    delete ejsWindow.EJS_disableBatchBootup;
    delete ejsWindow.EJS_disableCue;
    delete ejsWindow.EJS_defaultOptions;
    delete ejsWindow.EJS_Settings;
    delete ejsWindow.EJS_netplayServer;
    delete ejsWindow.EJS_netplayICEServers;
    delete ejsWindow.EJS_gameID;
    delete ejsWindow.EJS_roomKey;
    delete ejsWindow.EJS_netplayRoom;
    delete ejsWindow.EJS_playerName;
    this._currentSystem = null;
    this._activeTier = null;
    this._activeCoreSettings = null;
    this._launchGameFile = null;
    this._setState("idle");
  }

  /** Reset low-FPS detection timers for a new emulator session. */
  private _resetAdaptiveQualityState(): void {
    this._lowFPSStartTime = 0;
    this._lastQualitySuggestionTime = Number.NEGATIVE_INFINITY;
    // Reset DRS tracking timers (but preserve _drsEnabled and _drsCurrentStepIdx
    // so a caller-set initial step survives a reset).
    this._drsLowFPSStartTime  = 0;
    this._drsHighFPSStartTime = 0;
  }

  private _disconnectAudioWorklet(): void {
    // Remove any enhancement filter first to clean up its graph connections.
    this._removeAudioFilter();
    try {
      this._audioWorkletNode?.disconnect();
    } catch { /* ignore */ }
    try {
      this._audioAnalyserNode?.disconnect();
    } catch { /* ignore */ }
    this._audioWorkletNode = null;
    this._audioAnalyserNode = null;
    this._audioLevel = 0;
    // Close the AudioContext only when we created it (not shared with EJS).
    if (this._audioWorkletCtxOwned && this._audioWorkletCtx) {
      this._audioWorkletCtx.close().catch(() => { /* best-effort */ });
    }
    this._audioWorkletCtx = null;
    this._audioWorkletCtxOwned = false;
  }

  /**
   * Handle a message from the AudioWorklet processor port.
   *
   * Extracted into a named method so tests can exercise the production
   * handler directly without having to stand up a real AudioWorklet
   * environment. The underrun branch is rate-limited to at most one
   * console.warn per 10 seconds to prevent log spam on slow hardware.
   *
   * @internal Exposed as private for testing only.
   */
  private _onAudioWorkletMessage(e: MessageEvent<{ type: string; count: number; rms: number }>): void {
    if (e.data.type === "underrun") {
      this._audioUnderruns += e.data.count;
      this.onAudioUnderrun?.(this._audioUnderruns);
      // Rate-limit the console warning to at most once per 10 s to prevent
      // log spam on slow hardware where underruns can fire every frame.
      const now = performance.now();
      if (now - this._lastAudioUnderrunWarnTime >= 10_000) {
        this._lastAudioUnderrunWarnTime = now;
        console.warn(
          `[RetroOasis] Audio underrun detected (${e.data.count} new, ` +
          `${this._audioUnderruns} total). ` +
          "Consider increasing the audio buffer size."
        );
      }
    } else if (e.data.type === "level") {
      this._audioLevel = e.data.rms;
      this.onAudioLevel?.(e.data.rms);
    }
  }

  /**
   * Attach the WebGPU post-processing pipeline to the emulator canvas.
   * Called when a game starts and post-processing is enabled.
   */
  private _attachPostProcessor(): void {
    if (!this._webgpuDevice || this._postProcessor) return;
    if (this._postProcessConfig.effect === "none") return;

    const playerEl = document.getElementById(this._playerId);
    if (!playerEl) return;
    const canvas = playerEl.querySelector("canvas");
    if (!canvas) return;

    try {
      const postProcessor = new WebGPUPostProcessor(
        this._webgpuDevice,
        this._postProcessConfig,
      );

      // Re-initialise WebGPU and re-attach the post-processor if the GPU
      // device is lost (driver crash, GPU reset, tab backgrounded on mobile).
      postProcessor.onDeviceLost = () => {
        this._postProcessor = null;
        this._webgpuDevice = null;
        this._webgpuPreWarmed = false;
        const powerPref = this._activeTier === "low" ? "low-power" : "high-performance";
        this.preWarmWebGPU(powerPref).then(() => {
          if (this._webgpuDevice && this._state === "running") {
            this._attachPostProcessor();
          }
        }).catch(() => { /* recovery is best-effort */ });
      };

      postProcessor.attach(canvas, playerEl);
      if (!postProcessor.active) {
        postProcessor.dispose();
        const reason = "WebGPU post-processing requested but could not be activated.";
        console.warn(`[RetroOasis] ${reason}`);
        this.onPostProcessorFallback?.(reason);
        return;
      }
      this._postProcessor = postProcessor;
      console.info(
        `[RetroOasis] WebGPU post-processing active — effect: ${this._postProcessConfig.effect}`
      );
    } catch (err) {
      console.warn("[RetroOasis] Failed to attach WebGPU post-processor:", err);
      this._postProcessor = null;
    }
  }

  /**
   * Detach and dispose of the WebGPU post-processing pipeline.
   * Called on teardown or when the user disables post-processing entirely.
   */
  private _detachPostProcessor(): void {
    this._postProcessor?.dispose();
    this._postProcessor = null;
  }

  /**
   * Release the WebGPU device and adapter metadata.
   * Called only from dispose() — NOT from _teardown() — because the device
   * is intentionally kept alive across game launches within the same session.
   */
  private _releaseWebGPUDevice(): void {
    try {
      this._webgpuDevice?.destroy();
    } catch { /* best-effort */ }
    this._webgpuDevice = null;
    this._webgpuAdapterInfo = null;
  }

  private _revokeBlobUrl(): void {
    if (this._blobUrl) {
      URL.revokeObjectURL(this._blobUrl);
      this._blobUrl = null;
    }
    if (typeof this._biosUrl === "string" && this._biosUrl.startsWith("blob:")) {
      URL.revokeObjectURL(this._biosUrl);
    }
    this._biosUrl = null;
  }

  /**
   * Inject the EmulatorJS loader script.
   *
   * `_teardown()` removes the script before each new launch so this will
   * always inject a fresh copy. The early-return guard here is a safety net
   * for unexpected double-injection (e.g. race conditions during rapid
   * successive launches).
   */
  private _loadScript(src: string): Promise<void> {
    // Return the cached promise when an injection is already in progress or
    // the script has already been injected, preventing double-injection.
    if (this._scriptLoadPromise) return this._scriptLoadPromise;
    if (document.querySelector("script[data-ejs-loader]")) {
      return Promise.resolve();
    }

    const promise = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      let scriptOrigin = window.location.origin;
      if (typeof URL === "function") {
        scriptOrigin = new URL(src, window.location.href).origin;
      } else {
        const urlParser = document.createElement("a");
        urlParser.href = src;
        scriptOrigin = urlParser.origin;
      }
      if (scriptOrigin !== window.location.origin) {
        script.crossOrigin = "anonymous";
      }
      script.setAttribute("data-ejs-loader", "true");
      script.onload  = () => resolve();
      script.onerror = () =>
        reject(new Error(
          `Could not load EmulatorJS from CDN.\n` +
          `URL: ${src}\n\n` +
          `Check your internet connection. If the CDN is down, try again later.`
        ));
      document.body.appendChild(script);
    }).finally(() => {
      // Clear the cached promise so a future _teardown+relaunch picks a
      // fresh one — the script will have been removed by _teardown() then.
      this._scriptLoadPromise = null;
    });
    this._scriptLoadPromise = promise;
    return promise;
  }
}
