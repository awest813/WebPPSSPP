/**
 * archive.ts — Client-side ROM archive extraction
 *
 * Provides transparent ZIP decompression so users can drop a .zip file
 * containing a ROM and have it extracted automatically before launch or
 * before it is stored in the library.
 *
 * Supported formats
 * -----------------
 * ZIP  — parsed entirely in JS; deflate decompression via the browser's
 *         native DecompressionStream API (Chrome 80+, Firefox 113+, Safari 16.4+).
 *         Falls back gracefully when DecompressionStream is absent (stored/uncompressed
 *         entries still work).
 *
 * 7-Zip (.7z) — treated as a native package format (e.g. arcade sets).
 *
 * RAR / TAR / GZIP / BZIP2 / XZ — identified so UI can show a clear
 *         message instead of generic “unrecognised file type” errors.
 *
 * The extractor prefers files whose extension matches a known ROM type.
 * If none match it returns the first non-directory entry.
 */

import { ALL_EXTENSIONS } from "./systems.js";

// Precomputed set of ROM-compatible extensions (excludes archive formats).
// Built once at module load time to avoid rebuilding on every extractFromZip call.
const _romExtensions = new Set(
  ALL_EXTENSIONS.filter(ext => ext !== "zip" && ext !== "7z")
);

// ── ZIP magic constants ───────────────────────────────────────────────────────

const LOCAL_FILE_MAGIC   = 0x04034b50; // "PK\x03\x04"
const CENTRAL_DIR_MAGIC  = 0x02014b50; // "PK\x01\x02"
const EOCD_MAGIC         = 0x06054b50; // "PK\x05\x06"
const ZIP64_EOCD_MAGIC   = 0x06064b50; // "PK\x06\x06" — handled but not full ZIP64

const COMPRESS_STORED    = 0;
const COMPRESS_DEFLATE   = 8;
const MAX_EXTRACTED_ENTRY_BYTES = 512 * 1024 * 1024;

// ── Internal types ────────────────────────────────────────────────────────────

interface CentralDirEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readUint16LE(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readUint32LE(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

// Shared, stateless decoders — reused across all ZIP filename decodes.
const _utf8Decoder   = new TextDecoder("utf-8", { fatal: true });
const _latin1Decoder = new TextDecoder("latin1");

/**
 * Decode a byte slice as a filename.
 * ZIP filenames should be UTF-8 when the general-purpose bit 11 is set; we
 * attempt UTF-8 first and fall back to Latin-1 for legacy encodings.
 */
function decodeName(bytes: Uint8Array): string {
  try {
    return _utf8Decoder.decode(bytes);
  } catch {
    return _latin1Decoder.decode(bytes);
  }
}

/**
 * Check if an ArrayBuffer starts with ZIP magic bytes.
 */
function hasZipMagic(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false;
  return new DataView(buf).getUint32(0, true) === LOCAL_FILE_MAGIC;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Format of the archive. */
export type ArchiveFormat = "zip" | "7z" | "rar" | "gzip" | "bzip2" | "xz" | "tar" | "unknown";

/**
 * Detect the archive format of a Blob by reading its magic header.
 */
export async function detectArchiveFormat(blob: Blob): Promise<ArchiveFormat> {
  if (blob.size < 4) return "unknown";
  try {
    const header = await blob.slice(0, 600).arrayBuffer();
    const view   = new DataView(header);
    const bytes  = new Uint8Array(header);
    const sig32  = view.getUint32(0, true);
    if (sig32 === LOCAL_FILE_MAGIC) return "zip";
    // 7-zip magic: "7z\xBC\xAF\x27\x1C"
    // Bytes [0x37,'z'=0x7a] read as little-endian uint16 → 0x7a37
    if (view.getUint16(0, true) === 0x7a37 &&
        view.getUint16(2, true) === 0xafbc) return "7z";

    // RAR v1.5+ / v5 signatures:
    // 52 61 72 21 1A 07 00 and 52 61 72 21 1A 07 01 00
    if (bytes.length >= 7 &&
        bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21 &&
        bytes[4] === 0x1a && bytes[5] === 0x07 && (bytes[6] === 0x00 || bytes[6] === 0x01)) {
      return "rar";
    }

    // GZIP signature: 1F 8B
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";

    // BZIP2 signature: 42 5A 68 ("BZh")
    if (bytes.length >= 3 && bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) return "bzip2";

    // XZ signature: FD 37 7A 58 5A 00
    if (bytes.length >= 6 &&
        bytes[0] === 0xfd && bytes[1] === 0x37 && bytes[2] === 0x7a &&
        bytes[3] === 0x58 && bytes[4] === 0x5a && bytes[5] === 0x00) {
      return "xz";
    }

    // TAR magic at offset 257: "ustar" + NUL/space
    if (bytes.length >= 263) {
      const isTar =
        bytes[257] === 0x75 && bytes[258] === 0x73 && bytes[259] === 0x74 &&
        bytes[260] === 0x61 && bytes[261] === 0x72 &&
        (bytes[262] === 0x00 || bytes[262] === 0x20);
      if (isTar) return "tar";
    }
  } catch { /* ignore */ }
  return "unknown";
}

/**
 * Extract the first ROM-compatible file from a ZIP archive.
 *
 * @param blob   The ZIP Blob (may be large — read in one ArrayBuffer call).
 * @returns      Extracted filename + Blob, or null on any failure.
 */
export async function extractFromZip(
  blob: Blob
): Promise<{ name: string; blob: Blob } | null> {
  // Reject archives larger than 2 GB before attempting a full ArrayBuffer read
  // to avoid an OOM crash on low-memory devices.
  const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024;
  if (blob.size > MAX_ZIP_BYTES) {
    throw new Error(
      `ZIP file is too large to extract in-browser (${(blob.size / 1073741824).toFixed(1)} GB). ` +
      `Please extract it manually and drop the ROM file directly.`
    );
  }

  const buffer = await blob.arrayBuffer();
  const view   = new DataView(buffer);
  const bytes  = new Uint8Array(buffer);

  if (!hasZipMagic(buffer)) return null;

  // ── Locate End-of-Central-Directory record ────────────────────────────────
  // EOCD is at least 22 bytes; search backwards from the file end.
  // A ZIP comment of up to 65535 bytes can follow the EOCD.
  const maxSearch = Math.max(0, bytes.length - 22 - 65535);
  let eocdOffset  = -1;

  for (let i = bytes.length - 22; i >= maxSearch; i--) {
    if (readUint32LE(view, i) === EOCD_MAGIC) {
      // Validate that the comment-length field at offset +20 exactly accounts
      // for all remaining bytes. This rejects false-positive EOCD_MAGIC matches
      // that may appear inside a ZIP comment containing the PK\x05\x06 sequence.
      const commentLen = readUint16LE(view, i + 20);
      if (i + 22 + commentLen === bytes.length) {
        eocdOffset = i;
        break;
      }
    }
  }

  if (eocdOffset < 0) return null;

  let centralDirSize   = readUint32LE(view, eocdOffset + 12);
  let centralDirOffset = readUint32LE(view, eocdOffset + 16);

  // ── ZIP64 fallback ────────────────────────────────────────────────────────
  // If the EOCD values are 0xFFFFFFFF, the real values are in the
  // ZIP64 End-of-Central-Directory record located just before the EOCD locator.
  if (centralDirSize === 0xffffffff || centralDirOffset === 0xffffffff) {
    const zip64LocOffset = eocdOffset - 20;
    if (zip64LocOffset >= 0 && readUint32LE(view, zip64LocOffset) === 0x07064b50) {
      const zip64EocdOffset = Number(
        BigInt(readUint32LE(view, zip64LocOffset + 8)) |
        (BigInt(readUint32LE(view, zip64LocOffset + 12)) << 32n)
      );
      if (readUint32LE(view, zip64EocdOffset) === ZIP64_EOCD_MAGIC) {
        // 64-bit fields at known positions — read as two 32-bit LE words
        const readUint64LE = (o: number) =>
          Number(
            BigInt(readUint32LE(view, o)) |
            (BigInt(readUint32LE(view, o + 4)) << 32n)
          );
        centralDirSize   = readUint64LE(zip64EocdOffset + 40);
        centralDirOffset = readUint64LE(zip64EocdOffset + 48);
      }
    }
  }

  // ── Parse central directory ───────────────────────────────────────────────
  const entries: CentralDirEntry[] = [];
  let pos = centralDirOffset;
  const cdEnd = centralDirOffset + centralDirSize;

  while (pos < cdEnd && pos + 46 <= bytes.length) {
    if (readUint32LE(view, pos) !== CENTRAL_DIR_MAGIC) break;

    const compressionMethod  = readUint16LE(view, pos + 10);
    const compressedSize     = readUint32LE(view, pos + 20);
    const uncompressedSize   = readUint32LE(view, pos + 24);
    const fileNameLength     = readUint16LE(view, pos + 28);
    const extraFieldLength   = readUint16LE(view, pos + 30);
    const commentLength      = readUint16LE(view, pos + 32);
    const localHeaderOffset  = readUint32LE(view, pos + 42);

    const nameSlice = bytes.slice(pos + 46, pos + 46 + fileNameLength);
    const name      = decodeName(nameSlice);

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    pos += 46 + fileNameLength + extraFieldLength + commentLength;
  }

  if (entries.length === 0) return null;

  // ── Choose which entry to extract ─────────────────────────────────────────
  // Prefer files whose extension is a known ROM format.
  // Directories end with "/" and are skipped.
  //
  // Intentionally exclude archive extensions from extraction candidates.
  // ZIP/7Z packages may be native ROM containers for arcade sets; picking an
  // inner archive (or an arbitrary non-ROM payload) causes mis-detection.
  const isDir = (e: CentralDirEntry) => e.name.endsWith("/");

  const romCandidates = entries.filter(e => {
    if (isDir(e)) return false;
    const dotIdx = e.name.lastIndexOf(".");
    const ext = dotIdx > 0
      ? e.name.substring(dotIdx + 1).toLowerCase()
      : "";
    return _romExtensions.has(ext);
  });

  // Do not silently fall back to the first arbitrary file when no ROM-like
  // entry exists. Returning null allows callers to decide whether the archive
  // should be treated as a native package (e.g. MAME zip set).
  const target = romCandidates[0] ?? null;

  if (!target) return null;

  if (target.uncompressedSize > MAX_EXTRACTED_ENTRY_BYTES) {
    throw new Error(
      `ZIP entry "${target.name}" is too large to extract in-browser ` +
      `(${(target.uncompressedSize / 1073741824).toFixed(2)} GB).`
    );
  }

  // ── Read local file header to find the compressed data offset ─────────────
  const lhBase = target.localHeaderOffset;
  if (lhBase + 30 > bytes.length) return null;
  if (readUint32LE(view, lhBase) !== LOCAL_FILE_MAGIC) return null;

  const lhFileNameLen = readUint16LE(view, lhBase + 26);
  const lhExtraLen    = readUint16LE(view, lhBase + 28);
  const dataStart     = lhBase + 30 + lhFileNameLen + lhExtraLen;
  const dataEnd2      = dataStart + target.compressedSize;

  if (dataEnd2 > bytes.length) return null;

  const compressedSlice = bytes.slice(dataStart, dataEnd2);

  // ── Decompress ────────────────────────────────────────────────────────────
  let resultBlob: Blob;

  if (target.compressionMethod === COMPRESS_STORED) {
    if (compressedSlice.length !== target.uncompressedSize) {
      throw new Error(
        `ZIP entry size mismatch for "${target.name}" (expected ${target.uncompressedSize} bytes, ` +
        `got ${compressedSlice.length}).`
      );
    }
    resultBlob = new Blob([compressedSlice]);

  } else if (target.compressionMethod === COMPRESS_DEFLATE) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error(
        "Your browser does not support DecompressionStream. " +
        "Please extract the ZIP manually or use Chrome 80+ / Firefox 113+ / Safari 16.4+."
      );
    }
    const ds     = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    await writer.write(compressedSlice);
    await writer.close();

    const chunks: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }

    const totalLen  = chunks.reduce((n, c) => n + c.length, 0);

    if (totalLen !== target.uncompressedSize) {
      throw new Error(
        `ZIP inflate size mismatch for "${target.name}" (expected ${target.uncompressedSize} bytes, got ${totalLen}).`
      );
    }

    const output    = new Uint8Array(totalLen);
    let writeOffset = 0;
    for (const chunk of chunks) {
      output.set(chunk, writeOffset);
      writeOffset += chunk.length;
    }
    resultBlob = new Blob([output]);

  } else {
    throw new Error(
      `Unsupported ZIP compression method ${target.compressionMethod}. ` +
      "Only Stored (0) and Deflate (8) are supported."
    );
  }

  // Return just the final path component as the filename
  const shortName = target.name.replace(/\\/g, "/").split("/").pop() ?? target.name;
  return { name: shortName, blob: resultBlob };
}

/**
 * Check if a file extension indicates an archive format we recognise.
 * ZIP (.zip) is automatically extracted; 7-Zip (.7z) and RAR (.rar) must
 * be extracted manually before importing.
 */
export function isArchiveExtension(ext: string): boolean {
  return ext === "zip" || ext === "7z" || ext === "rar" ||
    ext === "tar" || ext === "gz" || ext === "tgz" ||
    ext === "bz2" || ext === "tbz" || ext === "tbz2" ||
    ext === "xz" || ext === "txz" ||
    ext === "zst" || ext === "lz" || ext === "lzma" || ext === "cab";
}

/**
 * User-friendly description of supported archive extraction.
 */
export const ARCHIVE_SUPPORT_NOTE =
  "ZIP archives are automatically extracted. " +
  "7-Zip (.7z) is treated as a native package for compatible systems. " +
  "RAR, TAR, GZIP, BZIP2, XZ, and similar archives must be extracted manually before importing.";
