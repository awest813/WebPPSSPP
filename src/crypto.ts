/**
 * crypto.ts — Cryptographic utilities for RetroOasis.
 * Includes a fast MD5 implementation for RetroAchievements hash matching.
 */

export async function calculateMD5(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  return md5(new Uint8Array(buffer));
}

// Simple MD5 implementation (all `w()` calls use non-null assertions
// because the Int32Array is always large enough for the indices used)
function md5(data: Uint8Array): string {
  let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;
  const words = createWords(data);
  // Convenience accessor — Int32Array always has the right size so the
  // value is never actually undefined, but TS's strict index signature
  // doesn't know that. The cast is safe.
  const w = (i: number): number => words[i] as number;

  for (let i = 0; i < words.length; i += 16) {
    const oldA = a, oldB = b, oldC = c, oldD = d;

    a = ff(a, b, c, d, w(i+ 0),  7, 0xD76AA478); d = ff(d, a, b, c, w(i+ 1), 12, 0xE8C7B756);
    c = ff(c, d, a, b, w(i+ 2), 17, 0x242070DB); b = ff(b, c, d, a, w(i+ 3), 22, 0xC1BDCEEE);
    a = ff(a, b, c, d, w(i+ 4),  7, 0xF57C0FAF); d = ff(d, a, b, c, w(i+ 5), 12, 0x4787C62A);
    c = ff(c, d, a, b, w(i+ 6), 17, 0xA8304613); b = ff(b, c, d, a, w(i+ 7), 22, 0xFD469501);
    a = ff(a, b, c, d, w(i+ 8),  7, 0x698098D8); d = ff(d, a, b, c, w(i+ 9), 12, 0x8B44F7AF);
    c = ff(c, d, a, b, w(i+10), 17, 0xFFFF5BB1); b = ff(b, c, d, a, w(i+11), 22, 0x895CD7BE);
    a = ff(a, b, c, d, w(i+12),  7, 0x6B901122); d = ff(d, a, b, c, w(i+13), 12, 0xFD987193);
    c = ff(c, d, a, b, w(i+14), 17, 0xA679438E); b = ff(b, c, d, a, w(i+15), 22, 0x49B40821);

    a = gg(a, b, c, d, w(i+ 1),  5, 0xF61E2562); d = gg(d, a, b, c, w(i+ 6),  9, 0xC040B340);
    c = gg(c, d, a, b, w(i+11), 14, 0x265E5A51); b = gg(b, c, d, a, w(i+ 0), 20, 0xE9B6C7AA);
    a = gg(a, b, c, d, w(i+ 5),  5, 0xD62F105D); d = gg(d, a, b, c, w(i+10),  9, 0x02441453);
    c = gg(c, d, a, b, w(i+15), 14, 0xD8A1E681); b = gg(b, c, d, a, w(i+ 4), 20, 0xE7D3FBC8);
    a = gg(a, b, c, d, w(i+ 9),  5, 0x21E1CDE6); d = gg(d, a, b, c, w(i+14),  9, 0xC33707D6);
    c = gg(c, d, a, b, w(i+ 3), 14, 0xF4D50D87); b = gg(b, c, d, a, w(i+ 8), 20, 0x455A14ED);
    a = gg(a, b, c, d, w(i+13),  5, 0xA9E3E905); d = gg(d, a, b, c, w(i+ 2),  9, 0xFCEFA3F8);
    c = gg(c, d, a, b, w(i+ 7), 14, 0x676F02D9); b = gg(b, c, d, a, w(i+12), 20, 0x8D2A4C8A);

    a = hh(a, b, c, d, w(i+ 5),  4, 0xFFFA3942); d = hh(d, a, b, c, w(i+ 8), 11, 0x8771F681);
    c = hh(c, d, a, b, w(i+11), 16, 0x6D9D6122); b = hh(b, c, d, a, w(i+14), 23, 0xFDE5380C);
    a = hh(a, b, c, d, w(i+ 1),  4, 0xA4BEEA44); d = hh(d, a, b, c, w(i+ 4), 11, 0x4BDECFA9);
    c = hh(c, d, a, b, w(i+ 7), 16, 0xF6BB4B60); b = hh(b, c, d, a, w(i+10), 23, 0xBEBFBC70);
    a = hh(a, b, c, d, w(i+13),  4, 0x289B7EC6); d = hh(d, a, b, c, w(i+ 0), 11, 0xEAA127FA);
    c = hh(c, d, a, b, w(i+ 3), 16, 0xD4EF3085); b = hh(b, c, d, a, w(i+ 6), 23, 0x04881D05);
    a = hh(a, b, c, d, w(i+ 9),  4, 0xD9D4D039); d = hh(d, a, b, c, w(i+12), 11, 0xE6DB99E5);
    c = hh(c, d, a, b, w(i+15), 16, 0x1FA27CF8); b = hh(b, c, d, a, w(i+ 2), 23, 0xC4AC5665);

    a = ii(a, b, c, d, w(i+ 0),  6, 0xF4292244); d = ii(d, a, b, c, w(i+ 7), 10, 0x432AFF97);
    c = ii(c, d, a, b, w(i+14), 15, 0xAB9423A7); b = ii(b, c, d, a, w(i+ 5), 21, 0xFC93A039);
    a = ii(a, b, c, d, w(i+12),  6, 0x655B59C3); d = ii(d, a, b, c, w(i+ 3), 10, 0x8F0CCC92);
    c = ii(c, d, a, b, w(i+10), 15, 0xFFEFF47D); b = ii(b, c, d, a, w(i+ 1), 21, 0x85845DD1);
    a = ii(a, b, c, d, w(i+ 8),  6, 0x6FA87E4F); d = ii(d, a, b, c, w(i+15), 10, 0xFE2CE6E0);
    c = ii(c, d, a, b, w(i+ 6), 15, 0xA3014314); b = ii(b, c, d, a, w(i+13), 21, 0x4E0811A1);
    a = ii(a, b, c, d, w(i+ 4),  6, 0xF7537E82); d = ii(d, a, b, c, w(i+11), 10, 0xBD3AF235);
    c = ii(c, d, a, b, w(i+ 2), 15, 0x2AD7D2BB); b = ii(b, c, d, a, w(i+ 9), 21, 0xEB86D391);

    a = (a + oldA) | 0; b = (b + oldB) | 0;
    c = (c + oldC) | 0; d = (d + oldD) | 0;
  }

  return toHex(a) + toHex(b) + toHex(c) + toHex(d);
}

function createWords(data: Uint8Array): Int32Array {
  const n = data.length;
  const words = new Int32Array(((n + 8) >> 6 << 4) + 16);
  for (let i = 0; i < n; i++) {
    const idx = i >> 2;
    words[idx] = (words[idx] ?? 0) | (data[i]! << ((i % 4) << 3));
  }
  const lastIdx = n >> 2;
  words[lastIdx] = (words[lastIdx] ?? 0) | (0x80 << ((n % 4) << 3));
  words[words.length - 2] = n << 3;
  return words;
}

function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
  return rol(a + (b & c | ~b & d) + x + t, s) + b;
}
function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
  return rol(a + (b & d | c & ~d) + x + t, s) + b;
}
function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
  return rol(a + (b ^ c ^ d) + x + t, s) + b;
}
function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
  return rol(a + (c ^ (b | ~d)) + x + t, s) + b;
}
function rol(v: number, s: number) { return (v << s) | (v >>> (32 - s)); }
function toHex(v: number) {
  let s = "";
  for (let i = 0; i < 4; i++) s += ((v >> (i * 8 + 4)) & 0xf).toString(16) + ((v >> (i * 8)) & 0xf).toString(16);
  return s;
}
