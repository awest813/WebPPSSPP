import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  WebGPUPostProcessor,
  DEFAULT_POST_PROCESS_CONFIG,
  type PostProcessConfig,
} from "./webgpuPostProcess";

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
  });
});

describe("DEFAULT_POST_PROCESS_CONFIG", () => {
  it("has expected default values", () => {
    expect(DEFAULT_POST_PROCESS_CONFIG.effect).toBe("none");
    expect(DEFAULT_POST_PROCESS_CONFIG.scanlineIntensity).toBe(0.15);
    expect(DEFAULT_POST_PROCESS_CONFIG.curvature).toBe(0.03);
    expect(DEFAULT_POST_PROCESS_CONFIG.vignetteStrength).toBe(0.2);
    expect(DEFAULT_POST_PROCESS_CONFIG.sharpenAmount).toBe(0.5);
  });
});

describe("PostProcessConfig typing", () => {
  it("allows all valid effect values", () => {
    const configs: PostProcessConfig[] = [
      { ...DEFAULT_POST_PROCESS_CONFIG, effect: "none" },
      { ...DEFAULT_POST_PROCESS_CONFIG, effect: "crt" },
      { ...DEFAULT_POST_PROCESS_CONFIG, effect: "sharpen" },
    ];
    expect(configs).toHaveLength(3);
  });
});
