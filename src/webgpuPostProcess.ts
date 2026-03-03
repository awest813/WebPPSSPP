/**
 * webgpuPostProcess.ts — WebGPU compute/render post-processing pipeline
 *
 * Captures frames from the emulator's WebGL canvas, applies GPU-accelerated
 * post-processing effects (CRT simulation, sharpening), and renders the
 * result to an overlay canvas.
 *
 * Architecture:
 *   1. copyExternalImageToTexture() copies the WebGL canvas to a GPUTexture
 *      without CPU readback — the copy stays entirely on the GPU.
 *   2. A fullscreen-triangle fragment shader samples the source texture and
 *      applies the selected effect (CRT scanlines, barrel distortion,
 *      vignette, or edge-aware sharpening).
 *   3. The processed frame is rendered to a GPUCanvasContext backed by a
 *      <canvas> element that overlays the original emulator canvas.
 *
 * Performance optimisations:
 *   - Bind groups are cached and only recreated when the source texture
 *     handle changes (i.e. on canvas resize), not on every frame.
 *   - A single pre-allocated Float32Array is reused for uniform uploads,
 *     eliminating per-frame heap allocations.
 *   - _pixelsToBlob uses a DataView-based 32-bit word swap to vectorize the
 *     BGRA→RGBA conversion, cutting the per-pixel branch count in half.
 *   - Pipeline WGSL sources are persisted to the shader cache on first build
 *     so they can be pre-compiled on subsequent session startups.
 *
 * Screenshot capture:
 *   captureScreenshotAsync() copies the post-processed frame to a staging
 *   GPUBuffer, maps it asynchronously via mapAsync(), and converts the
 *   pixel data to a JPEG Blob without synchronous GPU stalls.
 */

import { shaderCache } from "./shaderCache.js";

// ── WebGPU enum constants (numeric to avoid runtime dependency on globals) ────
// These values are stable and part of the WebGPU spec.

const SHADER_STAGE_FRAGMENT = 0x2;

const BUFFER_UNIFORM   = 0x0040;
const BUFFER_COPY_DST  = 0x0008;
const BUFFER_COPY_SRC  = 0x0004;
const BUFFER_MAP_READ  = 0x0001;

const TEX_BINDING          = 0x04;
const TEX_COPY_DST         = 0x02;
const TEX_COPY_SRC         = 0x01;
const TEX_RENDER_ATTACH    = 0x10;

const MAP_MODE_READ = 0x0001;

// ── Effect types ──────────────────────────────────────────────────────────────

export type PostProcessEffect = "none" | "crt" | "sharpen" | "lcd" | "bloom" | "fxaa";

export interface PostProcessConfig {
  effect: PostProcessEffect;
  /** CRT scanline darkness (0 = off, 1 = fully black). Default 0.15. */
  scanlineIntensity: number;
  /** CRT barrel distortion amount (0 = flat, 1 = extreme). Default 0.03. */
  curvature: number;
  /** CRT vignette strength (0 = off, 1 = heavy). Default 0.2. */
  vignetteStrength: number;
  /** Sharpen kernel strength (0 = off, 2 = aggressive). Default 0.5. */
  sharpenAmount: number;
  /** LCD shadow-mask intensity (0 = off, 1 = full grid). Default 0.4. */
  lcdShadowMask: number;
  /** LCD pixel-grid scale — higher values produce a finer grid. Default 1.0. */
  lcdPixelScale: number;
  /** Bloom brightness threshold (0–1). Pixels above this level emit glow. Default 0.6. */
  bloomThreshold: number;
  /** Bloom glow intensity multiplier. Default 0.5. */
  bloomIntensity: number;
  /** FXAA edge-detection / blend strength (0 = off, 1 = maximum quality). Default 0.75. */
  fxaaQuality: number;
}

export const DEFAULT_POST_PROCESS_CONFIG: PostProcessConfig = {
  effect: "none",
  scanlineIntensity: 0.15,
  curvature: 0.03,
  vignetteStrength: 0.2,
  sharpenAmount: 0.5,
  lcdShadowMask: 0.4,
  lcdPixelScale: 1.0,
  bloomThreshold: 0.6,
  bloomIntensity: 0.5,
  fxaaQuality: 0.75,
};

// ── WGSL shaders ──────────────────────────────────────────────────────────────

const FULLSCREEN_VERTEX = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4f {
  // Fullscreen triangle covering the entire clip space.
  // Vertices: (-1,-1), (3,-1), (-1,3) — the GPU clips to the viewport.
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  return vec4f(pos[idx], 0.0, 1.0);
}
`;

const PASSTHROUGH_FRAGMENT = /* wgsl */ `
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;

@fragment fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(srcTex));
  let uv = fragCoord.xy / dims;
  return textureSample(srcTex, srcSampler, uv);
}
`;

const CRT_FRAGMENT = /* wgsl */ `
struct Params {
  scanlineIntensity: f32,
  curvature: f32,
  vignetteStrength: f32,
  _pad: f32,
  resolution: vec2f,
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;

fn barrelDistort(uv: vec2f, k: f32) -> vec2f {
  let centered = uv - 0.5;
  let r2 = dot(centered, centered);
  return uv + centered * r2 * k;
}

@fragment fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let uv = fragCoord.xy / params.resolution;

  // Barrel distortion (CRT curvature)
  let distorted = barrelDistort(uv, params.curvature * 8.0);

  // Out-of-bounds check after distortion
  if (distorted.x < 0.0 || distorted.x > 1.0 || distorted.y < 0.0 || distorted.y > 1.0) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }

  var color = textureSample(srcTex, srcSampler, distorted);

  // Scanlines — darken alternating lines based on screen-space Y
  let scanline = 1.0 - params.scanlineIntensity * (0.5 + 0.5 * sin(fragCoord.y * 3.14159265 * 2.0));
  color = vec4f(color.rgb * scanline, color.a);

  // Phosphor RGB sub-pixel emphasis (subtle colour fringing)
  let subpixel = fract(fragCoord.x / 3.0);
  var phosphor = vec3f(1.0);
  if (subpixel < 0.333) {
    phosphor = vec3f(1.08, 0.96, 0.96);
  } else if (subpixel < 0.666) {
    phosphor = vec3f(0.96, 1.08, 0.96);
  } else {
    phosphor = vec3f(0.96, 0.96, 1.08);
  }
  color = vec4f(color.rgb * phosphor, color.a);

  // Vignette — darken edges
  let vig = smoothstep(0.0, 1.0, 1.0 - length((uv - 0.5) * 2.0) * params.vignetteStrength);
  color = vec4f(color.rgb * vig, color.a);

  return color;
}
`;

const SHARPEN_FRAGMENT = /* wgsl */ `
struct Params {
  sharpenAmount: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
  resolution: vec2f,
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;

@fragment fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let texel = 1.0 / params.resolution;
  let uv = fragCoord.xy / params.resolution;

  // 3x3 unsharp mask kernel: center weight = 1 + 4*amount, neighbours = -amount
  let center = textureSample(srcTex, srcSampler, uv);
  let top    = textureSample(srcTex, srcSampler, uv + vec2f(0.0, -texel.y));
  let bottom = textureSample(srcTex, srcSampler, uv + vec2f(0.0,  texel.y));
  let left   = textureSample(srcTex, srcSampler, uv + vec2f(-texel.x, 0.0));
  let right  = textureSample(srcTex, srcSampler, uv + vec2f( texel.x, 0.0));

  let neighbours = top + bottom + left + right;
  let sharpened = center * (1.0 + 4.0 * params.sharpenAmount) - neighbours * params.sharpenAmount;

  return vec4f(clamp(sharpened.rgb, vec3f(0.0), vec3f(1.0)), center.a);
}
`;

const LCD_FRAGMENT = /* wgsl */ `
struct Params {
  lcdShadowMask: f32,
  lcdPixelScale: f32,
  _pad1: f32,
  _pad2: f32,
  resolution: vec2f,
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;

// Row gap threshold: pixel rows above this normalised position get a dark gap
// (0.88 = top ~12 % of each cell row, producing a thin horizontal separator).
const ROW_GAP_THRESHOLD: f32 = 0.88;
// Sub-pixel stripe widths: three equal columns cover [0, 1/3), [1/3, 2/3), [2/3, 1)
const SUBPIXEL_COLUMN_WIDTH: f32 = 0.333;
// Brightness boost applied to the dominant sub-pixel column per channel
const SUBPIXEL_BOOST: f32 = 0.12;
// Brightness cut applied to the non-dominant sub-pixel columns per channel
const SUBPIXEL_ATTENUATION: f32 = 0.08;

@fragment fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let uv = fragCoord.xy / params.resolution;
  var color = textureSample(srcTex, srcSampler, uv);

  // Intra-pixel position in [0, 1) — one "pixel cell" per lcdPixelScale screen pixels
  let cell = fragCoord.xy * params.lcdPixelScale;
  let pixelX = fract(cell.x);
  let pixelY = fract(cell.y);

  // Horizontal grid lines — thin dark gap at the top of each cell row
  let rowGap = 1.0 - params.lcdShadowMask * step(ROW_GAP_THRESHOLD, pixelY);
  color = vec4f(color.rgb * rowGap, color.a);

  // RGB sub-pixel stripe mask: three vertical columns per cell (R / G / B)
  var subpixelMask = vec3f(1.0);
  if (pixelX < SUBPIXEL_COLUMN_WIDTH) {
    subpixelMask = vec3f(
      1.0 + params.lcdShadowMask * SUBPIXEL_BOOST,
      1.0 - params.lcdShadowMask * SUBPIXEL_ATTENUATION,
      1.0 - params.lcdShadowMask * SUBPIXEL_ATTENUATION,
    );
  } else if (pixelX < 2.0 * SUBPIXEL_COLUMN_WIDTH) {
    subpixelMask = vec3f(
      1.0 - params.lcdShadowMask * SUBPIXEL_ATTENUATION,
      1.0 + params.lcdShadowMask * SUBPIXEL_BOOST,
      1.0 - params.lcdShadowMask * SUBPIXEL_ATTENUATION,
    );
  } else {
    subpixelMask = vec3f(
      1.0 - params.lcdShadowMask * SUBPIXEL_ATTENUATION,
      1.0 - params.lcdShadowMask * SUBPIXEL_ATTENUATION,
      1.0 + params.lcdShadowMask * SUBPIXEL_BOOST,
    );
  }

  return vec4f(clamp(color.rgb * subpixelMask, vec3f(0.0), vec3f(1.0)), color.a);
}
`;

const BLOOM_FRAGMENT = /* wgsl */ `
struct Params {
  bloomThreshold: f32,
  bloomIntensity: f32,
  _pad1: f32,
  _pad2: f32,
  resolution: vec2f,
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;

// Outer tap radius in texels — large enough for a visible glow without a
// separate blur pass.  The inner diagonal taps use radius 1.0.
const BLUR_RADIUS: f32 = 2.0;
// Number of taps in the cross + diagonal pattern below (must match array size)
const BLOOM_TAP_COUNT: i32 = 8;

// Approximate a Gaussian blur with an 8-tap cross + diagonal pattern.
// Each tap is offset by BLUR_RADIUS or 1.0 texels so the glow
// reaches far enough to be visible without a dedicated blur pass.
fn blurredBright(uv: vec2f, texel: vec2f) -> vec3f {
  var acc = vec3f(0.0);
  let offsets = array<vec2f, 8>(
    vec2f(-BLUR_RADIUS,  0.0         ), vec2f( BLUR_RADIUS,  0.0         ),
    vec2f( 0.0,         -BLUR_RADIUS ), vec2f( 0.0,          BLUR_RADIUS ),
    vec2f(-1.0,         -1.0         ), vec2f( 1.0,         -1.0         ),
    vec2f(-1.0,          1.0         ), vec2f( 1.0,          1.0         ),
  );
  for (var i: i32 = 0; i < BLOOM_TAP_COUNT; i++) {
    let s = textureSample(srcTex, srcSampler, uv + offsets[i] * texel).rgb;
    acc += max(s - vec3f(params.bloomThreshold), vec3f(0.0));
  }
  return acc / f32(BLOOM_TAP_COUNT);
}

@fragment fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let texel = 1.0 / params.resolution;
  let uv = fragCoord.xy / params.resolution;

  let base  = textureSample(srcTex, srcSampler, uv);
  let glow  = blurredBright(uv, texel) * params.bloomIntensity;

  // Additive blend — glow brightens the scene without washing out darks
  return vec4f(clamp(base.rgb + glow, vec3f(0.0), vec3f(1.0)), base.a);
}
`;

const FXAA_FRAGMENT = /* wgsl */ `
struct Params {
  fxaaQuality: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
  resolution: vec2f,
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;

// Perceived luminance using Rec. 601 coefficients — matches human eye sensitivity.
fn luma(rgb: vec3f) -> f32 {
  return dot(rgb, vec3f(0.299, 0.587, 0.114));
}

// Fast Approximate Anti-Aliasing (FXAA).
//
// Algorithm overview:
//   1. Compute luminance at the current pixel and its 4 cardinal neighbours.
//   2. Skip the pixel entirely when the local contrast is below the threshold
//      (flat areas / solid colours have no aliasing to fix).
//   3. Determine the dominant edge direction (horizontal vs. vertical) and
//      estimate the sub-pixel alias contribution.
//   4. Blend the current pixel toward the brighter neighbour across the edge,
//      scaled by the sub-pixel alias estimate and fxaaQuality.
//
// This is a single-pass, single-sample-per-tap implementation well-suited
// to low-spec GPUs where a full multi-pass MSAA or TAA pipeline would be
// too expensive.  It provides a noticeable reduction in 3D geometry aliasing
// at a cost of roughly 4–6 extra texture samples per fragment.
@fragment fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let texel = 1.0 / params.resolution;
  let uv    = fragCoord.xy / params.resolution;

  let center = textureSample(srcTex, srcSampler, uv).rgb;
  let lumaC  = luma(center);

  // Sample 4 cardinal neighbours
  let lumaN = luma(textureSample(srcTex, srcSampler, uv + vec2f( 0.0,       -texel.y)).rgb);
  let lumaS = luma(textureSample(srcTex, srcSampler, uv + vec2f( 0.0,        texel.y)).rgb);
  let lumaE = luma(textureSample(srcTex, srcSampler, uv + vec2f( texel.x,    0.0    )).rgb);
  let lumaW = luma(textureSample(srcTex, srcSampler, uv + vec2f(-texel.x,    0.0    )).rgb);

  let lumaMin   = min(lumaC, min(min(lumaN, lumaS), min(lumaE, lumaW)));
  let lumaMax   = max(lumaC, max(max(lumaN, lumaS), max(lumaE, lumaW)));
  let lumaRange = lumaMax - lumaMin;

  // Absolute minimum threshold: skip pixels in very dark areas (no visible aliasing).
  // Relative threshold (0.125 = "low quality" preset from Lottes 2009): skip pixels
  // whose contrast is already below 12.5 % of the local maximum.  The relative
  // threshold is divided by fxaaQuality so the user can tighten edge detection
  // by increasing quality; the absolute threshold remains fixed.
  let absThreshold = 0.0312;
  let relThreshold = 0.125 / max(params.fxaaQuality, 0.001);
  if (lumaRange < max(absThreshold, relThreshold * lumaMax)) {
    return vec4f(center, 1.0);
  }

  // Sub-pixel aliasing estimation: how much does the center pixel deviate from
  // the neighbourhood average?  A large deviation signals a single-pixel alias.
  let lumaAvg      = (lumaN + lumaS + lumaE + lumaW) * 0.25;
  let subpixelDiff = abs(lumaAvg - lumaC) / lumaRange;
  let blendStrength = subpixelDiff * subpixelDiff * params.fxaaQuality * 0.75;

  // Edge direction: compare horizontal vs. vertical gradient magnitude.
  let edgeHoriz = abs(lumaN + lumaS - 2.0 * lumaC);
  let edgeVert  = abs(lumaE + lumaW - 2.0 * lumaC);
  let isHoriz   = edgeHoriz >= edgeVert;

  // Step one texel perpendicular to the edge (into the gradient direction).
  let step = select(vec2f(texel.x, 0.0), vec2f(0.0, texel.y), isHoriz);

  // Blend toward the pixel on the brighter side of the edge.
  let lumaPos = select(lumaE, lumaN, isHoriz);
  let lumaNeg = select(lumaW, lumaS, isHoriz);
  let blendDir = select(-step, step, abs(lumaPos - lumaC) >= abs(lumaNeg - lumaC));

  let blended = textureSample(srcTex, srcSampler, uv + blendDir * 0.5).rgb;
  return vec4f(mix(center, blended, blendStrength), 1.0);
}
`;

// ── Pipeline builder ──────────────────────────────────────────────────────────

interface EffectPipeline {
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
  uniformBuffer: GPUBuffer | null;
  /** WGSL source strings built into this pipeline (vertex, fragment). */
  wgslSources: { vertex: string; fragment: string };
}

export function buildEffectPipeline(
  device: GPUDevice,
  effect: PostProcessEffect,
  format: GPUTextureFormat,
): EffectPipeline {
  let fragmentCode: string;

  switch (effect) {
    case "crt":     fragmentCode = CRT_FRAGMENT; break;
    case "sharpen": fragmentCode = SHARPEN_FRAGMENT; break;
    case "lcd":     fragmentCode = LCD_FRAGMENT; break;
    case "bloom":   fragmentCode = BLOOM_FRAGMENT; break;
    case "fxaa":    fragmentCode = FXAA_FRAGMENT; break;
    default:        fragmentCode = PASSTHROUGH_FRAGMENT; break;
  }

  const vertModule = device.createShaderModule({ code: FULLSCREEN_VERTEX });
  const fragModule = device.createShaderModule({ code: fragmentCode });

  const hasUniforms = effect === "crt" || effect === "sharpen" || effect === "lcd" || effect === "bloom" || effect === "fxaa";

  const entries: GPUBindGroupLayoutEntry[] = [
    { binding: 0, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
    { binding: 1, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: "filtering" } },
  ];

  if (hasUniforms) {
    entries.push({
      binding: 2,
      visibility: SHADER_STAGE_FRAGMENT,
      buffer: { type: "uniform" },
    });
  }

  const bindGroupLayout = device.createBindGroupLayout({ entries });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

  const pipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex:   { module: vertModule, entryPoint: "vs" },
    fragment: { module: fragModule, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  // 32 bytes: 4 floats (16 bytes) + vec2f resolution (8 bytes) + padding to 32
  const uniformBuffer = hasUniforms
    ? device.createBuffer({ size: 32, usage: BUFFER_UNIFORM | BUFFER_COPY_DST })
    : null;

  return { pipeline, bindGroupLayout, uniformBuffer, wgslSources: { vertex: FULLSCREEN_VERTEX, fragment: fragmentCode } };
}

// ── WebGPUPostProcessor ───────────────────────────────────────────────────────

export class WebGPUPostProcessor {
  private _device: GPUDevice;
  private _config: PostProcessConfig;
  private _canvas: HTMLCanvasElement | null = null;
  private _gpuContext: GPUCanvasContext | null = null;
  private _sourceCanvas: HTMLCanvasElement | null = null;
  private _sourceTexture: GPUTexture | null = null;
  private _sampler: GPUSampler | null = null;
  private _effectPipeline: EffectPipeline | null = null;
  private _currentEffect: PostProcessEffect = "none";
  private _presentFormat: GPUTextureFormat = "bgra8unorm";
  private _rafId: number | null = null;
  private _active = false;
  private _lastSourceWidth = 0;
  private _lastSourceHeight = 0;

  /**
   * Cached bind group for the current source texture + pipeline combination.
   * Invalidated whenever the source texture handle changes (canvas resize).
   * Re-creating the bind group every frame was the single largest per-frame
   * allocation; caching it brings that to zero in the steady state.
   */
  private _cachedBindGroup: GPUBindGroup | null = null;
  private _cachedBindGroupTexture: GPUTexture | null = null;

  /**
   * Pre-allocated Float32Array for uniform uploads.
   * Reusing this buffer avoids a 32-byte heap allocation every rAF tick.
   */
  private readonly _uniformData = new Float32Array(8);

  // ── GPU timestamp query state ─────────────────────────────────────────────
  /**
   * Timestamp query set (2 timestamps: begin + end of the render pass).
   * Null when the device does not support the "timestamp-query" feature.
   */
  private _querySet: GPUQuerySet | null = null;
  /**
   * GPU buffer used to resolve timestamp queries into raw 64-bit nanosecond
   * values. Size = 2 timestamps × 8 bytes.
   */
  private _queryResolveBuffer: GPUBuffer | null = null;
  /**
   * Staging buffer used to read the resolved timestamps back to the CPU
   * asynchronously. Mapped every GPU_TIMER_SAMPLE_INTERVAL frames.
   */
  private _queryReadbackBuffer: GPUBuffer | null = null;
  /** Counts rendered frames since the last timestamp readback. */
  private _framesSinceTimerSample = 0;
  /** How many frames to render between GPU timer readback operations. */
  private static readonly _GPU_TIMER_SAMPLE_INTERVAL = 60;
  /**
   * Latest measured GPU frame render time in milliseconds.
   * Updated asynchronously; may lag by ~1 frame interval.
   */
  private _lastGPUFrameTimeMs: number | null = null;
  /** Whether a timer readback is already in flight. */
  private _timerReadbackPending = false;

  constructor(device: GPUDevice, config?: Partial<PostProcessConfig>) {
    this._device = device;
    this._config = { ...DEFAULT_POST_PROCESS_CONFIG, ...config };
    this._initTimestampQuery();
  }

  get active(): boolean { return this._active; }
  get config(): PostProcessConfig { return { ...this._config }; }
  /**
   * Most recently measured GPU render time for the post-processing pass in ms.
   * Updated asynchronously once per ~60 frames. Returns null until the first
   * measurement completes or when timestamp queries are unsupported.
   */
  get lastGPUFrameTimeMs(): number | null { return this._lastGPUFrameTimeMs; }

  /**
   * Attach the post-processor to a source canvas (the emulator's WebGL canvas).
   * Creates an overlay canvas inside the given container element and begins
   * the render loop.
   */
  attach(sourceCanvas: HTMLCanvasElement, container: HTMLElement): void {
    if (this._active) this.detach();

    this._sourceCanvas = sourceCanvas;

    // Create overlay canvas sized to match the source
    this._canvas = document.createElement("canvas");
    this._canvas.className = "webgpu-postprocess-overlay";
    this._canvas.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;" +
      "pointer-events:none;z-index:1;";
    this._canvas.width = sourceCanvas.width || 640;
    this._canvas.height = sourceCanvas.height || 480;

    container.style.position = "relative";
    container.appendChild(this._canvas);

    // Configure the WebGPU canvas context
    this._gpuContext = this._canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!this._gpuContext) {
      console.warn("[RetroVault] WebGPU canvas context unavailable — post-processing disabled.");
      this._canvas.remove();
      this._canvas = null;
      return;
    }

    this._presentFormat = navigator.gpu.getPreferredCanvasFormat();
    this._gpuContext.configure({
      device: this._device,
      format: this._presentFormat,
      alphaMode: "premultiplied",
    });

    this._sampler = this._device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });

    // Recreate optional timestamp query resources on re-attach. detach()
    // releases them, and the same processor instance can be attached again.
    if (!this._querySet) {
      this._initTimestampQuery();
    }

    this._rebuildPipeline();
    this._active = true;

    if (this._config.effect !== "none") {
      this._startLoop();
    }
  }

  /** Stop the render loop and remove the overlay canvas. */
  detach(): void {
    this._stopLoop();
    this._active = false;
    this._canvas?.remove();
    this._canvas = null;
    this._gpuContext = null;
    this._sourceCanvas = null;
    this._destroySourceTexture();
    this._effectPipeline?.uniformBuffer?.destroy();
    this._effectPipeline = null;
    this._sampler = null;
    this._invalidateBindGroupCache();
    this._destroyTimestampQuery();
  }

  /** Update post-processing configuration. Rebuilds the pipeline if the effect changes. */
  updateConfig(patch: Partial<PostProcessConfig>): void {
    const prevEffect = this._config.effect;
    Object.assign(this._config, patch);

    if (this._config.effect !== prevEffect) {
      this._rebuildPipeline();
      // Changing the pipeline invalidates the cached bind group because the
      // bind group layout changes with the effect.
      this._invalidateBindGroupCache();
    }

    if (this._active) {
      if (this._config.effect === "none") {
        this._stopLoop();
        this._hideOverlay();
      } else {
        this._showOverlay();
        this._startLoop();
      }
    }
  }

  /**
   * Capture a screenshot of the post-processed frame using async GPU readback.
   * Returns null if the pipeline is not active or readback fails.
   */
  async captureScreenshotAsync(): Promise<Blob | null> {
    if (!this._active || !this._canvas || !this._gpuContext || !this._sourceTexture) {
      return null;
    }

    const width = this._canvas.width;
    const height = this._canvas.height;
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const bufferSize = bytesPerRow * height;

    const stagingBuffer = this._device.createBuffer({
      size: bufferSize,
      usage: BUFFER_COPY_DST | BUFFER_MAP_READ,
    });

    // Render one frame to a standalone texture for capture
    const captureTexture = this._device.createTexture({
      size: { width, height },
      format: this._presentFormat,
      usage: TEX_RENDER_ATTACH | TEX_COPY_SRC,
    });

    this._renderFrame(captureTexture.createView());

    const encoder = this._device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: captureTexture },
      { buffer: stagingBuffer, bytesPerRow, rowsPerImage: height },
      { width, height },
    );
    this._device.queue.submit([encoder.finish()]);

    try {
      await stagingBuffer.mapAsync(MAP_MODE_READ);
      const data = new Uint8Array(stagingBuffer.getMappedRange()).slice();
      stagingBuffer.unmap();
      stagingBuffer.destroy();
      captureTexture.destroy();

      return this._pixelsToBlob(data, width, height, bytesPerRow);
    } catch {
      stagingBuffer.destroy();
      captureTexture.destroy();
      return null;
    }
  }

  /** Release all GPU resources. */
  dispose(): void {
    this.detach();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _rebuildPipeline(): void {
    this._effectPipeline?.uniformBuffer?.destroy();
    this._currentEffect = this._config.effect;

    try {
      this._effectPipeline = buildEffectPipeline(
        this._device,
        this._currentEffect,
        this._presentFormat,
      );

      // Persist the WGSL sources so subsequent session startups can pre-warm
      // the GPU shader compiler via shaderCache.preCompileWGSL().
      if (this._currentEffect !== "none") {
        const { vertex, fragment } = this._effectPipeline.wgslSources;
        shaderCache.recordWGSL(vertex, `${this._currentEffect}-vertex`).catch(() => {});
        shaderCache.recordWGSL(fragment, `${this._currentEffect}-fragment`).catch(() => {});
      }
    } catch (err) {
      console.warn("[RetroVault] Failed to build WebGPU post-process pipeline:", err);
      this._effectPipeline = null;
    }
  }

  private _ensureSourceTexture(width: number, height: number): void {
    if (this._lastSourceWidth === width && this._lastSourceHeight === height && this._sourceTexture) {
      return;
    }

    this._destroySourceTexture();

    this._sourceTexture = this._device.createTexture({
      size: { width, height },
      format: "rgba8unorm",
      usage:
        TEX_BINDING |
        TEX_COPY_DST |
        TEX_RENDER_ATTACH,
    });

    this._lastSourceWidth = width;
    this._lastSourceHeight = height;

    // The texture handle changed — the cached bind group must be recreated.
    this._invalidateBindGroupCache();
  }

  private _destroySourceTexture(): void {
    this._sourceTexture?.destroy();
    this._sourceTexture = null;
    this._lastSourceWidth = 0;
    this._lastSourceHeight = 0;
    this._invalidateBindGroupCache();
  }

  /**
   * Drop the cached bind group.
   * Called whenever the source texture or pipeline changes so the next
   * _renderFrame call recreates it against the current handles.
   */
  private _invalidateBindGroupCache(): void {
    this._cachedBindGroup = null;
    this._cachedBindGroupTexture = null;
  }

  /**
   * Return the cached bind group, creating it if necessary.
   *
   * The bind group wraps the source texture view, sampler, and uniform buffer.
   * Since none of these change between frames (only the uniform *values* change,
   * which are uploaded via writeBuffer to the same GPUBuffer), the bind group
   * object itself can be reused indefinitely — until the source texture handle
   * is replaced due to a canvas resize or pipeline switch.
   */
  private _ensureBindGroup(): GPUBindGroup | null {
    if (!this._effectPipeline || !this._sourceTexture || !this._sampler) return null;

    // Cache hit: same texture and same pipeline
    if (this._cachedBindGroup && this._cachedBindGroupTexture === this._sourceTexture) {
      return this._cachedBindGroup;
    }

    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: this._sourceTexture.createView() },
      { binding: 1, resource: this._sampler },
    ];
    if (this._effectPipeline.uniformBuffer) {
      entries.push({ binding: 2, resource: { buffer: this._effectPipeline.uniformBuffer } });
    }

    this._cachedBindGroup = this._device.createBindGroup({
      layout: this._effectPipeline.bindGroupLayout,
      entries,
    });
    this._cachedBindGroupTexture = this._sourceTexture;
    return this._cachedBindGroup;
  }

  private _renderFrame(targetView?: GPUTextureView): void {
    if (!this._sourceCanvas || !this._gpuContext || !this._effectPipeline || !this._sampler) {
      return;
    }

    const srcW = this._sourceCanvas.width;
    const srcH = this._sourceCanvas.height;
    if (srcW === 0 || srcH === 0) return;

    // Sync overlay canvas size
    if (this._canvas && (this._canvas.width !== srcW || this._canvas.height !== srcH)) {
      this._canvas.width = srcW;
      this._canvas.height = srcH;
    }

    this._ensureSourceTexture(srcW, srcH);
    if (!this._sourceTexture) return;

    // Copy the emulator canvas to our GPU texture (GPU-side, no CPU readback)
    try {
      this._device.queue.copyExternalImageToTexture(
        { source: this._sourceCanvas, flipY: false },
        { texture: this._sourceTexture },
        { width: srcW, height: srcH },
      );
    } catch {
      return;
    }

    // Upload uniforms — reuses the pre-allocated Float32Array
    this._writeUniforms(srcW, srcH);

    // Retrieve the cached (or freshly created) bind group
    const bindGroup = this._ensureBindGroup();
    if (!bindGroup) return;

    const view = targetView ?? this._gpuContext.getCurrentTexture().createView();

    const encoder = this._device.createCommandEncoder();

    // Attach timestamp writes when the query set is available and this is a
    // regular (non-capture) frame (targetView is undefined during normal rAF).
    const useTimer = this._querySet !== null && targetView === undefined;
    const renderPassDesc: GPURenderPassDescriptor = {
      colorAttachments: [{
        view,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    };
    if (useTimer && this._querySet) {
      (renderPassDesc as GPURenderPassDescriptor & {
        timestampWrites?: { querySet: GPUQuerySet; beginningOfPassWriteIndex: number; endOfPassWriteIndex: number };
      }).timestampWrites = {
        querySet: this._querySet,
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1,
      };
    }

    const pass = encoder.beginRenderPass(renderPassDesc);

    pass.setPipeline(this._effectPipeline.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();

    // Resolve timestamps into the resolve buffer once per sample interval
    if (useTimer && this._querySet && this._queryResolveBuffer) {
      encoder.resolveQuerySet(this._querySet, 0, 2, this._queryResolveBuffer, 0);

      this._framesSinceTimerSample++;
      if (
        this._framesSinceTimerSample >= WebGPUPostProcessor._GPU_TIMER_SAMPLE_INTERVAL &&
        !this._timerReadbackPending &&
        this._queryReadbackBuffer
      ) {
        this._framesSinceTimerSample = 0;
        encoder.copyBufferToBuffer(this._queryResolveBuffer, 0, this._queryReadbackBuffer, 0, 16);
        this._device.queue.submit([encoder.finish()]);
        this._readbackGPUTimestamp();
        return;
      }
    }

    this._device.queue.submit([encoder.finish()]);
  }

  private _writeUniforms(width: number, height: number): void {
    if (!this._effectPipeline?.uniformBuffer) return;

    // Reuse the pre-allocated buffer — no heap allocation
    const data = this._uniformData;

    switch (this._currentEffect) {
      case "crt":
        data[0] = this._config.scanlineIntensity;
        data[1] = this._config.curvature;
        data[2] = this._config.vignetteStrength;
        data[3] = 0; // padding
        data[4] = width;
        data[5] = height;
        break;
      case "sharpen":
        data[0] = this._config.sharpenAmount;
        data[1] = 0;
        data[2] = 0;
        data[3] = 0;
        data[4] = width;
        data[5] = height;
        break;
      case "lcd":
        data[0] = this._config.lcdShadowMask;
        data[1] = this._config.lcdPixelScale;
        data[2] = 0;
        data[3] = 0;
        data[4] = width;
        data[5] = height;
        break;
      case "bloom":
        data[0] = this._config.bloomThreshold;
        data[1] = this._config.bloomIntensity;
        data[2] = 0;
        data[3] = 0;
        data[4] = width;
        data[5] = height;
        break;
      case "fxaa":
        data[0] = this._config.fxaaQuality;
        data[1] = 0;
        data[2] = 0;
        data[3] = 0;
        data[4] = width;
        data[5] = height;
        break;
    }

    this._device.queue.writeBuffer(this._effectPipeline.uniformBuffer, 0, data);
  }

  private _startLoop(): void {
    if (this._rafId !== null) return;
    const loop = () => {
      if (!this._active || this._config.effect === "none") return;
      this._renderFrame();
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  private _stopLoop(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  private _showOverlay(): void {
    if (this._canvas) this._canvas.style.display = "";
  }

  private _hideOverlay(): void {
    if (this._canvas) this._canvas.style.display = "none";
  }

  // ── GPU timestamp query helpers ──────────────────────────────────────────

  /**
   * Attempt to create timestamp query resources.
   * Silently no-ops when the "timestamp-query" feature is not available —
   * this keeps the rest of the pipeline unaffected on unsupported devices.
   */
  private _initTimestampQuery(): void {
    try {
      const features = this._device.features as Set<string>;
      if (!features.has("timestamp-query")) return;

      // 2 query slots: index 0 = render pass begin, index 1 = render pass end
      this._querySet = this._device.createQuerySet({ type: "timestamp", count: 2 });

      // Buffer to hold the resolved 64-bit nanosecond timestamps (2 × 8 bytes)
      this._queryResolveBuffer = this._device.createBuffer({
        size: 16,
        usage: BUFFER_COPY_SRC | (0x0200 /* QUERY_RESOLVE */),
      });

      // Staging buffer for async CPU readback
      this._queryReadbackBuffer = this._device.createBuffer({
        size: 16,
        usage: BUFFER_COPY_DST | BUFFER_MAP_READ,
      });
    } catch {
      // Timestamp queries are optional — clean up any partial state
      this._destroyTimestampQuery();
    }
  }

  private _destroyTimestampQuery(): void {
    this._querySet?.destroy();
    this._querySet = null;
    this._queryResolveBuffer?.destroy();
    this._queryResolveBuffer = null;
    this._queryReadbackBuffer?.destroy();
    this._queryReadbackBuffer = null;
    this._timerReadbackPending = false;
    this._lastGPUFrameTimeMs = null;
  }

  /**
   * Asynchronously read back the latest timestamp pair and compute the GPU
   * frame time. Uses mapAsync() in a non-blocking fashion; results are
   * stored in _lastGPUFrameTimeMs and accessible via the public getter.
   */
  private _readbackGPUTimestamp(): void {
    if (!this._queryReadbackBuffer || this._timerReadbackPending) return;
    this._timerReadbackPending = true;

    this._queryReadbackBuffer.mapAsync(MAP_MODE_READ).then(() => {
      try {
        if (!this._queryReadbackBuffer) return;
        const mapped = this._queryReadbackBuffer.getMappedRange();
        // Two BigInt64 timestamps: [beginNs, endNs]
        const view = new BigInt64Array(mapped);
        const beginNs = view[0];
        const endNs   = view[1];
        if (endNs > beginNs) {
          // Convert nanoseconds to milliseconds
          this._lastGPUFrameTimeMs = Number(endNs - beginNs) / 1_000_000;
        }
      } finally {
        this._queryReadbackBuffer?.unmap();
        this._timerReadbackPending = false;
      }
    }).catch(() => {
      this._timerReadbackPending = false;
    });
  }

  /**
   * Convert raw BGRA/RGBA pixel data to a JPEG Blob via an offscreen canvas.
   *
   * For BGRA formats (most WebGPU implementations) the R and B channels must
   * be swapped before writing into ImageData. Rather than a per-pixel
   * conditional branch this implementation reads each pixel as a 32-bit
   * integer and rotates the bytes — a single operation per pixel that the
   * JIT compiler can often vectorize.
   *
   * BGRA word layout (little-endian): 0xAARRGGBB stored as [ B, G, R, A ]
   * After swap we need RGBA in memory:                     [ R, G, B, A ]
   *
   * The rotation: new_word = (word & 0xFF00FF00) | ((word >> 16) & 0xFF) | ((word & 0xFF) << 16)
   * effectively swaps bytes 0↔2 while leaving bytes 1 and 3 in place.
   */
  private _pixelsToBlob(
    data: Uint8Array,
    width: number,
    height: number,
    bytesPerRow: number,
  ): Promise<Blob | null> {
    return new Promise((resolve) => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) { resolve(null); return; }

        const imageData = ctx.createImageData(width, height);
        const isBGRA = this._presentFormat === "bgra8unorm";

        if (isBGRA) {
          // Fast path: use a 32-bit view to swap R↔B channels with bit manipulation.
          // Each pixel is read as one uint32 word; we swap the byte at position 0
          // (blue, in BGRA little-endian) with the byte at position 2 (red).
          const src32 = new Uint32Array(data.buffer, data.byteOffset);
          const dst32 = new Uint32Array(imageData.data.buffer);

          for (let y = 0; y < height; y++) {
            const srcRowBase = (y * bytesPerRow) >> 2;
            const dstRowBase = y * width;
            for (let x = 0; x < width; x++) {
              const word = src32[srcRowBase + x];
              // Swap bytes 0 (B) and 2 (R): keep G (byte 1) and A (byte 3) in place.
              dst32[dstRowBase + x] =
                (word & 0xFF00FF00) |
                ((word & 0x00FF0000) >>> 16) |
                ((word & 0x000000FF) << 16);
            }
          }
        } else {
          // RGBA path: copy row by row to handle bytesPerRow padding
          const dst = imageData.data;
          for (let y = 0; y < height; y++) {
            const srcOffset = y * bytesPerRow;
            const dstOffset = y * width * 4;
            dst.set(data.subarray(srcOffset, srcOffset + width * 4), dstOffset);
          }
        }

        ctx.putImageData(imageData, 0, 0);
        canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.85);
      } catch {
        resolve(null);
      }
    });
  }
}
