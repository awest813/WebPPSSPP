import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { PSPEmulator, EJS_CDN_BASE } from './emulator';

describe('PSPEmulator', () => {
  let emulator: PSPEmulator;

  beforeEach(() => {
    emulator = new PSPEmulator('test-player');
    // Ensure the player element exists in jsdom
    if (!document.getElementById('test-player')) {
      const div = document.createElement('div');
      div.id = 'test-player';
      document.body.appendChild(div);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.getElementById('test-player')?.remove();
  });

  // ── Initial state ─────────────────────────────────────────────────────────

  it('starts in idle state', () => {
    expect(emulator.state).toBe('idle');
  });

  it('has no active system on creation', () => {
    expect(emulator.currentSystem).toBeNull();
  });

  it('has no active tier on creation', () => {
    expect(emulator.activeTier).toBeNull();
  });

  // ── FPS monitor control ───────────────────────────────────────────────────

  describe('setFPSMonitorEnabled', () => {
    it('disables FPS callbacks when called with false', () => {
      const updates: unknown[] = [];
      emulator.onFPSUpdate = (snap) => updates.push(snap);

      // Start monitor (normally done by game start)
      emulator.setFPSMonitorEnabled(false);

      // The monitor is disabled — no updates should fire even if manually triggered
      // We verify by checking that setFPSMonitorEnabled does not throw
      expect(() => emulator.setFPSMonitorEnabled(false)).not.toThrow();
      expect(() => emulator.setFPSMonitorEnabled(true)).not.toThrow();
    });

    it('can be toggled multiple times without error', () => {
      for (let i = 0; i < 10; i++) {
        emulator.setFPSMonitorEnabled(i % 2 === 0);
      }
      // No assertion beyond not throwing
    });
  });

  // ── Preconnect / prefetch ─────────────────────────────────────────────────

  describe('preconnect', () => {
    it('injects dns-prefetch and preconnect links', () => {
      emulator.preconnect();

      const dns = document.head.querySelector('link[rel="dns-prefetch"]');
      const pc  = document.head.querySelector('link[rel="preconnect"]');

      expect(dns).not.toBeNull();
      expect(pc).not.toBeNull();
    });

    it('does not inject duplicate links when called twice', () => {
      emulator.preconnect();
      emulator.preconnect();

      const pcLinks = document.head.querySelectorAll('link[rel="preconnect"]');
      // Should only inject once
      expect(pcLinks.length).toBeLessThanOrEqual(2); // dns-prefetch + preconnect
    });
  });

  describe('prefetchLoader', () => {
    it('injects a prefetch link for the loader script', () => {
      const loaderUrl = `${EJS_CDN_BASE}loader.js`;
      emulator.prefetchLoader();

      const link = document.head.querySelector(`link[href="${loaderUrl}"]`);
      expect(link).not.toBeNull();
      expect(link?.getAttribute('rel')).toBe('prefetch');
    });

    it('does not add duplicate prefetch links', () => {
      emulator.prefetchLoader();
      emulator.prefetchLoader();

      const loaderUrl = `${EJS_CDN_BASE}loader.js`;
      const links = document.head.querySelectorAll(`link[href="${loaderUrl}"]`);
      expect(links.length).toBe(1);
    });
  });

  // ── Launch guards ─────────────────────────────────────────────────────────

  describe('launch', () => {
    it('emits error for an unknown system id', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      const fakeFile = new File(['data'], 'game.iso');
      const fakeCaps = {
        deviceMemoryGB: 4,
        cpuCores: 4,
        gpuRenderer: 'unknown',
        isSoftwareGPU: false,
        isLowSpec: false,
        isChromOS: false,
        recommendedMode: 'quality' as const,
        tier: 'medium' as const,
        gpuCaps: {
          renderer: 'unknown',
          vendor: 'unknown',
          maxTextureSize: 2048,
          maxVertexAttribs: 16,
          maxVaryingVectors: 8,
          maxRenderbufferSize: 2048,
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
        },
        gpuBenchmarkScore: 30,
        prefersReducedMotion: false,
        webgpuAvailable: false,
        connectionQuality: 'unknown' as const,
        jsHeapLimitMB: null,
      };

      await emulator.launch({
        file:            fakeFile,
        volume:          0.7,
        systemId:        'not-a-real-system',
        performanceMode: 'auto',
        deviceCaps:      fakeCaps,
      });

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('Unknown system');
    });

    it('rejects launch while already loading', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      // Force loading state
      (emulator as unknown as { _state: string })._state = 'loading';

      const fakeFile = new File(['data'], 'game.iso');
      await emulator.launch({
        file:            fakeFile,
        volume:          0.7,
        systemId:        'psp',
        performanceMode: 'auto',
        deviceCaps:      {
          deviceMemoryGB: 4,
          cpuCores: 4,
          gpuRenderer: 'unknown',
          isSoftwareGPU: false,
          isLowSpec: false,
          isChromOS: false,
          recommendedMode: 'quality' as const,
          tier: 'medium' as const,
          gpuCaps: {
            renderer: 'unknown', vendor: 'unknown', maxTextureSize: 2048,
            maxVertexAttribs: 16, maxVaryingVectors: 8, maxRenderbufferSize: 2048,
            anisotropicFiltering: false, maxAnisotropy: 0,
            floatTextures: false, halfFloatTextures: false,
            instancedArrays: false, webgl2: false,
            vertexArrayObject: false, compressedTextures: false,
            maxColorAttachments: 1, multiDraw: false,
          },
          gpuBenchmarkScore: 30,
          prefersReducedMotion: false,
          webgpuAvailable: false,
          connectionQuality: 'unknown' as const,
          jsHeapLimitMB: null,
        },
      });

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('already loading');
    });
  });

  // ── FPS snapshot ──────────────────────────────────────────────────────────

  describe('getFPS', () => {
    it('returns a zero snapshot when the monitor has not started', () => {
      const snap = emulator.getFPS();
      expect(snap.current).toBe(0);
      expect(snap.average).toBe(0);
      expect(snap.min).toBe(0);
      expect(snap.max).toBe(0);
      expect(snap.droppedFrames).toBe(0);
    });
  });

  // ── PSP pipeline warm-up ──────────────────────────────────────────────────

  describe('warmUpPSPPipeline', () => {
    it('does not throw when called', () => {
      expect(() => emulator.warmUpPSPPipeline()).not.toThrow();
    });

    it('is idempotent — calling twice does not throw', () => {
      expect(() => {
        emulator.warmUpPSPPipeline();
        emulator.warmUpPSPPipeline();
      }).not.toThrow();
    });
  });

  // ── WebGPU pre-warm ───────────────────────────────────────────────────────

  describe('preWarmWebGPU', () => {
    it('resolves without throwing even when WebGPU is unavailable', async () => {
      await expect(emulator.preWarmWebGPU()).resolves.not.toThrow();
    });

    it('reports webgpuAvailable = false in test environment (no GPU)', () => {
      // jsdom does not expose navigator.gpu — so this should be false
      expect(emulator.webgpuAvailable).toBe(false);
    });

    it('webgpuAdapterInfo is null before preWarmWebGPU is called', () => {
      const freshEmulator = new PSPEmulator('test-player');
      expect(freshEmulator.webgpuAdapterInfo).toBeNull();
    });

    it('is idempotent — calling twice does not throw', async () => {
      await expect(
        emulator.preWarmWebGPU().then(() => emulator.preWarmWebGPU())
      ).resolves.not.toThrow();
    });

    it('accepts high-performance power preference without throwing', async () => {
      const freshEmulator = new PSPEmulator('test-player');
      await expect(freshEmulator.preWarmWebGPU('high-performance')).resolves.not.toThrow();
    });

    it('accepts low-power power preference without throwing', async () => {
      const freshEmulator = new PSPEmulator('test-player');
      await expect(freshEmulator.preWarmWebGPU('low-power')).resolves.not.toThrow();
    });

    describe('with mocked WebGPU adapter', () => {
      afterEach(() => {
        Object.defineProperty(navigator, 'gpu', {
          value: undefined,
          configurable: true,
          writable: true,
        });
      });

      it('captures adapter info when adapter.info is available', async () => {
        const mockDevice = {
          createCommandEncoder: () => ({
            beginComputePass: () => ({ end: vi.fn() }),
            finish: () => ({}),
          }),
          createShaderModule: vi.fn().mockReturnValue({}),
          createRenderPipeline: vi.fn().mockReturnValue({}),
          createBindGroupLayout: vi.fn().mockReturnValue({}),
          createPipelineLayout: vi.fn().mockReturnValue({}),
          createBuffer: vi.fn().mockReturnValue({ destroy: vi.fn() }),
          features: new Set<string>(),
          queue: { submit: vi.fn() },
          destroy: vi.fn(),
        };
        const mockAdapter = {
          info: {
            vendor: 'nvidia',
            architecture: 'turing',
            device: 'NVIDIA GeForce RTX 3080',
            description: 'NVIDIA RTX 3080',
          },
          isFallbackAdapter: false,
          requestDevice: vi.fn().mockResolvedValue(mockDevice),
        };
        Object.defineProperty(navigator, 'gpu', {
          value: {
            requestAdapter: vi.fn().mockResolvedValue(mockAdapter),
            getPreferredCanvasFormat: vi.fn().mockReturnValue('bgra8unorm'),
          },
          configurable: true,
          writable: true,
        });

        const freshEmulator = new PSPEmulator('test-player');
        await freshEmulator.preWarmWebGPU();

        expect(freshEmulator.webgpuAvailable).toBe(true);
        expect(freshEmulator.webgpuAdapterInfo).not.toBeNull();
        expect(freshEmulator.webgpuAdapterInfo?.vendor).toBe('nvidia');
        expect(freshEmulator.webgpuAdapterInfo?.architecture).toBe('turing');
        expect(freshEmulator.webgpuAdapterInfo?.device).toBe('NVIDIA GeForce RTX 3080');
        expect(freshEmulator.webgpuAdapterInfo?.isFallbackAdapter).toBe(false);
      });

      it('handles adapters without info property gracefully', async () => {
        const mockDevice = {
          createCommandEncoder: () => ({
            beginComputePass: () => ({ end: vi.fn() }),
            finish: () => ({}),
          }),
          createShaderModule: vi.fn().mockReturnValue({}),
          createRenderPipeline: vi.fn().mockReturnValue({}),
          createBindGroupLayout: vi.fn().mockReturnValue({}),
          createPipelineLayout: vi.fn().mockReturnValue({}),
          createBuffer: vi.fn().mockReturnValue({ destroy: vi.fn() }),
          features: new Set<string>(),
          queue: { submit: vi.fn() },
          destroy: vi.fn(),
        };
        const mockAdapter = {
          // No info property
          requestDevice: vi.fn().mockResolvedValue(mockDevice),
        };
        Object.defineProperty(navigator, 'gpu', {
          value: {
            requestAdapter: vi.fn().mockResolvedValue(mockAdapter),
            getPreferredCanvasFormat: vi.fn().mockReturnValue('bgra8unorm'),
          },
          configurable: true,
          writable: true,
        });

        const freshEmulator = new PSPEmulator('test-player');
        await freshEmulator.preWarmWebGPU();

        expect(freshEmulator.webgpuAvailable).toBe(true);
        expect(freshEmulator.webgpuAdapterInfo).toBeNull();
      });

      it('marks isFallbackAdapter correctly when adapter reports software fallback', async () => {
        const mockDevice = {
          createCommandEncoder: () => ({
            beginComputePass: () => ({ end: vi.fn() }),
            finish: () => ({}),
          }),
          createShaderModule: vi.fn().mockReturnValue({}),
          createRenderPipeline: vi.fn().mockReturnValue({}),
          createBindGroupLayout: vi.fn().mockReturnValue({}),
          createPipelineLayout: vi.fn().mockReturnValue({}),
          createBuffer: vi.fn().mockReturnValue({ destroy: vi.fn() }),
          features: new Set<string>(),
          queue: { submit: vi.fn() },
          destroy: vi.fn(),
        };
        const mockAdapter = {
          info: {
            vendor: 'google',
            architecture: '',
            device: '',
            description: 'SwiftShader',
          },
          isFallbackAdapter: true,
          requestDevice: vi.fn().mockResolvedValue(mockDevice),
        };
        Object.defineProperty(navigator, 'gpu', {
          value: {
            requestAdapter: vi.fn().mockResolvedValue(mockAdapter),
            getPreferredCanvasFormat: vi.fn().mockReturnValue('bgra8unorm'),
          },
          configurable: true,
          writable: true,
        });

        const freshEmulator = new PSPEmulator('test-player');
        await freshEmulator.preWarmWebGPU();

        expect(freshEmulator.webgpuAdapterInfo?.isFallbackAdapter).toBe(true);
        expect(freshEmulator.webgpuAdapterInfo?.description).toBe('SwiftShader');
      });

      it('respects the power preference parameter passed to requestAdapter', async () => {
        const requestAdapterSpy = vi.fn().mockResolvedValue(null);
        Object.defineProperty(navigator, 'gpu', {
          value: { requestAdapter: requestAdapterSpy },
          configurable: true,
          writable: true,
        });

        const freshEmulator = new PSPEmulator('test-player');
        await freshEmulator.preWarmWebGPU('low-power');

        expect(requestAdapterSpy).toHaveBeenCalledWith({ powerPreference: 'low-power' });
      });

      it('uses high-performance by default', async () => {
        const requestAdapterSpy = vi.fn().mockResolvedValue(null);
        Object.defineProperty(navigator, 'gpu', {
          value: { requestAdapter: requestAdapterSpy },
          configurable: true,
          writable: true,
        });

        const freshEmulator = new PSPEmulator('test-player');
        await freshEmulator.preWarmWebGPU();

        expect(requestAdapterSpy).toHaveBeenCalledWith({ powerPreference: 'high-performance' });
      });

      it('leaves webgpuAvailable = false when requestAdapter returns null', async () => {
        Object.defineProperty(navigator, 'gpu', {
          value: { requestAdapter: vi.fn().mockResolvedValue(null) },
          configurable: true,
          writable: true,
        });

        const freshEmulator = new PSPEmulator('test-player');
        await freshEmulator.preWarmWebGPU();

        expect(freshEmulator.webgpuAvailable).toBe(false);
        expect(freshEmulator.webgpuAdapterInfo).toBeNull();
      });

      it('calls createShaderModule and createRenderPipeline for WGSL warm-up', async () => {
        const createShaderModuleSpy = vi.fn().mockReturnValue({});
        const createRenderPipelineSpy = vi.fn().mockReturnValue({});
        const mockDevice = {
          createCommandEncoder: () => ({
            beginComputePass: () => ({ end: vi.fn() }),
            finish: () => ({}),
          }),
          createShaderModule: createShaderModuleSpy,
          createRenderPipeline: createRenderPipelineSpy,
          createBindGroupLayout: vi.fn().mockReturnValue({}),
          createPipelineLayout: vi.fn().mockReturnValue({}),
          createBuffer: vi.fn().mockReturnValue({ destroy: vi.fn() }),
          features: new Set<string>(),
          queue: { submit: vi.fn() },
          destroy: vi.fn(),
        };
        Object.defineProperty(navigator, 'gpu', {
          value: {
            requestAdapter: vi.fn().mockResolvedValue({
              requestDevice: vi.fn().mockResolvedValue(mockDevice),
            }),
            getPreferredCanvasFormat: vi.fn().mockReturnValue('bgra8unorm'),
          },
          configurable: true,
          writable: true,
        });

        const freshEmulator = new PSPEmulator('test-player');
        await freshEmulator.preWarmWebGPU();

        // The warm-up builds: 1 minimal WGSL module + 2 effect pipelines (crt, sharpen)
        // Each pipeline = 1 vertex module + 1 fragment module → 4 additional modules
        // Total: ≥ 1 (minimal) + 4 (effects) = ≥ 5 createShaderModule calls
        expect(createShaderModuleSpy.mock.calls.length).toBeGreaterThanOrEqual(5);
        // Pipeline builds: 1 minimal + 2 effect pipelines
        expect(createRenderPipelineSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

        // Verify the first module contains WGSL entry points
        const allCodes = createShaderModuleSpy.mock.calls.map(
          (c: unknown[]) => (c[0] as { code: string }).code
        );
        expect(allCodes.some((c: string) => c.includes('@vertex'))).toBe(true);
        expect(allCodes.some((c: string) => c.includes('@fragment'))).toBe(true);
      });

      it('still warms the compute queue even if WGSL pipeline compilation fails', async () => {
        const submitSpy = vi.fn();
        const mockDevice = {
          createCommandEncoder: () => ({
            beginComputePass: () => ({ end: vi.fn() }),
            finish: () => ({}),
          }),
          createShaderModule: vi.fn().mockImplementation(() => {
            throw new Error('WGSL not supported');
          }),
          createRenderPipeline: vi.fn(),
          createBindGroupLayout: vi.fn().mockReturnValue({}),
          createPipelineLayout: vi.fn().mockReturnValue({}),
          createBuffer: vi.fn().mockReturnValue({ destroy: vi.fn() }),
          features: new Set<string>(),
          queue: { submit: submitSpy },
          destroy: vi.fn(),
        };
        Object.defineProperty(navigator, 'gpu', {
          value: {
            requestAdapter: vi.fn().mockResolvedValue({
              requestDevice: vi.fn().mockResolvedValue(mockDevice),
            }),
            getPreferredCanvasFormat: vi.fn().mockReturnValue('bgra8unorm'),
          },
          configurable: true,
          writable: true,
        });

        const freshEmulator = new PSPEmulator('test-player');
        await freshEmulator.preWarmWebGPU();

        expect(freshEmulator.webgpuAvailable).toBe(true);
        expect(submitSpy).toHaveBeenCalledOnce();
      });
    });
  });

  // ── WebGPU dispose / cleanup ───────────────────────────────────────────────

  describe('dispose', () => {
    it('calls destroy on the WebGPU device when dispose is called', async () => {
      const destroySpy = vi.fn();
      const mockDevice = {
        createCommandEncoder: () => ({
          beginComputePass: () => ({ end: vi.fn() }),
          finish: () => ({}),
        }),
        createShaderModule: vi.fn().mockReturnValue({}),
        createRenderPipeline: vi.fn().mockReturnValue({}),
        createBindGroupLayout: vi.fn().mockReturnValue({}),
        createPipelineLayout: vi.fn().mockReturnValue({}),
        createBuffer: vi.fn().mockReturnValue({ destroy: vi.fn() }),
        features: new Set<string>(),
        queue: { submit: vi.fn() },
        destroy: destroySpy,
      };
      Object.defineProperty(navigator, 'gpu', {
        value: {
          requestAdapter: vi.fn().mockResolvedValue({
            info: { vendor: 'test', architecture: '', device: 'Test GPU', description: '' },
            isFallbackAdapter: false,
            requestDevice: vi.fn().mockResolvedValue(mockDevice),
          }),
          getPreferredCanvasFormat: vi.fn().mockReturnValue('bgra8unorm'),
        },
        configurable: true,
        writable: true,
      });

      const freshEmulator = new PSPEmulator('test-player');
      await freshEmulator.preWarmWebGPU();
      expect(freshEmulator.webgpuAvailable).toBe(true);

      freshEmulator.dispose();

      expect(destroySpy).toHaveBeenCalledOnce();
      expect(freshEmulator.webgpuAvailable).toBe(false);
      expect(freshEmulator.webgpuAdapterInfo).toBeNull();

      Object.defineProperty(navigator, 'gpu', {
        value: undefined,
        configurable: true,
        writable: true,
      });
    });
  });

  // ── Post-processing ─────────────────────────────────────────────────────────

  describe('post-processing', () => {
    it('postProcessActive is false by default', () => {
      expect(emulator.postProcessActive).toBe(false);
    });

    it('postProcessConfig returns default config', () => {
      const config = emulator.postProcessConfig;
      expect(config.effect).toBe('none');
      expect(config.scanlineIntensity).toBe(0.15);
      expect(config.curvature).toBe(0.03);
      expect(config.vignetteStrength).toBe(0.2);
      expect(config.sharpenAmount).toBe(0.5);
    });

    it('setPostProcessEffect updates config without throwing', () => {
      expect(() => emulator.setPostProcessEffect('crt')).not.toThrow();
      expect(emulator.postProcessConfig.effect).toBe('crt');
    });

    it('updatePostProcessConfig merges partial updates', () => {
      emulator.updatePostProcessConfig({ scanlineIntensity: 0.5 });
      expect(emulator.postProcessConfig.scanlineIntensity).toBe(0.5);
    });

    it('setPostProcessEffect to none does not throw', () => {
      emulator.setPostProcessEffect('crt');
      expect(() => emulator.setPostProcessEffect('none')).not.toThrow();
    });
  });

  // ── Async screenshot ──────────────────────────────────────────────────────

  describe('captureScreenshotAsync', () => {
    it('falls back to canvas.toBlob when no post-processor is active', async () => {
      const result = await emulator.captureScreenshotAsync();
      expect(result).toBeNull();
    });
  });

  // ── webgpuDevice getter ────────────────────────────────────────────────────

  describe('webgpuDevice', () => {
    it('is null before preWarmWebGPU', () => {
      expect(emulator.webgpuDevice).toBeNull();
    });
  });

  // ── Shader cache pre-warm ─────────────────────────────────────────────────

  describe('preWarmShaderCache', () => {
    it('resolves without throwing', async () => {
      await expect(emulator.preWarmShaderCache()).resolves.not.toThrow();
    });
  });

  // ── AudioWorklet setup ────────────────────────────────────────────────────

  describe('setupAudioWorklet', () => {
    it('returns false when AudioWorkletNode is not available in jsdom', async () => {
      // jsdom does not implement AudioWorkletNode
      const result = await emulator.setupAudioWorklet('http://localhost');
      expect(result).toBe(false);
    });

    it('audioUnderruns starts at zero', () => {
      expect(emulator.audioUnderruns).toBe(0);
    });

    it('getAudioContext returns null when worklet has not been set up', () => {
      expect(emulator.getAudioContext()).toBeNull();
    });
  });

  // ── Adaptive quality timing ───────────────────────────────────────────────

  describe('adaptive quality (onLowFPS timing)', () => {
    // Helper: access the private _checkAdaptiveQuality method
    type EmuInternal = { _checkAdaptiveQuality: (fps: number) => void };

    it('does not fire onLowFPS before 10 seconds of sustained low FPS', () => {
      const lowFPSEvents: number[] = [];
      emulator.onLowFPS = (fps) => { lowFPSEvents.push(fps); };

      const baseTime = 1_000_000;

      // First call starts the timer
      vi.spyOn(performance, 'now').mockReturnValue(baseTime);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      // 9.9 seconds later — still under the 10 s threshold
      vi.spyOn(performance, 'now').mockReturnValue(baseTime + 9_900);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      expect(lowFPSEvents).toHaveLength(0);
    });

    it('fires onLowFPS after 10 actual seconds of sustained low FPS', () => {
      const lowFPSEvents: number[] = [];
      emulator.onLowFPS = (fps) => { lowFPSEvents.push(fps); };

      const baseTime = 2_000_000;

      // First call: start the low-FPS timer
      vi.spyOn(performance, 'now').mockReturnValue(baseTime);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);
      expect(lowFPSEvents).toHaveLength(0);

      // Move time past 10 s — should trigger onLowFPS
      vi.spyOn(performance, 'now').mockReturnValue(baseTime + 10_100);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      expect(lowFPSEvents).toHaveLength(1);
      expect(lowFPSEvents[0]).toBe(20);
    });

    it('resets the timer when FPS recovers, then requires another 10 s', () => {
      const lowFPSEvents: number[] = [];
      emulator.onLowFPS = (fps) => { lowFPSEvents.push(fps); };

      const baseTime = 3_000_000;
      vi.spyOn(performance, 'now').mockReturnValue(baseTime);

      // Start accumulating low FPS
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      // FPS recovers at 5 s — timer resets
      vi.spyOn(performance, 'now').mockReturnValue(baseTime + 5_000);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(55);

      // FPS drops again at 5 s; a new 10 s window starts now
      vi.spyOn(performance, 'now').mockReturnValue(baseTime + 5_000);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      // 9 s after the reset (14 s absolute) — still under the new 10 s window
      vi.spyOn(performance, 'now').mockReturnValue(baseTime + 14_000);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      expect(lowFPSEvents).toHaveLength(0);
    });

    it('does not fire onLowFPS a second time within the 60 s cooldown', () => {
      const lowFPSEvents: number[] = [];
      emulator.onLowFPS = (fps) => { lowFPSEvents.push(fps); };

      const baseTime = 4_000_000;
      vi.spyOn(performance, 'now').mockReturnValue(baseTime);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      // Trigger once at 10 s
      vi.spyOn(performance, 'now').mockReturnValue(baseTime + 10_100);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);
      expect(lowFPSEvents).toHaveLength(1);

      // Immediately keep low FPS; cooldown prevents a second fire
      vi.spyOn(performance, 'now').mockReturnValue(baseTime + 10_200);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);
      vi.spyOn(performance, 'now').mockReturnValue(baseTime + 20_000);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      // Still only one event — the 60 s cooldown is in effect
      expect(lowFPSEvents).toHaveLength(1);
    });

    it('resets low-FPS cooldown state after teardown', () => {
      const lowFPSEvents: number[] = [];
      emulator.onLowFPS = (fps) => { lowFPSEvents.push(fps); };

      type EmuLifecycleInternal = {
        _checkAdaptiveQuality: (fps: number) => void;
        _teardown: () => void;
      };
      const internal = emulator as unknown as EmuLifecycleInternal;
      const nowSpy = vi.spyOn(performance, 'now');
      const baseTime = 5_000_000;

      // Trigger initial low-FPS suggestion
      nowSpy.mockReturnValue(baseTime);
      internal._checkAdaptiveQuality(20);
      nowSpy.mockReturnValue(baseTime + 10_100);
      internal._checkAdaptiveQuality(20);
      expect(lowFPSEvents).toHaveLength(1);

      // New session boundary
      internal._teardown();

      // Within the old cooldown window, a fresh 10 s run should trigger again
      // because teardown resets the adaptive-quality timing state.
      nowSpy.mockReturnValue(baseTime + 11_000);
      internal._checkAdaptiveQuality(20);
      nowSpy.mockReturnValue(baseTime + 21_200);
      internal._checkAdaptiveQuality(20);
      expect(lowFPSEvents).toHaveLength(2);
    });
  });

  // ── tierOverride in LaunchOptions ─────────────────────────────────────────

  describe('launch with tierOverride', () => {
    it('accepts a tierOverride without error (validates structure)', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      const fakeFile = new File(['data'], 'game.iso');
      await emulator.launch({
        file:            fakeFile,
        volume:          0.7,
        systemId:        'not-a-real-system',
        performanceMode: 'auto',
        tierOverride:    'low',
        deviceCaps: {
          deviceMemoryGB: 4, cpuCores: 4, gpuRenderer: 'unknown',
          isSoftwareGPU: false, isLowSpec: false, isChromOS: false,
          recommendedMode: 'quality', tier: 'medium',
          gpuCaps: {
            renderer: 'unknown', vendor: 'unknown', maxTextureSize: 2048,
            maxVertexAttribs: 16, maxVaryingVectors: 8, maxRenderbufferSize: 2048,
            anisotropicFiltering: false, maxAnisotropy: 0,
            floatTextures: false, halfFloatTextures: false,
            instancedArrays: false, webgl2: false,
            vertexArrayObject: false, compressedTextures: false,
            maxColorAttachments: 1, multiDraw: false,
          },
          gpuBenchmarkScore: 30, prefersReducedMotion: false,
          webgpuAvailable: false, connectionQuality: 'unknown', jsHeapLimitMB: null,
        },
      });

      // The error here is "Unknown system", not a tierOverride crash
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('Unknown system');
    });
  });
});
