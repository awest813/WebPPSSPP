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
 * Schema version embedded inside the serialised capabilities object.
 * Increment this when the DeviceCapabilities interface gains or removes fields
 * so that cached entries without the new fields are automatically discarded,
 * even if the sessionStorage key name is not also bumped.
 */
const CAPS_SCHEMA_VERSION = 1;

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
    this._cells[this._cellIndex(x, y)].add(obj);
  }

  /**
   * Remove an object from the cell it was inserted into.
   *
   * The caller must supply the same (x, y) used during `insert`.
   * If the object has moved, call `move()` instead.
   */
  remove(obj: T, x: number, y: number): void {
    this._cells[this._cellIndex(x, y)].delete(obj);
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
      this._cells[oldIdx].delete(obj);
      this._cells[newIdx].add(obj);
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
        for (const obj of this._cells[r * this._cols + c]) {
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
      this._queue[i++]();
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

// ── Entity Component System ───────────────────────────────────────────────────

/**
 * Minimal Entity Component System for real-time update loops.
 *
 * Entities are lightweight numeric IDs. Components are plain data objects
 * stored in typed maps keyed by entity ID. Systems iterate only the entities
 * that possess the components they care about, keeping per-frame work O(n)
 * in the number of relevant entities rather than O(all entities).
 *
 * ### Design goals
 * - **Zero allocation per frame**: component maps are pre-allocated; no
 *   Array.push/pop occurs inside the hot update path.
 * - **Cache-friendly iteration**: all components of the same type are stored
 *   in a single `Map`, which modern engines keep as a dense hash table.
 * - **Simple API**: no decorators, no reflection, no codegen.
 *
 * ### Usage
 * ```typescript
 * const ecs = new EntityComponentSystem();
 * const e = ecs.createEntity();
 * ecs.addComponent(e, 'position', { x: 0, y: 0 });
 * ecs.addComponent(e, 'velocity', { vx: 1, vy: 0 });
 *
 * // Update loop — only entities with both 'position' and 'velocity':
 * for (const id of ecs.queryEntities(['position', 'velocity'])) {
 *   const pos = ecs.getComponent<{x:number;y:number}>(id, 'position')!;
 *   const vel = ecs.getComponent<{vx:number;vy:number}>(id, 'velocity')!;
 *   pos.x += vel.vx * dt;
 *   pos.y += vel.vy * dt;
 * }
 * ```
 */
export class EntityComponentSystem {
  private _nextId = 1;
  private readonly _alive = new Set<number>();
  /** component-type → (entityId → component data) */
  private readonly _stores = new Map<string, Map<number, unknown>>();

  // ── Entity lifecycle ────────────────────────────────────────────────────────

  /** Allocate a new entity and return its ID. */
  createEntity(): number {
    const id = this._nextId++;
    this._alive.add(id);
    return id;
  }

  /**
   * Destroy an entity and remove all of its components.
   *
   * Silently ignored when the entity does not exist.
   */
  destroyEntity(id: number): void {
    if (!this._alive.has(id)) return;
    this._alive.delete(id);
    for (const store of this._stores.values()) {
      store.delete(id);
    }
  }

  /** Return `true` if the entity exists (has not been destroyed). */
  isAlive(id: number): boolean {
    return this._alive.has(id);
  }

  /** Number of live entities. */
  get entityCount(): number { return this._alive.size; }

  // ── Component management ────────────────────────────────────────────────────

  /**
   * Attach a component to an entity.
   *
   * Replaces any existing component of the same type on this entity.
   *
   * @param id    Entity ID returned by {@link createEntity}.
   * @param type  Unique string key identifying the component type.
   * @param data  The component data object.
   */
  addComponent<T>(id: number, type: string, data: T): void {
    let store = this._stores.get(type);
    if (!store) {
      store = new Map<number, unknown>();
      this._stores.set(type, store);
    }
    store.set(id, data);
  }

  /**
   * Retrieve a component from an entity.
   *
   * @returns The component data, or `undefined` if the entity does not have
   *          the given component type.
   */
  getComponent<T>(id: number, type: string): T | undefined {
    return this._stores.get(type)?.get(id) as T | undefined;
  }

  /**
   * Remove a single component from an entity.
   *
   * Silently ignored when the component does not exist.
   */
  removeComponent(id: number, type: string): void {
    this._stores.get(type)?.delete(id);
  }

  /** Return `true` if the entity has the given component type. */
  hasComponent(id: number, type: string): boolean {
    return this._stores.get(type)?.has(id) ?? false;
  }

  // ── Query ───────────────────────────────────────────────────────────────────

  /**
   * Return the set of entity IDs that possess **all** of the given component
   * types.
   *
   * The returned array is freshly allocated each call. For hot-path
   * iteration, consider caching the result and invalidating it only when
   * entities are created/destroyed.
   *
   * @param types  One or more component-type keys to require.
   * @returns      Array of matching entity IDs.
   */
  queryEntities(types: readonly string[]): number[] {
    if (types.length === 0) return Array.from(this._alive);
    // Start from the smallest store to minimise iterations.
    let smallestType = types[0];
    let smallestSize = this._stores.get(types[0])?.size ?? 0;
    for (let i = 1; i < types.length; i++) {
      const s = this._stores.get(types[i])?.size ?? 0;
      if (s < smallestSize) { smallestSize = s; smallestType = types[i]; }
    }
    const primary = this._stores.get(smallestType);
    if (!primary) return [];
    const result: number[] = [];
    for (const id of primary.keys()) {
      if (!this._alive.has(id)) continue;
      let ok = true;
      for (const t of types) {
        if (t === smallestType) continue;
        if (!this._stores.get(t)?.has(id)) { ok = false; break; }
      }
      if (ok) result.push(id);
    }
    return result;
  }

  /** Remove all entities and components (e.g. on scene teardown). */
  clear(): void {
    this._alive.clear();
    this._stores.clear();
    this._nextId = 1;
  }
}

// ── Quadtree ──────────────────────────────────────────────────────────────────

/** A point entry stored inside a {@link Quadtree} node. */
interface QuadtreeEntry<T> {
  x: number;
  y: number;
  data: T;
}

/**
 * Adaptive point quadtree for efficient 2-D spatial queries.
 *
 * Compared to {@link SpatialGrid}, the quadtree is better suited for
 * **non-uniform** object distributions: it subdivides only in regions that
 * are actually populated, so sparse worlds don't waste memory on empty cells.
 *
 * ### Complexity
 * - Insert: O(log n) amortised
 * - Range query: O(log n + k), k = number of results
 * - Well-suited for pathfinding waypoint lookup and physics broad-phase
 *
 * ### Usage
 * ```typescript
 * const qt = new Quadtree<Entity>(0, 0, 1000, 1000);
 * qt.insert(entity, entity.x, entity.y);
 * const nearby = qt.query(x - 50, y - 50, x + 50, y + 50);
 * qt.clear();
 * ```
 */
export class Quadtree<T> {
  private readonly _x: number;
  private readonly _y: number;
  private readonly _w: number;
  private readonly _h: number;
  private readonly _capacity: number;
  private _points: QuadtreeEntry<T>[] = [];
  private _divided = false;
  private _nw: Quadtree<T> | null = null;
  private _ne: Quadtree<T> | null = null;
  private _sw: Quadtree<T> | null = null;
  private _se: Quadtree<T> | null = null;

  /**
   * @param x         Left boundary of this node's region.
   * @param y         Top boundary of this node's region.
   * @param w         Width of this node's region.
   * @param h         Height of this node's region.
   * @param capacity  Maximum points per node before subdivision. Default: 8.
   */
  constructor(x: number, y: number, w: number, h: number, capacity = 8) {
    this._x = x;
    this._y = y;
    this._w = w;
    this._h = h;
    this._capacity = capacity;
  }

  private _subdivide(): void {
    const hw = this._w / 2;
    const hh = this._h / 2;
    const cap = this._capacity;
    this._nw = new Quadtree<T>(this._x,      this._y,      hw, hh, cap);
    this._ne = new Quadtree<T>(this._x + hw, this._y,      hw, hh, cap);
    this._sw = new Quadtree<T>(this._x,      this._y + hh, hw, hh, cap);
    this._se = new Quadtree<T>(this._x + hw, this._y + hh, hw, hh, cap);
    this._divided = true;
    // Re-insert existing points into children.
    for (const p of this._points) {
      this._insertIntoChild(p);
    }
    this._points = [];
  }

  private _insertIntoChild(entry: QuadtreeEntry<T>): void {
    const midX = this._x + this._w / 2;
    const midY = this._y + this._h / 2;
    if (entry.x < midX) {
      (entry.y < midY ? this._nw : this._sw)!.insert(entry.data, entry.x, entry.y);
    } else {
      (entry.y < midY ? this._ne : this._se)!.insert(entry.data, entry.x, entry.y);
    }
  }

  /**
   * Insert a data point at the given world-space coordinates.
   *
   * Points outside the node's bounds are silently ignored; the root node
   * should span the full world extent.
   */
  insert(data: T, x: number, y: number): void {
    // Reject points outside this node's bounds.
    if (x < this._x || x >= this._x + this._w ||
        y < this._y || y >= this._y + this._h) return;

    if (this._divided) {
      this._insertIntoChild({ x, y, data });
      return;
    }

    this._points.push({ x, y, data });
    if (this._points.length > this._capacity) {
      this._subdivide();
    }
  }

  /**
   * Return all data objects whose insertion point falls within the
   * axis-aligned bounding box [minX, maxX) × [minY, maxY).
   *
   * @param results  Optional array to accumulate results into (avoids
   *                 per-call allocation when provided).
   */
  query(
    minX: number, minY: number, maxX: number, maxY: number,
    results: T[] = [],
  ): T[] {
    // Quick reject: AABB vs. this node's bounds.
    if (minX >= this._x + this._w || maxX < this._x ||
        minY >= this._y + this._h || maxY < this._y) {
      return results;
    }

    if (this._divided) {
      this._nw!.query(minX, minY, maxX, maxY, results);
      this._ne!.query(minX, minY, maxX, maxY, results);
      this._sw!.query(minX, minY, maxX, maxY, results);
      this._se!.query(minX, minY, maxX, maxY, results);
      return results;
    }

    for (const p of this._points) {
      if (p.x >= minX && p.x < maxX && p.y >= minY && p.y < maxY) {
        results.push(p.data);
      }
    }
    return results;
  }

  /** Remove all points and collapse all child nodes. */
  clear(): void {
    this._points = [];
    this._divided = false;
    this._nw = this._ne = this._sw = this._se = null;
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
        if (this._pending[i].priority < this._pending[bestIdx].priority) {
          bestIdx = i;
        }
      }
      const req = this._pending.splice(bestIdx, 1)[0];
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

// ── Delta tracker ─────────────────────────────────────────────────────────────

/**
 * Tracks changes to numeric state values and emits only the delta (difference)
 * since the last acknowledged snapshot.
 *
 * Useful for network synchronisation and UI updates where re-sending or
 * re-rendering unchanged values is wasteful. Only properties that have
 * changed by more than `epsilon` are included in the delta output.
 *
 * ### Techniques
 * - **Delta compression**: only changed fields are serialised/transmitted.
 * - **Epsilon threshold**: suppresses trivial floating-point drift (default 0).
 * - **Snapshot / commit**: the caller controls when the baseline advances,
 *   enabling rollback or multi-frame accumulation.
 *
 * ### Usage
 * ```typescript
 * const tracker = new DeltaTracker({ x: 0, y: 0, hp: 100 });
 *
 * // After physics update:
 * tracker.set('x', entity.x);
 * tracker.set('y', entity.y);
 *
 * const delta = tracker.delta();  // { x: newX, y: newY } (only changed)
 * if (delta) sendNetworkUpdate(delta);
 * tracker.commit();               // advance baseline
 * ```
 */
export class DeltaTracker {
  private _baseline: Record<string, number>;
  private _current:  Record<string, number>;
  private readonly _epsilon: number;

  /**
   * @param initial  Initial state. All values must be numbers.
   * @param epsilon  Minimum absolute change required for a field to be
   *                 considered dirty. Default: 0 (any change is dirty).
   */
  constructor(initial: Record<string, number>, epsilon = 0) {
    this._baseline = { ...initial };
    this._current  = { ...initial };
    this._epsilon  = epsilon;
  }

  /**
   * Update the current value for a tracked key.
   *
   * New keys not present in the initial state are accepted and will appear
   * in the next `delta()` call.
   */
  set(key: string, value: number): void {
    this._current[key] = value;
  }

  /** Read the current (possibly uncommitted) value for a key. */
  get(key: string): number | undefined {
    return this._current[key];
  }

  /**
   * Return a partial record containing only keys whose current value differs
   * from the baseline by more than `epsilon`.
   *
   * Returns `null` when nothing has changed (no network/render work needed).
   */
  delta(): Record<string, number> | null {
    let out: Record<string, number> | null = null;
    for (const key of Object.keys(this._current)) {
      const base = this._baseline[key] ?? 0;
      if (Math.abs(this._current[key] - base) > this._epsilon) {
        (out ??= {})[key] = this._current[key];
      }
    }
    return out;
  }

  /**
   * Advance the baseline to the current state.
   *
   * Call this after the delta has been consumed (e.g. after sending a
   * network packet or completing a UI refresh).
   */
  commit(): void {
    Object.assign(this._baseline, this._current);
  }

  /**
   * Discard pending changes and revert current state to the last committed
   * baseline (rollback support).
   */
  rollback(): void {
    Object.assign(this._current, this._baseline);
  }

  /** Return `true` if any tracked field has an uncommitted change. */
  isDirty(): boolean {
    return this.delta() !== null;
  }

  /**
   * Replace the tracked state entirely with a new set of values and commit
   * them as the new baseline (e.g. after a full-state sync from the server).
   */
  reset(state: Record<string, number>): void {
    this._baseline = { ...state };
    this._current  = { ...state };
  }
}
