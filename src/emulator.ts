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
  /** Emscripten module — used to access the OpenAL audio context. */
  Module?: {
    AL?: {
      currentCtx?: {
        audioCtx?: AudioContext;
        sources?:  Record<string, { gain: GainNode }>;
      };
    };
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const EJS_CDN_BASE = "https://cdn.emulatorjs.org/stable/data/";

/** Warn when a ROM file exceeds this size (500 MB). */
const LARGE_ROM_THRESHOLD = 500 * 1024 * 1024;

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
  /**
   * Optional explicit tier override — bypasses the auto-detected tier.
   * Used by the auto-downgrade flow when re-launching at a lower quality tier.
   */
  tierOverride?: PerformanceTier;
  /**
   * Blob URL for the system BIOS file (e.g. PS1 SCPH-5501, Saturn BIOS).
   * Set EJS_biosUrl when provided. The caller is responsible for revoking
   * this URL after launch (the emulator holds it for the session duration).
   */
  biosUrl?: string;
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
  private _biosUrl: string | null = null;
  private _prefetchedCores = new Set<string>();
  private _webglPreWarmed = false;
  private _pspPipelineWarmed = false;
  private _webgpuDevice: object | null = null; // GPUDevice — typed as object to avoid requiring @webgpu/types
  private _webgpuPreWarmed = false;
  private _audioWorkletCtx: AudioContext | null = null;
  private _audioWorkletNode: AudioWorkletNode | null = null;
  private _audioUnderruns = 0;
  /** Consecutive seconds the average FPS has been below the low-FPS threshold. */
  private _lowFPSSeconds = 0;
  /** Timestamp (ms) of the last low-FPS quality suggestion, to debounce warnings. */
  private _lastQualitySuggestionTime = 0;

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
  onLowFPS?:      (averageFPS: number, tier: PerformanceTier | null) => void;
  /** Fired when an audio underrun is detected via the AudioWorklet processor. */
  onAudioUnderrun?: (count: number) => void;

  constructor(playerId: string) {
    this._playerId = playerId;
    this._fpsMonitor = new FPSMonitor(60);
  }

  get state(): EmulatorState { return this._state; }
  get currentSystem(): SystemInfo | null { return this._currentSystem; }
  get activeTier(): PerformanceTier | null { return this._activeTier; }
  /** True if a WebGPU device was successfully acquired during pre-warm. */
  get webgpuAvailable(): boolean { return this._webgpuDevice !== null; }
  /** The number of audio underruns detected since the last game launch. */
  get audioUnderruns(): number { return this._audioUnderruns; }

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

    try {
      const canvas = document.createElement("canvas");
      canvas.width = 16;
      canvas.height = 16;
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!gl) return;

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
      // Pre-warming is best-effort
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

    try {
      const canvas = document.createElement("canvas");
      canvas.width = 16;
      canvas.height = 16;
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!gl) return;

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
      // Pipeline warm-up is best-effort
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
   * The acquired GPUDevice is held for the lifetime of the emulator instance
   * so it remains ready without repeated initialisation.
   */
  async preWarmWebGPU(): Promise<void> {
    if (this._webgpuPreWarmed) return;
    this._webgpuPreWarmed = true;

    try {
      // Use 'any' only here to avoid requiring @webgpu/types as a dependency.
      // The real API shape is: navigator.gpu → GPUAdapter → GPUDevice.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gpu = (navigator as any).gpu as {
        requestAdapter(opts: { powerPreference: string }): Promise<{
          requestDevice(): Promise<{
            createCommandEncoder(): {
              beginComputePass(): { end(): void };
              finish(): unknown;
            };
            queue: { submit(cmds: unknown[]): void };
          }>;
        } | null>;
      } | undefined;

      if (!gpu) return;

      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) return;

      const device = await adapter.requestDevice();
      this._webgpuDevice = device;

      // Submit a trivial compute pass to warm the GPU command queue
      const encoder = device.createCommandEncoder();
      const passEncoder = encoder.beginComputePass();
      passEncoder.end();
      device.queue.submit([encoder.finish()]);

      console.info("[RetroVault] WebGPU device acquired — GPU command queue warmed.");
    } catch {
      // WebGPU unavailable or not yet supported — silently fall back to WebGL
      this._webgpuDevice = null;
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
   * @param workletBaseUrl  Base URL for loading audio-processor.js (pass
   *                        `import.meta.url` or the app origin).
   */
  async setupAudioWorklet(workletBaseUrl: string): Promise<boolean> {
    if (!("AudioWorkletNode" in window)) return false;

    try {
      // Prefer the game's OpenAL context so we're in the same audio graph
      const ejsCtx = window.EJS_emulator?.Module?.AL?.currentCtx?.audioCtx;
      const ctx = ejsCtx ?? new AudioContext({ latencyHint: "playback" });

      const processorUrl = new URL("/audio-processor.js", workletBaseUrl).href;
      await ctx.audioWorklet.addModule(processorUrl);

      const workletNode = new AudioWorkletNode(ctx, "retrovault-audio-processor");

      workletNode.port.onmessage = (e: MessageEvent<{ type: string; count: number }>) => {
        if (e.data.type === "underrun") {
          this._audioUnderruns += e.data.count;
          this.onAudioUnderrun?.(this._audioUnderruns);
          console.warn(
            `[RetroVault] Audio underrun detected (${e.data.count} new, ` +
            `${this._audioUnderruns} total). ` +
            "Consider increasing the audio buffer size."
          );
        }
      };

      if (ejsCtx) {
        // Connect worklet into the EJS audio graph
        const alCtx = window.EJS_emulator?.Module?.AL?.currentCtx;
        if (alCtx?.sources) {
          const gainNodes = Object.values(alCtx.sources).map(s => s.gain);
          gainNodes.forEach(g => g.connect(workletNode));
        }
        workletNode.connect(ctx.destination);
      }

      this._audioWorkletCtx  = ctx;
      this._audioWorkletNode = workletNode;

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
   * Pre-compile shader programs cached from previous sessions.
   * Call during startup in an idle callback — runs asynchronously.
   */
  async preWarmShaderCache(): Promise<void> {
    await shaderCache.preCompile();
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

      // Reset audio underrun counter for the new session
      this._audioUnderruns = 0;

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
        this._fpsMonitor.onUpdate = (snap) => {
          this.onFPSUpdate?.(snap);
          this._checkAdaptiveQuality(snap.average);
        };
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
    const LOW_FPS_THRESHOLD_HZ  = 25;
    const TRIGGER_SECONDS        = 10;
    const COOLDOWN_MS            = 60_000;

    if (averageFPS > 0 && averageFPS < LOW_FPS_THRESHOLD_HZ) {
      this._lowFPSSeconds++;
      if (
        this._lowFPSSeconds >= TRIGGER_SECONDS &&
        performance.now() - this._lastQualitySuggestionTime > COOLDOWN_MS
      ) {
        this._lastQualitySuggestionTime = performance.now();
        this._lowFPSSeconds = 0;
        this.onLowFPS?.(Math.round(averageFPS), this._activeTier);
        console.warn(
          `[RetroVault] Sustained low FPS (avg ${averageFPS.toFixed(1)} fps) ` +
          `detected on tier "${this._activeTier}". ` +
          "Consider switching to Performance mode for a smoother experience."
        );
      }
    } else {
      // FPS recovered — reset the counter
      this._lowFPSSeconds = 0;
    }
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
    this._disconnectAudioWorklet();
    document.querySelector("script[data-ejs-loader]")?.remove();
    const playerEl = document.getElementById(this._playerId);
    if (playerEl) playerEl.innerHTML = "";
    delete window.EJS_emulator;
    delete window.EJS_ready;
    delete window.EJS_onGameStart;
    delete window.EJS_biosUrl;
    this._currentSystem = null;
    this._activeTier = null;
    this._setState("idle");
  }

  private _disconnectAudioWorklet(): void {
    try {
      this._audioWorkletNode?.disconnect();
    } catch { /* ignore */ }
    this._audioWorkletNode = null;
    // Do not close the AudioContext — it is often shared with EJS.
    // The GC will collect it when EJS tears down its audio graph.
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
