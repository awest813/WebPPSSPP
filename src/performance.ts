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

    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, `
      attribute vec2 a_pos;
      attribute vec2 a_uv;
      varying vec2 v_uv;
      void main() { v_uv = a_uv; gl_Position = vec4(a_pos, 0.0, 1.0); }
    `);
    gl.compileShader(vs);

    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
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

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const uVal = gl.getUniformLocation(prog, "u_val");
    const uTex = gl.getUniformLocation(prog, "u_tex");
    gl.uniform1i(uTex, 0);

    // Interleaved buffer: position (2 floats) + UV (2 floats) per vertex.
    // The UV coordinates are passed to the fragment shader for texture sampling.
    const buf = gl.createBuffer()!;
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
  if (points >= 75) return "ultra";
  if (points >= 50) return "high";
  if (points >= 25) return "medium";
  return "low";
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
  const reducedMotion = prefersReducedMotion();
  const webgpuAvailable = isWebGPUAvailable();
  const connectionQuality = estimateConnectionQuality();
  const jsHeapLimitMB = getJSHeapLimitMB();

  const tier = classifyTier(cpuCores, deviceMemoryGB, isSoftwareGPU, gpuBenchmarkScore, gpuCaps, chromeos);

  const estimatedVRAM = estimateVRAM(gpuCaps);

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
    estimatedVRAMMB: estimatedVRAM,
  };
}

// ── Session-cached capability detection ──────────────────────────────────────

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
 */
export function detectCapabilitiesCached(): DeviceCapabilities {
  try {
    const raw = sessionStorage.getItem(CAPABILITIES_SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DeviceCapabilities;
      // Sanity-check the most critical field to detect truncated/stale entries.
      if ((["low", "medium", "high", "ultra"] as const).includes(parsed.tier)) {
        return parsed;
      }
    }
  } catch {
    // sessionStorage unavailable or JSON corrupt — fall through to fresh detection.
  }

  const caps = detectCapabilities();

  try {
    sessionStorage.setItem(CAPABILITIES_SESSION_KEY, JSON.stringify(caps));
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
      return used ? Math.round(used / (1024 * 1024)) : null;
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
      return limit ? Math.round(limit / (1024 * 1024)) : null;
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
 * Uses `requestIdleCallback` when available (Chromium-based browsers), falling
 * back to `setTimeout(task, 0)` for browsers that do not support it
 * (Safari ≤16, Firefox with `dom.requestIdleCallback.enabled = false`).
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
      const ctx = new AudioContextCtor({ latencyHint: "playback" });
      await ctx.suspend();

      const baseLatencyMs    = (ctx.baseLatency   ?? null) !== null ? (ctx.baseLatency   * 1000) : null;
      const outputLatencyMs  = (ctx.outputLatency  ?? null) !== null ? (ctx.outputLatency * 1000) : null;
      const sampleRate       = ctx.sampleRate;
      const maxChannelCount  = ctx.destination.maxChannelCount ?? null;

      await ctx.close();

      let suggestedBufferTier: AudioCapabilities["suggestedBufferTier"] = "medium";
      if (baseLatencyMs !== null) {
        if (baseLatencyMs <= 8)  suggestedBufferTier = "low";
        else if (baseLatencyMs <= 20) suggestedBufferTier = "medium";
        else                     suggestedBufferTier = "high";
      }

      return { baseLatencyMs, outputLatencyMs, audioWorklet, sampleRate, maxChannelCount, suggestedBufferTier };
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
  chromeos: boolean
): PerformanceTier {
  return classifyTier(cpuCores, memoryGB, isSoftware, gpuScore, gpuCaps, chromeos);
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
  lines.push(`Estimated VRAM: ${caps.estimatedVRAMMB} MB`);
  if (caps.webgpuAvailable)            lines.push("WebGPU: available");
  if (caps.connectionQuality !== "unknown") lines.push(`Network: ${caps.connectionQuality}`);
  if (caps.isChromOS) {
    lines.push("Device: Chromebook (conservative tier applied)");
  }
  return lines.join("\n");
}
