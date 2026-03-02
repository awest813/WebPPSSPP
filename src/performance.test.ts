import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  detectCapabilities,
  isLikelyChromeOS,
  prefersReducedMotion,
  checkBatteryStatus,
  formatCapabilitiesSummary,
  formatDetailedSummary,
} from './performance';

describe('performance', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});
