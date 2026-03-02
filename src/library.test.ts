import { describe, it, expect } from 'vitest';
import { formatBytes, formatRelativeTime } from './library';

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

describe('formatRelativeTime', () => {
  it('returns "just now" for timestamps less than 1 minute ago', () => {
    expect(formatRelativeTime(Date.now() - 30_000)).toBe('just now');
    expect(formatRelativeTime(Date.now() - 59_999)).toBe('just now');
  });

  it('returns minutes for timestamps 1–59 minutes ago', () => {
    expect(formatRelativeTime(Date.now() - 60_000)).toBe('1m ago');
    expect(formatRelativeTime(Date.now() - 30 * 60_000)).toBe('30m ago');
    expect(formatRelativeTime(Date.now() - 59 * 60_000)).toBe('59m ago');
  });

  it('returns hours for timestamps 1–23 hours ago', () => {
    expect(formatRelativeTime(Date.now() - 3_600_000)).toBe('1h ago');
    expect(formatRelativeTime(Date.now() - 5 * 3_600_000)).toBe('5h ago');
    expect(formatRelativeTime(Date.now() - 23 * 3_600_000)).toBe('23h ago');
  });

  it('returns days for timestamps 1–29 days ago', () => {
    expect(formatRelativeTime(Date.now() - 86_400_000)).toBe('1d ago');
    expect(formatRelativeTime(Date.now() - 7 * 86_400_000)).toBe('7d ago');
    expect(formatRelativeTime(Date.now() - 29 * 86_400_000)).toBe('29d ago');
  });

  it('returns months for timestamps 30+ days ago', () => {
    expect(formatRelativeTime(Date.now() - 30 * 86_400_000)).toBe('1mo ago');
    expect(formatRelativeTime(Date.now() - 60 * 86_400_000)).toBe('2mo ago');
  });
});
