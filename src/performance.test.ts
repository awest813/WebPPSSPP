// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectCapabilities } from './performance';

describe('Performance capabilities detection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles WebGL renderer exception gracefully', () => {
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          getContext: () => {
            throw new Error('WebGL not supported or blocked');
          },
          width: 0,
          height: 0,
        } as unknown as HTMLCanvasElement;
      }
      return originalCreateElement(tagName) as any;
    });

    const caps = detectCapabilities();

    expect(caps.gpuRenderer).toBe('unknown');
    expect(caps.gpuBenchmarkScore).toBe(0);
  });
});
