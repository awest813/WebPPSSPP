import { describe, expect, it, vi, afterEach } from 'vitest';
import { detectCapabilities } from './performance';

describe('performance', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles WebGL renderer exception gracefully', () => {
    // Mock document.createElement to throw when creating a canvas
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
});
