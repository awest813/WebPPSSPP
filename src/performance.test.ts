import { describe, it, expect } from 'vitest';
import {
  resolveMode,
  resolveTier,
  formatTierLabel,
  formatCapabilitiesSummary,
  type DeviceCapabilities,
  type PerformanceTier,
} from './performance';

// Minimal DeviceCapabilities stub for unit testing pure utility functions.
function makeCaps(
  tier: PerformanceTier,
  recommendedMode: 'performance' | 'quality' = 'quality',
  isLowSpec = false,
): DeviceCapabilities {
  return {
    deviceMemoryGB: 8,
    cpuCores: 8,
    gpuRenderer: 'Test GPU',
    isSoftwareGPU: false,
    isLowSpec,
    recommendedMode,
    tier,
    gpuBenchmarkScore: 75,
    gpuCaps: {
      renderer: 'Test GPU',
      vendor: 'Test Vendor',
      maxTextureSize: 8192,
      maxVertexAttribs: 16,
      maxVaryingVectors: 30,
      maxRenderbufferSize: 8192,
      anisotropicFiltering: true,
      maxAnisotropy: 16,
      floatTextures: true,
      instancedArrays: true,
      webgl2: true,
    },
  };
}

describe('resolveMode', () => {
  it('returns the recommended mode when set to auto', () => {
    expect(resolveMode('auto', makeCaps('high', 'quality'))).toBe('quality');
    expect(resolveMode('auto', makeCaps('low', 'performance', true))).toBe('performance');
  });

  it('always returns performance when explicitly set to performance', () => {
    expect(resolveMode('performance', makeCaps('ultra', 'quality'))).toBe('performance');
    expect(resolveMode('performance', makeCaps('low', 'performance'))).toBe('performance');
  });

  it('always returns quality when explicitly set to quality', () => {
    expect(resolveMode('quality', makeCaps('low', 'performance', true))).toBe('quality');
    expect(resolveMode('quality', makeCaps('high', 'quality'))).toBe('quality');
  });
});

describe('resolveTier', () => {
  it('returns the detected tier in auto mode', () => {
    expect(resolveTier('auto', makeCaps('ultra'))).toBe('ultra');
    expect(resolveTier('auto', makeCaps('high'))).toBe('high');
    expect(resolveTier('auto', makeCaps('medium'))).toBe('medium');
    expect(resolveTier('auto', makeCaps('low'))).toBe('low');
  });

  it('always returns low in performance mode', () => {
    expect(resolveTier('performance', makeCaps('ultra'))).toBe('low');
    expect(resolveTier('performance', makeCaps('medium'))).toBe('low');
  });

  it('returns ultra in quality mode when the detected tier is ultra', () => {
    expect(resolveTier('quality', makeCaps('ultra'))).toBe('ultra');
  });

  it('clamps to high in quality mode for tiers below ultra', () => {
    expect(resolveTier('quality', makeCaps('high'))).toBe('high');
    expect(resolveTier('quality', makeCaps('medium'))).toBe('high');
    expect(resolveTier('quality', makeCaps('low'))).toBe('high');
  });
});

describe('formatTierLabel', () => {
  it('returns the correct capitalised label for each tier', () => {
    expect(formatTierLabel('low')).toBe('Low');
    expect(formatTierLabel('medium')).toBe('Medium');
    expect(formatTierLabel('high')).toBe('High');
    expect(formatTierLabel('ultra')).toBe('Ultra');
  });
});

describe('formatCapabilitiesSummary', () => {
  it('includes RAM, CPU core count, and GPU renderer', () => {
    const caps = makeCaps('high');
    const summary = formatCapabilitiesSummary(caps);
    expect(summary).toContain('8 GB RAM');
    expect(summary).toContain('8 CPU cores');
    expect(summary).toContain('Test GPU');
  });

  it('falls back gracefully when RAM is unknown', () => {
    const caps = { ...makeCaps('medium'), deviceMemoryGB: null };
    const summary = formatCapabilitiesSummary(caps);
    expect(summary).toContain('RAM unknown');
  });

  it('labels software GPUs clearly', () => {
    const caps = { ...makeCaps('low'), isSoftwareGPU: true };
    const summary = formatCapabilitiesSummary(caps);
    expect(summary).toContain('Software GPU');
  });

  it('uses singular "core" for a single CPU core', () => {
    const caps = { ...makeCaps('low'), cpuCores: 1 };
    const summary = formatCapabilitiesSummary(caps);
    expect(summary).toContain('1 CPU core');
    expect(summary).not.toContain('1 CPU cores');
  });
});
