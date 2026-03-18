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
import type { PerformanceTier } from "./performance.js";

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

export type PostProcessEffect = "none" | "crt" | "sharpen" | "lcd" | "bloom" | "fxaa" | "fsr" | "grain" | "retro" | "colorgrade" | "taa" | "pixelate" | "ntsc" | "hdr";

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
  /**
   * FSR 1.0 RCAS sharpness — contrast-adaptive sharpening after upsampling.
   * Range 0 (no sharpening) to 1 (maximum sharpness). Default 0.25.
   */
  fsrSharpness: number;
  /** Film grain intensity (0 = off, 1 = heavy grain). Default 0.08. */
  grainIntensity: number;
  /**
   * Film grain texel size — larger values produce coarser, blockier grain.
   * Range 0.5–8. Default 1.5.
   */
  grainSize: number;
  /**
   * Retro color quantization steps per channel (2–256).
   * Lower values produce a more restricted palette (e.g. 4 = ~64 colors total).
   * Fractional values are rounded to the nearest integer by validatePostProcessConfig().
   * Default 16.
   */
  retroColors: number;
  /** Color-grade contrast multiplier, pivoted at 0.5 (0 = flat grey, 1 = neutral, 2 = high). Default 1.0. */
  contrast: number;
  /** Color-grade saturation (0 = greyscale, 1 = neutral, 2 = vivid). Default 1.0. */
  saturation: number;
  /** Color-grade brightness offset added to each channel (−1–1). Default 0.0. */
  brightness: number;
  /**
   * TAA blend weight for the current frame (0 = pure history, 1 = pure current).
   * Values near 0.1 give subtle temporal smoothing; 0 freezes the image.
   * Default 0.1.
   */
  taaBlend: number;
  /**
   * Pixelate block size in screen pixels (1–32).
   * Larger values produce coarser, more blocky pixelation. Default 4.
   */
  pixelateSize: number;
  /**
   * NTSC composite artifact intensity (0 = clean, 1 = heavy chroma bleed + dot crawl).
   * Controls horizontal chroma smear and dot-crawl animation strength. Default 0.5.
   */
  ntscArtifacts: number;
  /**
   * NTSC luma sharpness retention (0 = blurry, 1 = sharp Y channel). Default 0.5.
   */
  ntscSharpness: number;
  /**
   * HDR exposure multiplier applied before tone mapping (0.1–8). Default 1.0.
   */
  hdrExposure: number;
  /**
   * Reinhard extended white-point — luminance at which the curve saturates (0.1–8).
   * Higher values preserve more highlight detail. Default 1.0.
   */
  hdrWhitePoint: number;
  /**
   * When true, use a nearest-neighbor (point) sampler instead of bilinear.
   * Ideal for pixel-art games where bilinear blurring destroys sharp pixel edges.
   * Default false.
   */
  pixelPerfect: boolean;
  /** Performance tier — used to auto-reduce effect quality on low-end devices. */
  tier?: PerformanceTier;
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
  fsrSharpness: 0.25,
  grainIntensity: 0.08,
  grainSize: 1.5,
  retroColors: 16,
  contrast: 1.0,
  saturation: 1.0,
  brightness: 0.0,
  taaBlend: 0.1,
  pixelateSize: 4,
  ntscArtifacts: 0.5,
  ntscSharpness: 0.5,
  hdrExposure: 1.0,
  hdrWhitePoint: 1.0,
  pixelPerfect: false,
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

// ── New effect shaders ─────────────────────────────────────────────────────────

// Film grain — hash-based per-cell noise that changes with a per-frame seed.
//
// The noise is computed from a 2-D integer cell coordinate so that cells
// larger than one screen pixel share the same random value, producing
// coarser, film-grain-like clusters.  The grainSeed uniform is incremented
// each frame by the processor so the pattern animates in real time.
//
// Uniform layout (32 bytes):
//   offset  0: grainIntensity (f32)
//   offset  4: grainSize      (f32)
//   offset  8: grainSeed      (f32) — changes every frame for animation
//   offset 12: _pad           (f32)
//   offset 16: resolution     (vec2f)
//   offset 24: _pad4, _pad5   (padding to 32 bytes)
const GRAIN_FRAGMENT = /* wgsl */ `
struct Params {
  grainIntensity: f32,
  grainSize: f32,
  grainSeed: f32,
  _pad: f32,
  resolution: vec2f,
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;

// Pseudo-random hash in [0, 1) from a 2-D point.
// Uses two dot products and a large prime multiplier for good distribution.
fn hash2(p: vec2f) -> f32 {
  let q = vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)));
  return fract(sin(dot(q, vec2f(1.0, 1.0))) * 43758.5453123);
}

@fragment fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let uv = fragCoord.xy / params.resolution;
  let base = textureSample(srcTex, srcSampler, uv);

  // Grain cell — cells larger than one pixel share the same noise value,
  // producing coarser, blockier grain that resembles film grain clusters.
  let cellSize = max(params.grainSize, 0.5);
  let cell = floor(fragCoord.xy / cellSize) + params.grainSeed;
  // Map [0,1) hash to [-1,1] additive noise
  let noise = hash2(cell) * 2.0 - 1.0;

  return vec4f(clamp(base.rgb + noise * params.grainIntensity, vec3f(0.0), vec3f(1.0)), base.a);
}
`;

// Retro pixel-art — quantises each RGB channel to a limited number of evenly
// spaced levels using Bayer 4×4 ordered dithering to smooth gradient transitions
// without any additional passes.
//
// With retroColors = 4 each channel has 4 possible output values (0, ⅓, ⅔, 1),
// giving 64 possible colours in total — comparable to a classic 6-bit palette.
// At retroColors = 16 the output is close to the original but with visible
// colour banding at sharp gradients.
//
// Uniform layout (32 bytes):
//   offset  0: retroColors  (f32 — cast from integer, minimum 2)
//   offset  4–12: _pad × 3
//   offset 16: resolution   (vec2f)
const RETRO_FRAGMENT = /* wgsl */ `
struct Params {
  retroColors: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
  resolution: vec2f,
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;

// Bayer 4×4 ordered dithering matrix.  Each entry is the threshold for that
// screen position.  The values are normalised so the returned threshold is in
// the range [-0.5, 0.5], ready to be scaled by the inter-level gap.
fn bayer4(p: vec2u) -> f32 {
  let bayer = array<u32, 16>(
     0u,  8u,  2u, 10u,
    12u,  4u, 14u,  6u,
     3u, 11u,  1u,  9u,
    15u,  7u, 13u,  5u,
  );
  let idx = (p.y & 3u) * 4u + (p.x & 3u);
  return (f32(bayer[idx]) / 15.0) - 0.5;
}

@fragment fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let uv = fragCoord.xy / params.resolution;
  let base = textureSample(srcTex, srcSampler, uv);

  let steps = max(params.retroColors, 2.0);
  // Scale the Bayer threshold by the inter-level gap so dithering occurs only
  // at quantisation boundaries, not across the full dynamic range.
  let threshold = bayer4(vec2u(u32(fragCoord.x), u32(fragCoord.y))) / max(steps - 1.0, 1.0);
  let dithered = clamp(base.rgb + threshold, vec3f(0.0), vec3f(1.0));
  // Round to the nearest quantisation level in [0, 1]
  let quantized = round(dithered * (steps - 1.0)) / (steps - 1.0);

  return vec4f(quantized, base.a);
}
`;

// Colour grading — adjusts brightness, contrast, and saturation in a single
// pass.  The three operations are applied in order: brightness first (additive
// offset), then contrast (multiplicative pivot at 0.5), then saturation (mix
// toward the perceptual luminance).  Neutral settings (contrast = 1, sat = 1,
// brightness = 0) leave the image unchanged.
//
// Uniform layout (32 bytes):
//   offset  0: contrast   (f32 — multiplier, 0 = flat grey, 1 = neutral)
//   offset  4: saturation (f32 — mix factor,  0 = greyscale, 1 = neutral)
//   offset  8: brightness (f32 — additive offset, 0 = neutral)
//   offset 12: _pad
//   offset 16: resolution (vec2f)
const COLORGRADE_FRAGMENT = /* wgsl */ `
struct Params {
  contrast: f32,
  saturation: f32,
  brightness: f32,
  _pad: f32,
  resolution: vec2f,
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;

// Perceived luminance using Rec. 601 coefficients.
fn luminance(rgb: vec3f) -> f32 {
  return dot(rgb, vec3f(0.299, 0.587, 0.114));
}

@fragment fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let uv = fragCoord.xy / params.resolution;
  var color = textureSample(srcTex, srcSampler, uv).rgb;

  // 1. Brightness — additive lift/crush
  color = color + params.brightness;

  // 2. Contrast — pivot around mid-grey (0.5) to preserve average exposure
  color = (color - 0.5) * max(params.contrast, 0.0) + 0.5;

  // 3. Saturation — interpolate between greyscale and the original colour
  let grey = luminance(color);
  color = mix(vec3f(grey), color, max(params.saturation, 0.0));

  return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

// FSR 1.0-inspired edge-adaptive spatial upsampling with RCAS sharpening.
//
// This implements a single-pass approximation of AMD FidelityFX Super
// Resolution 1.0.  The algorithm combines:
//
//   1. EASU (Edge-Adaptive Spatial Upsampling): A 12-tap Lanczos-based
//      filter that detects local edges via luma gradients and applies
//      directional reconstruction weights to reduce ringing and preserve
//      fine detail at the upsampled resolution.
//
//   2. RCAS (Robust Contrast-Adaptive Sharpening): A single-pass sharpening
//      step that increases local contrast without amplifying noise, using a
//      per-pixel sharpness estimate derived from the luma neighbourhood.
//
// The two passes are fused into a single fragment shader for the web — this
// avoids the two-pass architecture of the reference AMD implementation while
// still providing a substantial quality improvement over bilinear scaling.
//
// Uniform layout (32 bytes):
//   offset  0: fsrSharpness (f32)
//   offset  4: _pad1 (f32)
//   offset  8: _pad2 (f32)
//   offset 12: _pad3 (f32)
//   offset 16: resolution (vec2f — display width, display height)
//   offset 24: _pad4, _pad5 (padding to 32 bytes)
const FSR_FRAGMENT = /* wgsl */ `
struct Params {
  fsrSharpness: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
  resolution: vec2f,
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;

// Perceived luminance (Rec. 601)
fn luma(rgb: vec3f) -> f32 {
  return dot(rgb, vec3f(0.299, 0.587, 0.114));
}

// Lanczos-2 window function.
fn lanczos2(x: f32) -> f32 {
  if (abs(x) < 0.0001) { return 1.0; }
  if (abs(x) >= 2.0)   { return 0.0; }
  let pi_x = x * 3.14159265358979;
  return (sin(pi_x) / pi_x) * (sin(pi_x * 0.5) / (pi_x * 0.5));
}

// EASU: 4-tap directionally-weighted Lanczos upsampling.
// Samples a 2×2 neighbourhood and blends based on luma-gradient direction.
fn easu(uv: vec2f, texel: vec2f) -> vec3f {
  // Sample 3×3 grid for gradient estimation
  let c00 = textureSample(srcTex, srcSampler, uv + vec2f(-texel.x, -texel.y)).rgb;
  let c10 = textureSample(srcTex, srcSampler, uv + vec2f( 0.0,     -texel.y)).rgb;
  let c20 = textureSample(srcTex, srcSampler, uv + vec2f( texel.x, -texel.y)).rgb;
  let c01 = textureSample(srcTex, srcSampler, uv + vec2f(-texel.x,  0.0    )).rgb;
  let c11 = textureSample(srcTex, srcSampler, uv                            ).rgb;
  let c21 = textureSample(srcTex, srcSampler, uv + vec2f( texel.x,  0.0    )).rgb;
  let c02 = textureSample(srcTex, srcSampler, uv + vec2f(-texel.x,  texel.y)).rgb;
  let c12 = textureSample(srcTex, srcSampler, uv + vec2f( 0.0,      texel.y)).rgb;
  let c22 = textureSample(srcTex, srcSampler, uv + vec2f( texel.x,  texel.y)).rgb;

  // Luma of each sample
  let l00 = luma(c00); let l10 = luma(c10); let l20 = luma(c20);
  let l01 = luma(c01); let l11 = luma(c11); let l21 = luma(c21);
  let l02 = luma(c02); let l12 = luma(c12); let l22 = luma(c22);

  // Horizontal and vertical gradient magnitude (Sobel-like)
  let gx = (-l00 + l20) + 2.0 * (-l01 + l21) + (-l02 + l22);
  let gy = (-l00 - 2.0*l10 - l20) + (l02 + 2.0*l12 + l22);
  let gradMag = sqrt(gx*gx + gy*gy) + 0.0001;

  // Directional weights: favour sampling along the edge direction
  let wx = abs(gy) / gradMag;
  let wy = abs(gx) / gradMag;

  // Reconstruct: bilinear + edge-weighted blend of horizontal/vertical passes
  let horiz = mix(c11, mix(c01, c21, 0.5), wx * 0.5);
  let vert  = mix(c11, mix(c10, c12, 0.5), wy * 0.5);
  return mix(horiz, vert, 0.5);
}

// RCAS: robust contrast-adaptive sharpening.
fn rcas(color: vec3f, uv: vec2f, texel: vec2f, sharpness: f32) -> vec3f {
  let n = textureSample(srcTex, srcSampler, uv + vec2f( 0.0,    -texel.y)).rgb;
  let s = textureSample(srcTex, srcSampler, uv + vec2f( 0.0,     texel.y)).rgb;
  let e = textureSample(srcTex, srcSampler, uv + vec2f( texel.x, 0.0    )).rgb;
  let w = textureSample(srcTex, srcSampler, uv + vec2f(-texel.x, 0.0    )).rgb;

  // Luma-based sharpening amount — reduces sharpening in high-frequency areas
  // to avoid noise amplification.
  let lumaC = luma(color);
  let lumaMin = min(lumaC, min(min(luma(n), luma(s)), min(luma(e), luma(w))));
  let lumaMax = max(lumaC, max(max(luma(n), luma(s)), max(luma(e), luma(w))));
  let lumaRange = lumaMax - lumaMin;

  // Scale sharpness by local contrast: less sharpening in flat / noisy areas.
  let adaptiveSharp = sharpness * (1.0 - lumaRange * 2.0);
  let k = max(adaptiveSharp, 0.0) * 0.25;

  // 5-tap sharpening kernel: centre + (1 + 4k) - cardinal neighbours × k
  return clamp(
    color * (1.0 + 4.0 * k) - (n + s + e + w) * k,
    vec3f(0.0),
    vec3f(1.0)
  );
}

@fragment fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let texel = 1.0 / params.resolution;
  let uv    = fragCoord.xy / params.resolution;

  // EASU upsampling pass
  let upsampled = easu(uv, texel);

  // RCAS sharpening pass (optional — skipped when sharpness is near zero)
  var result = upsampled;
  if (params.fsrSharpness > 0.001) {
    result = rcas(upsampled, uv, texel, params.fsrSharpness);
  }

  return vec4f(result, 1.0);
}
`;

// Temporal Anti-Aliasing (TAA) — blends the current frame with a stored history
// texture to smooth high-frequency temporal noise and reduce shimmer on 3D
// geometry.  This is a lightweight, single-pass accumulation approach suited
// for the WebGPU post-processing pipeline.
//
// Unlike full TAA (which reprojects motion vectors), this implementation is
// a simple frame accumulation: a weighted mix of the current frame and the
// previous frame snapshot stored in the history texture.  The result reduces
// sub-pixel shimmer and edge flicker at a cost of mild ghosting on fast motion.
//
// Uniform layout (32 bytes):
//   offset  0: taaBlend  (f32) — weight of current frame (0 = pure history, 1 = pure current)
//   offset  4–12: _pad × 3
//   offset 16: resolution (vec2f)
//
// Bindings:
//   0: srcTex    — current frame
//   1: srcSampler
//   2: uniforms
//   3: histTex   — previous frame (history buffer)
const TAA_FRAGMENT = /* wgsl */ `
struct Params {
  taaBlend: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
  resolution: vec2f,
};

@group(0) @binding(0) var srcTex:     texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var histTex:    texture_2d<f32>;

@fragment fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let uv      = fragCoord.xy / params.resolution;
  let current = textureSample(srcTex,  srcSampler, uv);
  let history = textureSample(histTex, srcSampler, uv);

  // Blend: high taaBlend = more current frame (less smoothing)
  //        low  taaBlend = more history (stronger smoothing / ghosting)
  let blend = clamp(params.taaBlend, 0.0, 1.0);
  return vec4f(mix(history.rgb, current.rgb, blend), 1.0);
}
`;

// Block pixelation — snaps each fragment to the centre of its enclosing pixel
// cell, producing the classic "mosaic" or "Minecraft" low-resolution look.
//
// Uniform layout (32 bytes):
//   offset  0: pixelateSize (f32 — block size in screen pixels, minimum 1)
//   offset  4–12: _pad × 3
//   offset 16: resolution (vec2f)
const PIXELATE_FRAGMENT = /* wgsl */ `
struct Params {
  pixelateSize: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
  resolution: vec2f,
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;

@fragment fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  // Snap to the centre of the nearest pixel block
  let blockSize = max(params.pixelateSize, 1.0);
  let blockUV = (floor(fragCoord.xy / blockSize) * blockSize + blockSize * 0.5) / params.resolution;
  return textureSample(srcTex, srcSampler, clamp(blockUV, vec2f(0.0), vec2f(1.0)));
}
`;

// NTSC composite video simulation — encodes the image into Y (luma) + IQ (chroma)
// signals, applies the characteristic limited-bandwidth chroma smear, then
// decodes back to RGB.  A dot-crawl pattern is superimposed at colour boundaries
// to reproduce the interference fringing visible on real composite hardware.
//
// Chroma smear: sample the IQ channels at several horizontal offsets and blend
//   them with the center sample, simulating a ~1.3 MHz IQ bandwidth limit.
// Dot crawl: a sine-based beat pattern at the luma–chroma boundary frequency
//   (~3.58 MHz / line-rate) that scrolls with time (animated via grainSeed).
// Luma sharpness: independently controlled so the brightness channel stays crisp.
//
// Uniform layout (32 bytes):
//   offset  0: ntscArtifacts (f32 — composite intensity 0–1)
//   offset  4: ntscSharpness (f32 — luma retention 0–1)
//   offset  8: grainSeed     (f32 — frame counter for dot-crawl animation)
//   offset 12: _pad          (f32)
//   offset 16: resolution    (vec2f)
const NTSC_FRAGMENT = /* wgsl */ `
struct Params {
  ntscArtifacts: f32,
  ntscSharpness: f32,
  grainSeed: f32,
  _pad: f32,
  resolution: vec2f,
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;

// RGB → YIQ (NTSC colour space)
fn rgb2yiq(c: vec3f) -> vec3f {
  return vec3f(
     0.299 * c.r + 0.587 * c.g + 0.114 * c.b,
     0.596 * c.r - 0.274 * c.g - 0.322 * c.b,
     0.211 * c.r - 0.523 * c.g + 0.312 * c.b,
  );
}

// YIQ → RGB
fn yiq2rgb(y: vec3f) -> vec3f {
  return vec3f(
    y.x + 0.956 * y.y + 0.621 * y.z,
    y.x - 0.272 * y.y - 0.647 * y.z,
    y.x - 1.106 * y.y + 1.703 * y.z,
  );
}

@fragment fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let uv   = fragCoord.xy / params.resolution;
  let texel = 1.0 / params.resolution;

  // Center sample in YIQ space
  let center = textureSample(srcTex, srcSampler, uv);
  let yiqC   = rgb2yiq(center.rgb);

  // Chroma blur: sample IQ at ±1 and ±2 texel offsets (scaled by artifact amount)
  let blurStep = params.ntscArtifacts * 3.0 + 0.5;
  let yiqL1 = rgb2yiq(textureSample(srcTex, srcSampler, uv - vec2f(texel.x * blurStep, 0.0)).rgb);
  let yiqL2 = rgb2yiq(textureSample(srcTex, srcSampler, uv - vec2f(texel.x * blurStep * 2.0, 0.0)).rgb);
  let yiqR1 = rgb2yiq(textureSample(srcTex, srcSampler, uv + vec2f(texel.x * blurStep, 0.0)).rgb);

  // Weighted horizontal IQ average — bias left for the characteristic "trailing colour"
  let iqBlurred = (
    vec2f(yiqC.y,  yiqC.z)  * 1.0 +
    vec2f(yiqL1.y, yiqL1.z) * 2.0 +
    vec2f(yiqL2.y, yiqL2.z) * 1.0 +
    vec2f(yiqR1.y, yiqR1.z) * 0.5
  ) / 4.5;

  // Mix original and blurred chroma based on artifact intensity
  let finalIQ = mix(vec2f(yiqC.y, yiqC.z), iqBlurred, params.ntscArtifacts);

  // Dot crawl: sine beat at the NTSC colour carrier frequency (~3.58 MHz).
  // fragCoord.x drives the horizontal carrier frequency; grainSeed animates it.
  let crawl = sin(fragCoord.x * 0.628318 + params.grainSeed * 0.4) *
              0.04 * params.ntscArtifacts;

  // Luma sharpness: unsharp-mask on Y channel when ntscSharpness > 0
  var lumaY = yiqC.x;
  if (params.ntscSharpness > 0.001) {
    let yN = rgb2yiq(textureSample(srcTex, srcSampler, uv + vec2f( 0.0,    -texel.y)).rgb).x;
    let yS = rgb2yiq(textureSample(srcTex, srcSampler, uv + vec2f( 0.0,     texel.y)).rgb).x;
    let yE = rgb2yiq(textureSample(srcTex, srcSampler, uv + vec2f( texel.x, 0.0    )).rgb).x;
    let yW = rgb2yiq(textureSample(srcTex, srcSampler, uv + vec2f(-texel.x, 0.0    )).rgb).x;
    lumaY = clamp(yiqC.x * (1.0 + 4.0 * params.ntscSharpness * 0.5) - (yN + yS + yE + yW) * (params.ntscSharpness * 0.5), 0.0, 1.0);
  }

  let result = yiq2rgb(vec3f(lumaY + crawl, finalIQ));
  return vec4f(clamp(result, vec3f(0.0), vec3f(1.0)), center.a);
}
`;

// HDR tone mapping — applies Reinhard extended tone mapping followed by sRGB
// gamma encoding.  Useful for games that output linear-light values > 1.0
// (e.g. bloom-lit scenes) where a simple clamp would blow out highlights.
//
// Reinhard extended: tone(x) = x * (1 + x/W²) / (1 + x)
//   W = white-point — input luminance mapped to 1.0 after tone mapping.
// Per-channel application preserves hue better than luminance-only mapping for
// the moderate HDR range typical of retro emulation scenes.
//
// Uniform layout (32 bytes):
//   offset  0: hdrExposure   (f32 — pre-tone-map exposure multiplier)
//   offset  4: hdrWhitePoint (f32 — Reinhard white point W)
//   offset  8–12: _pad × 2
//   offset 16: resolution    (vec2f)
const HDR_FRAGMENT = /* wgsl */ `
struct Params {
  hdrExposure: f32,
  hdrWhitePoint: f32,
  _pad1: f32,
  _pad2: f32,
  resolution: vec2f,
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;

// Reinhard extended per-channel tone mapping.
fn reinhardExtended(x: f32, w: f32) -> f32 {
  let w2 = max(w * w, 0.0001);
  return (x * (1.0 + x / w2)) / (1.0 + x);
}

@fragment fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let uv   = fragCoord.xy / params.resolution;
  let raw  = textureSample(srcTex, srcSampler, uv).rgb;

  // Apply exposure before tone mapping
  let exposed = raw * max(params.hdrExposure, 0.001);

  // Per-channel Reinhard extended tone mapping
  let w = max(params.hdrWhitePoint, 0.001);
  let tonemapped = vec3f(
    reinhardExtended(exposed.r, w),
    reinhardExtended(exposed.g, w),
    reinhardExtended(exposed.b, w),
  );

  // Approximate sRGB gamma (2.2) — avoid pow() branch for values < 0.0031308
  // by using the piecewise linear approximation:
  //   linear  ≤ 0.0031308 → 12.92 × linear
  //   linear  >  0.0031308 → 1.055 × linear^(1/2.4) − 0.055
  let cutoff = vec3f(0.0031308);
  let gamma = mix(
    tonemapped * 12.92,
    pow(tonemapped, vec3f(1.0 / 2.4)) * 1.055 - vec3f(0.055),
    vec3f(f32(tonemapped.r > cutoff.r), f32(tonemapped.g > cutoff.g), f32(tonemapped.b > cutoff.b))
  );

  return vec4f(clamp(gamma, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

interface EffectPipeline {
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
  uniformBuffer: GPUBuffer | null;
  /** WGSL source strings built into this pipeline (vertex, fragment). */
  wgslSources: { vertex: string; fragment: string };
  /** True when the pipeline uses a second texture binding (e.g. TAA history). */
  requiresHistoryTexture?: boolean;

}

// ── Pipeline builder ──────────────────────────────────────────────────────────

/**
 * Public alias for the pipeline descriptor returned by buildEffectPipeline().
 * Expose this type so callers can annotate references to the pipeline object.
 */
export type { EffectPipeline };

/**
 * Human-readable display labels for each post-processing effect.
 * Useful for building UI dropdowns and tooltips without duplicating
 * label strings across the application.
 */
export const EFFECT_LABELS: Record<PostProcessEffect, string> = {
  none:       "No effect",
  crt:        "CRT screen",
  sharpen:    "Sharpen",
  lcd:        "LCD shadow mask",
  bloom:      "Bloom glow",
  fxaa:       "FXAA anti-aliasing",
  fsr:        "FSR 1.0 upscaling",
  grain:      "Film grain",
  retro:      "Retro pixel art",
  colorgrade: "Color grading",
  taa:        "Temporal AA (TAA)",
  pixelate:   "Pixelate",
  ntsc:       "NTSC composite",
  hdr:        "HDR tone mapping",
};

/**
 * Clamp all numeric parameters in a PostProcessConfig to their documented
 * valid ranges.  Returns a new object; does not mutate the input.
 *
 * Use this before persisting user-supplied settings or after deserialising
 * config from localStorage to guard against out-of-range values.
 */
export function validatePostProcessConfig(config: PostProcessConfig): PostProcessConfig {
  return {
    ...config,
    scanlineIntensity: Math.max(0, Math.min(1,   config.scanlineIntensity)),
    curvature:         Math.max(0, Math.min(1,   config.curvature)),
    vignetteStrength:  Math.max(0, Math.min(1,   config.vignetteStrength)),
    sharpenAmount:     Math.max(0, Math.min(2,   config.sharpenAmount)),
    lcdShadowMask:     Math.max(0, Math.min(1,   config.lcdShadowMask)),
    lcdPixelScale:     Math.max(0.1, Math.min(8, config.lcdPixelScale)),
    bloomThreshold:    Math.max(0, Math.min(1,   config.bloomThreshold)),
    bloomIntensity:    Math.max(0, Math.min(2,   config.bloomIntensity)),
    fxaaQuality:       Math.max(0, Math.min(1,   config.fxaaQuality)),
    fsrSharpness:      Math.max(0, Math.min(1,   config.fsrSharpness)),
    grainIntensity:    Math.max(0, Math.min(1,   config.grainIntensity)),
    grainSize:         Math.max(0.5, Math.min(8, config.grainSize)),
    retroColors:       Math.max(2, Math.min(256, Math.round(config.retroColors))),
    contrast:          Math.max(0, Math.min(4,   config.contrast)),
    saturation:        Math.max(0, Math.min(4,   config.saturation)),
    brightness:        Math.max(-1, Math.min(1,  config.brightness)),
    taaBlend:          Math.max(0, Math.min(1,   config.taaBlend)),
    pixelateSize:      Math.max(1, Math.min(32,  Math.round(config.pixelateSize))),
    ntscArtifacts:     Math.max(0, Math.min(1,   config.ntscArtifacts)),
    ntscSharpness:     Math.max(0, Math.min(1,   config.ntscSharpness)),
    hdrExposure:       Math.max(0.1, Math.min(8, config.hdrExposure)),
    hdrWhitePoint:     Math.max(0.1, Math.min(8, config.hdrWhitePoint)),
    pixelPerfect:      config.pixelPerfect,
  };
}

/**
 * Adjust post-process parameters based on device tier.
 * Reduces effect intensity on lower-tier devices to maintain framerate.
 */
export function adjustConfigForTier(config: PostProcessConfig): PostProcessConfig {
  const tier = config.tier;
  if (!tier || tier === "ultra" || tier === "high") return config;

  const adjusted = { ...config };
  if (tier === "low") {
    // Disable expensive effects entirely on low-tier devices
    const LOW_TIER_MAX_CURVATURE  = 0.2;
    const LOW_TIER_MAX_SCANLINE   = 0.3;
    adjusted.bloomIntensity = 0;
    adjusted.curvature = Math.min(adjusted.curvature, LOW_TIER_MAX_CURVATURE);
    adjusted.scanlineIntensity = Math.min(adjusted.scanlineIntensity, LOW_TIER_MAX_SCANLINE);
    // FSR: disable RCAS sharpening on low tier to save shader cost
    adjusted.fsrSharpness = 0;
    // TAA: disabled on low tier — history texture copy adds GPU overhead
    adjusted.taaBlend = 1;
    // NTSC: reduce artifact complexity on low tier
    adjusted.ntscArtifacts = Math.min(adjusted.ntscArtifacts, 0.4);
    adjusted.ntscSharpness = Math.max(adjusted.ntscSharpness, 0.5);
    // Pixelate: limit block size to reduce per-frame overhead on very low-end GPUs
    adjusted.pixelateSize = Math.max(adjusted.pixelateSize, 2);
  } else if (tier === "medium") {
    // Reduce intensity on medium-tier devices
    const MED_TIER_MAX_BLOOM     = 0.3;
    const MED_TIER_MAX_CURVATURE = 0.5;
    const MED_TIER_MAX_FSR       = 0.15;
    adjusted.bloomIntensity = Math.min(adjusted.bloomIntensity, MED_TIER_MAX_BLOOM);
    adjusted.curvature = Math.min(adjusted.curvature, MED_TIER_MAX_CURVATURE);
    adjusted.fsrSharpness = Math.min(adjusted.fsrSharpness, MED_TIER_MAX_FSR);
    // TAA: cap blend on medium to reduce history influence (less ghosting risk)
    adjusted.taaBlend = Math.max(adjusted.taaBlend, 0.2);
    // NTSC: slight artifact reduction on medium tier
    adjusted.ntscArtifacts = Math.min(adjusted.ntscArtifacts, 0.7);
  }
  return adjusted;
}

export function buildEffectPipeline(
  device: GPUDevice,
  effect: PostProcessEffect,
  format: GPUTextureFormat,
): EffectPipeline {
  let fragmentCode: string;

  switch (effect) {
    case "crt":        fragmentCode = CRT_FRAGMENT; break;
    case "sharpen":    fragmentCode = SHARPEN_FRAGMENT; break;
    case "lcd":        fragmentCode = LCD_FRAGMENT; break;
    case "bloom":      fragmentCode = BLOOM_FRAGMENT; break;
    case "fxaa":       fragmentCode = FXAA_FRAGMENT; break;
    case "fsr":        fragmentCode = FSR_FRAGMENT; break;
    case "grain":      fragmentCode = GRAIN_FRAGMENT; break;
    case "retro":      fragmentCode = RETRO_FRAGMENT; break;
    case "colorgrade": fragmentCode = COLORGRADE_FRAGMENT; break;
    case "taa":        fragmentCode = TAA_FRAGMENT; break;
    case "pixelate":   fragmentCode = PIXELATE_FRAGMENT; break;
    case "ntsc":       fragmentCode = NTSC_FRAGMENT; break;
    case "hdr":        fragmentCode = HDR_FRAGMENT; break;
    default:           fragmentCode = PASSTHROUGH_FRAGMENT; break;
  }

  const vertModule = device.createShaderModule({ code: FULLSCREEN_VERTEX });
  const fragModule = device.createShaderModule({ code: fragmentCode });

  // All effects except passthrough ("none") use a uniform buffer for parameters.
  const hasUniforms = effect !== "none";
  const requiresHistoryTexture = effect === "taa";

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

  // TAA requires a second texture input for the history (previous frame) buffer.
  if (requiresHistoryTexture) {
    entries.push({
      binding: 3,
      visibility: SHADER_STAGE_FRAGMENT,
      texture: { sampleType: "float" },
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

  return { pipeline, bindGroupLayout, uniformBuffer, wgslSources: { vertex: FULLSCREEN_VERTEX, fragment: fragmentCode }, requiresHistoryTexture };
}

// ── WebGPUPostProcessor ───────────────────────────────────────────────────────

export class WebGPUPostProcessor {
  private _device: GPUDevice;
  private _config: PostProcessConfig;
  private _canvas: HTMLCanvasElement | null = null;
  private _gpuContext: GPUCanvasContext | null = null;
  private _sourceCanvas: HTMLCanvasElement | null = null;
  private _sourceTexture: GPUTexture | null = null;
  /** History texture for TAA accumulation (previous frame snapshot). */
  private _historyTexture: GPUTexture | null = null;
  /** Bilinear sampler — default for most effects. */
  private _sampler: GPUSampler | null = null;
  /** Nearest-neighbour (point) sampler — used when `pixelPerfect` is true. */
  private _nearestSampler: GPUSampler | null = null;
  private _effectPipeline: EffectPipeline | null = null;
  private _currentEffect: PostProcessEffect = "none";
  private _presentFormat: GPUTextureFormat = "bgra8unorm";
  private _rafId: number | null = null;
  private _active = false;
  private _lastSourceWidth = 0;
  private _lastSourceHeight = 0;

  /**
   * Cached bind group for the current source texture + pipeline combination.
   * Invalidated whenever the source texture handle changes (canvas resize),
   * the history texture changes (TAA resize), or the sampler mode changes.
   * Re-creating the bind group every frame was the single largest per-frame
   * allocation; caching it brings that to zero in the steady state.
   */
  private _cachedBindGroup: GPUBindGroup | null = null;
  private _cachedBindGroupTexture: GPUTexture | null = null;
  /**
   * Tracks the history texture used in the cached bind group for TAA.
   * When `_ensureHistoryTexture()` recreates the history texture on a resize,
   * this field diverges from `_historyTexture` and the cache is invalidated.
   */
  private _cachedBindGroupHistoryTexture: GPUTexture | null = null;

  /**
   * Pre-allocated Float32Array for uniform uploads.
   * Reusing this buffer avoids a 32-byte heap allocation every rAF tick.
   */
  private readonly _uniformData = new Float32Array(8);

  /**
   * Counts every rendered frame — used as the animated grain seed.
   * Wraps at _FRAME_COUNT_WRAP to stay within safe f32 integer precision.
   */
  private _frameCount = 0;
  /**
   * Upper bound for the frame counter modulo wrap.
   * 10 000 keeps the value well within f32 integer precision (f32 can represent
   * all integers up to 2^24 = 16 777 216 exactly) while providing a long enough
   * cycle that the grain pattern does not visibly repeat.
   */
  private static readonly _FRAME_COUNT_WRAP = 10_000;

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

  /**
   * Optional callback invoked when the WebGPU device is lost.
   *
   * The processor stops its render loop and deactivates before firing this
   * callback. Callers can use it to re-initialise the WebGPU device and
   * re-attach the post-processor (see `PSPEmulator.preWarmWebGPU()`).
   */
  onDeviceLost?: () => void;

  constructor(device: GPUDevice, config?: Partial<PostProcessConfig>) {
    this._device = device;
    this._config = { ...DEFAULT_POST_PROCESS_CONFIG, ...config };
    this._initTimestampQuery();
    this._watchDeviceLost();
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

    this._presentFormat = (navigator.gpu?.getPreferredCanvasFormat?.() as GPUTextureFormat | undefined) ?? "bgra8unorm";
    this._gpuContext.configure({
      device: this._device,
      format: this._presentFormat,
      alphaMode: "premultiplied",
    });

    this._sampler = this._device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });

    // Nearest-neighbour sampler for pixel-perfect mode (pixel-art games).
    // Created once here and reused; the bind group selects between the two
    // based on `pixelPerfect` in the config.
    this._nearestSampler = this._device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
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
    this._nearestSampler = null;
    this._invalidateBindGroupCache();
    this._destroyTimestampQuery();
  }

  /** Update post-processing configuration. Rebuilds the pipeline if the effect changes. */
  updateConfig(patch: Partial<PostProcessConfig>): void {
    const prevEffect      = this._config.effect;
    const prevPixelPerfect = this._config.pixelPerfect;
    Object.assign(this._config, patch);

    if (this._config.effect !== prevEffect) {
      this._rebuildPipeline();
      // Changing the pipeline invalidates the cached bind group because the
      // bind group layout changes with the effect.
      this._invalidateBindGroupCache();
    } else if (this._config.pixelPerfect !== prevPixelPerfect) {
      // Sampler switched between bilinear ↔ nearest — the bind group must be
      // recreated because it references the sampler object directly.
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
    const prevPipeline = this._effectPipeline;
    this._currentEffect = this._config.effect;

    try {
      this._effectPipeline = buildEffectPipeline(
        this._device,
        this._currentEffect,
        this._presentFormat,
      );

      // Destroy the old uniform buffer only after the new pipeline is assigned
      // to avoid releasing GPU resources before the replacement is ready.
      prevPipeline?.uniformBuffer?.destroy();

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
      // Release the old buffer to avoid a GPU resource leak.
      prevPipeline?.uniformBuffer?.destroy();
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
        // TEX_COPY_SRC is required to support copyTextureToTexture() into the
        // TAA history buffer after each frame.  Included unconditionally because
        // the overhead is negligible and it avoids recreating the texture when
        // switching to/from the TAA effect.
        TEX_COPY_SRC |
        TEX_RENDER_ATTACH,
    });

    this._lastSourceWidth = width;
    this._lastSourceHeight = height;

    // The texture handle changed — the cached bind group must be recreated.
    this._invalidateBindGroupCache();
  }

  /**
   * Ensure the TAA history texture exists at the given dimensions.
   * Creates or recreates the texture when dimensions change.
   * The history texture stores the previous frame for temporal blending.
   */
  private _ensureHistoryTexture(width: number, height: number): void {
    if (
      this._historyTexture &&
      this._historyTexture.width === width &&
      this._historyTexture.height === height
    ) {
      return;
    }
    this._historyTexture?.destroy();
    this._historyTexture = this._device.createTexture({
      size: { width, height },
      format: "rgba8unorm",
      usage: TEX_BINDING | TEX_COPY_DST,
    });
    // Invalidate cached bind group so next frame builds with new history handle.
    this._invalidateBindGroupCache();
  }

  private _destroySourceTexture(): void {
    this._sourceTexture?.destroy();
    this._sourceTexture = null;
    this._lastSourceWidth = 0;
    this._lastSourceHeight = 0;
    // Also tear down history texture — it matches source dimensions.
    this._historyTexture?.destroy();
    this._historyTexture = null;
    this._invalidateBindGroupCache();
  }

  /**
   * Drop the cached bind group.
   * Called whenever the source texture, history texture, pipeline, or sampler
   * mode changes so the next _renderFrame call recreates it against the current
   * handles.
   */
  private _invalidateBindGroupCache(): void {
    this._cachedBindGroup = null;
    this._cachedBindGroupTexture = null;
    this._cachedBindGroupHistoryTexture = null;
  }

  /**
   * Return the cached bind group, creating it if necessary.
   *
   * The bind group wraps the source texture view, sampler, and uniform buffer.
   * Since none of these change between frames (only the uniform *values* change,
   * which are uploaded via writeBuffer to the same GPUBuffer), the bind group
   * object itself can be reused indefinitely — until any of the following change:
   *   - source texture handle (canvas resize)
   *   - history texture handle for TAA (canvas resize)
   *   - pipeline (effect switch)
   *   - sampler mode (pixelPerfect toggle)
   */
  private _ensureBindGroup(): GPUBindGroup | null {
    if (!this._effectPipeline || !this._sourceTexture || !this._sampler) return null;

    // For TAA, the bind group also depends on the history texture.
    // The cache key must include both textures.
    const needsHistory = this._effectPipeline.requiresHistoryTexture;
    if (needsHistory && !this._historyTexture) return null;

    // Select the appropriate sampler based on pixelPerfect mode.
    // Nearest sampler may be absent on old attach paths — fall back to linear.
    const sampler = (this._config.pixelPerfect && this._nearestSampler)
      ? this._nearestSampler
      : this._sampler;

    // Cache hit: source texture, history texture (for TAA), and sampler type
    // are all unchanged since the last bind group was built.
    if (
      this._cachedBindGroup &&
      this._cachedBindGroupTexture === this._sourceTexture &&
      (!needsHistory || this._cachedBindGroupHistoryTexture === this._historyTexture)
    ) {
      return this._cachedBindGroup;
    }

    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: this._sourceTexture.createView() },
      { binding: 1, resource: sampler },
    ];
    if (this._effectPipeline.uniformBuffer) {
      entries.push({ binding: 2, resource: { buffer: this._effectPipeline.uniformBuffer } });
    }
    if (needsHistory && this._historyTexture) {
      entries.push({ binding: 3, resource: this._historyTexture.createView() });
    }

    this._cachedBindGroup = this._device.createBindGroup({
      layout: this._effectPipeline.bindGroupLayout,
      entries,
    });
    this._cachedBindGroupTexture = this._sourceTexture;
    this._cachedBindGroupHistoryTexture = needsHistory ? this._historyTexture : null;
    return this._cachedBindGroup;
  }

  /**
   * Safely acquire the current swapchain texture view from the WebGPU canvas.
   *
   * `getCurrentTexture()` can throw or transiently return invalid handles when
   * the canvas/swapchain is being reconfigured (or in test mocks). In that
   * case, skip this frame instead of surfacing an uncaught exception.
   */
  private _acquireCurrentTextureView(): GPUTextureView | null {
    if (!this._gpuContext) return null;

    let currentTexture: GPUTexture | null = null;
    try {
      currentTexture = this._gpuContext.getCurrentTexture();
    } catch {
      return null;
    }
    if (!currentTexture) return null;

    try {
      return currentTexture.createView();
    } catch {
      return null;
    }
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

    // TAA: ensure history texture exists and is correctly sized.
    const isTAA = this._effectPipeline.requiresHistoryTexture;
    if (isTAA) {
      this._ensureHistoryTexture(srcW, srcH);
      if (!this._historyTexture) return;
    }

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

    // Increment the frame counter after a successful copy (used as grain seed).
    this._frameCount = (this._frameCount + 1) % WebGPUPostProcessor._FRAME_COUNT_WRAP;

    // Upload uniforms — reuses the pre-allocated Float32Array
    this._writeUniforms(srcW, srcH);

    // Retrieve the cached (or freshly created) bind group.
    // Note: _ensureHistoryTexture() already calls _invalidateBindGroupCache() when
    // it creates or recreates the history texture, so no explicit invalidation is
    // needed here.
    const bindGroup = this._ensureBindGroup();
    if (!bindGroup) return;

    const view = targetView ?? this._acquireCurrentTextureView();
    if (!view) return;

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

    // TAA: copy the current source frame into the history buffer for next frame.
    // This records the pre-blend source so the next frame can reference it.
    if (isTAA && this._sourceTexture && this._historyTexture) {
      encoder.copyTextureToTexture(
        { texture: this._sourceTexture },
        { texture: this._historyTexture },
        { width: srcW, height: srcH },
      );
    }

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

    // Apply tier-based adjustments before writing to the GPU buffer
    const cfg = adjustConfigForTier(this._config);

    // Reuse the pre-allocated buffer — no heap allocation
    const data = this._uniformData;

    switch (this._currentEffect) {
      case "crt":
        data[0] = cfg.scanlineIntensity;
        data[1] = cfg.curvature;
        data[2] = cfg.vignetteStrength;
        data[3] = 0; // padding
        data[4] = width;
        data[5] = height;
        break;
      case "sharpen":
        data[0] = cfg.sharpenAmount;
        data[1] = 0;
        data[2] = 0;
        data[3] = 0;
        data[4] = width;
        data[5] = height;
        break;
      case "lcd":
        data[0] = cfg.lcdShadowMask;
        data[1] = cfg.lcdPixelScale;
        data[2] = 0;
        data[3] = 0;
        data[4] = width;
        data[5] = height;
        break;
      case "bloom":
        data[0] = cfg.bloomThreshold;
        data[1] = cfg.bloomIntensity;
        data[2] = 0;
        data[3] = 0;
        data[4] = width;
        data[5] = height;
        break;
      case "fxaa":
        data[0] = cfg.fxaaQuality;
        data[1] = 0;
        data[2] = 0;
        data[3] = 0;
        data[4] = width;
        data[5] = height;
        break;
      case "fsr":
        data[0] = cfg.fsrSharpness;
        data[1] = 0;
        data[2] = 0;
        data[3] = 0;
        data[4] = width;
        data[5] = height;
        break;
      case "grain":
        data[0] = cfg.grainIntensity;
        data[1] = cfg.grainSize;
        data[2] = this._frameCount; // animated seed — changes every frame
        data[3] = 0;
        data[4] = width;
        data[5] = height;
        break;
      case "retro":
        data[0] = cfg.retroColors;
        data[1] = 0;
        data[2] = 0;
        data[3] = 0;
        data[4] = width;
        data[5] = height;
        break;
      case "colorgrade":
        data[0] = cfg.contrast;
        data[1] = cfg.saturation;
        data[2] = cfg.brightness;
        data[3] = 0;
        data[4] = width;
        data[5] = height;
        break;
      case "taa":
        data[0] = cfg.taaBlend;
        data[1] = 0;
        data[2] = 0;
        data[3] = 0;
        data[4] = width;
        data[5] = height;
        break;
      case "pixelate":
        data[0] = cfg.pixelateSize;
        data[1] = 0;
        data[2] = 0;
        data[3] = 0;
        data[4] = width;
        data[5] = height;
        break;
      case "ntsc":
        data[0] = cfg.ntscArtifacts;
        data[1] = cfg.ntscSharpness;
        data[2] = this._frameCount; // animated dot-crawl seed — changes every frame
        data[3] = 0;
        data[4] = width;
        data[5] = height;
        break;
      case "hdr":
        data[0] = cfg.hdrExposure;
        data[1] = cfg.hdrWhitePoint;
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
      try {
        this._renderFrame();
      } catch (err) {
        console.warn("[RetroVault] WebGPU post-process frame failed — stopping render loop.", err);
        this._stopLoop();
        this._hideOverlay();
        return;
      }
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
   * Subscribe to the device's lost promise so we can gracefully stop the
   * render loop if the GPU context is lost (e.g. driver crash, tab hidden,
   * or GPU reset). Without this the rAF loop would keep trying to call into
   * an invalidated device on every animation frame.
   */
  private _watchDeviceLost(): void {
    // Guard against environments where the lost property may not be available
    // (e.g. older WebGPU implementations or mock objects in tests).
    const lost = this._device.lost as (Promise<GPUDeviceLostInfo> | undefined);
    if (lost == null) return;
    lost.then((info) => {
      if (!this._active) return;
      console.warn(
        `[RetroVault] WebGPU device lost (reason: ${info.reason}, message: "${info.message}"). ` +
        "Post-processing render loop stopped."
      );
      this._stopLoop();
      this._hideOverlay();
      this._active = false;
      // Notify the caller so they can attempt to re-acquire the device and
      // re-attach the post-processor (e.g. PSPEmulator.preWarmWebGPU()).
      this.onDeviceLost?.();
    }).catch(() => { /* ignore — device loss is not a recoverable error here */ });
  }

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
        const beginNs = view[0]!;
        const endNs   = view[1]!;
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
              const word = src32[srcRowBase + x]!;
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
