import { describe, it, expect, vi, afterEach } from "vitest";
import {
  detectArchiveFormat,
  extractFromArchive,
  extractFromGzip,
  extractFromTar,
  extractFromZip,
  isArchiveExtension,
  ARCHIVE_SUPPORT_NOTE,
  type ArchiveFormat,
} from "./archive.js";

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

function patchSingleEntrySizes(
  zipBuf: ArrayBuffer,
  fileName: string,
  sizes: { uncompressedSize?: number },
): ArrayBuffer {
  const copy = zipBuf.slice(0);
  const view = new DataView(copy);
  const nameLen = new TextEncoder().encode(fileName).length;
  const currentCompressedSize = view.getUint32(18, true);

  if (sizes.uncompressedSize !== undefined) {
    view.setUint32(22, sizes.uncompressedSize, true);
  }

  const centralOffset = (30 + nameLen) + currentCompressedSize;
  if (sizes.uncompressedSize !== undefined) {
    view.setUint32(centralOffset + 24, sizes.uncompressedSize, true);
  }

  return copy;
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

/**
 * Build a minimal TAR archive with provided file entries.
 */
function buildTar(entries: Array<{ name: string; data: Uint8Array }>): ArrayBuffer {
  const blocks: Uint8Array[] = [];
  const encoder = new TextEncoder();

  const writeOctal = (header: Uint8Array, start: number, length: number, value: number): void => {
    const oct = value.toString(8).padStart(length - 1, '0');
    const bytes = encoder.encode(oct);
    header.set(bytes.slice(0, length - 1), start);
    header[start + length - 1] = 0;
  };

  for (const entry of entries) {
    const header = new Uint8Array(512);
    const nameBytes = encoder.encode(entry.name);
    header.set(nameBytes.slice(0, 100), 0);

    writeOctal(header, 100, 8, 0o644); // mode
    writeOctal(header, 108, 8, 0);     // uid
    writeOctal(header, 116, 8, 0);     // gid
    writeOctal(header, 124, 12, entry.data.length); // size
    writeOctal(header, 136, 12, 0);    // mtime

    // checksum field initialized with spaces for checksum calculation
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    header[156] = 0x30; // typeflag: regular file

    const magic = encoder.encode('ustar');
    header.set(magic, 257);
    header[262] = 0; // ustar\0
    header[263] = 0x30; // version "00"
    header[264] = 0x30;

    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeOctal(header, 148, 8, checksum);

    blocks.push(header);
    blocks.push(entry.data);

    const pad = (512 - (entry.data.length % 512)) % 512;
    if (pad > 0) blocks.push(new Uint8Array(pad));
  }

  // End of archive: two zero blocks
  blocks.push(new Uint8Array(512));
  blocks.push(new Uint8Array(512));

  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of blocks) {
    out.set(b, offset);
    offset += b.length;
  }
  return out.buffer;
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

  it('returns "rar" for a RAR header', async () => {
    const rarBytes = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0x00]);
    const blob = new Blob([rarBytes]);
    expect(await detectArchiveFormat(blob)).toBe<ArchiveFormat>('rar');
  });

  it('returns "gzip" for a GZIP header', async () => {
    const gzipBytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
    const blob = new Blob([gzipBytes]);
    expect(await detectArchiveFormat(blob)).toBe<ArchiveFormat>('gzip');
  });

  it('returns "bzip2" for a BZIP2 header', async () => {
    const bz2Bytes = new Uint8Array([0x42, 0x5a, 0x68, 0x39]);
    const blob = new Blob([bz2Bytes]);
    expect(await detectArchiveFormat(blob)).toBe<ArchiveFormat>('bzip2');
  });

  it('returns "xz" for an XZ header', async () => {
    const xzBytes = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00]);
    const blob = new Blob([xzBytes]);
    expect(await detectArchiveFormat(blob)).toBe<ArchiveFormat>('xz');
  });

  it('returns "tar" for a TAR header with ustar magic', async () => {
    const tarBytes = new Uint8Array(512);
    tarBytes.set(new TextEncoder().encode('ustar'), 257);
    tarBytes[262] = 0x00;
    const blob = new Blob([tarBytes]);
    expect(await detectArchiveFormat(blob)).toBe<ArchiveFormat>('tar');
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

  it('returns true for "rar"', () => {
    expect(isArchiveExtension('rar')).toBe(true);
  });

  it('returns true for additional archive extensions', () => {
    expect(isArchiveExtension('tar')).toBe(true);
    expect(isArchiveExtension('gz')).toBe(true);
    expect(isArchiveExtension('tgz')).toBe(true);
    expect(isArchiveExtension('bz2')).toBe(true);
    expect(isArchiveExtension('xz')).toBe(true);
    expect(isArchiveExtension('zst')).toBe(true);
    expect(isArchiveExtension('cab')).toBe(true);
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

  it('mentions RAR limitation', () => {
    expect(ARCHIVE_SUPPORT_NOTE).toContain('RAR');
  });

  it('mentions additional archive limitations', () => {
    expect(ARCHIVE_SUPPORT_NOTE).toContain('TAR');
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

  it('throws when stored entry uncompressed size metadata is inconsistent', async () => {
    const content  = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const zipBuf   = buildZip('game.nes', content);
    const broken   = patchSingleEntrySizes(zipBuf, 'game.nes', { uncompressedSize: content.length + 1 });

    await expect(extractFromZip(new Blob([broken]))).rejects.toThrow('ZIP entry size mismatch');
  });

  it('throws when the selected entry exceeds the extraction safety limit', async () => {
    const content  = new Uint8Array([0xaa]);
    const zipBuf   = buildZip('game.nes', content);
    const hugeSize = 600 * 1024 * 1024;
    const broken   = patchSingleEntrySizes(zipBuf, 'game.nes', { uncompressedSize: hugeSize });

    await expect(extractFromZip(new Blob([broken]))).rejects.toThrow('too large to extract in-browser');
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

  it('recognises .64 files as valid ROM entries inside ZIP archives', async () => {
    const noteData = new Uint8Array([0x6e, 0x6f, 0x74, 0x65]); // "note"
    const romData  = new Uint8Array([0x80, 0x37, 0x12, 0x40]); // N64 ROM magic

    const zipBuf = buildZipWithTwoEntries(
      'readme.txt', noteData,
      'mario.64',   romData,
    );

    const result = await extractFromZip(new Blob([zipBuf]));
    expect(result).not.toBeNull();
    expect(result!.name).toBe('mario.64');
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

  it('does not treat zero-byte ROM entries as directories', async () => {
    const zipBuf = buildZip('game.gba', new Uint8Array(0));
    const blob = new Blob([zipBuf]);

    const result = await extractFromZip(blob);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.gba');
    expect(result!.blob.size).toBe(0);
  });

  it('throws when the compression method is unsupported', async () => {
    const content = new Uint8Array([1, 2, 3]);
    // Method 1 = Shrunk (unsupported)
    const zipBuf = buildZip('game.nes', content, 1);
    const blob   = new Blob([zipBuf]);

    await expect(extractFromZip(blob)).rejects.toThrow(/unsupported ZIP compression method/i);
  });

  it('throws with a descriptive message when the local-header offset is the ZIP64 sentinel (0xFFFFFFFF)', async () => {
    // Build a ZIP where the central-directory local-header offset is
    // 0xFFFFFFFF — the ZIP64 extended-offset indicator.  The parser must
    // throw a clear diagnostic instead of silently returning null.
    const enc      = new TextEncoder();
    const fileName = 'game.nes';
    const data     = new Uint8Array([0x4e, 0x45, 0x53, 0x1a]);
    const nameBytes = enc.encode(fileName);
    const nameLen   = nameBytes.length;
    const dataLen   = data.length;

    const lhSize   = 30 + nameLen;
    const cdSize   = 46 + nameLen;
    const eocdSize = 22;
    const buf      = new ArrayBuffer(lhSize + dataLen + cdSize + eocdSize);
    const view     = new DataView(buf);
    const bytes    = new Uint8Array(buf);

    // Local file header at offset 0
    view.setUint32(0,  0x04034b50, true);
    view.setUint16(4,  20, true);
    view.setUint16(6,  0, true);
    view.setUint16(8,  0, true);  // stored
    view.setUint32(18, dataLen, true); // compressed size
    view.setUint32(22, dataLen, true); // uncompressed size
    view.setUint16(26, nameLen, true);
    view.setUint16(28, 0, true);
    bytes.set(nameBytes, 30);
    bytes.set(data, lhSize);

    // Central directory entry — local header offset set to 0xFFFFFFFF (ZIP64 indicator)
    const cdOffset = lhSize + dataLen;
    let p = cdOffset;
    view.setUint32(p,      0x02014b50, true);
    view.setUint16(p + 4,  20, true);
    view.setUint16(p + 6,  20, true);
    view.setUint16(p + 8,  0, true);
    view.setUint16(p + 10, 0, true);
    view.setUint32(p + 20, dataLen, true); // compressed
    view.setUint32(p + 24, dataLen, true); // uncompressed
    view.setUint16(p + 28, nameLen, true);
    view.setUint32(p + 42, 0xffffffff, true); // ← ZIP64 sentinel
    bytes.set(nameBytes, p + 46);
    p += cdSize;

    // EOCD
    view.setUint32(p,      0x06054b50, true);
    view.setUint16(p + 8,  1, true); // entries on disk
    view.setUint16(p + 10, 1, true); // total entries
    view.setUint32(p + 12, cdSize, true);
    view.setUint32(p + 16, cdOffset, true);

    await expect(extractFromZip(new Blob([buf]))).rejects.toThrow('ZIP64');
  });

  it('throws with a Deflate64 message for compression method 9', async () => {
    const content = new Uint8Array([1, 2, 3]);
    const zipBuf  = buildZip('game.nes', content, 9); // method 9 = Deflate64
    await expect(extractFromZip(new Blob([zipBuf]))).rejects.toThrow(/Deflate64/i);
  });

  it('throws with a BZip2 message for compression method 12', async () => {
    const content = new Uint8Array([1, 2, 3]);
    const zipBuf  = buildZip('game.nes', content, 12); // method 12 = BZip2
    await expect(extractFromZip(new Blob([zipBuf]))).rejects.toThrow(/bzip2/i);
  });

  it('throws with an LZMA message for compression method 14', async () => {
    const content = new Uint8Array([1, 2, 3]);
    const zipBuf  = buildZip('game.nes', content, 14); // method 14 = LZMA
    await expect(extractFromZip(new Blob([zipBuf]))).rejects.toThrow(/lzma/i);
  });

  it('resolves ZIP64 extra field sizes in central directory entries', async () => {
    // Build a ZIP where central-directory compressed/uncompressed sizes are
    // 0xFFFFFFFF (ZIP64 sentinels) and real values are in the extra field.
    // We use small actual sizes so the entry is well within safety limits.
    const enc       = new TextEncoder();
    const fileName  = 'game.nes';
    const data      = new Uint8Array([0x4e, 0x45, 0x53, 0x1a]); // NES magic
    const nameBytes = enc.encode(fileName);
    const nameLen   = nameBytes.length;
    const dataLen   = data.length;

    // ZIP64 extra field: tag 0x0001, size 16, two 8-byte values
    // (uncompressed size + compressed size — both 0xFFFFFFFF sentinels)
    const zip64Extra = new Uint8Array(20);
    const exView = new DataView(zip64Extra.buffer);
    exView.setUint16(0, 0x0001, true); // ZIP64 tag
    exView.setUint16(2, 16, true);      // 2 × 8-byte values
    // uncompressed size (real)
    exView.setUint32(4, dataLen, true);
    exView.setUint32(8, 0, true);
    // compressed size (real)
    exView.setUint32(12, dataLen, true);
    exView.setUint32(16, 0, true);

    const extraLen = zip64Extra.length;

    const lhSize   = 30 + nameLen;
    const cdSize   = 46 + nameLen + extraLen;
    const eocdSize = 22;
    const totalSize = lhSize + dataLen + cdSize + eocdSize;

    const buf   = new ArrayBuffer(totalSize);
    const view  = new DataView(buf);
    const bytes = new Uint8Array(buf);

    // Local file header
    view.setUint32(0,  0x04034b50, true);
    view.setUint16(4,  20, true);
    view.setUint32(18, dataLen, true); // compressed size
    view.setUint32(22, dataLen, true); // uncompressed size
    view.setUint16(26, nameLen, true);
    view.setUint16(28, 0, true);
    bytes.set(nameBytes, 30);
    bytes.set(data, lhSize);

    // Central directory entry with 0xFFFFFFFF sentinels + ZIP64 extra field
    const cdOffset = lhSize + dataLen;
    let p = cdOffset;
    view.setUint32(p,      0x02014b50, true);
    view.setUint16(p + 4,  20, true);
    view.setUint16(p + 6,  20, true);
    view.setUint32(p + 20, 0xffffffff, true); // compressed size sentinel
    view.setUint32(p + 24, 0xffffffff, true); // uncompressed size sentinel
    view.setUint16(p + 28, nameLen, true);
    view.setUint16(p + 30, extraLen, true);
    view.setUint32(p + 42, 0, true); // local header offset
    bytes.set(nameBytes, p + 46);
    bytes.set(zip64Extra, p + 46 + nameLen);
    p += cdSize;

    // EOCD
    view.setUint32(p,      0x06054b50, true);
    view.setUint16(p + 8,  1, true);
    view.setUint16(p + 10, 1, true);
    view.setUint32(p + 12, cdSize, true);
    view.setUint32(p + 16, cdOffset, true);

    const result = await extractFromZip(new Blob([buf]));
    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.nes');
    expect(new Uint8Array(await result!.blob.arrayBuffer())).toEqual(data);
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

// ── extractFromTar / extractFromGzip / extractFromArchive ────────────────────

describe('extractFromTar', () => {
  it('extracts a ROM-like entry from TAR archives', async () => {
    const note = new TextEncoder().encode('notes');
    const rom = new Uint8Array([0x4e, 0x45, 0x53, 0x1a]); // NES header
    const tarBuf = buildTar([
      { name: 'README.txt', data: note },
      { name: 'roms/game.nes', data: rom },
    ]);

    const result = await extractFromTar(new Blob([tarBuf]));
    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.nes');
    expect(new Uint8Array(await result!.blob.arrayBuffer())).toEqual(rom);
  });

  it('returns null when TAR has no ROM-like entries', async () => {
    const tarBuf = buildTar([
      { name: 'README.txt', data: new TextEncoder().encode('hello') },
      { name: 'docs/manual.txt', data: new TextEncoder().encode('# docs') },
    ]);

    const result = await extractFromTar(new Blob([tarBuf]));
    expect(result).toBeNull();
  });
});

describe('extractFromGzip', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts an inner TAR payload when gzip decompresses to tar bytes', async () => {
    const tarBuf = buildTar([
      { name: 'game.gba', data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const tarBytes = new Uint8Array(tarBuf);

    const mockReadable = {
      getReader: () => {
        let done = false;
        return {
          read: async () => {
            if (done) return { value: undefined, done: true };
            done = true;
            return { value: tarBytes, done: false };
          },
        };
      },
    };
    const mockWritable = {
      getWriter: () => ({
        write: async (_chunk: Uint8Array) => { /* no-op */ },
        close: async () => { /* no-op */ },
      }),
    };

    vi.stubGlobal('DecompressionStream', class {
      get readable() { return mockReadable; }
      get writable() { return mockWritable; }
    });

    const compressed = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]); // fake gzip bytes
    const result = await extractFromGzip(new Blob([compressed]), 'archive.tgz');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.gba');
  });
});

describe('extractFromArchive', () => {
  it('extracts ZIP archives through the unified entrypoint', async () => {
    const zipBuf = buildZip('game.nes', new Uint8Array([0xaa, 0xbb]));
    const result = await extractFromArchive(new Blob([zipBuf]));
    expect(result).not.toBeNull();
    expect(result!.format).toBe('zip');
    expect(result!.name).toBe('game.nes');
  });

  it('returns candidate list for multi-ROM ZIP archives', async () => {
    const zipBuf = buildZipWithTwoEntries(
      'alpha.nes', new Uint8Array([0xaa]),
      'beta.nes',  new Uint8Array([0xbb]),
    );
    const result = await extractFromArchive(new Blob([zipBuf]));
    expect(result).not.toBeNull();
    expect(result!.format).toBe('zip');
    const names = (result!.candidates ?? []).map(c => c.name);
    expect(names).toContain('alpha.nes');
    expect(names).toContain('beta.nes');
  });

  it('returns null for unsupported formats (bzip2)', async () => {
    const bz = new Uint8Array([0x42, 0x5a, 0x68, 0x39]);
    const result = await extractFromArchive(new Blob([bz]));
    expect(result).toBeNull();
  });

  it('returns candidate list for TAR archives with multiple ROM entries', async () => {
    const tarBuf = buildTar([
      { name: 'alpha.nes', data: new Uint8Array([0xaa]) },
      { name: 'beta.nes', data: new Uint8Array([0xbb]) },
    ]);
    const result = await extractFromArchive(new Blob([tarBuf]));
    expect(result).not.toBeNull();
    expect(result!.format).toBe('tar');
    const names = (result!.candidates ?? []).map(c => c.name);
    expect(names).toContain('alpha.nes');
    expect(names).toContain('beta.nes');
  });

  it('returns ranked candidates for RAR archives with multiple ROM entries', async () => {
    const originalWorker = globalThis.Worker;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;

    class MockWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      constructor(_url: string) {}
      postMessage(_data: ArrayBuffer): void {
        queueMicrotask(() => {
          this.onmessage?.({ data: { t: 2, file: 'readme.txt', data: new Uint8Array([0x52]) } } as MessageEvent);
          this.onmessage?.({ data: { t: 2, file: 'alpha.nes', data: new Uint8Array([0xaa]) } } as MessageEvent);
          this.onmessage?.({ data: { t: 2, file: 'beta.nes', data: new Uint8Array([0xbb]) } } as MessageEvent);
          this.onmessage?.({ data: { t: 1 } } as MessageEvent);
        });
      }
      terminate(): void {}
    }

    vi.stubGlobal('Worker', MockWorker as unknown as typeof Worker);
    URL.createObjectURL = vi.fn(() => 'blob:mock-worker');
    URL.revokeObjectURL = vi.fn();

    try {
      const rarHeader = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0x00]);
      const result = await extractFromArchive(new Blob([rarHeader]));
      expect(result).not.toBeNull();
      expect(result!.format).toBe('rar');
      expect(result!.candidates?.length).toBe(2);
      const names = (result!.candidates ?? []).map(c => c.name);
      expect(names).toContain('alpha.nes');
      expect(names).toContain('beta.nes');
    } finally {
      vi.unstubAllGlobals();
      globalThis.Worker = originalWorker;
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
});

// ── ROM/ISO format-specific extraction ───────────────────────────────────────

describe('extractFromZip — ROM/ISO format coverage', () => {
  // PSP-specific formats
  it('extracts a .iso file (PS1/PSP disc image)', async () => {
    const content = new Uint8Array([0x01, 0x43, 0x44, 0x30, 0x30, 0x31]); // ISO 9660 magic
    const zipBuf  = buildZip('game.iso', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.iso');
    const extracted = new Uint8Array(await result!.blob.arrayBuffer());
    expect(extracted).toEqual(content);
  });

  it('extracts a .cso file (PSP compressed ISO)', async () => {
    // CSO magic: "CISO" = 0x43 0x49 0x53 0x4F
    const content = new Uint8Array([0x43, 0x49, 0x53, 0x4f, 0x00, 0x00]);
    const zipBuf  = buildZip('game.cso', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.cso');
  });

  it('extracts a .pbp file (PSP/PSX executable)', async () => {
    // PBP magic: "\x00PBP"
    const content = new Uint8Array([0x00, 0x50, 0x42, 0x50]);
    const zipBuf  = buildZip('EBOOT.PBP', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    // Path-stripped name returned as lowercase extension
    expect(result!.name.toLowerCase()).toContain('pbp');
  });

  // PS1-specific formats
  it('extracts a .bin file (PS1 raw disc track)', async () => {
    const content = new Uint8Array([0x00, 0xff, 0xff, 0xff]); // typical sync pattern
    const zipBuf  = buildZip('track01.bin', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('track01.bin');
  });

  it('extracts a .chd file (compressed disc image)', async () => {
    // CHD magic: "MComprHD"
    const content = new Uint8Array([0x4d, 0x43, 0x6f, 0x6d, 0x70, 0x72, 0x48, 0x44]);
    const zipBuf  = buildZip('disc.chd', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('disc.chd');
  });

  it('extracts a .cue file (cuesheet)', async () => {
    const content = new TextEncoder().encode('FILE "track01.bin" BINARY\nTRACK 01 MODE2/2352\n');
    const zipBuf  = buildZip('game.cue', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.cue');
  });

  it('extracts a .m3u file (multi-disc playlist)', async () => {
    const content = new TextEncoder().encode('disc1.cue\ndisc2.cue\n');
    const zipBuf  = buildZip('game.m3u', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.m3u');
  });

  // Preference: ISO over readme when both present
  it('prefers .iso over .txt when both are present in the ZIP', async () => {
    const readmeData = new TextEncoder().encode('This is a readme');
    const isoData    = new Uint8Array([0x01, 0x43, 0x44, 0x30, 0x30, 0x31]);

    const zipBuf = buildZipWithTwoEntries(
      'readme.txt', readmeData,
      'game.iso',   isoData,
    );
    const result = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.iso');
  });

  // Preference: CSO over general binary
  it('prefers .cso over a .dat file when both are present', async () => {
    const datData = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const csoData = new Uint8Array([0x43, 0x49, 0x53, 0x4f]);

    const zipBuf = buildZipWithTwoEntries(
      'metadata.dat', datData,
      'game.cso',     csoData,
    );
    const result = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.cso');
  });

  // Path stripping for disc images stored in subdirectories
  it('strips the directory prefix from an ISO stored in a subdirectory', async () => {
    const content = new Uint8Array([0x01, 0x43, 0x44, 0x30]);
    const zipBuf  = buildZip('psp/games/mygame.iso', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('mygame.iso');
  });
});

// ── All-system archive extraction coverage ────────────────────────────────────

describe('extractFromZip — all system format coverage', () => {
  // ── Nintendo DS ─────────────────────────────────────────────────────────────
  it('extracts a .nds file (Nintendo DS ROM)', async () => {
    // NDS ROM header starts with an ARM9 entry point (4 bytes), then title (12 bytes).
    // We use a minimal non-zero header for the test.
    const content = new Uint8Array([0x00, 0x00, 0x00, 0x04, ...new Array<number>(12).fill(0x41)]);
    const zipBuf  = buildZip('pokemon.nds', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('pokemon.nds');
    const extracted = new Uint8Array(await result!.blob.arrayBuffer());
    expect(extracted).toEqual(content);
  });

  it('extracts a .nds file stored in a subdirectory', async () => {
    const content = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const zipBuf  = buildZip('nds/mario.nds', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('mario.nds');
  });

  // ── Nintendo 64 ─────────────────────────────────────────────────────────────
  it('extracts a .z64 file (N64 ROM, big-endian)', async () => {
    // Z64 magic: 0x80 0x37 0x12 0x40
    const content = new Uint8Array([0x80, 0x37, 0x12, 0x40, 0x00, 0x00, 0x00, 0x0f]);
    const zipBuf  = buildZip('zelda.z64', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('zelda.z64');
  });

  it('extracts a .v64 file (N64 ROM, byte-swapped)', async () => {
    // V64 magic: 0x37 0x80 0x40 0x12
    const content = new Uint8Array([0x37, 0x80, 0x40, 0x12]);
    const zipBuf  = buildZip('game.v64', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.v64');
  });

  it('extracts a .n64 file (N64 ROM, little-endian)', async () => {
    // N64 magic: 0x40 0x12 0x37 0x80
    const content = new Uint8Array([0x40, 0x12, 0x37, 0x80]);
    const zipBuf  = buildZip('game.n64', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.n64');
  });

  // ── Game Boy / Game Boy Color ────────────────────────────────────────────────
  it('extracts a .gb file (Game Boy ROM)', async () => {
    // GB ROM header: Nintendo logo starts at 0x104; offset 0 is the entry point.
    const content = new Uint8Array([0x00, 0xc3, 0x50, 0x01]); // NOP; JP 0x0150
    const zipBuf  = buildZip('tetris.gb', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('tetris.gb');
  });

  it('extracts a .gbc file (Game Boy Color ROM)', async () => {
    const content = new Uint8Array([0x00, 0xc3, 0x50, 0x01, 0x80]); // CGB flag at 0x143
    const zipBuf  = buildZip('pokemon_color.gbc', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('pokemon_color.gbc');
  });

  // ── SNES variants ────────────────────────────────────────────────────────────
  it('extracts a .smc file (SNES ROM with copier header)', async () => {
    const content = new Uint8Array(new Array(4).fill(0x55));
    const zipBuf  = buildZip('mario.smc', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('mario.smc');
  });

  it('extracts a .sfc file (SNES ROM, standard)', async () => {
    const content = new Uint8Array(new Array(4).fill(0xaa));
    const zipBuf  = buildZip('zelda.sfc', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('zelda.sfc');
  });

  // ── Sega Genesis / Mega Drive ────────────────────────────────────────────────
  it('extracts a .md file (Sega Mega Drive ROM)', async () => {
    // Mega Drive header starts at 0x100: "SEGA MEGA DRIVE" (or similar).
    const content = new Uint8Array(new Array(8).fill(0x53)); // 'S' repeated
    const zipBuf  = buildZip('sonic.md', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('sonic.md');
  });

  it('extracts a .gen file (Sega Genesis ROM)', async () => {
    const content = new Uint8Array([0x00, 0xff, 0x00, 0xff]);
    const zipBuf  = buildZip('game.gen', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.gen');
  });

  // ── Game Gear / Sega Master System ───────────────────────────────────────────
  it('extracts a .gg file (Game Gear ROM)', async () => {
    const content = new Uint8Array([0x54, 0x4d, 0x52, 0x20]); // "TMR " footer magic
    const zipBuf  = buildZip('sonic_gg.gg', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('sonic_gg.gg');
  });

  it('extracts a .sms file (Sega Master System ROM)', async () => {
    const content = new Uint8Array([0x54, 0x4d, 0x52, 0x20]);
    const zipBuf  = buildZip('alex_kidd.sms', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('alex_kidd.sms');
  });

  // ── Atari systems ────────────────────────────────────────────────────────────
  it('extracts a .a26 file (Atari 2600 ROM)', async () => {
    const content = new Uint8Array([0xf8, 0x60, 0x00, 0x00]);
    const zipBuf  = buildZip('pitfall.a26', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('pitfall.a26');
  });

  it('extracts a .a78 file (Atari 7800 ROM)', async () => {
    // A78 header starts with "ATARI7800" at offset 1
    const content = new Uint8Array([0x00, 0x41, 0x54, 0x41, 0x52, 0x49]);
    const zipBuf  = buildZip('game.a78', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.a78');
  });

  it('extracts a .lnx file (Atari Lynx ROM)', async () => {
    // Lynx header: "LYNX" magic at offset 0
    const content = new Uint8Array([0x4c, 0x59, 0x4e, 0x58]); // "LYNX"
    const zipBuf  = buildZip('game.lnx', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.lnx');
  });

  // ── Neo Geo Pocket ───────────────────────────────────────────────────────────
  it('extracts a .ngp file (Neo Geo Pocket ROM)', async () => {
    const content = new Uint8Array([0x4e, 0x47, 0x50, 0x00]); // "NGP\0"
    const zipBuf  = buildZip('snk.ngp', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('snk.ngp');
  });

  it('extracts a .ngpc file (Neo Geo Pocket Color ROM)', async () => {
    const content = new Uint8Array([0x4e, 0x47, 0x50, 0x10]); // color flag set
    const zipBuf  = buildZip('snk_color.ngpc', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('snk_color.ngpc');
  });

  // ── Dreamcast ────────────────────────────────────────────────────────────────
  it('extracts a .gdi file (Dreamcast GD-ROM image descriptor)', async () => {
    const content = new TextEncoder().encode('3\n1 0 4 2048 track01.bin 0\n');
    const zipBuf  = buildZip('game.gdi', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.gdi');
  });

  it('extracts a .cdi file (Dreamcast disc image)', async () => {
    const content = new Uint8Array([0x00, 0x00, 0x01, 0x00]);
    const zipBuf  = buildZip('game.cdi', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.cdi');
  });

  // ── NES variants ─────────────────────────────────────────────────────────────
  it('extracts a .fds file (Famicom Disk System image)', async () => {
    // FDS magic: "FDS\x1a"
    const content = new Uint8Array([0x46, 0x44, 0x53, 0x1a]);
    const zipBuf  = buildZip('game.fds', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.fds');
  });

  it('extracts a .unf file (UNIF NES ROM format)', async () => {
    // UNIF magic: "UNIF"
    const content = new Uint8Array([0x55, 0x4e, 0x49, 0x46]);
    const zipBuf  = buildZip('mapper.unf', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('mapper.unf');
  });

  // ── PSP ELF ──────────────────────────────────────────────────────────────────
  it('extracts a .elf file (PSP ELF executable)', async () => {
    // ELF magic: 0x7f "ELF"
    const content = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x01, 0x01, 0x01, 0x00]);
    const zipBuf  = buildZip('boot.elf', content);
    const result  = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('boot.elf');
  });

  // ── Cross-system priority — DS vs other formats ───────────────────────────────
  it('extracts .nds when present alongside a .txt readme in the same ZIP', async () => {
    const readmeData = new TextEncoder().encode('Game readme');
    const ndsData    = new Uint8Array([0x00, 0x00, 0x00, 0x04, 0x02]);

    const zipBuf = buildZipWithTwoEntries(
      'readme.txt', readmeData,
      'game.nds',   ndsData,
    );
    const result = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('game.nds');
  });

  it('extracts .z64 when present alongside a .txt readme in the same ZIP', async () => {
    const readmeData = new TextEncoder().encode('N64 readme');
    const romData    = new Uint8Array([0x80, 0x37, 0x12, 0x40]);

    const zipBuf = buildZipWithTwoEntries(
      'readme.txt', readmeData,
      'zelda.z64',  romData,
    );
    const result = await extractFromZip(new Blob([zipBuf]));

    expect(result).not.toBeNull();
    expect(result!.name).toBe('zelda.z64');
  });
});
