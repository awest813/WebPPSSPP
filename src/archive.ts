/**
 * archive.ts — Client-side ROM archive extraction
 *
 * Provides transparent archive decompression so users can drop compressed
 * packages directly (mobile and desktop) and still launch games.
 *
 * Supported extraction paths:
 *   - ZIP   (native parser + DecompressionStream deflate; on iOS WebKit, random-access
 *            ZIP layout + per-entry slices to avoid loading the whole archive)
 *   - 7Z    (legacy worker — desktop only; disabled on iPhone/iPad for stability)
 *   - RAR   (legacy libunrar worker — desktop only; disabled on iPhone/iPad)
 *   - TAR   (native parser; streaming walk on large archives on iOS)
 *   - GZIP  (DecompressionStream gzip; auto-detects inner TAR)
 *
 * Formats detected but not currently extracted:
 *   - bzip2 / xz (manual extraction required)
 */

import { ALL_EXTENSIONS } from "./systems.js";
import extract7zWorkerUrl from "../data/compression/extract7z.js?url";
import libunrarScriptUrl from "../data/compression/libunrar.js?url";
import libunrarWasmUrl from "../data/compression/libunrar.wasm?url";

// Precomputed set of ROM-compatible extensions (excludes archive formats).
const _romExtensions = new Set(
  ALL_EXTENSIONS.filter(ext => ext !== "zip" && ext !== "7z")
);

// ── ZIP magic constants ───────────────────────────────────────────────────────

const LOCAL_FILE_MAGIC   = 0x04034b50; // "PK\x03\x04"
const CENTRAL_DIR_MAGIC  = 0x02014b50; // "PK\x01\x02"
const EOCD_MAGIC         = 0x06054b50; // "PK\x05\x06"
const ZIP64_EOCD_MAGIC   = 0x06064b50; // "PK\x06\x06"
const ZIP64_EXTRA_TAG    = 0x0001;     // ZIP64 extended information extra field tag

const COMPRESS_STORED    = 0;
const COMPRESS_DEFLATE   = 8;
// Common compression methods not supported by DecompressionStream:
const COMPRESS_DEFLATE64 = 9;  // Deflate64 — non-standard extension
const COMPRESS_BZIP2     = 12; // BZip2
const COMPRESS_LZMA      = 14; // LZMA

// ZIP general-purpose bit flags
const GP_FLAG_ENCRYPTED = 0x0001; // bit 0: entry is encrypted (password-protected)

// ── Safety limits ─────────────────────────────────────────────────────────────

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const MAX_EXTRACTED_ENTRY_BYTES = 512 * 1024 * 1024; // 512 MB
const MAX_EXTRACTED_ENTRY_COUNT = 4096;

// iOS Safari enforces a strict per-tab memory budget. ZIP/TAR can be parsed
// without holding the full archive; 7z/RAR still duplicate the archive in a
// worker, so we keep a lower ceiling than desktop for all archive types.
const IOS_LARGE_ARCHIVE_WARNING_BYTES = 400 * 1024 * 1024;

// On iOS WebKit, use random-access ZIP parsing (EOCD + central-directory
// slice + per-entry data slice) instead of materialising the whole archive.
const IOS_STREAMING_ZIP_MIN_BYTES = 96 * 1024;

// Yield to the event loop occasionally while inflating on iOS so WebKit is
// less likely to watchdog-freeze the tab on large entries.
const IOS_DECOMPRESS_YIELD_CHUNK_COUNT = 24;
const IOS_DECOMPRESS_YIELD_BYTE_INTERVAL = 2 * 1024 * 1024;

// ── Internal types ────────────────────────────────────────────────────────────

interface CentralDirEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  generalPurposeFlags: number;
}

interface ArchiveEntry {
  name: string;
  bytes: Uint8Array;
}

interface WorkerProgressMessage {
  t: 4;
  current: number;
  total: number;
  name?: string;
}

interface WorkerFileMessage {
  t: 2;
  file: string;
  size?: number;
  data: unknown;
}

interface WorkerDoneMessage {
  t: 1;
}

interface WorkerErrorMessage {
  t?: 0;
  error?: string;
}

// ── Progress API ──────────────────────────────────────────────────────────────

export interface ArchiveExtractProgress {
  format: ArchiveFormat;
  stage: "detect" | "extract" | "select";
  message: string;
  percent?: number;
  currentEntry?: string;
}

export interface ArchiveExtractOptions {
  onProgress?: (progress: ArchiveExtractProgress) => void;
}

export interface ArchiveExtractCandidate {
  name: string;
  blob: Blob;
  size: number;
}

export interface ArchiveExtractResult {
  name: string;
  blob: Blob;
  format: ArchiveFormat;
  candidates?: ArchiveExtractCandidate[];
}

interface ArchiveCandidateOptions {
  includeCandidates?: boolean;
  maxCandidates?: number;
  onProgress?: (progress: ArchiveExtractProgress) => void;
}

function emitProgress(
  options: ArchiveExtractOptions | undefined,
  progress: ArchiveExtractProgress
): void {
  options?.onProgress?.(progress);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readUint16LE(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readUint32LE(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

const _utf8Decoder   = new TextDecoder("utf-8", { fatal: true });
const _latin1Decoder = new TextDecoder("latin1");

function decodeName(bytes: Uint8Array): string {
  try {
    return _utf8Decoder.decode(bytes);
  } catch {
    return _latin1Decoder.decode(bytes);
  }
}

function hasZipMagic(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false;
  return new DataView(buf).getUint32(0, true) === LOCAL_FILE_MAGIC;
}

function extensionOf(fileName: string): string {
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx >= fileName.length - 1) return "";
  return fileName.substring(dotIdx + 1).toLowerCase();
}

function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, "/").replace(/^\/+/, "");
}

function shortNameFromPath(name: string): string {
  const normalized = normalizeEntryName(name);
  return normalized.split("/").pop() ?? normalized;
}

function toUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(value)) return new Uint8Array(value);
  return null;
}

/**
 * Returns true when running inside Mobile Safari, Chrome-on-iOS, or any
 * browser on iPadOS (all of which use WebKit and share the same constraints).
 *
 * Handles both classic iOS user-agents (`iP(hone|ad|od)`) and the iPadOS 13+
 * case where the browser reports itself as "Macintosh" but exposes touch
 * points — matching the same logic used by `isLikelyIOS()` in performance.ts.
 */
function isIOSBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  if (/iP(hone|ad|od)/.test(navigator.userAgent)) return true;
  // iPadOS 13+ reports as "Macintosh" but has touch hardware.
  if (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints >= 1) return true;
  return false;
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    const schedule = globalThis.queueMicrotask?.bind(globalThis);
    if (schedule) {
      schedule(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

/**
 * Resolve ZIP central-directory offset and size without reading the whole
 * archive. Expands the tail read when ZIP64 locator sits outside the first slice.
 */
async function resolveZipCentralDirectoryLayout(
  zipBlob: Blob
): Promise<{ centralDirOffset: number; centralDirSize: number } | null> {
  const size = zipBlob.size;
  if (size < 22) return null;

  let tailBytes = Math.min(size, 70_000);
  for (let attempt = 0; attempt < 4; attempt++) {
    const tailStart = size - tailBytes;
    const tailBuf = await zipBlob.slice(tailStart, size).arrayBuffer();
    const view = new DataView(tailBuf);
    const bytes = new Uint8Array(tailBuf);
    const maxSearch = Math.max(0, bytes.length - 22 - 65535);
    let eocdRel = -1;

    for (let i = bytes.length - 22; i >= maxSearch; i--) {
      if (readUint32LE(view, i) === EOCD_MAGIC) {
        const commentLen = readUint16LE(view, i + 20);
        if (i + 22 + commentLen === bytes.length) {
          eocdRel = i;
          break;
        }
      }
    }

    if (eocdRel < 0) return null;

    const eocdOffset = tailStart + eocdRel;
    let centralDirSize = readUint32LE(view, eocdRel + 12);
    let centralDirOffset = readUint32LE(view, eocdRel + 16);

    if (centralDirSize === 0xffffffff || centralDirOffset === 0xffffffff) {
      const zip64LocOffset = eocdOffset - 20;
      if (zip64LocOffset < tailStart) {
        tailBytes = Math.min(size, size - zip64LocOffset + 64);
        continue;
      }
      const locRel = zip64LocOffset - tailStart;
      if (locRel < 0 || locRel + 20 > bytes.length) {
        tailBytes = Math.min(size, size - zip64LocOffset + 64);
        continue;
      }
      if (readUint32LE(view, locRel) === 0x07064b50) {
        const zip64EocdOffset = Number(
          BigInt(readUint32LE(view, locRel + 8)) |
          (BigInt(readUint32LE(view, locRel + 12)) << 32n)
        );
        if (zip64EocdOffset + 56 <= size) {
          const zip64Buf = await zipBlob.slice(zip64EocdOffset, zip64EocdOffset + 56).arrayBuffer();
          const zv = new DataView(zip64Buf);
          if (readUint32LE(zv, 0) === ZIP64_EOCD_MAGIC) {
            const readUint64LE = (o: number) =>
              Number(
                BigInt(readUint32LE(zv, o)) |
                (BigInt(readUint32LE(zv, o + 4)) << 32n)
              );
            centralDirSize = readUint64LE(40);
            centralDirOffset = readUint64LE(48);
          }
        }
      }
    }

    if (
      centralDirOffset < 0 ||
      centralDirSize < 0 ||
      centralDirOffset > size ||
      centralDirOffset + centralDirSize > size
    ) {
      return null;
    }

    return { centralDirOffset, centralDirSize };
  }

  return null;
}

function parseZipCentralDirectoryEntries(
  buffer: ArrayBuffer,
  centralDirOffset: number,
  centralDirSize: number
): CentralDirEntry[] {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const entries: CentralDirEntry[] = [];
  let pos = centralDirOffset;
  const cdEnd = centralDirOffset + centralDirSize;

  while (pos < cdEnd && pos + 46 <= bytes.length) {
    if (readUint32LE(view, pos) !== CENTRAL_DIR_MAGIC) break;

    const generalPurposeFlags = readUint16LE(view, pos + 8);
    const compressionMethod = readUint16LE(view, pos + 10);
    let compressedSize = readUint32LE(view, pos + 20);
    let uncompressedSize = readUint32LE(view, pos + 24);
    const fileNameLength = readUint16LE(view, pos + 28);
    const extraFieldLength = readUint16LE(view, pos + 30);
    const commentLength = readUint16LE(view, pos + 32);
    let localHeaderOffset = readUint32LE(view, pos + 42);

    const nameSlice = bytes.slice(pos + 46, pos + 46 + fileNameLength);
    const name = decodeName(nameSlice);

    const needsUncompressed = uncompressedSize === 0xffffffff;
    const needsCompressed = compressedSize === 0xffffffff;
    const needsOffset = localHeaderOffset === 0xffffffff;
    if (needsUncompressed || needsCompressed || needsOffset) {
      const extraStart = pos + 46 + fileNameLength;
      const extraBytes = bytes.slice(extraStart, extraStart + extraFieldLength);
      const zip64 = parseZip64ExtraField(extraBytes, needsUncompressed, needsCompressed, needsOffset);
      if (zip64.uncompressedSize !== undefined) uncompressedSize = zip64.uncompressedSize;
      if (zip64.compressedSize !== undefined) compressedSize = zip64.compressedSize;
      if (zip64.localHeaderOffset !== undefined) localHeaderOffset = zip64.localHeaderOffset;
    }

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      generalPurposeFlags,
    });

    pos += 46 + fileNameLength + extraFieldLength + commentLength;
    if (entries.length > MAX_EXTRACTED_ENTRY_COUNT) {
      throw new Error("ZIP archive contains too many entries to extract safely in-browser.");
    }
  }

  return entries;
}

async function readZipLocalHeaderDataStart(zipBlob: Blob, lhBase: number): Promise<number | null> {
  const head = await zipBlob.slice(lhBase, lhBase + 30).arrayBuffer();
  if (head.byteLength < 30) return null;
  const view = new DataView(head);
  if (readUint32LE(view, 0) !== LOCAL_FILE_MAGIC) return null;
  const fileNameLen = readUint16LE(view, 26);
  const extraLen = readUint16LE(view, 28);
  const dataStart = lhBase + 30 + fileNameLen + extraLen;
  if (dataStart > zipBlob.size) return null;
  return dataStart;
}

/** File entry in a TAR stream (header offset + payload metadata only). */
interface TarFileRef {
  name: string;
  dataOffset: number;
  size: number;
}

/**
 * Walk a TAR blob without loading the whole archive into memory (for iOS WebKit).
 */
async function listTarFileRefsStreaming(tarBlob: Blob): Promise<TarFileRef[]> {
  const refs: TarFileRef[] = [];
  let offset = 0;
  let zeroBlocks = 0;

  while (offset + 512 <= tarBlob.size) {
    const header = new Uint8Array(
      await tarBlob.slice(offset, offset + 512).arrayBuffer()
    );
    const isZeroBlock = header.every(b => b === 0);
    if (isZeroBlock) {
      zeroBlocks++;
      if (zeroBlocks >= 2) break;
      offset += 512;
      continue;
    }
    zeroBlocks = 0;

    const name = tarFieldString(header, 0, 100);
    const prefix = tarFieldString(header, 345, 500);
    const fullName = normalizeEntryName(prefix ? `${prefix}/${name}` : name);
    const size = tarFieldOctal(header, 124, 136);
    const typeFlag = header[156];

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (size < 0 || dataEnd > tarBlob.size) break;
    if (size > MAX_EXTRACTED_ENTRY_BYTES) {
      throw new Error(`TAR entry "${fullName}" is too large to extract in-browser.`);
    }

    const isDirectory = typeFlag === 53 || fullName.endsWith("/");
    if (!isDirectory && fullName) {
      refs.push({ name: fullName, dataOffset: dataStart, size });
    }

    if (refs.length > MAX_EXTRACTED_ENTRY_COUNT) {
      throw new Error("TAR archive contains too many entries to extract safely in-browser.");
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return refs;
}

function selectBestRomTarRef(refs: TarFileRef[]): TarFileRef | null {
  if (refs.length === 0) return null;
  const ranked = refs
    .map(ref => ({ ref, score: scoreArchiveEntry(ref.name, ref.size) }))
    .filter(item => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.ref ?? null;
}

function selectTopRomTarRefs(refs: TarFileRef[], limit: number): TarFileRef[] {
  if (refs.length === 0) return [];
  return refs
    .map(ref => ({ ref, score: scoreArchiveEntry(ref.name, ref.size) }))
    .filter(item => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
    .map(item => item.ref);
}

function assertArchiveSize(blob: Blob, formatLabel: string): void {
  if (blob.size > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `${formatLabel} file is too large to extract in-browser ` +
      `(${(blob.size / 1073741824).toFixed(1)} GB). ` +
      "Please extract it manually and import the ROM directly."
    );
  }

  // On iOS, the browser process has a strict memory ceiling.  Extracting a
  // large archive requires holding both the compressed and decompressed data
  // in memory at the same time, which can exceed the OS-imposed limit and
  // cause the tab to crash.  Throw early with a descriptive message instead
  // of silently hanging or crashing.
  if (
    blob.size > IOS_LARGE_ARCHIVE_WARNING_BYTES &&
    isIOSBrowser()
  ) {
    throw new Error(
      `This ${formatLabel} archive (${(blob.size / 1048576).toFixed(0)} MB) may be too large to extract on iPhone/iPad. ` +
      "iOS limits available memory per browser tab, which can cause large archives to crash mid-extraction. " +
      "Please extract the archive on a desktop computer and import the ROM file directly."
    );
  }
}

function tarFieldString(header: Uint8Array, start: number, end: number): string {
  const slice = header.slice(start, end);
  const nul = slice.indexOf(0);
  const raw = nul >= 0 ? slice.slice(0, nul) : slice;
  return decodeName(raw).trim();
}

function tarFieldOctal(header: Uint8Array, start: number, end: number): number {
  const txt = tarFieldString(header, start, end).replace(/\0/g, "").trim();
  if (!txt) return 0;
  const parsed = Number.parseInt(txt, 8);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function isTarBuffer(bytes: Uint8Array): boolean {
  if (bytes.length < 263) return false;
  return (
    bytes[257] === 0x75 && // u
    bytes[258] === 0x73 && // s
    bytes[259] === 0x74 && // t
    bytes[260] === 0x61 && // a
    bytes[261] === 0x72 && // r
    (bytes[262] === 0x00 || bytes[262] === 0x20)
  );
}

/**
 * Parse the ZIP64 Extended Information extra field from a central-directory
 * entry's extra-field block.
 *
 * When the standard 32-bit fields in a central directory entry contain
 * 0xFFFFFFFF, the actual values are stored in this extra field. Only the
 * fields that were 0xFFFFFFFF in the original record are written here, in
 * the order: uncompressedSize, compressedSize, localHeaderOffset.
 */
function parseZip64ExtraField(
  extraBytes: Uint8Array,
  needsUncompressedSize: boolean,
  needsCompressedSize: boolean,
  needsLocalHeaderOffset: boolean,
): {
  uncompressedSize?: number;
  compressedSize?: number;
  localHeaderOffset?: number;
} {
  const result: {
    uncompressedSize?: number;
    compressedSize?: number;
    localHeaderOffset?: number;
  } = {};

  if (extraBytes.length < 4) return result;

  const view = new DataView(extraBytes.buffer, extraBytes.byteOffset, extraBytes.byteLength);
  const readUint64 = (off: number): number =>
    Number(
      BigInt(view.getUint32(off, true)) |
      (BigInt(view.getUint32(off + 4, true)) << 32n),
    );

  let pos = 0;
  while (pos + 4 <= extraBytes.length) {
    const tag  = view.getUint16(pos, true);
    const size = view.getUint16(pos + 2, true);
    pos += 4;

    if (tag === ZIP64_EXTRA_TAG) {
      let offset = pos;
      if (needsUncompressedSize && offset + 8 <= pos + size) {
        result.uncompressedSize = readUint64(offset);
        offset += 8;
      }
      if (needsCompressedSize && offset + 8 <= pos + size) {
        result.compressedSize = readUint64(offset);
        offset += 8;
      }
      if (needsLocalHeaderOffset && offset + 8 <= pos + size) {
        result.localHeaderOffset = readUint64(offset);
        offset += 8;
      }
      break;
    }

    pos += size;
  }
  return result;
}

function scoreArchiveEntry(entryName: string, sizeBytes: number): number {
  const normalized = normalizeEntryName(entryName);
  const lower = normalized.toLowerCase();
  const ext = extensionOf(lower);

  if (!_romExtensions.has(ext)) return Number.NEGATIVE_INFINITY;

  let score = 100;

  // Prefer binary/game payloads over descriptor files when both exist.
  if (["iso", "cso", "chd", "pbp", "elf", "nds", "z64", "n64", "v64", "64", "gba", "gbc", "gb", "nes", "sfc", "smc", "md", "gen", "gg", "sms", "a26", "a78", "lnx", "ngp", "ngpc", "ngc", "cdi", "gdi", "bin", "img", "mdf", "ccd"].includes(ext)) {
    score += 300;
  }

  if (["m3u", "cue"].includes(ext)) score += 50;
  if (["txt", "nfo", "json", "xml", "log", "html"].includes(ext)) score -= 200;
  if (/(^|\/)(__macosx|\.ds_store|readme|manual|info|license|changelog)/i.test(lower)) score -= 200;

  // Prefer larger payloads among similar candidates.
  score += Math.min(100, Math.floor(sizeBytes / (1024 * 1024)));

  return score;
}

function selectBestRomEntry(entries: ArchiveEntry[]): ArchiveEntry | null {
  if (entries.length === 0) return null;

  const ranked = entries
    .map(entry => ({ entry, score: scoreArchiveEntry(entry.name, entry.bytes.byteLength) }))
    .filter(item => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.entry ?? null;
}

function selectTopRomEntries(entries: ArchiveEntry[], limit = 8): ArchiveEntry[] {
  if (entries.length === 0) return [];
  return entries
    .map(entry => ({ entry, score: scoreArchiveEntry(entry.name, entry.bytes.byteLength) }))
    .filter(item => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
    .map(item => item.entry);
}

function toArchiveCandidates(entries: ArchiveEntry[]): ArchiveExtractCandidate[] {
  return entries.map((entry) => ({
    name: shortNameFromPath(entry.name),
    blob: new Blob([new Uint8Array(entry.bytes)]),
    size: entry.bytes.byteLength,
  }));
}

interface DecompressStreamOptions {
  /** Yield to the main thread while reading output (reduces WebKit tab freezes). */
  yieldWhileReading?: boolean;
}

async function decompressWithStream(
  format: "gzip" | "deflate-raw",
  bytes: Uint8Array,
  streamOpts?: DecompressStreamOptions
): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    // Provide a targeted hint for iOS/iPadOS users who need to update.
    const hint = isIOSBrowser()
      ? " On iPhone/iPad: update to iOS 16.4 or later in Settings → General → Software Update."
      : " Please extract the archive manually or use a modern browser.";
    throw new Error(
      "Your browser does not support DecompressionStream — ZIP archive decompression is unavailable." +
      hint
    );
  }

  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  // Write and read concurrently to avoid backpressure deadlock on Safari/iOS.
  // On some WebKit versions, awaiting writer.close() before any reader.read()
  // can hang indefinitely once the transform's output buffer fills up.
  // Cast required because WritableStreamDefaultWriter<Uint8Array> is typed to
  // accept ArrayBuffer-backed views; blob.arrayBuffer() always produces a plain
  // ArrayBuffer so the runtime type is always correct.
  const writePromise = writer.write(bytes as unknown as Uint8Array<ArrayBuffer>).then(() => writer.close());

  const chunks: Uint8Array[] = [];
  let total = 0;
  let readCount = 0;
  let sinceYield = 0;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.length;
      if (total > MAX_EXTRACTED_ENTRY_BYTES) {
        throw new Error("Archive entry is too large to extract in-browser.");
      }
      if (streamOpts?.yieldWhileReading) {
        readCount++;
        sinceYield += value.length;
        if (
          readCount % IOS_DECOMPRESS_YIELD_CHUNK_COUNT === 0 ||
          sinceYield >= IOS_DECOMPRESS_YIELD_BYTE_INTERVAL
        ) {
          sinceYield = 0;
          await yieldToMain();
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Propagate any write-side error (e.g. malformed compressed data).
  await writePromise;

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function extractWithLegacyWorker(
  format: "7z" | "rar",
  archiveBytes: Uint8Array,
  options?: ArchiveExtractOptions
): Promise<ArchiveEntry[]> {
  if (typeof Worker === "undefined") {
    throw new Error(
      `${format.toUpperCase()} extraction requires Web Worker support. ` +
      "Please extract this archive manually on this browser."
    );
  }

  const workerResult = await new Promise<ArchiveEntry[]>((resolve, reject) => {
    const entries: ArchiveEntry[] = [];
    let workerUrlToRevoke: string | null = null;

    const worker = (() => {
      if (format === "7z") {
        return new Worker(extract7zWorkerUrl);
      }

      // RAR path: inline wrapper that imports libunrar and recursively emits files.
      const source = `
        self.Module = { locateFile: () => ${JSON.stringify(libunrarWasmUrl)} };
        importScripts(${JSON.stringify(libunrarScriptUrl)});
        self.onmessage = function(ev) {
          try {
            const incoming = ev.data;
            const bytes = incoming instanceof Uint8Array ? incoming : new Uint8Array(incoming);
            const callback = function(fileName, fileSize, progress) {
              self.postMessage({ t: 4, name: fileName, total: fileSize, current: progress });
            };
            const content = self.readRARContent([{ name: "archive.rar", content: bytes }], null, callback);
            const walk = function(entry) {
              if (!entry) return;
              if (entry.type === "file") {
                self.postMessage({ t: 2, file: entry.fullFileName, size: entry.fileSize, data: entry.fileContent });
                return;
              }
              if (entry.type === "dir" && entry.ls) {
                Object.keys(entry.ls).forEach(function(key) { walk(entry.ls[key]); });
              }
            };
            walk(content);
            self.postMessage({ t: 1 });
          } catch (err) {
            self.postMessage({ t: 0, error: err && err.message ? err.message : String(err) });
          }
        };
      `;
      const blob = new Blob([source], { type: "application/javascript" });
      workerUrlToRevoke = URL.createObjectURL(blob);
      return new Worker(workerUrlToRevoke);
    })();

    const cleanup = () => {
      worker.terminate();
      if (workerUrlToRevoke) URL.revokeObjectURL(workerUrlToRevoke);
    };

    worker.onmessage = (event: MessageEvent<WorkerProgressMessage | WorkerFileMessage | WorkerDoneMessage | WorkerErrorMessage>) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;

      if ("t" in msg && msg.t === 4) {
        const total = msg.total > 0 ? msg.total : 0;
        const percent = total > 0
          ? Math.min(100, Math.max(0, Math.floor((msg.current / total) * 100)))
          : undefined;
        emitProgress(options, {
          format,
          stage: "extract",
          message: msg.name ? `Extracting ${msg.name}…` : `Extracting ${format.toUpperCase()} archive…`,
          percent,
          currentEntry: msg.name,
        });
        return;
      }

      if ("t" in msg && msg.t === 2) {
        const bytes = toUint8Array(msg.data);
        if (!bytes) return;
        if (bytes.byteLength > MAX_EXTRACTED_ENTRY_BYTES) {
          cleanup();
          reject(new Error(`Archive entry "${msg.file}" is too large to extract in-browser.`));
          return;
        }
        entries.push({ name: normalizeEntryName(msg.file), bytes });
        if (entries.length > MAX_EXTRACTED_ENTRY_COUNT) {
          cleanup();
          reject(new Error("Archive contains too many files to extract safely in-browser."));
          return;
        }
        return;
      }

      if ("t" in msg && msg.t === 1) {
        cleanup();
        resolve(entries);
        return;
      }

      if ("error" in msg && msg.error) {
        cleanup();
        reject(new Error(msg.error));
      }
    };

    worker.onerror = (event) => {
      cleanup();
      reject(new Error(`${format.toUpperCase()} extraction failed: ${event.message}`));
    };

    // Transfer ownership of the bytes buffer into the worker to avoid duplication.
    worker.postMessage(archiveBytes.buffer, [archiveBytes.buffer]);
  });

  return workerResult;
}

function getFormatFromFileName(fileName: string): ArchiveFormat {
  const ext = extensionOf(fileName);
  if (ext === "zip") return "zip";
  if (ext === "7z") return "7z";
  if (ext === "rar") return "rar";
  if (ext === "tar") return "tar";
  if (ext === "gz" || ext === "tgz" || ext === "gzip") return "gzip";
  if (ext === "bz2" || ext === "tbz" || ext === "tbz2") return "bzip2";
  if (ext === "xz" || ext === "txz") return "xz";
  return "unknown";
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
    if (view.getUint16(0, true) === 0x7a37 &&
        view.getUint16(2, true) === 0xafbc) return "7z";

    // RAR v1.5+ / v5 signatures
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
 * Returns `null` when the archive contains no ROM-like entries.
 */
export async function extractFromZip(
  blob: Blob,
  opts: ArchiveCandidateOptions = {}
): Promise<{ name: string; blob: Blob; candidates?: ArchiveExtractCandidate[] } | null> {
  assertArchiveSize(blob, "ZIP");

  const ios = isIOSBrowser();
  const useStreamingZip = ios && blob.size >= IOS_STREAMING_ZIP_MIN_BYTES;

  if (useStreamingZip) {
    const layout = await resolveZipCentralDirectoryLayout(blob);
    if (layout) {
      const cdBuf = await blob.slice(
        layout.centralDirOffset,
        layout.centralDirOffset + layout.centralDirSize
      ).arrayBuffer();
      const entries = parseZipCentralDirectoryEntries(
        cdBuf,
        0,
        layout.centralDirSize
      );
      if (entries.length === 0) return null;
      return await runZipExtractionAfterEntries(blob, entries, opts, {
        mode: "streaming",
        yieldInflate: ios,
      });
    }
    // Fall through: rare ZIP layouts (e.g. comment longer than tail window) use full read.
  }

  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  if (!hasZipMagic(buffer)) return null;

  // ── Locate End-of-Central-Directory record ────────────────────────────────
  const maxSearch = Math.max(0, bytes.length - 22 - 65535);
  let eocdOffset = -1;

  for (let i = bytes.length - 22; i >= maxSearch; i--) {
    if (readUint32LE(view, i) === EOCD_MAGIC) {
      const commentLen = readUint16LE(view, i + 20);
      if (i + 22 + commentLen === bytes.length) {
        eocdOffset = i;
        break;
      }
    }
  }

  if (eocdOffset < 0) return null;

  let centralDirSize = readUint32LE(view, eocdOffset + 12);
  let centralDirOffset = readUint32LE(view, eocdOffset + 16);

  // ── ZIP64 fallback ────────────────────────────────────────────────────────
  if (centralDirSize === 0xffffffff || centralDirOffset === 0xffffffff) {
    const zip64LocOffset = eocdOffset - 20;
    if (zip64LocOffset >= 0 && readUint32LE(view, zip64LocOffset) === 0x07064b50) {
      const zip64EocdOffset = Number(
        BigInt(readUint32LE(view, zip64LocOffset + 8)) |
        (BigInt(readUint32LE(view, zip64LocOffset + 12)) << 32n)
      );
      if (readUint32LE(view, zip64EocdOffset) === ZIP64_EOCD_MAGIC) {
        const readUint64LE = (o: number) =>
          Number(
            BigInt(readUint32LE(view, o)) |
            (BigInt(readUint32LE(view, o + 4)) << 32n)
          );
        centralDirSize = readUint64LE(zip64EocdOffset + 40);
        centralDirOffset = readUint64LE(zip64EocdOffset + 48);
      }
    }
  }

  const entries = parseZipCentralDirectoryEntries(buffer, centralDirOffset, centralDirSize);
  if (entries.length === 0) return null;

  return await runZipExtractionAfterEntries(blob, entries, opts, {
    mode: "buffered",
    view,
    bytes,
    yieldInflate: ios,
  });
}

type ZipExtractMode =
  | { mode: "buffered"; view: DataView; bytes: Uint8Array; yieldInflate: boolean }
  | { mode: "streaming"; yieldInflate: boolean };

async function runZipExtractionAfterEntries(
  zipBlob: Blob,
  entries: CentralDirEntry[],
  opts: ArchiveCandidateOptions,
  zipMode: ZipExtractMode
): Promise<{ name: string; blob: Blob; candidates?: ArchiveExtractCandidate[] } | null> {
  const files = entries.filter(e => !e.name.endsWith("/"));
  const romCandidates = files
    .filter(e => _romExtensions.has(extensionOf(e.name)))
    .map(e => ({
      entry: e,
      score: scoreArchiveEntry(e.name, e.uncompressedSize),
    }))
    .sort((a, b) => b.score - a.score);

  const target = romCandidates[0]?.entry ?? null;
  if (!target) return null;

  const dsOpts: DecompressStreamOptions | undefined = zipMode.yieldInflate
    ? { yieldWhileReading: true }
    : undefined;

  emitProgress({ onProgress: opts.onProgress }, {
    format: "zip",
    stage: "extract",
    message: `Extracting ${shortNameFromPath(target.name)}…`,
    percent: 0,
    currentEntry: shortNameFromPath(target.name),
  });

  const extractZipEntry = async (entry: CentralDirEntry): Promise<ArchiveEntry | null> => {
    if (entry.generalPurposeFlags & GP_FLAG_ENCRYPTED) {
      throw new Error(
        `ZIP entry "${entry.name}" is password-protected. ` +
        "Please decrypt the archive and import the ROM file directly."
      );
    }

    if (entry.uncompressedSize > MAX_EXTRACTED_ENTRY_BYTES) {
      throw new Error(
        `ZIP entry "${entry.name}" is too large to extract in-browser ` +
        `(${(entry.uncompressedSize / 1073741824).toFixed(2)} GB).`
      );
    }

    if (entry.localHeaderOffset === 0xffffffff) {
      throw new Error(
        `ZIP64 local-header offset could not be resolved for entry "${entry.name}". ` +
        "Please extract the archive manually and import the ROM file directly."
      );
    }

    const lhBase = entry.localHeaderOffset;
    let dataStart: number;
    let compressedSlice: Uint8Array;

    if (zipMode.mode === "buffered") {
      const { view, bytes } = zipMode;
      if (lhBase + 30 > bytes.length) return null;
      if (readUint32LE(view, lhBase) !== LOCAL_FILE_MAGIC) return null;

      const lhFileNameLen = readUint16LE(view, lhBase + 26);
      const lhExtraLen = readUint16LE(view, lhBase + 28);
      dataStart = lhBase + 30 + lhFileNameLen + lhExtraLen;
      const dataEnd2 = dataStart + entry.compressedSize;

      if (dataStart > bytes.length || dataEnd2 > bytes.length) return null;
      compressedSlice = bytes.slice(dataStart, dataEnd2);
    } else {
      const resolved = await readZipLocalHeaderDataStart(zipBlob, lhBase);
      if (resolved === null) return null;
      dataStart = resolved;
      const dataEnd = dataStart + entry.compressedSize;
      if (dataStart > zipBlob.size || dataEnd > zipBlob.size) return null;
      const ab = await zipBlob.slice(dataStart, dataEnd).arrayBuffer();
      compressedSlice = new Uint8Array(ab);
    }

    let output: Uint8Array;
    if (entry.compressionMethod === COMPRESS_STORED) {
      if (compressedSlice.length !== entry.uncompressedSize) {
        throw new Error(
          `ZIP entry size mismatch for "${entry.name}" (expected ${entry.uncompressedSize} bytes, ` +
          `got ${compressedSlice.length}).`
        );
      }
      output = compressedSlice;
    } else if (entry.compressionMethod === COMPRESS_DEFLATE) {
      output = await decompressWithStream("deflate-raw", compressedSlice, dsOpts);
      if (output.length !== entry.uncompressedSize) {
        throw new Error(
          `ZIP inflate size mismatch for "${entry.name}" (expected ${entry.uncompressedSize} bytes, got ${output.length}).`
        );
      }
    } else if (entry.compressionMethod === COMPRESS_DEFLATE64) {
      throw new Error(
        `Entry "${entry.name}" uses Deflate64 compression (method 9), which is not supported in browsers. ` +
        "Please re-compress the archive using standard Deflate or extract it manually."
      );
    } else if (entry.compressionMethod === COMPRESS_BZIP2) {
      throw new Error(
        `Entry "${entry.name}" uses BZip2 compression (method 12), which is not supported in browsers. ` +
        "Please extract the archive manually and import the ROM file directly."
      );
    } else if (entry.compressionMethod === COMPRESS_LZMA) {
      throw new Error(
        `Entry "${entry.name}" uses LZMA compression (method 14), which is not supported in browsers. ` +
        "Please extract the archive manually and import the ROM file directly."
      );
    } else {
      throw new Error(
        `Entry "${entry.name}" uses unsupported ZIP compression method ${entry.compressionMethod}. ` +
        "Only Stored (0) and Deflate (8) are supported. Please extract the archive manually."
      );
    }

    return {
      name: entry.name,
      bytes: output,
    };
  };

  const selected = await extractZipEntry(target);
  if (!selected) return null;

  emitProgress({ onProgress: opts.onProgress }, {
    format: "zip",
    stage: "extract",
    message: `Extracted ${shortNameFromPath(selected.name)}`,
    percent: 100,
    currentEntry: shortNameFromPath(selected.name),
  });

  let candidates: ArchiveExtractCandidate[] | undefined;
  if (opts.includeCandidates) {
    const max = Math.max(1, opts.maxCandidates ?? 8);
    const topEntries = romCandidates.slice(0, max).map(item => item.entry);
    const cache = new Map<number, ArchiveEntry>();
    cache.set(target.localHeaderOffset, selected);
    const topExtracted: ArchiveEntry[] = [];
    for (const entry of topEntries) {
      const cached = cache.get(entry.localHeaderOffset);
      if (cached) {
        topExtracted.push(cached);
        continue;
      }
      const out = await extractZipEntry(entry);
      if (!out) continue;
      cache.set(entry.localHeaderOffset, out);
      topExtracted.push(out);
    }
    candidates = toArchiveCandidates(topExtracted);
  }

  return {
    name: shortNameFromPath(selected.name),
    blob: new Blob([new Uint8Array(selected.bytes)]),
    candidates,
  };
}

/**
 * Extract a ROM-like file from a TAR archive.
 */
export async function extractFromTar(
  blob: Blob,
  opts: ArchiveCandidateOptions = {}
): Promise<{ name: string; blob: Blob; candidates?: ArchiveExtractCandidate[] } | null> {
  assertArchiveSize(blob, "TAR");

  const streamTar = isIOSBrowser() && blob.size >= IOS_STREAMING_ZIP_MIN_BYTES;

  if (streamTar) {
    const refs = await listTarFileRefsStreaming(blob);
    const selectedRef = selectBestRomTarRef(refs);
    if (!selectedRef) return null;

    const payload = await blob.slice(
      selectedRef.dataOffset,
      selectedRef.dataOffset + selectedRef.size
    ).arrayBuffer();
    const selectedBytes = new Uint8Array(payload);

    let candidates: ArchiveExtractCandidate[] | undefined;
    if (opts.includeCandidates) {
      const topRefs = selectTopRomTarRefs(refs, Math.max(1, opts.maxCandidates ?? 8));
      const out: ArchiveExtractCandidate[] = [];
      for (const ref of topRefs) {
        const ab = await blob.slice(ref.dataOffset, ref.dataOffset + ref.size).arrayBuffer();
        out.push({
          name: shortNameFromPath(ref.name),
          blob: new Blob([new Uint8Array(ab)]),
          size: ref.size,
        });
      }
      candidates = out;
    }

    return {
      name: shortNameFromPath(selectedRef.name),
      blob: new Blob([new Uint8Array(selectedBytes)]),
      candidates,
    };
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const entries: ArchiveEntry[] = [];

  let offset = 0;
  let zeroBlocks = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.slice(offset, offset + 512);
    const isZeroBlock = header.every(b => b === 0);
    if (isZeroBlock) {
      zeroBlocks++;
      if (zeroBlocks >= 2) break;
      offset += 512;
      continue;
    }
    zeroBlocks = 0;

    const name = tarFieldString(header, 0, 100);
    const prefix = tarFieldString(header, 345, 500);
    const fullName = normalizeEntryName(prefix ? `${prefix}/${name}` : name);
    const size = tarFieldOctal(header, 124, 136);
    const typeFlag = header[156];

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (size < 0 || dataEnd > bytes.length) break;
    if (size > MAX_EXTRACTED_ENTRY_BYTES) {
      throw new Error(`TAR entry "${fullName}" is too large to extract in-browser.`);
    }

    const isDirectory = typeFlag === 53 || fullName.endsWith("/");
    if (!isDirectory && fullName) {
      entries.push({
        name: fullName,
        bytes: new Uint8Array(bytes.slice(dataStart, dataEnd)),
      });
    }

    if (entries.length > MAX_EXTRACTED_ENTRY_COUNT) {
      throw new Error("TAR archive contains too many entries to extract safely in-browser.");
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  const selected = selectBestRomEntry(entries);
  if (!selected) return null;

  let candidates: ArchiveExtractCandidate[] | undefined;
  if (opts.includeCandidates) {
    const top = selectTopRomEntries(entries, Math.max(1, opts.maxCandidates ?? 8));
    candidates = toArchiveCandidates(top);
  }

  return {
    name: shortNameFromPath(selected.name),
    blob: new Blob([new Uint8Array(selected.bytes)]),
    candidates,
  };
}

/**
 * Extract a ROM-like file from a GZIP archive.
 *
 * If the decompressed payload is a TAR file, TAR parsing is used to choose
 * the best ROM candidate. Otherwise, the decompressed payload is returned as
 * a single file with a `.gz`/`.gzip` suffix stripped from the source name.
 */
export async function extractFromGzip(
  blob: Blob,
  sourceName = "archive.gz",
  opts: ArchiveCandidateOptions = {}
): Promise<{ name: string; blob: Blob; candidates?: ArchiveExtractCandidate[] } | null> {
  assertArchiveSize(blob, "GZIP");

  const compressed = new Uint8Array(await blob.arrayBuffer());
  const dsOpts: DecompressStreamOptions | undefined = isIOSBrowser()
    ? { yieldWhileReading: true }
    : undefined;
  const decompressed = await decompressWithStream("gzip", compressed, dsOpts);

  if (isTarBuffer(decompressed)) {
    return extractFromTar(new Blob([new Uint8Array(decompressed)]), opts);
  }

  const stripped = sourceName.replace(/\.(tgz|gz|gzip)$/i, "");
  const outName = stripped && stripped !== sourceName ? stripped : "archive.bin";
  return {
    name: shortNameFromPath(outName),
    blob: new Blob([new Uint8Array(decompressed)]),
  };
}

/**
 * Unified archive extraction entrypoint.
 *
 * Returns null when:
 *   - the format is unknown/unsupported, or
 *   - the archive contains no ROM-like entries.
 */
export async function extractFromArchive(
  blob: Blob,
  options: ArchiveExtractOptions = {}
): Promise<ArchiveExtractResult | null> {
  emitProgress(options, {
    format: "unknown",
    stage: "detect",
    message: "Detecting archive format…",
  });

  const detected = await detectArchiveFormat(blob);
  const fallbackFromName = blob instanceof File ? getFormatFromFileName(blob.name) : "unknown";
  const format = detected !== "unknown" ? detected : fallbackFromName;

  if (format === "unknown" || format === "bzip2" || format === "xz") return null;

  emitProgress(options, {
    format,
    stage: "extract",
    message: `Extracting ${format.toUpperCase()} archive…`,
  });

  switch (format) {
    case "zip": {
      const extracted = await extractFromZip(blob, {
        includeCandidates: true,
        maxCandidates: 10,
        onProgress: options.onProgress
          ? (p) => emitProgress(options, p)
          : undefined,
      });
      return extracted ? { ...extracted, format } : null;
    }

    case "tar": {
      const extracted = await extractFromTar(blob, { includeCandidates: true, maxCandidates: 10 });
      return extracted ? { ...extracted, format } : null;
    }

    case "gzip": {
      const sourceName = blob instanceof File ? blob.name : "archive.gz";
      const extracted = await extractFromGzip(blob, sourceName, { includeCandidates: true, maxCandidates: 10 });
      return extracted ? { ...extracted, format } : null;
    }

    case "7z":
    case "rar": {
      if (isIOSBrowser()) {
        throw new Error(
          `${format.toUpperCase()} archives are not extracted on iPhone/iPad in this browser ` +
          "(memory limits and worker overhead make in-tab extraction unreliable). " +
          "Please extract the archive in the Files app or on a desktop, then import the ROM file."
        );
      }
      assertArchiveSize(blob, format.toUpperCase());
      const archiveBytes = new Uint8Array(await blob.arrayBuffer());
      const entries = await extractWithLegacyWorker(format, archiveBytes, options);
      emitProgress(options, {
        format,
        stage: "select",
        message: "Selecting ROM payload…",
      });
      const selected = selectBestRomEntry(entries);
      if (!selected) return null;
      const top = selectTopRomEntries(entries, 10);
      const candidates = toArchiveCandidates(top);
      return {
        format,
        name: shortNameFromPath(selected.name),
        blob: new Blob([new Uint8Array(selected.bytes)]),
        candidates,
      };
    }

    default:
      return null;
  }
}

/**
 * Archive extensions accepted by the file picker in addition to
 * system-specific ROM extensions.
 */
export const ARCHIVE_PICKER_EXTENSIONS = [
  "zip", "7z", "rar", "tar", "gz", "tgz",
  "bz2", "tbz", "tbz2", "xz", "txz",
  "zst", "lz", "lzma", "cab",
];

/**
 * Check if a file extension indicates an archive format we recognise.
 */
export function isArchiveExtension(ext: string): boolean {
  return ARCHIVE_PICKER_EXTENSIONS.includes(ext);
}

/**
 * User-friendly description of supported archive extraction.
 */
export const ARCHIVE_SUPPORT_NOTE =
  "ZIP, 7-Zip (.7z), RAR, TAR, and GZIP archives are extracted automatically in-browser. " +
  "BZIP2 (.bz2), XZ (.xz), Zstandard (.zst), and Cabinet (.cab) files must be extracted " +
  "manually before importing. Inside ZIP archives, only Stored and Deflate compression are " +
  "supported; Deflate64, BZip2, and LZMA methods require manual extraction.";

