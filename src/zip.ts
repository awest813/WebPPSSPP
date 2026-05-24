export interface StoredZipEntry {
  path: string;
  bytes: Uint8Array;
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]!) & 0xFF]! ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xFFFF, true);
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

export function createStoredZip(entries: StoredZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBytes = encodeUtf8(entry.path.replace(/\\/g, "/"));
    const dataBytes = entry.bytes;
    const checksum = crc32(dataBytes);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    writeU32(localView, 0, 0x04034B50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, 0);
    writeU16(localView, 8, 0);
    writeU16(localView, 10, 0);
    writeU16(localView, 12, 0);
    writeU32(localView, 14, checksum);
    writeU32(localView, 18, dataBytes.length);
    writeU32(localView, 22, dataBytes.length);
    writeU16(localView, 26, nameBytes.length);
    writeU16(localView, 28, 0);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, dataBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeU32(centralView, 0, 0x02014B50);
    writeU16(centralView, 4, 20);
    writeU16(centralView, 6, 20);
    writeU16(centralView, 8, 0);
    writeU16(centralView, 10, 0);
    writeU16(centralView, 12, 0);
    writeU16(centralView, 14, 0);
    writeU32(centralView, 16, checksum);
    writeU32(centralView, 20, dataBytes.length);
    writeU32(centralView, 24, dataBytes.length);
    writeU16(centralView, 28, nameBytes.length);
    writeU16(centralView, 30, 0);
    writeU16(centralView, 32, 0);
    writeU16(centralView, 34, 0);
    writeU16(centralView, 36, 0);
    writeU32(centralView, 38, 0);
    writeU32(centralView, 42, localOffset);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    localOffset += localHeader.length + dataBytes.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  writeU32(endView, 0, 0x06054B50);
  writeU16(endView, 4, 0);
  writeU16(endView, 6, 0);
  writeU16(endView, 8, entries.length);
  writeU16(endView, 10, entries.length);
  writeU32(endView, 12, centralSize);
  writeU32(endView, 16, localOffset);
  writeU16(endView, 20, 0);

  const totalSize =
    localParts.reduce((sum, part) => sum + part.length, 0) +
    centralSize +
    endRecord.length;

  const out = new Uint8Array(totalSize);
  let cursor = 0;
  for (const part of localParts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  for (const part of centralParts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  out.set(endRecord, cursor);
  return out;
}
