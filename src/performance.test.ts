import { describe, expect, it } from 'vitest';
import { resolveMode, DeviceCapabilities, PerformanceMode } from './performance';

describe('resolveMode', () => {
  const mockPerformanceCaps = { recommendedMode: 'performance' } as DeviceCapabilities;
  const mockQualityCaps = { recommendedMode: 'quality' } as DeviceCapabilities;

  it('returns recommendedMode when userMode is "auto"', () => {
    expect(resolveMode('auto', mockPerformanceCaps)).toBe('performance');
    expect(resolveMode('auto', mockQualityCaps)).toBe('quality');
  });

  it('returns "performance" when userMode is "performance", regardless of recommendedMode', () => {
    expect(resolveMode('performance', mockPerformanceCaps)).toBe('performance');
    expect(resolveMode('performance', mockQualityCaps)).toBe('performance');
  });

  it('returns "quality" when userMode is "quality", regardless of recommendedMode', () => {
    expect(resolveMode('quality', mockPerformanceCaps)).toBe('quality');
    expect(resolveMode('quality', mockQualityCaps)).toBe('quality');
  });
});
