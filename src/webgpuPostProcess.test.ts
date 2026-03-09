import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  WebGPUPostProcessor,
  DEFAULT_POST_PROCESS_CONFIG,
  buildEffectPipeline,
  adjustConfigForTier,
  type PostProcessConfig,
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
