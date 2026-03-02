/**
 * patcher.ts — ROM patch application (IPS, BPS, UPS)
 *
 * Applies standard ROM-patching formats on-the-fly in the browser before
 * a game is stored or launched. This enables fan translations, regional
 * fixes, and ROM hacks without requiring the user to pre-patch their ROMs.
 *
 * Supported formats
 * -----------------
 * IPS  — International Patching System
 *         Simple offset-based patch; ubiquitous for NES/SNES era hacks.
 *         Supports regular records, RLE records, and truncation extension.
 *
 * BPS  — Binary Patching System
 *         Modern delta format; handles source-copy and target-copy blocks.
 *         CRC32-verified (patch integrity + source + target).
 *
 * UPS  — Universal Patching System
 *         XOR-based format; CRC32-verified.
 *
 * Accepted file extensions: .ips, .bps, .ups
 */

// ── CRC32 ─────────────────────────────────────────────────────────────────────

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC32_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── Magic-byte reader ─────────────────────────────────────────────────────────

function readAscii(view: DataView, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

// ── Format detection ──────────────────────────────────────────────────────────

export type PatchFormat = "ips" | "bps" | "ups";

/**
 * Detect the patch format from the file's magic bytes.
 * Returns null when the format is not recognised.
 */
export function detectPatchFormat(patch: ArrayBuffer): PatchFormat | null {
  if (patch.byteLength < 4) return null;
  const view = new DataView(patch);
  if (patch.byteLength >= 5 && readAscii(view, 0, 5) === "PATCH") return "ips";
  const m4 = readAscii(view, 0, 4);
  if (m4 === "BPS1") return "bps";
  if (m4 === "UPS1") return "ups";
  return null;
}

/**
 * File extensions that indicate a ROM patch file.
 */
export const PATCH_EXTENSIONS = new Set(["ips", "bps", "ups"]);

// ── IPS patcher ───────────────────────────────────────────────────────────────

/**
 * Apply an IPS (International Patching System) patch to a ROM.
 *
 * IPS format:
 *   Header: "PATCH" (5 bytes)
 *   Records (repeating):
 *     offset    — 3 bytes, big-endian
 *     size      — 2 bytes, big-endian
 *     if size ≠ 0: data  (size bytes)
 *     if size = 0: RLE run — rle_size (2 bytes BE) + rle_byte (1 byte)
 *   EOF: "EOF" (3 bytes)
 *   Optional truncation: 3 bytes, big-endian (total output size)
 */
export function applyIPS(rom: ArrayBuffer, patch: ArrayBuffer): ArrayBuffer {
  const pv = new DataView(patch);
  const pb = new Uint8Array(patch);

  if (patch.byteLength < 8 || readAscii(pv, 0, 5) !== "PATCH") {
    throw new Error("Invalid IPS patch: missing PATCH header");
  }

  // Copy ROM into a growable array
  let output = new Uint8Array(rom.byteLength);
  output.set(new Uint8Array(rom));

  function ensureSize(needed: number): void {
    if (needed <= output.length) return;
    const grown = new Uint8Array(needed);
    grown.set(output);
    output = grown;
  }

  let pos = 5;

  while (pos + 3 <= pb.length) {
    // EOF marker is exactly "EOF" at the current position
    if (pb[pos] === 0x45 && pb[pos + 1] === 0x4f && pb[pos + 2] === 0x46) {
      pos += 3;
      break;
    }

    // 3-byte big-endian offset
    const offset = (pb[pos]! << 16) | (pb[pos + 1]! << 8) | pb[pos + 2]!;
    pos += 3;

    if (pos + 2 > pb.length) break;
    const size = (pb[pos]! << 8) | pb[pos + 1]!;
    pos += 2;

    if (size === 0) {
      // RLE record
      if (pos + 3 > pb.length) break;
      const rleSize = (pb[pos]! << 8) | pb[pos + 1]!;
      const rleByte = pb[pos + 2]!;
      pos += 3;
      ensureSize(offset + rleSize);
      output.fill(rleByte, offset, offset + rleSize);
    } else {
      // Standard record
      if (pos + size > pb.length) break;
      ensureSize(offset + size);
      output.set(pb.slice(pos, pos + size), offset);
      pos += size;
    }
  }

  // Optional post-EOF truncation length (3 bytes BE)
  if (pos + 3 <= pb.length) {
    const truncLen = (pb[pos]! << 16) | (pb[pos + 1]! << 8) | pb[pos + 2]!;
    if (truncLen > 0 && truncLen < output.length) {
      output = output.slice(0, truncLen);
    }
  }

  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
}

// ── BPS VLQ ───────────────────────────────────────────────────────────────────

interface Cursor { pos: number }

function readBpsVLQ(bytes: Uint8Array, cur: Cursor): number {
  let data  = 0;
  let shift = 1;
  for (;;) {
    const b = bytes[cur.pos++]!;
    data   += (b & 0x7f) * shift;
    if (b & 0x80) break;
    shift <<= 7;
    data   += shift;
  }
  return data;
}

// ── BPS patcher ───────────────────────────────────────────────────────────────

/**
 * Apply a BPS (Binary Patching System) patch to a ROM.
 *
 * BPS format:
 *   Header: "BPS1"
 *   source_size, target_size, metadata_length (VLQ)
 *   metadata (metadata_length bytes — UTF-8 description, ignored)
 *   actions: SourceRead | TargetRead | SourceCopy | TargetCopy
 *   source_crc32, target_crc32, patch_crc32 (each 4 bytes LE at the end)
 */
export function applyBPS(rom: ArrayBuffer, patch: ArrayBuffer): ArrayBuffer {
  const pb = new Uint8Array(patch);
  const pv = new DataView(patch);

  if (patch.byteLength < 12 || readAscii(pv, 0, 4) !== "BPS1") {
    throw new Error("Invalid BPS patch: missing BPS1 header");
  }

  // Verify patch integrity
  const patchCRC   = pv.getUint32(pb.length - 4, true);
  const actualCRC  = crc32(pb.slice(0, pb.length - 4));
  if (patchCRC !== actualCRC) {
    throw new Error("BPS patch is corrupt (patch CRC32 mismatch)");
  }

  const cur: Cursor = { pos: 4 };
  const sourceSize  = readBpsVLQ(pb, cur);
  const targetSize  = readBpsVLQ(pb, cur);
  const metaLen     = readBpsVLQ(pb, cur);
  cur.pos          += metaLen; // skip metadata string

  const source = new Uint8Array(rom);
  const target = new Uint8Array(targetSize);

  // Verify source CRC32
  const sourceCRC = pv.getUint32(pb.length - 12, true);
  if (crc32(source.slice(0, sourceSize)) !== sourceCRC) {
    throw new Error("BPS patch source CRC32 mismatch — wrong base ROM provided");
  }

  let outputPos    = 0;
  let sourceRelPos = 0;
  let targetRelPos = 0;
  const dataEnd    = pb.length - 12; // three CRC32 words are excluded

  while (cur.pos < dataEnd) {
    const data   = readBpsVLQ(pb, cur);
    const action = data & 3;
    const length = (data >> 2) + 1;

    switch (action) {
      case 0: // SourceRead — copy from source at the same position
        for (let i = 0; i < length; i++) {
          target[outputPos] = source[outputPos] ?? 0;
          outputPos++;
        }
        break;

      case 1: // TargetRead — copy literal bytes from the patch stream
        for (let i = 0; i < length; i++) {
          target[outputPos++] = pb[cur.pos++]!;
        }
        break;

      case 2: { // SourceCopy — copy from source at a relatively-encoded offset
        const raw = readBpsVLQ(pb, cur);
        sourceRelPos += (raw & 1) ? -(raw >> 1) : (raw >> 1);
        for (let i = 0; i < length; i++) {
          target[outputPos++] = source[sourceRelPos++] ?? 0;
        }
        break;
      }

      case 3: { // TargetCopy — copy from already-written output
        const raw = readBpsVLQ(pb, cur);
        targetRelPos += (raw & 1) ? -(raw >> 1) : (raw >> 1);
        for (let i = 0; i < length; i++) {
          target[outputPos++] = target[targetRelPos++] ?? 0;
        }
        break;
      }
    }
  }

  // Verify target CRC32
  const targetCRC = pv.getUint32(pb.length - 8, true);
  if (crc32(target) !== targetCRC) {
    throw new Error("BPS patch produced corrupt output (target CRC32 mismatch)");
  }

  return target.buffer;
}

// ── UPS VLQ ───────────────────────────────────────────────────────────────────

function readUpsVLQ(bytes: Uint8Array, cur: Cursor): number {
  let result = 0;
  let shift  = 0;
  for (;;) {
    const b = bytes[cur.pos++]!;
    if (b & 0x80) {
      result += (b & 0x7f) << shift;
      break;
    }
    result += (b | 0x80) << shift;
    shift  += 7;
  }
  return result;
}

// ── UPS patcher ───────────────────────────────────────────────────────────────

/**
 * Apply a UPS (Universal Patching System) patch to a ROM.
 *
 * UPS format:
 *   Header: "UPS1"
 *   source_size, target_size (VLQ)
 *   XOR hunks: relative_offset (VLQ) + XOR bytes until NUL terminator
 *   source_crc32, target_crc32, patch_crc32 (each 4 bytes LE at the end)
 */
export function applyUPS(rom: ArrayBuffer, patch: ArrayBuffer): ArrayBuffer {
  const pb = new Uint8Array(patch);
  const pv = new DataView(patch);

  if (patch.byteLength < 12 || readAscii(pv, 0, 4) !== "UPS1") {
    throw new Error("Invalid UPS patch: missing UPS1 header");
  }

  const cur: Cursor = { pos: 4 };
  const sourceSize  = readUpsVLQ(pb, cur);
  const targetSize  = readUpsVLQ(pb, cur);

  const source  = new Uint8Array(rom);
  const target  = new Uint8Array(Math.max(sourceSize, targetSize));
  target.set(source.slice(0, Math.min(source.length, target.length)));

  const dataEnd = pb.length - 12;
  let filePos   = 0;

  while (cur.pos < dataEnd) {
    filePos += readUpsVLQ(pb, cur);
    while (cur.pos < dataEnd) {
      const xor = pb[cur.pos++]!;
      if (xor === 0) { filePos++; break; }
      if (filePos < target.length) {
        target[filePos] = (target[filePos]! ^ xor) & 0xff;
      }
      filePos++;
    }
  }

  const out = targetSize < target.length ? target.slice(0, targetSize) : target;

  // Verify CRC32
  const sourceCRC = pv.getUint32(pb.length - 12, true);
  const targetCRC = pv.getUint32(pb.length - 8,  true);
  if (crc32(source.slice(0, sourceSize)) !== sourceCRC) {
    throw new Error("UPS patch source CRC32 mismatch — wrong base ROM provided");
  }
  if (crc32(out) !== targetCRC) {
    throw new Error("UPS patch produced corrupt output (target CRC32 mismatch)");
  }

  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

// ── Unified entry point ───────────────────────────────────────────────────────

/**
 * Apply a patch of any supported format to a ROM.
 * Auto-detects the format from the patch's magic bytes.
 *
 * @param rom    The base ROM as an ArrayBuffer.
 * @param patch  The patch file as an ArrayBuffer.
 * @returns      The patched ROM as an ArrayBuffer.
 * @throws       On unrecognised format, corrupt data, or CRC mismatch.
 */
export function applyPatch(rom: ArrayBuffer, patch: ArrayBuffer): ArrayBuffer {
  const format = detectPatchFormat(patch);
  switch (format) {
    case "ips": return applyIPS(rom, patch);
    case "bps": return applyBPS(rom, patch);
    case "ups": return applyUPS(rom, patch);
    default:
      throw new Error(
        "Unrecognised patch format. " +
        "Supported formats: IPS (.ips), BPS (.bps), UPS (.ups)"
      );
  }
}
