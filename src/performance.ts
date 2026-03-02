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
  /**
   * Suggested audio buffer tier: "low" = minimal latency (≤8 ms base),
   * "medium" = comfortable (≤20 ms), "high" = conservative (>20 ms or unknown).
   */
  suggestedBufferTier: "low" | "medium" | "high";
}

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
    const anisoExt =
      gl.getExtension("EXT_texture_filter_anisotropic") ??
      gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic") ??
      gl.getExtension("MOZ_EXT_texture_filter_anisotropic");
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
    const multiDraw = !!(
      gl.getExtension("WEBGL_multi_draw") ||
      (gl instanceof WebGL2RenderingContext && gl.getExtension("WEBGL_multi_draw"))
    );

    return {
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
      maxColorAttachments,
      multiDraw,
    };
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
 * Returns a score 0–100. Intentionally lightweight (≤12ms) to avoid
 * blocking startup, especially on Chromebooks and low-spec hardware.
 */
function benchmarkGPU(): number {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;

    const gl2 = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
    const gl  = gl2 ?? canvas.getContext("webgl") as WebGLRenderingContext | null;
    if (!gl) return 0;

    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, `
      attribute vec2 a_pos;
      void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
    `);
    gl.compileShader(vs);

    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, `
      precision mediump float;
      uniform float u_val;
      void main() { gl_FragColor = vec4(u_val, u_val * 0.5, u_val * 0.25, 1.0); }
    `);
    gl.compileShader(fs);

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const uVal = gl.getUniformLocation(prog, "u_val");

    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );

    const aPos = gl.getAttribLocation(prog, "a_pos");

    // Use VAO when available to reduce per-draw attribute-setup overhead.
    // This more accurately reflects 3D game workloads where VAOs are ubiquitous.
    let vaoExt: VAOExtension | null = null;
    let vao: WebGLVertexArrayObject | null = null;

    if (gl2) {
      vao = gl2.createVertexArray();
      gl2.bindVertexArray(vao);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      gl2.bindVertexArray(null);
    } else {
      // OES_vertex_array_object has a compatible shape — cast via unknown
      const rawExt = gl.getExtension("OES_vertex_array_object");
      if (rawExt) {
        vaoExt = rawExt as unknown as VAOExtension;
        vao = vaoExt.createVertexArrayOES();
        vaoExt.bindVertexArrayOES(vao);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        vaoExt.bindVertexArrayOES(null);
      } else {
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      }
    }

    // Warm up — flush driver lazy-init before timing
    for (let i = 0; i < 10; i++) {
      if (gl2 && vao) gl2.bindVertexArray(vao);
      else if (vaoExt && vao) vaoExt.bindVertexArrayOES(vao);
      gl.uniform1f(uVal, i * 0.1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.finish();

    // Timed run: count draw calls in a fixed budget.
    // 12ms budget is intentionally short to be non-intrusive on slow devices.
    const BUDGET_MS = 12;
    let drawCalls = 0;
    const start = performance.now();

    while (performance.now() - start < BUDGET_MS) {
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
    gl.deleteBuffer(buf);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.deleteProgram(prog);

    // Normalise to 0–100. Thresholds derived from empirical testing:
    //   ~200  draws/12ms  → very slow (software or old mobile)    → score ~2
    //   ~1000 draws/12ms  → mid-range integrated (Chromebook)     → score ~10
    //   ~5000 draws/12ms  → decent discrete GPU                   → score ~50
    //   ~10000+ draws/12ms → high-end desktop                     → score ~100
    const score = Math.min(100, Math.round((drawCalls / 10000) * 100));
    return score;
  } catch {
    return 0;
  }
}

// ── Tier classification ───────────────────────────────────────────────────────

function classifyTier(
  cpuCores: number,
  memoryGB: number | null,
  isSoftware: boolean,
  gpuScore: number,
  gpuCaps: GPUCapabilities,
  chromeos: boolean
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

  // Chrome OS / Chromebook penalty: these devices use power-constrained
  // ARM/Intel Celeron SoCs and often throttle under sustained GPU load.
  // Reduce effective points to avoid over-estimating their capability.
  if (chromeos) points = Math.round(points * 0.75);

  // Classify
  if (points >= 75) return "ultra";
  if (points >= 50) return "high";
  if (points >= 25) return "medium";
  return "low";
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
  const reducedMotion = prefersReducedMotion();
  const webgpuAvailable = isWebGPUAvailable();
  const connectionQuality = estimateConnectionQuality();
  const jsHeapLimitMB = getJSHeapLimitMB();

  const tier = classifyTier(cpuCores, deviceMemoryGB, isSoftwareGPU, gpuBenchmarkScore, gpuCaps, chromeos);

  const isLowSpec = tier === "low";

  return {
    deviceMemoryGB,
    cpuCores,
    gpuRenderer: gpuCaps.renderer,
    isSoftwareGPU,
    isLowSpec,
    isChromOS: chromeos,
    recommendedMode: isLowSpec || tier === "medium" ? "performance" : "quality",
    tier,
    gpuCaps,
    gpuBenchmarkScore,
    prefersReducedMotion: reducedMotion,
    webgpuAvailable,
    connectionQuality,
    jsHeapLimitMB,
  };
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
export async function detectAudioCapabilities(): Promise<AudioCapabilities> {
  const audioWorklet = typeof AudioWorkletNode !== "undefined";
  const fallback: AudioCapabilities = {
    baseLatencyMs: null,
    outputLatencyMs: null,
    audioWorklet,
    sampleRate: null,
    suggestedBufferTier: "medium",
  };

  try {
    const AudioContextCtor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return fallback;

    // Construct suspended so we don't trigger autoplay policy.
    const ctx = new AudioContextCtor({ latencyHint: "playback" });
    await ctx.suspend();

    const baseLatencyMs    = (ctx.baseLatency   ?? null) !== null ? (ctx.baseLatency   * 1000) : null;
    const outputLatencyMs  = (ctx.outputLatency  ?? null) !== null ? (ctx.outputLatency * 1000) : null;
    const sampleRate       = ctx.sampleRate;

    await ctx.close();

    let suggestedBufferTier: AudioCapabilities["suggestedBufferTier"] = "medium";
    if (baseLatencyMs !== null) {
      if (baseLatencyMs <= 8)  suggestedBufferTier = "low";
      else if (baseLatencyMs <= 20) suggestedBufferTier = "medium";
      else                     suggestedBufferTier = "high";
    }

    return { baseLatencyMs, outputLatencyMs, audioWorklet, sampleRate, suggestedBufferTier };
  } catch {
    return fallback;
  }
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
  return `${ram} · ${cores} · ${gpu}${chromeosSuffix}`;
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
  if (caps.isChromOS) {
    lines.push("Device: Chromebook (conservative tier applied)");
  }
  return lines.join("\n");
}
