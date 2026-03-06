/**
 * netplay-alias-debug.js — Netplay alias debug CLI
 *
 * Resolves a game title through the full netplay alias pipeline and prints
 * diagnostic information.
 *
 * Usage:
 *   node tools/netplay-alias-debug.js "<Game Title>" [--system <systemId>]
 *
 * Examples:
 *   node tools/netplay-alias-debug.js "Pokemon FireRed (USA)"
 *   node tools/netplay-alias-debug.js "Pokemon FireRed (USA)" --system gba
 *   node tools/netplay-alias-debug.js "Pokemon Red Version" --system gbc
 *
 * Output:
 *   Input title:     Pokemon FireRed (USA)
 *   Normalized title: pokemon firered
 *   Canonical key:   pokemon_firered
 *   Alias group:     pokemon_gen3_kanto
 *   Room key:        pokemon_gen3_kanto
 *   System:          gba
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeRomTitle,
  canonicalizeTitle,
  SYSTEM_ALIAS,
  inferSystemFromRoomKey,
  hashGameId,
  CONFIDENCE_THRESHOLD,
  aliasConfidence,
} from './utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname, '..', 'src');

// Re-export for callers that import normalizeRomTitle / canonicalizeTitle directly.
export { normalizeRomTitle, canonicalizeTitle };

// ── Alias resolution ──────────────────────────────────────────────────────────

/**
 * Load the compiled alias rules from compatibility_aliases.json.
 *
 * @returns {Promise<Array<{ roomKey: string, system: string, match: RegExp }>>}
 */
async function loadAliasRules() {
  const raw = await readFile(resolve(SRC_DIR, 'compatibility_aliases.json'), 'utf-8');
  const table = JSON.parse(raw);
  const rules = [];
  for (const [roomKey, patterns] of Object.entries(table)) {
    const inferredSystem = inferSystemFromRoomKey(roomKey);
    for (const pattern of patterns) {
      rules.push({ roomKey, system: inferredSystem, match: new RegExp(pattern, 'i') });
    }
  }
  return rules;
}

/**
 * Resolve a game title to its netplay room key.
 *
 * @param {string} title
 * @param {string|undefined} systemId
 * @param {Array<{ roomKey: string, system: string, match: RegExp }>} rules
 * @returns {{ normalizedTitle: string, canonicalKey: string, aliasGroup: string|null, roomKey: string }}
 */
export function resolveTitle(title, systemId, rules) {
  const normalizedTitle = normalizeRomTitle(title);
  const canonicalKey = canonicalizeTitle(title);
  const normalizedSystem = (SYSTEM_ALIAS[systemId] ?? systemId ?? '').toLowerCase();

  for (const rule of rules) {
    if (normalizedSystem && rule.system !== normalizedSystem) continue;
    if (rule.match.test(canonicalKey)) {
      const conf = aliasConfidence(canonicalKey);
      if (conf >= CONFIDENCE_THRESHOLD) {
        return { normalizedTitle, canonicalKey, aliasGroup: rule.roomKey, roomKey: rule.roomKey };
      }
      break;
    }
  }
  return { normalizedTitle, canonicalKey, aliasGroup: null, roomKey: canonicalKey };
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

const isMain = process.argv[1] && (
  process.argv[1].endsWith('netplay-alias-debug.js') ||
  process.argv[1].endsWith('alias-debug.js')
);

if (isMain) {
  const args = process.argv.slice(2);
  let title = '';
  let systemId;
  let i = 0;
  while (i < args.length) {
    if ((args[i] === '--system' || args[i] === '-s') && args[i + 1]) {
      systemId = args[i + 1];
      i += 2;
    } else if (!args[i].startsWith('-')) {
      title = args[i];
      i++;
    } else {
      i++;
    }
  }

  if (!title) {
    console.error('Usage: node tools/netplay-alias-debug.js "<Game Title>" [--system <systemId>]');
    console.error('');
    console.error('Examples:');
    console.error('  node tools/netplay-alias-debug.js "Pokemon FireRed (USA)"');
    console.error('  node tools/netplay-alias-debug.js "Pokemon Red Version" --system gbc');
    process.exit(1);
  }

  const rules = await loadAliasRules();
  const result = resolveTitle(title, systemId, rules);

  console.log('');
  console.log(`Input title:      ${title}`);
  console.log(`Normalized title: ${result.normalizedTitle}`);
  console.log(`Canonical key:    ${result.canonicalKey}`);
  console.log(`Alias group:      ${result.aliasGroup ?? '(none — no match in alias table)'}`);
  console.log(`Room key:         ${result.roomKey}`);
  console.log(`System:           ${systemId ?? '(not specified)'}`);
  console.log(`Room hash:        0x${hashGameId(result.roomKey).toString(16)}`);
  console.log('');
}
