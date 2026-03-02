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
 * 7-Zip (.7z) — client-side decompression of 7z requires a WASM port of
 *         7-Zip; we surface an actionable error rather than silently fail.
 *
 * The extractor prefers files whose extension matches a known ROM type.
 * If none match it returns the first non-directory entry.
 */

import { ALL_EXTENSIONS } from "./systems.js";

// ── ZIP magic constants ───────────────────────────────────────────────────────

const LOCAL_FILE_MAGIC   = 0x04034b50; // "PK\x03\x04"
const CENTRAL_DIR_MAGIC  = 0x02014b50; // "PK\x01\x02"
const EOCD_MAGIC         = 0x06054b50; // "PK\x05\x06"
const ZIP64_EOCD_MAGIC   = 0x06064b50; // "PK\x06\x06" — handled but not full ZIP64

const COMPRESS_STORED    = 0;
const COMPRESS_DEFLATE   = 8;

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

/**
 * Decode a byte slice as a filename.
 * ZIP filenames should be UTF-8 when the general-purpose bit 11 is set; we
 * attempt UTF-8 first and fall back to Latin-1 for legacy encodings.
 */
function decodeName(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
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
export type ArchiveFormat = "zip" | "7z" | "unknown";

/**
 * Detect the archive format of a Blob by reading its magic header.
 */
export async function detectArchiveFormat(blob: Blob): Promise<ArchiveFormat> {
  if (blob.size < 4) return "unknown";
  try {
    const header = await blob.slice(0, 8).arrayBuffer();
    const view   = new DataView(header);
    const sig32  = view.getUint32(0, true);
    if (sig32 === LOCAL_FILE_MAGIC) return "zip";
    // 7-zip magic: "7z\xBC\xAF\x27\x1C"
    // Bytes [0x37,'z'=0x7a] read as little-endian uint16 → 0x7a37
    if (view.getUint16(0, true) === 0x7a37 &&
        view.getUint16(2, true) === 0xafbc) return "7z";
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
      eocdOffset = i;
      break;
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
  const knownExts = new Set(
    ALL_EXTENSIONS.filter(ext => ext !== "zip" && ext !== "7z")
  );
  const isDir = (e: CentralDirEntry) => e.name.endsWith("/") || e.uncompressedSize === 0;

  const romCandidates = entries.filter(e => {
    if (isDir(e)) return false;
    const ext = e.name.split(".").pop()?.toLowerCase() ?? "";
    return knownExts.has(ext);
  });

  // Do not silently fall back to the first arbitrary file when no ROM-like
  // entry exists. Returning null allows callers to decide whether the archive
  // should be treated as a native package (e.g. MAME zip set).
  const target = romCandidates[0] ?? null;

  if (!target) return null;

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
 * Check if a file extension indicates an archive format we handle.
 */
export function isArchiveExtension(ext: string): boolean {
  return ext === "zip" || ext === "7z";
}

/**
 * User-friendly description of supported archive extraction.
 */
export const ARCHIVE_SUPPORT_NOTE =
  "ZIP archives are automatically extracted. " +
  "7-Zip (.7z) files must be extracted manually before importing.";
