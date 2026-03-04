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
 *   - Per-system core prefetching: eagerly fetch both JS glue + WASM cores
 *   - WASM streaming compilation: triggers ahead-of-time compile via fetch()
 *   - Blob-direct launch: accepts Blob directly, skipping File copy overhead
 *   - Tier-aware settings: picks the right core config per hardware tier
 *   - Audio latency adaptation: tunes audio buffer based on detected HW latency
 *   - Page Visibility API: auto-pauses when tab is hidden to save resources
 *   - WebGL context pre-warming: reduces cold-start jank on first launch
 *   - FPS monitoring: ring-buffer-based framerate tracking via rAF
 *   - Adaptive quality suggestions: logs warnings when sustained FPS is low
 *   - Memory-aware blob management: revokes URLs promptly, warns on large ROMs
 */

import { getSystemById, type SystemInfo } from "./systems.js";
import {
  resolveMode, resolveTier, detectAudioCapabilities,
  type PerformanceMode, type DeviceCapabilities, type PerformanceTier,
} from "./performance.js";
import { shaderCache } from "./shaderCache.js";
import type { NetplayManager } from "./multiplayer.js";
import {
  WebGPUPostProcessor,
  buildEffectPipeline,
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
    EJS_DEBUG_XX:      boolean;
    EJS_Settings?:     Record<string, string>;
    EJS_biosUrl?:      string;
    EJS_ready?:        () => void;
    EJS_onGameStart?:  () => void;
    EJS_emulator?:     EJSEmulatorInstance;
    /** Netplay signalling server WebSocket URL (set when netplay is active). */
    EJS_netplayServer?:     string;
    /** ICE server list forwarded to WebRTC peer connections. */
    EJS_netplayICEServers?: RTCIceServer[];
    /** Numeric room-scoping ID derived from the game's string identifier. */
    EJS_gameID?:            number;
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
    getSaveFile?(): Uint8Array | null;
    loadSaveFile?(data: Uint8Array): void;
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
      stat(path: string): { size: number };
      readdir(path: string): string[];
      unlink(path: string): void;
      analyzePath(path: string): { exists: boolean; object?: unknown };
    };
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const EJS_CDN_BASE = "https://cdn.emulatorjs.org/stable/data/";

/** Warn when a ROM file exceeds this size (500 MB). */
const LARGE_ROM_THRESHOLD = 500 * 1024 * 1024;

// Adaptive quality thresholds — moved here so they are not reconstructed on
// every _checkAdaptiveQuality() call (which fires every ~10 frames).
const AQ_LOW_FPS_HZ   = 25;        // FPS floor before the timer starts
const AQ_TRIGGER_MS   = 10_000;    // sustained low-FPS window before alert
const AQ_COOLDOWN_MS  = 60_000;    // minimum gap between successive alerts

let cachedWebGL2Support: boolean | null = null;

/**
 * Maps EJS core ids to their CDN core filenames for prefetching.
 *
 * Each 3D core entry includes both the JS glue module and the .wasm binary.
 * Prefetching both ensures they land in the browser HTTP cache before the
 * user launches a game, eliminating the largest download delay (10–30 MB).
 *
 * The .wasm files are also eligible for WebAssembly streaming compilation
 * (triggered separately in prefetchCore) which lets the browser compile
 * the WASM ahead-of-time while it is still downloading.
 */
const CORE_PREFETCH_MAP: Record<string, { js: string; wasm: string }> = {
  psp: {
    js:   "cores/ppsspp_libretro.js",
    wasm: "cores/ppsspp_libretro.wasm",
  },
  n64: {
    js:   "cores/mupen64plus_next_libretro.js",
    wasm: "cores/mupen64plus_next_libretro.wasm",
  },
  psx: {
    js:   "cores/mednafen_psx_hw_libretro.js",
    wasm: "cores/mednafen_psx_hw_libretro.wasm",
  },
  nds: {
    js:   "cores/desmume2015_libretro.js",
    wasm: "cores/desmume2015_libretro.wasm",
  },
  gba: {
    js:   "cores/mgba_libretro.js",
    wasm: "cores/mgba_libretro.wasm",
  },
  // ── Phase 3 additions ────────────────────────────────────────────────────
  segaSaturn: {
    js:   "cores/mednafen_saturn_libretro.js",
    wasm: "cores/mednafen_saturn_libretro.wasm",
  },
  segaDC: {
    js:   "cores/flycast_libretro.js",
    wasm: "cores/flycast_libretro.wasm",
  },
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
  private _running = false;
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
   * Blob URL for the system BIOS file (e.g. PS1 SCPH-5501, Saturn BIOS).
   * Set EJS_biosUrl when provided. The emulator takes ownership of revoking
   * this URL when the session ends. If the launch fails due to a preflight
   * error (unknown system, bad file extension, etc.) the emulator will not
   * have stored the URL, so the caller must perform a defensive revoke.
   */
  biosUrl?: string;
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
  private _contextLossHandler: (() => void) | null = null;
  private _pausedByVisibility = false;
  private _preconnected = false;
  private _activeTier: PerformanceTier | null = null;
  private _biosUrl: string | null = null;
  private _prefetchedCores = new Set<string>();
  private _webglPreWarmed = false;
  private _pspPipelineWarmed = false;
  private _webgpuDevice: GPUDevice | null = null;
  private _webgpuPreWarmed = false;
  private _webgpuAdapterInfo: WebGPUAdapterInfo | null = null;
  private _postProcessor: WebGPUPostProcessor | null = null;
  private _postProcessConfig: PostProcessConfig = { ...DEFAULT_POST_PROCESS_CONFIG };
  private _audioWorkletCtx: AudioContext | null = null;
  private _audioWorkletCtxOwned = false;
  private _audioWorkletNode: AudioWorkletNode | null = null;
  private _audioAnalyserNode: AnalyserNode | null = null;
  private _audioUnderruns = 0;
  private _audioLevel = 0;
  /** Timestamp (ms) when sustained low FPS was first detected; 0 when FPS is healthy. */
  private _lowFPSStartTime = 0;
  /**
   * Timestamp (ms) of the last low-FPS quality suggestion, to debounce warnings.
   * Initialised to -Infinity so the very first suggestion can always fire
   * regardless of how soon after page-load the game is launched (avoids the
   * 60-second page-age requirement that would arise from using 0 as the sentinel).
   */
  private _lastQualitySuggestionTime = Number.NEGATIVE_INFINITY;
  /** Timer ID for the launch watchdog — clears when the game starts or errors. */
  private _launchTimeoutId: ReturnType<typeof setTimeout> | null = null;

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
   * Fired when auto-save is triggered (tab close / visibility hidden).
   * The handler should persist the save state asynchronously.
   */
  onAutoSave?: () => void;

  constructor(playerId: string) {
    this._playerId = playerId;
    this._fpsMonitor = new FPSMonitor(60);
  }

  get state(): EmulatorState { return this._state; }
  get currentSystem(): SystemInfo | null { return this._currentSystem; }
  get activeTier(): PerformanceTier | null { return this._activeTier; }
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
   * Prefetches both the JS glue module and the .wasm binary, and additionally
   * attempts WebAssembly streaming compilation of the .wasm so the browser
   * can compile it ahead-of-time while it downloads — further cutting startup
   * latency when the user eventually launches a game.
   *
   * Call this when the user's library contains games for a given system,
   * or when hovering over a game card for that system.
   */
  prefetchCore(systemId: string): void {
    if (this._prefetchedCores.has(systemId)) return;
    const corePaths = CORE_PREFETCH_MAP[systemId];
    if (!corePaths) return;

    this._prefetchedCores.add(systemId);

    const jsUrl   = `${EJS_CDN_BASE}${corePaths.js}`;
    const wasmUrl = `${EJS_CDN_BASE}${corePaths.wasm}`;

    // Prefetch the JS glue
    if (!document.querySelector(`link[href="${jsUrl}"]`)) {
      const jsLink = document.createElement("link");
      jsLink.rel = "prefetch";
      jsLink.href = jsUrl;
      jsLink.as = "script";
      jsLink.crossOrigin = "anonymous";
      document.head.appendChild(jsLink);
    }

    // Prefetch the WASM binary
    if (!document.querySelector(`link[href="${wasmUrl}"]`)) {
      const wasmLink = document.createElement("link");
      wasmLink.rel = "prefetch";
      wasmLink.href = wasmUrl;
      wasmLink.as = "fetch";
      wasmLink.crossOrigin = "anonymous";
      document.head.appendChild(wasmLink);
    }

    // Attempt streaming WASM compilation: fetch + compile in parallel so the
    // compiled module is ready before the JS glue code requests it.
    // This is best-effort — failures are silently ignored.
    if (typeof WebAssembly?.compileStreaming === "function") {
      fetch(wasmUrl, { mode: "cors", credentials: "omit" })
        .then(res => WebAssembly.compileStreaming(res))
        .catch(() => { /* streaming compile failed — loader will compile at runtime */ });
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
   */
  preWarmWebGL(): void {
    if (this._webglPreWarmed) return;
    this._webglPreWarmed = true;

    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return;

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
   */
  warmUpPSPPipeline(): void {
    if (this._pspPipelineWarmed) return;
    this._pspPipelineWarmed = true;

    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return;

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
        const vs = gl.createShader(gl.VERTEX_SHADER)!;
        gl.shaderSource(vs, vsSrc);
        gl.compileShader(vs);

        const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
        gl.shaderSource(fs, fsSrc);
        gl.compileShader(fs);

        const prog = gl.createProgram()!;
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
      if (!gpu) return;

      const adapter = await gpu.requestAdapter({
        powerPreference,
      });
      if (!adapter) return;

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

      const device = await adapter.requestDevice();
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
        // acquired and the compute queue is still warmed below.
      }

      // Submit a trivial compute pass to warm the GPU command queue
      const encoder = device.createCommandEncoder();
      const passEncoder = encoder.beginComputePass();
      passEncoder.end();
      device.queue.submit([encoder.finish()]);

      // Pre-compile all post-process pipelines so the first activation of
      // WebGPU post-processing has no shader stall. Also record their WGSL
      // sources in the persistent cache so they can be re-warmed on subsequent
      // launches via preCompileWGSL().
      try {
        const presentFormat = navigator.gpu.getPreferredCanvasFormat();
        for (const effect of ["crt", "sharpen", "lcd", "bloom", "fxaa"] as const) {
          buildEffectPipeline(device, effect, presentFormat);
        }
        // Persist the pipeline WGSL sources for future sessions
        void shaderCache.preCompileWGSL(device);
      } catch {
        // Post-process pipeline pre-compilation is best-effort
      }

      const adapterLabel =
        this._webgpuAdapterInfo?.device  ||
        this._webgpuAdapterInfo?.vendor  ||
        "unknown adapter";
      console.info(
        `[RetroVault] WebGPU device acquired (${adapterLabel}) — ` +
        "GPU command queue and shader compiler warmed."
      );
    } catch {
      // WebGPU unavailable or not yet supported — silently fall back to WebGL
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
   * @param workletBaseUrl  Base URL for loading audio-processor.js (pass
   *                        `import.meta.url` or the app origin).
   */
  async setupAudioWorklet(workletBaseUrl: string): Promise<boolean> {
    if (!("AudioWorkletNode" in window)) return false;

    try {
      // Prefer the game's OpenAL context so we're in the same audio graph
      const ejsCtx = window.EJS_emulator?.Module?.AL?.currentCtx?.audioCtx;
      const ctx = ejsCtx ?? new AudioContext({ latencyHint: "playback" });
      const ctxOwned = !ejsCtx;

      // Resume a suspended context (may happen due to autoplay policy)
      if (ctx.state === "suspended") {
        await ctx.resume().catch(() => { /* best-effort */ });
      }

      const processorUrl = new URL("/audio-processor.js", workletBaseUrl).href;
      await ctx.audioWorklet.addModule(processorUrl);

      const workletNode = new AudioWorkletNode(ctx, "retrovault-audio-processor");

      workletNode.port.onmessage = (e: MessageEvent<{ type: string; count: number; rms: number }>) => {
        if (e.data.type === "underrun") {
          this._audioUnderruns += e.data.count;
          this.onAudioUnderrun?.(this._audioUnderruns);
          console.warn(
            `[RetroVault] Audio underrun detected (${e.data.count} new, ` +
            `${this._audioUnderruns} total). ` +
            "Consider increasing the audio buffer size."
          );
        } else if (e.data.type === "level") {
          this._audioLevel = e.data.rms;
          this.onAudioLevel?.(e.data.rms);
        }
      };

      // AnalyserNode sits after the worklet so the UI can visualise post-gain output
      const analyserNode = ctx.createAnalyser();
      analyserNode.fftSize = 256;
      analyserNode.smoothingTimeConstant = 0.75;

      if (ejsCtx) {
        // Connect worklet into the EJS audio graph
        const alCtx = window.EJS_emulator?.Module?.AL?.currentCtx;
        if (alCtx?.sources) {
          const gainNodes = Object.values(alCtx.sources).map(s => s.gain);
          gainNodes.forEach(g => g.connect(workletNode));
        }
      }
      workletNode.connect(analyserNode);
      analyserNode.connect(ctx.destination);

      this._audioWorkletCtx  = ctx;
      this._audioWorkletCtxOwned = ctxOwned;
      this._audioWorkletNode = workletNode;
      this._audioAnalyserNode = analyserNode;

      console.info("[RetroVault] AudioWorklet path active — reduced-latency audio enabled.");
      return true;
    } catch {
      // AudioWorklet unavailable or module failed to load — fall back silently
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
   * Pre-compile shader programs cached from previous sessions.
   * Call during startup in an idle callback — runs asynchronously.
   */
  async preWarmShaderCache(): Promise<void> {
    await shaderCache.preCompile();
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

    // Derive the filename - Blob doesn't have .name, so accept it explicitly
    const fileName = opts.fileName
      ?? (opts.file instanceof File ? opts.file.name : "game.bin");

    if (!this._validateFileExt(fileName, system, opts.skipExtensionCheck)) return;

    // ── Large ROM warning ───────────────────────────────────────────────────
    if (opts.file.size > LARGE_ROM_THRESHOLD) {
      console.warn(
        `[RetroVault] Large ROM detected (${(opts.file.size / 1024 / 1024).toFixed(0)} MB). ` +
        `This may cause memory pressure in the browser. Consider using a CSO/compressed format.`
      );
    }

    this._setState("loading");
    this._emit("onProgress", "Preparing game file…");

    if (this.verboseLogging) {
      console.info(
        `[RetroVault] Launching "${fileName}" on system "${opts.systemId}" ` +
        `(size: ${(opts.file.size / 1024 / 1024).toFixed(1)} MB, tier override: ${opts.tierOverride ?? "none"})`
      );
    }

    // ── Probe audio latency in parallel with blob URL creation ─────────────
    // detectAudioCapabilities() is async and short; running it before we reach
    // the EJS globals section means we can use the result to override the
    // audio buffer size if the hardware reports unusually high latency.
    const audioCapabilitiesPromise = detectAudioCapabilities();

    try {
      // Create blob URL directly from the Blob/File — no copy needed
      this._blobUrl = URL.createObjectURL(opts.file);
      const gameName = fileName.replace(/\.[^.]+$/, "");

      this._emit("onProgress", "Initialising EmulatorJS…");

      // ── Resolve performance settings (tier-aware) ───────────────────────
      // tierOverride bypasses auto-detection — used by the tier-downgrade flow
      const tier = opts.tierOverride ?? resolveTier(opts.performanceMode, opts.deviceCaps);
      this._activeTier = tier;
      this._resetAdaptiveQualityState();

      // Reset audio underrun counter and level for the new session
      this._audioUnderruns = 0;
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

      // ── Audio latency adaptation ─────────────────────────────────────────
      // Override the audio buffer size from tier defaults when the hardware
      // reports a different latency profile.  This prevents crackles on
      // Bluetooth/USB audio devices (high base latency) and allows the
      // minimum buffer on DACs with very low output latency.
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
          console.info(
            `[RetroVault] Audio: hardware latency (${audioCaps.baseLatencyMs?.toFixed(1)} ms) ` +
            `suggests buffer tier "${hwBufTier}"; upgrading ppsspp_audio_latency ` +
            `from ${tierLatency} → ${hwNumeric}.`
          );
        }
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

      if (opts.biosUrl) {
        window.EJS_biosUrl = opts.biosUrl;
        this._biosUrl      = opts.biosUrl;
      } else {
        delete window.EJS_biosUrl;
        this._biosUrl = null;
      }

      // ── Netplay globals ───────────────────────────────────────────────────
      const netplay = opts.netplayManager;
      if (netplay?.isActive && opts.gameId) {
        window.EJS_netplayServer    = netplay.serverUrl;
        window.EJS_netplayICEServers = netplay.iceServers;
        window.EJS_gameID           = netplay.gameIdFor(opts.gameId);
      } else {
        delete window.EJS_netplayServer;
        delete window.EJS_netplayICEServers;
        delete window.EJS_gameID;
      }

      if (Object.keys(ejsSettings).length > 0) {
        window.EJS_Settings = ejsSettings;
      } else {
        delete window.EJS_Settings;
      }

      // ── Lifecycle callbacks ───────────────────────────────────────────────
      window.EJS_ready = () => {
        // Ignore stale callbacks from a torn-down/replaced core instance.
        if (this._state !== "loading") return;
        this._emit("onProgress", "Booting game…");
        if (this.verboseLogging) {
          console.info("[RetroVault] EJS_ready fired — core loaded, booting game.");
        }
      };

      window.EJS_onGameStart = () => {
        // Ignore stale callbacks from a torn-down/replaced core instance.
        if (this._state !== "loading") return;
        if (this.verboseLogging) {
          console.info("[RetroVault] EJS_onGameStart fired — game is running.");
        }
        this._setState("running");
        this._fpsMonitor.onUpdate = (snap) => {
          this.onFPSUpdate?.(snap);
          this._checkAdaptiveQuality(snap.average);
        };
        this._fpsMonitor.start();
        this._installVisibilityHandler();
        this._installContextLossHandler();

        // Attach WebGPU post-processing if enabled and device is available
        if (this._webgpuDevice && this._postProcessConfig.effect !== "none") {
          requestAnimationFrame(() => this._attachPostProcessor());
        }

        this.onGameStart?.();
      };

      // ── Inject / reuse loader.js ──────────────────────────────────────────
      await this._loadScript(`${EJS_CDN_BASE}loader.js`);

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

    const paths = [
      `/home/web_user/retroarch/states/${gameName}.state${slot}`,
      `/home/web_user/retroarch/states/${gameName}.state`,
      `/data/saves/${gameName}.state${slot}`,
    ];

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

    const basePath = "/home/web_user/retroarch/states";
    const statePath = `${basePath}/${gameName}.state${slot}`;

    try {
      try {
        emu.Module.FS.stat(basePath);
      } catch {
        return false;
      }
      emu.Module.FS.writeFile(statePath, data);
      return true;
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

  setVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    window.EJS_emulator?.setVolume(clamped);
    // Also update the worklet gain parameter so volume is reflected in the audio graph
    if (this._audioWorkletNode && this._audioWorkletCtx) {
      const gainParam = this._audioWorkletNode.parameters.get("gain");
      if (gainParam) gainParam.setValueAtTime(clamped, this._audioWorkletCtx.currentTime);
    }
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
        this._setState("paused");
      } else if (!document.hidden && this._pausedByVisibility) {
        this._pausedByVisibility = false;
        window.EJS_emulator?.resume?.();
        this._fpsMonitor.start();
        this._setState("running");
      }
    };

    this._beforeUnloadHandler = () => {
      if (this._state === "running" || this._state === "paused") {
        this._triggerAutoSave();
      }
    };

    document.addEventListener("visibilitychange", this._visibilityHandler);
    window.addEventListener("beforeunload", this._beforeUnloadHandler);
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

  // ── Adaptive quality monitoring ──────────────────────────────────────────────

  /**
   * Called every ~10 frames with the current average FPS.
   *
   * If the average stays below 25 FPS for more than 10 consecutive seconds
   * the game is definitively struggling on this hardware. We fire `onLowFPS`
   * so the UI layer can surface a "Switch to Performance mode?" suggestion.
   * A 60-second cooldown prevents spamming the user during loading screens.
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
            `[RetroVault] Sustained low FPS (avg ${averageFPS.toFixed(1)} fps) ` +
            `detected on tier "${this._activeTier ?? "unknown"}". ` +
            "Consider switching to Performance mode for a smoother experience."
          );
        }
        void this.onLowFPS?.(Math.round(averageFPS), this._activeTier);
      }
    } else {
      this._lowFPSStartTime = 0;
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
    // Cancel any pending launch watchdog before resetting state.
    if (this._launchTimeoutId !== null) {
      clearTimeout(this._launchTimeoutId);
      this._launchTimeoutId = null;
    }
    this._fpsMonitor.stop();
    this._removeVisibilityHandler();
    this._removeContextLossHandler();
    this._resetAdaptiveQualityState();
    this._detachPostProcessor();
    this._revokeBlobUrl();
    this._disconnectAudioWorklet();
    document.querySelector("script[data-ejs-loader]")?.remove();
    const playerEl = document.getElementById(this._playerId);
    if (playerEl) playerEl.innerHTML = "";
    delete window.EJS_emulator;
    delete window.EJS_ready;
    delete window.EJS_onGameStart;
    delete window.EJS_biosUrl;
    delete window.EJS_Settings;
    this._currentSystem = null;
    this._activeTier = null;
    this._setState("idle");
  }

  /** Reset low-FPS detection timers for a new emulator session. */
  private _resetAdaptiveQualityState(): void {
    this._lowFPSStartTime = 0;
    this._lastQualitySuggestionTime = Number.NEGATIVE_INFINITY;
  }

  private _disconnectAudioWorklet(): void {
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
      this._postProcessor = new WebGPUPostProcessor(
        this._webgpuDevice,
        this._postProcessConfig,
      );
      this._postProcessor.attach(canvas, playerEl);
      console.info(
        `[RetroVault] WebGPU post-processing active — effect: ${this._postProcessConfig.effect}`
      );
    } catch (err) {
      console.warn("[RetroVault] Failed to attach WebGPU post-processor:", err);
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
    if (this._biosUrl) {
      URL.revokeObjectURL(this._biosUrl);
      this._biosUrl = null;
    }
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
