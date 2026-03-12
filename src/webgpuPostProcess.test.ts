import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  WebGPUPostProcessor,
  DEFAULT_POST_PROCESS_CONFIG,
  buildEffectPipeline,
  adjustConfigForTier,
  validatePostProcessConfig,
  EFFECT_LABELS,
  type PostProcessConfig,
  type PostProcessEffect,
  type EffectPipeline,
} from "./webgpuPostProcess.js";

// ── Mock GPU device factory ───────────────────────────────────────────────────

function createMockGPUDevice() {
  const mockBuffer = {
    destroy: vi.fn(),
    mapAsync: vi.fn().mockResolvedValue(undefined),
    getMappedRange: vi.fn().mockReturnValue(new ArrayBuffer(256 * 4)),
    unmap: vi.fn(),
    size: 256 * 4,
    usage: 0,
    label: "",
    mapState: "unmapped" as GPUBufferMapState,
  };

  const mockTexture = {
    createView: vi.fn().mockReturnValue({}),
    destroy: vi.fn(),
    width: 640,
    height: 480,
    format: "rgba8unorm" as GPUTextureFormat,
    depthOrArrayLayers: 1,
    mipLevelCount: 1,
    sampleCount: 1,
    dimension: "2d" as GPUTextureDimension,
    usage: 0,
    label: "",
  };

  const mockEncoder = {
    beginRenderPass: vi.fn().mockReturnValue({
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
      end: vi.fn(),
    }),
    copyTextureToBuffer: vi.fn(),
    finish: vi.fn().mockReturnValue({}),
    beginComputePass: vi.fn().mockReturnValue({ end: vi.fn() }),
    resolveQuerySet: vi.fn(),
    copyBufferToBuffer: vi.fn(),
    label: "",
  };

  const device = {
    createBuffer: vi.fn().mockReturnValue(mockBuffer),
    createTexture: vi.fn().mockReturnValue(mockTexture),
    createSampler: vi.fn().mockReturnValue({}),
    createShaderModule: vi.fn().mockReturnValue({}),
    createRenderPipeline: vi.fn().mockReturnValue({}),
    createBindGroupLayout: vi.fn().mockReturnValue({}),
    createPipelineLayout: vi.fn().mockReturnValue({}),
    createBindGroup: vi.fn().mockReturnValue({}),
    createCommandEncoder: vi.fn().mockReturnValue(mockEncoder),
    createQuerySet: vi.fn().mockReturnValue({ destroy: vi.fn() }),
    features: new Set<string>(),
    queue: {
      submit: vi.fn(),
      writeBuffer: vi.fn(),
      copyExternalImageToTexture: vi.fn(),
    },
    destroy: vi.fn(),
  };

  return { device, mockTexture, mockBuffer, mockEncoder };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("WebGPUPostProcessor", () => {
  let container: HTMLDivElement;
  let sourceCanvas: HTMLCanvasElement;

  beforeEach(() => {
    container = document.createElement("div");
    container.id = "test-container";
    document.body.appendChild(container);

    sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = 640;
    sourceCanvas.height = 480;
    container.appendChild(sourceCanvas);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  describe("construction", () => {
    it("uses default config when none is provided", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
      expect(pp.config).toEqual(DEFAULT_POST_PROCESS_CONFIG);
      expect(pp.active).toBe(false);
    });

    it("accepts partial config overrides", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice, {
        effect: "crt",
        scanlineIntensity: 0.3,
      });
      expect(pp.config.effect).toBe("crt");
      expect(pp.config.scanlineIntensity).toBe(0.3);
      expect(pp.config.curvature).toBe(DEFAULT_POST_PROCESS_CONFIG.curvature);
    });

    it("exposes lastGPUFrameTimeMs getter (null before any frame)", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
      expect(pp.lastGPUFrameTimeMs).toBeNull();
    });
  });

  describe("updateConfig", () => {
    it("merges partial config updates", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
      pp.updateConfig({ effect: "sharpen", sharpenAmount: 1.0 });
      expect(pp.config.effect).toBe("sharpen");
      expect(pp.config.sharpenAmount).toBe(1.0);
    });

    it("rebuilds pipeline when effect changes (calls createRenderPipeline)", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      // First change builds a pipeline
      pp.updateConfig({ effect: "crt" });
      const firstCallCount = (device.createRenderPipeline as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(firstCallCount).toBeGreaterThan(0);

      // Second change rebuilds
      pp.updateConfig({ effect: "sharpen" });
      const secondCallCount = (device.createRenderPipeline as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(secondCallCount).toBeGreaterThan(firstCallCount);
    });

    it("rebuilds pipeline when switching to lcd effect", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      pp.updateConfig({ effect: "lcd" });
      const callCount = (device.createRenderPipeline as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callCount).toBeGreaterThan(0);
    });

    it("rebuilds pipeline when switching to bloom effect", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      pp.updateConfig({ effect: "bloom" });
      const callCount = (device.createRenderPipeline as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callCount).toBeGreaterThan(0);
    });

    it("accepts lcd-specific config parameters", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
      pp.updateConfig({ effect: "lcd", lcdShadowMask: 0.7, lcdPixelScale: 2.0 });
      expect(pp.config.effect).toBe("lcd");
      expect(pp.config.lcdShadowMask).toBe(0.7);
      expect(pp.config.lcdPixelScale).toBe(2.0);
    });

    it("accepts bloom-specific config parameters", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
      pp.updateConfig({ effect: "bloom", bloomThreshold: 0.8, bloomIntensity: 1.2 });
      expect(pp.config.effect).toBe("bloom");
      expect(pp.config.bloomThreshold).toBe(0.8);
      expect(pp.config.bloomIntensity).toBe(1.2);
    });

    it("does not rebuild pipeline when only parameters change", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      pp.updateConfig({ effect: "crt" });
      const initialCallCount = (device.createRenderPipeline as ReturnType<typeof vi.fn>).mock.calls.length;

      pp.updateConfig({ scanlineIntensity: 0.5 });
      const afterCallCount = (device.createRenderPipeline as ReturnType<typeof vi.fn>).mock.calls.length;

      expect(afterCallCount).toBe(initialCallCount);
    });
  });

  describe("dispose", () => {
    it("does not throw when called without attach", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
      expect(() => pp.dispose()).not.toThrow();
    });

    it("sets active to false", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
      pp.dispose();
      expect(pp.active).toBe(false);
    });
  });

  describe("device loss handling", () => {
    it("stops the render loop and deactivates when the GPU device is lost", async () => {
      // Create a deferred promise that simulates device loss
      let signalLost!: (info: { reason: string; message: string }) => void;
      const lostPromise = new Promise<{ reason: string; message: string }>(
        (resolve) => { signalLost = resolve; }
      );

      const { device } = createMockGPUDevice();
      // Wire the device's lost promise
      (device as unknown as Record<string, unknown>).lost = lostPromise;

      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice, { effect: "crt" });

      const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
      const webgpuContext = {
        configure: vi.fn(),
        getCurrentTexture: vi.fn().mockReturnValue({ createView: vi.fn().mockReturnValue({}) }),
      };
      const getContextSpy = vi
        .spyOn(HTMLCanvasElement.prototype, "getContext")
        .mockImplementation((contextId: "webgpu") => {
          if (contextId === "webgpu") return webgpuContext as unknown as GPUCanvasContext;
          return null;
        });
      const originalGPU = navigator.gpu;
      Object.defineProperty(navigator, "gpu", {
        configurable: true,
        writable: true,
        value: { getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm") },
      });

      pp.attach(sourceCanvas, container);
      expect(pp.active).toBe(true);

      // Simulate device loss — the handler should deactivate the processor
      signalLost({ reason: "destroyed", message: "GPU device was lost" });
      // Flush microtasks to let the .then() callback run
      await Promise.resolve();
      await Promise.resolve();

      expect(pp.active).toBe(false);

      pp.dispose();
      rafSpy.mockRestore();
      getContextSpy.mockRestore();
      Object.defineProperty(navigator, "gpu", {
        configurable: true,
        writable: true,
        value: originalGPU,
      });
    });

    it("does not throw if device has no lost property", () => {
      const { device } = createMockGPUDevice();
      // Ensure lost is not set
      expect(() => new WebGPUPostProcessor(device as unknown as GPUDevice)).not.toThrow();
    });
  });

  describe("timestamp queries", () => {
    it("re-initialises timestamp query resources after detach + reattach", () => {
      const { device } = createMockGPUDevice();
      device.features = new Set<string>(["timestamp-query"]);

      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice, { effect: "crt" });

      const webgpuContext = {
        configure: vi.fn(),
        getCurrentTexture: vi.fn().mockReturnValue({ createView: vi.fn().mockReturnValue({}) }),
      };
      const getContextSpy = vi
        .spyOn(HTMLCanvasElement.prototype, "getContext")
        .mockImplementation((contextId: "webgpu") => {
          if (contextId === "webgpu") return webgpuContext as unknown as GPUCanvasContext;
          return null;
        });

      const originalGPU = navigator.gpu;
      Object.defineProperty(navigator, "gpu", {
        configurable: true,
        writable: true,
        value: { getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm") },
      });

      pp.attach(sourceCanvas, container);
      pp.detach();
      pp.attach(sourceCanvas, container);

      expect(device.createQuerySet).toHaveBeenCalledTimes(2);
      pp.dispose();

      getContextSpy.mockRestore();
      Object.defineProperty(navigator, "gpu", {
        configurable: true,
        writable: true,
        value: originalGPU,
      });
    });
  });

  describe("render-loop resilience", () => {
    it("skips frame safely when getCurrentTexture returns undefined", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice, { effect: "crt" });

      const webgpuContext = {
        configure: vi.fn(),
        getCurrentTexture: vi.fn().mockReturnValue(undefined),
      };
      const getContextSpy = vi
        .spyOn(HTMLCanvasElement.prototype, "getContext")
        .mockImplementation((contextId: "webgpu") => {
          if (contextId === "webgpu") return webgpuContext as unknown as GPUCanvasContext;
          return null;
        });
      const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
      const originalGPU = navigator.gpu;
      Object.defineProperty(navigator, "gpu", {
        configurable: true,
        writable: true,
        value: { getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm") },
      });

      pp.attach(sourceCanvas, container);
      expect(() => {
        (pp as unknown as { _renderFrame: () => void })._renderFrame();
      }).not.toThrow();
      expect(device.queue.submit).not.toHaveBeenCalled();

      pp.dispose();
      expect(rafSpy).toHaveBeenCalled();
      getContextSpy.mockRestore();
      Object.defineProperty(navigator, "gpu", {
        configurable: true,
        writable: true,
        value: originalGPU,
      });
    });

    it("skips frame safely when getCurrentTexture throws", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice, { effect: "crt" });

      const webgpuContext = {
        configure: vi.fn(),
        getCurrentTexture: vi.fn(() => {
          throw new Error("context-lost");
        }),
      };
      const getContextSpy = vi
        .spyOn(HTMLCanvasElement.prototype, "getContext")
        .mockImplementation((contextId: "webgpu") => {
          if (contextId === "webgpu") return webgpuContext as unknown as GPUCanvasContext;
          return null;
        });
      vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
      const originalGPU = navigator.gpu;
      Object.defineProperty(navigator, "gpu", {
        configurable: true,
        writable: true,
        value: { getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm") },
      });

      pp.attach(sourceCanvas, container);
      expect(() => {
        (pp as unknown as { _renderFrame: () => void })._renderFrame();
      }).not.toThrow();
      expect(device.queue.submit).not.toHaveBeenCalled();

      pp.dispose();
      getContextSpy.mockRestore();
      Object.defineProperty(navigator, "gpu", {
        configurable: true,
        writable: true,
        value: originalGPU,
      });
    });
  });

  describe("pipeline building (via updateConfig)", () => {
    it("creates shader modules for CRT effect", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      // Trigger pipeline build by switching from "none" to "crt"
      pp.updateConfig({ effect: "crt" });

      const calls = (device.createShaderModule as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2); // vertex + fragment

      const allCodes = calls.map((c: unknown[]) => (c[0] as { code: string }).code);
      expect(allCodes.some((c: string) => c.includes("@vertex"))).toBe(true);
      expect(allCodes.some((c: string) => c.includes("@fragment"))).toBe(true);
    });

    it("creates shader modules for sharpen effect", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      pp.updateConfig({ effect: "sharpen" });

      const calls = (device.createShaderModule as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });

    it("creates shader modules for LCD effect", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      pp.updateConfig({ effect: "lcd" });

      const calls = (device.createShaderModule as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);

      const allCodes = calls.map((c: unknown[]) => (c[0] as { code: string }).code);
      expect(allCodes.some((c: string) => c.includes("lcdShadowMask"))).toBe(true);
    });

    it("creates shader modules for bloom effect", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      pp.updateConfig({ effect: "bloom" });

      const calls = (device.createShaderModule as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);

      const allCodes = calls.map((c: unknown[]) => (c[0] as { code: string }).code);
      expect(allCodes.some((c: string) => c.includes("bloomThreshold"))).toBe(true);
    });

    it("creates a uniform buffer for CRT effect", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      pp.updateConfig({ effect: "crt" });

      expect(device.createBuffer).toHaveBeenCalled();
      const bufferCalls = (device.createBuffer as ReturnType<typeof vi.fn>).mock.calls;
      // 0x0040 = BUFFER_UNIFORM
      const hasUniform = bufferCalls.some(
        (c: unknown[]) => ((c[0] as { usage: number }).usage & 0x0040) !== 0
      );
      expect(hasUniform).toBe(true);
    });

    it("creates a uniform buffer for LCD effect", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      pp.updateConfig({ effect: "lcd" });

      const bufferCalls = (device.createBuffer as ReturnType<typeof vi.fn>).mock.calls;
      const hasUniform = bufferCalls.some(
        (c: unknown[]) => ((c[0] as { usage: number }).usage & 0x0040) !== 0
      );
      expect(hasUniform).toBe(true);
    });

    it("creates a uniform buffer for bloom effect", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      pp.updateConfig({ effect: "bloom" });

      const bufferCalls = (device.createBuffer as ReturnType<typeof vi.fn>).mock.calls;
      const hasUniform = bufferCalls.some(
        (c: unknown[]) => ((c[0] as { usage: number }).usage & 0x0040) !== 0
      );
      expect(hasUniform).toBe(true);
    });

    it("does not create a uniform buffer for none effect", () => {
      const { device } = createMockGPUDevice();
      // Constructor starts with "none" and does not build a pipeline
      new WebGPUPostProcessor(device as unknown as GPUDevice);

      const bufferCalls = (device.createBuffer as ReturnType<typeof vi.fn>).mock.calls;
      const hasUniform = bufferCalls.some(
        (c: unknown[]) => ((c[0] as { usage: number }).usage & 0x0040) !== 0
      );
      expect(hasUniform).toBe(false);
    });

    it("destroys the old uniform buffer only after the new pipeline is successfully built", () => {
      const { device, mockBuffer } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      // Build an initial CRT pipeline — this creates a uniform buffer
      pp.updateConfig({ effect: "crt" });
      const destroyCallsAfterFirstBuild = mockBuffer.destroy.mock.calls.length;

      // The old buffer must NOT be destroyed yet (no effect change has happened)
      expect(destroyCallsAfterFirstBuild).toBe(0);

      // Switch to sharpen — this triggers _rebuildPipeline():
      // the old CRT buffer should be destroyed only AFTER the new pipeline succeeds
      pp.updateConfig({ effect: "sharpen" });
      expect(mockBuffer.destroy).toHaveBeenCalled();
    });

    it("destroys the old uniform buffer even when the new pipeline build fails", () => {
      const { device, mockBuffer } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      // Build initial CRT pipeline
      pp.updateConfig({ effect: "crt" });
      expect(mockBuffer.destroy).not.toHaveBeenCalled();

      // Make the next pipeline build throw
      (device.createRenderPipeline as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error("GPU pipeline compile failed");
      });

      // Switch effect — build will fail, but the old buffer must still be released
      pp.updateConfig({ effect: "sharpen" });
      expect(mockBuffer.destroy).toHaveBeenCalled();
    });
  });

  describe("bind group caching", () => {
    it("createBindGroup is not called on every updateConfig call when only params change", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      // Build the initial CRT pipeline
      pp.updateConfig({ effect: "crt" });
      const bindGroupCallsAfterInit = (device.createBindGroup as ReturnType<typeof vi.fn>).mock.calls.length;

      // Changing parameters only should NOT trigger a new bind group
      pp.updateConfig({ scanlineIntensity: 0.3 });
      pp.updateConfig({ curvature: 0.05 });
      const bindGroupCallsAfterParamChanges = (device.createBindGroup as ReturnType<typeof vi.fn>).mock.calls.length;

      expect(bindGroupCallsAfterParamChanges).toBe(bindGroupCallsAfterInit);
    });

    it("bind group cache is invalidated when effect (pipeline) changes", () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      pp.updateConfig({ effect: "crt" });
      const beforeSwitch = (device.createBindGroup as ReturnType<typeof vi.fn>).mock.calls.length;

      // Switching effect invalidates the cache — next render will recreate it
      pp.updateConfig({ effect: "sharpen" });
      const afterSwitch = (device.createBindGroup as ReturnType<typeof vi.fn>).mock.calls.length;

      // The bind group itself is only created on the first _renderFrame call,
      // but the pipeline switch should not create one prematurely.
      expect(afterSwitch).toBe(beforeSwitch);
    });
  });
});

describe("buildEffectPipeline", () => {
  it("returns wgslSources with vertex and fragment code for CRT", () => {
    const { device } = createMockGPUDevice();
    const result = buildEffectPipeline(device as unknown as GPUDevice, "crt", "bgra8unorm");
    expect(result.wgslSources.vertex).toContain("@vertex");
    expect(result.wgslSources.fragment).toContain("@fragment");
    expect(result.wgslSources.fragment).toContain("scanlineIntensity");
  });

  it("returns wgslSources with vertex and fragment code for sharpen", () => {
    const { device } = createMockGPUDevice();
    const result = buildEffectPipeline(device as unknown as GPUDevice, "sharpen", "bgra8unorm");
    expect(result.wgslSources.vertex).toContain("@vertex");
    expect(result.wgslSources.fragment).toContain("sharpenAmount");
  });

  it("returns wgslSources with vertex and fragment code for lcd", () => {
    const { device } = createMockGPUDevice();
    const result = buildEffectPipeline(device as unknown as GPUDevice, "lcd", "bgra8unorm");
    expect(result.wgslSources.vertex).toContain("@vertex");
    expect(result.wgslSources.fragment).toContain("@fragment");
    expect(result.wgslSources.fragment).toContain("lcdShadowMask");
    expect(result.wgslSources.fragment).toContain("lcdPixelScale");
    expect(result.uniformBuffer).not.toBeNull();
  });

  it("returns wgslSources with vertex and fragment code for bloom", () => {
    const { device } = createMockGPUDevice();
    const result = buildEffectPipeline(device as unknown as GPUDevice, "bloom", "bgra8unorm");
    expect(result.wgslSources.vertex).toContain("@vertex");
    expect(result.wgslSources.fragment).toContain("@fragment");
    expect(result.wgslSources.fragment).toContain("bloomThreshold");
    expect(result.wgslSources.fragment).toContain("bloomIntensity");
    expect(result.uniformBuffer).not.toBeNull();
  });

  it("returns wgslSources for passthrough (none) effect", () => {
    const { device } = createMockGPUDevice();
    const result = buildEffectPipeline(device as unknown as GPUDevice, "none", "bgra8unorm");
    expect(result.wgslSources.vertex).toContain("@vertex");
    expect(result.wgslSources.fragment).toContain("@fragment");
    expect(result.uniformBuffer).toBeNull();
  });

  it("returns wgslSources with vertex and fragment code for fxaa", () => {
    const { device } = createMockGPUDevice();
    const result = buildEffectPipeline(device as unknown as GPUDevice, "fxaa", "bgra8unorm");
    expect(result.wgslSources.vertex).toContain("@vertex");
    expect(result.wgslSources.fragment).toContain("@fragment");
    expect(result.wgslSources.fragment).toContain("fxaaQuality");
    expect(result.wgslSources.fragment).toContain("luma");
    expect(result.uniformBuffer).not.toBeNull();
  });
});

describe("DEFAULT_POST_PROCESS_CONFIG", () => {
  it("has expected default values", () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.effect).toBe("none");
    expect(DEFAULT_POST_PROCESS_CONFIG.scanlineIntensity).toBe(0.15);
    expect(DEFAULT_POST_PROCESS_CONFIG.curvature).toBe(0.03);
    expect(DEFAULT_POST_PROCESS_CONFIG.vignetteStrength).toBe(0.2);
    expect(DEFAULT_POST_PROCESS_CONFIG.sharpenAmount).toBe(0.5);
    expect(DEFAULT_POST_PROCESS_CONFIG.lcdShadowMask).toBe(0.4);
    expect(DEFAULT_POST_PROCESS_CONFIG.lcdPixelScale).toBe(1.0);
    expect(DEFAULT_POST_PROCESS_CONFIG.bloomThreshold).toBe(0.6);
    expect(DEFAULT_POST_PROCESS_CONFIG.bloomIntensity).toBe(0.5);
    expect(DEFAULT_POST_PROCESS_CONFIG.fxaaQuality).toBe(0.75);
  });
});

describe("PostProcessConfig typing", () => {
  it("allows all valid effect values", () => {
    const configs: PostProcessConfig[] = [
      { ...DEFAULT_POST_PROCESS_CONFIG, effect: "none" },
      { ...DEFAULT_POST_PROCESS_CONFIG, effect: "crt" },
      { ...DEFAULT_POST_PROCESS_CONFIG, effect: "sharpen" },
      { ...DEFAULT_POST_PROCESS_CONFIG, effect: "lcd" },
      { ...DEFAULT_POST_PROCESS_CONFIG, effect: "bloom" },
      { ...DEFAULT_POST_PROCESS_CONFIG, effect: "fxaa" },
    ];
    expect(configs).toHaveLength(6);
  });
});

// ── adjustConfigForTier ───────────────────────────────────────────────────────

describe("adjustConfigForTier", () => {
  it("returns config unchanged for high tier", () => {
    const config = { ...DEFAULT_POST_PROCESS_CONFIG, tier: "high" as const, bloomIntensity: 0.8, curvature: 1.0 };
    const adjusted = adjustConfigForTier(config);
    expect(adjusted.bloomIntensity).toBe(0.8);
    expect(adjusted.curvature).toBe(1.0);
  });

  it("caps bloom and curvature on medium tier", () => {
    const config = { ...DEFAULT_POST_PROCESS_CONFIG, tier: "medium" as const, bloomIntensity: 0.8, curvature: 1.0 };
    const adjusted = adjustConfigForTier(config);
    expect(adjusted.bloomIntensity).toBeLessThanOrEqual(0.3);
    expect(adjusted.curvature).toBeLessThanOrEqual(0.5);
  });

  it("disables bloom and severely caps effects on low tier", () => {
    const config = { ...DEFAULT_POST_PROCESS_CONFIG, tier: "low" as const, bloomIntensity: 0.8, curvature: 1.0, scanlineIntensity: 0.8 };
    const adjusted = adjustConfigForTier(config);
    expect(adjusted.bloomIntensity).toBe(0);
    expect(adjusted.curvature).toBeLessThanOrEqual(0.2);
    expect(adjusted.scanlineIntensity).toBeLessThanOrEqual(0.3);
  });

  it("returns config unchanged when no tier is set", () => {
    const config = { ...DEFAULT_POST_PROCESS_CONFIG, bloomIntensity: 0.8 };
    const adjusted = adjustConfigForTier(config);
    expect(adjusted.bloomIntensity).toBe(0.8);
  });
});

// ── FSR 1.0 effect ────────────────────────────────────────────────────────────

describe("FSR effect", () => {
  it("DEFAULT_POST_PROCESS_CONFIG includes fsrSharpness", () => {
    expect(DEFAULT_POST_PROCESS_CONFIG).toHaveProperty('fsrSharpness');
    expect(typeof DEFAULT_POST_PROCESS_CONFIG.fsrSharpness).toBe('number');
  });

  it("fsrSharpness default is 0.25", () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.fsrSharpness).toBe(0.25);
  });

  it("adjustConfigForTier zeros fsrSharpness on low tier", () => {
    const config: PostProcessConfig = {
      ...DEFAULT_POST_PROCESS_CONFIG,
      tier: "low",
      fsrSharpness: 0.8,
    };
    const adjusted = adjustConfigForTier(config);
    expect(adjusted.fsrSharpness).toBe(0);
  });

  it("adjustConfigForTier caps fsrSharpness at 0.15 on medium tier", () => {
    const config: PostProcessConfig = {
      ...DEFAULT_POST_PROCESS_CONFIG,
      tier: "medium",
      fsrSharpness: 0.8,
    };
    const adjusted = adjustConfigForTier(config);
    expect(adjusted.fsrSharpness).toBeLessThanOrEqual(0.15);
  });

  it("adjustConfigForTier leaves fsrSharpness unchanged on high tier", () => {
    const config: PostProcessConfig = {
      ...DEFAULT_POST_PROCESS_CONFIG,
      tier: "high",
      fsrSharpness: 0.5,
    };
    const adjusted = adjustConfigForTier(config);
    expect(adjusted.fsrSharpness).toBe(0.5);
  });

  it("buildEffectPipeline succeeds for 'fsr' effect", () => {
    const { device } = createMockGPUDevice();
    expect(() => buildEffectPipeline(device as unknown as GPUDevice, "fsr", "bgra8unorm")).not.toThrow();
  });

  it("buildEffectPipeline for 'fsr' creates a uniform buffer", () => {
    const { device } = createMockGPUDevice();
    const pipeline = buildEffectPipeline(device as unknown as GPUDevice, "fsr", "bgra8unorm");
    expect(pipeline.uniformBuffer).not.toBeNull();
  });

  it("wgslSources.fragment for 'fsr' contains 'fsrSharpness'", () => {
    const { device } = createMockGPUDevice();
    const pipeline = buildEffectPipeline(device as unknown as GPUDevice, "fsr", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("fsrSharpness");
  });

  it("wgslSources.fragment for 'fsr' contains EASU function", () => {
    const { device } = createMockGPUDevice();
    const pipeline = buildEffectPipeline(device as unknown as GPUDevice, "fsr", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("easu");
  });

  it("wgslSources.fragment for 'fsr' contains RCAS function", () => {
    const { device } = createMockGPUDevice();
    const pipeline = buildEffectPipeline(device as unknown as GPUDevice, "fsr", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("rcas");
  });
});

// ── New effects: grain, retro, colorgrade ─────────────────────────────────────

describe("grain effect", () => {
  it("buildEffectPipeline succeeds for 'grain' effect", () => {
    const { device } = createMockGPUDevice();
    expect(() => buildEffectPipeline(device as unknown as GPUDevice, "grain", "bgra8unorm")).not.toThrow();
  });

  it("buildEffectPipeline for 'grain' creates a uniform buffer", () => {
    const { device } = createMockGPUDevice();
    const pipeline = buildEffectPipeline(device as unknown as GPUDevice, "grain", "bgra8unorm");
    expect(pipeline.uniformBuffer).not.toBeNull();
  });

  it("wgslSources.fragment for 'grain' contains 'grainIntensity'", () => {
    const { device } = createMockGPUDevice();
    const pipeline = buildEffectPipeline(device as unknown as GPUDevice, "grain", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("grainIntensity");
  });

  it("wgslSources.fragment for 'grain' contains 'grainSize'", () => {
    const { device } = createMockGPUDevice();
    const pipeline = buildEffectPipeline(device as unknown as GPUDevice, "grain", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("grainSize");
  });

  it("wgslSources.fragment for 'grain' contains hash function", () => {
    const { device } = createMockGPUDevice();
    const pipeline = buildEffectPipeline(device as unknown as GPUDevice, "grain", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("hash2");
  });

  it("wgslSources.fragment for 'grain' contains animated seed param", () => {
    const { device } = createMockGPUDevice();
    const pipeline = buildEffectPipeline(device as unknown as GPUDevice, "grain", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("grainSeed");
  });

  it("updateConfig accepts grain-specific parameters", () => {
    const { device } = createMockGPUDevice();
    const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
    pp.updateConfig({ effect: "grain", grainIntensity: 0.15, grainSize: 2.0 });
    expect(pp.config.effect).toBe("grain");
    expect(pp.config.grainIntensity).toBe(0.15);
    expect(pp.config.grainSize).toBe(2.0);
  });
});

describe("retro effect", () => {
  it("buildEffectPipeline succeeds for 'retro' effect", () => {
    const { device } = createMockGPUDevice();
    expect(() => buildEffectPipeline(device as unknown as GPUDevice, "retro", "bgra8unorm")).not.toThrow();
  });

  it("buildEffectPipeline for 'retro' creates a uniform buffer", () => {
    const { device } = createMockGPUDevice();
    const pipeline = buildEffectPipeline(device as unknown as GPUDevice, "retro", "bgra8unorm");
    expect(pipeline.uniformBuffer).not.toBeNull();
  });

  it("wgslSources.fragment for 'retro' contains 'retroColors'", () => {
    const { device } = createMockGPUDevice();
    const pipeline = buildEffectPipeline(device as unknown as GPUDevice, "retro", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("retroColors");
  });

  it("wgslSources.fragment for 'retro' contains Bayer dithering", () => {
    const { device } = createMockGPUDevice();
    const pipeline = buildEffectPipeline(device as unknown as GPUDevice, "retro", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("bayer4");
  });

  it("updateConfig accepts retro-specific parameters", () => {
    const { device } = createMockGPUDevice();
    const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
    pp.updateConfig({ effect: "retro", retroColors: 8 });
    expect(pp.config.effect).toBe("retro");
    expect(pp.config.retroColors).toBe(8);
  });
});

describe("colorgrade effect", () => {
  it("buildEffectPipeline succeeds for 'colorgrade' effect", () => {
    const { device } = createMockGPUDevice();
    expect(() => buildEffectPipeline(device as unknown as GPUDevice, "colorgrade", "bgra8unorm")).not.toThrow();
  });

  it("buildEffectPipeline for 'colorgrade' creates a uniform buffer", () => {
    const { device } = createMockGPUDevice();
    const pipeline = buildEffectPipeline(device as unknown as GPUDevice, "colorgrade", "bgra8unorm");
    expect(pipeline.uniformBuffer).not.toBeNull();
  });

  it("wgslSources.fragment for 'colorgrade' contains 'contrast'", () => {
    const { device } = createMockGPUDevice();
    const pipeline = buildEffectPipeline(device as unknown as GPUDevice, "colorgrade", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("contrast");
  });

  it("wgslSources.fragment for 'colorgrade' contains 'saturation'", () => {
    const { device } = createMockGPUDevice();
    const pipeline = buildEffectPipeline(device as unknown as GPUDevice, "colorgrade", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("saturation");
  });

  it("wgslSources.fragment for 'colorgrade' contains 'brightness'", () => {
    const { device } = createMockGPUDevice();
    const pipeline = buildEffectPipeline(device as unknown as GPUDevice, "colorgrade", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("brightness");
  });

  it("updateConfig accepts colorgrade-specific parameters", () => {
    const { device } = createMockGPUDevice();
    const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
    pp.updateConfig({ effect: "colorgrade", contrast: 1.2, saturation: 0.8, brightness: -0.05 });
    expect(pp.config.effect).toBe("colorgrade");
    expect(pp.config.contrast).toBe(1.2);
    expect(pp.config.saturation).toBe(0.8);
    expect(pp.config.brightness).toBe(-0.05);
  });
});

// ── EFFECT_LABELS ─────────────────────────────────────────────────────────────

describe("EFFECT_LABELS", () => {
  it("provides a label for every PostProcessEffect", () => {
    const allEffects: PostProcessEffect[] = [
      "none", "crt", "sharpen", "lcd", "bloom", "fxaa", "fsr",
      "grain", "retro", "colorgrade",
    ];
    for (const e of allEffects) {
      expect(EFFECT_LABELS[e]).toBeTruthy();
    }
  });

  it("none effect label indicates no effect", () => {
    expect(EFFECT_LABELS.none).toContain("No effect");
  });

  it("grain effect label indicates film grain", () => {
    expect(EFFECT_LABELS.grain.toLowerCase()).toContain("grain");
  });

  it("retro effect label indicates retro / pixel art", () => {
    expect(EFFECT_LABELS.retro.toLowerCase()).toMatch(/retro|pixel/);
  });

  it("colorgrade effect label indicates colour grading", () => {
    expect(EFFECT_LABELS.colorgrade.toLowerCase()).toMatch(/color|colour|grad/);
  });
});

// ── validatePostProcessConfig ─────────────────────────────────────────────────

describe("validatePostProcessConfig", () => {
  it("returns a new object (does not mutate input)", () => {
    const config = { ...DEFAULT_POST_PROCESS_CONFIG };
    const validated = validatePostProcessConfig(config);
    expect(validated).not.toBe(config);
  });

  it("preserves valid values unchanged", () => {
    const config = { ...DEFAULT_POST_PROCESS_CONFIG };
    const validated = validatePostProcessConfig(config);
    expect(validated.scanlineIntensity).toBe(config.scanlineIntensity);
    expect(validated.curvature).toBe(config.curvature);
    expect(validated.fsrSharpness).toBe(config.fsrSharpness);
    expect(validated.grainIntensity).toBe(config.grainIntensity);
    expect(validated.retroColors).toBe(config.retroColors);
    expect(validated.contrast).toBe(config.contrast);
  });

  it("clamps scanlineIntensity above 1 down to 1", () => {
    const cfg = { ...DEFAULT_POST_PROCESS_CONFIG, scanlineIntensity: 2.5 };
    expect(validatePostProcessConfig(cfg).scanlineIntensity).toBe(1);
  });

  it("clamps scanlineIntensity below 0 up to 0", () => {
    const cfg = { ...DEFAULT_POST_PROCESS_CONFIG, scanlineIntensity: -0.5 };
    expect(validatePostProcessConfig(cfg).scanlineIntensity).toBe(0);
  });

  it("clamps sharpenAmount to [0, 2]", () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, sharpenAmount: -1 }).sharpenAmount).toBe(0);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, sharpenAmount: 5 }).sharpenAmount).toBe(2);
  });

  it("clamps grainIntensity to [0, 1]", () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, grainIntensity: -0.1 }).grainIntensity).toBe(0);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, grainIntensity: 1.5 }).grainIntensity).toBe(1);
  });

  it("clamps grainSize to [0.5, 8]", () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, grainSize: 0 }).grainSize).toBe(0.5);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, grainSize: 100 }).grainSize).toBe(8);
  });

  it("clamps retroColors to [2, 256] and rounds to integer", () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, retroColors: 1 }).retroColors).toBe(2);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, retroColors: 999 }).retroColors).toBe(256);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, retroColors: 7.6 }).retroColors).toBe(8);
  });

  it("clamps contrast to [0, 4]", () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, contrast: -1 }).contrast).toBe(0);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, contrast: 10 }).contrast).toBe(4);
  });

  it("clamps saturation to [0, 4]", () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, saturation: -0.5 }).saturation).toBe(0);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, saturation: 5 }).saturation).toBe(4);
  });

  it("clamps brightness to [-1, 1]", () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, brightness: -2 }).brightness).toBe(-1);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, brightness: 2 }).brightness).toBe(1);
  });

  it("clamps lcdPixelScale minimum to 0.1", () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, lcdPixelScale: 0 }).lcdPixelScale).toBe(0.1);
  });

  it("preserves effect and tier fields", () => {
    const cfg: PostProcessConfig = { ...DEFAULT_POST_PROCESS_CONFIG, effect: "crt", tier: "medium" };
    const validated = validatePostProcessConfig(cfg);
    expect(validated.effect).toBe("crt");
    expect(validated.tier).toBe("medium");
  });
});

// ── EffectPipeline type export ────────────────────────────────────────────────

describe("EffectPipeline type", () => {
  it("buildEffectPipeline return value is assignable to EffectPipeline", () => {
    const { device } = createMockGPUDevice();
    const pipeline: EffectPipeline = buildEffectPipeline(device as unknown as GPUDevice, "crt", "bgra8unorm");
    expect(pipeline).toBeDefined();
    expect(pipeline.pipeline).toBeDefined();
    expect(pipeline.bindGroupLayout).toBeDefined();
    expect(pipeline.wgslSources).toBeDefined();
  });
});

// ── DEFAULT_POST_PROCESS_CONFIG new fields ────────────────────────────────────

describe("DEFAULT_POST_PROCESS_CONFIG new fields", () => {
  it("includes grainIntensity with value 0.08", () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.grainIntensity).toBe(0.08);
  });

  it("includes grainSize with value 1.5", () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.grainSize).toBe(1.5);
  });

  it("includes retroColors with value 16", () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.retroColors).toBe(16);
  });

  it("includes contrast with neutral value 1.0", () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.contrast).toBe(1.0);
  });

  it("includes saturation with neutral value 1.0", () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.saturation).toBe(1.0);
  });

  it("includes brightness with neutral value 0.0", () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.brightness).toBe(0.0);
  });
});

// ── hasUniforms: passthrough has no uniform buffer ────────────────────────────

describe("buildEffectPipeline uniform buffer presence", () => {
  const effectsWithUniforms: PostProcessEffect[] = [
    "crt", "sharpen", "lcd", "bloom", "fxaa", "fsr", "grain", "retro", "colorgrade",
  ];

  for (const effect of effectsWithUniforms) {
    it(`'${effect}' effect always creates a uniform buffer`, () => {
      const { device } = createMockGPUDevice();
      const pipeline = buildEffectPipeline(device as unknown as GPUDevice, effect, "bgra8unorm");
      expect(pipeline.uniformBuffer).not.toBeNull();
    });
  }

  it("'none' (passthrough) effect never creates a uniform buffer", () => {
    const { device } = createMockGPUDevice();
    const pipeline = buildEffectPipeline(device as unknown as GPUDevice, "none", "bgra8unorm");
    expect(pipeline.uniformBuffer).toBeNull();
  });
});
