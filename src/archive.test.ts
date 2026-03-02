import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  detectArchiveFormat,
  extractFromZip,
  isArchiveExtension,
  ARCHIVE_SUPPORT_NOTE,
  type ArchiveFormat,
} from './archive';

// ── ZIP binary builder ────────────────────────────────────────────────────────

/**
 * Write a little-endian 16-bit value into a DataView.
 */
function writeUint16LE(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

/**
 * Write a little-endian 32-bit value into a DataView.
 */
function writeUint32LE(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

/**
 * Build a minimal ZIP archive containing a single stored (uncompressed) entry.
 *
 * @param fileName     Name for the entry inside the archive.
 * @param data         Raw bytes of the entry's content.
 * @param compression  ZIP compression method (0 = stored, 8 = deflate, other = custom).
 */
function buildZip(
  fileName: string,
  data: Uint8Array,
  compression = 0,
): ArrayBuffer {
  const nameBytes = new TextEncoder().encode(fileName);
  const nameLen   = nameBytes.length;
  const dataLen   = data.length;

  // Sizes of each section
  const localHeaderSize   = 30 + nameLen;
  const centralEntrySize  = 46 + nameLen;
  const eocdSize          = 22;

  const totalSize = localHeaderSize + dataLen + centralEntrySize + eocdSize;
  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  let pos = 0;

  // ── Local file header ─────────────────────────────────────────────────────
  writeUint32LE(view, pos,      0x04034b50); // signature
  writeUint16LE(view, pos + 4,  20);          // version needed
  writeUint16LE(view, pos + 6,  0);           // general purpose flags
  writeUint16LE(view, pos + 8,  compression); // compression method
  writeUint16LE(view, pos + 10, 0);           // last mod time
  writeUint16LE(view, pos + 12, 0);           // last mod date
  writeUint32LE(view, pos + 14, 0);           // CRC-32
  writeUint32LE(view, pos + 18, dataLen);     // compressed size
  writeUint32LE(view, pos + 22, dataLen);     // uncompressed size
  writeUint16LE(view, pos + 26, nameLen);     // file name length
  writeUint16LE(view, pos + 28, 0);           // extra field length
  bytes.set(nameBytes, pos + 30);
  pos += localHeaderSize;

  // ── File data ─────────────────────────────────────────────────────────────
  const dataOffset = pos;
  bytes.set(data, pos);
  pos += dataLen;

  // ── Central directory entry ───────────────────────────────────────────────
  const centralOffset = pos;
  writeUint32LE(view, pos,      0x02014b50); // signature
  writeUint16LE(view, pos + 4,  20);          // version made by
  writeUint16LE(view, pos + 6,  20);          // version needed
  writeUint16LE(view, pos + 8,  0);           // general purpose flags
  writeUint16LE(view, pos + 10, compression); // compression method
  writeUint16LE(view, pos + 12, 0);           // last mod time
  writeUint16LE(view, pos + 14, 0);           // last mod date
  writeUint32LE(view, pos + 16, 0);           // CRC-32
  writeUint32LE(view, pos + 20, dataLen);     // compressed size
  writeUint32LE(view, pos + 24, dataLen);     // uncompressed size
  writeUint16LE(view, pos + 28, nameLen);     // file name length
  writeUint16LE(view, pos + 30, 0);           // extra field length
  writeUint16LE(view, pos + 32, 0);           // comment length
  writeUint16LE(view, pos + 34, 0);           // disk start
  writeUint16LE(view, pos + 36, 0);           // internal attrs
  writeUint32LE(view, pos + 38, 0);           // external attrs
  writeUint32LE(view, pos + 42, 0);           // local header offset
  bytes.set(nameBytes, pos + 46);
  pos += centralEntrySize;

  // ── End of central directory ──────────────────────────────────────────────
  const cdSize = centralEntrySize;
  writeUint32LE(view, pos,      0x06054b50); // signature
  writeUint16LE(view, pos + 4,  0);           // disk number
  writeUint16LE(view, pos + 6,  0);           // start disk
  writeUint16LE(view, pos + 8,  1);           // entries on this disk
  writeUint16LE(view, pos + 10, 1);           // total entries
  writeUint32LE(view, pos + 12, cdSize);      // central dir size
  writeUint32LE(view, pos + 16, centralOffset); // central dir offset
  writeUint16LE(view, pos + 20, 0);           // comment length

  // suppress unused variable warning
  void dataOffset;

  return buf;
}

/**
 * Build a ZIP containing two entries: one non-ROM file and one ROM file.
 * Used to verify that the extractor prefers ROM-extension files.
 */
function buildZipWithTwoEntries(
  firstName: string, firstData: Uint8Array,
  secondName: string, secondData: Uint8Array,
): ArrayBuffer {
  const enc = new TextEncoder();
  const name1 = enc.encode(firstName);
  const name2 = enc.encode(secondName);

  const lh1Size  = 30 + name1.length;
  const lh2Size  = 30 + name2.length;
  const cd1Size  = 46 + name1.length;
  const cd2Size  = 46 + name2.length;
  const eocdSize = 22;

  const total = lh1Size + firstData.length + lh2Size + secondData.length + cd1Size + cd2Size + eocdSize;
  const buf   = new ArrayBuffer(total);
  const view  = new DataView(buf);
  const bytes = new Uint8Array(buf);

  let pos = 0;

  const writeEntry = (nameBytes: Uint8Array, data: Uint8Array, _headerOffset: number): number => {
    const lhBase = pos;
    writeUint32LE(view, pos,      0x04034b50);
    writeUint16LE(view, pos + 4,  20);
    writeUint16LE(view, pos + 6,  0);
    writeUint16LE(view, pos + 8,  0); // stored
    writeUint16LE(view, pos + 10, 0);
    writeUint16LE(view, pos + 12, 0);
    writeUint32LE(view, pos + 14, 0);
    writeUint32LE(view, pos + 18, data.length);
    writeUint32LE(view, pos + 22, data.length);
    writeUint16LE(view, pos + 26, nameBytes.length);
    writeUint16LE(view, pos + 28, 0);
    bytes.set(nameBytes, pos + 30);
    pos += 30 + nameBytes.length;
    bytes.set(data, pos);
    pos += data.length;
    return lhBase;
  };

  const lhOffset1 = writeEntry(name1, firstData, 0);
  const lhOffset2 = writeEntry(name2, secondData, 0);

  const cdStart = pos;
  const writeCd = (nameBytes: Uint8Array, data: Uint8Array, lhOffset: number): void => {
    writeUint32LE(view, pos,      0x02014b50);
    writeUint16LE(view, pos + 4,  20);
    writeUint16LE(view, pos + 6,  20);
    writeUint16LE(view, pos + 8,  0);
    writeUint16LE(view, pos + 10, 0);
    writeUint16LE(view, pos + 12, 0);
    writeUint16LE(view, pos + 14, 0);
    writeUint32LE(view, pos + 16, 0);
    writeUint32LE(view, pos + 20, data.length);
    writeUint32LE(view, pos + 24, data.length);
    writeUint16LE(view, pos + 28, nameBytes.length);
    writeUint16LE(view, pos + 30, 0);
    writeUint16LE(view, pos + 32, 0);
    writeUint16LE(view, pos + 34, 0);
    writeUint16LE(view, pos + 36, 0);
    writeUint32LE(view, pos + 38, 0);
    writeUint32LE(view, pos + 42, lhOffset);
    bytes.set(nameBytes, pos + 46);
    pos += 46 + nameBytes.length;
  };

  writeCd(name1, firstData, lhOffset1);
  writeCd(name2, secondData, lhOffset2);

  const cdSize = pos - cdStart;
  writeUint32LE(view, pos,      0x06054b50);
  writeUint16LE(view, pos + 4,  0);
  writeUint16LE(view, pos + 6,  0);
  writeUint16LE(view, pos + 8,  2);
  writeUint16LE(view, pos + 10, 2);
  writeUint32LE(view, pos + 12, cdSize);
  writeUint32LE(view, pos + 16, cdStart);
  writeUint16LE(view, pos + 20, 0);

  return buf;
}

// ── detectArchiveFormat ───────────────────────────────────────────────────────

describe('detectArchiveFormat', () => {
  it('returns "zip" for a valid ZIP header', async () => {
    const zip = buildZip('game.nes', new Uint8Array([1, 2, 3]));
    const blob = new Blob([zip]);
    expect(await detectArchiveFormat(blob)).toBe<ArchiveFormat>('zip');
  });

  it('returns "7z" for a 7-Zip header', async () => {
    // 7z magic: 0x37 0x7A 0xBC 0xAF 0x27 0x1C
    const sevenZBytes = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0]);
    const blob = new Blob([sevenZBytes]);
    expect(await detectArchiveFormat(blob)).toBe<ArchiveFormat>('7z');
  });

  it('returns "unknown" for an unrecognised header', async () => {
    const blob = new Blob([new Uint8Array([0xde, 0xad, 0xbe, 0xef])]);
    expect(await detectArchiveFormat(blob)).toBe<ArchiveFormat>('unknown');
  });

  it('returns "unknown" for an empty blob', async () => {
    const blob = new Blob([new Uint8Array([1, 2])]);
    expect(await detectArchiveFormat(blob)).toBe<ArchiveFormat>('unknown');
  });
});

// ── isArchiveExtension ────────────────────────────────────────────────────────

describe('isArchiveExtension', () => {
  it('returns true for "zip"', () => {
    expect(isArchiveExtension('zip')).toBe(true);
  });

  it('returns true for "7z"', () => {
    expect(isArchiveExtension('7z')).toBe(true);
  });

  it('returns false for ROM extensions', () => {
    expect(isArchiveExtension('nes')).toBe(false);
    expect(isArchiveExtension('sfc')).toBe(false);
    expect(isArchiveExtension('gba')).toBe(false);
  });

  it('returns false for arbitrary strings', () => {
    expect(isArchiveExtension('pdf')).toBe(false);
    expect(isArchiveExtension('')).toBe(false);
  });
});

// ── ARCHIVE_SUPPORT_NOTE ──────────────────────────────────────────────────────

describe('ARCHIVE_SUPPORT_NOTE', () => {
  it('mentions ZIP extraction', () => {
    expect(ARCHIVE_SUPPORT_NOTE).toContain('ZIP');
  });

  it('mentions 7-Zip limitation', () => {
    expect(ARCHIVE_SUPPORT_NOTE).toContain('7');
  });
});

// ── extractFromZip ────────────────────────────────────────────────────────────

describe('extractFromZip', () => {
  it('returns null for non-ZIP data', async () => {
    const blob = new Blob([new Uint8Array([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4])]);
    expect(await extractFromZip(blob)).toBeNull();
  });

  it('extracts a stored (uncompressed) file by name', async () => {
    const content  = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const zipBuf   = buildZip('game.nes', content);
    const blob     = new Blob([zipBuf]);

    const result = await extractFromZip(blob);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.nes');

    const extracted = new Uint8Array(await result!.blob.arrayBuffer());
    expect(extracted).toEqual(content);
  });

  it('prefers a ROM-extension file over a non-ROM file', async () => {
    const readmeData = new Uint8Array([0x52, 0x45, 0x41, 0x44]); // "READ"
    const romData    = new Uint8Array([0x4e, 0x45, 0x53, 0x1a]); // NES header magic

    const zipBuf = buildZipWithTwoEntries(
      'readme.txt', readmeData,
      'game.nes',   romData,
    );
    const blob   = new Blob([zipBuf]);

    const result = await extractFromZip(blob);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.nes');
  });

  it('returns null when no ROM-extension entry exists in the ZIP', async () => {
    const content = new Uint8Array([1, 2, 3]);
    const zipBuf  = buildZip('unknown.xyz', content);
    const blob    = new Blob([zipBuf]);

    const result = await extractFromZip(blob);
    expect(result).toBeNull();
  });

  it('does not treat nested archive files as extractable ROM targets', async () => {
    const textData = new Uint8Array([0x4f, 0x4b]); // "OK"
    const zipData  = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // nested zip header bytes

    const zipBuf = buildZipWithTwoEntries(
      'notes.txt', textData,
      'set.zip',   zipData,
    );
    const blob = new Blob([zipBuf]);

    const result = await extractFromZip(blob);
    expect(result).toBeNull();
  });

  it('returns just the filename component (strips path prefix)', async () => {
    const content = new Uint8Array([1, 2, 3]);
    const zipBuf  = buildZip('roms/subdir/game.gba', content);
    const blob    = new Blob([zipBuf]);

    const result = await extractFromZip(blob);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.gba');
  });

  it('skips directory entries and returns null when only directories exist', async () => {
    // A directory entry has uncompressedSize = 0 and name ending with "/"
    const enc       = new TextEncoder();
    const dirName   = enc.encode('roms/');
    const nameLen   = dirName.length;
    const lhSize    = 30 + nameLen;
    const cdSize    = 46 + nameLen;
    const eocdSize  = 22;

    const buf   = new ArrayBuffer(lhSize + cdSize + eocdSize);
    const view  = new DataView(buf);
    const bytes = new Uint8Array(buf);

    // Local header for directory (size = 0)
    writeUint32LE(view, 0,  0x04034b50);
    writeUint16LE(view, 4,  20);
    writeUint16LE(view, 6,  0);
    writeUint16LE(view, 8,  0);
    writeUint16LE(view, 10, 0);
    writeUint16LE(view, 12, 0);
    writeUint32LE(view, 14, 0);
    writeUint32LE(view, 18, 0); // compressed size 0
    writeUint32LE(view, 22, 0); // uncompressed size 0
    writeUint16LE(view, 26, nameLen);
    writeUint16LE(view, 28, 0);
    bytes.set(dirName, 30);

    const cdOffset = lhSize;
    let pos = cdOffset;
    writeUint32LE(view, pos,      0x02014b50);
    writeUint16LE(view, pos + 4,  20);
    writeUint16LE(view, pos + 6,  20);
    writeUint16LE(view, pos + 8,  0);
    writeUint16LE(view, pos + 10, 0);
    writeUint16LE(view, pos + 12, 0);
    writeUint16LE(view, pos + 14, 0);
    writeUint32LE(view, pos + 16, 0);
    writeUint32LE(view, pos + 20, 0);
    writeUint32LE(view, pos + 24, 0);
    writeUint16LE(view, pos + 28, nameLen);
    writeUint16LE(view, pos + 30, 0);
    writeUint16LE(view, pos + 32, 0);
    writeUint16LE(view, pos + 34, 0);
    writeUint16LE(view, pos + 36, 0);
    writeUint32LE(view, pos + 38, 0);
    writeUint32LE(view, pos + 42, 0);
    bytes.set(dirName, pos + 46);
    pos += cdSize;

    writeUint32LE(view, pos,      0x06054b50);
    writeUint16LE(view, pos + 4,  0);
    writeUint16LE(view, pos + 6,  0);
    writeUint16LE(view, pos + 8,  1);
    writeUint16LE(view, pos + 10, 1);
    writeUint32LE(view, pos + 12, cdSize);
    writeUint32LE(view, pos + 16, cdOffset);
    writeUint16LE(view, pos + 20, 0);

    const result = await extractFromZip(new Blob([buf]));
    expect(result).toBeNull();
  });

  it('throws when the compression method is unsupported', async () => {
    const content = new Uint8Array([1, 2, 3]);
    // Method 1 = Shrunk (unsupported)
    const zipBuf = buildZip('game.nes', content, 1);
    const blob   = new Blob([zipBuf]);

    await expect(extractFromZip(blob)).rejects.toThrow('Unsupported ZIP compression method');
  });

  it('throws when DecompressionStream is absent and the entry is deflate-compressed', async () => {
    // Temporarily remove DecompressionStream from the global scope
    const original = globalThis.DecompressionStream;
    // @ts-expect-error intentionally removing global for test
    delete globalThis.DecompressionStream;

    const content = new Uint8Array([1, 2, 3]);
    // Method 8 = deflate
    const zipBuf  = buildZip('game.nes', content, 8);
    const blob    = new Blob([zipBuf]);

    try {
      await expect(extractFromZip(blob)).rejects.toThrow('DecompressionStream');
    } finally {
      globalThis.DecompressionStream = original;
    }
  });

  it('returns null for a blob smaller than a valid ZIP', async () => {
    const blob = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])]);
    expect(await extractFromZip(blob)).toBeNull();
  });

  describe('with DecompressionStream', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('extracts a deflate-compressed entry using DecompressionStream', async () => {
      const originalContent = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"

      // Mock DecompressionStream to pass data through unmodified
      const mockReadable = {
        getReader: () => {
          let done = false;
          return {
            read: async () => {
              if (done) return { value: undefined, done: true };
              done = true;
              return { value: originalContent, done: false };
            },
          };
        },
      };
      const mockWritable = {
        getWriter: () => ({
          write: async (_chunk: Uint8Array) => { /* passthrough */ },
          close: async () => { /* no-op */ },
        }),
      };

      vi.stubGlobal('DecompressionStream', class {
        get readable() { return mockReadable; }
        get writable() { return mockWritable; }
      });

      const zipBuf = buildZip('game.nes', originalContent, 8); // method 8 = deflate
      const result = await extractFromZip(new Blob([zipBuf]));

      expect(result).not.toBeNull();
      expect(result!.name).toBe('game.nes');
      const extracted = new Uint8Array(await result!.blob.arrayBuffer());
      expect(extracted).toEqual(originalContent);
    });
  });
});
