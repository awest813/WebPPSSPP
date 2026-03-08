/**
 * archive.ts — Client-side ROM archive extraction
 *
 * Provides transparent archive decompression so users can drop compressed
 * packages directly (mobile and desktop) and still launch games.
 *
 * Supported extraction paths:
 *   - ZIP   (native parser + DecompressionStream deflate)
 *   - 7Z    (legacy worker-based extractor bundled with the repo)
 *   - RAR   (legacy libunrar worker wrapper)
 *   - TAR   (native parser)
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
const ZIP64_EOCD_MAGIC   = 0x06064b50; // "PK\x06\x06" — handled but not full ZIP64

const COMPRESS_STORED    = 0;
const COMPRESS_DEFLATE   = 8;

// ── Safety limits ─────────────────────────────────────────────────────────────

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const MAX_EXTRACTED_ENTRY_BYTES = 512 * 1024 * 1024; // 512 MB
const MAX_EXTRACTED_ENTRY_COUNT = 4096;

// ── Internal types ────────────────────────────────────────────────────────────

interface CentralDirEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
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

function assertArchiveSize(blob: Blob, formatLabel: string): void {
  if (blob.size > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `${formatLabel} file is too large to extract in-browser ` +
      `(${(blob.size / 1073741824).toFixed(1)} GB). ` +
      "Please extract it manually and import the ROM directly."
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

async function decompressWithStream(
  format: "gzip" | "deflate-raw",
  bytes: Uint8Array
): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "Your browser does not support DecompressionStream. " +
      "Please extract the archive manually or use a modern browser."
    );
  }

  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  await writer.write(new Uint8Array(bytes));
  await writer.close();

  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.length;
    if (total > MAX_EXTRACTED_ENTRY_BYTES) {
      throw new Error("Archive entry is too large to extract in-browser.");
    }
  }

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

  const buffer = await blob.arrayBuffer();
  const view   = new DataView(buffer);
  const bytes  = new Uint8Array(buffer);

  if (!hasZipMagic(buffer)) return null;

  // ── Locate End-of-Central-Directory record ────────────────────────────────
  const maxSearch = Math.max(0, bytes.length - 22 - 65535);
  let eocdOffset  = -1;

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

  let centralDirSize   = readUint32LE(view, eocdOffset + 12);
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
    if (entries.length > MAX_EXTRACTED_ENTRY_COUNT) {
      throw new Error("ZIP archive contains too many entries to extract safely in-browser.");
    }
  }

  if (entries.length === 0) return null;

  // ── Choose which entry to extract ─────────────────────────────────────────
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

  const extractZipEntry = async (entry: CentralDirEntry): Promise<ArchiveEntry | null> => {
    if (entry.uncompressedSize > MAX_EXTRACTED_ENTRY_BYTES) {
      throw new Error(
        `ZIP entry "${entry.name}" is too large to extract in-browser ` +
        `(${(entry.uncompressedSize / 1073741824).toFixed(2)} GB).`
      );
    }

    // Detect ZIP64 extended-offset indicator. When `localHeaderOffset` reads
    // as 0xFFFFFFFF the actual offset is stored in the ZIP64 extra field of
    // the central-directory entry, which this parser does not yet decode.
    // Silently returning null here would make the extraction appear to succeed
    // but produce no output, so we throw a clear diagnostic instead.
    if (entry.localHeaderOffset === 0xffffffff) {
      throw new Error(
        `ZIP64 extended local-header offsets are not supported for entry "${entry.name}". ` +
        "Please extract the archive manually and import the ROM file directly."
      );
    }

    const lhBase = entry.localHeaderOffset;
    if (lhBase + 30 > bytes.length) return null;
    if (readUint32LE(view, lhBase) !== LOCAL_FILE_MAGIC) return null;

    const lhFileNameLen = readUint16LE(view, lhBase + 26);
    const lhExtraLen    = readUint16LE(view, lhBase + 28);
    const dataStart     = lhBase + 30 + lhFileNameLen + lhExtraLen;
    const dataEnd2      = dataStart + entry.compressedSize;

    if (dataEnd2 > bytes.length) return null;
    const compressedSlice = bytes.slice(dataStart, dataEnd2);

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
      output = await decompressWithStream("deflate-raw", compressedSlice);
      if (output.length !== entry.uncompressedSize) {
        throw new Error(
          `ZIP inflate size mismatch for "${entry.name}" (expected ${entry.uncompressedSize} bytes, got ${output.length}).`
        );
      }
    } else {
      throw new Error(
        `Unsupported ZIP compression method ${entry.compressionMethod}. ` +
        "Only Stored (0) and Deflate (8) are supported."
      );
    }

    return {
      name: entry.name,
      bytes: output,
    };
  };

  const selected = await extractZipEntry(target);
  if (!selected) return null;

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
  const decompressed = await decompressWithStream("gzip", compressed);

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
      const extracted = await extractFromZip(blob, { includeCandidates: true, maxCandidates: 10 });
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
  "ZIP, 7-Zip (.7z), RAR, TAR, and GZIP archives are extracted in-browser when possible. " +
  "BZIP2, XZ, and similar formats must be extracted manually before importing.";

