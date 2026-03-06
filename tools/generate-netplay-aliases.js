/**
 * generate-netplay-aliases.js — Alias generation pipeline
 *
 * Builds a `generated_netplay_aliases.json` mapping from canonical room keys
 * to normalized ROM title strings.  The output file is consumed by the debug
 * CLI and can be reviewed by developers.
 *
 * Usage:
 *   node tools/generate-netplay-aliases.js [dat-file ...] [--out <output.json>]
 *
 * When no DAT files are provided, the tool generates aliases from the built-in
 * compatibility_aliases.json regex table by computing representative titles.
 *
 * When DAT files are provided, their ROM entries are normalized and grouped
 * under the matching canonical room key (if any), enriching the output with
 * real No-Intro titles.
 *
 * Examples:
 *   # Generate from built-in table only (no No-Intro files needed)
 *   node tools/generate-netplay-aliases.js
 *
 *   # Enrich with real No-Intro GBA data
 *   node tools/generate-netplay-aliases.js ./No-Intro\ GBA.dat --system gba
 *
 *   # Multiple systems
 *   node tools/generate-netplay-aliases.js \
 *     ./No-Intro\ GBC.dat --system gbc \
 *     ./No-Intro\ GBA.dat --system gba
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNoIntroDat } from './parse-nointro-dat.js';
import { normalizeRomTitle, canonicalizeTitle } from './utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname, '..', 'src');

// Re-export normalizeRomTitle so callers that import from this module still work.
export { normalizeRomTitle };

/**
 * Convert a normalized title to a canonical filesystem-safe key.
 *
 * @param {string} normalizedTitle
 * @returns {string}
 */
export function toCanonicalKey(normalizedTitle) {
  return canonicalizeTitle(normalizedTitle);
}

// ── Room-key resolution from compatibility_aliases.json ───────────────────────

/**
 * Load and compile the alias table from compatibility_aliases.json.
 * Returns a list of { roomKey, match } entries for pattern matching.
 *
 * @returns {Promise<Array<{ roomKey: string, match: RegExp }>>}
 */
async function loadAliasRules() {
  const raw = await readFile(resolve(SRC_DIR, 'compatibility_aliases.json'), 'utf-8');
  const table = JSON.parse(raw);
  const rules = [];
  for (const [roomKey, patterns] of Object.entries(table)) {
    for (const pattern of patterns) {
      rules.push({ roomKey, match: new RegExp(pattern, 'i') });
    }
  }
  return rules;
}

/**
 * Resolve the canonical room key for a normalized title.
 *
 * @param {string} normalized - Normalized title (space-separated lowercase)
 * @param {Array<{ roomKey: string, match: RegExp }>} rules
 * @returns {string|null}
 */
function resolveRoomKey(normalized, rules) {
  const canonical = toCanonicalKey(normalized);
  for (const rule of rules) {
    if (rule.match.test(canonical)) return rule.roomKey;
  }
  return null;
}

// ── Conflict detection ────────────────────────────────────────────────────────

/**
 * Detect collisions in the generated alias map.
 *
 * A collision occurs when the same normalized title appears under two different
 * room keys (e.g., "pokemon stadium" matching both "pokemon_gen1" and a
 * separate group).
 *
 * @param {Record<string, string[]>} aliasMap
 * @returns {string[]} Violation descriptions (empty if no conflicts)
 */
export function detectAliasConflicts(aliasMap) {
  const titleToKey = new Map();
  const violations = [];
  for (const [roomKey, titles] of Object.entries(aliasMap)) {
    for (const title of titles) {
      const existing = titleToKey.get(title);
      if (existing && existing !== roomKey) {
        violations.push(
          `Conflict: title "${title}" appears under both "${existing}" and "${roomKey}"`
        );
      } else {
        titleToKey.set(title, roomKey);
      }
    }
  }
  return violations;
}

// ── Base alias map from built-in table ────────────────────────────────────────

/**
 * The built-in seed titles that map to each room key.
 * These are the canonical set even without No-Intro DAT files.
 */
const BUILTIN_SEED_TITLES = {
  pokemon_gen1: [
    'pokemon red', 'pokemon blue', 'pokemon yellow', 'pokemon green',
    'pocket monsters red', 'pocket monsters blue',
    'pocket monsters yellow', 'pocket monsters green',
  ],
  pokemon_gen2: [
    'pokemon gold', 'pokemon silver', 'pokemon crystal',
    'pocket monsters gold', 'pocket monsters silver', 'pocket monsters crystal',
  ],
  pokemon_gen3_kanto: [
    'pokemon firered', 'pokemon fire red',
    'pokemon leafgreen', 'pokemon leaf green',
  ],
  pokemon_gen3_hoenn: [
    'pokemon ruby', 'pokemon sapphire', 'pokemon emerald',
  ],
  pokemon_gen4_sinnoh: [
    'pokemon diamond', 'pokemon pearl', 'pokemon platinum',
  ],
  pokemon_gen5_unova: [
    'pokemon black', 'pokemon white', 'pokemon black 2', 'pokemon white 2',
  ],
};

// ── Main generation pipeline ──────────────────────────────────────────────────

/**
 * Generate the alias map.
 *
 * @param {Array<{ system: string, filePath: string }>} datInputs
 * @returns {Promise<Record<string, string[]>>}
 */
export async function generateAliasMap(datInputs = []) {
  const rules = await loadAliasRules();

  // Start from built-in seed titles
  /** @type {Record<string, Set<string>>} */
  const groupSets = {};
  for (const [roomKey, titles] of Object.entries(BUILTIN_SEED_TITLES)) {
    groupSets[roomKey] = new Set(titles);
  }

  // Enrich with No-Intro DAT entries if provided
  for (const { filePath } of datInputs) {
    let entries;
    try {
      entries = await parseNoIntroDat(filePath);
    } catch (err) {
      console.warn(`[generate] Warning: could not read "${filePath}": ${err.message}`);
      continue;
    }
    for (const entry of entries) {
      const normalized = normalizeRomTitle(entry.name);
      const roomKey = resolveRoomKey(normalized, rules);
      if (!roomKey) continue;
      groupSets[roomKey] ??= new Set();
      groupSets[roomKey].add(normalized);
    }
  }

  // Convert sets to sorted arrays
  /** @type {Record<string, string[]>} */
  const aliasMap = {};
  for (const [roomKey, set] of Object.entries(groupSets)) {
    aliasMap[roomKey] = [...set].sort();
  }

  // Conflict detection
  const violations = detectAliasConflicts(aliasMap);
  if (violations.length > 0) {
    console.warn('[generate] Alias conflicts detected:');
    for (const v of violations) console.warn('  •', v);
  }

  return aliasMap;
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (process.argv[1] && basename(process.argv[1]) === 'generate-netplay-aliases.js') {
  const args = process.argv.slice(2);

  // Parse args: dat-file [--system <sys>] pairs, plus --out <file>
  const datInputs = [];
  let outPath = resolve(SRC_DIR, 'generated_netplay_aliases.json');
  let i = 0;
  while (i < args.length) {
    if (args[i] === '--out' && args[i + 1]) {
      outPath = resolve(args[i + 1]);
      i += 2;
    } else if (args[i] === '--system' && args[i + 1]) {
      // --system following a dat file (attach to the last dat)
      if (datInputs.length > 0) {
        datInputs[datInputs.length - 1].system = args[i + 1];
      }
      i += 2;
    } else if (!args[i].startsWith('--')) {
      datInputs.push({ filePath: resolve(args[i]), system: 'auto' });
      i++;
    } else {
      i++;
    }
  }

  console.log(`[generate] Generating alias map${datInputs.length ? ` with ${datInputs.length} DAT file(s)` : ' from built-in table'}…`);
  const aliasMap = await generateAliasMap(datInputs);
  const json = JSON.stringify(aliasMap, null, 2) + '\n';
  await writeFile(outPath, json, 'utf-8');
  console.log(`[generate] Written to: ${outPath}`);

  const totalTitles = Object.values(aliasMap).reduce((s, a) => s + a.length, 0);
  const groupCount = Object.keys(aliasMap).length;
  console.log(`[generate] ${groupCount} compatibility group(s), ${totalTitles} total title(s)`);
}
