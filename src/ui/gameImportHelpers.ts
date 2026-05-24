/**
 * gameImportHelpers.ts — ROM importing utilities: extension detection, archive
 * constants, progress formatting, diagnostic logging, and retry logic.
 *
 * Extracted from src/ui.ts as part of the modularisation effort.
 */

import type { PSPEmulator } from "../emulator.js";
import { ALL_EXTENSIONS, type SystemInfo } from "../systems.js";
import type { ArchiveExtractProgress, ArchiveFormat } from "../archive.js";
import type { Settings } from "../types/settings.js";

const APP_NAME = "RetroOasis";

export function toLaunchFile(blob: Blob, fileName: string): File {
  if (blob instanceof File && blob.name === fileName) return blob;
  return new File([blob], fileName, { type: blob.type });
}

export const PATCH_EXT_SET = new Set(["ips", "bps", "ups"]);
export const IMPORT_ARCHIVE_EXT_SET = new Set([
  "zip", "7z", "rar", "tar", "gz", "tgz",
  "bz2", "tbz", "tbz2", "xz", "txz",
  "zst", "lz", "lzma", "cab",
]);
export const IMPORT_ARCHIVE_FORMAT_BY_EXT: Partial<Record<string, ArchiveFormat>> = {
  zip: "zip",
  "7z": "7z",
  rar: "rar",
  tar: "tar",
  gz: "gzip",
  tgz: "gzip",
  gzip: "gzip",
  bz2: "bzip2",
  tbz: "bzip2",
  tbz2: "bzip2",
  xz: "xz",
  txz: "xz",
};
export const EXTRACTABLE_ARCHIVE_FORMATS = new Set<ArchiveFormat>(["zip", "7z", "rar", "tar", "gzip"]);
export const UNSUPPORTED_ARCHIVE_EXT_SET = new Set(["zst", "lz", "lzma", "cab"]);
export const MIN_NATIVE_PACKAGE_BIN_ENTRY_COUNT = 4;
export const NATIVE_PACKAGE_BIN_EXT = "bin";
const NATIVE_PACKAGE_ARCHIVE_SUFFIX_RE = /\.(zip|7z)$/i;
const ARCADE_SET_ARCHIVE_SUFFIX_RE = /\.(zip|7z)$/i;
const ARCADE_SET_STEM_RE = /^[a-z0-9][a-z0-9_+.-]{1,15}$/i;
export const DESCRIPTIVE_DISC_ARCHIVE_RE =
  /\b(disc|disk|track|usa|europe|japan|rev|playstation|psx|ps1|sega[\s_-]*cd|mega[\s_-]*cd)\b/i;

export function fileExt(fileName: string): string {
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx >= fileName.length - 1) return "";
  return fileName.substring(dotIdx + 1).toLowerCase();
}

export function hasKnownRomHintInArchiveName(fileName: string): boolean {
  const stem = fileName.replace(NATIVE_PACKAGE_ARCHIVE_SUFFIX_RE, "");
  const stemExt = fileExt(stem);
  return stemExt !== "" && ALL_EXTENSIONS.includes(stemExt);
}

export function looksLikeNativeRomSetArchive(fileName: string): boolean {
  const stem = fileName.replace(ARCADE_SET_ARCHIVE_SUFFIX_RE, "");
  if (stem === fileName || DESCRIPTIVE_DISC_ARCHIVE_RE.test(stem)) return false;
  return ARCADE_SET_STEM_RE.test(stem);
}

export function inferFileForSystem(original: File, system: SystemInfo): File {
  const currentExt = fileExt(original.name);
  if (system.extensions.includes(currentExt)) return original;

  const baseName = original.name.replace(/\.[^.]+$/, "") || "game";
  const inferredExt = system.extensions[0] ?? "bin";
  return new File([original], `${baseName}.${inferredExt}`, { type: original.type });
}

export function formatArchiveProgressMessage(progress: ArchiveExtractProgress): string {
  const pct = typeof progress.percent === "number" ? ` ${progress.percent}%` : "";
  return `${progress.message}${pct}`;
}

export function logImport(
  emulatorRef: PSPEmulator | undefined,
  settings: Settings,
  message: string,
): void {
  emulatorRef?.logDiagnostic("system", `Import: ${message}`);
  if (settings.verboseLogging) console.info(`[${APP_NAME}] ${message}`);
}

export function logImportWarn(
  emulatorRef: PSPEmulator | undefined,
  settings: Settings,
  message: string,
): void {
  emulatorRef?.logDiagnostic("error", `Import: ${message}`);
  if (settings.verboseLogging) console.warn(`[${APP_NAME}] ${message}`);
}

const IMPORT_MAX_ATTEMPTS = 3;
const IMPORT_RETRY_BASE_DELAY_MS = 300;

export function isTransientImportError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  if (msg.includes("quota") || msg.includes("no space") || msg.includes("storage full")) return false;
  return (
    msg.includes("transaction") ||
    msg.includes("database") ||
    msg.includes("network") ||
    msg.includes("fetch") ||
    err.name === "TransactionInactiveError" ||
    err.name === "AbortError" ||
    err.name === "NetworkError" ||
    err.name === "UnknownError"
  );
}

interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  onRetry?: (attempt: number, err: Error) => void;
  isRetryable?: (err: Error) => boolean;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = IMPORT_MAX_ATTEMPTS,
    delayMs     = IMPORT_RETRY_BASE_DELAY_MS,
    onRetry,
    isRetryable = () => true,
  } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) break;
      const e = err instanceof Error ? err : new Error(String(err));
      if (!isRetryable(e)) break;
      onRetry?.(attempt, e);
      await new Promise<void>(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}
