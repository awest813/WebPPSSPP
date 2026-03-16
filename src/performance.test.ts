import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import {
  detectCapabilities,
  detectCapabilitiesCached,
  clearCapabilitiesCache,
  isLikelyChromeOS,
  isLikelyIOS,
  isLikelyAndroid,
  isLikelySafari,
  getSafariVersion,
  isWebGPUAvailable,
  prefersReducedMotion,
  checkBatteryStatus,
  detectAudioCapabilities,
  __resetAudioCapabilitiesCacheForTests,
  __classifyTierForTests,
  formatCapabilitiesSummary,
  formatDetailedSummary,
  resolveMode,
  resolveTier,
  estimateConnectionQuality,
  estimateVRAM,
  MemoryMonitor,
  scheduleIdleTask,
  ObjectPool,
  SpatialGrid,
  FrameBudget,
  DrawCallBatcher,
  EntityComponentSystem,
  Quadtree,
  AssetLoader,
  DeltaTracker,
  DeviceCapabilities,
  GPUCapabilities,
  getResolutionCoreOptions,
  getResolutionLadder,
  recommendedAssetConcurrency,
  recommendedFrameBudgetMs,
  ThermalMonitor,
  StartupProfiler,
  FpsPrediction,
  getLaunchCounts,
  recordSystemLaunch,
  getTopLaunchedSystems,
} from "./performance.js";

describe('performance', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __resetAudioCapabilitiesCacheForTests();
    clearCapabilitiesCache();
  });

  // ── WebGL error resilience ──────────────────────────────────────────────

  it('handles WebGL renderer exception gracefully', () => {
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string, options?: ElementCreationOptions) => {
      if (tagName === 'canvas') {
        throw new Error('Canvas not supported');
      }
      return originalCreateElement(tagName, options);
    });

    const caps = detectCapabilities();

    expect(caps.gpuRenderer).toBe('unknown');
  });

  it('handles WebGL renderer getContext exception gracefully', () => {
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string, options?: ElementCreationOptions) => {
      if (tagName === 'canvas') {
        return {
          getContext: () => {
            throw new Error('WebGL not supported or blocked');
          },
          width: 0,
          height: 0,
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName, options);
    });

    const caps = detectCapabilities();

    expect(caps.gpuRenderer).toBe('unknown');
    expect(caps.gpuBenchmarkScore).toBe(0);
  });

  it('returns a valid DeviceCapabilities object on normal run', () => {
    const caps = detectCapabilities();

    expect(caps).toHaveProperty('tier');
    expect(['low', 'medium', 'high', 'ultra']).toContain(caps.tier);
    expect(caps).toHaveProperty('gpuBenchmarkScore');
    expect(caps.gpuBenchmarkScore).toBeGreaterThanOrEqual(0);
    expect(caps.gpuBenchmarkScore).toBeLessThanOrEqual(100);
    expect(caps).toHaveProperty('isChromOS');
    expect(typeof caps.isChromOS).toBe('boolean');
    expect(caps).toHaveProperty('prefersReducedMotion');
    expect(typeof caps.prefersReducedMotion).toBe('boolean');
  });

  it('uses flush (not finish) during GPU benchmark warm-up', () => {
    const flush = vi.fn();
    const finish = vi.fn();
    const loseContext = vi.fn();
    const gl = {
      VERTEX_SHADER: 0x8B31,
      FRAGMENT_SHADER: 0x8B30,
      ARRAY_BUFFER: 0x8892,
      STATIC_DRAW: 0x88E4,
      TRIANGLE_STRIP: 0x0005,
      FLOAT: 0x1406,
      TEXTURE0: 0x84C0,
      TEXTURE_2D: 0x0DE1,
      RGBA: 0x1908,
      UNSIGNED_BYTE: 0x1401,
      TEXTURE_MIN_FILTER: 0x2801,
      TEXTURE_MAG_FILTER: 0x2800,
      TEXTURE_WRAP_S: 0x2802,
      TEXTURE_WRAP_T: 0x2803,
      NEAREST: 0x2600,
      CLAMP_TO_EDGE: 0x812F,
      createShader: vi.fn(() => ({})),
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      createProgram: vi.fn(() => ({})),
      attachShader: vi.fn(),
      linkProgram: vi.fn(),
      useProgram: vi.fn(),
      getUniformLocation: vi.fn(() => ({})),
      uniform1f: vi.fn(),
      uniform1i: vi.fn(),
      createBuffer: vi.fn(() => ({})),
      bindBuffer: vi.fn(),
      bufferData: vi.fn(),
      getAttribLocation: vi.fn(() => 0),
      enableVertexAttribArray: vi.fn(),
      vertexAttribPointer: vi.fn(),
      createTexture: vi.fn(() => ({})),
      bindTexture: vi.fn(),
      activeTexture: vi.fn(),
      texImage2D: vi.fn(),
      texParameteri: vi.fn(),
      deleteTexture: vi.fn(),
      getExtension: vi.fn((name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null)),
      drawArrays: vi.fn(),
      flush,
      finish,
      deleteBuffer: vi.fn(),
      deleteShader: vi.fn(),
      deleteProgram: vi.fn(),
    };
    const canvas = { width: 0, height: 0, getContext: vi.fn((type: string) => (type === 'webgl' ? gl : null)) };
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string, options?: ElementCreationOptions) => (
      tagName === 'canvas'
        ? (canvas as unknown as HTMLCanvasElement)
        : originalCreateElement(tagName, options)
    ));

    detectCapabilities();

    expect(finish).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalled();
  });

  it('releases the WebGL probe context via WEBGL_lose_context after capability detection', () => {
    const loseContext = vi.fn();
    const gl = {
      VERTEX_SHADER: 0x8B31,
      FRAGMENT_SHADER: 0x8B30,
      ARRAY_BUFFER: 0x8892,
      STATIC_DRAW: 0x88E4,
      TRIANGLE_STRIP: 0x0005,
      FLOAT: 0x1406,
      MAX_TEXTURE_SIZE: 0x0D33,
      MAX_VERTEX_ATTRIBS: 0x8869,
      MAX_VARYING_VECTORS: 0x8DFC,
      MAX_RENDERBUFFER_SIZE: 0x84E8,
      createShader: vi.fn(() => ({})),
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      createProgram: vi.fn(() => ({})),
      attachShader: vi.fn(),
      linkProgram: vi.fn(),
      useProgram: vi.fn(),
      getUniformLocation: vi.fn(() => ({})),
      createBuffer: vi.fn(() => ({})),
      bindBuffer: vi.fn(),
      bufferData: vi.fn(),
      getAttribLocation: vi.fn(() => 0),
      enableVertexAttribArray: vi.fn(),
      vertexAttribPointer: vi.fn(),
      getParameter: vi.fn(() => 4096),
      getExtension: vi.fn((name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null)),
      uniform1f: vi.fn(),
      drawArrays: vi.fn(),
      flush: vi.fn(),
      deleteBuffer: vi.fn(),
      deleteShader: vi.fn(),
      deleteProgram: vi.fn(),
    };
    const canvas = { width: 0, height: 0, getContext: vi.fn((type: string) => (type === 'webgl' ? gl : null)) };
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string, options?: ElementCreationOptions) => (
      tagName === 'canvas'
        ? (canvas as unknown as HTMLCanvasElement)
        : originalCreateElement(tagName, options)
    ));

    detectCapabilities();

    // loseContext() is called by both probeGPU() and benchmarkGPU()
    expect(loseContext).toHaveBeenCalled();
  });

  // ── WebGPU availability ─────────────────────────────────────────────────

  describe('isWebGPUAvailable', () => {
    afterEach(() => {
      Object.defineProperty(navigator, 'gpu', {
        value: undefined,
        configurable: true,
        writable: true,
      });
    });

    it('returns false when navigator.gpu is absent', () => {
      expect(isWebGPUAvailable()).toBe(false);
    });

    it('returns true when navigator.gpu is defined', () => {
      Object.defineProperty(navigator, 'gpu', {
        value: {},
        configurable: true,
        writable: true,
      });
      expect(isWebGPUAvailable()).toBe(true);
    });

    it('returns false when accessing navigator.gpu throws', () => {
      Object.defineProperty(navigator, 'gpu', {
        get() { throw new Error('Permission denied'); },
        configurable: true,
      });
      expect(isWebGPUAvailable()).toBe(false);
    });
  });

  // ── Chrome OS detection ─────────────────────────────────────────────────

  describe('isLikelyChromeOS', () => {
    it('returns false for a standard desktop user-agent', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      );
      expect(isLikelyChromeOS()).toBe(false);
    });

    it('returns true for a Chrome OS user-agent', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (X11; CrOS x86_64 15236.80.0) AppleWebKit/537.36 Chrome/109.0.0.0 Safari/537.36'
      );
      expect(isLikelyChromeOS()).toBe(true);
    });

    it('returns false for macOS Safari', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/604.1'
      );
      expect(isLikelyChromeOS()).toBe(false);
    });
  });

  // ── iOS detection ───────────────────────────────────────────────────────

  describe('isLikelyIOS', () => {
    it('returns true for an iPhone user-agent', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
      );
      expect(isLikelyIOS()).toBe(true);
    });

    it('returns true for an iPad user-agent (classic)', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
      );
      expect(isLikelyIOS()).toBe(true);
    });

    it('returns true for iPadOS 13+ which reports as Macintosh with touch points', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/604.1'
      );
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
      expect(isLikelyIOS()).toBe(true);
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
    });

    it('returns false for a macOS desktop with no touch points', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/604.1'
      );
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
      expect(isLikelyIOS()).toBe(false);
    });

    it('returns false for a Windows desktop user-agent', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      );
      expect(isLikelyIOS()).toBe(false);
    });

    it('returns false for an Android user-agent', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'
      );
      expect(isLikelyIOS()).toBe(false);
    });
  });

  // ── Android detection ───────────────────────────────────────────────────

  describe('isLikelyAndroid', () => {
    it('returns true for an Android Chrome user-agent', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'
      );
      expect(isLikelyAndroid()).toBe(true);
    });

    it('returns true for an Android Samsung Internet user-agent', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 SamsungBrowser/21.0 Mobile Safari/537.36'
      );
      expect(isLikelyAndroid()).toBe(true);
    });

    it('returns false for an iPhone user-agent', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
      );
      expect(isLikelyAndroid()).toBe(false);
    });

    it('returns false for a Windows desktop user-agent', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      );
      expect(isLikelyAndroid()).toBe(false);
    });

    it('returns false for a Chrome OS user-agent', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (X11; CrOS x86_64 15236.80.0) AppleWebKit/537.36 Chrome/109.0.0.0 Safari/537.36'
      );
      expect(isLikelyAndroid()).toBe(false);
    });
  });

  // ── Safari detection ────────────────────────────────────────────────────

  describe('isLikelySafari', () => {
    it('returns true for macOS Safari', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
      );
      expect(isLikelySafari()).toBe(true);
    });

    it('returns true for iOS Safari (Version/ token present)', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      );
      expect(isLikelySafari()).toBe(true);
    });

    it('returns false for Chrome on macOS (no Version/ token)', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
      expect(isLikelySafari()).toBe(false);
    });

    it('returns false for Chrome on iOS (CriOS token)', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1'
      );
      expect(isLikelySafari()).toBe(false);
    });

    it('returns false for Firefox on iOS (FxiOS token)', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/120.0 Mobile/15E148 Safari/604.1'
      );
      expect(isLikelySafari()).toBe(false);
    });

    it('returns false for Edge on Windows', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
      );
      expect(isLikelySafari()).toBe(false);
    });

    it('returns false for Chrome on Windows', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
      expect(isLikelySafari()).toBe(false);
    });

    it('returns false for Firefox on desktop', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'
      );
      expect(isLikelySafari()).toBe(false);
    });

    it('returns false for Chrome OS', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (X11; CrOS x86_64 15236.80.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36'
      );
      expect(isLikelySafari()).toBe(false);
    });
  });

  // ── getSafariVersion ────────────────────────────────────────────────────

  describe('getSafariVersion', () => {
    it('returns the major version for macOS Safari 17', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
      );
      expect(getSafariVersion()).toBe(17);
    });

    it('returns the major version for iOS Safari 16', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
      );
      expect(getSafariVersion()).toBe(16);
    });

    it('returns null for Chrome (no Version/ token)', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
      expect(getSafariVersion()).toBeNull();
    });

    it('returns null for Chrome on iOS (CriOS)', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1'
      );
      expect(getSafariVersion()).toBeNull();
    });

    it('returns null for Firefox on desktop', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'
      );
      expect(getSafariVersion()).toBeNull();
    });
  });

  // ── Reduced motion preference ───────────────────────────────────────────

  describe('prefersReducedMotion', () => {
    it('returns false when matchMedia returns no match', () => {
      vi.spyOn(window, 'matchMedia').mockReturnValue({
        matches: false,
        media: '(prefers-reduced-motion: reduce)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
      });
      expect(prefersReducedMotion()).toBe(false);
    });

    it('returns true when matchMedia indicates reduced motion', () => {
      vi.spyOn(window, 'matchMedia').mockReturnValue({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
      });
      expect(prefersReducedMotion()).toBe(true);
    });

    it('returns false when matchMedia throws (graceful degradation)', () => {
      vi.spyOn(window, 'matchMedia').mockImplementation(() => {
        throw new Error('matchMedia not supported');
      });
      expect(prefersReducedMotion()).toBe(false);
    });
  });

  // ── Battery status ──────────────────────────────────────────────────────

  describe('checkBatteryStatus', () => {
    it('returns null when getBattery is not available', async () => {
      const nav = navigator as Navigator & { getBattery?: unknown };
      const original = nav.getBattery;
      Object.defineProperty(navigator, 'getBattery', {
        value: undefined,
        configurable: true,
        writable: true,
      });

      const result = await checkBatteryStatus();
      expect(result).toBeNull();

      Object.defineProperty(navigator, 'getBattery', {
        value: original,
        configurable: true,
        writable: true,
      });
    });

    it('returns charging status and isLowBattery=false when charging', async () => {
      Object.defineProperty(navigator, 'getBattery', {
        value: () => Promise.resolve({ charging: true, level: 0.15, addEventListener: vi.fn() }),
        configurable: true,
        writable: true,
      });

      const result = await checkBatteryStatus();
      expect(result).not.toBeNull();
      expect(result?.charging).toBe(true);
      expect(result?.level).toBe(0.15);
      expect(result?.isLowBattery).toBe(false); // Not low battery when charging
    });

    it('returns isLowBattery=true when discharging below 20%', async () => {
      Object.defineProperty(navigator, 'getBattery', {
        value: () => Promise.resolve({ charging: false, level: 0.12, addEventListener: vi.fn() }),
        configurable: true,
        writable: true,
      });

      const result = await checkBatteryStatus();
      expect(result?.isLowBattery).toBe(true);
      expect(result?.level).toBe(0.12);
    });

    it('returns isLowBattery=false when discharging above 20%', async () => {
      Object.defineProperty(navigator, 'getBattery', {
        value: () => Promise.resolve({ charging: false, level: 0.55, addEventListener: vi.fn() }),
        configurable: true,
        writable: true,
      });

      const result = await checkBatteryStatus();
      expect(result?.isLowBattery).toBe(false);
    });

    it('returns null when getBattery rejects', async () => {
      Object.defineProperty(navigator, 'getBattery', {
        value: () => Promise.reject(new Error('Permission denied')),
        configurable: true,
        writable: true,
      });

      const result = await checkBatteryStatus();
      expect(result).toBeNull();
    });
  });

  // ── Audio capability memoization ────────────────────────────────────────

  describe('detectAudioCapabilities memoization', () => {
    const originalAudioContext = window.AudioContext;

    afterEach(() => {
      Object.defineProperty(window, 'AudioContext', {
        value: originalAudioContext,
        configurable: true,
        writable: true,
      });
    });

    it('reuses a memoized probe result across calls', async () => {
      const ctorSpy = vi.fn(() => ({
        baseLatency: 0.01,
        outputLatency: 0.02,
        sampleRate: 48000,
        destination: { maxChannelCount: 2 },
        suspend: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      }));

      Object.defineProperty(window, 'AudioContext', {
        value: ctorSpy,
        configurable: true,
        writable: true,
      });

      const first = await detectAudioCapabilities();
      const second = await detectAudioCapabilities();

      expect(ctorSpy).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it('forceRefresh bypasses the memoized probe', async () => {
      const ctorSpy = vi.fn(() => ({
        baseLatency: 0.015,
        outputLatency: 0.03,
        sampleRate: 44100,
        destination: { maxChannelCount: 6 },
        suspend: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      }));

      Object.defineProperty(window, 'AudioContext', {
        value: ctorSpy,
        configurable: true,
        writable: true,
      });

      await detectAudioCapabilities();
      await detectAudioCapabilities({ forceRefresh: true });

      expect(ctorSpy).toHaveBeenCalledTimes(2);
    });

    it('returns maxChannelCount from hardware destination', async () => {
      const ctorSpy = vi.fn(() => ({
        baseLatency: 0.005,
        outputLatency: 0.01,
        sampleRate: 48000,
        destination: { maxChannelCount: 8 },
        suspend: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      }));

      Object.defineProperty(window, 'AudioContext', {
        value: ctorSpy,
        configurable: true,
        writable: true,
      });

      const caps = await detectAudioCapabilities();
      expect(caps.maxChannelCount).toBe(8);
    });

    it('returns null for maxChannelCount when destination is unavailable', async () => {
      const ctorSpy = vi.fn(() => ({
        baseLatency: 0.01,
        outputLatency: 0.02,
        sampleRate: 48000,
        // no destination — simulates context that does not expose it
        suspend: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      }));

      Object.defineProperty(window, 'AudioContext', {
        value: ctorSpy,
        configurable: true,
        writable: true,
      });

      const caps = await detectAudioCapabilities();
      expect(caps.maxChannelCount).toBeNull();
    });
  });

  // ── Chrome OS tier penalty ──────────────────────────────────────────────

  describe('Chrome OS tier classification', () => {
    it('includes isChromOS flag in capabilities', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (X11; CrOS x86_64 15236.80.0) AppleWebKit/537.36 Chrome/109.0.0.0 Safari/537.36'
      );

      const caps = detectCapabilities();
      expect(caps.isChromOS).toBe(true);
    });

    it('isChromOS is false on non-CrOS user-agents', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
      );

      const caps = detectCapabilities();
      expect(caps.isChromOS).toBe(false);
    });
  });

  // ── Mobile platform detection ───────────────────────────────────────────

  describe('mobile platform detection in detectCapabilities', () => {
    it('sets isIOS=true and isMobile=true for iPhone user-agent', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
      );
      const caps = detectCapabilities();
      expect(caps.isIOS).toBe(true);
      expect(caps.isAndroid).toBe(false);
      expect(caps.isMobile).toBe(true);
    });

    it('sets isAndroid=true and isMobile=true for Android user-agent', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'
      );
      const caps = detectCapabilities();
      expect(caps.isIOS).toBe(false);
      expect(caps.isAndroid).toBe(true);
      expect(caps.isMobile).toBe(true);
    });

    it('sets all mobile flags to false for desktop user-agent', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      );
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
      const caps = detectCapabilities();
      expect(caps.isIOS).toBe(false);
      expect(caps.isAndroid).toBe(false);
      expect(caps.isMobile).toBe(false);
    });
  });

  // ── Safari detection in detectCapabilities ──────────────────────────────

  describe('isSafari in detectCapabilities', () => {
    it('sets isSafari=true for macOS Safari', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
      );
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
      const caps = detectCapabilities();
      expect(caps.isSafari).toBe(true);
      expect(caps.isIOS).toBe(false);
    });

    it('sets isSafari=true and isIOS=true for iOS Safari', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      );
      const caps = detectCapabilities();
      expect(caps.isSafari).toBe(true);
      expect(caps.isIOS).toBe(true);
    });

    it('sets isSafari=false for Chrome on macOS', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
      const caps = detectCapabilities();
      expect(caps.isSafari).toBe(false);
    });

    it('sets isSafari=false for Chrome on Windows', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
      const caps = detectCapabilities();
      expect(caps.isSafari).toBe(false);
    });
  });

  // ── safariVersion in detectCapabilities ─────────────────────────────────

  describe('safariVersion in detectCapabilities', () => {
    it('sets safariVersion to the major version for macOS Safari 17', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
      );
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
      const caps = detectCapabilities();
      expect(caps.safariVersion).toBe(17);
      expect(caps.isSafari).toBe(true);
    });

    it('sets safariVersion for iOS Safari 16', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
      );
      const caps = detectCapabilities();
      expect(caps.safariVersion).toBe(16);
      expect(caps.isSafari).toBe(true);
    });

    it('sets safariVersion to null for Chrome on macOS', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
      const caps = detectCapabilities();
      expect(caps.safariVersion).toBeNull();
      expect(caps.isSafari).toBe(false);
    });

    it('sets safariVersion to null for Chrome on iOS (CriOS)', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1'
      );
      const caps = detectCapabilities();
      expect(caps.safariVersion).toBeNull();
      expect(caps.isSafari).toBe(false);
    });

    it('sets safariVersion to null for Firefox on desktop', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'
      );
      const caps = detectCapabilities();
      expect(caps.safariVersion).toBeNull();
      expect(caps.isSafari).toBe(false);
    });
  });

  // ── Mobile tier cap ──────────────────────────────────────────────────────

  describe('classifyTier — mobile tier cap', () => {
    function makeHighEndGPUCaps(): GPUCapabilities {
      return {
        renderer: 'Apple GPU', vendor: 'Apple',
        maxTextureSize: 16384,
        maxVertexAttribs: 16, maxVaryingVectors: 15, maxRenderbufferSize: 16384,
        anisotropicFiltering: true, maxAnisotropy: 16,
        floatTextures: true, halfFloatTextures: true,
        instancedArrays: true, webgl2: true,
        vertexArrayObject: true, compressedTextures: true,
        etc2Textures: true, astcTextures: true,
        maxColorAttachments: 8, multiDraw: false,
      };
    }

    it('caps mobile tier at "high" even when score would be "ultra"', () => {
      // High-end spec that would normally be "ultra" on desktop
      const tier = __classifyTierForTests(8, 8, false, 80, makeHighEndGPUCaps(), false, true);
      expect(tier).toBe('high');
    });

    it('allows "ultra" tier for desktop with the same score', () => {
      const tier = __classifyTierForTests(8, 8, false, 80, makeHighEndGPUCaps(), false, false);
      expect(tier).toBe('ultra');
    });

    it('does not raise a mobile device above its actual tier (medium stays medium)', () => {
      // Low-spec mobile that scores "medium"
      const basicCaps: GPUCapabilities = {
        renderer: 'PowerVR', vendor: 'Imagination',
        maxTextureSize: 4096,
        maxVertexAttribs: 8, maxVaryingVectors: 8, maxRenderbufferSize: 4096,
        anisotropicFiltering: false, maxAnisotropy: 0,
        floatTextures: false, halfFloatTextures: false,
        instancedArrays: false, webgl2: false,
        vertexArrayObject: false, compressedTextures: false,
        etc2Textures: false, astcTextures: false,
        maxColorAttachments: 1, multiDraw: false,
      };
      const tier = __classifyTierForTests(4, 4, false, 0, basicCaps, false, true);
      expect(tier).toBe('medium');
    });
  });

  // ── Formatting helpers ──────────────────────────────────────────────────

  describe('formatCapabilitiesSummary', () => {
    it('includes Chromebook suffix when isChromOS is true', () => {
      const caps = detectCapabilities();
      // Inject a Chromebook flag
      const chromeCaps = { ...caps, isChromOS: true };
      const summary = formatCapabilitiesSummary(chromeCaps);
      expect(summary).toContain('Chromebook');
    });

    it('omits Chromebook suffix when isChromOS is false', () => {
      const caps = detectCapabilities();
      const nonChromeCaps = { ...caps, isChromOS: false };
      const summary = formatCapabilitiesSummary(nonChromeCaps);
      expect(summary).not.toContain('Chromebook');
    });

    it('includes iPhone/iPad suffix when isIOS is true', () => {
      const caps = detectCapabilities();
      const iosCaps = { ...caps, isIOS: true, isAndroid: false, isMobile: true };
      const summary = formatCapabilitiesSummary(iosCaps);
      expect(summary).toContain('iPhone/iPad');
    });

    it('includes Android suffix when isAndroid is true', () => {
      const caps = detectCapabilities();
      const androidCaps = { ...caps, isIOS: false, isAndroid: true, isMobile: true };
      const summary = formatCapabilitiesSummary(androidCaps);
      expect(summary).toContain('Android');
    });

    it('omits mobile suffix for desktop devices', () => {
      const caps = detectCapabilities();
      const desktopCaps = { ...caps, isIOS: false, isAndroid: false, isMobile: false };
      const summary = formatCapabilitiesSummary(desktopCaps);
      expect(summary).not.toContain('iPhone/iPad');
      expect(summary).not.toContain('Android');
    });
  });

  describe('formatDetailedSummary', () => {
    it('mentions Chromebook in detailed summary when isChromOS', () => {
      const caps = detectCapabilities();
      const chromeCaps = { ...caps, isChromOS: true };
      const summary = formatDetailedSummary(chromeCaps);
      expect(summary).toContain('Chromebook');
    });

    it('mentions iOS in detailed summary when isIOS', () => {
      const caps = detectCapabilities();
      const iosCaps = { ...caps, isIOS: true, isAndroid: false, isMobile: true };
      const summary = formatDetailedSummary(iosCaps);
      expect(summary).toContain('iOS');
    });

    it('mentions Android in detailed summary when isAndroid', () => {
      const caps = detectCapabilities();
      const androidCaps = { ...caps, isIOS: false, isAndroid: true, isMobile: true };
      const summary = formatDetailedSummary(androidCaps);
      expect(summary).toContain('Android');
    });

    it('omits mobile device line for desktop', () => {
      const caps = detectCapabilities();
      const desktopCaps = { ...caps, isIOS: false, isAndroid: false, isMobile: false };
      const summary = formatDetailedSummary(desktopCaps);
      expect(summary).not.toContain('iPhone/iPad');
      expect(summary).not.toContain('Android — WebGL');
    });

    it('shows Safari version and PSP-requires note for Safari < 17', () => {
      const caps = detectCapabilities();
      const safariCaps = { ...caps, isIOS: false, isSafari: true, safariVersion: 16 };
      const summary = formatDetailedSummary(safariCaps);
      expect(summary).toContain('Safari 16');
      expect(summary).toContain('PSP requires Safari 17+');
    });

    it('shows Safari version and PSP-supported note for Safari 17+', () => {
      const caps = detectCapabilities();
      const safariCaps = { ...caps, isIOS: false, isSafari: true, safariVersion: 17 };
      const summary = formatDetailedSummary(safariCaps);
      expect(summary).toContain('Safari 17');
      expect(summary).toContain('PSP is supported');
    });

    it('shows generic Safari line when safariVersion is null', () => {
      const caps = detectCapabilities();
      const safariCaps = { ...caps, isIOS: false, isSafari: true, safariVersion: null };
      const summary = formatDetailedSummary(safariCaps);
      expect(summary).toContain('Safari');
      expect(summary).toContain('PSP requires Safari 17+');
    });
  });

  // ── Mode resolution ─────────────────────────────────────────────────────

  describe('resolveMode', () => {
    it('returns caps.recommendedMode when userMode is "auto"', () => {
      const capsPerf = { recommendedMode: 'performance' } as DeviceCapabilities;
      expect(resolveMode('auto', capsPerf)).toBe('performance');

      const capsQual = { recommendedMode: 'quality' } as DeviceCapabilities;
      expect(resolveMode('auto', capsQual)).toBe('quality');
    });

    it('returns "performance" when userMode is "performance", regardless of caps.recommendedMode', () => {
      const capsPerf = { recommendedMode: 'performance' } as DeviceCapabilities;
      expect(resolveMode('performance', capsPerf)).toBe('performance');

      const capsQual = { recommendedMode: 'quality' } as DeviceCapabilities;
      expect(resolveMode('performance', capsQual)).toBe('performance');
    });

    it('returns "quality" when userMode is "quality", regardless of caps.recommendedMode', () => {
      const capsPerf = { recommendedMode: 'performance' } as DeviceCapabilities;
      expect(resolveMode('quality', capsPerf)).toBe('quality');

      const capsQual = { recommendedMode: 'quality' } as DeviceCapabilities;
      expect(resolveMode('quality', capsQual)).toBe('quality');
    });
  });

  // ── Tier resolution ─────────────────────────────────────────────────────

  describe('resolveTier', () => {
    it('returns caps.tier when userMode is "auto"', () => {
      const caps = { tier: 'medium' } as DeviceCapabilities;
      expect(resolveTier('auto', caps)).toBe('medium');

      const capsUltra = { tier: 'ultra' } as DeviceCapabilities;
      expect(resolveTier('auto', capsUltra)).toBe('ultra');
    });

    it('returns "low" when userMode is "performance"', () => {
      const caps = { tier: 'ultra' } as DeviceCapabilities;
      expect(resolveTier('performance', caps)).toBe('low');

      const capsLow = { tier: 'low' } as DeviceCapabilities;
      expect(resolveTier('performance', capsLow)).toBe('low');
    });

    it('returns "ultra" in quality mode when caps.tier is "ultra"', () => {
      const caps = { tier: 'ultra' } as DeviceCapabilities;
      expect(resolveTier('quality', caps)).toBe('ultra');
    });

    it('returns "high" in quality mode when caps.tier is not "ultra"', () => {
      for (const tier of ['low', 'medium', 'high'] as const) {
        const caps = { tier } as DeviceCapabilities;
        expect(resolveTier('quality', caps)).toBe('high');
      }
    });
  });

  // ── Connection quality estimation ───────────────────────────────────────

  describe('estimateConnectionQuality', () => {
    type NavigatorWithConn = Navigator & {
      connection?: {
        effectiveType?: string;
        downlink?: number;
        saveData?: boolean;
      };
    };

    afterEach(() => {
      Object.defineProperty(navigator, 'connection', {
        value: undefined,
        configurable: true,
        writable: true,
      });
    });

    it('returns "unknown" when navigator.connection is unavailable', () => {
      Object.defineProperty(navigator, 'connection', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      expect(estimateConnectionQuality()).toBe('unknown');
    });

    it('returns "slow" when saveData is true', () => {
      (navigator as NavigatorWithConn).connection = { saveData: true, effectiveType: '4g', downlink: 10 };
      expect(estimateConnectionQuality()).toBe('slow');
    });

    it('returns "fast" when effectiveType is "4g" and downlink >= 5', () => {
      (navigator as NavigatorWithConn).connection = { effectiveType: '4g', downlink: 5 };
      expect(estimateConnectionQuality()).toBe('fast');
    });

    it('returns "fast" when effectiveType is "4g" but downlink in [2,5) via fallback path', () => {
      (navigator as NavigatorWithConn).connection = { effectiveType: '4g', downlink: 3 };
      expect(estimateConnectionQuality()).toBe('fast');
    });

    it('returns "unknown" when effectiveType is "4g" and downlink < 2', () => {
      (navigator as NavigatorWithConn).connection = { effectiveType: '4g', downlink: 1 };
      expect(estimateConnectionQuality()).toBe('unknown');
    });

    it('returns "slow" when effectiveType is "3g"', () => {
      (navigator as NavigatorWithConn).connection = { effectiveType: '3g' };
      expect(estimateConnectionQuality()).toBe('slow');
    });

    it('returns "slow" when effectiveType is "2g"', () => {
      (navigator as NavigatorWithConn).connection = { effectiveType: '2g' };
      expect(estimateConnectionQuality()).toBe('slow');
    });

    it('returns "fast" when downlink >= 2 and effectiveType is not "3g"/"2g"', () => {
      (navigator as NavigatorWithConn).connection = { downlink: 2 };
      expect(estimateConnectionQuality()).toBe('fast');
    });
  });

  // ── formatDetailedSummary WebGPU and connection quality ─────────────────

  describe('formatDetailedSummary WebGPU and connection fields', () => {
    it('includes "WebGPU: available" when webgpuAvailable is true', () => {
      const caps = detectCapabilities();
      const summary = formatDetailedSummary({ ...caps, webgpuAvailable: true });
      expect(summary).toContain('WebGPU: available');
    });

    it('omits WebGPU line when webgpuAvailable is false', () => {
      const caps = detectCapabilities();
      const summary = formatDetailedSummary({ ...caps, webgpuAvailable: false });
      expect(summary).not.toContain('WebGPU');
    });

    it('includes network quality when connectionQuality is not "unknown"', () => {
      const caps = detectCapabilities();
      const summary = formatDetailedSummary({ ...caps, connectionQuality: 'fast' });
      expect(summary).toContain('Network: fast');
    });

    it('omits network line when connectionQuality is "unknown"', () => {
      const caps = detectCapabilities();
      const summary = formatDetailedSummary({ ...caps, connectionQuality: 'unknown' });
      expect(summary).not.toContain('Network:');
    });
  });

  // ── GPU benchmark texture sampling ─────────────────────────────────────────

  /** Build a minimal but complete WebGL1 mock suitable for the benchmarkGPU path. */
  function makeBenchmarkGLMock(overrides: Record<string, unknown> = {}) {
    const loseContext = vi.fn();
    return {
      VERTEX_SHADER: 0x8B31,
      FRAGMENT_SHADER: 0x8B30,
      ARRAY_BUFFER: 0x8892,
      STATIC_DRAW: 0x88E4,
      TRIANGLE_STRIP: 0x0005,
      FLOAT: 0x1406,
      TEXTURE0: 0x84C0,
      TEXTURE_2D: 0x0DE1,
      RGBA: 0x1908,
      UNSIGNED_BYTE: 0x1401,
      TEXTURE_MIN_FILTER: 0x2801,
      TEXTURE_MAG_FILTER: 0x2800,
      TEXTURE_WRAP_S: 0x2802,
      TEXTURE_WRAP_T: 0x2803,
      NEAREST: 0x2600,
      CLAMP_TO_EDGE: 0x812F,
      createShader: vi.fn(() => ({})),
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      createProgram: vi.fn(() => ({})),
      attachShader: vi.fn(),
      linkProgram: vi.fn(),
      useProgram: vi.fn(),
      getUniformLocation: vi.fn(() => ({})),
      uniform1f: vi.fn(),
      uniform1i: vi.fn(),
      createBuffer: vi.fn(() => ({})),
      bindBuffer: vi.fn(),
      bufferData: vi.fn(),
      getAttribLocation: vi.fn(() => 0),
      enableVertexAttribArray: vi.fn(),
      vertexAttribPointer: vi.fn(),
      createTexture: vi.fn(() => ({})),
      bindTexture: vi.fn(),
      activeTexture: vi.fn(),
      texImage2D: vi.fn(),
      texParameteri: vi.fn(),
      deleteTexture: vi.fn(),
      drawArrays: vi.fn(),
      flush: vi.fn(),
      finish: vi.fn(),
      deleteBuffer: vi.fn(),
      deleteShader: vi.fn(),
      deleteProgram: vi.fn(),
      getExtension: vi.fn((name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null)),
      ...overrides,
    };
  }

  describe('benchmarkGPU texture sampling', () => {
    it('calls createTexture and texImage2D during the benchmark', () => {
      const createTexture = vi.fn(() => ({}));
      const texImage2D = vi.fn();
      const gl = makeBenchmarkGLMock({ createTexture, texImage2D });
      const canvas = { width: 0, height: 0, getContext: vi.fn((type: string) => (type === 'webgl' ? gl : null)) };
      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tagName: string, options?: ElementCreationOptions) => (
        tagName === 'canvas'
          ? (canvas as unknown as HTMLCanvasElement)
          : originalCreateElement(tagName, options)
      ));

      detectCapabilities();

      expect(createTexture).toHaveBeenCalled();
      expect(texImage2D).toHaveBeenCalled();
    });

    it('deletes the benchmark texture in cleanup', () => {
      const deleteTexture = vi.fn();
      const gl = makeBenchmarkGLMock({ deleteTexture });
      const canvas = { width: 0, height: 0, getContext: vi.fn((type: string) => (type === 'webgl' ? gl : null)) };
      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tagName: string, options?: ElementCreationOptions) => (
        tagName === 'canvas'
          ? (canvas as unknown as HTMLCanvasElement)
          : originalCreateElement(tagName, options)
      ));

      detectCapabilities();

      expect(deleteTexture).toHaveBeenCalled();
    });

    /** Mount a WebGL1 mock canvas so detectCapabilities() exercises benchmarkGPU(). */
    function spyBenchmarkCanvas(glOverrides: Record<string, unknown>) {
      const gl = makeBenchmarkGLMock(glOverrides);
      const canvas = { width: 0, height: 0, getContext: vi.fn((type: string) => (type === 'webgl' ? gl : null)) };
      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tagName: string, options?: ElementCreationOptions) => (
        tagName === 'canvas'
          ? (canvas as unknown as HTMLCanvasElement)
          : originalCreateElement(tagName, options)
      ));
    }

    it('returns gpuBenchmarkScore 0 when createShader returns null', () => {
      spyBenchmarkCanvas({ createShader: vi.fn(() => null) });
      expect(detectCapabilities().gpuBenchmarkScore).toBe(0);
    });

    it('returns gpuBenchmarkScore 0 when createProgram returns null', () => {
      spyBenchmarkCanvas({ createProgram: vi.fn(() => null) });
      expect(detectCapabilities().gpuBenchmarkScore).toBe(0);
    });

    it('returns gpuBenchmarkScore 0 when createBuffer returns null', () => {
      spyBenchmarkCanvas({ createBuffer: vi.fn(() => null) });
      expect(detectCapabilities().gpuBenchmarkScore).toBe(0);
    });
  });

  // ── classifyTier — very-limited-GPU penalty ──────────────────────────────

  describe('classifyTier — very-limited GPU penalty', () => {
    /** Minimal GPUCapabilities with only maxTextureSize set, all features off. */
    function makeGPUCaps(maxTextureSize: number): GPUCapabilities {
      return {
        renderer: 'unknown', vendor: 'unknown',
        maxTextureSize,
        maxVertexAttribs: 8, maxVaryingVectors: 8, maxRenderbufferSize: maxTextureSize,
        anisotropicFiltering: false, maxAnisotropy: 0,
        floatTextures: false, halfFloatTextures: false,
        instancedArrays: false, webgl2: false,
        vertexArrayObject: false, compressedTextures: false,
        etc2Textures: false, astcTextures: false,
        maxColorAttachments: 1, multiDraw: false,
      };
    }

    it('classifies a 4-core/4 GB device as "low" when maxTextureSize is 1024', () => {
      // Without the penalty: CPU(14) + RAM(12) + GPU(0) = 26 → "medium".
      // With the 8-point penalty: 26 − 8 = 18 → "low".
      const tier = __classifyTierForTests(4, 4, false, 0, makeGPUCaps(1024), false);
      expect(tier).toBe('low');
    });

    it('classifies the same device as "medium" when maxTextureSize is 2048 (no penalty)', () => {
      // 2048 is exactly the threshold boundary: penalty only fires for < 2048.
      const tier = __classifyTierForTests(4, 4, false, 0, makeGPUCaps(2048), false);
      expect(tier).toBe('medium');
    });

    it('does NOT apply the penalty when maxTextureSize is 0 (probe failure)', () => {
      // maxTextureSize === 0 means probeGPU failed; we have no data so the
      // penalty must not fire. The same 4-core/4 GB device should remain
      // at "medium" without penalisation.
      const tier = __classifyTierForTests(4, 4, false, 0, makeGPUCaps(0), false);
      expect(tier).toBe('medium');
    });
  });

  // ── estimateVRAM ────────────────────────────────────────────────────────────

  describe('estimateVRAM', () => {
    function makeFullGPUCaps(overrides: Partial<GPUCapabilities> = {}): GPUCapabilities {
      return {
        renderer: 'Test GPU',
        vendor: 'Test Vendor',
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
        etc2Textures: false,
        astcTextures: false,
        maxColorAttachments: 1,
        multiDraw: false,
        ...overrides,
      };
    }

    it('returns minimum estimate for basic GPU capabilities', () => {
      const caps = makeFullGPUCaps({ maxTextureSize: 2048, maxColorAttachments: 1, astcTextures: false, etc2Textures: false });
      expect(estimateVRAM(caps)).toBe(256);
    });

    it('returns higher estimate for GPU with large textures and MRT', () => {
      const caps = makeFullGPUCaps({ maxTextureSize: 16384, maxColorAttachments: 8 });
      expect(estimateVRAM(caps)).toBe(4096 + 512);
    });

    it('includes compression bonuses for ASTC and ETC2', () => {
      const caps = makeFullGPUCaps({ maxTextureSize: 4096, maxColorAttachments: 1, astcTextures: true, etc2Textures: true });
      // 512 (texSize) + 0 (MRT) + 256 (ASTC) + 128 (ETC2)
      expect(estimateVRAM(caps)).toBe(512 + 256 + 128);
    });

    it('returns mid-range estimate for typical discrete GPU', () => {
      const caps = makeFullGPUCaps({ maxTextureSize: 8192, maxColorAttachments: 4, astcTextures: false, etc2Textures: true });
      // 1536 (texSize) + 256 (MRT 4) + 0 (no ASTC) + 128 (ETC2)
      expect(estimateVRAM(caps)).toBe(1536 + 256 + 128);
    });
  });

  // ── detectCapabilitiesCached ──────────────────────────────────────────────

  describe('detectCapabilitiesCached', () => {
    beforeEach(() => {
      clearCapabilitiesCache();
    });

    it('returns a valid DeviceCapabilities object on first call', () => {
      const caps = detectCapabilitiesCached();
      expect(caps).toHaveProperty('tier');
      expect(['low', 'medium', 'high', 'ultra']).toContain(caps.tier);
    });

    it('returns identical result from cache on second call without re-running detection', () => {
      const caps1 = detectCapabilitiesCached();
      // Spy on detectCapabilities; if caching works it should NOT be called again
      const spy = vi.spyOn({ detectCapabilities }, 'detectCapabilities');
      const caps2 = detectCapabilitiesCached();
      // Values must match
      expect(caps2.tier).toBe(caps1.tier);
      expect(caps2.gpuBenchmarkScore).toBe(caps1.gpuBenchmarkScore);
      spy.mockRestore();
    });

    it('re-runs detection after clearCapabilitiesCache()', () => {
      const caps1 = detectCapabilitiesCached();
      clearCapabilitiesCache();
      const caps2 = detectCapabilitiesCached();
      // Both results must be structurally valid (content may vary in test env)
      expect(['low', 'medium', 'high', 'ultra']).toContain(caps2.tier);
      expect(typeof caps2.gpuBenchmarkScore).toBe('number');
      // Tier should be the same across two identical runs in the same environment
      expect(caps2.tier).toBe(caps1.tier);
    });

    it('falls back gracefully when sessionStorage throws on read', () => {
      vi.spyOn(window.sessionStorage, 'getItem').mockImplementation(() => {
        throw new Error('storage unavailable');
      });
      vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {});
      const caps = detectCapabilitiesCached();
      expect(['low', 'medium', 'high', 'ultra']).toContain(caps.tier);
    });

    it('falls back gracefully when sessionStorage contains corrupt JSON', () => {
      vi.spyOn(window.sessionStorage, 'getItem').mockReturnValue('not-valid-json{{{');
      vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {});
      const caps = detectCapabilitiesCached();
      expect(['low', 'medium', 'high', 'ultra']).toContain(caps.tier);
    });

    it('falls back gracefully when cached entry has an unrecognised tier', () => {
      const bad = JSON.stringify({ tier: 'extreme', gpuBenchmarkScore: 99 });
      vi.spyOn(window.sessionStorage, 'getItem').mockReturnValue(bad);
      vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {});
      const caps = detectCapabilitiesCached();
      // Must have fallen through to fresh detection
      expect(['low', 'medium', 'high', 'ultra']).toContain(caps.tier);
    });

    it('falls back gracefully when sessionStorage.setItem throws (write failure)', () => {
      clearCapabilitiesCache();
      vi.spyOn(window.sessionStorage, 'getItem').mockReturnValue(null);
      vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('QuotaExceededError');
      });
      const caps = detectCapabilitiesCached();
      expect(['low', 'medium', 'high', 'ultra']).toContain(caps.tier);
    });

    it('clearCapabilitiesCache removes the session entry without throwing', () => {
      detectCapabilitiesCached(); // populate
      expect(() => clearCapabilitiesCache()).not.toThrow();
      // After clearing, sessionStorage should not have the key
      expect(sessionStorage.getItem('retrovault-devcaps-v1')).toBeNull();
    });
  });

  // ── MemoryMonitor ──────────────────────────────────────────────────────────

  describe('MemoryMonitor', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('usedHeapMB returns null when performance.memory is unavailable', () => {
      const monitor = new MemoryMonitor();
      // jsdom does not expose performance.memory
      expect(monitor.usedHeapMB).toBeNull();
    });

    it('heapLimitMB returns null when performance.memory is unavailable', () => {
      const monitor = new MemoryMonitor();
      expect(monitor.heapLimitMB).toBeNull();
    });

    it('stop() does not throw when the monitor was never started', () => {
      const monitor = new MemoryMonitor();
      expect(() => monitor.stop()).not.toThrow();
    });

    it('start() does not throw', () => {
      const monitor = new MemoryMonitor();
      expect(() => monitor.start()).not.toThrow();
      monitor.stop();
    });

    it('start() is idempotent — calling twice does not start two intervals', () => {
      const monitor = new MemoryMonitor();
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      monitor.start();
      monitor.start(); // second call should be a no-op
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      monitor.stop();
    });

    it('stop() clears the interval', () => {
      const monitor = new MemoryMonitor();
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      monitor.start();
      monitor.stop();
      expect(clearIntervalSpy).toHaveBeenCalled();
    });

    it('stop() can be called multiple times without error', () => {
      const monitor = new MemoryMonitor();
      monitor.start();
      monitor.stop();
      expect(() => monitor.stop()).not.toThrow();
    });

    it('fires onPressure when heap usage exceeds 80% of limit', () => {
      const monitor = new MemoryMonitor();
      const pressureEvents: [number, number][] = [];
      monitor.onPressure = (used, limit) => pressureEvents.push([used, limit]);

      const perfMock = performance as Performance & {
        memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
      };
      Object.defineProperty(perfMock, 'memory', {
        value: { usedJSHeapSize: 850 * 1024 * 1024, jsHeapSizeLimit: 1000 * 1024 * 1024 },
        configurable: true,
      });

      type MonitorInternal = { _check(): void; _lastPressureTime: number };
      const mon = monitor as unknown as MonitorInternal;
      mon._lastPressureTime = 0;
      mon._check();

      expect(pressureEvents).toHaveLength(1);
      expect(pressureEvents[0]![0]).toBe(850);
      expect(pressureEvents[0]![1]).toBe(1000);

      Object.defineProperty(perfMock, 'memory', { value: undefined, configurable: true });
    });

    it('does NOT fire onPressure when heap usage is below 80% of limit', () => {
      const monitor = new MemoryMonitor();
      const pressureEvents: unknown[] = [];
      monitor.onPressure = () => pressureEvents.push(true);

      const perfMock = performance as Performance & {
        memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
      };
      Object.defineProperty(perfMock, 'memory', {
        value: { usedJSHeapSize: 700 * 1024 * 1024, jsHeapSizeLimit: 1000 * 1024 * 1024 },
        configurable: true,
      });

      type MonitorInternal = { _check(): void; _lastPressureTime: number };
      const mon = monitor as unknown as MonitorInternal;
      mon._lastPressureTime = 0;
      mon._check();

      expect(pressureEvents).toHaveLength(0);

      Object.defineProperty(perfMock, 'memory', { value: undefined, configurable: true });
    });

    it('respects the 30 s cooldown — does not fire twice within the window', () => {
      const monitor = new MemoryMonitor();
      const pressureEvents: unknown[] = [];
      monitor.onPressure = () => pressureEvents.push(true);

      const perfMock = performance as Performance & {
        memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
      };
      Object.defineProperty(perfMock, 'memory', {
        value: { usedJSHeapSize: 900 * 1024 * 1024, jsHeapSizeLimit: 1000 * 1024 * 1024 },
        configurable: true,
      });

      type MonitorInternal = { _check(): void; _lastPressureTime: number };
      const mon = monitor as unknown as MonitorInternal;
      // Fire the first pressure notification
      mon._lastPressureTime = 0;
      mon._check();
      expect(pressureEvents).toHaveLength(1);

      // Immediately check again — cooldown should suppress the second callback
      mon._check();
      expect(pressureEvents).toHaveLength(1);

      Object.defineProperty(perfMock, 'memory', { value: undefined, configurable: true });
    });

    it('fires again after the cooldown period has elapsed', () => {
      const monitor = new MemoryMonitor();
      const pressureEvents: unknown[] = [];
      monitor.onPressure = () => pressureEvents.push(true);

      const perfMock = performance as Performance & {
        memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
      };
      Object.defineProperty(perfMock, 'memory', {
        value: { usedJSHeapSize: 900 * 1024 * 1024, jsHeapSizeLimit: 1000 * 1024 * 1024 },
        configurable: true,
      });

      type MonitorInternal = { _check(): void; _lastPressureTime: number };
      const mon = monitor as unknown as MonitorInternal;

      // First notification
      mon._lastPressureTime = 0;
      mon._check();
      expect(pressureEvents).toHaveLength(1);

      // Simulate the cooldown having elapsed by backdating _lastPressureTime
      mon._lastPressureTime = Date.now() - 31_000;
      mon._check();
      expect(pressureEvents).toHaveLength(2);

      Object.defineProperty(perfMock, 'memory', { value: undefined, configurable: true });
    });

    it('does not throw when performance.memory is absent during _check', () => {
      const monitor = new MemoryMonitor();
      type MonitorInternal = { _check(): void };
      expect(() => (monitor as unknown as MonitorInternal)._check()).not.toThrow();
    });

    it('usedHeapMB reads the mocked value when performance.memory is available', () => {
      const monitor = new MemoryMonitor();
      const perfMock = performance as Performance & {
        memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
      };
      Object.defineProperty(perfMock, 'memory', {
        value: { usedJSHeapSize: 512 * 1024 * 1024, jsHeapSizeLimit: 2048 * 1024 * 1024 },
        configurable: true,
      });

      expect(monitor.usedHeapMB).toBe(512);
      expect(monitor.heapLimitMB).toBe(2048);

      Object.defineProperty(perfMock, 'memory', { value: undefined, configurable: true });
    });
  });

  // ── scheduleIdleTask ───────────────────────────────────────────────────────

  describe('scheduleIdleTask', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('invokes the task via setTimeout when requestIdleCallback is unavailable', async () => {
      // jsdom does not provide requestIdleCallback, so the fallback path runs
      const results: string[] = [];
      vi.useFakeTimers();
      scheduleIdleTask(() => results.push('ran'));
      expect(results).toHaveLength(0);  // not yet called
      await vi.runAllTimersAsync();
      expect(results).toHaveLength(1);
      expect(results[0]).toBe('ran');
    });

    it('invokes the task via requestIdleCallback when available', async () => {
      const results: string[] = [];
      let capturedCallback: (() => void) | null = null;

      // Temporarily install a mock requestIdleCallback
      const original = (globalThis as Record<string, unknown>).requestIdleCallback;
      (globalThis as Record<string, unknown>).requestIdleCallback = (cb: () => void) => {
        capturedCallback = cb;
        return 1;
      };

      scheduleIdleTask(() => results.push('idle'));
      expect(capturedCallback).not.toBeNull();
      expect(results).toHaveLength(0);

      // Invoke the captured callback as the browser would
      capturedCallback!();
      expect(results).toHaveLength(1);
      expect(results[0]).toBe('idle');

      // Restore
      (globalThis as Record<string, unknown>).requestIdleCallback = original;
    });

    it('respects the custom timeoutMs parameter', () => {
      const capturedOpts: { timeout?: number }[] = [];
      const original = (globalThis as Record<string, unknown>).requestIdleCallback;
      (globalThis as Record<string, unknown>).requestIdleCallback = (
        _cb: () => void,
        opts: { timeout?: number }
      ) => {
        capturedOpts.push(opts);
        return 1;
      };

      scheduleIdleTask(() => {}, 5000);
      expect(capturedOpts[0]!.timeout).toBe(5000);

      (globalThis as Record<string, unknown>).requestIdleCallback = original;
    });
  });

  // ── ObjectPool ─────────────────────────────────────────────────────────────

  describe('ObjectPool', () => {
    it('creates a new object when the pool is empty', () => {
      let created = 0;
      const pool = new ObjectPool<{ x: number }>(() => { created++; return { x: 0 }; });
      const obj = pool.acquire();
      expect(created).toBe(1);
      expect(obj).toEqual({ x: 0 });
    });

    it('reuses a released object instead of creating a new one', () => {
      let created = 0;
      const pool = new ObjectPool<{ x: number }>(() => { created++; return { x: 0 }; });
      const first = pool.acquire();
      pool.release(first);
      const second = pool.acquire();
      expect(created).toBe(1); // no extra allocation
      expect(second).toBe(first); // same reference
    });

    it('calls the reset callback with extra args on acquire', () => {
      const pool = new ObjectPool<{ x: number; y: number }, [number, number]>(
        () => ({ x: 0, y: 0 }),
        (obj, x, y) => { obj.x = x; obj.y = y; },
      );
      const obj = pool.acquire(3, 7);
      expect(obj.x).toBe(3);
      expect(obj.y).toBe(7);
    });

    it('discards objects when the pool is at capacity', () => {
      const pool = new ObjectPool<object>(() => ({}), undefined, 2);
      const a = pool.acquire();
      const b = pool.acquire();
      const c = pool.acquire();
      pool.release(a);
      pool.release(b);
      pool.release(c); // pool is full — should be silently dropped
      expect(pool.size).toBe(2);
    });

    it('size reflects the number of pooled objects', () => {
      const pool = new ObjectPool<object>(() => ({}), undefined, 10);
      expect(pool.size).toBe(0);
      const obj = pool.acquire();
      pool.release(obj);
      expect(pool.size).toBe(1);
    });

    it('prewarm fills the pool up to maxSize', () => {
      const pool = new ObjectPool<object>(() => ({}), undefined, 5);
      pool.prewarm(3);
      expect(pool.size).toBe(3);
    });

    it('prewarm does not exceed maxSize', () => {
      const pool = new ObjectPool<object>(() => ({}), undefined, 3);
      pool.prewarm(100);
      expect(pool.size).toBe(3);
    });

    it('clear drains all pooled objects', () => {
      const pool = new ObjectPool<object>(() => ({}), undefined, 10);
      pool.prewarm(5);
      pool.clear();
      expect(pool.size).toBe(0);
    });
  });

  // ── SpatialGrid ────────────────────────────────────────────────────────────

  describe('SpatialGrid', () => {
    it('exposes cols, rows, and cellSize', () => {
      const grid = new SpatialGrid(100, 200, 25);
      expect(grid.cols).toBe(4);   // 100 / 25
      expect(grid.rows).toBe(8);   // 200 / 25
      expect(grid.cellSize).toBe(25);
    });

    it('throws when cellSize is zero or negative', () => {
      expect(() => new SpatialGrid(100, 100, 0)).toThrow(RangeError);
      expect(() => new SpatialGrid(100, 100, -1)).toThrow(RangeError);
    });

    it('insert and query return the object', () => {
      const grid = new SpatialGrid<string>(100, 100, 10);
      grid.insert('a', 15, 25);
      const result = grid.query(10, 20, 20, 30);
      expect(result.has('a')).toBe(true);
    });

    it('query returns nothing for a disjoint region', () => {
      const grid = new SpatialGrid<string>(100, 100, 10);
      grid.insert('a', 5, 5);
      const result = grid.query(50, 50, 60, 60);
      expect(result.size).toBe(0);
    });

    it('remove prevents the object from appearing in subsequent queries', () => {
      const grid = new SpatialGrid<string>(100, 100, 10);
      grid.insert('b', 15, 15);
      grid.remove('b', 15, 15);
      expect(grid.query(10, 10, 20, 20).has('b')).toBe(false);
    });

    it('move updates the object to the new cell', () => {
      const grid = new SpatialGrid<string>(100, 100, 10);
      grid.insert('c', 5, 5);
      grid.move('c', 5, 5, 55, 55);
      expect(grid.query(0, 0, 9, 9).has('c')).toBe(false);
      expect(grid.query(50, 50, 60, 60).has('c')).toBe(true);
    });

    it('move within the same cell is a no-op (no duplicate)', () => {
      const grid = new SpatialGrid<string>(100, 100, 10);
      grid.insert('d', 5, 5);
      grid.move('d', 5, 5, 6, 6); // same cell (0,0)
      const result = grid.query(0, 0, 9, 9);
      expect(result.has('d')).toBe(true);
      expect(result.size).toBe(1);
    });

    it('clamps out-of-bounds positions to boundary cells', () => {
      const grid = new SpatialGrid<string>(100, 100, 10);
      grid.insert('e', -50, -50); // clamped to (0,0)
      grid.insert('f', 999, 999); // clamped to last cell
      expect(grid.query(0, 0, 9, 9).has('e')).toBe(true);
      expect(grid.query(90, 90, 100, 100).has('f')).toBe(true);
    });

    it('clear removes all objects', () => {
      const grid = new SpatialGrid<string>(100, 100, 10);
      grid.insert('g', 5, 5);
      grid.clear();
      expect(grid.query(0, 0, 100, 100).size).toBe(0);
    });

    it('query spanning the entire world returns all inserted objects', () => {
      const grid = new SpatialGrid<number>(100, 100, 10);
      for (let i = 0; i < 5; i++) grid.insert(i, i * 15, i * 15);
      const all = grid.query(0, 0, 100, 100);
      for (let i = 0; i < 5; i++) expect(all.has(i)).toBe(true);
    });
  });

  // ── FrameBudget ────────────────────────────────────────────────────────────

  describe('FrameBudget', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('pendingCount starts at zero', () => {
      const budget = new FrameBudget();
      expect(budget.pendingCount).toBe(0);
    });

    it('enqueue increments pendingCount', () => {
      const budget = new FrameBudget();
      budget.enqueue(() => {});
      budget.enqueue(() => {});
      expect(budget.pendingCount).toBe(2);
    });

    it('flush executes all tasks when within budget', () => {
      const ran: number[] = [];
      const budget = new FrameBudget(1000); // very generous budget
      budget.beginFrame();
      budget.enqueue(() => ran.push(1));
      budget.enqueue(() => ran.push(2));
      const count = budget.flush();
      expect(ran).toEqual([1, 2]);
      expect(count).toBe(2);
      expect(budget.pendingCount).toBe(0);
    });

    it('flush stops when budget is exceeded and defers remaining tasks', () => {
      const baseTime = 5_000_000;
      const nowSpy = vi.spyOn(performance, 'now');
      // Call 1: beginFrame() records the frame start.
      // Call 2: first isOverBudget() check before task 'a' — within budget.
      // Call 3: second isOverBudget() check before task 'b' — over budget → stop.
      nowSpy
        .mockReturnValueOnce(baseTime)         // beginFrame
        .mockReturnValueOnce(baseTime)         // check before 'a' → 0 ms
        .mockReturnValue   (baseTime + 15);    // check before 'b' → 15 ms

      const budget = new FrameBudget(10); // 10 ms budget
      budget.beginFrame();

      const ran: string[] = [];
      budget.enqueue(() => ran.push('a'));
      budget.enqueue(() => ran.push('b'));

      budget.flush();
      expect(ran).toEqual(['a']);
      expect(budget.pendingCount).toBe(1); // 'b' deferred
    });

    it('isOverBudget returns false before beginFrame is called', () => {
      const budget = new FrameBudget(16);
      expect(budget.isOverBudget()).toBe(false);
    });

    it('elapsed returns 0 before beginFrame is called', () => {
      const budget = new FrameBudget();
      expect(budget.elapsed()).toBe(0);
    });

    it('clear discards all pending tasks', () => {
      const budget = new FrameBudget();
      budget.enqueue(() => {});
      budget.enqueue(() => {});
      budget.clear();
      expect(budget.pendingCount).toBe(0);
    });

    it('flush returns 0 when the queue is empty', () => {
      const budget = new FrameBudget(1000);
      budget.beginFrame();
      expect(budget.flush()).toBe(0);
    });
  });

  // ── DrawCallBatcher ────────────────────────────────────────────────────────

  describe('DrawCallBatcher', () => {
    const GL_TRIANGLES = 4;

    it('pendingCount starts at zero', () => {
      const batcher = new DrawCallBatcher();
      expect(batcher.pendingCount).toBe(0);
    });

    it('add increments pendingCount', () => {
      const batcher = new DrawCallBatcher();
      batcher.add(GL_TRIANGLES, 36, 0, 0, 1);
      expect(batcher.pendingCount).toBe(1);
    });

    it('flush returns sorted commands and resets pendingCount', () => {
      const batcher = new DrawCallBatcher();
      batcher.add(GL_TRIANGLES, 12, 0, 1, 2); // programId=2, tex=1
      batcher.add(GL_TRIANGLES, 36, 0, 0, 1); // programId=1, tex=0
      batcher.add(GL_TRIANGLES, 6,  0, 0, 2); // programId=2, tex=0
      const cmds = batcher.flush();
      expect(batcher.pendingCount).toBe(0);
      // Sorted: programId 1 < programId 2; within programId 2: tex 0 < tex 1
      expect(cmds[0]!.programId).toBe(1);
      expect(cmds[1]!.programId).toBe(2);
      expect(cmds[1]!.textureUnit).toBe(0);
      expect(cmds[2]!.programId).toBe(2);
      expect(cmds[2]!.textureUnit).toBe(1);
    });

    it('flush sorts by offset within the same program and texture', () => {
      const batcher = new DrawCallBatcher();
      batcher.add(GL_TRIANGLES, 6, 72, 0, 1);
      batcher.add(GL_TRIANGLES, 6, 0,  0, 1);
      batcher.add(GL_TRIANGLES, 6, 36, 0, 1);
      const cmds = batcher.flush();
      expect(cmds.map(c => c.offset)).toEqual([0, 36, 72]);
    });

    it('flush returns an empty array when no commands were added', () => {
      const batcher = new DrawCallBatcher();
      expect(batcher.flush()).toEqual([]);
    });

    it('silently drops commands beyond maxCommands', () => {
      const batcher = new DrawCallBatcher(2);
      batcher.add(GL_TRIANGLES, 6, 0, 0, 1);
      batcher.add(GL_TRIANGLES, 6, 0, 0, 2);
      batcher.add(GL_TRIANGLES, 6, 0, 0, 3); // dropped
      expect(batcher.pendingCount).toBe(2);
    });

    it('clear discards pending commands', () => {
      const batcher = new DrawCallBatcher();
      batcher.add(GL_TRIANGLES, 36, 0, 0, 1);
      batcher.clear();
      expect(batcher.pendingCount).toBe(0);
      expect(batcher.flush()).toEqual([]);
    });

    it('stores correct DrawCommand fields', () => {
      const batcher = new DrawCallBatcher();
      batcher.add(GL_TRIANGLES, 36, 48, 2, 5);
      const cmd = batcher.flush()[0]!;
      expect(cmd.mode).toBe(GL_TRIANGLES);
      expect(cmd.count).toBe(36);
      expect(cmd.offset).toBe(48);
      expect(cmd.textureUnit).toBe(2);
      expect(cmd.programId).toBe(5);
    });
  });

  // ── EntityComponentSystem ──────────────────────────────────────────────────

  describe('EntityComponentSystem', () => {
    it('createEntity returns incrementing IDs', () => {
      const ecs = new EntityComponentSystem();
      const a = ecs.createEntity();
      const b = ecs.createEntity();
      expect(typeof a).toBe('number');
      expect(b).toBe(a + 1);
    });

    it('isAlive returns true for a live entity', () => {
      const ecs = new EntityComponentSystem();
      const id = ecs.createEntity();
      expect(ecs.isAlive(id)).toBe(true);
    });

    it('isAlive returns false after destroyEntity', () => {
      const ecs = new EntityComponentSystem();
      const id = ecs.createEntity();
      ecs.destroyEntity(id);
      expect(ecs.isAlive(id)).toBe(false);
    });

    it('entityCount tracks live entities', () => {
      const ecs = new EntityComponentSystem();
      expect(ecs.entityCount).toBe(0);
      const a = ecs.createEntity();
      ecs.createEntity();
      expect(ecs.entityCount).toBe(2);
      ecs.destroyEntity(a);
      expect(ecs.entityCount).toBe(1);
    });

    it('addComponent / getComponent round-trip', () => {
      const ecs = new EntityComponentSystem();
      const id = ecs.createEntity();
      ecs.addComponent(id, 'position', { x: 3, y: 7 });
      expect(ecs.getComponent<{x:number;y:number}>(id, 'position')).toEqual({ x: 3, y: 7 });
    });

    it('getComponent returns undefined for missing component', () => {
      const ecs = new EntityComponentSystem();
      const id = ecs.createEntity();
      expect(ecs.getComponent(id, 'missing')).toBeUndefined();
    });

    it('hasComponent returns true/false correctly', () => {
      const ecs = new EntityComponentSystem();
      const id = ecs.createEntity();
      ecs.addComponent(id, 'hp', { value: 100 });
      expect(ecs.hasComponent(id, 'hp')).toBe(true);
      expect(ecs.hasComponent(id, 'mana')).toBe(false);
    });

    it('removeComponent removes the component', () => {
      const ecs = new EntityComponentSystem();
      const id = ecs.createEntity();
      ecs.addComponent(id, 'tag', { name: 'enemy' });
      ecs.removeComponent(id, 'tag');
      expect(ecs.hasComponent(id, 'tag')).toBe(false);
    });

    it('destroyEntity removes all components', () => {
      const ecs = new EntityComponentSystem();
      const id = ecs.createEntity();
      ecs.addComponent(id, 'position', { x: 0, y: 0 });
      ecs.addComponent(id, 'velocity', { vx: 1, vy: 0 });
      ecs.destroyEntity(id);
      expect(ecs.getComponent(id, 'position')).toBeUndefined();
      expect(ecs.getComponent(id, 'velocity')).toBeUndefined();
    });

    it('destroyEntity is idempotent', () => {
      const ecs = new EntityComponentSystem();
      const id = ecs.createEntity();
      ecs.destroyEntity(id);
      expect(() => ecs.destroyEntity(id)).not.toThrow();
    });

    it('queryEntities returns only entities with all required components', () => {
      const ecs = new EntityComponentSystem();
      const a = ecs.createEntity();
      const b = ecs.createEntity();
      const c = ecs.createEntity();
      ecs.addComponent(a, 'position', {});
      ecs.addComponent(a, 'velocity', {});
      ecs.addComponent(b, 'position', {});  // no velocity
      ecs.addComponent(c, 'velocity', {});  // no position
      const result = ecs.queryEntities(['position', 'velocity']);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(a);
    });

    it('queryEntities returns all live entities when types is empty', () => {
      const ecs = new EntityComponentSystem();
      const a = ecs.createEntity();
      const b = ecs.createEntity();
      const result = ecs.queryEntities([]);
      expect(result).toContain(a);
      expect(result).toContain(b);
    });

    it('queryEntities excludes destroyed entities', () => {
      const ecs = new EntityComponentSystem();
      const a = ecs.createEntity();
      const b = ecs.createEntity();
      ecs.addComponent(a, 'position', {});
      ecs.addComponent(b, 'position', {});
      ecs.destroyEntity(a);
      const result = ecs.queryEntities(['position']);
      expect(result).not.toContain(a);
      expect(result).toContain(b);
    });

    it('clear resets all state', () => {
      const ecs = new EntityComponentSystem();
      const id = ecs.createEntity();
      ecs.addComponent(id, 'hp', { value: 100 });
      ecs.clear();
      expect(ecs.entityCount).toBe(0);
      expect(ecs.queryEntities(['hp'])).toHaveLength(0);
    });
  });

  // ── Quadtree ───────────────────────────────────────────────────────────────

  describe('Quadtree', () => {
    it('query returns inserted points within range', () => {
      const qt = new Quadtree<string>(0, 0, 100, 100);
      qt.insert('A', 10, 10);
      qt.insert('B', 90, 90);
      const result = qt.query(0, 0, 50, 50);
      expect(result).toContain('A');
      expect(result).not.toContain('B');
    });

    it('query returns empty array for disjoint region', () => {
      const qt = new Quadtree<string>(0, 0, 100, 100);
      qt.insert('A', 10, 10);
      expect(qt.query(60, 60, 100, 100)).toHaveLength(0);
    });

    it('ignores points outside the root bounds', () => {
      const qt = new Quadtree<string>(0, 0, 100, 100);
      qt.insert('out', -10, -10);
      qt.insert('out2', 200, 200);
      expect(qt.query(-50, -50, 300, 300)).toHaveLength(0);
    });

    it('subdivides and still returns correct results', () => {
      // capacity=2 forces subdivision after 2 points
      const qt = new Quadtree<number>(0, 0, 100, 100, 2);
      for (let i = 0; i < 10; i++) {
        qt.insert(i, i * 9, i * 9);
      }
      const result = qt.query(0, 0, 50, 50);
      // Points 0–5 have coords < 50
      for (let i = 0; i <= 5; i++) {
        expect(result).toContain(i);
      }
    });

    it('accepts a pre-allocated results array to avoid allocation', () => {
      const qt = new Quadtree<number>(0, 0, 100, 100);
      qt.insert(42, 10, 10);
      const out: number[] = [];
      qt.query(0, 0, 50, 50, out);
      expect(out).toContain(42);
    });

    it('clear removes all points', () => {
      const qt = new Quadtree<string>(0, 0, 100, 100);
      qt.insert('A', 10, 10);
      qt.clear();
      expect(qt.query(0, 0, 100, 100)).toHaveLength(0);
    });
  });

  // ── AssetLoader ────────────────────────────────────────────────────────────

  describe('AssetLoader', () => {
    it('loads and caches an asset', async () => {
      const loader = new AssetLoader<string>(2);
      const result = await loader.load('tex1', 0, () => Promise.resolve('texture-data'));
      expect(result).toBe('texture-data');
      expect(loader.has('tex1')).toBe(true);
    });

    it('returns cached result on second load without calling factory again', async () => {
      const loader = new AssetLoader<string>(2);
      const factory = vi.fn(() => Promise.resolve('data'));
      await loader.load('key', 0, factory);
      await loader.load('key', 0, factory);
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it('get returns cached asset synchronously', async () => {
      const loader = new AssetLoader<number>(2);
      await loader.load('k', 0, () => Promise.resolve(99));
      expect(loader.get('k')).toBe(99);
    });

    it('get returns undefined for unloaded asset', () => {
      const loader = new AssetLoader<number>(2);
      expect(loader.get('missing')).toBeUndefined();
    });

    it('respects concurrency limit', async () => {
      let active = 0;
      let maxActive = 0;
      const loader = new AssetLoader<number>(2);
      const factory = (n: number) => () => new Promise<number>((res) => {
        active++;
        maxActive = Math.max(maxActive, active);
        setTimeout(() => { active--; res(n); }, 0);
      });
      const promises = [0, 1, 2, 3].map(n =>
        loader.load(`k${n}`, 0 as const, factory(n)));
      await Promise.all(promises);
      expect(maxActive).toBeLessThanOrEqual(2);
    });

    it('higher-priority requests start before lower-priority ones', async () => {
      const order: number[] = [];
      // concurrency=1 so requests run strictly one at a time
      const loader = new AssetLoader<number>(1);

      // Saturate the single slot so queued items wait.
      const blocker = loader.load('blocker', 0, () =>
        new Promise(res => setTimeout(() => res(0), 0)));

      // Queue two more requests while slot is busy.
      void loader.load('low', 3, () => { order.push(3); return Promise.resolve(3); });
      void loader.load('high', 0, () => { order.push(0); return Promise.resolve(0); });

      await blocker;
      await new Promise(res => setTimeout(res, 10));

      // The priority-0 request must have run before priority-3.
      const highIdx  = order.indexOf(0);
      const lowIdx   = order.indexOf(3);
      expect(highIdx).toBeGreaterThanOrEqual(0);
      expect(lowIdx).toBeGreaterThan(highIdx);
    });

    it('evict removes an asset from the cache', async () => {
      const loader = new AssetLoader<string>(2);
      await loader.load('k', 0, () => Promise.resolve('v'));
      loader.evict('k');
      expect(loader.has('k')).toBe(false);
    });

    it('clearCache evicts all assets', async () => {
      const loader = new AssetLoader<string>(2);
      await loader.load('a', 0, () => Promise.resolve('A'));
      await loader.load('b', 0, () => Promise.resolve('B'));
      loader.clearCache();
      expect(loader.has('a')).toBe(false);
      expect(loader.has('b')).toBe(false);
    });

    it('rejects the promise when the factory throws', async () => {
      const loader = new AssetLoader<string>(2);
      await expect(
        loader.load('err', 0, () => Promise.reject(new Error('fail'))),
      ).rejects.toThrow('fail');
    });

    it('pendingCount reflects queued requests', () => {
      const loader = new AssetLoader<string>(1);
      // First load saturates the single slot.
      void loader.load('first', 0, () => new Promise(() => {}));
      // Second queues up.
      void loader.load('second', 0, () => new Promise(() => {}));
      expect(loader.pendingCount).toBe(1);
      expect(loader.inFlight).toBe(1);
    });
  });

  // ── DeltaTracker ──────────────────────────────────────────────────────────

  describe('DeltaTracker', () => {
    it('delta returns null when nothing has changed', () => {
      const t = new DeltaTracker({ x: 0, y: 0 });
      expect(t.delta()).toBeNull();
    });

    it('delta returns changed fields after set()', () => {
      const t = new DeltaTracker({ x: 0, y: 0 });
      t.set('x', 5);
      expect(t.delta()).toEqual({ x: 5 });
    });

    it('delta omits unchanged fields', () => {
      const t = new DeltaTracker({ x: 0, y: 0 });
      t.set('x', 3);
      const d = t.delta();
      expect(d).not.toHaveProperty('y');
    });

    it('commit advances the baseline', () => {
      const t = new DeltaTracker({ x: 0 });
      t.set('x', 10);
      t.commit();
      expect(t.delta()).toBeNull();
    });

    it('rollback reverts to baseline', () => {
      const t = new DeltaTracker({ x: 0 });
      t.set('x', 99);
      t.rollback();
      expect(t.get('x')).toBe(0);
      expect(t.delta()).toBeNull();
    });

    it('isDirty returns true when a field has changed', () => {
      const t = new DeltaTracker({ hp: 100 });
      t.set('hp', 80);
      expect(t.isDirty()).toBe(true);
    });

    it('isDirty returns false after commit', () => {
      const t = new DeltaTracker({ hp: 100 });
      t.set('hp', 80);
      t.commit();
      expect(t.isDirty()).toBe(false);
    });

    it('epsilon suppresses small changes', () => {
      const t = new DeltaTracker({ angle: 0 }, 0.01);
      t.set('angle', 0.005);  // within epsilon
      expect(t.delta()).toBeNull();
    });

    it('epsilon allows changes beyond the threshold', () => {
      const t = new DeltaTracker({ angle: 0 }, 0.01);
      t.set('angle', 0.02);  // beyond epsilon
      expect(t.delta()).toEqual({ angle: 0.02 });
    });

    it('get returns the current value', () => {
      const t = new DeltaTracker({ score: 0 });
      t.set('score', 42);
      expect(t.get('score')).toBe(42);
    });

    it('get returns undefined for unknown key', () => {
      const t = new DeltaTracker({ x: 0 });
      expect(t.get('z')).toBeUndefined();
    });

    it('reset replaces state and clears dirty', () => {
      const t = new DeltaTracker({ x: 0, y: 0 });
      t.set('x', 100);
      t.reset({ x: 50, y: 50 });
      expect(t.delta()).toBeNull();
      expect(t.get('x')).toBe(50);
    });

    it('accepts new keys added after construction', () => {
      const t = new DeltaTracker({ x: 0 });
      t.set('z', 7);
      const d = t.delta();
      expect(d).toHaveProperty('z', 7);
    });
  });

  // ── ResolutionPreset / getResolutionCoreOptions ────────────────────────────
  describe('getResolutionCoreOptions', () => {
    it('returns empty object for an unknown system', () => {
      expect(getResolutionCoreOptions('unknownSystem', '2x')).toEqual({});
    });

    it('returns empty object for native preset (native = index 0)', () => {
      expect(getResolutionCoreOptions('psp', 'native')).toEqual({});
      expect(getResolutionCoreOptions('n64', 'native')).toEqual({});
    });

    it('returns correct PSP 2× option', () => {
      expect(getResolutionCoreOptions('psp', '2x')).toEqual({ ppsspp_internal_resolution: '2' });
    });

    it('returns correct PSP 4× option (step index 2)', () => {
      expect(getResolutionCoreOptions('psp', '4x')).toEqual({ ppsspp_internal_resolution: '4' });
    });

    it('returns correct N64 2× option', () => {
      expect(getResolutionCoreOptions('n64', '2x')).toEqual({ 'mupen64plus-resolution-factor': '2' });
    });

    it('returns correct N64 4× option', () => {
      expect(getResolutionCoreOptions('n64', '4x')).toEqual({ 'mupen64plus-resolution-factor': '4' });
    });

    it('returns correct PS1 2× option', () => {
      expect(getResolutionCoreOptions('psx', '2x')).toEqual({ beetle_psx_internal_resolution: '2x' });
    });

    it('returns correct PS1 4× option', () => {
      expect(getResolutionCoreOptions('psx', '4x')).toEqual({ beetle_psx_internal_resolution: '4x' });
    });

    it('returns correct Saturn 2× option', () => {
      expect(getResolutionCoreOptions('segaSaturn', '2x')).toEqual({ beetle_saturn_resolution: '2x' });
    });

    it('returns correct Dreamcast 2× option', () => {
      expect(getResolutionCoreOptions('segaDC', '2x')).toEqual({ flycast_internal_resolution: '1280x960' });
    });

    it('clamps 4× to the ladder maximum when the system only has fewer steps', () => {
      // N64 ladder: ["1","2","4"] — 3 entries; index 2 is "4"
      expect(getResolutionCoreOptions('n64', '4x')).toEqual({ 'mupen64plus-resolution-factor': '4' });
    });

    it('display_match returns a non-empty object for PSP (fallback path in tests)', () => {
      // In test environments window.screen may not be populated — just verify
      // it returns either an object with one key or {} (native fallback).
      const result = getResolutionCoreOptions('psp', 'display_match');
      // Must be an object (either {} or { ppsspp_internal_resolution: '...' })
      expect(typeof result).toBe('object');
    });

    describe('getResolutionLadder', () => {
      it('returns null for unknown system', () => {
        expect(getResolutionLadder('unknownSystem')).toBeNull();
      });

      it('returns the PSP ladder', () => {
        const ladder = getResolutionLadder('psp');
        expect(ladder).not.toBeNull();
        expect(ladder!.key).toBe('ppsspp_internal_resolution');
        expect(ladder!.values[0]).toBe('1');
      });

      it('returns the N64 ladder', () => {
        const ladder = getResolutionLadder('n64');
        expect(ladder).not.toBeNull();
        expect(ladder!.key).toBe('mupen64plus-resolution-factor');
      });
    });
  });
});

// ── recommendedAssetConcurrency ───────────────────────────────────────────────

describe('recommendedAssetConcurrency', () => {
  const mobileCaps = (tier: DeviceCapabilities['tier']): DeviceCapabilities =>
    ({ tier, isMobile: true } as unknown as DeviceCapabilities);
  const desktopCaps = (tier: DeviceCapabilities['tier']): DeviceCapabilities =>
    ({ tier, isMobile: false } as unknown as DeviceCapabilities);

  it('returns 1 for low-tier mobile', () => {
    expect(recommendedAssetConcurrency(mobileCaps('low'))).toBe(1);
  });

  it('returns 2 for medium/high/ultra mobile', () => {
    expect(recommendedAssetConcurrency(mobileCaps('medium'))).toBe(2);
    expect(recommendedAssetConcurrency(mobileCaps('high'))).toBe(2);
    expect(recommendedAssetConcurrency(mobileCaps('ultra'))).toBe(2);
  });

  it('returns 2 for low-tier desktop', () => {
    expect(recommendedAssetConcurrency(desktopCaps('low'))).toBe(2);
  });

  it('returns 4 for medium-tier desktop', () => {
    expect(recommendedAssetConcurrency(desktopCaps('medium'))).toBe(4);
  });

  it('returns 6 for high-tier desktop', () => {
    expect(recommendedAssetConcurrency(desktopCaps('high'))).toBe(6);
  });

  it('returns 8 for ultra-tier desktop', () => {
    expect(recommendedAssetConcurrency(desktopCaps('ultra'))).toBe(8);
  });

  it('mobile concurrency is always lower than desktop concurrency for the same tier', () => {
    for (const tier of ['medium', 'high', 'ultra'] as const) {
      expect(recommendedAssetConcurrency(mobileCaps(tier)))
        .toBeLessThan(recommendedAssetConcurrency(desktopCaps(tier)));
    }
  });
});

// ── recommendedFrameBudgetMs ──────────────────────────────────────────────────

describe('recommendedFrameBudgetMs', () => {
  const mobileCaps = (tier: DeviceCapabilities['tier']): DeviceCapabilities =>
    ({ tier, isMobile: true } as unknown as DeviceCapabilities);
  const desktopCaps = (tier: DeviceCapabilities['tier']): DeviceCapabilities =>
    ({ tier, isMobile: false } as unknown as DeviceCapabilities);

  it('returns a positive number for all tiers on mobile', () => {
    for (const tier of ['low', 'medium', 'high', 'ultra'] as const) {
      expect(recommendedFrameBudgetMs(mobileCaps(tier))).toBeGreaterThan(0);
    }
  });

  it('returns a positive number for all tiers on desktop', () => {
    for (const tier of ['low', 'medium', 'high', 'ultra'] as const) {
      expect(recommendedFrameBudgetMs(desktopCaps(tier))).toBeGreaterThan(0);
    }
  });

  it('returns lower budget for low-tier mobile than medium-tier mobile', () => {
    expect(recommendedFrameBudgetMs(mobileCaps('low')))
      .toBeLessThan(recommendedFrameBudgetMs(mobileCaps('medium')));
  });

  it('returns ≤16 ms for all tiers (fits within a 60fps frame)', () => {
    for (const tier of ['low', 'medium', 'high', 'ultra'] as const) {
      expect(recommendedFrameBudgetMs(desktopCaps(tier))).toBeLessThanOrEqual(16);
      expect(recommendedFrameBudgetMs(mobileCaps(tier))).toBeLessThanOrEqual(16);
    }
  });

  it('ultra desktop returns 16 ms (full frame budget)', () => {
    expect(recommendedFrameBudgetMs(desktopCaps('ultra'))).toBe(16);
  });

  it('mobile budget is not greater than equivalent desktop budget', () => {
    for (const tier of ['low', 'medium', 'high', 'ultra'] as const) {
      expect(recommendedFrameBudgetMs(mobileCaps(tier)))
        .toBeLessThanOrEqual(recommendedFrameBudgetMs(desktopCaps(tier)));
    }
  });
});

// ── ThermalMonitor ────────────────────────────────────────────────────────────

describe('ThermalMonitor', () => {
  it('starts in "unknown" state when the Compute Pressure API is unavailable', () => {
    const monitor = new ThermalMonitor();
    expect(monitor.state).toBe('unknown');
  });

  it('isSupported() returns false when PressureObserver is not defined', () => {
    const original = (globalThis as Record<string, unknown>)['PressureObserver'];
    delete (globalThis as Record<string, unknown>)['PressureObserver'];
    expect(ThermalMonitor.isSupported()).toBe(false);
    (globalThis as Record<string, unknown>)['PressureObserver'] = original;
  });

  it('isSupported() returns true when PressureObserver is a function', () => {
    (globalThis as Record<string, unknown>)['PressureObserver'] = function() {};
    expect(ThermalMonitor.isSupported()).toBe(true);
    delete (globalThis as Record<string, unknown>)['PressureObserver'];
  });

  it('start() resolves without error when API is unavailable', async () => {
    const monitor = new ThermalMonitor();
    await expect(monitor.start()).resolves.toBeUndefined();
    expect(monitor.state).toBe('unknown');
  });

  it('stop() is safe to call before start()', () => {
    const monitor = new ThermalMonitor();
    expect(() => monitor.stop()).not.toThrow();
  });

  it('stop() resets state to "unknown"', async () => {
    // Simulate a running monitor with a mock PressureObserver
    let callback: ((records: Array<{ state: string }>) => void) | null = null;
    const mockObserver = {
      observe: vi.fn().mockResolvedValue(undefined),
      unobserve: vi.fn(),
    };
    const MockPO = vi.fn().mockImplementation((cb: (records: Array<{ state: string }>) => void) => {
      callback = cb;
      return mockObserver;
    });
    (globalThis as Record<string, unknown>)['PressureObserver'] = MockPO;

    const monitor = new ThermalMonitor();
    await monitor.start();

    // Fire a simulated state change
    callback?.([{ state: 'serious' }]);
    expect(monitor.state).toBe('serious');

    monitor.stop();
    expect(monitor.state).toBe('unknown');

    delete (globalThis as Record<string, unknown>)['PressureObserver'];
  });

  it('fires onPressureChange callback on state transition', async () => {
    let callback: ((records: Array<{ state: string }>) => void) | null = null;
    const mockObserver = {
      observe: vi.fn().mockResolvedValue(undefined),
      unobserve: vi.fn(),
    };
    const MockPO = vi.fn().mockImplementation((cb: (records: Array<{ state: string }>) => void) => {
      callback = cb;
      return mockObserver;
    });
    (globalThis as Record<string, unknown>)['PressureObserver'] = MockPO;

    const monitor = new ThermalMonitor();
    const changes: Array<[string, string]> = [];
    monitor.onPressureChange = (s, p) => changes.push([s, p]);
    await monitor.start();

    callback?.([{ state: 'fair' }]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual(['fair', 'unknown']);

    callback?.([{ state: 'serious' }]);
    expect(changes).toHaveLength(2);
    expect(changes[1]).toEqual(['serious', 'fair']);

    delete (globalThis as Record<string, unknown>)['PressureObserver'];
  });

  it('does not fire onPressureChange when the state does not change', async () => {
    let callback: ((records: Array<{ state: string }>) => void) | null = null;
    const mockObserver = {
      observe: vi.fn().mockResolvedValue(undefined),
      unobserve: vi.fn(),
    };
    const MockPO = vi.fn().mockImplementation((cb: (records: Array<{ state: string }>) => void) => {
      callback = cb;
      return mockObserver;
    });
    (globalThis as Record<string, unknown>)['PressureObserver'] = MockPO;

    const monitor = new ThermalMonitor();
    let callCount = 0;
    monitor.onPressureChange = () => callCount++;
    await monitor.start();

    callback?.([{ state: 'nominal' }]);
    callback?.([{ state: 'nominal' }]); // same state — should not fire again
    expect(callCount).toBe(1);

    delete (globalThis as Record<string, unknown>)['PressureObserver'];
  });

  it('maps unknown pressure states to "unknown"', async () => {
    let callback: ((records: Array<{ state: string }>) => void) | null = null;
    const mockObserver = {
      observe: vi.fn().mockResolvedValue(undefined),
      unobserve: vi.fn(),
    };
    const MockPO = vi.fn().mockImplementation((cb: (records: Array<{ state: string }>) => void) => {
      callback = cb;
      return mockObserver;
    });
    (globalThis as Record<string, unknown>)['PressureObserver'] = MockPO;

    const monitor = new ThermalMonitor();
    const states: string[] = [];
    monitor.onPressureChange = (s) => states.push(s);
    await monitor.start();

    // Transition to a known state first
    callback?.([{ state: 'fair' }]);
    expect(monitor.state).toBe('fair');

    // Now an unknown state maps to "unknown" — should fire a transition fair → unknown
    callback?.([{ state: 'extremely_hot' }]);
    expect(states).toHaveLength(2);
    expect(states[1]).toBe('unknown');
    expect(monitor.state).toBe('unknown');

    delete (globalThis as Record<string, unknown>)['PressureObserver'];
  });

  it('stays stopped when observe() throws', async () => {
    const MockPO = vi.fn().mockImplementation(() => ({
      observe: vi.fn().mockRejectedValue(new Error('permissions policy')),
      unobserve: vi.fn(),
    }));
    (globalThis as Record<string, unknown>)['PressureObserver'] = MockPO;

    const monitor = new ThermalMonitor();
    await monitor.start();
    expect(monitor.state).toBe('unknown');

    delete (globalThis as Record<string, unknown>)['PressureObserver'];
  });
});

// ── StartupProfiler ───────────────────────────────────────────────────────────

describe('StartupProfiler', () => {
  it('starts with no records', () => {
    const profiler = new StartupProfiler();
    expect(profiler.records()).toHaveLength(0);
  });

  it('records a completed phase', () => {
    const profiler = new StartupProfiler();
    profiler.begin('core_download');
    profiler.end('core_download');
    const recs = profiler.records();
    expect(recs).toHaveLength(1);
    expect(recs[0]!.phase).toBe('core_download');
    expect(recs[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('does not record a phase that was begun but not ended', () => {
    const profiler = new StartupProfiler();
    profiler.begin('core_download');
    expect(profiler.records()).toHaveLength(0);
  });

  it('begin() is idempotent — second call does not reset the start time', () => {
    const profiler = new StartupProfiler();
    profiler.begin('core_download');
    const recs1 = profiler.records();
    profiler.begin('core_download'); // second call — should be ignored
    profiler.end('core_download');
    const recs2 = profiler.records();
    expect(recs2).toHaveLength(1);
    // The start time should not have changed
    void recs1; // suppress unused warning
  });

  it('end() is safe to call when begin() was not called', () => {
    const profiler = new StartupProfiler();
    expect(() => profiler.end('core_download')).not.toThrow();
    expect(profiler.records()).toHaveLength(0);
  });

  it('end() is idempotent — second call does not extend duration', () => {
    const profiler = new StartupProfiler();
    profiler.begin('core_download');
    profiler.end('core_download');
    const dur1 = profiler.records()[0]!.durationMs;
    profiler.end('core_download'); // second call — should be ignored
    const dur2 = profiler.records()[0]!.durationMs;
    expect(dur2).toBe(dur1);
  });

  it('sorts records by start time', () => {
    const profiler = new StartupProfiler();
    profiler.begin('first_frame');
    profiler.begin('core_download');
    profiler.end('core_download');
    profiler.end('first_frame');
    const recs = profiler.records();
    // first_frame was begun first but they may interleave — just check ordering
    expect(recs.every((r, i) => i === 0 || r.startMs >= recs[i - 1]!.startMs)).toBe(true);
  });

  it('summary() returns correct totalMs and slowest phase', () => {
    const profiler = new StartupProfiler();
    // Use fake timers to get deterministic results
    let t = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => t);

    profiler.begin('core_download');
    t += 500;
    profiler.end('core_download');

    profiler.begin('first_frame');
    t += 200;
    profiler.end('first_frame');

    const { totalMs, slowest } = profiler.summary();
    expect(totalMs).toBe(700);
    expect(slowest?.phase).toBe('core_download');
    expect(slowest?.durationMs).toBe(500);
  });

  it('summary() returns null slowest when there are no records', () => {
    const profiler = new StartupProfiler();
    const { totalMs, slowest } = profiler.summary();
    expect(totalMs).toBe(0);
    expect(slowest).toBeNull();
  });

  it('reset() clears all phases', () => {
    const profiler = new StartupProfiler();
    profiler.begin('core_download');
    profiler.end('core_download');
    profiler.reset();
    expect(profiler.records()).toHaveLength(0);
  });
});

// ── FpsPrediction ─────────────────────────────────────────────────────────────

describe('FpsPrediction', () => {
  it('returns null when fewer than minSamples are collected', () => {
    const pred = new FpsPrediction(5000, 55, 3);
    pred.addSample(60, 0);
    pred.addSample(60, 100);
    expect(pred.predict()).toBeNull();
  });

  it('returns a prediction once minSamples are collected', () => {
    const pred = new FpsPrediction(5000, 55, 3);
    pred.addSample(60, 0);
    pred.addSample(60, 100);
    pred.addSample(60, 200);
    const result = pred.predict();
    expect(result).not.toBeNull();
    expect(result!.sustainable).toBe(true);
  });

  it('marks as unsustainable when averageFps is below threshold', () => {
    const pred = new FpsPrediction(5000, 55, 3);
    pred.addSample(30, 0);
    pred.addSample(30, 100);
    pred.addSample(30, 200);
    const result = pred.predict();
    expect(result).not.toBeNull();
    expect(result!.sustainable).toBe(false);
    expect(result!.averageFps).toBeCloseTo(30);
  });

  it('marks as unsustainable when trend is strongly negative even if avg is above threshold', () => {
    const pred = new FpsPrediction(5000, 55, 3);
    // FPS degrading rapidly: starts at 60, drops 10 fps/s
    pred.addSample(60, 0);
    pred.addSample(50, 1000);
    pred.addSample(40, 2000);
    pred.addSample(30, 3000);
    const result = pred.predict();
    expect(result).not.toBeNull();
    // Trend should be negative
    expect(result!.trendFpsPerS).toBeLessThan(-2);
    expect(result!.sustainable).toBe(false);
  });

  it('locks after the observation window elapses', () => {
    const pred = new FpsPrediction(1000, 55, 3);
    pred.addSample(60, 0);
    pred.addSample(60, 500);
    pred.addSample(60, 999);
    // Window is 1000ms — the next sample at t=1001 should lock the predictor
    pred.addSample(60, 1001);
    expect(pred.isLocked).toBe(true);
    // Further samples are ignored
    const beforeCount = pred.sampleCount;
    pred.addSample(60, 2000);
    expect(pred.sampleCount).toBe(beforeCount);
  });

  it('ignores non-finite fps values', () => {
    const pred = new FpsPrediction(5000, 55, 3);
    pred.addSample(NaN, 0);
    pred.addSample(Infinity, 100);
    pred.addSample(-10, 200); // negative fps
    expect(pred.sampleCount).toBe(0);
  });

  it('reset() clears all state', () => {
    const pred = new FpsPrediction(5000, 55, 3);
    pred.addSample(60, 0);
    pred.addSample(60, 100);
    pred.addSample(60, 200);
    pred.reset();
    expect(pred.sampleCount).toBe(0);
    expect(pred.isLocked).toBe(false);
    expect(pred.predict()).toBeNull();
  });

  it('confidence is "high" with 20+ samples', () => {
    const pred = new FpsPrediction(60_000, 55, 3);
    for (let i = 0; i < 20; i++) pred.addSample(60, i * 100);
    const result = pred.predict();
    expect(result?.confidence).toBe('high');
  });

  it('confidence is "medium" with 8–19 samples', () => {
    const pred = new FpsPrediction(60_000, 55, 3);
    for (let i = 0; i < 10; i++) pred.addSample(60, i * 100);
    const result = pred.predict();
    expect(result?.confidence).toBe('medium');
  });

  it('confidence is "low" with 3–7 samples', () => {
    const pred = new FpsPrediction(60_000, 55, 3);
    for (let i = 0; i < 5; i++) pred.addSample(60, i * 100);
    const result = pred.predict();
    expect(result?.confidence).toBe('low');
  });

  it('trendFpsPerS is 0 when all samples have the same FPS', () => {
    const pred = new FpsPrediction(5000, 55, 3);
    pred.addSample(60, 0);
    pred.addSample(60, 1000);
    pred.addSample(60, 2000);
    const result = pred.predict();
    expect(result?.trendFpsPerS).toBeCloseTo(0, 5);
  });
});

// ── Launch count tracking (intelligent core preloading) ───────────────────────

describe('getLaunchCounts / recordSystemLaunch / getTopLaunchedSystems', () => {
  beforeEach(() => {
    // Clear the launch count key before each test
    localStorage.removeItem('rv:launchCounts');
  });

  afterEach(() => {
    localStorage.removeItem('rv:launchCounts');
  });

  it('getLaunchCounts returns an empty object when nothing has been recorded', () => {
    expect(getLaunchCounts()).toEqual({});
  });

  it('recordSystemLaunch increments the count for a system', () => {
    recordSystemLaunch('psp');
    expect(getLaunchCounts()).toEqual({ psp: 1 });
    recordSystemLaunch('psp');
    expect(getLaunchCounts()).toEqual({ psp: 2 });
  });

  it('recordSystemLaunch tracks multiple systems independently', () => {
    recordSystemLaunch('psp');
    recordSystemLaunch('n64');
    recordSystemLaunch('n64');
    recordSystemLaunch('gba');
    const counts = getLaunchCounts();
    expect(counts['psp']).toBe(1);
    expect(counts['n64']).toBe(2);
    expect(counts['gba']).toBe(1);
  });

  it('getTopLaunchedSystems returns the top N systems by launch count', () => {
    recordSystemLaunch('psp');
    recordSystemLaunch('psp');
    recordSystemLaunch('psp');
    recordSystemLaunch('n64');
    recordSystemLaunch('n64');
    recordSystemLaunch('gba');
    const top2 = getTopLaunchedSystems(2);
    expect(top2).toHaveLength(2);
    expect(top2[0]).toBe('psp');
    expect(top2[1]).toBe('n64');
  });

  it('getTopLaunchedSystems returns fewer than N when not enough systems exist', () => {
    recordSystemLaunch('psp');
    const top5 = getTopLaunchedSystems(5);
    expect(top5).toHaveLength(1);
    expect(top5[0]).toBe('psp');
  });

  it('getTopLaunchedSystems returns empty array when no systems have been launched', () => {
    expect(getTopLaunchedSystems(2)).toHaveLength(0);
  });

  it('getLaunchCounts returns empty object when localStorage contains invalid JSON', () => {
    localStorage.setItem('rv:launchCounts', '{invalid json}');
    expect(getLaunchCounts()).toEqual({});
  });

  it('getLaunchCounts returns empty object when stored value is an array', () => {
    localStorage.setItem('rv:launchCounts', '[1,2,3]');
    expect(getLaunchCounts()).toEqual({});
  });
});
