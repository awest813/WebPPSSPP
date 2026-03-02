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
 * Screenshot capture:
 *   captureScreenshotAsync() copies the post-processed frame to a staging
 *   GPUBuffer, maps it asynchronously via mapAsync(), and converts the
 *   pixel data to a JPEG Blob without synchronous GPU stalls.
 */

// ── WebGPU enum constants (numeric to avoid runtime dependency on globals) ────
// These values are stable and part of the WebGPU spec.

const SHADER_STAGE_FRAGMENT = 0x2;

const BUFFER_UNIFORM   = 0x0040;
const BUFFER_COPY_DST  = 0x0008;
const BUFFER_MAP_READ  = 0x0001;

const TEX_BINDING          = 0x04;
const TEX_COPY_DST         = 0x02;
const TEX_COPY_SRC         = 0x01;
const TEX_RENDER_ATTACH    = 0x10;

const MAP_MODE_READ = 0x0001;

// ── Effect types ──────────────────────────────────────────────────────────────

export type PostProcessEffect = "none" | "crt" | "sharpen";

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
}

export const DEFAULT_POST_PROCESS_CONFIG: PostProcessConfig = {
  effect: "none",
  scanlineIntensity: 0.15,
  curvature: 0.03,
  vignetteStrength: 0.2,
  sharpenAmount: 0.5,
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

// ── Pipeline builder ──────────────────────────────────────────────────────────

interface EffectPipeline {
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
  uniformBuffer: GPUBuffer | null;
}

function buildEffectPipeline(
  device: GPUDevice,
  effect: PostProcessEffect,
  format: GPUTextureFormat,
): EffectPipeline {
  let fragmentCode: string;

  switch (effect) {
    case "crt":     fragmentCode = CRT_FRAGMENT; break;
    case "sharpen": fragmentCode = SHARPEN_FRAGMENT; break;
    default:        fragmentCode = PASSTHROUGH_FRAGMENT; break;
  }

  const vertModule = device.createShaderModule({ code: FULLSCREEN_VERTEX });
  const fragModule = device.createShaderModule({ code: fragmentCode });

  const hasUniforms = effect === "crt" || effect === "sharpen";

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

  return { pipeline, bindGroupLayout, uniformBuffer };
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

  constructor(device: GPUDevice, config?: Partial<PostProcessConfig>) {
    this._device = device;
    this._config = { ...DEFAULT_POST_PROCESS_CONFIG, ...config };
  }

  get active(): boolean { return this._active; }
  get config(): PostProcessConfig { return { ...this._config }; }

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
  }

  /** Update post-processing configuration. Rebuilds the pipeline if the effect changes. */
  updateConfig(patch: Partial<PostProcessConfig>): void {
    const prevEffect = this._config.effect;
    Object.assign(this._config, patch);

    if (this._config.effect !== prevEffect) {
      this._rebuildPipeline();
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
  }

  private _destroySourceTexture(): void {
    this._sourceTexture?.destroy();
    this._sourceTexture = null;
    this._lastSourceWidth = 0;
    this._lastSourceHeight = 0;
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

    // Write uniforms
    this._writeUniforms(srcW, srcH);

    // Build bind group (must be recreated if texture changes)
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: this._sourceTexture.createView() },
      { binding: 1, resource: this._sampler },
    ];
    if (this._effectPipeline.uniformBuffer) {
      entries.push({ binding: 2, resource: { buffer: this._effectPipeline.uniformBuffer } });
    }

    const bindGroup = this._device.createBindGroup({
      layout: this._effectPipeline.bindGroupLayout,
      entries,
    });

    const view = targetView ?? this._gpuContext.getCurrentTexture().createView();

    const encoder = this._device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    });

    pass.setPipeline(this._effectPipeline.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();

    this._device.queue.submit([encoder.finish()]);
  }

  private _writeUniforms(width: number, height: number): void {
    if (!this._effectPipeline?.uniformBuffer) return;

    const data = new Float32Array(8);

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

  /**
   * Convert raw BGRA/RGBA pixel data to a JPEG Blob via an offscreen canvas.
   * Handles the BGRA→RGBA channel swap that most WebGPU implementations use.
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

        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const srcIdx = y * bytesPerRow + x * 4;
            const dstIdx = (y * width + x) * 4;
            if (isBGRA) {
              imageData.data[dstIdx + 0] = data[srcIdx + 2]; // R ← B
              imageData.data[dstIdx + 1] = data[srcIdx + 1]; // G
              imageData.data[dstIdx + 2] = data[srcIdx + 0]; // B ← R
            } else {
              imageData.data[dstIdx + 0] = data[srcIdx + 0];
              imageData.data[dstIdx + 1] = data[srcIdx + 1];
              imageData.data[dstIdx + 2] = data[srcIdx + 2];
            }
            imageData.data[dstIdx + 3] = data[srcIdx + 3];
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
