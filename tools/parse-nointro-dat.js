/**
 * parse-nointro-dat.js — No-Intro DAT file parser
 *
 * Parses No-Intro ROM database DAT files (Logiqx XML format) and returns
 * structured ROM entry objects.
 *
 * Usage (as a module):
 *   import { parseNoIntroDat } from './parse-nointro-dat.js';
 *   const entries = await parseNoIntroDat('./No-Intro GBA.dat');
 *
 * Usage (CLI):
 *   node tools/parse-nointro-dat.js ./No-Intro\ GBA.dat
 *
 * Supported DAT formats:
 *  - Logiqx XML  (<datafile><game name="..."><rom .../></game></datafile>)
 *  - ClrMamePro text (game ( name "..." rom ( ... ) ))
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { REGION_TAG_REGEX, REVISION_TAG_REGEX } from './utils.js';

// ── Logiqx XML parser ─────────────────────────────────────────────────────────

/**
 * Parse a Logiqx XML DAT string and return an array of ROM entries.
 * Uses regex-based parsing to avoid external XML library dependencies.
 *
 * @param {string} xml - Raw XML text content of the DAT file
 * @returns {RomEntry[]}
 */
function parseLogiqxXml(xml) {
  const entries = [];
  // Match each <game> or <machine> element (including multiline)
  const gamePattern = /<(?:game|machine)\s[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/(?:game|machine)>/gi;
  let gameMatch;
  while ((gameMatch = gamePattern.exec(xml)) !== null) {
    const name = unescapeXml(gameMatch[1]);
    const body = gameMatch[2];
    // Extract <rom> attributes: crc, sha1, size, serial
    const romPattern = /<rom\s([^>]*)\/>/gi;
    let romMatch;
    while ((romMatch = romPattern.exec(body)) !== null) {
      const attrs = parseXmlAttributes(romMatch[1]);
      entries.push({
        name,
        romName: unescapeXml(attrs.name ?? ''),
        size: attrs.size ? parseInt(attrs.size, 10) : undefined,
        crc: attrs.crc ?? '',
        sha1: attrs.sha1 ?? '',
        region: extractRegion(name),
        revision: extractRevision(name),
        serial: attrs.serial ?? '',
      });
    }
    // If no <rom> child (some DATs omit it), still include the game entry
    if (!/<rom\s/i.test(body)) {
      entries.push({
        name,
        romName: name,
        size: undefined,
        crc: '',
        sha1: '',
        region: extractRegion(name),
        revision: extractRevision(name),
        serial: '',
      });
    }
  }
  return entries;
}

// ── ClrMamePro text parser ────────────────────────────────────────────────────

/**
 * Parse a ClrMamePro .dat text file and return an array of ROM entries.
 *
 * @param {string} text - Raw text content of the .dat file
 * @returns {RomEntry[]}
 */
function parseClrMameProText(text) {
  const entries = [];
  // Match top-level game blocks: game ( ... )
  const gamePattern = /^game\s*\(\s*\n([\s\S]*?)\n\)/gm;
  let gameMatch;
  while ((gameMatch = gamePattern.exec(text)) !== null) {
    const block = gameMatch[1];
    const name = extractCmpField(block, 'name') ?? '';
    // Extract rom sub-block: rom ( ... )
    const romPattern = /\s+rom\s*\(\s*([^)]*)\)/gi;
    let romMatch;
    while ((romMatch = romPattern.exec(block)) !== null) {
      const attrs = parseCmpAttributes(romMatch[1]);
      entries.push({
        name,
        romName: attrs.name ?? '',
        size: attrs.size ? parseInt(attrs.size, 10) : undefined,
        crc: attrs.crc ?? '',
        sha1: attrs.sha1 ?? '',
        region: extractRegion(name),
        revision: extractRevision(name),
        serial: attrs.serial ?? '',
      });
    }
  }
  return entries;
}

// ── Attribute helpers ─────────────────────────────────────────────────────────

/** Parse XML attribute string into key/value map. */
function parseXmlAttributes(attrString) {
  const attrs = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(attrString)) !== null) {
    attrs[m[1].toLowerCase()] = unescapeXml(m[2]);
  }
  return attrs;
}

/** Unescape common XML entities in a single pass to prevent double-unescaping. */
function unescapeXml(str) {
  return str.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => {
    switch (entity) {
      case 'amp':  return '&';
      case 'lt':   return '<';
      case 'gt':   return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default:     return `&${entity};`;
    }
  });
}

/** Extract a named field value from a ClrMamePro block. */
function extractCmpField(block, field) {
  const m = new RegExp(`\\s+${field}\\s+"([^"]*)"`, 'i').exec(block);
  return m ? m[1] : undefined;
}

/** Parse a ClrMamePro rom attribute string into key/value map. */
function parseCmpAttributes(attrString) {
  const attrs = {};
  const re = /(\w+)\s+"([^"]*)"/g;
  let m;
  while ((m = re.exec(attrString)) !== null) {
    attrs[m[1].toLowerCase()] = m[2];
  }
  return attrs;
}

// ── Region / revision extraction ──────────────────────────────────────────────
// Capture-group variants of the shared patterns for extracting the matched value.

const REGION_TAG_CAP = /[\[(](usa|us|u|europe|eu|e|japan|jp|j|world|korea|france|germany|spain|italy|australia|canada|brazil|china|asia|global|intl|international|eng|en(?:[,-]\s*[a-z]{2,})*)[\])]/i;
const REVISION_TAG_CAP = /[\[(](rev(?:ision)?\s*[0-9a-z]+|v\s*\d+(?:\.\d+)*)[\])]/i;

function extractRegion(name) {
  const m = REGION_TAG_CAP.exec(name);
  return m ? m[1].toLowerCase() : '';
}

function extractRevision(name) {
  const m = REVISION_TAG_CAP.exec(name);
  return m ? m[1] : '';
}

// ── Auto-detect format and parse ──────────────────────────────────────────────

/**
 * Detect the DAT file format from its content.
 *
 * @param {string} content
 * @returns {'xml' | 'clrmamepro'}
 */
function detectFormat(content) {
  const trimmed = content.trimStart();
  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<datafile')) return 'xml';
  if (/^clrmamepro\s*\(/m.test(content) || /^game\s*\(/m.test(content)) return 'clrmamepro';
  // Fall back to XML if it looks like XML tags are present
  if (/<game\b/i.test(content)) return 'xml';
  return 'clrmamepro';
}

/**
 * Parse a No-Intro DAT file and return an array of ROM entries.
 *
 * @param {string} filePath - Path to the .dat file
 * @returns {Promise<RomEntry[]>}
 *
 * @typedef {{ name: string, romName: string, size: number|undefined, crc: string, sha1: string, region: string, revision: string, serial: string }} RomEntry
 */
export async function parseNoIntroDat(filePath) {
  const content = await readFile(filePath, 'utf-8');
  const format = detectFormat(content);
  if (format === 'xml') {
    return parseLogiqxXml(content);
  }
  return parseClrMameProText(content);
}

/**
 * Parse a No-Intro DAT file from a string (useful for testing).
 *
 * @param {string} content - Raw DAT file content
 * @param {'xml'|'clrmamepro'|'auto'} [format='auto']
 * @returns {RomEntry[]}
 */
export function parseNoIntroDatString(content, format = 'auto') {
  const fmt = format === 'auto' ? detectFormat(content) : format;
  if (fmt === 'xml') return parseLogiqxXml(content);
  return parseClrMameProText(content);
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (process.argv[1] && basename(process.argv[1]) === 'parse-nointro-dat.js') {
  const [,, filePath, ...rest] = process.argv;
  if (!filePath) {
    console.error('Usage: node tools/parse-nointro-dat.js <path-to.dat> [--json]');
    process.exit(1);
  }
  const asJson = rest.includes('--json');
  try {
    const entries = await parseNoIntroDat(filePath);
    if (asJson) {
      console.log(JSON.stringify(entries, null, 2));
    } else {
      console.log(`Parsed ${entries.length} ROM entries from: ${filePath}`);
      for (const entry of entries.slice(0, 10)) {
        console.log(`  • ${entry.name}${entry.region ? ` [${entry.region}]` : ''}${entry.revision ? ` (${entry.revision})` : ''}`);
      }
      if (entries.length > 10) {
        console.log(`  … and ${entries.length - 10} more`);
      }
    }
  } catch (err) {
    console.error(`Error reading "${filePath}": ${err.message}`);
    process.exit(1);
  }
}
