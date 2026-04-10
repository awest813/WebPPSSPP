/**
 * performance.ts — Device capability detection, GPU benchmarking, and
 * multi-tier performance profiling
 *
 * Hardware detection heuristics:
 *   - navigator.deviceMemory → RAM tier
 *   - navigator.hardwareConcurrency → CPU core count
 *   - GPU renderer string → software fallback detection
 *   - Chrome OS user-agent → Chromebook penalty applied to tier
 *   - WebGL draw-call micro-benchmark → GPU throughput tier
 *   - WebGL capability probing → max texture size, extensions
 *   - Battery Status API (async) → dynamic tier downgrade on low battery
 *   - Web Audio API (async) → base latency, AudioWorklet availability
 *
 * Performance tiers (replaces the old binary low/high split):
 *   - "low"    — software GPU, ≤2 cores, <4 GB RAM, or Chromebook class
 *   - "medium" — 4 cores / 4 GB RAM / modest discrete/integrated GPU
 *   - "high"   — 6+ cores / 8+ GB RAM / decent GPU
 *   - "ultra"  — 8+ cores / 8+ GB RAM / powerful GPU
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type PerformanceMode = "auto" | "performance" | "quality";

export type PerformanceTier = "low" | "medium" | "high" | "ultra";

/**
 * Resolution scaling preset — a one-click combo of internal resolution,
 * upscale filter, and anti-aliasing intensity.
 *
 * - "native"        — system's default resolution (no scaling)
 * - "2x"            — 2× internal resolution (crisp, moderate cost)
 * - "4x"            — 4× internal resolution (ultra sharpness, high cost)
 * - "display_match" — best resolution for the display size (heuristic)
 */
export type ResolutionPreset = "native" | "2x" | "4x" | "display_match";

// ── Per-system resolution ladders ─────────────────────────────────────────────

/**
 * Maps system IDs to the core-option key controlling internal resolution
 * and the ordered ladder of values (native → highest).
 */
const RESOLUTION_LADDERS: Record<string, { key: string; values: string[] }> = {
  psp: {
    key: "ppsspp_internal_resolution",
    values: ["1", "2", "4", "8"],
  },
  n64: {
    key: "mupen64plus-resolution-factor",
    values: ["1", "2", "4"],
  },
  psx: {
    key: "beetle_psx_hw_internal_resolution",
    // Matches Beetle PSX HW libretro steps (preset "4×" maps to index 2 = 4x).
    values: ["1x(native)", "2x", "4x", "8x", "16x"],
  },
  nds: {
    key: "desmume_internal_resolution",
    values: ["256x192", "512x384", "768x576", "1024x768"],
  },
};

/**
 * Returns the core-option key and value pairs that implement the given
 * resolution preset for the specified system.
 *
 * Returns an empty object for systems without a resolution option or when
 * the preset maps to the same step as native (ladder index 0).
 *
 * The "display_match" preset picks 2× for small/medium displays (≤1440p)
 * and 4× for large/high-DPI displays, falling back to 2× if the system
 * only supports a two-step ladder.
 */
export function getResolutionCoreOptions(
  systemId: string,
  preset: ResolutionPreset,
): Record<string, string> {
  const ladder = RESOLUTION_LADDERS[systemId];
  if (!ladder) return {};

  let targetIdx: number;

  switch (preset) {
    case "native":
      targetIdx = 0;
      break;
    case "2x":
      targetIdx = Math.min(1, ladder.values.length - 1);
      break;
    case "4x":
      targetIdx = Math.min(2, ladder.values.length - 1);
      break;
    case "display_match": {
      // Heuristic: use devicePixelRatio and screen size to pick the best step.
      // Falls back to 2× when window is unavailable (e.g., tests).
      let displayStep = 1;
      if (typeof window !== "undefined") {
        const dpr         = window.devicePixelRatio ?? 1;
        const logicalW    = window.screen?.width ?? 1920;
        const physicalW   = logicalW * dpr;
        displayStep = physicalW >= 3840 ? 2 : 1;
      }
      targetIdx = Math.min(displayStep, ladder.values.length - 1);
      break;
    }
  }

  const value = ladder.values[targetIdx];
  // If the target is already the native value (index 0), return an empty map
  // to avoid redundant core-option injection.
  if (!value || targetIdx === 0) return {};
  return { [ladder.key]: value };
}

/**
 * Returns the ordered resolution values for the given system (native first).
 * Returns null when the system has no known resolution option.
 */
export function getResolutionLadder(
  systemId: string,
): { key: string; values: string[] } | null {
  return RESOLUTION_LADDERS[systemId] ?? null;
}

export interface GPUCapabilities {
  /** Unmasked renderer string. */
  renderer: string;
  /** Unmasked vendor string. */
  vendor: string;
  /** Maximum texture dimension (px). */
  maxTextureSize: number;
  /** Maximum number of vertex attributes. */
  maxVertexAttribs: number;
  /** Maximum number of varying vectors. */
  maxVaryingVectors: number;
  /** Maximum render buffer size. */
  maxRenderbufferSize: number;
  /** Whether anisotropic filtering is supported. */
  anisotropicFiltering: boolean;
  /** Max anisotropy level (0 if unsupported). */
  maxAnisotropy: number;
  /** Whether float textures are available. */
  floatTextures: boolean;
  /** Whether half-float (fp16) textures are available. */
  halfFloatTextures: boolean;
  /** Whether instanced rendering is available. */
  instancedArrays: boolean;
  /** Whether WebGL 2 is available. */
  webgl2: boolean;
  /** Whether OES_vertex_array_object or native WebGL2 VAOs are available. */
  vertexArrayObject: boolean;
  /** Whether any S3TC / ETC / ASTC compressed texture format is supported. */
  compressedTextures: boolean;
  /** Whether ETC2 texture compression is available. */
  etc2Textures: boolean;
  /** Whether ASTC texture compression is available. */
  astcTextures: boolean;
  /** Maximum color attachments for Multiple Render Targets (MRT). */
  maxColorAttachments: number;
  /** Whether WEBGL_multi_draw is available (batched draw calls in one API call). */
  multiDraw: boolean;
}

export interface DeviceCapabilities {
  /** Approximate device RAM in GB from navigator.deviceMemory, or null if unavailable. */
  deviceMemoryGB: number | null;
  /** Logical CPU core count from navigator.hardwareConcurrency. */
  cpuCores: number;
  /** WebGL 2 renderer string (may reveal software fallback). */
  gpuRenderer: string;
  /** True if the GPU is known to be a software rasteriser. */
  isSoftwareGPU: boolean;
  /** True when heuristics suggest the device is low-spec. */
  isLowSpec: boolean;
  /** True when the device appears to be running Chrome OS (Chromebook). */
  isChromOS: boolean;
  /** True when the device appears to be an iPhone or iPad (iOS/iPadOS). */
  isIOS: boolean;
  /** True when the device appears to be running Android. */
  isAndroid: boolean;
  /** True when the device appears to be a mobile device (iOS or Android). */
  isMobile: boolean;
  /**
   * True when the browser is Safari (any platform — desktop macOS or iOS).
   * Combine with `isIOS` to distinguish desktop Safari from mobile WebKit.
   * Use this to guard Safari-specific behaviours such as the
   * `webkitAudioContext` prefix on older Safari versions, or to check whether
   * `credentialless` COEP (Safari 17+) is available for PSP multi-threading.
   */
  isSafari: boolean;
  /**
   * Major Safari version number (e.g. `17` for Safari 17.x), or `null` when
   * the user is not on Safari or the version cannot be parsed.
   *
   * Cached here so callers can branch on the version without re-parsing the
   * user-agent string. Equivalent to calling `getSafariVersion()` once at
   * capability-detection time.
   *
   * Key version milestones:
   *   - Safari 17 — `credentialless` COEP support → PSP SharedArrayBuffer works.
   *   - Safari 18 — `requestIdleCallback` support → idle scheduling available.
   */
  safariVersion: number | null;
  /**
   * Recommended mode based on hardware alone.
   * Does NOT reflect the user's manual override.
   */
  recommendedMode: "performance" | "quality";
  /** Multi-tier performance classification. */
  tier: PerformanceTier;
  /** Detailed GPU capabilities from WebGL probing. */
  gpuCaps: GPUCapabilities;
  /** GPU benchmark score (0–100). Higher = faster GPU. */
  gpuBenchmarkScore: number;
  /** Whether the device prefers reduced motion (OS accessibility setting). */
  prefersReducedMotion: boolean;
  /** Whether WebGPU is available (future-proof rendering path). */
  webgpuAvailable: boolean;
  /** Estimated network quality: "fast", "slow", or "unknown". */
  connectionQuality: "fast" | "slow" | "unknown";
  /** JS heap size limit in MB, or null if unavailable. */
  jsHeapLimitMB: number | null;
  /** Estimated GPU VRAM in MB (heuristic from WebGL capabilities). */
  estimatedVRAMMB: number;
}

/** Lightweight battery status snapshot. */
export interface BatteryStatus {
  /** True if the device is on AC power. */
  charging: boolean;
  /** Battery level 0–1, or null if unavailable. */
  level: number | null;
  /** True when level < 0.2 and not charging (triggers conservative mode). */
  isLowBattery: boolean;
}

/**
 * Audio system capabilities probed via the Web Audio API.
 * Used to tune audio buffer sizes and select low-latency code paths.
 */
export interface AudioCapabilities {
  /** Estimated round-trip audio output latency in ms, or null if unavailable. */
  baseLatencyMs: number | null;
  /** Full output latency including hardware buffering in ms, or null if unavailable. */
  outputLatencyMs: number | null;
  /** Whether AudioWorklet is supported (enables low-latency custom DSP). */
  audioWorklet: boolean;
  /** The native sample rate of the audio output device in Hz. */
  sampleRate: number | null;
  /** Maximum number of output channels supported by the audio hardware, or null if unavailable. */
  maxChannelCount: number | null;
  /**
   * Suggested audio buffer tier: "low" = minimal latency (≤8 ms base),
   * "medium" = comfortable (≤20 ms), "high" = conservative (>20 ms or unknown).
   */
  suggestedBufferTier: "low" | "medium" | "high";
}

let _audioCapabilitiesPromise: Promise<AudioCapabilities> | null = null;

// ── Software renderer detection ───────────────────────────────────────────────

const SOFTWARE_RENDERER_KEYWORDS = [
  "swiftshader",
  "swangle",
  "llvmpipe",
  "softpipe",
  "virgl",
  "mesa offscreen",
  "microsoft basic render",
] as const;

function isSoftwareRenderer(renderer: string): boolean {
  const lower = renderer.toLowerCase();
  return SOFTWARE_RENDERER_KEYWORDS.some(kw => lower.includes(kw));
}

// ── Chrome OS detection ───────────────────────────────────────────────────────

/**
 * Detect if the user is on Chrome OS / a Chromebook.
 *
 * Chrome OS always includes "CrOS" in the user-agent string, which is
 * a reliable signal for applying Chromebook-appropriate performance limits.
 */
export function isLikelyChromeOS(): boolean {
  return /CrOS/.test(navigator.userAgent);
}

// ── iOS / Android detection ───────────────────────────────────────────────────

/**
 * Detect if the user is on iOS (iPhone, iPad, or iPod Touch).
 *
 * Handles both classic iOS user-agents (iP(hone|ad|od)) and the iPadOS 13+
 * case where Safari reports itself as "Macintosh" but exposes touch points.
 * Both Safari and all iOS-native browsers (Chrome, Firefox) use WebKit and
 * share the same performance and API constraints.
 */
export function isLikelyIOS(): boolean {
  try {
    if (/iP(hone|ad|od)/.test(navigator.userAgent)) return true;
    // iPadOS 13+ identifies as "Macintosh" but has touch hardware
    if (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints >= 1) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Detect if the user is on Android.
 *
 * Android always includes "Android" in the user-agent string regardless of
 * the browser (Chrome, Firefox, Samsung Internet, etc.).
 */
export function isLikelyAndroid(): boolean {
  try {
    return /Android/.test(navigator.userAgent);
  } catch {
    return false;
  }
}

// ── Safari / WebKit detection ─────────────────────────────────────────────────

/**
 * Detect if the user is running the Safari browser (any platform).
 *
 * Safari's user-agent always includes a `Version/X.Y` token immediately
 * before the `Safari/` token. Chromium-based browsers (Chrome, Edge, Opera,
 * Samsung Internet) include `Safari/` for compatibility but use the fixed
 * string `Safari/537.36` — they never emit a `Version/` token — so they are
 * cleanly excluded by the Version/ check. Chrome on iOS uses `CriOS/` and
 * Firefox on iOS uses `FxiOS/`, which are also excluded.
 *
 * Returns `true` for both desktop Safari (macOS) and iOS Safari. Combine with
 * `isLikelyIOS()` to distinguish desktop Safari from mobile WebKit.
 */
export function isLikelySafari(): boolean {
  try {
    const ua = navigator.userAgent;
    if (!/\bVersion\/\d+/.test(ua)) return false;
    if (!/\bSafari\//.test(ua)) return false;
    // Exclude Chromium-derived browsers that might include a Version/ token.
    if (/\b(Chrome|CriOS|Chromium|OPR|Edg|EdgA|FxiOS|SamsungBrowser)\b/.test(ua)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse the major Safari version number from the user-agent string.
 *
 * Safari encodes its version as `Version/X.Y` in the user-agent. This
 * function extracts the major (`X`) component and returns it as a number.
 * Returns `null` when not running in Safari or when the version cannot be
 * parsed (e.g. in a non-browser environment).
 *
 * Useful for gating on version-specific capabilities such as `credentialless`
 * COEP support (Safari 17+) or `requestIdleCallback` (Safari 17+).
 */
export function getSafariVersion(): number | null {
  try {
    if (!isLikelySafari()) return null;
    const match = /\bVersion\/(\d+)/.exec(navigator.userAgent);
    if (!match) return null;
    return parseInt(match[1]!, 10);
  } catch {
    return null;
  }
}

// ── Reduced motion preference ─────────────────────────────────────────────────

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// ── WebGPU availability ───────────────────────────────────────────────────────

export function isWebGPUAvailable(): boolean {
  try {
    return "gpu" in navigator && navigator.gpu !== undefined;
  } catch {
    return false;
  }
}

// ── Connection quality estimation ─────────────────────────────────────────────

/**
 * Estimate network quality from the Network Information API.
 * Used to decide whether to eagerly prefetch large WASM cores.
 */
export function estimateConnectionQuality(): "fast" | "slow" | "unknown" {
  try {
    const conn = (navigator as Navigator & {
      connection?: {
        effectiveType?: string;
        downlink?: number;
        saveData?: boolean;
      };
    }).connection;

    if (!conn) return "unknown";
    if (conn.saveData) return "slow";
    if (conn.effectiveType === "4g" && (conn.downlink ?? 0) >= 5) return "fast";
    if (conn.effectiveType === "3g" || conn.effectiveType === "2g") return "slow";
    if ((conn.downlink ?? 0) >= 2) return "fast";
    return "unknown";
  } catch {
    return "unknown";
  }
}

// ── JS heap introspection ─────────────────────────────────────────────────────

function getJSHeapLimitMB(): number | null {
  try {
    const perf = performance as Performance & {
      memory?: { jsHeapSizeLimit?: number };
    };
    if (perf.memory?.jsHeapSizeLimit) {
      return Math.round(perf.memory.jsHeapSizeLimit / (1024 * 1024));
    }
    return null;
  } catch {
    return null;
  }
}

// ── WebGL probing ─────────────────────────────────────────────────────────────

function probeGPU(): GPUCapabilities {
  const defaults: GPUCapabilities = {
    renderer: "unknown",
    vendor: "unknown",
    maxTextureSize: 0,
    maxVertexAttribs: 0,
    maxVaryingVectors: 0,
    maxRenderbufferSize: 0,
    anisotropicFiltering: false,
    maxAnisotropy: 0,
    floatTextures: false,
    halfFloatTextures: false,
    instancedArrays: false,
    webgl2: false,
    vertexArrayObject: false,
    compressedTextures: false,
    etc2Textures: false,
    astcTextures: false,
    maxColorAttachments: 1,
    multiDraw: false,
  };

  try {
    const canvas = document.createElement("canvas");
    const webgl2Context = canvas.getContext("webgl2");
    const isWebGL2 = webgl2Context !== null;
    const gl = webgl2Context ?? canvas.getContext("webgl");
    if (!gl) return defaults;

    const debugExt = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = debugExt
      ? (gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL) as string)
      : "unknown";
    const vendor = debugExt
      ? (gl.getParameter(debugExt.UNMASKED_VENDOR_WEBGL) as string)
      : "unknown";

    // Anisotropic filtering
    const anisoExt = (
      gl.getExtension("EXT_texture_filter_anisotropic") ??
      gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic") ??
      gl.getExtension("MOZ_EXT_texture_filter_anisotropic")
    ) as { MAX_TEXTURE_MAX_ANISOTROPY_EXT: GLenum } | null;
    const maxAnisotropy = anisoExt
      ? (gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number)
      : 0;

    // Float textures
    const floatTextures = !!(
      gl.getExtension("OES_texture_float") ||
      (gl instanceof WebGL2RenderingContext)
    );

    // Half-float textures — important for HDR render targets and post-processing
    const halfFloatTextures = !!(
      gl.getExtension("OES_texture_half_float") ||
      (gl instanceof WebGL2RenderingContext)
    );

    // Instanced arrays (critical for efficient 3D batch rendering)
    const instancedArrays = !!(
      gl.getExtension("ANGLE_instanced_arrays") ||
      (gl instanceof WebGL2RenderingContext)
    );

    // Vertex Array Objects — eliminate per-draw state setup overhead
    const vertexArrayObject = !!(
      gl.getExtension("OES_vertex_array_object") ||
      (gl instanceof WebGL2RenderingContext)
    );

    // Compressed texture support — reduces VRAM bandwidth, allows larger texture sets
    const compressedTextures = !!(
      gl.getExtension("WEBGL_compressed_texture_s3tc") ||
      gl.getExtension("WEBGL_compressed_texture_etc") ||
      gl.getExtension("WEBGL_compressed_texture_astc") ||
      gl.getExtension("WEBGL_compressed_texture_pvrtc") ||
      gl.getExtension("WEBKIT_WEBGL_compressed_texture_pvrtc")
    );

    const etc2Textures = !!gl.getExtension("WEBGL_compressed_texture_etc");
    const astcTextures = !!gl.getExtension("WEBGL_compressed_texture_astc");

    // Multiple Render Targets — used by deferred rendering and post-processing
    let maxColorAttachments = 1;
    if (gl instanceof WebGL2RenderingContext) {
      maxColorAttachments = gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) as number;
    } else {
      const drawBuffersExt = gl.getExtension("WEBGL_draw_buffers");
      if (drawBuffersExt) {
        maxColorAttachments = gl.getParameter(
          drawBuffersExt.MAX_COLOR_ATTACHMENTS_WEBGL
        ) as number;
      }
    }

    // WEBGL_multi_draw — batches multiple draw calls into one API call, reducing CPU overhead
    const multiDraw = !!gl.getExtension("WEBGL_multi_draw");

    const probed: GPUCapabilities = {
      renderer,
      vendor,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number,
      maxVaryingVectors: gl.getParameter(gl.MAX_VARYING_VECTORS) as number,
      maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      anisotropicFiltering: anisoExt !== null,
      maxAnisotropy,
      floatTextures,
      halfFloatTextures,
      instancedArrays,
      webgl2: isWebGL2,
      vertexArrayObject,
      compressedTextures,
      etc2Textures,
      astcTextures,
      maxColorAttachments,
      multiDraw,
    };

    // Explicitly release the throwaway context to avoid holding OS-level GPU
    // resources for the lifetime of the page. probeGPU() runs on every startup
    // so prompt cleanup is important on memory-constrained devices.
    try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* ignore */ }

    return probed;
  } catch {
    return defaults;
  }
}

// ── GPU micro-benchmark ───────────────────────────────────────────────────────

/** Minimal VAO extension interface — typed to avoid `any` while staying portable. */
interface VAOExtension {
  createVertexArrayOES(): WebGLVertexArrayObject | null;
  bindVertexArrayOES(vao: WebGLVertexArrayObject | null): void;
  deleteVertexArrayOES(vao: WebGLVertexArrayObject | null): void;
}

/**
 * Run a quick WebGL draw-call micro-benchmark to estimate GPU throughput.
 *
 * Uses VAOs when available (WebGL2 / OES_vertex_array_object) to better
 * represent the real rendering workload of 3D game cores, which batch
 * vertex state into VAOs to reduce per-draw CPU overhead.
 *
 * The fragment shader samples a 1×1 texture to include texture fetch
 * latency in the score, since PSP / N64 / PS1 3D games are heavily
 * texture-bound and a solid-colour benchmark underestimates their GPU cost.
 *
 * Returns a score 0–100. Intentionally lightweight (≤12ms) to avoid
 * blocking startup, especially on Chromebooks and low-spec hardware.
 */
function benchmarkGPU(): number {
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;

    const gl2 = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
    gl  = gl2 ?? canvas.getContext("webgl") as WebGLRenderingContext | null;
    if (!gl) return 0;

    const vs = gl.createShader(gl.VERTEX_SHADER);
    if (!vs) return 0;
    gl.shaderSource(vs, `
      attribute vec2 a_pos;
      attribute vec2 a_uv;
      varying vec2 v_uv;
      void main() { v_uv = a_uv; gl_Position = vec4(a_pos, 0.0, 1.0); }
    `);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) return 0;

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!fs) return 0;
    // Sample a 1×1 texture to measure the texture-fetch unit.
    // 3D retro game cores are texture-bound; a solid-colour benchmark
    // overestimates GPU capability relative to real gameplay.
    gl.shaderSource(fs, `
      precision mediump float;
      uniform float u_val;
      uniform sampler2D u_tex;
      varying vec2 v_uv;
      void main() {
        vec4 t = texture2D(u_tex, v_uv);
        gl_FragColor = vec4(t.rgb * u_val, 1.0);
      }
    `);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) return 0;

    const prog = gl.createProgram();
    if (!prog) return 0;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return 0;
    gl.useProgram(prog);

    const uVal = gl.getUniformLocation(prog, "u_val");
    const uTex = gl.getUniformLocation(prog, "u_tex");
    gl.uniform1i(uTex, 0);

    // Interleaved buffer: position (2 floats) + UV (2 floats) per vertex.
    // The UV coordinates are passed to the fragment shader for texture sampling.
    const buf = gl.createBuffer();
    if (!buf) return 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1, 0, 0,
         1, -1, 1, 0,
        -1,  1, 0, 1,
         1,  1, 1, 1,
      ]),
      gl.STATIC_DRAW
    );

    const STRIDE = 4 * Float32Array.BYTES_PER_ELEMENT;
    const aPos = gl.getAttribLocation(prog, "a_pos");
    const aUV  = gl.getAttribLocation(prog, "a_uv");

    // 1×1 white texture — exercises the GPU texture-fetch unit without
    // requiring a real image, keeping benchmark startup cost negligible.
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255])
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Use VAO when available to reduce per-draw attribute-setup overhead.
    // This more accurately reflects 3D game workloads where VAOs are ubiquitous.
    let vaoExt: VAOExtension | null = null;
    let vao: WebGLVertexArrayObject | null = null;

    if (gl2) {
      vao = gl2.createVertexArray();
      gl2.bindVertexArray(vao);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, STRIDE, 0);
      if (aUV >= 0) {
        gl.enableVertexAttribArray(aUV);
        gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, STRIDE, 2 * Float32Array.BYTES_PER_ELEMENT);
      }
      gl2.bindVertexArray(null);
    } else {
      // OES_vertex_array_object has a compatible shape — cast via unknown
      const rawExt = gl.getExtension("OES_vertex_array_object");
      if (rawExt) {
        vaoExt = rawExt as unknown as VAOExtension;
        vao = vaoExt.createVertexArrayOES();
        vaoExt.bindVertexArrayOES(vao);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, STRIDE, 0);
        if (aUV >= 0) {
          gl.enableVertexAttribArray(aUV);
          gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, STRIDE, 2 * Float32Array.BYTES_PER_ELEMENT);
        }
        vaoExt.bindVertexArrayOES(null);
      } else {
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, STRIDE, 0);
        if (aUV >= 0) {
          gl.enableVertexAttribArray(aUV);
          gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, STRIDE, 2 * Float32Array.BYTES_PER_ELEMENT);
        }
      }
    }

    // Warm up — flush driver lazy-init before timing
    for (let i = 0; i < 10; i++) {
      if (gl2 && vao) gl2.bindVertexArray(vao);
      else if (vaoExt && vao) vaoExt.bindVertexArrayOES(vao);
      gl.uniform1f(uVal, i * 0.1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.flush();

    // Timed run: count draw calls in a fixed budget.
    // 12ms budget is intentionally short to be non-intrusive on slow devices.
    const BUDGET_MS = 12;
    // Safety cap: prevents an infinite loop in environments where
    // performance.now() does not advance (some headless test runners).
    const MAX_DRAW_CALLS = 200_000;
    let drawCalls = 0;
    const start = performance.now();

    while (performance.now() - start < BUDGET_MS && drawCalls < MAX_DRAW_CALLS) {
      for (let batch = 0; batch < 50; batch++) {
        if (gl2 && vao) gl2.bindVertexArray(vao);
        else if (vaoExt && vao) vaoExt.bindVertexArrayOES(vao);
        gl.uniform1f(uVal, (drawCalls & 0xff) / 255);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        drawCalls++;
      }
      // flush() instead of finish() to avoid synchronous GPU stall on
      // tiled-rendering mobile/Chromebook GPUs.
      gl.flush();
    }
    gl.flush();

    // Cleanup
    if (gl2 && vao) gl2.deleteVertexArray(vao);
    else if (vaoExt && vao) vaoExt.deleteVertexArrayOES(vao);
    gl.deleteTexture(tex);
    gl.deleteBuffer(buf);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.deleteProgram(prog);

    // Logarithmic scale for better discrimination across GPU tiers.
    // log10-based scoring maps the wide range of GPU capabilities more evenly:
    //   ~100 draws/12ms  → score ~10 (very slow mobile/software)
    //   ~1000 draws/12ms → score ~30 (integrated/Chromebook)
    //   ~5000 draws/12ms → score ~55 (decent discrete GPU)
    //   ~10000 draws/12ms → score ~70 (high-end desktop)
    //   ~50000+ draws/12ms → score ~100 (top-tier desktop)
    const clampedDraws = Math.max(1, drawCalls);
    // Scale factor: 100 / log10(100_000) ≈ 20; 21.5 stretches the upper range
    // so that 50 K+ draws reliably hit 100 without compressing mid-tier scores.
    const LOG10_SCALE_FACTOR = 21.5;
    const score = Math.min(100, Math.round(Math.log10(clampedDraws) * LOG10_SCALE_FACTOR));
    return score;
  } catch {
    return 0;
  } finally {
    // Always release the throwaway context to avoid leaking OS-level GPU resources.
    try { gl?.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* ignore */ }
  }
}

/**
 * Optimizes the browser environment for Chrome.
 * Chrome-specific tweaks for RetroVault:
 * - High-priority WASM thread allocation hints
 * - SharedArrayBuffer validation (COOP/COEP)
 * - V8 TurboFan hints for instruction-heavy WASM cores (PSP/N64)
 */
export function optimizeChromePerformance(): void {
  const isChrome = /Chrome/.test(navigator.userAgent) && /Google Inc/.test(navigator.vendor);
  if (!isChrome) return;

  // Hint at high-performance requirements
  if (typeof performance !== "undefined" && typeof performance.mark === "function") {
    performance.mark("retrovault-boot-start");
  }

  // Check for isolation which is crucial for PSP/N64 WASM performance
  if (typeof window !== "undefined" && !window.crossOriginIsolated) {
    console.warn("[RetroVault] Not cross-origin isolated — PSP/N64 performance may be degraded (no SharedArrayBuffer).");
  }
}

// ── Tier classification ───────────────────────────────────────────────────────

function classifyTier(
  cpuCores: number,
  memoryGB: number | null,
  isSoftware: boolean,
  gpuScore: number,
  gpuCaps: GPUCapabilities,
  chromeos: boolean,
  isMobile: boolean
): PerformanceTier {
  // Software GPU → always low
  if (isSoftware) return "low";

  // Accumulate a points-based score
  let points = 0;

  // CPU contribution (0–30 points)
  if (cpuCores >= 8)      points += 30;
  else if (cpuCores >= 6) points += 22;
  else if (cpuCores >= 4) points += 14;
  else if (cpuCores >= 2) points += 6;

  // Memory contribution (0–20 points)
  if (memoryGB !== null) {
    if (memoryGB >= 8)      points += 20;
    else if (memoryGB >= 4) points += 12;
    else if (memoryGB >= 2) points += 4;
  } else {
    points += 10; // unknown → assume mid
  }

  // GPU benchmark contribution (0–40 points)
  points += Math.round(gpuScore * 0.4);

  // GPU capability bonuses (0–16 points)
  if (gpuCaps.maxTextureSize >= 8192)    points += 3;
  if (gpuCaps.anisotropicFiltering)      points += 2;
  if (gpuCaps.floatTextures)             points += 2;
  if (gpuCaps.instancedArrays)           points += 3;
  // Additional modern-GPU bonuses: MRT, VAO, and batch-draw support are
  // reliable indicators of a capable GPU/driver stack.
  if (gpuCaps.maxColorAttachments >= 4)  points += 2;
  if (gpuCaps.vertexArrayObject)         points += 1;
  if (gpuCaps.multiDraw)                 points += 1;
  if (gpuCaps.compressedTextures)        points += 2;
  if (gpuCaps.etc2Textures)              points += 1;
  if (gpuCaps.astcTextures)              points += 2;

  // Very-limited-GPU penalty: maxTextureSize < 2048 indicates ancient or
  // heavily constrained GPU hardware (e.g. very old mobile SoCs). These
  // devices struggle with 3D rendering regardless of CPU/RAM, so penalise
  // them to keep the tier accurately low. Skip when maxTextureSize is 0
  // (probe failed — no information to act on).
  if (gpuCaps.maxTextureSize > 0 && gpuCaps.maxTextureSize < 2048) points -= 8;

  // Chrome OS / Chromebook penalty: these devices use power-constrained
  // ARM/Intel Celeron SoCs and often throttle under sustained GPU load.
  // Reduce effective points to avoid over-estimating their capability.
  if (chromeos) points = Math.round(points * 0.75);

  // Classify
  let tier: PerformanceTier;
  if (points >= 75) tier = "ultra";
  else if (points >= 50) tier = "high";
  else if (points >= 25) tier = "medium";
  else tier = "low";

  // Mobile cap: even high-end phones run inside a browser with restricted heap
  // memory (iOS Safari caps at ~1.5 GB; Android Chrome has tighter limits than
  // desktop). Sustained WebGL workloads also throttle more aggressively on
  // mobile SoCs due to thermal constraints. Cap mobile devices at "high" to
  // prevent over-estimating real-world emulation performance.
  if (isMobile && tier === "ultra") tier = "high";

  return tier;
}

// ── VRAM estimation ───────────────────────────────────────────────────────────

/**
 * Estimate available VRAM from WebGL capabilities.
 *
 * WebGL does not expose VRAM directly, but we can use maxTextureSize and
 * maxRenderbufferSize as proxies: GPUs with more VRAM typically support
 * larger textures and renderbuffers.
 *
 * Returns estimated VRAM in MB (rough approximation).
 */
export function estimateVRAM(gpuCaps: GPUCapabilities): number {
  // Correlation between maxTextureSize and typical discrete/mobile GPU VRAM:
  //   16384px → high-end desktop GPU, typically 4 GB+
  //    8192px → mid-range discrete / high-end mobile, ~1–2 GB
  //    4096px → integrated / low-end discrete, ~256–512 MB
  //    ≤2048px → very old or software renderer, ~128 MB or less
  const VRAM_16K = 4096;
  const VRAM_8K  = 1536;
  const VRAM_4K  = 512;
  const VRAM_BASE = 256;

  const texSizeTier = gpuCaps.maxTextureSize >= 16384 ? VRAM_16K
    : gpuCaps.maxTextureSize >= 8192 ? VRAM_8K
    : gpuCaps.maxTextureSize >= 4096 ? VRAM_4K
    : VRAM_BASE;

  // MRT (Multiple Render Targets) support suggests a more capable GPU with more VRAM
  const MRT_BONUS_HIGH = 512;   // 8+ attachments → high-end
  const MRT_BONUS_MID  = 256;   // 4+ attachments → mid-range
  const mrtBonus = gpuCaps.maxColorAttachments >= 8 ? MRT_BONUS_HIGH
    : gpuCaps.maxColorAttachments >= 4 ? MRT_BONUS_MID
    : 0;

  // ASTC/ETC2 support typically indicates a modern GPU with dedicated VRAM
  const ASTC_BONUS = 256;
  const ETC2_BONUS = 128;
  const compressionBonus = (gpuCaps.astcTextures ? ASTC_BONUS : 0) + (gpuCaps.etc2Textures ? ETC2_BONUS : 0);

  return texSizeTier + mrtBonus + compressionBonus;
}

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Probe the device's hardware tier.
 *
 * Call this once at startup. It touches the GPU via WebGL for probing
 * and runs a quick micro-benchmark (~12ms).
 */
export function detectCapabilities(): DeviceCapabilities {
  const deviceMemoryGB: number | null =
    (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null;

  const cpuCores = navigator.hardwareConcurrency ?? 1;
  const gpuCaps = probeGPU();
  const isSoftwareGPU = isSoftwareRenderer(gpuCaps.renderer);
  const gpuBenchmarkScore = benchmarkGPU();
  const chromeos = isLikelyChromeOS();
  const ios = isLikelyIOS();
  const android = isLikelyAndroid();
  const safari = isLikelySafari();
  const safariVer = getSafariVersion();
  const mobile = ios || android;
  const reducedMotion = prefersReducedMotion();
  const webgpuAvailable = isWebGPUAvailable();
  const connectionQuality = estimateConnectionQuality();
  const jsHeapLimitMB = getJSHeapLimitMB();

  const tier = classifyTier(cpuCores, deviceMemoryGB, isSoftwareGPU, gpuBenchmarkScore, gpuCaps, chromeos, mobile);

  const estimatedVRAM = estimateVRAM(gpuCaps);

  const isLowSpec = tier === "low";

  return {
    deviceMemoryGB,
    cpuCores,
    gpuRenderer: gpuCaps.renderer,
    isSoftwareGPU,
    isLowSpec,
    isChromOS: chromeos,
    isIOS: ios,
    isAndroid: android,
    isMobile: mobile,
    isSafari: safari,
    safariVersion: safariVer,
    recommendedMode: isLowSpec || tier === "medium" ? "performance" : "quality",
    tier,
    gpuCaps,
    gpuBenchmarkScore,
    prefersReducedMotion: reducedMotion,
    webgpuAvailable,
    connectionQuality,
    jsHeapLimitMB,
    estimatedVRAMMB: estimatedVRAM,
  };
}

// ── Session-cached capability detection ──────────────────────────────────────

/**
 * Schema version embedded inside the serialised capabilities object.
 * Increment this when the DeviceCapabilities interface gains or removes fields
 * so that cached entries without the new fields are automatically discarded,
 * even if the sessionStorage key name is not also bumped.
 */
const CAPS_SCHEMA_VERSION = 4;

/**
 * sessionStorage key for the cached DeviceCapabilities result.
 * Bump the suffix when the DeviceCapabilities interface changes shape so
 * stale caches from old app versions are ignored automatically.
 */
const CAPABILITIES_SESSION_KEY = "retrovault-devcaps-v1";

/**
 * Detect device capabilities with session-level caching.
 *
 * The GPU micro-benchmark (~12 ms) and WebGL probe run only once per browser
 * session. The result is serialised to sessionStorage (cleared on tab close)
 * so that page navigations and soft-reloads within the same tab skip the
 * expensive detection entirely.
 *
 * Falls back to the full `detectCapabilities()` run when:
 *   - sessionStorage is unavailable (private browsing restrictions)
 *   - the stored value is corrupt or has an unrecognised tier
 *   - the stored value has an older schema version
 */
export function detectCapabilitiesCached(): DeviceCapabilities {
  try {
    const raw = sessionStorage.getItem(CAPABILITIES_SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DeviceCapabilities & { __v?: number };
      // Sanity-check the most critical field to detect truncated/stale entries,
      // and verify the schema version to reject entries missing newer fields.
      if (
        parsed.__v === CAPS_SCHEMA_VERSION &&
        (["low", "medium", "high", "ultra"] as const).includes(parsed.tier)
      ) {
        const { __v: _v, ...caps } = parsed;
        return caps as DeviceCapabilities;
      }
    }
  } catch {
    // sessionStorage unavailable or JSON corrupt — fall through to fresh detection.
  }

  const caps = detectCapabilities();

  try {
    sessionStorage.setItem(
      CAPABILITIES_SESSION_KEY,
      JSON.stringify({ ...caps, __v: CAPS_SCHEMA_VERSION }),
    );
  } catch {
    // sessionStorage write failed (private mode quota / storage error) — ignore.
  }

  return caps;
}

/** Clear the cached capabilities (e.g. after the user forces re-detection). */
export function clearCapabilitiesCache(): void {
  try {
    sessionStorage.removeItem(CAPABILITIES_SESSION_KEY);
  } catch { /* ignore */ }
}

// ── Memory pressure monitoring ────────────────────────────────────────────────

/**
 * Monitors JS heap usage and fires a callback when the heap approaches its
 * browser-imposed limit.
 *
 * Uses the non-standard (Chrome-only) `performance.memory` API. On browsers
 * that do not expose this API the monitor is a no-op — `usedHeapMB` and
 * `heapLimitMB` return `null` and the pressure callback never fires.
 *
 * Usage:
 * ```typescript
 * const monitor = new MemoryMonitor();
 * monitor.onPressure = (usedMB, limitMB) => {
 *   console.warn(`Heap at ${usedMB} / ${limitMB} MB — consider reducing quality`);
 * };
 * monitor.start();          // begin polling every 10 s
 * // … later …
 * monitor.stop();
 * ```
 */
export class MemoryMonitor {
  private _intervalId: ReturnType<typeof setInterval> | null = null;
  private _onPressure?: (usedMB: number, limitMB: number) => void;
  private _lastPressureTime = 0;

  /** Minimum gap between successive `onPressure` callbacks (30 seconds). */
  private static readonly _PRESSURE_COOLDOWN_MS = 30_000;
  /**
   * Heap usage fraction (0–1) above which pressure is reported.
   * 0.80 = 80 % of the reported JS heap limit.
   */
  private static readonly _PRESSURE_THRESHOLD = 0.80;

  /**
   * Callback fired when JS heap usage exceeds 80 % of the browser-reported
   * limit. Rate-limited to at most once per 30 seconds.
   */
  set onPressure(cb: (usedMB: number, limitMB: number) => void) {
    this._onPressure = cb;
  }

  /** Current used JS heap in MB, or null when the API is unavailable. */
  get usedHeapMB(): number | null {
    return MemoryMonitor._getUsedHeapMB();
  }

  /** JS heap size limit in MB, or null when the API is unavailable. */
  get heapLimitMB(): number | null {
    return MemoryMonitor._getHeapLimitMB();
  }

  private static _getUsedHeapMB(): number | null {
    try {
      const perf = performance as Performance & {
        memory?: { usedJSHeapSize?: number };
      };
      const used = perf.memory?.usedJSHeapSize;
      return used != null ? Math.round(used / (1024 * 1024)) : null;
    } catch {
      return null;
    }
  }

  private static _getHeapLimitMB(): number | null {
    try {
      const perf = performance as Performance & {
        memory?: { jsHeapSizeLimit?: number };
      };
      const limit = perf.memory?.jsHeapSizeLimit;
      return limit != null ? Math.round(limit / (1024 * 1024)) : null;
    } catch {
      return null;
    }
  }

  /**
   * Begin polling JS heap usage at the given interval.
   *
   * @param intervalMs  How often to sample the heap (default 10 000 ms).
   *                    Shorter intervals increase the chance of catching
   *                    a short-lived spike but add minor CPU overhead.
   */
  start(intervalMs = 10_000): void {
    if (this._intervalId !== null) return; // already running
    this._intervalId = setInterval(() => { this._check(); }, intervalMs);
  }

  /** Stop the polling interval. */
  stop(): void {
    if (this._intervalId !== null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  private _check(): void {
    const usedMB  = MemoryMonitor._getUsedHeapMB();
    const limitMB = MemoryMonitor._getHeapLimitMB();
    if (usedMB === null || limitMB === null || limitMB === 0) return;

    const ratio = usedMB / limitMB;
    if (ratio >= MemoryMonitor._PRESSURE_THRESHOLD) {
      const now = Date.now();
      if (now - this._lastPressureTime > MemoryMonitor._PRESSURE_COOLDOWN_MS) {
        this._lastPressureTime = now;
        this._onPressure?.(usedMB, limitMB);
      }
    }
  }
}

// ── Idle task scheduler ───────────────────────────────────────────────────────

/**
 * Schedule a non-critical task to run during the browser's next idle period.
 *
 * Uses `requestIdleCallback` when available (Chromium-based browsers and
 * Safari 18+), falling back to `setTimeout(task, 0)` for browsers that do
 * not support it (Safari ≤17, Firefox with
 * `dom.requestIdleCallback.enabled = false`).
 *
 * Idle scheduling avoids competing with the main-thread work needed to render
 * the first game frame, making it ideal for startup tasks such as:
 *   - Pre-warming the WebGL driver
 *   - Prefetching WASM core files
 *   - Rehydrating the shader cache from IndexedDB
 *
 * @param task       Function to execute during an idle period.
 * @param timeoutMs  Deadline guarantee — the browser will invoke `task` within
 *                   this many milliseconds even if the page never goes idle.
 *                   Default: 2000 ms.
 */
export function scheduleIdleTask(task: () => void, timeoutMs = 2000): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(task, { timeout: timeoutMs });
  } else {
    setTimeout(task, 0);
  }
}

// ── Battery status (async) ────────────────────────────────────────────────────

/**
 * Asynchronously query the Battery Status API.
 *
 * Returns null when the API is unavailable (Firefox, Safari, Chrome with
 * permissions policy blocking it). When battery is ≤20% and discharging,
 * `isLowBattery` is set — callers can use this to force "performance" mode.
 *
 * The Battery API is available in Chrome/Chromium (including Chrome OS),
 * making it especially useful for Chromebook users.
 */
export async function checkBatteryStatus(): Promise<BatteryStatus | null> {
  try {
    const nav = navigator as Navigator & {
      getBattery?: () => Promise<{
        charging: boolean;
        level: number;
        addEventListener(event: string, handler: () => void): void;
      }>;
    };
    if (typeof nav.getBattery !== "function") return null;
    const battery = await nav.getBattery();
    return {
      charging: battery.charging,
      level: battery.level,
      isLowBattery: !battery.charging && battery.level <= 0.2,
    };
  } catch {
    return null;
  }
}

// ── Audio capabilities (async) ────────────────────────────────────────────────

/**
 * Probe Web Audio API capabilities to inform audio buffer sizing.
 *
 * Creates a temporary AudioContext (immediately suspended to avoid autoplay
 * restrictions) to read hardware latency values. The context is closed after
 * probing to release system audio resources.
 *
 * `suggestedBufferTier` maps directly to PPSSPP's `ppsspp_audio_latency`:
 *   - "low"    → 0 (minimum buffer, ≤8 ms base latency — low-latency hardware)
 *   - "medium" → 1 (standard buffer, ≤20 ms — typical laptop/desktop audio)
 *   - "high"   → 2 (conservative buffer, >20 ms or unknown — USB/Bluetooth audio)
 */
export async function detectAudioCapabilities(
  opts: { forceRefresh?: boolean } = {}
): Promise<AudioCapabilities> {
  const runProbe = async (): Promise<AudioCapabilities> => {
    const audioWorklet = typeof AudioWorkletNode !== "undefined";
    const fallback: AudioCapabilities = {
      baseLatencyMs: null,
      outputLatencyMs: null,
      audioWorklet,
      sampleRate: null,
      maxChannelCount: null,
      suggestedBufferTier: "medium",
    };

    try {
      const AudioContextCtor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return fallback;

      // Construct suspended so we don't trigger autoplay policy.
      // Use try/finally to guarantee ctx.close() even if ctx.suspend() throws
      // (e.g. when the browser puts the context into an "interrupted" state).
      let ctx: AudioContext | undefined;
      try {
        ctx = new AudioContextCtor({ latencyHint: "playback" });
        await ctx.suspend();

        const baseLatencyMs    = (ctx.baseLatency   ?? null) !== null ? (ctx.baseLatency   * 1000) : null;
        const outputLatencyMs  = (ctx.outputLatency  ?? null) !== null ? (ctx.outputLatency * 1000) : null;
        const sampleRate       = ctx.sampleRate;
        const maxChannelCount  = ctx.destination.maxChannelCount ?? null;

        let suggestedBufferTier: AudioCapabilities["suggestedBufferTier"] = "medium";
        if (baseLatencyMs !== null) {
          if (baseLatencyMs <= 8)  suggestedBufferTier = "low";
          else if (baseLatencyMs <= 20) suggestedBufferTier = "medium";
          else                     suggestedBufferTier = "high";
        }

        return { baseLatencyMs, outputLatencyMs, audioWorklet, sampleRate, maxChannelCount, suggestedBufferTier };
      } finally {
        ctx?.close().catch(() => { /* best-effort */ });
      }
    } catch {
      return fallback;
    }
  };

  if (!opts.forceRefresh && _audioCapabilitiesPromise) {
    return _audioCapabilitiesPromise;
  }

  _audioCapabilitiesPromise = runProbe();
  return _audioCapabilitiesPromise;
}

/** Test helper to clear memoized audio probe state between tests. */
export function __resetAudioCapabilitiesCacheForTests(): void {
  _audioCapabilitiesPromise = null;
}

/**
 * Test helper: direct access to classifyTier for unit-testing the scoring
 * and penalty logic without going through the full WebGL probe pipeline.
 * Not part of the public API.
 */
export function __classifyTierForTests(
  cpuCores: number,
  memoryGB: number | null,
  isSoftware: boolean,
  gpuScore: number,
  gpuCaps: GPUCapabilities,
  chromeos: boolean,
  isMobile = false
): PerformanceTier {
  return classifyTier(cpuCores, memoryGB, isSoftware, gpuScore, gpuCaps, chromeos, isMobile);
}

// ── Effective mode resolution ─────────────────────────────────────────────────

/**
 * Resolve the actual performance mode taking the user's override into account.
 *
 * "auto" → uses the detected recommendation.
 */
export function resolveMode(
  userMode: PerformanceMode,
  caps: DeviceCapabilities
): "performance" | "quality" {
  if (userMode === "auto") return caps.recommendedMode;
  return userMode;
}

/**
 * Resolve the performance tier for core option selection.
 *
 * In "auto" mode, uses the detected hardware tier.
 * In "performance" mode, always returns "low".
 * In "quality" mode, returns the detected tier clamped to at least "high".
 */
export function resolveTier(
  userMode: PerformanceMode,
  caps: DeviceCapabilities
): PerformanceTier {
  if (userMode === "auto") return caps.tier;
  if (userMode === "performance") return "low";
  // quality mode: ensure at least "high" settings
  return caps.tier === "ultra" ? "ultra" : "high";
}

// ── Human-readable summaries ──────────────────────────────────────────────────

const TIER_LABELS: Record<PerformanceTier, string> = {
  low:    "Low",
  medium: "Medium",
  high:   "High",
  ultra:  "Ultra",
};

export function formatTierLabel(tier: PerformanceTier): string {
  return TIER_LABELS[tier];
}

export function formatCapabilitiesSummary(caps: DeviceCapabilities): string {
  const ram = caps.deviceMemoryGB !== null
    ? `${caps.deviceMemoryGB} GB RAM`
    : "RAM unknown";
  const cores = `${caps.cpuCores} CPU ${caps.cpuCores === 1 ? "core" : "cores"}`;
  const gpu = caps.isSoftwareGPU
    ? "Software GPU (slow)"
    : caps.gpuRenderer !== "unknown"
      ? caps.gpuRenderer.replace(/\(.*?\)/g, "").trim()
      : "GPU info unavailable";
  const chromeosSuffix = caps.isChromOS ? " · Chromebook" : "";
  const mobileSuffix = caps.isIOS ? " · iPhone/iPad" : caps.isAndroid ? " · Android" : "";
  const safariBrowserSuffix = !caps.isIOS && caps.isSafari ? " · Safari" : "";
  return `${ram} · ${cores} · ${gpu}${chromeosSuffix}${mobileSuffix}${safariBrowserSuffix}`;
}

export function formatDetailedSummary(caps: DeviceCapabilities): string {
  const lines: string[] = [];
  lines.push(`Tier: ${formatTierLabel(caps.tier)} (score: ${caps.gpuBenchmarkScore}/100)`);
  lines.push(formatCapabilitiesSummary(caps));
  lines.push(`Max texture: ${caps.gpuCaps.maxTextureSize}px`);
  if (caps.gpuCaps.anisotropicFiltering) {
    lines.push(`Anisotropic: ${caps.gpuCaps.maxAnisotropy}×`);
  }
  if (caps.gpuCaps.webgl2)             lines.push("WebGL 2: yes");
  if (caps.gpuCaps.multiDraw)          lines.push("Multi-draw: yes");
  if (caps.gpuCaps.compressedTextures) lines.push("Compressed textures: yes");
  lines.push(`Estimated VRAM: ${caps.estimatedVRAMMB} MB`);
  if (caps.webgpuAvailable)            lines.push("WebGPU: available");
  if (caps.connectionQuality !== "unknown") lines.push(`Network: ${caps.connectionQuality}`);
  if (caps.isChromOS) {
    lines.push("Device: Chromebook (conservative tier applied)");
  }
  if (caps.isIOS) {
    lines.push("Device: iPhone/iPad (iOS) — memory-constrained browser; tier capped at High");
  } else if (caps.isAndroid) {
    lines.push("Device: Android — WebGL performance varies by device; tier capped at High");
  } else if (caps.isSafari) {
    const verLabel = caps.safariVersion !== null ? ` ${caps.safariVersion}` : "";
    const pspNote = caps.safariVersion !== null && caps.safariVersion >= 17
      ? "PSP is supported (Safari 17+)"
      : "PSP requires Safari 17+";
    lines.push(`Browser: Safari${verLabel} (macOS) — some APIs limited; ${pspNote}`);
  }
  return lines.join("\n");
}

// ── Object pool ───────────────────────────────────────────────────────────────

/**
 * Generic object pool that eliminates per-frame heap allocations for
 * frequently-created short-lived objects (vectors, draw commands, events, etc.).
 *
 * The pool pre-allocates up to `maxSize` instances via a factory function.
 * `acquire()` returns a recycled instance (resetting it with the optional
 * `reset` callback) or creates a new one when the pool is empty.
 * `release()` returns an instance back to the pool; it is silently dropped
 * when the pool is already full to prevent unbounded memory growth.
 *
 * Zero GC pressure during normal gameplay: no Array.push/pop allocations, no
 * garbage generated while the pool is neither empty nor overflowed.
 *
 * Usage:
 * ```typescript
 * interface Vec2 { x: number; y: number }
 * const pool = new ObjectPool<Vec2>(
 *   () => ({ x: 0, y: 0 }),                    // factory
 *   (v, x, y) => { v.x = x; v.y = y; },       // reset
 *   256,                                        // maxSize
 * );
 * const v = pool.acquire(3, 4);
 * // … use v …
 * pool.release(v);
 * ```
 */
export class ObjectPool<T, A extends unknown[] = []> {
  private readonly _pool: T[] = [];
  private readonly _factory: () => T;
  private readonly _reset?: (obj: T, ...args: A) => void;
  private readonly _maxSize: number;

  /** Total number of objects currently held in the pool. */
  get size(): number { return this._pool.length; }

  /**
   * @param factory  Creates a new instance when the pool is empty.
   * @param reset    Optional function called on recycled instances before
   *                 they are returned from `acquire()`.
   * @param maxSize  Maximum pool capacity (excess releases are discarded).
   *                 Default: 128.
   */
  constructor(factory: () => T, reset?: (obj: T, ...args: A) => void, maxSize = 128) {
    this._factory = factory;
    this._reset   = reset;
    this._maxSize = maxSize;
  }

  /**
   * Acquire an object from the pool, or create a fresh one when empty.
   *
   * @param args  Passed directly to the `reset` callback so callers can
   *              initialise the recycled object in a single call.
   */
  acquire(...args: A): T {
    const obj = this._pool.length > 0
      ? this._pool.pop()!
      : this._factory();
    this._reset?.(obj, ...args);
    return obj;
  }

  /**
   * Return an object to the pool for future reuse.
   * Objects are silently discarded when the pool is at capacity.
   */
  release(obj: T): void {
    if (this._pool.length < this._maxSize) {
      this._pool.push(obj);
    }
  }

  /** Pre-fill the pool with `count` fresh instances (optional warm-up). */
  prewarm(count: number): void {
    const needed = Math.min(count, this._maxSize) - this._pool.length;
    for (let i = 0; i < needed; i++) {
      this._pool.push(this._factory());
    }
  }

  /** Drain all pooled objects (e.g. on scene teardown). */
  clear(): void {
    this._pool.length = 0;
  }
}

// ── Spatial grid ──────────────────────────────────────────────────────────────

/**
 * Fixed-cell uniform spatial grid for O(1) insertion/removal and
 * O(k) nearest-cell queries, where k is the average objects-per-cell.
 *
 * Intended for entity/physics broad-phase: instead of checking every
 * entity against every other entity (O(n²)), only entities in
 * neighbouring cells are compared (typically O(1)–O(n) in practice).
 *
 * The grid covers [0, worldWidth) × [0, worldHeight) in world-space units.
 * Objects outside this range are clamped to the boundary cell.
 *
 * Usage:
 * ```typescript
 * const grid = new SpatialGrid<Entity>(1000, 1000, 64); // 64×64 cells
 * grid.insert(entity, entity.x, entity.y);
 * const nearby = grid.query(x - 64, y - 64, x + 64, y + 64);
 * grid.remove(entity, entity.x, entity.y);
 * ```
 */
export class SpatialGrid<T> {
  private readonly _cols: number;
  private readonly _rows: number;
  private readonly _cellSize: number;
  private readonly _cells: Set<T>[];

  /** Number of columns in the grid. */
  get cols(): number { return this._cols; }
  /** Number of rows in the grid. */
  get rows(): number { return this._rows; }
  /** Cell size in world-space units. */
  get cellSize(): number { return this._cellSize; }

  /**
   * @param worldWidth   Total width of the simulated world in world-space units.
   * @param worldHeight  Total height of the simulated world in world-space units.
   * @param cellSize     Width/height of each cell in world-space units.
   *                     Smaller cells = fewer candidates per query, but more
   *                     memory. A good starting point is ~2× the largest entity.
   */
  constructor(worldWidth: number, worldHeight: number, cellSize: number) {
    if (cellSize <= 0) throw new RangeError("SpatialGrid: cellSize must be > 0");
    this._cellSize = cellSize;
    this._cols = Math.max(1, Math.ceil(worldWidth  / cellSize));
    this._rows = Math.max(1, Math.ceil(worldHeight / cellSize));
    this._cells = Array.from({ length: this._cols * this._rows }, () => new Set<T>());
  }

  private _cellIndex(x: number, y: number): number {
    const col = Math.min(Math.max(0, Math.floor(x / this._cellSize)), this._cols - 1);
    const row = Math.min(Math.max(0, Math.floor(y / this._cellSize)), this._rows - 1);
    return row * this._cols + col;
  }

  /** Insert an object at the given world-space position. */
  insert(obj: T, x: number, y: number): void {
    this._cells[this._cellIndex(x, y)]!.add(obj);
  }

  /**
   * Remove an object from the cell it was inserted into.
   *
   * The caller must supply the same (x, y) used during `insert`.
   * If the object has moved, call `move()` instead.
   */
  remove(obj: T, x: number, y: number): void {
    this._cells[this._cellIndex(x, y)]!.delete(obj);
  }

  /**
   * Move an object from its old position to a new one in a single call.
   * Equivalent to `remove(obj, oldX, oldY); insert(obj, newX, newY)` but
   * skips the Set operations when the cell has not changed (common case for
   * slowly-moving entities in a coarse grid).
   */
  move(obj: T, oldX: number, oldY: number, newX: number, newY: number): void {
    const oldIdx = this._cellIndex(oldX, oldY);
    const newIdx = this._cellIndex(newX, newY);
    if (oldIdx !== newIdx) {
      this._cells[oldIdx]!.delete(obj);
      this._cells[newIdx]!.add(obj);
    }
  }

  /**
   * Return all objects whose insertion point falls within the axis-aligned
   * bounding box [minX, maxX] × [minY, maxY].
   *
   * Returns a new `Set<T>` containing the candidates. The set may include
   * objects that are slightly outside the query box when they lie in a
   * partially-overlapping cell — callers should perform a precise AABB check
   * on the returned candidates if exact containment is required.
   */
  query(minX: number, minY: number, maxX: number, maxY: number): Set<T> {
    const result = new Set<T>();
    const colMin = Math.min(Math.max(0, Math.floor(minX / this._cellSize)), this._cols - 1);
    const colMax = Math.min(Math.max(0, Math.floor(maxX / this._cellSize)), this._cols - 1);
    const rowMin = Math.min(Math.max(0, Math.floor(minY / this._cellSize)), this._rows - 1);
    const rowMax = Math.min(Math.max(0, Math.floor(maxY / this._cellSize)), this._rows - 1);
    for (let r = rowMin; r <= rowMax; r++) {
      for (let c = colMin; c <= colMax; c++) {
        for (const obj of this._cells[r * this._cols + c]!) {
          result.add(obj);
        }
      }
    }
    return result;
  }

  /** Remove all objects from every cell. */
  clear(): void {
    for (const cell of this._cells) cell.clear();
  }
}

// ── Frame budget ──────────────────────────────────────────────────────────────

/**
 * Frame-time budget tracker for real-time engines.
 *
 * Divides each frame into a fixed time quota (default: 16 ms for 60 fps).
 * Work items queued with `enqueue()` are executed sequentially in FIFO order
 * during `flush()`. `flush()` stops consuming items the moment the elapsed
 * time since `beginFrame()` exceeds the budget, deferring remaining work to
 * the next frame. This prevents frame spikes caused by bursty workloads
 * (e.g. streaming asset decoding, pathfinding updates, AI evaluation).
 *
 * Usage:
 * ```typescript
 * const budget = new FrameBudget(14); // 14 ms budget per frame
 *
 * // Each rAF tick:
 * budget.beginFrame();
 * budget.enqueue(() => updateAI());
 * budget.enqueue(() => processPhysics());
 * budget.flush();  // stops at 14 ms; leftover work runs next frame
 * ```
 */
export class FrameBudget {
  private _queue: (() => void)[] = [];
  private _frameStart = 0;
  private readonly _budgetMs: number;

  /** Number of work items currently waiting in the queue. */
  get pendingCount(): number { return this._queue.length; }

  /**
   * @param budgetMs  Maximum milliseconds of deferred work to execute per
   *                  frame. Default: 16 ms (one 60 fps frame).
   */
  constructor(budgetMs = 16) {
    this._budgetMs = budgetMs;
  }

  /**
   * Mark the start of a new frame.
   *
   * Call this once at the beginning of each `requestAnimationFrame` callback,
   * before enqueuing or flushing work items.
   */
  beginFrame(): void {
    this._frameStart = performance.now();
  }

  /**
   * Elapsed milliseconds since `beginFrame()` was last called.
   * Returns 0 when `beginFrame()` has not yet been called.
   */
  elapsed(): number {
    return this._frameStart === 0 ? 0 : performance.now() - this._frameStart;
  }

  /** Returns true when the per-frame budget has been consumed. */
  isOverBudget(): boolean {
    return this.elapsed() >= this._budgetMs;
  }

  /**
   * Enqueue a unit of deferred work to be executed during `flush()`.
   *
   * @param task  A zero-argument function to run within the frame budget.
   */
  enqueue(task: () => void): void {
    this._queue.push(task);
  }

  /**
   * Execute queued tasks until the frame budget is exhausted or the queue
   * is empty. Remaining tasks are carried over to the next frame.
   *
   * Uses an index cursor instead of `shift()` so the underlying array is
   * only spliced once at the end, making the inner loop O(1) per task
   * rather than O(n).
   *
   * @returns The number of tasks executed this call.
   */
  flush(): number {
    let i = 0;
    while (i < this._queue.length && !this.isOverBudget()) {
      this._queue[i++]!();
    }
    if (i > 0) {
      this._queue.splice(0, i);
    }
    return i;
  }

  /** Discard all queued tasks (e.g. on scene change or teardown). */
  clear(): void {
    this._queue.length = 0;
  }
}

// ── Draw call batcher ─────────────────────────────────────────────────────────

/**
 * Describes a single WebGL draw call to be batched.
 */
export interface DrawCommand {
  /** WebGL draw mode (e.g. `gl.TRIANGLES`). */
  mode: number;
  /** Number of vertices to draw. */
  count: number;
  /** Byte offset into the index buffer, or 0 for non-indexed draws. */
  offset: number;
  /** Texture unit index to bind before drawing (0–15). */
  textureUnit: number;
  /**
   * Opaque handle identifying the shader program. Commands with the same
   * `programId` are grouped together to minimise program switches.
   */
  programId: number;
}

/**
 * Lightweight CPU-side draw call batcher.
 *
 * Accumulates `DrawCommand` descriptors during a frame and sorts them before
 * dispatch to minimise expensive GPU state changes:
 *   1. By `programId` — avoids shader program switches (most expensive).
 *   2. By `textureUnit` — reduces texture-bind overhead.
 *   3. By `offset` — improves index-buffer locality.
 *
 * Commands are stored in a pre-allocated ring buffer (`maxCommands`) to
 * avoid per-frame heap allocations. `ObjectPool` is used internally to
 * recycle `DrawCommand` objects.
 *
 * Usage:
 * ```typescript
 * const batcher = new DrawCallBatcher(1024);
 * // During scene traversal:
 * batcher.add(gl.TRIANGLES, 36, 0, 0, shaderA.id);
 * batcher.add(gl.TRIANGLES, 12, 36, 1, shaderB.id);
 * // At the end of the frame:
 * for (const cmd of batcher.flush()) {
 *   gl.useProgram(programs[cmd.programId]);
 *   gl.bindTexture(gl.TEXTURE_2D, textures[cmd.textureUnit]);
 *   gl.drawElements(cmd.mode, cmd.count, gl.UNSIGNED_SHORT, cmd.offset);
 * }
 * ```
 */
export class DrawCallBatcher {
  private readonly _pool: ObjectPool<DrawCommand, [number, number, number, number, number]>;
  private _pending: DrawCommand[] = [];
  /**
   * Commands returned by the previous `flush()` that are safe to recycle
   * once the caller has had a full frame to consume them. Recycling is
   * deferred to the *start* of the next `flush()` call so that callers can
   * safely iterate the returned array without risking pool reuse corruption.
   */
  private _toRecycle: DrawCommand[] = [];
  private readonly _maxCommands: number;

  /** Number of draw commands accumulated since the last `flush()`. */
  get pendingCount(): number { return this._pending.length; }

  /**
   * @param maxCommands  Maximum draw commands per frame before older ones are
   *                     silently dropped. Default: 1024.
   */
  constructor(maxCommands = 1024) {
    this._maxCommands = maxCommands;
    this._pool = new ObjectPool<DrawCommand, [number, number, number, number, number]>(
      () => ({ mode: 0, count: 0, offset: 0, textureUnit: 0, programId: 0 }),
      (cmd, mode, count, offset, textureUnit, programId) => {
        cmd.mode        = mode;
        cmd.count       = count;
        cmd.offset      = offset;
        cmd.textureUnit = textureUnit;
        cmd.programId   = programId;
      },
      maxCommands,
    );
  }

  /**
   * Record a draw command to be dispatched during the next `flush()`.
   *
   * @param mode        WebGL primitive mode (e.g. `gl.TRIANGLES = 4`).
   * @param count       Number of vertices/indices to draw.
   * @param offset      Byte offset into the index/vertex buffer.
   * @param textureUnit Texture unit index (0–15).
   * @param programId   Opaque shader program identifier for state sorting.
   */
  add(mode: number, count: number, offset: number, textureUnit: number, programId: number): void {
    if (this._pending.length >= this._maxCommands) return;
    this._pending.push(this._pool.acquire(mode, count, offset, textureUnit, programId));
  }

  /**
   * Sort pending commands to minimise GPU state changes and return them.
   *
   * Command objects from the *previous* `flush()` are recycled at the start
   * of this call, after the caller has had a full frame to consume them.
   * This means callers may safely iterate the returned array until the next
   * `flush()` without risk of pool-reuse corruption.
   *
   * Sort order: programId → textureUnit → offset.
   *
   * @returns The sorted array of pending draw commands.
   */
  flush(): DrawCommand[] {
    // Recycle commands dispatched in the previous frame now that the caller
    // has had a full frame cycle to consume them.
    for (const cmd of this._toRecycle) {
      this._pool.release(cmd);
    }
    this._pending.sort((a, b) =>
      a.programId   !== b.programId   ? a.programId   - b.programId   :
      a.textureUnit !== b.textureUnit ? a.textureUnit - b.textureUnit :
      a.offset      - b.offset
    );
    this._toRecycle = this._pending;
    this._pending = [];
    return this._toRecycle;
  }

  /** Discard all pending commands without executing them. */
  clear(): void {
    for (const cmd of this._toRecycle) {
      this._pool.release(cmd);
    }
    this._toRecycle = [];
    for (const cmd of this._pending) {
      this._pool.release(cmd);
    }
    this._pending = [];
  }
}

// ── UI dirty-flag system ──────────────────────────────────────────────────────

/**
 * Bit-flag constants for each independently re-renderable UI region.
 *
 * Combine with bitwise OR to mark multiple regions dirty at once:
 *   flags.mark(UIDirtyFlags.LIBRARY | UIDirtyFlags.FPS_OVERLAY)
 *
 * The values are powers of two so they can be stored in a single integer and
 * tested cheaply with bitwise AND.
 */
export const UIDirtyFlags = {
  /** Game library grid — card list needs re-render. */
  LIBRARY:         0b00000001,
  /** FPS overlay text values need updating. */
  FPS_OVERLAY:     0b00000010,
  /** Developer debug overlay values need updating. */
  DEV_OVERLAY:     0b00000100,
  /** In-game header status (state dot, tier badge). */
  HEADER_STATUS:   0b00001000,
  /** Settings panel content. */
  SETTINGS:        0b00010000,
  /** Touch controls overlay layout. */
  TOUCH_CONTROLS:  0b00100000,
  /** All regions. */
  ALL:             0b00111111,
} as const;

export type UIDirtyFlagBit = typeof UIDirtyFlags[keyof typeof UIDirtyFlags];

/**
 * Lightweight dirty-flag tracker for the UI render pipeline.
 *
 * Rather than re-rendering all UI regions every frame, consumers mark
 * specific regions dirty and then call `consume()` in the render loop.
 * Regions that have not changed since the last consume are skipped,
 * reducing redundant DOM mutations and layout reflows.
 *
 * ### Usage
 * ```ts
 * const dirty = new UIDirtyTracker();
 *
 * // Mark specific regions that changed:
 * dirty.mark(UIDirtyFlags.FPS_OVERLAY);
 *
 * // In your render loop:
 * if (dirty.consume(UIDirtyFlags.FPS_OVERLAY)) updateFPSOverlay();
 * if (dirty.consume(UIDirtyFlags.LIBRARY))     renderLibrary();
 * ```
 *
 * The tracker is intentionally not reactive — it does not schedule its own
 * render loop. Callers remain in control of when rendering happens, which
 * keeps the system compatible with requestAnimationFrame, setTimeout, or
 * any other scheduling strategy.
 */
export class UIDirtyTracker {
  private _flags = 0;

  /**
   * Mark one or more UI regions as dirty.
   *
   * @param flags  Bitwise OR of {@link UIDirtyFlags} constants.
   */
  mark(flags: number): void {
    this._flags |= flags;
  }

  /**
   * Return `true` if any of the given regions are dirty, then clear them.
   *
   * Call this once per region per render-loop tick. The region is
   * automatically cleared so subsequent calls in the same tick return
   * `false` unless the region is marked dirty again.
   *
   * @param flags  Bitwise OR of {@link UIDirtyFlags} constants to test.
   */
  consume(flags: number): boolean {
    const dirty = (this._flags & flags) !== 0;
    if (dirty) this._flags &= ~flags;
    return dirty;
  }

  /**
   * Return `true` if any of the given regions are dirty without clearing.
   *
   * Useful for conditional checks that should not advance the render state.
   *
   * @param flags  Bitwise OR of {@link UIDirtyFlags} constants to test.
   */
  peek(flags: number): boolean {
    return (this._flags & flags) !== 0;
  }

  /** Mark all tracked regions as clean. */
  reset(): void {
    this._flags = 0;
  }

  /** Raw bitmask of all currently dirty regions. */
  get raw(): number {
    return this._flags;
  }
}


// ── Asset loader ──────────────────────────────────────────────────────────────

/** Priority levels for {@link AssetLoader} requests. Lower number = higher priority. */
export type AssetPriority = 0 | 1 | 2 | 3;

/** A pending or in-flight asset load request. */
interface AssetRequest<T> {
  key: string;
  priority: AssetPriority;
  load: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * Priority-queue asset loader that limits the number of concurrent loads to
 * prevent network/decode saturation on low-end devices.
 *
 * Assets are requested with a priority (0 = critical, 3 = background) and
 * the loader dispatches at most `concurrency` loads simultaneously. When a
 * slot opens, the highest-priority pending request is started next.
 *
 * Already-loaded assets are returned from an in-memory cache, eliminating
 * redundant decoding for assets used by multiple entities in the same scene.
 *
 * ### Techniques
 * - **Priority queue**: O(1) enqueue, O(n) dequeue (n is typically small).
 * - **In-memory cache**: duplicate requests complete instantly without
 *   touching the network or disk.
 * - **Concurrency cap**: prevents frame spikes caused by simultaneous
 *   large-asset decodes.
 *
 * ### Usage
 * ```typescript
 * const loader = new AssetLoader(4);
 * const tex = await loader.load('hero-sprite', 0, () => fetchTexture('hero.png'));
 * ```
 */
export class AssetLoader<T> {
  private readonly _cache   = new Map<string, T>();
  private readonly _pending: AssetRequest<T>[] = [];
  private _inFlight = 0;
  private readonly _concurrency: number;

  /** Number of assets currently loading. */
  get inFlight(): number { return this._inFlight; }
  /** Number of requests waiting to start. */
  get pendingCount(): number { return this._pending.length; }

  /**
   * @param concurrency  Maximum simultaneous in-flight loads. Default: 4.
   */
  constructor(concurrency = 4) {
    this._concurrency = Math.max(1, concurrency);
  }

  /**
   * Request an asset load.
   *
   * If the asset is already cached the promise resolves synchronously on the
   * next microtask. If an identical key is already loading, a second request
   * is queued normally — callers should deduplicate by checking `has()` first
   * if strict deduplication beyond the cache is needed.
   *
   * @param key       Unique identifier for the asset (used as cache key).
   * @param priority  Load priority. 0 = highest, 3 = lowest.
   * @param load      Async factory that fetches/decodes the asset.
   */
  load(key: string, priority: AssetPriority, load: () => Promise<T>): Promise<T> {
    const cached = this._cache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);

    return new Promise<T>((resolve, reject) => {
      this._pending.push({ key, priority, load, resolve, reject });
      this._drain();
    });
  }

  /** Return `true` if the asset is already in the cache. */
  has(key: string): boolean {
    return this._cache.has(key);
  }

  /** Retrieve a cached asset synchronously, or `undefined` if not loaded. */
  get(key: string): T | undefined {
    return this._cache.get(key);
  }

  /** Evict a single asset from the cache. */
  evict(key: string): void {
    this._cache.delete(key);
  }

  /** Evict all cached assets (e.g. on scene teardown). */
  clearCache(): void {
    this._cache.clear();
  }

  private _drain(): void {
    while (this._inFlight < this._concurrency && this._pending.length > 0) {
      // Pop the highest-priority (lowest priority number) request.
      let bestIdx = 0;
      for (let i = 1; i < this._pending.length; i++) {
        if (this._pending[i]!.priority < this._pending[bestIdx]!.priority) {
          bestIdx = i;
        }
      }
      const req = this._pending.splice(bestIdx, 1)[0]!;
      this._inFlight++;
      req.load().then(
        (value) => {
          this._cache.set(req.key, value);
          req.resolve(value);
          this._inFlight--;
          this._drain();
        },
        (err) => {
          req.reject(err);
          this._inFlight--;
          this._drain();
        },
      );
    }
  }
}

// ── Mobile-aware performance helpers ─────────────────────────────────────────

/**
 * Return the recommended maximum concurrent asset loads for the device.
 *
 * Mobile browsers share a single process across tabs and have tighter memory
 * bandwidth than desktop. Reducing concurrency prevents frame spikes caused
 * by simultaneous large-asset decodes and avoids saturating the network on
 * constrained connections.
 *
 * Callers should pass the result to `new AssetLoader(concurrency)`:
 * ```typescript
 * const loader = new AssetLoader(recommendedAssetConcurrency(caps));
 * ```
 */
export function recommendedAssetConcurrency(caps: DeviceCapabilities): number {
  if (caps.isMobile) {
    // Mobile: keep concurrency low to avoid OOM and network contention.
    return caps.tier === "low" ? 1 : 2;
  }
  switch (caps.tier) {
    case "low":    return 2;
    case "medium": return 4;
    case "high":   return 6;
    case "ultra":  return 8;
  }
}

/**
 * Return the recommended per-frame deferred-work budget in milliseconds.
 *
 * Deferred-work systems (e.g. `FrameBudget`) need a budget sized to leave
 * enough headroom for the main render pass. Mobile devices and low-spec
 * hardware have shorter effective frame windows due to thermal throttling
 * and tighter memory bandwidth, so their budgets are conservatively lower.
 *
 * At 60 fps the total frame budget is ~16 ms. These values reserve a portion
 * of that for background work while ensuring the render pass is not starved.
 *
 * Callers should pass the result to `new FrameBudget(budgetMs)`:
 * ```typescript
 * const budget = new FrameBudget(recommendedFrameBudgetMs(caps));
 * ```
 */
export function recommendedFrameBudgetMs(caps: DeviceCapabilities): number {
  if (caps.isMobile) {
    // Mobile SoCs throttle aggressively; keep deferred work short.
    return caps.tier === "low" ? 4 : 8;
  }
  switch (caps.tier) {
    case "low":    return 8;
    case "medium": return 12;
    case "high":   return 14;
    case "ultra":  return 16;
  }
}

// ── Thermal monitor (Compute Pressure API) ────────────────────────────────────

/**
 * Thermal/compute pressure state observed via the Compute Pressure API.
 *
 * - "nominal"  — Device is running cool; no throttling expected.
 * - "fair"     — Minor thermal load; brief throttling bursts possible.
 * - "serious"  — Sustained high thermal load; performance is impacted.
 * - "critical" — Device is overheating; OS-level throttling is active.
 * - "unknown"  — Compute Pressure API is unavailable in this browser.
 */
export type ThermalPressureState = "nominal" | "fair" | "serious" | "critical" | "unknown";

/**
 * Monitors CPU/thermal pressure using the Compute Pressure API (Chrome 125+).
 *
 * When the API is unavailable the monitor enters "unknown" state and no
 * callbacks are fired. Callers should treat "unknown" as "nominal" for
 * decision-making purposes.
 *
 * ### Usage
 * ```typescript
 * const monitor = new ThermalMonitor();
 * monitor.onPressureChange = (state, prev) => {
 *   if (state === "serious" || state === "critical") {
 *     emulator.suggestTierDowngrade();
 *   }
 * };
 * await monitor.start();
 * // … later …
 * monitor.stop();
 * ```
 */
export class ThermalMonitor {
  private _state: ThermalPressureState = "unknown";
  private _observer: unknown = null;   // PressureObserver (typed as unknown for API compat)
  private _running = false;

  /**
   * Fired when the compute pressure state transitions to a new value.
   * The second argument is the previous state.
   */
  onPressureChange?: (state: ThermalPressureState, prev: ThermalPressureState) => void;

  /** Current pressure state. "unknown" when the API is unavailable. */
  get state(): ThermalPressureState { return this._state; }

  /** Whether the Compute Pressure API is available in this browser. */
  static isSupported(): boolean {
    return typeof (globalThis as Record<string, unknown>)["PressureObserver"] === "function";
  }

  /**
   * Start observing CPU pressure.
   *
   * Resolves immediately when the Compute Pressure API is unavailable —
   * the instance remains in "unknown" state but is otherwise harmless.
   *
   * @returns Promise that resolves once observation has started (or been
   *          determined to be unsupported).
   */
  async start(): Promise<void> {
    if (this._running) return;
    const PO = (globalThis as Record<string, unknown>)["PressureObserver"] as
      | { new(cb: (records: Array<{ state: string }>) => void): { observe(source: string): Promise<void>; unobserve(source: string): void } }
      | undefined;
    if (!PO) return;

    this._running = true;
    this._observer = new PO((records: Array<{ state: string }>) => {
      const last = records[records.length - 1];
      if (!last) return;
      const next = this._mapState(last.state);
      if (next !== this._state) {
        const prev = this._state;
        this._state = next;
        this.onPressureChange?.(next, prev);
      }
    });
    try {
      await (this._observer as { observe(source: string): Promise<void> }).observe("cpu");
    } catch {
      // Observation start failed (e.g. permissions policy) — stay in "unknown"
      this._running = false;
      this._observer = null;
    }
  }

  /** Stop observing CPU pressure. */
  stop(): void {
    if (!this._running || !this._observer) return;
    try {
      (this._observer as { unobserve(source: string): void }).unobserve("cpu");
    } catch { /* ignore */ }
    this._running = false;
    this._observer = null;
    this._state = "unknown";
  }

  private _mapState(raw: string): ThermalPressureState {
    if (raw === "nominal" || raw === "fair" || raw === "serious" || raw === "critical") {
      return raw as ThermalPressureState;
    }
    return "unknown";
  }
}

// ── Startup profiler ──────────────────────────────────────────────────────────

/**
 * A named phase in the emulator launch pipeline.
 *
 * - "core_download" — Time spent fetching the JS glue + WASM files from CDN.
 * - "wasm_compile"  — Time spent compiling the WASM binary (streaming or sync).
 * - "bios_load"     — Time spent fetching + loading the system BIOS file.
 * - "first_frame"   — Time from EJS_ready until `EJS_onGameStart` fires.
 */
export type LaunchPhase = "core_download" | "wasm_compile" | "bios_load" | "first_frame";

/** A completed launch phase with start and end timestamps (performance.now). */
export interface LaunchPhaseRecord {
  phase:      LaunchPhase;
  startMs:    number;
  endMs:      number;
  durationMs: number;
}

/**
 * High-resolution launch phase profiler.
 *
 * Records how long each phase of the emulator startup takes.  The slowest
 * phase is surfaced so the caller can display a targeted optimisation hint
 * (e.g. "Slow core download — check your connection").
 *
 * ### Usage
 * ```typescript
 * const profiler = new StartupProfiler();
 * profiler.begin("core_download");
 * // … fetch core files …
 * profiler.end("core_download");
 * profiler.begin("first_frame");
 * // … wait for EJS_onGameStart …
 * profiler.end("first_frame");
 *
 * const summary = profiler.summary();
 * console.log(`Total: ${summary.totalMs.toFixed(0)} ms`);
 * console.log(`Slowest: ${summary.slowest?.phase} (${summary.slowest?.durationMs.toFixed(0)} ms)`);
 * ```
 */
export class StartupProfiler {
  private _phases: Map<LaunchPhase, { startMs: number; endMs?: number }> = new Map();

  /** Mark the start of a launch phase. Idempotent per phase. */
  begin(phase: LaunchPhase): void {
    if (this._phases.has(phase)) return;
    this._phases.set(phase, { startMs: this._now() });
  }

  /**
   * Mark the end of a launch phase.
   *
   * Silently no-ops when `begin()` has not been called for this phase, or when
   * `end()` has already been called (idempotent).
   */
  end(phase: LaunchPhase): void {
    const rec = this._phases.get(phase);
    if (!rec) return;
    if (rec.endMs === undefined) {
      rec.endMs = this._now();
    }
  }

  /** Return all completed phase records, sorted by start time. */
  records(): LaunchPhaseRecord[] {
    const out: LaunchPhaseRecord[] = [];
    for (const [phase, rec] of this._phases) {
      if (rec.endMs !== undefined) {
        out.push({
          phase,
          startMs:    rec.startMs,
          endMs:      rec.endMs,
          durationMs: rec.endMs - rec.startMs,
        });
      }
    }
    out.sort((a, b) => a.startMs - b.startMs);
    return out;
  }

  /**
   * Summary of all completed phases.
   *
   * Returns the total elapsed time across completed phases, the slowest
   * individual phase, and all records.
   */
  summary(): { totalMs: number; slowest: LaunchPhaseRecord | null; records: LaunchPhaseRecord[] } {
    const recs = this.records();
    let totalMs = 0;
    let slowest: LaunchPhaseRecord | null = null;
    for (const r of recs) {
      totalMs += r.durationMs;
      if (!slowest || r.durationMs > slowest.durationMs) slowest = r;
    }
    return { totalMs, slowest, records: recs };
  }

  /** Reset all phase records (e.g. before a new launch attempt). */
  reset(): void {
    this._phases.clear();
  }

  private _now(): number {
    try { return performance.now(); } catch { return Date.now(); }
  }
}

// ── FPS prediction ────────────────────────────────────────────────────────────

/**
 * Collects FPS samples over an initial observation window and predicts
 * whether the current tier can sustain 60 fps long-term.
 *
 * Uses a simple linear-regression trend over the collected samples to
 * determine if FPS is stable, degrading, or recovering. After `windowMs`
 * milliseconds the prediction is locked in and no new samples are accepted.
 *
 * ### Design
 * - Observation window: first 5 s of gameplay (configurable).
 * - Minimum samples: 3 (fewer gives an unreliable prediction).
 * - FPS threshold: 55 fps → "sustainable"; below → "unsustainable".
 * - Trend threshold: slope < −2 fps/s over the window → "degrading".
 */
export class FpsPrediction {
  private readonly _windowMs:    number;
  private readonly _minSamples:  number;
  private readonly _targetFps:   number;
  private _samples: Array<{ t: number; fps: number }> = [];
  private _locked  = false;
  private _startMs = -1;

  /**
   * @param windowMs    Observation window in milliseconds (default 5000).
   * @param targetFps   FPS threshold above which the tier is "sustainable" (default 55).
   * @param minSamples  Minimum samples required for a prediction (default 3).
   */
  constructor(windowMs = 5_000, targetFps = 55, minSamples = 3) {
    this._windowMs   = windowMs;
    this._targetFps  = targetFps;
    this._minSamples = minSamples;
  }

  /**
   * Record a new FPS sample.
   *
   * Samples are ignored after the prediction window closes or when the
   * prediction has been locked.
   *
   * @param fps  Current FPS reading (must be a finite non-negative number).
   * @param nowMs  Current time in ms (defaults to `performance.now()`).
   */
  addSample(fps: number, nowMs?: number): void {
    if (this._locked || !Number.isFinite(fps) || fps < 0) return;
    const t = nowMs ?? this._now();
    if (this._startMs < 0) this._startMs = t;
    if (t - this._startMs > this._windowMs) {
      this._locked = true;
      return;
    }
    this._samples.push({ t, fps });
  }

  /** Whether the observation window has elapsed. */
  get isLocked(): boolean { return this._locked; }

  /** Number of samples collected so far. */
  get sampleCount(): number { return this._samples.length; }

  /**
   * Return a prediction once enough samples have been collected.
   *
   * Returns `null` if fewer than `minSamples` samples are available.
   *
   * ### Result fields
   * - `sustainable`  — `true` when the average FPS meets the threshold AND
   *                    the trend is not strongly negative.
   * - `averageFps`   — Mean FPS over the observation window.
   * - `trendFpsPerS` — FPS slope (fps per second) from linear regression.
   *                    Negative means FPS is degrading; positive means recovery.
   * - `confidence`   — `"low"` | `"medium"` | `"high"` based on sample count.
   */
  predict(): {
    sustainable: boolean;
    averageFps: number;
    trendFpsPerS: number;
    confidence: "low" | "medium" | "high";
  } | null {
    if (this._samples.length < this._minSamples) return null;

    const n = this._samples.length;
    let sumFps = 0;
    for (const s of this._samples) sumFps += s.fps;
    const averageFps = sumFps / n;

    // Linear regression: fps = a*t + b — we want the slope (a) in fps/second
    const tRef = this._samples[0]!.t;
    let sumT  = 0, sumF = 0, sumTF = 0, sumT2 = 0;
    for (const s of this._samples) {
      const tSec = (s.t - tRef) / 1000;
      sumT  += tSec;
      sumF  += s.fps;
      sumTF += tSec * s.fps;
      sumT2 += tSec * tSec;
    }
    const denom = n * sumT2 - sumT * sumT;
    const trendFpsPerS = denom !== 0 ? (n * sumTF - sumT * sumF) / denom : 0;

    // A strongly negative slope (< −2 fps/s) is a warning sign even if the
    // current average is above threshold — the tier is likely unsustainable.
    const sustainable = averageFps >= this._targetFps && trendFpsPerS >= -2;

    const confidence: "low" | "medium" | "high" =
      n >= 20 ? "high" : n >= 8 ? "medium" : "low";

    return { sustainable, averageFps, trendFpsPerS, confidence };
  }

  /** Reset the predictor for a new game session. */
  reset(): void {
    this._samples = [];
    this._locked  = false;
    this._startMs = -1;
  }

  private _now(): number {
    try { return performance.now(); } catch { return Date.now(); }
  }
}

// ── Intelligent core preloading ───────────────────────────────────────────────

const LAUNCH_COUNT_KEY = "rv:launchCounts";

/**
 * Read the persisted per-system launch count map from localStorage.
 *
 * Returns an empty map when localStorage is unavailable or the stored
 * value is not a valid JSON object.
 */
export function getLaunchCounts(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LAUNCH_COUNT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, number>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Increment the launch count for a system and persist to localStorage.
 *
 * @param systemId  EmulatorJS system/core id (e.g. "psp", "n64").
 */
export function recordSystemLaunch(systemId: string): void {
  try {
    const counts = getLaunchCounts();
    counts[systemId] = (counts[systemId] ?? 0) + 1;
    localStorage.setItem(LAUNCH_COUNT_KEY, JSON.stringify(counts));
  } catch { /* localStorage unavailable — ignore */ }
}

/**
 * Return the top N most-frequently-launched system IDs, sorted by descending
 * launch count.
 *
 * @param n  Maximum number of system IDs to return (default 2).
 */
export function getTopLaunchedSystems(n = 2): string[] {
  const counts = getLaunchCounts();
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id]) => id);
}

/**
 * Large WASM cores for polygon-heavy systems. Used to extend idle-time prefetch
 * beyond launch history so first-time users still warm PSP / N64 / PS1 / NDS
 * blobs when bandwidth is available.
 *
 * Order is roughly by typical download size and user demand (heaviest first).
 */
export const HEAVY_3D_CORE_PREFETCH_ORDER: readonly string[] = [
  "psp",
  "n64",
  "psx",
  "nds",
  "segaSaturn",
];

/**
 * Merge the user's most-launched systems with additional heavy 3D cores, without
 * duplicates. Unknown ids are still returned — callers filter with their own
 * prefetch map.
 *
 * @param topN  How many top launch-count systems to include first
 * @param extraHeavy3D  Max additional systems to append from {@link HEAVY_3D_CORE_PREFETCH_ORDER}
 */
export function resolveCorePrefetchSystems(topN: number, extraHeavy3D: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const id of getTopLaunchedSystems(topN)) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  let heavyAdded = 0;
  const cap = Math.max(0, Math.floor(extraHeavy3D));
  for (const id of HEAVY_3D_CORE_PREFETCH_ORDER) {
    if (heavyAdded >= cap) break;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    heavyAdded++;
  }

  return out;
}
