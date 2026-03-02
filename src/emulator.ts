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
 *   - Per-system core prefetching: eagerly fetch WASM cores before launch
 *   - Blob-direct launch: accepts Blob directly, skipping File copy overhead
 *   - Tier-aware settings: picks the right PPSSPP config per hardware tier
 *   - Page Visibility API: auto-pauses when tab is hidden to save resources
 *   - WebGL context pre-warming: reduces cold-start jank on first launch
 *   - FPS monitoring: ring-buffer-based framerate tracking via rAF
 *   - Memory-aware blob management: revokes URLs promptly, warns on large ROMs
 */

import { getSystemById, type SystemInfo } from "./systems.js";
import {
  resolveMode, resolveTier,
  type PerformanceMode, type DeviceCapabilities, type PerformanceTier,
} from "./performance.js";

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
    EJS_DEBUG_XX:      boolean;
    EJS_Settings?:     Record<string, string>;
    EJS_ready?:        () => void;
    EJS_onGameStart?:  () => void;
    EJS_emulator?:     EJSEmulatorInstance;
  }
}

interface EJSEmulatorInstance {
  setVolume(volume: number): void;
  pause?(): void;
  resume?(): void;
  gameManager?: {
    restart(): void;
    quickSave(slot: number): boolean;
    quickLoad(slot: number): void;
    supportsStates(): boolean;
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const EJS_CDN_BASE = "https://cdn.emulatorjs.org/stable/data/";

/** Warn when a ROM file exceeds this size (500 MB). */
const LARGE_ROM_THRESHOLD = 500 * 1024 * 1024;

let cachedWebGL2Support: boolean | null = null;

/**
 * Maps EJS core ids to their CDN core filenames for prefetching.
 * These are the most performance-critical (3D) cores that benefit
 * from being in the browser cache before the user launches a game.
 */
const CORE_PREFETCH_MAP: Record<string, string> = {
  psp:    "cores/ppsspp_libretro.js",
  n64:    "cores/mupen64plus_next_libretro.js",
  psx:    "cores/mednafen_psx_hw_libretro.js",
  nds:    "cores/desmume2015_libretro.js",
};

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
}

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
  private _enabled = false;
  private _onUpdate?: (snapshot: FPSSnapshot) => void;
  private _frameCount = 0;

  private readonly _windowSize: number;
  private readonly _ring: Float64Array;
  private _ringHead = 0;
  private _ringCount = 0;

  constructor(targetFPS = 60) {
    this._targetFPS = targetFPS;
    this._windowSize = 60;
    this._ring = new Float64Array(this._windowSize);
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
    this._lastTime = performance.now();
    this._enabled = true;
    this._tick = this._tick.bind(this);
    this._rafId = requestAnimationFrame(this._tick);
  }

  stop(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._enabled = false;
  }

  setCallbackEnabled(active: boolean): void {
    this._enabled = active;
  }

  getSnapshot(): FPSSnapshot {
    if (this._ringCount === 0) {
      return { current: 0, average: 0, min: 0, max: 0, droppedFrames: 0 };
    }

    const count = this._ringCount;
    const lastIdx = (this._ringHead - 1 + this._windowSize) % this._windowSize;
    const lastDelta = this._ring[lastIdx];
    const current = lastDelta > 0 ? 1000 / lastDelta : 0;

    let sum = 0;
    let maxDelta = 0;
    let minDelta = Infinity;
    for (let i = 0; i < count; i++) {
      const idx = (this._ringHead - count + i + this._windowSize) % this._windowSize;
      const d = this._ring[idx];
      sum += d;
      if (d > maxDelta) maxDelta = d;
      if (d > 0 && d < minDelta) minDelta = d;
    }

    const avgDelta = sum / count;
    const average = avgDelta > 0 ? 1000 / avgDelta : 0;
    const min = maxDelta > 0 ? 1000 / maxDelta : 0;
    const max = isFinite(minDelta) && minDelta > 0 ? 1000 / minDelta : 0;

    return {
      current: Math.round(current),
      average: Math.round(average),
      min: Math.round(min),
      max: isFinite(max) ? Math.round(max) : 0,
      droppedFrames: this._droppedFrames,
    };
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

      if (this._enabled && this._frameCount % 10 === 0) {
        this._onUpdate?.(this.getSnapshot());
      }
    }

    this._rafId = requestAnimationFrame(this._tick);
  }
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
}

// ── PSPEmulator ───────────────────────────────────────────────────────────────

export class PSPEmulator {
  private _state: EmulatorState = "idle";
  private _blobUrl: string | null = null;
  private readonly _playerId: string;
  private _currentSystem: SystemInfo | null = null;
  private _fpsMonitor: FPSMonitor;
  private _visibilityHandler: (() => void) | null = null;
  private _contextLossHandler: (() => void) | null = null;
  private _pausedByVisibility = false;
  private _preconnected = false;
  private _activeTier: PerformanceTier | null = null;
  private _prefetchedCores = new Set<string>();
  private _webglPreWarmed = false;

  onStateChange?: (state: EmulatorState) => void;
  onProgress?:    (msg:   string)        => void;
  onError?:       (msg:   string)        => void;
  onGameStart?:   ()                     => void;
  onFPSUpdate?:   (snapshot: FPSSnapshot) => void;

  constructor(playerId: string) {
    this._playerId = playerId;
    this._fpsMonitor = new FPSMonitor(60);
    this._fpsMonitor.onUpdate = (snap) => this.onFPSUpdate?.(snap);
  }

  get state(): EmulatorState { return this._state; }
  get currentSystem(): SystemInfo | null { return this._currentSystem; }
  get activeTier(): PerformanceTier | null { return this._activeTier; }

  /** Get the current FPS snapshot (call anytime while running). */
  getFPS(): FPSSnapshot { return this._fpsMonitor.getSnapshot(); }

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
    const loaderUrl = `${EJS_CDN_BASE}loader.js`;
    if (document.querySelector(`link[href="${loaderUrl}"]`)) return;

    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = loaderUrl;
    link.as = "script";
    document.head.appendChild(link);
  }

  /**
   * Prefetch the WASM core for a specific system so it's in the browser
   * cache before the user launches a game. This eliminates the largest
   * download delay (10–30 MB WASM files for PSP/N64/PS1).
   *
   * Call this when the user's library contains games for a given system,
   * or when hovering over a game card for that system.
   */
  prefetchCore(systemId: string): void {
    if (this._prefetchedCores.has(systemId)) return;
    const corePath = CORE_PREFETCH_MAP[systemId];
    if (!corePath) return;

    this._prefetchedCores.add(systemId);
    const coreUrl = `${EJS_CDN_BASE}${corePath}`;

    if (document.querySelector(`link[href="${coreUrl}"]`)) return;

    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = coreUrl;
    link.as = "script";
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);
  }

  /**
   * Pre-warm a WebGL context to eliminate cold-start GPU initialization
   * overhead on the first game launch. Creates and immediately destroys
   * a throwaway context so the GPU driver is loaded and ready.
   */
  preWarmWebGL(): void {
    if (this._webglPreWarmed) return;
    this._webglPreWarmed = true;

    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (gl) {
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.flush();
        const ext = gl.getExtension("WEBGL_lose_context");
        ext?.loseContext();
      }
    } catch {
      // Pre-warming is best-effort
    }
  }

  // ── launch ──────────────────────────────────────────────────────────────────

  async launch(opts: LaunchOptions): Promise<void> {
    if (this._state === "loading") {
      this._emitError("Emulator is already loading. Please wait.");
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

    // Derive the filename - Blob doesn't have .name, so accept it explicitly
    const fileName = opts.fileName
      ?? (opts.file instanceof File ? opts.file.name : "game.bin");

    if (!this._validateFileExt(fileName, system)) return;

    // ── Large ROM warning ───────────────────────────────────────────────────
    if (opts.file.size > LARGE_ROM_THRESHOLD) {
      console.warn(
        `[RetroVault] Large ROM detected (${(opts.file.size / 1024 / 1024).toFixed(0)} MB). ` +
        `This may cause memory pressure in the browser. Consider using a CSO/compressed format.`
      );
    }

    this._setState("loading");
    this._emit("onProgress", "Preparing game file…");

    this._revokeBlobUrl();

    try {
      // Create blob URL directly from the Blob/File — no copy needed
      this._blobUrl = URL.createObjectURL(opts.file);
      const gameName = fileName.replace(/\.[^.]+$/, "");

      this._emit("onProgress", "Initialising EmulatorJS…");

      // ── Resolve performance settings (tier-aware) ───────────────────────
      const tier = resolveTier(opts.performanceMode, opts.deviceCaps);
      this._activeTier = tier;

      let ejsSettings: Record<string, string>;

      if (system.tierSettings && system.tierSettings[tier]) {
        ejsSettings = { ...system.tierSettings[tier] };
      } else {
        const mode = resolveMode(opts.performanceMode, opts.deviceCaps);
        ejsSettings = mode === "performance"
          ? { ...system.perfSettings }
          : { ...system.qualitySettings };
      }

      // ── Set EJS globals ───────────────────────────────────────────────────
      window.EJS_player        = `#${this._playerId}`;
      window.EJS_core          = system.id;
      window.EJS_gameUrl       = this._blobUrl;
      window.EJS_gameName      = gameName;
      window.EJS_pathtodata    = EJS_CDN_BASE;
      window.EJS_startOnLoaded = true;
      window.EJS_threads       = system.needsThreads;
      window.EJS_volume        = opts.volume;
      window.EJS_DEBUG_XX      = false;

      if (Object.keys(ejsSettings).length > 0) {
        window.EJS_Settings = ejsSettings;
      } else {
        delete window.EJS_Settings;
      }

      // ── Lifecycle callbacks ───────────────────────────────────────────────
      window.EJS_ready = () => {
        this._emit("onProgress", "Core loaded — booting game…");
      };

      window.EJS_onGameStart = () => {
        this._setState("running");
        this._fpsMonitor.start();
        this._installVisibilityHandler();
        this._installContextLossHandler();
        this.onGameStart?.();
      };

      // ── Inject / reuse loader.js ──────────────────────────────────────────
      await this._loadScript(`${EJS_CDN_BASE}loader.js`);

    } catch (err) {
      this._setState("error");
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

  setVolume(volume: number): void {
    window.EJS_emulator?.setVolume(Math.max(0, Math.min(1, volume)));
  }

  pause(): void {
    if (this._state !== "running") return;
    window.EJS_emulator?.pause?.();
    this._fpsMonitor.stop();
    this._setState("paused");
  }

  resume(): void {
    if (this._state !== "paused") return;
    window.EJS_emulator?.resume?.();
    this._fpsMonitor.start();
    this._setState("running");
  }

  dispose(): void {
    this._teardown();
  }

  // ── Page Visibility ─────────────────────────────────────────────────────────

  /**
   * Auto-pause emulation when the browser tab is hidden.
   * This frees CPU/GPU resources and prevents unnecessary battery drain.
   */
  private _installVisibilityHandler(): void {
    this._removeVisibilityHandler();

    this._visibilityHandler = () => {
      if (document.hidden && this._state === "running") {
        this._pausedByVisibility = true;
        window.EJS_emulator?.pause?.();
        this._fpsMonitor.stop();
        // Don't change _state — the user didn't explicitly pause.
        // We resume transparently when the tab is visible again.
      } else if (!document.hidden && this._pausedByVisibility) {
        this._pausedByVisibility = false;
        window.EJS_emulator?.resume?.();
        this._fpsMonitor.start();
      }
    };

    document.addEventListener("visibilitychange", this._visibilityHandler);
  }

  private _removeVisibilityHandler(): void {
    if (this._visibilityHandler) {
      document.removeEventListener("visibilitychange", this._visibilityHandler);
      this._visibilityHandler = null;
    }
    this._pausedByVisibility = false;
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

    this._contextLossHandler = () => {
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

  // ── Private ─────────────────────────────────────────────────────────────────

  private _setState(s: EmulatorState): void {
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

  private _validateFileExt(fileName: string, system: SystemInfo): boolean {
    const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
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
      const canvas = document.createElement("canvas");
      cachedWebGL2Support = !!canvas.getContext("webgl2");
    }

    if (cachedWebGL2Support) return true;

    this._emitError(
      "WebGL 2 is not available in your browser.\n\n" +
      "This system requires WebGL 2 for rendering. Please:\n" +
      "• Use Chrome 58+ or Firefox 51+.\n" +
      "• Enable hardware acceleration in browser settings.\n" +
      "• Update your GPU drivers."
    );
    return false;
  }

  /**
   * Tear down the current EJS session so a new game can be launched.
   * Removes the injected loader script, clears the player element, and
   * resets all EJS globals so the loader re-initialises cleanly.
   */
  private _teardown(): void {
    this._fpsMonitor.stop();
    this._removeVisibilityHandler();
    this._removeContextLossHandler();
    this._revokeBlobUrl();
    document.querySelector("script[data-ejs-loader]")?.remove();
    const playerEl = document.getElementById(this._playerId);
    if (playerEl) playerEl.innerHTML = "";
    delete window.EJS_emulator;
    delete window.EJS_ready;
    delete window.EJS_onGameStart;
    this._currentSystem = null;
    this._activeTier = null;
    this._setState("idle");
  }

  private _revokeBlobUrl(): void {
    if (this._blobUrl) {
      URL.revokeObjectURL(this._blobUrl);
      this._blobUrl = null;
    }
  }

  /**
   * Inject the EmulatorJS loader script.
   * If it was already injected from a previous game session (same page load)
   * we can't hot-swap systems — the page must be reloaded.
   */
  private _loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (document.querySelector("script[data-ejs-loader]")) {
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.setAttribute("data-ejs-loader", "true");
      script.onload  = () => resolve();
      script.onerror = () =>
        reject(new Error(
          `Could not load EmulatorJS from CDN.\n` +
          `URL: ${src}\n\n` +
          `Check your internet connection. If the CDN is down, try again later.`
        ));
      document.body.appendChild(script);
    });
  }
}
