import { describe, it, expect } from 'vitest';
import { formatBytes } from './library';

describe('formatBytes', () => {
  it('formats 0 bytes correctly', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes less than 1 KB correctly', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats exactly 1 KB correctly', () => {
    expect(formatBytes(1024)).toBe('1 KB');
  });

  it('formats bytes between 1 KB and 1 MB correctly', () => {
    expect(formatBytes(1536)).toBe('2 KB'); // 1.5 KB rounded to 2 KB by toFixed(0)
    expect(formatBytes(1048575)).toBe('1024 KB');
  });

  it('formats exactly 1 MB correctly', () => {
    expect(formatBytes(1048576)).toBe('1.0 MB');
  });

  it('formats bytes between 1 MB and 1 GB correctly', () => {
    expect(formatBytes(1572864)).toBe('1.5 MB');
    expect(formatBytes(1073741823)).toBe('1024.0 MB');
  });

  it('formats exactly 1 GB correctly', () => {
    expect(formatBytes(1073741824)).toBe('1.0 GB');
  });

  it('formats very large values correctly', () => {
    expect(formatBytes(1610612736)).toBe('1.5 GB');
    expect(formatBytes(10737418240)).toBe('10.0 GB');
  });
});
