/**
 * utils.js — Shared utilities for netplay alias tools
 *
 * Centralises regex patterns, normalization helpers, and the djb2 hash function
 * so all three tools stay in sync with the runtime logic in multiplayer.ts.
 */

// ── Region / revision / dump-annotation regex patterns ────────────────────────
// These mirror the constants in multiplayer.ts and must be kept in sync.

/**
 * Region suffixes used by No-Intro and other ROM databases.
 * Matches parenthesised or bracketed region codes: (USA), [Japan], (Europe), …
 */
export const REGION_TAG_REGEX =
  /\s*[\[(](?:usa|us|u|europe|eu|e|japan|jp|j|world|korea|france|germany|spain|italy|australia|canada|brazil|china|asia|global|intl|international|eng|en(?:[,-]\s*[a-z]{2,})*)[\])]/gi;

/**
 * Revision / version tags: (Rev 1), (Rev A), (v1.1), …
 */
export const REVISION_TAG_REGEX =
  /\s*[\[(](?:rev(?:ision)?\s*[0-9a-z]+|v\s*\d+(?:\.\d+)*)[\])]/gi;

/**
 * Dump-quality annotation tags used by GoodTools / No-Intro:
 *  - `!`         — verified good dump
 *  - `b` / `b1`  — bad dump
 *  - `a1`        — alternate dump
 *  - `h` / `hXX` — hack / trainer
 *  - `f` / `f1`  — fixed dump
 *  - `t[+-]…`    — translation patch
 */
export const DUMP_ANNOTATION_REGEX =
  /\s*[\[(](?:!|b\d*|a\d+|h\d*\s*[a-z0-9_]*|f\s*\d*|t[+-]?[a-z0-9_]*)[\])]/gi;

/**
 * ROM file-extension suffixes to strip during normalization.
 */
export const EXT_REGEX =
  /\.(?:gba|gbc|gb|nds|nes|sfc|smc|n64|z64|v64|psp|iso|bin|rom)$/i;

// ── Normalization helpers ─────────────────────────────────────────────────────

/**
 * Strip the region suffix from a ROM title.
 *
 * @param {string} title
 * @returns {string}
 */
export function stripRegion(title) {
  return title.replace(REGION_TAG_REGEX, ' ').trim();
}

/**
 * Strip the revision suffix from a ROM title.
 *
 * @param {string} title
 * @returns {string}
 */
export function stripRevision(title) {
  return title.replace(REVISION_TAG_REGEX, ' ').trim();
}

/**
 * Normalize a ROM title to lowercase space-separated form.
 * Mirrors `normalizeRomTitle()` in multiplayer.ts.
 *
 * @param {string} title
 * @returns {string}
 */
export function normalizeRomTitle(title) {
  return stripRevision(stripRegion(title))
    .replace(DUMP_ANNOTATION_REGEX, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(EXT_REGEX, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Canonicalize a title to a filesystem-safe underscore-separated key.
 *
 * @param {string} title
 * @returns {string}
 */
export function canonicalizeTitle(title) {
  return normalizeRomTitle(title)
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// ── System inference ──────────────────────────────────────────────────────────

/**
 * System-alias overrides: maps alternate system IDs to their primary bucket.
 * GB games share alias rules with GBC since GB cartridges run on GBC hardware.
 *
 * @type {Record<string, string>}
 */
export const SYSTEM_ALIAS = { gb: 'gbc' };

/**
 * Infer the system bucket for a room key based on naming conventions.
 *
 * Convention (mirrors multiplayer.ts):
 *   - gen1 / gen2  → gbc
 *   - gen3         → gba
 *   - everything else → nds
 *
 * @param {string} roomKey
 * @returns {string}
 */
export function inferSystemFromRoomKey(roomKey) {
  if (roomKey.includes('gen1') || roomKey.includes('gen2')) return 'gbc';
  if (roomKey.includes('gen3')) return 'gba';
  return 'nds';
}

// ── djb2 hash ─────────────────────────────────────────────────────────────────

/**
 * Compute a stable 31-bit positive integer from a string.
 * Mirrors `hashGameId()` in multiplayer.ts using the djb2 algorithm.
 *
 * @param {string} str
 * @returns {number}
 */
export function hashGameId(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return (hash & 0x7fff_ffff) || 1;
}

// ── Alias confidence ──────────────────────────────────────────────────────────

/** Minimum confidence score required to apply an alias. */
export const CONFIDENCE_THRESHOLD = 0.7;

/**
 * Compute confidence that a canonical key should receive an alias.
 * Currently only Pokémon titles are considered high-confidence.
 *
 * @param {string} canonicalKey
 * @returns {number}
 */
export function aliasConfidence(canonicalKey) {
  return /^pokemon(?:_|$)|^pocket_monsters(?:_|$)/.test(canonicalKey) ? 1 : 0.25;
}
