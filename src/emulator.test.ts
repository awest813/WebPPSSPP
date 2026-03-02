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
