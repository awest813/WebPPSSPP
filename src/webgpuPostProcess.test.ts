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
    createRenderPipelineAsync: vi.fn().mockResolvedValue({}),
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
    it("uses default config when none is provided", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
      expect(pp.config).toEqual(DEFAULT_POST_PROCESS_CONFIG);
      expect(pp.active).toBe(false);
    });

    it("accepts partial config overrides", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice, {
        effect: "crt",
        scanlineIntensity: 0.3,
      });
      expect(pp.config.effect).toBe("crt");
      expect(pp.config.scanlineIntensity).toBe(0.3);
      expect(pp.config.curvature).toBe(DEFAULT_POST_PROCESS_CONFIG.curvature);
    });

    it("exposes lastGPUFrameTimeMs getter (null before any frame)", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
      expect(pp.lastGPUFrameTimeMs).toBeNull();
    });
  });

  describe("updateConfig", () => {
    it("merges partial config updates", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
      pp.updateConfig({ effect: "sharpen", sharpenAmount: 1.0 });
      expect(pp.config.effect).toBe("sharpen");
      expect(pp.config.sharpenAmount).toBe(1.0);
    });

    it("rebuilds pipeline when effect changes (calls createRenderPipeline)", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      // First change builds a pipeline
      pp.updateConfig({ effect: "crt" }); await new Promise(r => setTimeout(r, 0));
      const firstCallCount = (device.createRenderPipelineAsync as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(firstCallCount).toBeGreaterThan(0);

      // Second change rebuilds
      pp.updateConfig({ effect: "sharpen" }); await new Promise(r => setTimeout(r, 0));
      const secondCallCount = (device.createRenderPipelineAsync as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(secondCallCount).toBeGreaterThan(firstCallCount);
    });

    it("rebuilds pipeline when switching to lcd effect", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      pp.updateConfig({ effect: "lcd" }); await new Promise(r => setTimeout(r, 0));
      const callCount = (device.createRenderPipelineAsync as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callCount).toBeGreaterThan(0);
    });

    it("rebuilds pipeline when switching to bloom effect", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      pp.updateConfig({ effect: "bloom" }); await new Promise(r => setTimeout(r, 0));
      const callCount = (device.createRenderPipelineAsync as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callCount).toBeGreaterThan(0);
    });

    it("accepts lcd-specific config parameters", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
      pp.updateConfig({ effect: "lcd", lcdShadowMask: 0.7, lcdPixelScale: 2.0 });
      expect(pp.config.effect).toBe("lcd");
      expect(pp.config.lcdShadowMask).toBe(0.7);
      expect(pp.config.lcdPixelScale).toBe(2.0);
    });

    it("accepts bloom-specific config parameters", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
      pp.updateConfig({ effect: "bloom", bloomThreshold: 0.8, bloomIntensity: 1.2 });
      expect(pp.config.effect).toBe("bloom");
      expect(pp.config.bloomThreshold).toBe(0.8);
      expect(pp.config.bloomIntensity).toBe(1.2);
    });

    it("does not rebuild pipeline when only parameters change", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      pp.updateConfig({ effect: "crt" }); await new Promise(r => setTimeout(r, 0));
      const initialCallCount = (device.createRenderPipelineAsync as ReturnType<typeof vi.fn>).mock.calls.length;

      pp.updateConfig({ scanlineIntensity: 0.5 });
      const afterCallCount = (device.createRenderPipelineAsync as ReturnType<typeof vi.fn>).mock.calls.length;

      expect(afterCallCount).toBe(initialCallCount);
    });
  });

  describe("dispose", () => {
    it("does not throw when called without attach", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
      expect(() => pp.dispose()).not.toThrow();
    });

    it("sets active to false", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
      pp.dispose();
      expect(pp.active).toBe(false);
    });
  });

  describe("attach resilience", () => {
    it("disables post-processing cleanly when WebGPU canvas configure throws", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice, { effect: "crt" });

      const webgpuContext = {
        configure: vi.fn(() => {
          throw new Error("configure failed");
        }),
        getCurrentTexture: vi.fn(),
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

      expect(() => pp.attach(sourceCanvas, container)).not.toThrow();
      expect(pp.active).toBe(false);
      expect(container.querySelector(".webgpu-postprocess-overlay")).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        "[RetroOasis] WebGPU canvas configuration failed — post-processing disabled.",
        expect.any(Error),
      );

      pp.dispose();
      getContextSpy.mockRestore();
      Object.defineProperty(navigator, "gpu", {
        configurable: true,
        writable: true,
        value: originalGPU,
      });
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
      expect(container.querySelector(".webgpu-postprocess-overlay")).toBeTruthy();

      // Simulate device loss — the handler should deactivate the processor
      signalLost({ reason: "destroyed", message: "GPU device was lost" });
      // Flush microtasks to let the .then() callback run
      await Promise.resolve();
      await Promise.resolve();

      expect(pp.active).toBe(false);
      expect(container.querySelector(".webgpu-postprocess-overlay")).toBeNull();
      expect((pp as unknown as { _canvas: HTMLCanvasElement | null })._canvas).toBeNull();
      expect((pp as unknown as { _gpuContext: GPUCanvasContext | null })._gpuContext).toBeNull();
      expect((pp as unknown as { _sourceCanvas: HTMLCanvasElement | null })._sourceCanvas).toBeNull();

      pp.dispose();
      rafSpy.mockRestore();
      getContextSpy.mockRestore();
      Object.defineProperty(navigator, "gpu", {
        configurable: true,
        writable: true,
        value: originalGPU,
      });
    });

    it("does not throw if device has no lost property", async () => {
      const { device } = createMockGPUDevice();
      // Ensure lost is not set
      expect(() => new WebGPUPostProcessor(device as unknown as GPUDevice)).not.toThrow();
    });
  });

  describe("timestamp queries", () => {
    it("re-initialises timestamp query resources after detach + reattach", async () => {
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
    it("skips frame safely when getCurrentTexture returns undefined", async () => {
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

    it("skips frame safely when getCurrentTexture throws", async () => {
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
    it("creates shader modules for CRT effect", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      // Trigger pipeline build by switching from "none" to "crt"
      pp.updateConfig({ effect: "crt" }); await new Promise(r => setTimeout(r, 0));

      const calls = (device.createShaderModule as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2); // vertex + fragment

      const allCodes = calls.map((c: unknown[]) => (c[0] as { code: string }).code);
      expect(allCodes.some((c: string) => c.includes("@vertex"))).toBe(true);
      expect(allCodes.some((c: string) => c.includes("@fragment"))).toBe(true);
    });

    it("creates shader modules for sharpen effect", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      pp.updateConfig({ effect: "sharpen" }); await new Promise(r => setTimeout(r, 0));

      const calls = (device.createShaderModule as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });

    it("creates shader modules for LCD effect", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      pp.updateConfig({ effect: "lcd" }); await new Promise(r => setTimeout(r, 0));

      const calls = (device.createShaderModule as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);

      const allCodes = calls.map((c: unknown[]) => (c[0] as { code: string }).code);
      expect(allCodes.some((c: string) => c.includes("lcdShadowMask"))).toBe(true);
    });

    it("creates shader modules for bloom effect", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      pp.updateConfig({ effect: "bloom" }); await new Promise(r => setTimeout(r, 0));

      const calls = (device.createShaderModule as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);

      const allCodes = calls.map((c: unknown[]) => (c[0] as { code: string }).code);
      expect(allCodes.some((c: string) => c.includes("bloomThreshold"))).toBe(true);
    });

    it("creates a uniform buffer for CRT effect", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      pp.updateConfig({ effect: "crt" }); await new Promise(r => setTimeout(r, 0));

      expect(device.createBuffer).toHaveBeenCalled();
      const bufferCalls = (device.createBuffer as ReturnType<typeof vi.fn>).mock.calls;
      // 0x0040 = BUFFER_UNIFORM
      const hasUniform = bufferCalls.some(
        (c: unknown[]) => ((c[0] as { usage: number }).usage & 0x0040) !== 0
      );
      expect(hasUniform).toBe(true);
    });

    it("creates a uniform buffer for LCD effect", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      pp.updateConfig({ effect: "lcd" }); await new Promise(r => setTimeout(r, 0));

      const bufferCalls = (device.createBuffer as ReturnType<typeof vi.fn>).mock.calls;
      const hasUniform = bufferCalls.some(
        (c: unknown[]) => ((c[0] as { usage: number }).usage & 0x0040) !== 0
      );
      expect(hasUniform).toBe(true);
    });

    it("creates a uniform buffer for bloom effect", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      pp.updateConfig({ effect: "bloom" }); await new Promise(r => setTimeout(r, 0));

      const bufferCalls = (device.createBuffer as ReturnType<typeof vi.fn>).mock.calls;
      const hasUniform = bufferCalls.some(
        (c: unknown[]) => ((c[0] as { usage: number }).usage & 0x0040) !== 0
      );
      expect(hasUniform).toBe(true);
    });

    it("does not create a uniform buffer for none effect", async () => {
      const { device } = createMockGPUDevice();
      // Constructor starts with "none" and does not build a pipeline
      new WebGPUPostProcessor(device as unknown as GPUDevice);

      const bufferCalls = (device.createBuffer as ReturnType<typeof vi.fn>).mock.calls;
      const hasUniform = bufferCalls.some(
        (c: unknown[]) => ((c[0] as { usage: number }).usage & 0x0040) !== 0
      );
      expect(hasUniform).toBe(false);
    });

    it("destroys the old uniform buffer only after the new pipeline is successfully built", async () => {
      const { device, mockBuffer } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      // Build an initial CRT pipeline — this creates a uniform buffer
      pp.updateConfig({ effect: "crt" }); await new Promise(r => setTimeout(r, 0));
      const destroyCallsAfterFirstBuild = mockBuffer.destroy.mock.calls.length;

      // The old buffer must NOT be destroyed yet (no effect change has happened)
      expect(destroyCallsAfterFirstBuild).toBe(0);

      // Switch to sharpen — this triggers _rebuildPipeline():
      // the old CRT buffer should be destroyed only AFTER the new pipeline succeeds
      pp.updateConfig({ effect: "sharpen" }); await new Promise(r => setTimeout(r, 0));
      expect(mockBuffer.destroy).toHaveBeenCalled();
    });

    it("destroys the old uniform buffer even when the new pipeline build fails", async () => {
      const { device, mockBuffer } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      // Build initial CRT pipeline
      pp.updateConfig({ effect: "crt" }); await new Promise(r => setTimeout(r, 0));
      expect(mockBuffer.destroy).not.toHaveBeenCalled();

      // Make the next pipeline build throw
      (device.createRenderPipelineAsync as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error("GPU pipeline compile failed");
      });

      // Switch effect — build will fail, but the old buffer must still be released
      pp.updateConfig({ effect: "sharpen" }); await new Promise(r => setTimeout(r, 0));
      expect(mockBuffer.destroy).toHaveBeenCalled();
    });
  });

  describe("bind group caching", () => {
    it("createBindGroup is not called on every updateConfig call when only params change", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      // Build the initial CRT pipeline
      pp.updateConfig({ effect: "crt" }); await new Promise(r => setTimeout(r, 0));
      const bindGroupCallsAfterInit = (device.createBindGroup as ReturnType<typeof vi.fn>).mock.calls.length;

      // Changing parameters only should NOT trigger a new bind group
      pp.updateConfig({ scanlineIntensity: 0.3 });
      pp.updateConfig({ curvature: 0.05 });
      const bindGroupCallsAfterParamChanges = (device.createBindGroup as ReturnType<typeof vi.fn>).mock.calls.length;

      expect(bindGroupCallsAfterParamChanges).toBe(bindGroupCallsAfterInit);
    });

    it("bind group cache is invalidated when effect (pipeline) changes", async () => {
      const { device } = createMockGPUDevice();
      const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

      pp.updateConfig({ effect: "crt" }); await new Promise(r => setTimeout(r, 0));
      const beforeSwitch = (device.createBindGroup as ReturnType<typeof vi.fn>).mock.calls.length;

      // Switching effect invalidates the cache — next render will recreate it
      pp.updateConfig({ effect: "sharpen" }); await new Promise(r => setTimeout(r, 0));
      const afterSwitch = (device.createBindGroup as ReturnType<typeof vi.fn>).mock.calls.length;

      // The bind group itself is only created on the first _renderFrame call,
      // but the pipeline switch should not create one prematurely.
      expect(afterSwitch).toBe(beforeSwitch);
    });
  });
});

describe("buildEffectPipeline", () => {
  it("returns wgslSources with vertex and fragment code for CRT", async () => {
    const { device } = createMockGPUDevice();
    const result = await buildEffectPipeline(device as unknown as GPUDevice, "crt", "bgra8unorm");
    expect(result.wgslSources.vertex).toContain("@vertex");
    expect(result.wgslSources.fragment).toContain("@fragment");
    expect(result.wgslSources.fragment).toContain("scanlineIntensity");
  });

  it("returns wgslSources with vertex and fragment code for sharpen", async () => {
    const { device } = createMockGPUDevice();
    const result = await buildEffectPipeline(device as unknown as GPUDevice, "sharpen", "bgra8unorm");
    expect(result.wgslSources.vertex).toContain("@vertex");
    expect(result.wgslSources.fragment).toContain("sharpenAmount");
  });

  it("returns wgslSources with vertex and fragment code for lcd", async () => {
    const { device } = createMockGPUDevice();
    const result = await buildEffectPipeline(device as unknown as GPUDevice, "lcd", "bgra8unorm");
    expect(result.wgslSources.vertex).toContain("@vertex");
    expect(result.wgslSources.fragment).toContain("@fragment");
    expect(result.wgslSources.fragment).toContain("lcdShadowMask");
    expect(result.wgslSources.fragment).toContain("lcdPixelScale");
    expect(result.uniformBuffer).not.toBeNull();
  });

  it("returns wgslSources with vertex and fragment code for bloom", async () => {
    const { device } = createMockGPUDevice();
    const result = await buildEffectPipeline(device as unknown as GPUDevice, "bloom", "bgra8unorm");
    expect(result.wgslSources.vertex).toContain("@vertex");
    expect(result.wgslSources.fragment).toContain("@fragment");
    expect(result.wgslSources.fragment).toContain("bloomThreshold");
    expect(result.wgslSources.fragment).toContain("bloomIntensity");
    expect(result.uniformBuffer).not.toBeNull();
  });

  it("returns wgslSources for passthrough (none) effect", async () => {
    const { device } = createMockGPUDevice();
    const result = await buildEffectPipeline(device as unknown as GPUDevice, "none", "bgra8unorm");
    expect(result.wgslSources.vertex).toContain("@vertex");
    expect(result.wgslSources.fragment).toContain("@fragment");
    expect(result.uniformBuffer).toBeNull();
  });

  it("returns wgslSources with vertex and fragment code for fxaa", async () => {
    const { device } = createMockGPUDevice();
    const result = await buildEffectPipeline(device as unknown as GPUDevice, "fxaa", "bgra8unorm");
    expect(result.wgslSources.vertex).toContain("@vertex");
    expect(result.wgslSources.fragment).toContain("@fragment");
    expect(result.wgslSources.fragment).toContain("fxaaQuality");
    expect(result.wgslSources.fragment).toContain("luma");
    expect(result.uniformBuffer).not.toBeNull();
  });
});

describe("DEFAULT_POST_PROCESS_CONFIG", () => {
  it("has expected default values", async () => {
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
  it("allows all valid effect values", async () => {
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
  it("returns config unchanged for high tier", async () => {
    const config = { ...DEFAULT_POST_PROCESS_CONFIG, tier: "high" as const, bloomIntensity: 0.8, curvature: 1.0 };
    const adjusted = adjustConfigForTier(config);
    expect(adjusted.bloomIntensity).toBe(0.8);
    expect(adjusted.curvature).toBe(1.0);
  });

  it("caps bloom and curvature on medium tier", async () => {
    const config = { ...DEFAULT_POST_PROCESS_CONFIG, tier: "medium" as const, bloomIntensity: 0.8, curvature: 1.0 };
    const adjusted = adjustConfigForTier(config);
    expect(adjusted.bloomIntensity).toBeLessThanOrEqual(0.3);
    expect(adjusted.curvature).toBeLessThanOrEqual(0.5);
  });

  it("disables bloom and severely caps effects on low tier", async () => {
    const config = { ...DEFAULT_POST_PROCESS_CONFIG, tier: "low" as const, bloomIntensity: 0.8, curvature: 1.0, scanlineIntensity: 0.8 };
    const adjusted = adjustConfigForTier(config);
    expect(adjusted.bloomIntensity).toBe(0);
    expect(adjusted.curvature).toBeLessThanOrEqual(0.2);
    expect(adjusted.scanlineIntensity).toBeLessThanOrEqual(0.3);
  });

  it("returns config unchanged when no tier is set", async () => {
    const config = { ...DEFAULT_POST_PROCESS_CONFIG, bloomIntensity: 0.8 };
    const adjusted = adjustConfigForTier(config);
    expect(adjusted.bloomIntensity).toBe(0.8);
  });
});

// ── FSR 1.0 effect ────────────────────────────────────────────────────────────

describe("FSR effect", () => {
  it("DEFAULT_POST_PROCESS_CONFIG includes fsrSharpness", async () => {
    expect(DEFAULT_POST_PROCESS_CONFIG).toHaveProperty('fsrSharpness');
    expect(typeof DEFAULT_POST_PROCESS_CONFIG.fsrSharpness).toBe('number');
  });

  it("fsrSharpness default is 0.25", async () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.fsrSharpness).toBe(0.25);
  });

  it("adjustConfigForTier zeros fsrSharpness on low tier", async () => {
    const config: PostProcessConfig = {
      ...DEFAULT_POST_PROCESS_CONFIG,
      tier: "low",
      fsrSharpness: 0.8,
    };
    const adjusted = adjustConfigForTier(config);
    expect(adjusted.fsrSharpness).toBe(0);
  });

  it("adjustConfigForTier caps fsrSharpness at 0.15 on medium tier", async () => {
    const config: PostProcessConfig = {
      ...DEFAULT_POST_PROCESS_CONFIG,
      tier: "medium",
      fsrSharpness: 0.8,
    };
    const adjusted = adjustConfigForTier(config);
    expect(adjusted.fsrSharpness).toBeLessThanOrEqual(0.15);
  });

  it("adjustConfigForTier leaves fsrSharpness unchanged on high tier", async () => {
    const config: PostProcessConfig = {
      ...DEFAULT_POST_PROCESS_CONFIG,
      tier: "high",
      fsrSharpness: 0.5,
    };
    const adjusted = adjustConfigForTier(config);
    expect(adjusted.fsrSharpness).toBe(0.5);
  });

  it("buildEffectPipeline succeeds for 'fsr' effect", async () => {
    const { device } = createMockGPUDevice();
    await expect(buildEffectPipeline(device as unknown as GPUDevice, "fsr", "bgra8unorm")).resolves.not.toThrow();
  });

  it("buildEffectPipeline for 'fsr' creates a uniform buffer", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "fsr", "bgra8unorm");
    expect(pipeline.uniformBuffer).not.toBeNull();
  });

  it("wgslSources.fragment for 'fsr' contains 'fsrSharpness'", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "fsr", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("fsrSharpness");
  });

  it("wgslSources.fragment for 'fsr' contains EASU function", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "fsr", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("easu");
  });

  it("wgslSources.fragment for 'fsr' contains RCAS function", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "fsr", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("rcas");
  });
});

// ── New effects: grain, retro, colorgrade ─────────────────────────────────────

describe("grain effect", () => {
  it("buildEffectPipeline succeeds for 'grain' effect", async () => {
    const { device } = createMockGPUDevice();
    await expect(buildEffectPipeline(device as unknown as GPUDevice, "grain", "bgra8unorm")).resolves.not.toThrow();
  });

  it("buildEffectPipeline for 'grain' creates a uniform buffer", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "grain", "bgra8unorm");
    expect(pipeline.uniformBuffer).not.toBeNull();
  });

  it("wgslSources.fragment for 'grain' contains 'grainIntensity'", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "grain", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("grainIntensity");
  });

  it("wgslSources.fragment for 'grain' contains 'grainSize'", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "grain", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("grainSize");
  });

  it("wgslSources.fragment for 'grain' contains hash function", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "grain", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("hash2");
  });

  it("wgslSources.fragment for 'grain' contains animated seed param", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "grain", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("grainSeed");
  });

  it("updateConfig accepts grain-specific parameters", async () => {
    const { device } = createMockGPUDevice();
    const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
    pp.updateConfig({ effect: "grain", grainIntensity: 0.15, grainSize: 2.0 });
    expect(pp.config.effect).toBe("grain");
    expect(pp.config.grainIntensity).toBe(0.15);
    expect(pp.config.grainSize).toBe(2.0);
  });
});

describe("retro effect", () => {
  it("buildEffectPipeline succeeds for 'retro' effect", async () => {
    const { device } = createMockGPUDevice();
    await expect(buildEffectPipeline(device as unknown as GPUDevice, "retro", "bgra8unorm")).resolves.not.toThrow();
  });

  it("buildEffectPipeline for 'retro' creates a uniform buffer", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "retro", "bgra8unorm");
    expect(pipeline.uniformBuffer).not.toBeNull();
  });

  it("wgslSources.fragment for 'retro' contains 'retroColors'", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "retro", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("retroColors");
  });

  it("wgslSources.fragment for 'retro' contains Bayer dithering", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "retro", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("bayer4");
  });

  it("updateConfig accepts retro-specific parameters", async () => {
    const { device } = createMockGPUDevice();
    const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
    pp.updateConfig({ effect: "retro", retroColors: 8 });
    expect(pp.config.effect).toBe("retro");
    expect(pp.config.retroColors).toBe(8);
  });
});

describe("colorgrade effect", () => {
  it("buildEffectPipeline succeeds for 'colorgrade' effect", async () => {
    const { device } = createMockGPUDevice();
    await expect(buildEffectPipeline(device as unknown as GPUDevice, "colorgrade", "bgra8unorm")).resolves.not.toThrow();
  });

  it("buildEffectPipeline for 'colorgrade' creates a uniform buffer", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "colorgrade", "bgra8unorm");
    expect(pipeline.uniformBuffer).not.toBeNull();
  });

  it("wgslSources.fragment for 'colorgrade' contains 'contrast'", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "colorgrade", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("contrast");
  });

  it("wgslSources.fragment for 'colorgrade' contains 'saturation'", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "colorgrade", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("saturation");
  });

  it("wgslSources.fragment for 'colorgrade' contains 'brightness'", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "colorgrade", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("brightness");
  });

  it("updateConfig accepts colorgrade-specific parameters", async () => {
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
  it("provides a label for every PostProcessEffect", async () => {
    const allEffects: PostProcessEffect[] = [
      "none", "crt", "sharpen", "lcd", "bloom", "fxaa", "fsr",
      "grain", "retro", "colorgrade", "taa",
      "pixelate", "ntsc", "hdr",
    ];
    for (const e of allEffects) {
      expect(EFFECT_LABELS[e]).toBeTruthy();
    }
  });

  it("none effect label indicates no effect", async () => {
    expect(EFFECT_LABELS.none).toContain("No effect");
  });

  it("grain effect label indicates film grain", async () => {
    expect(EFFECT_LABELS.grain.toLowerCase()).toContain("grain");
  });

  it("retro effect label indicates retro / pixel art", async () => {
    expect(EFFECT_LABELS.retro.toLowerCase()).toMatch(/retro|pixel/);
  });

  it("colorgrade effect label indicates colour grading", async () => {
    expect(EFFECT_LABELS.colorgrade.toLowerCase()).toMatch(/color|colour|grad/);
  });
});

// ── validatePostProcessConfig ─────────────────────────────────────────────────

describe("validatePostProcessConfig", () => {
  it("returns a new object (does not mutate input)", async () => {
    const config = { ...DEFAULT_POST_PROCESS_CONFIG };
    const validated = validatePostProcessConfig(config);
    expect(validated).not.toBe(config);
  });

  it("preserves valid values unchanged", async () => {
    const config = { ...DEFAULT_POST_PROCESS_CONFIG };
    const validated = validatePostProcessConfig(config);
    expect(validated.scanlineIntensity).toBe(config.scanlineIntensity);
    expect(validated.curvature).toBe(config.curvature);
    expect(validated.fsrSharpness).toBe(config.fsrSharpness);
    expect(validated.grainIntensity).toBe(config.grainIntensity);
    expect(validated.retroColors).toBe(config.retroColors);
    expect(validated.contrast).toBe(config.contrast);
  });

  it("clamps scanlineIntensity above 1 down to 1", async () => {
    const cfg = { ...DEFAULT_POST_PROCESS_CONFIG, scanlineIntensity: 2.5 };
    expect(validatePostProcessConfig(cfg).scanlineIntensity).toBe(1);
  });

  it("clamps scanlineIntensity below 0 up to 0", async () => {
    const cfg = { ...DEFAULT_POST_PROCESS_CONFIG, scanlineIntensity: -0.5 };
    expect(validatePostProcessConfig(cfg).scanlineIntensity).toBe(0);
  });

  it("clamps sharpenAmount to [0, 2]", async () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, sharpenAmount: -1 }).sharpenAmount).toBe(0);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, sharpenAmount: 5 }).sharpenAmount).toBe(2);
  });

  it("clamps grainIntensity to [0, 1]", async () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, grainIntensity: -0.1 }).grainIntensity).toBe(0);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, grainIntensity: 1.5 }).grainIntensity).toBe(1);
  });

  it("clamps grainSize to [0.5, 8]", async () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, grainSize: 0 }).grainSize).toBe(0.5);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, grainSize: 100 }).grainSize).toBe(8);
  });

  it("clamps retroColors to [2, 256] and rounds to integer", async () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, retroColors: 1 }).retroColors).toBe(2);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, retroColors: 999 }).retroColors).toBe(256);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, retroColors: 7.6 }).retroColors).toBe(8);
  });

  it("clamps contrast to [0, 4]", async () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, contrast: -1 }).contrast).toBe(0);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, contrast: 10 }).contrast).toBe(4);
  });

  it("clamps saturation to [0, 4]", async () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, saturation: -0.5 }).saturation).toBe(0);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, saturation: 5 }).saturation).toBe(4);
  });

  it("clamps brightness to [-1, 1]", async () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, brightness: -2 }).brightness).toBe(-1);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, brightness: 2 }).brightness).toBe(1);
  });

  it("clamps lcdPixelScale minimum to 0.1", async () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, lcdPixelScale: 0 }).lcdPixelScale).toBe(0.1);
  });

  it("preserves effect and tier fields", async () => {
    const cfg: PostProcessConfig = { ...DEFAULT_POST_PROCESS_CONFIG, effect: "crt", tier: "medium" };
    const validated = validatePostProcessConfig(cfg);
    expect(validated.effect).toBe("crt");
    expect(validated.tier).toBe("medium");
  });
});

// ── EffectPipeline type export ────────────────────────────────────────────────

describe("EffectPipeline type", () => {
  it("buildEffectPipeline return value is assignable to EffectPipeline", async () => {
    const { device } = createMockGPUDevice();
    const pipeline: EffectPipeline = await buildEffectPipeline(device as unknown as GPUDevice, "crt", "bgra8unorm");
    expect(pipeline).toBeDefined();
    expect(pipeline.pipeline).toBeDefined();
    expect(pipeline.bindGroupLayout).toBeDefined();
    expect(pipeline.wgslSources).toBeDefined();
  });
});

// ── DEFAULT_POST_PROCESS_CONFIG new fields ────────────────────────────────────

describe("DEFAULT_POST_PROCESS_CONFIG new fields", () => {
  it("includes grainIntensity with value 0.08", async () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.grainIntensity).toBe(0.08);
  });

  it("includes grainSize with value 1.5", async () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.grainSize).toBe(1.5);
  });

  it("includes retroColors with value 16", async () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.retroColors).toBe(16);
  });

  it("includes contrast with neutral value 1.0", async () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.contrast).toBe(1.0);
  });

  it("includes saturation with neutral value 1.0", async () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.saturation).toBe(1.0);
  });

  it("includes brightness with neutral value 0.0", async () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.brightness).toBe(0.0);
  });
});

// ── hasUniforms: passthrough has no uniform buffer ────────────────────────────

describe("buildEffectPipeline uniform buffer presence", () => {
  const effectsWithUniforms: PostProcessEffect[] = [
    "crt", "sharpen", "lcd", "bloom", "fxaa", "fsr", "grain", "retro", "colorgrade", "taa",
    "pixelate", "ntsc", "hdr",
  ];

  for (const effect of effectsWithUniforms) {
    it(`'${effect}' effect always creates a uniform buffer`, async () => {
      const { device } = createMockGPUDevice();
      const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, effect, "bgra8unorm");
      expect(pipeline.uniformBuffer).not.toBeNull();
    });
  }

  it("'none' (passthrough) effect never creates a uniform buffer", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "none", "bgra8unorm");
    expect(pipeline.uniformBuffer).toBeNull();
  });
});

// ── TAA effect ────────────────────────────────────────────────────────────────

describe("taa effect", () => {
  it("buildEffectPipeline succeeds for 'taa' effect", async () => {
    const { device } = createMockGPUDevice();
    await expect(buildEffectPipeline(device as unknown as GPUDevice, "taa", "bgra8unorm")).resolves.not.toThrow();
  });

  it("buildEffectPipeline for 'taa' creates a uniform buffer", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "taa", "bgra8unorm");
    expect(pipeline.uniformBuffer).not.toBeNull();
  });

  it("buildEffectPipeline for 'taa' sets requiresHistoryTexture = true", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "taa", "bgra8unorm");
    expect(pipeline.requiresHistoryTexture).toBe(true);
  });

  it("buildEffectPipeline for non-taa effects does NOT set requiresHistoryTexture", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "fsr", "bgra8unorm");
    expect(pipeline.requiresHistoryTexture).toBeFalsy();
  });

  it("wgslSources.fragment for 'taa' contains 'taaBlend'", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "taa", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("taaBlend");
  });

  it("wgslSources.fragment for 'taa' contains 'histTex' history texture binding", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "taa", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("histTex");
  });

  it("TAA bind group layout includes extra texture entry (4 entries)", async () => {
    const { device } = createMockGPUDevice();
    await buildEffectPipeline(device as unknown as GPUDevice, "taa", "bgra8unorm");
    const calls = (device.createBindGroupLayout as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastCall = calls[calls.length - 1]!;
    const entries = (lastCall[0] as { entries: unknown[] }).entries;
    // TAA: src texture (0) + sampler (1) + uniform (2) + history texture (3) = 4 entries
    expect(entries.length).toBe(4);
  });

  it("updateConfig accepts taaBlend parameter", async () => {
    const { device } = createMockGPUDevice();
    const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
    pp.updateConfig({ effect: "taa", taaBlend: 0.15 });
    expect(pp.config.effect).toBe("taa");
    expect(pp.config.taaBlend).toBe(0.15);
  });

  it("EFFECT_LABELS has a label for 'taa'", async () => {
    expect(EFFECT_LABELS.taa).toBeTruthy();
    expect(EFFECT_LABELS.taa.toLowerCase()).toContain("taa");
  });

  it("DEFAULT_POST_PROCESS_CONFIG includes taaBlend = 0.1", async () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.taaBlend).toBe(0.1);
  });

  it("adjustConfigForTier sets taaBlend = 1 on low tier (disables smoothing)", async () => {
    const cfg = { ...DEFAULT_POST_PROCESS_CONFIG, effect: "taa" as const, taaBlend: 0.1, tier: "low" as const };
    const adjusted = adjustConfigForTier(cfg);
    expect(adjusted.taaBlend).toBe(1);
  });

  it("adjustConfigForTier caps taaBlend minimum to 0.2 on medium tier", async () => {
    const cfg = { ...DEFAULT_POST_PROCESS_CONFIG, effect: "taa" as const, taaBlend: 0.05, tier: "medium" as const };
    const adjusted = adjustConfigForTier(cfg);
    expect(adjusted.taaBlend).toBeGreaterThanOrEqual(0.2);
  });

  it("adjustConfigForTier leaves taaBlend unchanged on high tier", async () => {
    const cfg = { ...DEFAULT_POST_PROCESS_CONFIG, effect: "taa" as const, taaBlend: 0.08, tier: "high" as const };
    const adjusted = adjustConfigForTier(cfg);
    expect(adjusted.taaBlend).toBe(0.08);
  });

  it("validatePostProcessConfig clamps taaBlend to [0, 1]", async () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, taaBlend: -0.5 }).taaBlend).toBe(0);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, taaBlend: 1.5 }).taaBlend).toBe(1);
  });

  it("'taa' effect always creates a uniform buffer", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "taa", "bgra8unorm");
    expect(pipeline.uniformBuffer).not.toBeNull();
  });
});

// ── New effects: pixelate, ntsc, hdr ─────────────────────────────────────────

describe("pixelate effect", () => {
  it("buildEffectPipeline succeeds for 'pixelate' effect", async () => {
    const { device } = createMockGPUDevice();
    await expect(buildEffectPipeline(device as unknown as GPUDevice, "pixelate", "bgra8unorm")).resolves.not.toThrow();
  });

  it("buildEffectPipeline for 'pixelate' creates a uniform buffer", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "pixelate", "bgra8unorm");
    expect(pipeline.uniformBuffer).not.toBeNull();
  });

  it("wgslSources.fragment for 'pixelate' contains 'pixelateSize'", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "pixelate", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("pixelateSize");
  });

  it("wgslSources.fragment for 'pixelate' snaps UV to block centre", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "pixelate", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("floor");
  });

  it("updateConfig accepts pixelateSize parameter", async () => {
    const { device } = createMockGPUDevice();
    const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
    pp.updateConfig({ effect: "pixelate", pixelateSize: 8 });
    expect(pp.config.effect).toBe("pixelate");
    expect(pp.config.pixelateSize).toBe(8);
  });

  it("EFFECT_LABELS has a label for 'pixelate'", async () => {
    expect(EFFECT_LABELS.pixelate).toBeTruthy();
    expect(EFFECT_LABELS.pixelate.toLowerCase()).toContain("pixel");
  });

  it("DEFAULT_POST_PROCESS_CONFIG includes pixelateSize = 4", async () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.pixelateSize).toBe(4);
  });

  it("validatePostProcessConfig clamps pixelateSize to [1, 32] and rounds", async () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, pixelateSize: 0 }).pixelateSize).toBe(1);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, pixelateSize: 100 }).pixelateSize).toBe(32);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, pixelateSize: 5.7 }).pixelateSize).toBe(6);
  });

  it("adjustConfigForTier enforces minimum pixelateSize of 2 on low tier", async () => {
    const cfg = { ...DEFAULT_POST_PROCESS_CONFIG, tier: "low" as const, pixelateSize: 1 };
    const adjusted = adjustConfigForTier(cfg);
    expect(adjusted.pixelateSize).toBeGreaterThanOrEqual(2);
  });

  it("'pixelate' effect always creates a uniform buffer", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "pixelate", "bgra8unorm");
    expect(pipeline.uniformBuffer).not.toBeNull();
  });
});

describe("ntsc effect", () => {
  it("buildEffectPipeline succeeds for 'ntsc' effect", async () => {
    const { device } = createMockGPUDevice();
    await expect(buildEffectPipeline(device as unknown as GPUDevice, "ntsc", "bgra8unorm")).resolves.not.toThrow();
  });

  it("buildEffectPipeline for 'ntsc' creates a uniform buffer", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "ntsc", "bgra8unorm");
    expect(pipeline.uniformBuffer).not.toBeNull();
  });

  it("wgslSources.fragment for 'ntsc' contains 'ntscArtifacts'", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "ntsc", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("ntscArtifacts");
  });

  it("wgslSources.fragment for 'ntsc' contains 'ntscSharpness'", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "ntsc", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("ntscSharpness");
  });

  it("wgslSources.fragment for 'ntsc' contains YIQ colour space conversion", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "ntsc", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("rgb2yiq");
    expect(pipeline.wgslSources.fragment).toContain("yiq2rgb");
  });

  it("wgslSources.fragment for 'ntsc' contains dot-crawl animation via grainSeed", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "ntsc", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("grainSeed");
  });

  it("updateConfig accepts ntsc-specific parameters", async () => {
    const { device } = createMockGPUDevice();
    const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
    pp.updateConfig({ effect: "ntsc", ntscArtifacts: 0.7, ntscSharpness: 0.3 });
    expect(pp.config.effect).toBe("ntsc");
    expect(pp.config.ntscArtifacts).toBe(0.7);
    expect(pp.config.ntscSharpness).toBe(0.3);
  });

  it("EFFECT_LABELS has a label for 'ntsc'", async () => {
    expect(EFFECT_LABELS.ntsc).toBeTruthy();
    expect(EFFECT_LABELS.ntsc.toLowerCase()).toContain("ntsc");
  });

  it("DEFAULT_POST_PROCESS_CONFIG includes ntscArtifacts = 0.5", async () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.ntscArtifacts).toBe(0.5);
  });

  it("DEFAULT_POST_PROCESS_CONFIG includes ntscSharpness = 0.5", async () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.ntscSharpness).toBe(0.5);
  });

  it("validatePostProcessConfig clamps ntscArtifacts to [0, 1]", async () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, ntscArtifacts: -1 }).ntscArtifacts).toBe(0);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, ntscArtifacts: 2 }).ntscArtifacts).toBe(1);
  });

  it("validatePostProcessConfig clamps ntscSharpness to [0, 1]", async () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, ntscSharpness: -0.5 }).ntscSharpness).toBe(0);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, ntscSharpness: 3 }).ntscSharpness).toBe(1);
  });

  it("adjustConfigForTier caps ntscArtifacts at 0.4 on low tier", async () => {
    const cfg = { ...DEFAULT_POST_PROCESS_CONFIG, tier: "low" as const, ntscArtifacts: 0.9 };
    expect(adjustConfigForTier(cfg).ntscArtifacts).toBeLessThanOrEqual(0.4);
  });

  it("adjustConfigForTier caps ntscArtifacts at 0.7 on medium tier", async () => {
    const cfg = { ...DEFAULT_POST_PROCESS_CONFIG, tier: "medium" as const, ntscArtifacts: 1.0 };
    expect(adjustConfigForTier(cfg).ntscArtifacts).toBeLessThanOrEqual(0.7);
  });
});

describe("hdr effect", () => {
  it("buildEffectPipeline succeeds for 'hdr' effect", async () => {
    const { device } = createMockGPUDevice();
    await expect(buildEffectPipeline(device as unknown as GPUDevice, "hdr", "bgra8unorm")).resolves.not.toThrow();
  });

  it("buildEffectPipeline for 'hdr' creates a uniform buffer", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "hdr", "bgra8unorm");
    expect(pipeline.uniformBuffer).not.toBeNull();
  });

  it("wgslSources.fragment for 'hdr' contains 'hdrExposure'", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "hdr", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("hdrExposure");
  });

  it("wgslSources.fragment for 'hdr' contains 'hdrWhitePoint'", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "hdr", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("hdrWhitePoint");
  });

  it("wgslSources.fragment for 'hdr' contains Reinhard tone mapping function", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "hdr", "bgra8unorm");
    expect(pipeline.wgslSources.fragment).toContain("reinhardExtended");
  });

  it("wgslSources.fragment for 'hdr' applies sRGB gamma encoding", async () => {
    const { device } = createMockGPUDevice();
    const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, "hdr", "bgra8unorm");
    // The shader uses pow() for sRGB gamma approximation
    expect(pipeline.wgslSources.fragment).toContain("pow");
  });

  it("updateConfig accepts hdr-specific parameters", async () => {
    const { device } = createMockGPUDevice();
    const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
    pp.updateConfig({ effect: "hdr", hdrExposure: 1.5, hdrWhitePoint: 2.0 });
    expect(pp.config.effect).toBe("hdr");
    expect(pp.config.hdrExposure).toBe(1.5);
    expect(pp.config.hdrWhitePoint).toBe(2.0);
  });

  it("EFFECT_LABELS has a label for 'hdr'", async () => {
    expect(EFFECT_LABELS.hdr).toBeTruthy();
    expect(EFFECT_LABELS.hdr.toLowerCase()).toContain("hdr");
  });

  it("DEFAULT_POST_PROCESS_CONFIG includes hdrExposure = 1.0", async () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.hdrExposure).toBe(1.0);
  });

  it("DEFAULT_POST_PROCESS_CONFIG includes hdrWhitePoint = 1.0", async () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.hdrWhitePoint).toBe(1.0);
  });

  it("validatePostProcessConfig clamps hdrExposure to [0.1, 8]", async () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, hdrExposure: 0 }).hdrExposure).toBe(0.1);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, hdrExposure: 100 }).hdrExposure).toBe(8);
  });

  it("validatePostProcessConfig clamps hdrWhitePoint to [0.1, 8]", async () => {
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, hdrWhitePoint: -1 }).hdrWhitePoint).toBe(0.1);
    expect(validatePostProcessConfig({ ...DEFAULT_POST_PROCESS_CONFIG, hdrWhitePoint: 20 }).hdrWhitePoint).toBe(8);
  });
});

// ── pixelPerfect sampler mode ─────────────────────────────────────────────────

describe("pixelPerfect mode", () => {
  it("DEFAULT_POST_PROCESS_CONFIG has pixelPerfect = false", async () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.pixelPerfect).toBe(false);
  });

  it("updateConfig accepts pixelPerfect toggle", async () => {
    const { device } = createMockGPUDevice();
    const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
    pp.updateConfig({ pixelPerfect: true });
    expect(pp.config.pixelPerfect).toBe(true);
    pp.updateConfig({ pixelPerfect: false });
    expect(pp.config.pixelPerfect).toBe(false);
  });

  it("invalidates bind group cache when pixelPerfect changes", async () => {
    const { device } = createMockGPUDevice();
    const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

    pp.updateConfig({ effect: "crt" }); await new Promise(r => setTimeout(r, 0));

    // Initial bind group creation count
    const callsBefore = (device.createBindGroup as ReturnType<typeof vi.fn>).mock.calls.length;

    // Toggling pixelPerfect should NOT itself call createBindGroup (only invalidates cache)
    pp.updateConfig({ pixelPerfect: true });
    const callsAfterToggle = (device.createBindGroup as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterToggle).toBe(callsBefore); // Bind group is only created on next render
  });

  it("attach() creates both linear and nearest-neighbour samplers", async () => {
    const { device } = createMockGPUDevice();
    const pp = new WebGPUPostProcessor(device as unknown as GPUDevice, { effect: "crt" });

    const testContainer = document.createElement("div");
    document.body.appendChild(testContainer);
    const testCanvas = document.createElement("canvas");
    testCanvas.width = 640;
    testCanvas.height = 480;
    testContainer.appendChild(testCanvas);

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
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const originalGPU = navigator.gpu;
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      writable: true,
      value: { getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm") },
    });

    pp.attach(testCanvas, testContainer);

    // Both bilinear and nearest samplers should be created
    const samplerCalls = (device.createSampler as ReturnType<typeof vi.fn>).mock.calls;
    expect(samplerCalls.length).toBeGreaterThanOrEqual(2);
    const filters = samplerCalls.map((c: unknown[]) => (c[0] as { magFilter?: string }).magFilter);
    expect(filters).toContain("linear");
    expect(filters).toContain("nearest");

    pp.dispose();
    testContainer.remove();
    getContextSpy.mockRestore();
    Object.defineProperty(navigator, "gpu", { configurable: true, writable: true, value: originalGPU });
  });

  it("validatePostProcessConfig preserves pixelPerfect boolean", async () => {
    const cfg = { ...DEFAULT_POST_PROCESS_CONFIG, pixelPerfect: true };
    expect(validatePostProcessConfig(cfg).pixelPerfect).toBe(true);
    const cfg2 = { ...DEFAULT_POST_PROCESS_CONFIG, pixelPerfect: false };
    expect(validatePostProcessConfig(cfg2).pixelPerfect).toBe(false);
  });
});

// ── onDeviceLost callback ─────────────────────────────────────────────────────

describe("onDeviceLost callback", () => {
  it("fires onDeviceLost when the GPU device is lost", async () => {
    let signalLost!: (info: { reason: string; message: string }) => void;
    const lostPromise = new Promise<{ reason: string; message: string }>(
      (resolve) => { signalLost = resolve; }
    );

    const { device } = createMockGPUDevice();
    (device as unknown as Record<string, unknown>).lost = lostPromise;

    const pp = new WebGPUPostProcessor(device as unknown as GPUDevice, { effect: "crt" });
    const onDeviceLostSpy = vi.fn();
    pp.onDeviceLost = onDeviceLostSpy;

    const testContainer = document.createElement("div");
    document.body.appendChild(testContainer);
    const testCanvas = document.createElement("canvas");
    testCanvas.width = 640;
    testCanvas.height = 480;
    testContainer.appendChild(testCanvas);

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
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const originalGPU = navigator.gpu;
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      writable: true,
      value: { getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm") },
    });

    pp.attach(testCanvas, testContainer);
    expect(pp.active).toBe(true);

    signalLost({ reason: "destroyed", message: "test device loss" });
    await Promise.resolve();
    await Promise.resolve();

    expect(onDeviceLostSpy).toHaveBeenCalledOnce();
    expect(pp.active).toBe(false);
    expect(testContainer.querySelector(".webgpu-postprocess-overlay")).toBeNull();

    pp.dispose();
    testContainer.remove();
    getContextSpy.mockRestore();
    Object.defineProperty(navigator, "gpu", { configurable: true, writable: true, value: originalGPU });
  });

  it("does not fire onDeviceLost when device is already inactive at loss time", async () => {
    let signalLost!: (info: { reason: string; message: string }) => void;
    const lostPromise = new Promise<{ reason: string; message: string }>(
      (resolve) => { signalLost = resolve; }
    );

    const { device } = createMockGPUDevice();
    (device as unknown as Record<string, unknown>).lost = lostPromise;

    const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
    const onDeviceLostSpy = vi.fn();
    pp.onDeviceLost = onDeviceLostSpy;

    // Never attached — _active is false
    signalLost({ reason: "destroyed", message: "inactive processor" });
    await Promise.resolve();
    await Promise.resolve();

    expect(onDeviceLostSpy).not.toHaveBeenCalled();
  });
});

// ── TAA bind group cache (history texture invalidation) ───────────────────────

describe("TAA bind group cache with history texture", () => {
  it("bind group cache key includes history texture — does not use stale cache on TAA resize", async () => {
    const { device } = createMockGPUDevice();
    const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);

    // Force invalidation of bind group cache
    const ppAny = pp as unknown as {
      _invalidateBindGroupCache: () => void;
      _cachedBindGroupHistoryTexture: GPUTexture | null;
      _cachedBindGroup: GPUBindGroup | null;
    };

    pp.updateConfig({ effect: "taa" }); await new Promise(r => setTimeout(r, 0));

    // _cachedBindGroupHistoryTexture should start as null (no render frame run yet)
    expect(ppAny._cachedBindGroupHistoryTexture).toBeNull();

    // After explicit invalidation, both caches should be cleared
    ppAny._invalidateBindGroupCache();
    expect(ppAny._cachedBindGroup).toBeNull();
    expect(ppAny._cachedBindGroupHistoryTexture).toBeNull();
  });

  it("invalidates bind group when pixelPerfect toggles (cache key includes sampler)", async () => {
    const { device } = createMockGPUDevice();
    const pp = new WebGPUPostProcessor(device as unknown as GPUDevice);
    const ppAny = pp as unknown as {
      _cachedBindGroup: GPUBindGroup | null;
      _invalidateBindGroupCache: () => void;
    };

    pp.updateConfig({ effect: "crt" }); await new Promise(r => setTimeout(r, 0));

    // Simulate a cached bind group
    ppAny._cachedBindGroup = {} as unknown as GPUBindGroup;

    // Toggling pixelPerfect should invalidate the cache
    pp.updateConfig({ pixelPerfect: true });
    expect(ppAny._cachedBindGroup).toBeNull();
  });
});

// ── EFFECT_LABELS completeness (including new effects) ────────────────────────

describe("EFFECT_LABELS completeness", () => {
  it("provides labels for all 14 effects including pixelate, ntsc, hdr", async () => {
    const allEffects: PostProcessEffect[] = [
      "none", "crt", "sharpen", "lcd", "bloom", "fxaa", "fsr",
      "grain", "retro", "colorgrade", "taa",
      "pixelate", "ntsc", "hdr",
    ];
    for (const e of allEffects) {
      expect(EFFECT_LABELS[e], `Missing label for effect: ${e}`).toBeTruthy();
    }
  });
});

// ── buildEffectPipeline uniform buffer (all effects incl. new ones) ───────────

describe("buildEffectPipeline uniform buffer presence (new effects)", () => {
  const newEffects: PostProcessEffect[] = ["pixelate", "ntsc", "hdr"];

  for (const effect of newEffects) {
    it(`'${effect}' effect creates a uniform buffer`, async () => {
      const { device } = createMockGPUDevice();
      const pipeline = await buildEffectPipeline(device as unknown as GPUDevice, effect, "bgra8unorm");
      expect(pipeline.uniformBuffer).not.toBeNull();
    });
  }
});
