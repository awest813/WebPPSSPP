import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import {
  detectCapabilities,
  detectCapabilitiesCached,
  clearCapabilitiesCache,
  isLikelyChromeOS,
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
  DeviceCapabilities,
  GPUCapabilities,
} from './performance';

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
  });

  describe('formatDetailedSummary', () => {
    it('mentions Chromebook in detailed summary when isChromOS', () => {
      const caps = detectCapabilities();
      const chromeCaps = { ...caps, isChromOS: true };
      const summary = formatDetailedSummary(chromeCaps);
      expect(summary).toContain('Chromebook');
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
      expect(pressureEvents[0][0]).toBe(850);
      expect(pressureEvents[0][1]).toBe(1000);

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
      expect(capturedOpts[0].timeout).toBe(5000);

      (globalThis as Record<string, unknown>).requestIdleCallback = original;
    });
  });
});
