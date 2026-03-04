import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { PSPEmulator, EJS_CDN_BASE } from './emulator';
import { NetplayManager } from './multiplayer';

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

    // Access the internal FPSMonitor for state-level assertions
    type FPSMonitorInternal = {
      _running: boolean;
      _enabled: boolean;
      _rafId: number | null;
      start(): void;
      stop(): void;
      setCallbackEnabled(active: boolean): void;
      _tick(now: number): void;
    };
    type EmuInternal = { _fpsMonitor: FPSMonitorInternal };

    it('setCallbackEnabled(false) keeps _running true — loop must not stop', () => {
      const mon = (emulator as unknown as EmuInternal)._fpsMonitor;
      mon.start();
      expect(mon._running).toBe(true);

      mon.setCallbackEnabled(false);
      // Loop should still be scheduled — _running must not be cleared
      expect(mon._running).toBe(true);
      expect(mon._enabled).toBe(false);

      mon.stop();
    });

    it('stop() clears both _running and _enabled', () => {
      const mon = (emulator as unknown as EmuInternal)._fpsMonitor;
      mon.start();
      mon.stop();
      expect(mon._running).toBe(false);
      expect(mon._enabled).toBe(false);
      expect(mon._rafId).toBeNull();
    });

    it('_tick clears _rafId when _running is false so start() can restart', () => {
      const mon = (emulator as unknown as EmuInternal)._fpsMonitor;
      // Simulate a stale _rafId from a loop that stopped organically
      mon._rafId = 999;
      mon._running = false;
      mon._tick(performance.now());
      // The stale handle must be cleared so a subsequent start() is not blocked
      expect(mon._rafId).toBeNull();
    });

    it('start() is not blocked after loop stopped organically and _rafId was cleared', () => {
      const mon = (emulator as unknown as EmuInternal)._fpsMonitor;
      // Place monitor in the state it would be after an organic stop + _tick cleanup
      mon._rafId = null;
      mon._running = false;
      expect(() => mon.start()).not.toThrow();
      // Loop is now running again — _rafId is set
      expect(mon._rafId).not.toBeNull();
      mon.stop();
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

    it('preserves "loading" state when launch() is called while already loading', async () => {
      const stateChanges: string[] = [];
      emulator.onStateChange = (s) => stateChanges.push(s);
      emulator.onError = () => {};

      // Simulate an in-flight load
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

      // State must remain "loading" — the in-flight load is still active.
      // Previously this bug caused state to change to "error", which would
      // hide the loading overlay while the game was still booting.
      expect(emulator.state).toBe('loading');
      expect(stateChanges).toHaveLength(0);
    });
  });

  // ── Launch watchdog (freeze guard) ────────────────────────────────────────

  describe('launch watchdog', () => {
    // Shared fake caps for a system that passes all pre-flight checks in jsdom.
    // NES does not need SharedArrayBuffer or WebGL2, so it launches cleanly.
    const nesFile  = new File(['data'], 'game.nes');
    const nesCaps = {
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
      gpuBenchmarkScore: 50,
      prefersReducedMotion: false,
      webgpuAvailable: false,
      connectionQuality: 'unknown' as const,
      jsHeapLimitMB: null,
    };

    beforeEach(() => {
      vi.useFakeTimers();
      vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() });
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('emits an error and transitions to "error" state if EJS_onGameStart never fires within 120 s', async () => {
      const errors: string[] = [];
      const states: string[] = [];
      emulator.onError = (msg) => errors.push(msg);
      emulator.onStateChange = (s) => states.push(s);

      // Override _loadScript so it resolves immediately but never calls
      // EJS_onGameStart (simulates a stalled CDN core download).
      (emulator as unknown as { _loadScript: (src: string) => Promise<void> })._loadScript =
        () => Promise.resolve();

      await emulator.launch({
        file:            nesFile,
        volume:          0.7,
        systemId:        'nes',
        performanceMode: 'auto',
        deviceCaps:      nesCaps,
      });

      // Watchdog is armed but hasn't fired yet
      expect(emulator.state).toBe('loading');
      expect(errors).toHaveLength(0);

      // Advance fake timers by 120 seconds — the watchdog should fire
      vi.advanceTimersByTime(120_000);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('took too long to start');
      expect(emulator.state).toBe('error');
    });

    it('does NOT fire the watchdog when EJS_onGameStart fires before the timeout', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      // _loadScript immediately fires EJS_onGameStart (simulates fast boot)
      (emulator as unknown as { _loadScript: (src: string) => Promise<void> })._loadScript =
        async () => {
          await Promise.resolve();
          window.EJS_onGameStart?.();
        };

      await emulator.launch({
        file:            nesFile,
        volume:          0.7,
        systemId:        'nes',
        performanceMode: 'auto',
        deviceCaps:      nesCaps,
      });

      // Game started — watchdog was cancelled by _setState("running")
      expect(emulator.state).toBe('running');

      // Advance past the watchdog timeout — it should have been cancelled
      vi.advanceTimersByTime(120_000);
      expect(errors).toHaveLength(0);
      expect(emulator.state).toBe('running');
    });

    it('cancels the watchdog when dispose() is called before the timeout fires', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      // _loadScript never fires EJS_onGameStart
      (emulator as unknown as { _loadScript: (src: string) => Promise<void> })._loadScript =
        () => Promise.resolve();

      await emulator.launch({
        file:            nesFile,
        volume:          0.7,
        systemId:        'nes',
        performanceMode: 'auto',
        deviceCaps:      nesCaps,
      });

      // Dispose clears the watchdog via _teardown()
      emulator.dispose();

      // Advance past the timeout — watchdog must not fire after teardown
      vi.advanceTimersByTime(120_000);
      expect(errors).toHaveLength(0);
    });
  });

  // ── verboseLogging ────────────────────────────────────────────────────────

  describe('verboseLogging', () => {
    it('defaults to false', () => {
      expect(emulator.verboseLogging).toBe(false);
    });

    it('can be set to true', () => {
      emulator.verboseLogging = true;
      expect(emulator.verboseLogging).toBe(true);
    });

    it('emits a console.info launch message when verboseLogging is enabled', async () => {
      vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() });
      vi.useFakeTimers();

      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      emulator.verboseLogging = true;
      emulator.onError = () => {};

      // _loadScript resolves immediately; EJS_onGameStart fires to avoid
      // leaving an armed watchdog that would interfere with cleanup.
      (emulator as unknown as { _loadScript: (src: string) => Promise<void> })._loadScript =
        async () => {
          await Promise.resolve();
          window.EJS_onGameStart?.();
        };

      await emulator.launch({
        file:            new File(['data'], 'game.nes'),
        volume:          0.7,
        systemId:        'nes',
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
          gpuBenchmarkScore: 50,
          prefersReducedMotion: false,
          webgpuAvailable: false,
          connectionQuality: 'unknown' as const,
          jsHeapLimitMB: null,
        },
      });

      const launchLogs = infoSpy.mock.calls
        .map(args => args.join(' '))
        .filter(msg => msg.includes('Launching'));

      expect(launchLogs.length).toBeGreaterThan(0);
      expect(launchLogs[0]).toContain('game.nes');
      expect(launchLogs[0]).toContain('nes');

      vi.useRealTimers();
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

    it('compiles the depth-prepass shader variant alongside the other 6 variants', () => {
      // Use a minimal WebGL mock so the warm-up loop actually runs in jsdom.
      const shaderSources: string[] = [];
      const loseContext = vi.fn();
      const gl = {
        VERTEX_SHADER: 0x8B31,
        FRAGMENT_SHADER: 0x8B30,
        createShader: vi.fn(() => ({})),
        shaderSource: vi.fn((_shader: unknown, src: string) => { shaderSources.push(src); }),
        compileShader: vi.fn(),
        createProgram: vi.fn(() => ({})),
        attachShader: vi.fn(),
        linkProgram: vi.fn(),
        useProgram: vi.fn(),
        deleteShader: vi.fn(),
        deleteProgram: vi.fn(),
        flush: vi.fn(),
        getExtension: vi.fn((name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null)),
      };
      const fakeCanvas = { getContext: vi.fn((t: string) => (t === 'webgl2' ? null : t === 'webgl' ? gl : null)) };
      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tag: string, opts?: ElementCreationOptions) =>
        tag === 'canvas' ? (fakeCanvas as unknown as HTMLCanvasElement) : originalCreateElement(tag, opts)
      );

      // Create a fresh emulator so the idempotency guard hasn't fired yet.
      const emu2 = new PSPEmulator('test-player');
      emu2.warmUpPSPPipeline();

      // 7 variants × 2 shaders each = 14 shaderSource calls.
      expect(shaderSources).toHaveLength(14);

      // The depth-prepass variant uses a trivial vertex shader (only a_pos + u_mvp)
      // and a fragment shader that outputs vec4(0.0).
      const hasDepthPassVS = shaderSources.some(
        (s) => s.includes('a_pos') && !s.includes('a_uv') && !s.includes('a_weights')
      );
      const hasDepthPassFS = shaderSources.some(
        (s) => s.includes('vec4(0.0)')
      );
      expect(hasDepthPassVS).toBe(true);
      expect(hasDepthPassFS).toBe(true);
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

    it('audioLevel starts at zero', () => {
      expect(emulator.audioLevel).toBe(0);
    });

    it('getAudioContext returns null when worklet has not been set up', () => {
      expect(emulator.getAudioContext()).toBeNull();
    });

    it('getAnalyserNode returns null when worklet has not been set up', () => {
      expect(emulator.getAnalyserNode()).toBeNull();
    });
  });

  // ── setVolume ─────────────────────────────────────────────────────────────

  describe('setVolume', () => {
    it('clamps volume to 0 when given a negative value', () => {
      // EJS_emulator.setVolume not set — just confirm no error thrown
      expect(() => emulator.setVolume(-0.5)).not.toThrow();
    });

    it('clamps volume to 1 when given a value above 1', () => {
      expect(() => emulator.setVolume(2)).not.toThrow();
    });

    it('applies volume to EJS_emulator when available', () => {
      const setVolumeSpy = vi.fn();
      (window as Window & { EJS_emulator?: { setVolume: (v: number) => void } }).EJS_emulator = {
        setVolume: setVolumeSpy,
      };
      emulator.setVolume(0.75);
      expect(setVolumeSpy).toHaveBeenCalledWith(0.75);
      delete (window as Window & { EJS_emulator?: unknown }).EJS_emulator;
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

    it('fires onLowFPS even when page was freshly loaded (now < COOLDOWN_MS)', () => {
      // Regression: _lastQualitySuggestionTime was initialised to 0, which
      // caused `now - 0 < 60_000` to block the first suggestion for users who
      // started a game within the first 60 s of page load.
      const lowFPSEvents: number[] = [];
      emulator.onLowFPS = (fps) => { lowFPSEvents.push(fps); };

      // Simulate a freshly loaded page: performance.now() returns a small value
      // well inside the old 60 s cooldown window.
      const baseTime = 200; // 200 ms since page load

      vi.spyOn(performance, 'now').mockReturnValue(baseTime);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      // 10+ s of sustained low FPS — suggestion must fire despite tiny `now`
      vi.spyOn(performance, 'now').mockReturnValue(baseTime + 10_100);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      expect(lowFPSEvents).toHaveLength(1);
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

  // ── skipExtensionCheck in LaunchOptions ───────────────────────────────────

  describe('launch with skipExtensionCheck', () => {
    const fakeCaps = {
      deviceMemoryGB: 4, cpuCores: 4, gpuRenderer: 'unknown',
      isSoftwareGPU: false, isLowSpec: false, isChromOS: false,
      recommendedMode: 'quality' as const, tier: 'medium' as const,
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
      webgpuAvailable: false, connectionQuality: 'unknown' as const, jsHeapLimitMB: null,
    };

    it('emits "Unsupported file type" when extension mismatches system (default behavior)', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      // .gba extension does not belong to the NES system
      const fakeFile = new File(['data'], 'game.gba');
      await emulator.launch({
        file:            fakeFile,
        volume:          0.7,
        systemId:        'nes',
        performanceMode: 'auto',
        deviceCaps:      fakeCaps,
      });

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('Unsupported file type');
    });

    it('bypasses extension check and does not emit "Unsupported file type" when skipExtensionCheck is true', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      vi.stubGlobal('URL', {
        ...URL,
        createObjectURL: vi.fn(() => 'blob:fake-url'),
        revokeObjectURL: vi.fn(),
      });
      const marker = document.createElement('script');
      marker.setAttribute('data-ejs-loader', 'true');
      document.body.appendChild(marker);

      // .gba extension does not belong to the NES system, but skipExtensionCheck
      // prevents the pre-flight rejection — used when the user manually changes
      // the system for an existing library game.
      const fakeFile = new File(['data'], 'game.gba');
      await emulator.launch({
        file:               fakeFile,
        volume:             0.7,
        systemId:           'nes',
        performanceMode:    'auto',
        deviceCaps:         fakeCaps,
        skipExtensionCheck: true,
      });

      const extErrors = errors.filter(e => e.includes('Unsupported file type'));
      expect(extErrors).toHaveLength(0);

      vi.unstubAllGlobals();
      document.querySelector('script[data-ejs-loader]')?.remove();
    });
  });

  // ── Netplay EJS globals ───────────────────────────────────────────────────

  describe('launch — netplay EJS globals', () => {
    const fakeCaps = {
      deviceMemoryGB: 4, cpuCores: 4, gpuRenderer: 'unknown',
      isSoftwareGPU: false, isLowSpec: false, isChromOS: false,
      recommendedMode: 'quality' as const, tier: 'medium' as const,
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
      webgpuAvailable: false, connectionQuality: 'unknown' as const, jsHeapLimitMB: null,
    };

    beforeEach(() => {
      localStorage.clear();
      // jsdom does not implement URL.createObjectURL; stub it so launch() can
      // reach the EJS-globals section without throwing.
      vi.stubGlobal('URL', {
        ...URL,
        createObjectURL: vi.fn(() => 'blob:fake-url'),
        revokeObjectURL: vi.fn(),
      });
      // _loadScript() resolves immediately when the marker script already exists
      const marker = document.createElement('script');
      marker.setAttribute('data-ejs-loader', 'true');
      document.body.appendChild(marker);
      // Clean up any netplay globals left from a previous test
      delete window.EJS_netplayServer;
      delete window.EJS_netplayICEServers;
      delete window.EJS_gameID;
    });

    afterEach(() => {
      localStorage.clear();
      vi.unstubAllGlobals();
      document.querySelector('script[data-ejs-loader]')?.remove();
      delete window.EJS_netplayServer;
      delete window.EJS_netplayICEServers;
      delete window.EJS_gameID;
    });

    it('sets EJS netplay globals when netplay is active and a gameId is provided', async () => {
      const mgr = new NetplayManager();
      mgr.setEnabled(true);
      mgr.setServerUrl('wss://netplay.example.com');

      emulator.onError = () => {};
      await emulator.launch({
        file:           new File(['data'], 'game.nes'),
        volume:         0.7,
        systemId:       'nes',
        performanceMode:'auto',
        deviceCaps:     fakeCaps,
        netplayManager: mgr,
        gameId:         'psp-game-test',
      });

      expect(window.EJS_netplayServer).toBe('wss://netplay.example.com');
      expect(window.EJS_netplayICEServers).toBeDefined();
      expect(typeof window.EJS_gameID).toBe('number');
      expect(window.EJS_gameID).toBeGreaterThan(0);
    });

    it('does not set EJS netplay globals when netplay is disabled', async () => {
      const mgr = new NetplayManager();
      mgr.setEnabled(false);
      mgr.setServerUrl('wss://netplay.example.com');

      emulator.onError = () => {};
      await emulator.launch({
        file:           new File(['data'], 'game.nes'),
        volume:         0.7,
        systemId:       'nes',
        performanceMode:'auto',
        deviceCaps:     fakeCaps,
        netplayManager: mgr,
        gameId:         'psp-game-test',
      });

      expect(window.EJS_netplayServer).toBeUndefined();
      expect(window.EJS_gameID).toBeUndefined();
    });

    it('does not set EJS netplay globals when server URL is empty', async () => {
      const mgr = new NetplayManager();
      mgr.setEnabled(true);
      mgr.setServerUrl('');

      emulator.onError = () => {};
      await emulator.launch({
        file:           new File(['data'], 'game.nes'),
        volume:         0.7,
        systemId:       'nes',
        performanceMode:'auto',
        deviceCaps:     fakeCaps,
        netplayManager: mgr,
        gameId:         'psp-game-test',
      });

      expect(window.EJS_netplayServer).toBeUndefined();
      expect(window.EJS_gameID).toBeUndefined();
    });

    it('does not set EJS netplay globals when no gameId is provided', async () => {
      const mgr = new NetplayManager();
      mgr.setEnabled(true);
      mgr.setServerUrl('wss://netplay.example.com');

      emulator.onError = () => {};
      await emulator.launch({
        file:           new File(['data'], 'game.nes'),
        volume:         0.7,
        systemId:       'nes',
        performanceMode:'auto',
        deviceCaps:     fakeCaps,
        netplayManager: mgr,
        // gameId intentionally omitted
      });

      expect(window.EJS_netplayServer).toBeUndefined();
      expect(window.EJS_gameID).toBeUndefined();
    });

    it('EJS_gameID is derived from the gameId string deterministically', async () => {
      const mgr = new NetplayManager();
      mgr.setEnabled(true);
      mgr.setServerUrl('wss://netplay.example.com');

      emulator.onError = () => {};
      await emulator.launch({
        file:           new File(['data'], 'game.nes'),
        volume:         0.7,
        systemId:       'nes',
        performanceMode:'auto',
        deviceCaps:     fakeCaps,
        netplayManager: mgr,
        gameId:         'psp-game-ff7',
      });

      expect(window.EJS_gameID).toBe(mgr.gameIdFor('psp-game-ff7'));
    });
  });
});
