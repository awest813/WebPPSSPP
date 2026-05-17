/**
 * coverArt.ts — Auto-fetch cover art for library games.
 *
 * Provider abstraction so additional sources (self-hosted Laravel API, a
 * TheGamesDB-style service, etc.) can be added later behind the same
 * interface. The default provider is backed by the static GitHub repo
 * `ramiabraham/cover-art-collection`, which hosts platform-organised
 * cover images as `.jpg` / `.png` / `.webp` files. All data is served
 * from `api.github.com` (directory listings) and `raw.githubusercontent.com`
 * (image bytes), both of which send permissive CORS headers and cost the
 * user nothing to access.
 *
 * ── Reference: additional cover collections ────────────────────────────────
 *
 * The GBATemp "Cover Collections for emulators with cover support" thread
 * (https://gbatemp.net/threads/cover-collections-for-emulators-with-cover-support.324714/)
 * indexes many community-maintained boxart / titlescreen sets beyond the
 * sources wired up here (Libretro Thumbnails, cover-art-collection). Any
 * additional collection with permissive CORS or a reachable static CDN can
 * be added behind the `CoverArtProvider` interface and composed into the
 * chain without touching the UI layer.
 *
 * Credentialed metadata sources (RAWG, MobyGames) implement the same
 * interface but declare `requiresApiKey: true` and read their key from
 * {@link ./apiKeyStore.ts}.
 *
 * No ROM / BIOS bytes are ever sent to the network — only the game's
 * display name and system id are used to build the query.
 *
 * ── Name normalisation ─────────────────────────────────────────────────────
 *
 * ROM dumps typically look like "Super Mario World (USA) [!].smc". The
 * collection's filenames look like "Super Mario World (USA).jpg". We strip
 * the file extension, parenthesised region / language tags, bracketed dump
 * tags, trailing "Rev A" / "v1.1" revisions, leading/trailing "Disc N", and
 * all punctuation before collapsing whitespace and lower-casing. The result
 * is a sequence of alphanumeric tokens used both to build search strings
 * and to score candidates via the Sørensen–Dice coefficient over character
 * bigrams.
 */
import { diagDevWarn } from "./diagnosticLog.js";
import type { GameMetadata } from "./library.js";

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * A single match returned by a provider. The image is described by a URL so
 * the caller can lazily fetch only the bytes for the candidate the user
 * actually selects.
 */
export interface CoverArtCandidate {
  /** Human-readable title of the candidate, as shown in the picker UI. */
  title: string;
  /** RetroOasis systemId the candidate belongs to. */
  systemId: string;
  /** Absolute URL to the full-resolution image. */
  imageUrl: string;
  /** Short label describing the source, e.g. "cover-art-collection". */
  sourceName: string;
  /**
   * Confidence score in [0, 1]. 1.0 = perfect normalised-name match,
   * lower values indicate weaker fuzzy matches. Used to decide whether the
   * bulk "Fetch missing covers" flow should auto-apply without user input.
   */
  score: number;
}

/** Common interface every cover-art source implements. */
export interface CoverArtProvider {
  /** Short identifier persisted in settings, e.g. "github". */
  readonly id: string;
  /** Short label shown in the candidate picker UI. */
  readonly name: string;
  /**
   * Optional: providers that require user configuration (typically an API
   * key) return `false` until that configuration is supplied. The chain
   * skips unavailable providers silently instead of treating them as errors.
   */
  isAvailable?(): boolean;
  /**
   * Return up to `limit` candidates ranked by score descending. Must not
   * throw on network errors — return an empty array instead so that the
   * caller treats "no matches" and "network failure" consistently.
   */
  search(
    name: string,
    systemId: string,
    opts?: {
      limit?: number;
      signal?: AbortSignal;
      hashes?: { md5?: string; sha1?: string };
      /** Original ROM filename for fallback matching (e.g. ScreenScraper). */
      fileName?: string;
    },
  ): Promise<CoverArtCandidate[]>;
}

/**
 * Optional contract implemented by providers that require a user-supplied
 * API key. The Settings UI uses these fields to render a consistent
 * "bring your own key" row (signup link + test button + status pill).
 */
export interface ApiKeyedProvider extends CoverArtProvider {
  readonly requiresApiKey: true;
  /** Stable id for the key store, matches {@link ApiKeyProviderConfig.id}. */
  readonly providerId: string;
  /** Human-readable URL where the user can sign up for a free key. */
  readonly signupUrl: string;
  /**
   * Issue a cheap request to confirm the configured key works. Returns
   * `true` on success or an error message suitable for display.
   */
  testConnection(opts?: { signal?: AbortSignal }): Promise<true | string>;
}

// ── Name / platform normalisation ────────────────────────────────────────────

/**
 * Strip file extension, parenthesised region tags, bracketed dump tags,
 * disc numbers, revision markers, punctuation, and collapse whitespace.
 *
 * Deliberately aggressive so that "Super Mario World (USA) [!]" and
 * "Super Mario World.smc" both normalise to "super mario world".
 */
export function normalizeRomName(raw: string): string {
  if (!raw) return "";
  let s = String(raw);

  // Drop path prefix just in case a caller passes a full path.
  const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (slash >= 0) s = s.substring(slash + 1);

  // Strip file extension (last dot only, and only when the suffix is short).
  const dot = s.lastIndexOf(".");
  if (dot > 0 && s.length - dot <= 6) s = s.substring(0, dot);

  // Remove parenthesised / bracketed tags anywhere in the string.
  s = s.replace(/\([^)]*\)/g, " ");
  s = s.replace(/\[[^\]]*\]/g, " ");

  // Drop common revision / version / disc markers that survive tag removal.
  // Require a digit or single alpha-character suffix (e.g. "Rev A", "v1.1",
  // "Disc 2") so legitimate roman numerals like "VII" are preserved.
  s = s.replace(/\b(?:rev|ver|version)\s*[-_.]?\s*[A-Z0-9](?:[.0-9]*)\b/gi, " ");
  s = s.replace(/\bv\s*\d[.0-9]*\b/gi, " ");
  s = s.replace(/\b(?:disc|disk|cd)\s*[-_.]?\s*\d+\b/gi, " ");

  // Replace punctuation with spaces, then collapse.
  s = s.replace(/[^\p{L}\p{N}\s]+/gu, " ");
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s;
}

/** Tokenise a normalised name into alphanumeric words. */
export function tokenizeName(normalized: string): string[] {
  if (!normalized) return [];
  return normalized.split(/\s+/).filter(Boolean);
}

/**
 * Sørensen–Dice coefficient over character bigrams of two normalised
 * strings. Returns a value in [0, 1]. Robust to minor spelling variation,
 * word reordering is approximated via token-set padding.
 */
export function diceCoefficient(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;

  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    // Pad with a space on each side so single-character tokens still yield
    // at least one bigram and word boundaries contribute to the score.
    const padded = ` ${s} `;
    for (let i = 0; i < padded.length - 1; i++) {
      const g = padded.substring(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };

  const ga = bigrams(a);
  const gb = bigrams(b);
  let overlap = 0;
  let totalA = 0;
  let totalB = 0;
  for (const v of ga.values()) totalA += v;
  for (const v of gb.values()) totalB += v;
  for (const [k, va] of ga) {
    const vb = gb.get(k);
    if (vb) overlap += Math.min(va, vb);
  }
  if (totalA + totalB === 0) return 0;
  return (2 * overlap) / (totalA + totalB);
}

/**
 * Mapping from RetroOasis systemId → candidate folder names in the
 * cover-art-collection repo. Order matters: the first folder that exists
 * is used. Names come from the repo's current top-level directory layout
 * (short, human-readable platform names).
 */
const SYSTEM_FOLDER_MAP: Readonly<Record<string, readonly string[]>> = Object.freeze({
  nes:         ["NES", "Nintendo Entertainment System", "Famicom"],
  snes:        ["SNES", "Super Nintendo Entertainment System", "Super Famicom"],
  snesBsnes:   ["SNES", "Super Nintendo Entertainment System", "Super Famicom"],
  gb:          ["Game Boy", "GB", "GameBoy"],
  gbc:         ["Game Boy Color", "GBC", "GameBoy Color"],
  gba:         ["Game Boy Advance", "GBA", "GameBoy Advance"],
  nds:         ["Nintendo DS", "NDS", "DS"],
  "3ds":       ["Nintendo 3DS", "3DS"],
  n64:         ["Nintendo 64", "N64"],
  segaMD:      ["Sega Genesis", "Mega Drive", "Genesis", "Sega Mega Drive"],
  segaMDWide:  ["Sega Genesis", "Mega Drive", "Genesis", "Sega Mega Drive"],
  segaMS:      ["Sega Master System", "Master System"],
  segaGG:      ["Sega Game Gear", "Game Gear"],
  segaSaturn:  ["Sega Saturn", "Saturn"],
  segaDC:      ["Sega Dreamcast", "Dreamcast"],
  psx:         ["Sony Playstation", "PlayStation", "PS1", "PSX", "Sony PlayStation"],
  psp:         ["Sony PSP", "PSP", "PlayStation Portable"],
  atari2600:   ["Atari 2600", "2600"],
  atari7800:   ["Atari 7800", "7800"],
  intv:         ["Intellivision", "Mattel Intellivision"],
  dos:          ["DOS", "MS-DOS", "PC"],
  lynx:        ["Atari Lynx", "Lynx"],
  ngp:         ["Neo Geo Pocket", "NGP", "Neo Geo Pocket Color"],
  arcade:      ["Arcade", "FBNeo", "MAME"],
  mame2003:    ["Arcade", "MAME", "MAME 2003"],
});

/**
 * Return candidate folder names for a given systemId in the order they
 * should be tried. Unknown systems get an empty array so callers can
 * short-circuit cleanly.
 */
export function systemIdToCollectionFolders(systemId: string): string[] {
  if (!systemId) return [];
  const hit = SYSTEM_FOLDER_MAP[systemId];
  return hit ? [...hit] : [];
}

// ── GitHub provider ──────────────────────────────────────────────────────────

const DEFAULT_REPO_OWNER = "ramiabraham";
const DEFAULT_REPO_NAME  = "cover-art-collection";
const DEFAULT_REPO_REF   = "master";

const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|avif|gif)$/i;

const GITHUB_POPULAR_COVER_SOURCE = "GitHub popular covers";

interface PreloadedGitHubCoverArtEntry {
  title: string;
  repo: string;
  path: string;
}

/**
 * Small no-API preload of high-traffic covers hosted in GitHub thumbnail
 * repositories. This improves first-run results for systems that are absent
 * from `cover-art-collection` (PSX, N64, Dreamcast) and gives SNES a fast path
 * before falling back to directory listings.
 */
const PRELOADED_GITHUB_COVERS: Readonly<Record<string, readonly PreloadedGitHubCoverArtEntry[]>> = Object.freeze({
  nes: [
    { title: "Super Mario Bros.", repo: "Nintendo_-_Nintendo_Entertainment_System", path: "Named_Boxarts/Super Mario Bros. (World).png" },
    { title: "Super Mario Bros. 3", repo: "Nintendo_-_Nintendo_Entertainment_System", path: "Named_Boxarts/Super Mario Bros. 3 (USA).png" },
    { title: "The Legend of Zelda", repo: "Nintendo_-_Nintendo_Entertainment_System", path: "Named_Boxarts/Legend of Zelda, The (USA).png" },
    { title: "Metroid", repo: "Nintendo_-_Nintendo_Entertainment_System", path: "Named_Boxarts/Metroid (USA).png" },
    { title: "Contra", repo: "Nintendo_-_Nintendo_Entertainment_System", path: "Named_Boxarts/Contra (USA).png" },
    { title: "Mega Man 2", repo: "Nintendo_-_Nintendo_Entertainment_System", path: "Named_Boxarts/Mega Man 2 (USA).png" },
    { title: "Castlevania", repo: "Nintendo_-_Nintendo_Entertainment_System", path: "Named_Boxarts/Castlevania (USA).png" },
    { title: "Mike Tyson's Punch-Out!!", repo: "Nintendo_-_Nintendo_Entertainment_System", path: "Named_Boxarts/Mike Tyson's Punch-Out!! (USA).png" },
  ],
  snes: [
    { title: "Super Mario World", repo: "Nintendo_-_Super_Nintendo_Entertainment_System", path: "Named_Boxarts/Super Mario World (USA).png" },
    { title: "The Legend of Zelda - A Link to the Past", repo: "Nintendo_-_Super_Nintendo_Entertainment_System", path: "Named_Boxarts/Legend of Zelda, The - A Link to the Past (USA).png" },
    { title: "Super Metroid", repo: "Nintendo_-_Super_Nintendo_Entertainment_System", path: "Named_Boxarts/Super Metroid (Japan, USA).png" },
    { title: "Donkey Kong Country", repo: "Nintendo_-_Super_Nintendo_Entertainment_System", path: "Named_Boxarts/Donkey Kong Country (USA).png" },
    { title: "Chrono Trigger", repo: "Nintendo_-_Super_Nintendo_Entertainment_System", path: "Named_Boxarts/Chrono Trigger (USA).png" },
    { title: "Street Fighter II Turbo", repo: "Nintendo_-_Super_Nintendo_Entertainment_System", path: "Named_Boxarts/Street Fighter II Turbo (USA).png" },
    { title: "Mega Man X", repo: "Nintendo_-_Super_Nintendo_Entertainment_System", path: "Named_Boxarts/Mega Man X (USA).png" },
    { title: "Final Fantasy III", repo: "Nintendo_-_Super_Nintendo_Entertainment_System", path: "Named_Boxarts/Final Fantasy III (USA).png" },
    { title: "EarthBound", repo: "Nintendo_-_Super_Nintendo_Entertainment_System", path: "Named_Boxarts/EarthBound (USA).png" },
  ],
  gb: [
    { title: "Pokemon - Red Version", repo: "Nintendo_-_Game_Boy", path: "Named_Boxarts/Pokemon - Red Version (USA, Europe).png" },
    { title: "Pokemon - Blue Version", repo: "Nintendo_-_Game_Boy", path: "Named_Boxarts/Pokemon - Blue Version (USA, Europe).png" },
    { title: "Tetris", repo: "Nintendo_-_Game_Boy", path: "Named_Boxarts/Tetris (World).png" },
    { title: "Super Mario Land", repo: "Nintendo_-_Game_Boy", path: "Named_Boxarts/Super Mario Land (World).png" },
    { title: "The Legend of Zelda - Link's Awakening", repo: "Nintendo_-_Game_Boy", path: "Named_Boxarts/Legend of Zelda, The - Link's Awakening (USA, Europe).png" },
  ],
  gbc: [
    { title: "Pokemon - Gold Version", repo: "Nintendo_-_Game_Boy_Color", path: "Named_Boxarts/Pokemon - Gold Version (USA, Europe).png" },
    { title: "Pokemon - Silver Version", repo: "Nintendo_-_Game_Boy_Color", path: "Named_Boxarts/Pokemon - Silver Version (USA, Europe).png" },
    { title: "Pokemon - Crystal Version", repo: "Nintendo_-_Game_Boy_Color", path: "Named_Boxarts/Pokemon - Crystal Version (USA, Europe).png" },
    { title: "The Legend of Zelda - Oracle of Ages", repo: "Nintendo_-_Game_Boy_Color", path: "Named_Boxarts/Legend of Zelda, The - Oracle of Ages (USA, Europe).png" },
    { title: "The Legend of Zelda - Oracle of Seasons", repo: "Nintendo_-_Game_Boy_Color", path: "Named_Boxarts/Legend of Zelda, The - Oracle of Seasons (USA, Europe).png" },
  ],
  gba: [
    { title: "Pokemon - Emerald Version", repo: "Nintendo_-_Game_Boy_Advance", path: "Named_Boxarts/Pokemon - Emerald Version (USA, Europe).png" },
    { title: "Pokemon - FireRed Version", repo: "Nintendo_-_Game_Boy_Advance", path: "Named_Boxarts/Pokemon - FireRed Version (USA, Europe).png" },
    { title: "Pokemon - LeafGreen Version", repo: "Nintendo_-_Game_Boy_Advance", path: "Named_Boxarts/Pokemon - LeafGreen Version (USA, Europe).png" },
    { title: "The Legend of Zelda - The Minish Cap", repo: "Nintendo_-_Game_Boy_Advance", path: "Named_Boxarts/Legend of Zelda, The - The Minish Cap (USA).png" },
    { title: "Metroid Fusion", repo: "Nintendo_-_Game_Boy_Advance", path: "Named_Boxarts/Metroid Fusion (USA, Australia).png" },
    { title: "Mario Kart - Super Circuit", repo: "Nintendo_-_Game_Boy_Advance", path: "Named_Boxarts/Mario Kart - Super Circuit (USA).png" },
  ],
  nds: [
    { title: "New Super Mario Bros.", repo: "Nintendo_-_Nintendo_DS", path: "Named_Boxarts/New Super Mario Bros. (USA).png" },
    { title: "Mario Kart DS", repo: "Nintendo_-_Nintendo_DS", path: "Named_Boxarts/Mario Kart DS (USA).png" },
    { title: "Pokemon - Diamond Version", repo: "Nintendo_-_Nintendo_DS", path: "Named_Boxarts/Pokemon - Diamond Version (USA).png" },
    { title: "Pokemon - Pearl Version", repo: "Nintendo_-_Nintendo_DS", path: "Named_Boxarts/Pokemon - Pearl Version (USA).png" },
    { title: "Grand Theft Auto - Chinatown Wars", repo: "Nintendo_-_Nintendo_DS", path: "Named_Boxarts/Grand Theft Auto - Chinatown Wars (USA).png" },
  ],
  n64: [
    { title: "Super Mario 64", repo: "Nintendo_-_Nintendo_64", path: "Named_Boxarts/Super Mario 64 (USA).png" },
    { title: "The Legend of Zelda - Ocarina of Time", repo: "Nintendo_-_Nintendo_64", path: "Named_Boxarts/Legend of Zelda, The - Ocarina of Time (USA).png" },
    { title: "The Legend of Zelda - Majora's Mask", repo: "Nintendo_-_Nintendo_64", path: "Named_Boxarts/Legend of Zelda, The - Majora's Mask (USA).png" },
    { title: "GoldenEye 007", repo: "Nintendo_-_Nintendo_64", path: "Named_Boxarts/GoldenEye 007 (USA).png" },
    { title: "Mario Kart 64", repo: "Nintendo_-_Nintendo_64", path: "Named_Boxarts/Mario Kart 64 (USA).png" },
    { title: "Super Smash Bros.", repo: "Nintendo_-_Nintendo_64", path: "Named_Boxarts/Super Smash Bros. (USA).png" },
    { title: "Mario Party", repo: "Nintendo_-_Nintendo_64", path: "Named_Boxarts/Mario Party (USA).png" },
    { title: "Star Fox 64", repo: "Nintendo_-_Nintendo_64", path: "Named_Boxarts/Star Fox 64 (USA).png" },
    { title: "Banjo-Kazooie", repo: "Nintendo_-_Nintendo_64", path: "Named_Boxarts/Banjo-Kazooie (USA).png" },
  ],
  psx: [
    { title: "Final Fantasy VII", repo: "Sony_-_PlayStation", path: "Named_Boxarts/Final Fantasy VII (USA) (Disc 1).png" },
    { title: "Metal Gear Solid", repo: "Sony_-_PlayStation", path: "Named_Boxarts/Metal Gear Solid (USA) (Disc 1).png" },
    { title: "Resident Evil 2", repo: "Sony_-_PlayStation", path: "Named_Boxarts/Resident Evil 2 - Dual Shock Ver. (USA) (Disc 1).png" },
    { title: "Castlevania - Symphony of the Night", repo: "Sony_-_PlayStation", path: "Named_Boxarts/Castlevania - Symphony of the Night (USA).png" },
    { title: "Tekken 3", repo: "Sony_-_PlayStation", path: "Named_Boxarts/Tekken 3 (USA).png" },
    { title: "Crash Bandicoot", repo: "Sony_-_PlayStation", path: "Named_Boxarts/Crash Bandicoot (USA).png" },
    { title: "Spyro the Dragon", repo: "Sony_-_PlayStation", path: "Named_Boxarts/Spyro the Dragon (USA).png" },
  ],
  psp: [
    { title: "God of War - Ghost of Sparta", repo: "Sony_-_PlayStation_Portable", path: "Named_Boxarts/God of War - Ghost of Sparta (USA).png" },
    { title: "Grand Theft Auto - Liberty City Stories", repo: "Sony_-_PlayStation_Portable", path: "Named_Boxarts/Grand Theft Auto - Liberty City Stories (USA).png" },
    { title: "Monster Hunter Freedom Unite", repo: "Sony_-_PlayStation_Portable", path: "Named_Boxarts/Monster Hunter Freedom Unite (USA).png" },
    { title: "Crisis Core - Final Fantasy VII", repo: "Sony_-_PlayStation_Portable", path: "Named_Boxarts/Crisis Core - Final Fantasy VII (USA).png" },
    { title: "Metal Gear Solid - Peace Walker", repo: "Sony_-_PlayStation_Portable", path: "Named_Boxarts/Metal Gear Solid - Peace Walker (USA).png" },
  ],
  segaMD: [
    { title: "Sonic the Hedgehog", repo: "Sega_-_Mega_Drive_-_Genesis", path: "Named_Boxarts/Sonic the Hedgehog (USA, Europe).png" },
    { title: "Sonic the Hedgehog 2", repo: "Sega_-_Mega_Drive_-_Genesis", path: "Named_Boxarts/Sonic the Hedgehog 2 (World).png" },
    { title: "Mortal Kombat II", repo: "Sega_-_Mega_Drive_-_Genesis", path: "Named_Boxarts/Mortal Kombat II (World).png" },
    { title: "Streets of Rage 2", repo: "Sega_-_Mega_Drive_-_Genesis", path: "Named_Boxarts/Streets of Rage 2 (USA).png" },
    { title: "Gunstar Heroes", repo: "Sega_-_Mega_Drive_-_Genesis", path: "Named_Boxarts/Gunstar Heroes (USA).png" },
  ],
  segaDC: [
    { title: "Shenmue", repo: "Sega_-_Dreamcast", path: "Named_Boxarts/Shenmue (USA) (Disc 1).png" },
    { title: "Crazy Taxi", repo: "Sega_-_Dreamcast", path: "Named_Boxarts/Crazy Taxi (USA).png" },
    { title: "Jet Grind Radio", repo: "Sega_-_Dreamcast", path: "Named_Boxarts/Jet Grind Radio (USA).png" },
    { title: "Marvel vs. Capcom 2", repo: "Sega_-_Dreamcast", path: "Named_Boxarts/Marvel vs. Capcom 2 (USA).png" },
  ],
});

function rawGitHubContentUrl(owner: string, repo: string, ref: string, path: string): string {
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}` +
    `/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/` +
    path.split("/").map(part => encodeURIComponent(part)).join("/");
}

/** Tunable options for the GitHub provider. Exposed mainly for tests. */
export interface GitHubProviderOptions {
  owner?:  string;
  repo?:   string;
  ref?:    string;
  /** How long cached folder listings are considered fresh, ms. Default 24h. */
  cacheTtlMs?: number;
  /** Override `fetch` (useful for unit tests). */
  fetchImpl?: typeof fetch;
}

/** Shape of the entries returned by `GET /repos/.../contents/<path>`. */
interface GitHubContentEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  download_url: string | null;
}

/** In-memory cache of folder listings for the current session. */
interface FolderCacheEntry {
  files: GitHubContentEntry[];
  fetchedAt: number;
}

/**
 * GitHub-backed provider. Network calls go only to api.github.com and
 * raw.githubusercontent.com.
 */
export class GitHubCoverArtProvider implements CoverArtProvider {
  readonly id = "github";
  readonly name = "cover-art-collection";

  private readonly owner: string;
  private readonly repo: string;
  private readonly ref: string;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly memCache = new Map<string, FolderCacheEntry>();
  /** Deduplicate concurrent listings for the same folder. */
  private readonly inflight = new Map<string, Promise<GitHubContentEntry[]>>();

  constructor(opts: GitHubProviderOptions = {}) {
    this.owner      = opts.owner      ?? DEFAULT_REPO_OWNER;
    this.repo       = opts.repo       ?? DEFAULT_REPO_NAME;
    this.ref        = opts.ref        ?? DEFAULT_REPO_REF;
    this.cacheTtlMs = opts.cacheTtlMs ?? 24 * 60 * 60 * 1000;
    this.fetchImpl  = opts.fetchImpl  ?? fetch.bind(globalThis);
  }

  async search(
    name: string,
    systemId: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<CoverArtCandidate[]> {
    const limit = Math.max(1, Math.min(20, opts.limit ?? 6));
    const folders = systemIdToCollectionFolders(systemId);
    if (folders.length === 0) return [];
    const normQuery = normalizeRomName(name);
    if (!normQuery) return [];

    const preloaded = this.searchPreloadedCovers(normQuery, systemId, limit);
    if (preloaded.length > 0 && preloaded[0]!.score >= AUTO_APPLY_CONFIDENCE_THRESHOLD) {
      return preloaded;
    }

    for (const folder of folders) {
      if (opts.signal?.aborted) return [];
      let entries: GitHubContentEntry[];
      try {
        entries = await this.listFolder(folder, opts.signal);
      } catch {
        // Skip this folder on error (network, 404, rate limit); try next.
        continue;
      }
      if (entries.length === 0) continue;

      const scored: CoverArtCandidate[] = [];
      for (const e of entries) {
        if (e.type !== "file") continue;
        if (!IMAGE_EXT_RE.test(e.name)) continue;
        if (!e.download_url) continue;
        const normCandidate = normalizeRomName(e.name);
        if (!normCandidate) continue;
        const score = diceCoefficient(normQuery, normCandidate);
        if (score <= 0) continue;
        scored.push({
          title: e.name.replace(IMAGE_EXT_RE, ""),
          systemId,
          imageUrl: e.download_url,
          sourceName: this.name,
          score,
        });
      }
      if (scored.length === 0) continue;
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    }
    return preloaded;
  }

  private searchPreloadedCovers(
    normQuery: string,
    systemId: string,
    limit: number,
  ): CoverArtCandidate[] {
    const entries = PRELOADED_GITHUB_COVERS[systemId];
    if (!entries) return [];

    const scored: CoverArtCandidate[] = [];
    for (const entry of entries) {
      const score = diceCoefficient(normQuery, normalizeRomName(entry.title));
      if (score <= 0) continue;
      scored.push({
        title: entry.title,
        systemId,
        imageUrl: rawGitHubContentUrl("libretro-thumbnails", entry.repo, "master", entry.path),
        sourceName: GITHUB_POPULAR_COVER_SOURCE,
        score,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * Fetch (with caching) the listing of a single folder in the repo.
   * Throws only on hard failure — callers use try/catch to skip ahead
   * to the next candidate folder.
   */
  private async listFolder(
    folder: string,
    signal?: AbortSignal,
  ): Promise<GitHubContentEntry[]> {
    const now = Date.now();
    const cached = this.memCache.get(folder);
    if (cached && now - cached.fetchedAt < this.cacheTtlMs) {
      return cached.files;
    }
    const inflight = this.inflight.get(folder);
    if (inflight) return inflight;

    const url =
      `https://api.github.com/repos/${encodeURIComponent(this.owner)}` +
      `/${encodeURIComponent(this.repo)}/contents/${encodeURIComponent(folder)}` +
      `?ref=${encodeURIComponent(this.ref)}`;

    const p = (async (): Promise<GitHubContentEntry[]> => {
      const resp = await this.fetchImpl(url, {
        // GitHub accepts either Accept header; the JSON one is stable.
        headers: { Accept: "application/vnd.github+json" },
        signal,
      });
      if (!resp.ok) {
        throw new Error(`GitHub contents API ${resp.status} for "${folder}"`);
      }
      const raw: unknown = await resp.json();
      if (!Array.isArray(raw)) return [];
      const files: GitHubContentEntry[] = [];
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const name = typeof rec.name === "string" ? rec.name : "";
        const path = typeof rec.path === "string" ? rec.path : "";
        const type = rec.type === "file" || rec.type === "dir" || rec.type === "symlink" || rec.type === "submodule"
          ? rec.type
          : "file";
        const dl = typeof rec.download_url === "string" ? rec.download_url : null;
        if (name) files.push({ name, path, type, download_url: dl });
      }
      this.memCache.set(folder, { files, fetchedAt: Date.now() });
      return files;
    })();

    this.inflight.set(folder, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(folder);
    }
  }
}

// ── Fetch + validate helper used by the UI layer ─────────────────────────────

/** Default network timeout when downloading cover image bytes from a URL (ms). Pass `timeoutMs: null` to disable. */
export const DEFAULT_COVER_IMAGE_FETCH_TIMEOUT_MS = 45_000;

/**
 * Fetch a candidate's image URL and validate the response with
 * `createImageBitmap`, mirroring the existing "Use Image URL" flow in the
 * cover art picker. Returns the validated Blob on success; throws otherwise.
 *
 * When {@link opts.timeoutMs} is omitted, a default timeout prevents hung tab
 * states on slow CDNs / broken servers. Aborting happens via {@link opts.signal}.
 */
export async function fetchAndValidateCoverArt(
  url: string,
  opts: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    /** Omit for {@link DEFAULT_COVER_IMAGE_FETCH_TIMEOUT_MS}; pass `null` to wait indefinitely (tests only). */
    timeoutMs?: number | null;
  } = {},
): Promise<Blob> {
  const impl      = opts.fetchImpl ?? fetch.bind(globalThis);
  const timeoutMs =
    opts.timeoutMs === undefined ? DEFAULT_COVER_IMAGE_FETCH_TIMEOUT_MS : opts.timeoutMs;
  const parent    = opts.signal;
  const ctl       = new AbortController();
  let timedOut    = false;
  let spinTimer: ReturnType<typeof setTimeout> | undefined;

  const onParentAbort = () => { ctl.abort(); };

  if (parent) {
    if (parent.aborted) throw new DOMException("Aborted", "AbortError");
    parent.addEventListener("abort", onParentAbort);
  }
  if (timeoutMs !== null && timeoutMs > 0) {
    spinTimer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, timeoutMs);
  }

  try {
    const resp = await impl(url, { mode: "cors", signal: ctl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    bitmap.close();
    return blob;
  } catch (err: unknown) {
    const looksLikeAbort =
      (err instanceof DOMException && err.name === "AbortError") ||
      (err instanceof Error && err.name === "AbortError");
    if (timedOut && !parent?.aborted && looksLikeAbort) {
      const sec =
        typeof timeoutMs === "number" && timeoutMs > 0 ? Math.max(1, Math.round(timeoutMs / 1000)) : "";
      throw new Error(
        sec
          ? `Cover download timed out after ${sec}s — try another image or upload a file.`
          : "Cover download timed out — try another image or upload a file.",
      );
    }
    throw err;
  } finally {
    if (spinTimer) clearTimeout(spinTimer);
    if (parent) parent.removeEventListener("abort", onParentAbort);
  }
}

// ── Bulk-fetch helpers ───────────────────────────────────────────────────────

/** Games that do not yet have cover art (local or remote thumbnail). */
export function listGamesMissingCoverArt(games: GameMetadata[]): GameMetadata[] {
  return games.filter((g) => !g.hasCoverArt && !g.thumbnailUrl);
}

/**
 * Default confidence threshold for auto-applying a candidate in the bulk
 * "Fetch missing covers" flow. Matches above this are applied without
 * prompting the user; everything else is reported for manual review.
 */
export const AUTO_APPLY_CONFIDENCE_THRESHOLD = 0.85;

// ── Libretro Thumbnails provider ─────────────────────────────────────────────

/**
 * Mapping from RetroOasis systemId → Libretro thumbnail system directory
 * names. See https://thumbnails.libretro.com/ for the full directory listing.
 * These follow the "<Publisher> - <System>" convention used by the Libretro
 * thumbnails project.
 */
const LIBRETRO_SYSTEM_MAP: Readonly<Record<string, readonly string[]>> = Object.freeze({
  nes:        ["Nintendo - Nintendo Entertainment System"],
  snes:       ["Nintendo - Super Nintendo Entertainment System"],
  snesBsnes:  ["Nintendo - Super Nintendo Entertainment System"],
  gb:         ["Nintendo - Game Boy"],
  gbc:        ["Nintendo - Game Boy Color"],
  gba:        ["Nintendo - Game Boy Advance"],
  nds:        ["Nintendo - Nintendo DS"],
  "3ds":      ["Nintendo - Nintendo 3DS"],
  n64:        ["Nintendo - Nintendo 64"],
  segaMD:     ["Sega - Mega Drive - Genesis"],
  segaMDWide: ["Sega - Mega Drive - Genesis"],
  segaMS:     ["Sega - Master System - Mark III"],
  segaGG:     ["Sega - Game Gear"],
  segaSaturn: ["Sega - Saturn"],
  segaDC:     ["Sega - Dreamcast"],
  psx:        ["Sony - PlayStation"],
  psp:        ["Sony - PlayStation Portable"],
  atari2600:  ["Atari - 2600"],
  atari7800:  ["Atari - 7800"],
  intv:        ["Mattel - Intellivision"],
  dos:         ["DOS"],
  lynx:       ["Atari - Lynx"],
  ngp:        ["SNK - Neo Geo Pocket Color"],
  arcade:     ["FBNeo - Arcade Games"],
  mame2003:   ["MAME"],
});

const LIBRETRO_BASE_URL = "https://thumbnails.libretro.com";
type LibretroImageType = "Named_Boxarts" | "Named_Titles" | "Named_Snaps";
const LIBRETRO_IMAGE_TYPES: readonly LibretroImageType[] = ["Named_Boxarts", "Named_Titles"];

/**
 * Return candidate Libretro system directory names for a given systemId in
 * the order they should be tried. Unknown systems return an empty array.
 */
export function systemIdToLibretroSystems(systemId: string): string[] {
  if (!systemId) return [];
  const hit = LIBRETRO_SYSTEM_MAP[systemId];
  return hit ? [...hit] : [];
}

/**
 * Prepare a ROM filename for Libretro thumbnail lookup.
 *
 * Unlike `normalizeRomName`, this function preserves parenthesised
 * region, language, and revision tags so the result matches the
 * No-Intro naming convention used by the Libretro thumbnails repository.
 * Only the file extension and bracketed dump-verification tags (e.g. [!],
 * [b1], [h2]) are stripped.
 *
 * Examples:
 *   "Super Mario World (USA) [!].smc" → "Super Mario World (USA)"
 *   "Chrono Trigger (USA) (En,Fr,De).sfc" → "Chrono Trigger (USA) (En,Fr,De)"
 *   "Zelda [!].nes"                   → "Zelda"
 */
export function cleanRomNameForLibretro(raw: string): string {
  if (!raw) return "";
  let s = String(raw);

  // Drop path prefix just in case the caller passes a full path.
  const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (slash >= 0) s = s.substring(slash + 1);

  // Strip file extension (last dot only, when the suffix looks like an extension).
  const dot = s.lastIndexOf(".");
  if (dot > 0 && s.length - dot <= 6) s = s.substring(0, dot);

  // Remove bracketed dump / verification tags only — NOT parenthetical tags.
  s = s.replace(/\[[^\]]*\]/g, " ");

  // Collapse whitespace introduced by removals.
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

/**
 * Apply the Libretro thumbnails repository's filename-safety substitution:
 * the characters &, *, /, :, backtick, <, >, ?, backslash, and | cannot
 * appear in filenames on common filesystems and are each replaced with a
 * single underscore in the thumbnail files on the CDN. Without this
 * substitution titles like "Mega Man X: Command Mission (USA)" yield a
 * 404 because the actual file on the server is named
 * "Mega Man X_ Command Mission (USA).png".
 *
 * Reference: Libretro thumbnails guide — "Thumbnail file name convention".
 */
export function libretroFilenameSafe(name: string): string {
  // Order does not matter — none of the targets overlap.
  return name.replace(/[&*/:`<>?\\|]/g, "_");
}

/** Tunable options for `LibretroCoverArtProvider`. Exposed mainly for tests. */
export interface LibretroProviderOptions {
  /**
   * Image categories to search, in priority order.
   * Defaults to `["Named_Boxarts", "Named_Titles"]`.
   */
  imageTypes?: readonly LibretroImageType[];
}

/**
 * Libretro-thumbnails-backed cover art provider.
 *
 * Constructs direct image URLs from the public Libretro thumbnails CDN at
 * https://thumbnails.libretro.com/. No API key or authentication is needed.
 *
 * Two name variants are tried for each game:
 *   1. The No-Intro-style name (region tags preserved) — higher confidence.
 *   2. The fully-normalised name (all tags stripped) — lower confidence fallback.
 *
 * Filename-unsafe characters are substituted per the Libretro thumbnails
 * naming convention (see {@link libretroFilenameSafe}).
 *
 * Candidates are returned without prior network validation so the search is
 * instantaneous. The caller's `fetchAndValidateCoverArt` call handles the
 * actual download and will surface any 404 / unreachable errors gracefully.
 */
export class LibretroCoverArtProvider implements CoverArtProvider {
  readonly id = "libretro";
  readonly name = "Libretro Thumbnails";

  private readonly imageTypes: readonly LibretroImageType[];

  constructor(opts: LibretroProviderOptions = {}) {
    this.imageTypes = opts.imageTypes ?? LIBRETRO_IMAGE_TYPES;
  }

  async search(
    name: string,
    systemId: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<CoverArtCandidate[]> {
    if (opts.signal?.aborted) return [];
    const systems = systemIdToLibretroSystems(systemId);
    if (systems.length === 0) return [];

    // Build name variants: No-Intro style first (highest quality match),
    // then the aggressively-normalised form as a fallback.
    const noIntroName = cleanRomNameForLibretro(name);
    const normName    = normalizeRomName(name);
    if (!noIntroName && !normName) return [];

    // Deduplicate variants while preserving priority order.
    const variants = [...new Set([noIntroName, normName].filter(Boolean))];

    const limit = Math.max(1, Math.min(20, opts.limit ?? 6));
    const candidates: CoverArtCandidate[] = [];
    const seenUrls = new Set<string>();

    for (const system of systems) {
      if (opts.signal?.aborted) break;

      for (const imageType of this.imageTypes) {
        if (opts.signal?.aborted) break;

        for (const variant of variants) {
          if (candidates.length >= limit) break;

          const safeVariant = libretroFilenameSafe(variant);
          const url =
            `${LIBRETRO_BASE_URL}/${encodeURIComponent(system)}` +
            `/${imageType}/${encodeURIComponent(safeVariant)}.png`;

          if (seenUrls.has(url)) continue;
          seenUrls.add(url);

          // No-Intro name matches what the thumbnail repo actually uses;
          // normalised name is a fallback that may work for simpler titles.
          const score = variant === noIntroName ? 0.92 : 0.82;
          candidates.push({ title: variant, systemId, imageUrl: url, sourceName: this.name, score });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, limit);
  }
}

// ── Wikimedia / Wikipedia provider ────────────────────────────────────────────

interface WikimediaQueryResponse {
  query?: {
    pages?: Record<string, {
      title?: string;
      extract?: string;
      pageid?: number;
      thumbnail?: { source?: string };
      original?: { source?: string };
    }>;
  };
}

export interface WikimediaCoverArtProviderOptions {
  fetchImpl?: typeof fetch;
}

/**
 * No-key Wikimedia image fallback. It asks Wikipedia for likely game pages and
 * uses their page image when one is available. The image may be a logo,
 * screenshot, or freely licensed cover, so its confidence stays below exact
 * Libretro/GitHub filename hits but it is useful for obscure/homebrew titles.
 */
export class WikimediaCoverArtProvider implements CoverArtProvider {
  readonly id = "wikimedia";
  readonly name = "Wikimedia";

  private readonly fetchImpl: typeof fetch;

  constructor(opts: WikimediaCoverArtProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  async search(
    name: string,
    systemId: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<CoverArtCandidate[]> {
    if (opts.signal?.aborted) return [];
    const normQuery = normalizeRomName(name);
    if (!normQuery) return [];
    const limit = Math.max(1, Math.min(20, opts.limit ?? 6));

    const params = new URLSearchParams({
      action: "query",
      generator: "search",
      gsrsearch: `${normQuery} video game`,
      gsrlimit: String(Math.min(limit, 8)),
      prop: "pageimages|extracts",
      piprop: "thumbnail|original",
      pithumbsize: "600",
      exintro: "1",
      explaintext: "1",
      redirects: "1",
      format: "json",
      origin: "*",
    });

    let body: WikimediaQueryResponse;
    try {
      const resp = await this.fetchImpl(`https://en.wikipedia.org/w/api.php?${params.toString()}`, {
        signal: opts.signal,
      });
      if (!resp.ok) return [];
      body = (await resp.json()) as WikimediaQueryResponse;
    } catch {
      return [];
    }

    const out: CoverArtCandidate[] = [];
    const seen = new Set<string>();
    for (const page of Object.values(body.query?.pages ?? {})) {
      const title = typeof page.title === "string" ? page.title : "";
      const imageUrl = page.original?.source || page.thumbnail?.source || "";
      if (!title || !imageUrl || seen.has(imageUrl)) continue;
      const score = Math.min(0.86, diceCoefficient(normQuery, normalizeRomName(title)) + 0.08);
      if (score <= 0.2) continue;
      seen.add(imageUrl);
      out.push({ title, systemId, imageUrl, sourceName: this.name, score });
    }

    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }
}

// ── Chained / composite provider ─────────────────────────────────────────────

/**
 * A meta-provider that queries multiple `CoverArtProvider` instances in order
 * and returns a merged, deduplicated list of candidates ranked by score.
 *
 * Each inner provider is tried in sequence. Results are deduplicated by
 * `imageUrl` so the same image is never returned twice. The combined list is
 * sorted by score descending and truncated to `limit` entries.
 *
 * Network / runtime errors from individual providers are silently swallowed so
 * that one failing source does not prevent results from the others.
 *
 * A module-level in-flight counter (`_chainedSearchInFlight`) caps concurrent
 * bulk searches at {@link CHAINED_SEARCH_MAX_CONCURRENCY} to avoid hammering
 * third-party APIs when many games are searched in parallel.
 */

/** Maximum number of concurrent `ChainedCoverArtProvider.search()` calls. */
export const CHAINED_SEARCH_MAX_CONCURRENCY = 4;

let _chainedSearchInFlight = 0;

/**
 * Wait until the global in-flight count drops below the concurrency cap,
 * then increment it. Returns a cleanup function that must be called when
 * the search completes (success or failure).
 */
async function acquireConcurrencySlot(signal?: AbortSignal): Promise<() => void> {
  while (_chainedSearchInFlight >= CHAINED_SEARCH_MAX_CONCURRENCY) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await new Promise<void>((resolve, reject) => {
      const id = setTimeout(() => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }, 200);
      if (!signal) return;
      const onAbort = (): void => {
        clearTimeout(id);
        signal.removeEventListener("abort", onAbort);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort);
    });
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  _chainedSearchInFlight++;
  return () => { _chainedSearchInFlight = Math.max(0, _chainedSearchInFlight - 1); };
}

export class ChainedCoverArtProvider implements CoverArtProvider {
  readonly id = "chained";
  readonly name = "All Sources";

  constructor(private readonly providers: readonly CoverArtProvider[]) {}

  async search(
    name: string,
    systemId: string,
    opts: {
      limit?: number;
      signal?: AbortSignal;
      hashes?: { md5?: string; sha1?: string };
      fileName?: string;
    } = {},
  ): Promise<CoverArtCandidate[]> {
    const limit = Math.max(1, Math.min(20, opts.limit ?? 6));
    const all: CoverArtCandidate[] = [];
    const seenUrls = new Set<string>();

    let release: (() => void) | null = null;
    try {
      release = await acquireConcurrencySlot(opts.signal);
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === "AbortError") return [];
      throw e;
    }
    try {
      for (const provider of this.providers) {
        if (opts.signal?.aborted) break;
        // Providers that require user configuration (e.g. an API key) may
        // advertise themselves as unavailable. Skip silently — treating this
        // as an error would spam logs every time the chain runs.
        if (typeof provider.isAvailable === "function" && !provider.isAvailable()) {
          continue;
        }
        try {
          const results = await provider.search(name, systemId, { ...opts, limit });
          for (const c of results) {
            if (!seenUrls.has(c.imageUrl)) {
              seenUrls.add(c.imageUrl);
              all.push(c);
            }
          }
        } catch {
          // A single provider failing must not abort the chain.
        }
      }
    } finally {
      release?.();
    }

    all.sort((a, b) => b.score - a.score);
    return all.slice(0, limit);
  }
}

// ── API-key-backed providers (RAWG, MobyGames) ───────────────────────────────

/**
 * Simple in-memory response cache shared by keyed providers. Keyed on
 * `providerId|systemId|normalized-name` so rapid re-queries for the same
 * game don't spend the user's monthly quota.
 */
class KeyedProviderCache {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, { at: number; value: CoverArtCandidate[] }>();
  constructor(ttlMs = 5 * 60 * 1000) { this.ttlMs = ttlMs; }
  get(key: string): CoverArtCandidate[] | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return hit.value;
  }
  set(key: string, value: CoverArtCandidate[]): void {
    this.entries.set(key, { at: Date.now(), value });
  }
}

/**
 * RetroOasis systemId → RAWG platform id. Covers the most common consoles;
 * systems without a stable RAWG mapping (arcade/mame) are intentionally
 * omitted so the provider returns [] instead of guessing wrong.
 */
const RAWG_PLATFORM_MAP: Readonly<Record<string, number>> = Object.freeze({
  nes:        49,
  snes:       79,
  gb:         26,
  gbc:        43,
  gba:        24,
  nds:        9,
  n64:        83,
  segaMD:     167,
  segaMS:     74,
  segaGG:     77,
  segaSaturn: 107,
  segaDC:     106,
  psx:        27,
  psp:        17,
  atari2600:  23,
  atari7800:  31,
  lynx:       28,
  ngp:        115,
});

/** Return the RAWG platform id for a systemId, or undefined. */
export function systemIdToRawgPlatformId(systemId: string): number | undefined {
  return RAWG_PLATFORM_MAP[systemId];
}

/** Tunable options for `RawgCoverArtProvider`. */
export interface RawgProviderOptions {
  /** Callable that returns the current API key, or "" when unconfigured. */
  getApiKey: () => string;
  /** Override `fetch` (useful for unit tests). */
  fetchImpl?: typeof fetch;
  /** Response cache TTL in ms. Default 5 minutes. */
  cacheTtlMs?: number;
}

/** Shape (subset) of the RAWG `/games` response we rely on. */
interface RawgGamesResponse {
  results?: Array<{
    id?: number;
    name?: string;
    slug?: string;
    background_image?: string | null;
    short_screenshots?: Array<{ id?: number; image?: string | null }>;
  }>;
}

/**
 * RAWG-backed cover-art / screenshot provider. Requires the user to supply
 * their own RAWG API key via the Settings "API Keys" tab. Free tier allows
 * ~20,000 requests/month.
 */
export class RawgCoverArtProvider implements ApiKeyedProvider {
  readonly id = "rawg";
  readonly name = "RAWG";
  readonly requiresApiKey = true as const;
  readonly providerId = "rawg";
  readonly signupUrl = "https://rawg.io/apidocs";

  private readonly getApiKey: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: KeyedProviderCache;

  constructor(opts: RawgProviderOptions) {
    this.getApiKey = opts.getApiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.cache = new KeyedProviderCache(opts.cacheTtlMs);
  }

  isAvailable(): boolean {
    return this.getApiKey().trim() !== "";
  }

  async search(
    name: string,
    systemId: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<CoverArtCandidate[]> {
    if (opts.signal?.aborted) return [];
    const key = this.getApiKey().trim();
    if (!key) return [];
    const platform = systemIdToRawgPlatformId(systemId);
    if (platform === undefined) return [];
    const normQuery = normalizeRomName(name);
    if (!normQuery) return [];

    const limit = Math.max(1, Math.min(20, opts.limit ?? 6));
    const cacheKey = `rawg|${systemId}|${normQuery}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached.slice(0, limit);

    const url =
      "https://api.rawg.io/api/games" +
      `?search=${encodeURIComponent(normQuery)}` +
      `&platforms=${platform}` +
      `&page_size=${limit}` +
      `&key=${encodeURIComponent(key)}`;

    let body: RawgGamesResponse;
    try {
      const resp = await this.fetchImpl(url, { signal: opts.signal });
      if (!resp.ok) return [];
      body = (await resp.json()) as RawgGamesResponse;
    } catch {
      return [];
    }

    const out: CoverArtCandidate[] = [];
    const seen = new Set<string>();
    for (const g of body.results ?? []) {
      const title = typeof g.name === "string" ? g.name : "";
      if (!title) continue;
      const normCandidate = normalizeRomName(title);
      const score = diceCoefficient(normQuery, normCandidate);
      if (score <= 0) continue;

      // Primary box/header image.
      if (typeof g.background_image === "string" && g.background_image && !seen.has(g.background_image)) {
        seen.add(g.background_image);
        out.push({ title, systemId, imageUrl: g.background_image, sourceName: this.name, score });
      }
      // Supplementary screenshots — lower score so backgrounds rank higher.
      if (Array.isArray(g.short_screenshots)) {
        for (const s of g.short_screenshots) {
          const img = typeof s.image === "string" ? s.image : "";
          if (!img || seen.has(img)) continue;
          seen.add(img);
          out.push({ title, systemId, imageUrl: img, sourceName: this.name, score: Math.max(0, score - 0.1) });
        }
      }
    }
    out.sort((a, b) => b.score - a.score);
    const trimmed = out.slice(0, limit);
    this.cache.set(cacheKey, trimmed);
    return trimmed;
  }

  /** Cheap probe: ask RAWG for a single game record to validate the key. */
  async testConnection(opts: { signal?: AbortSignal } = {}): Promise<true | string> {
    const key = this.getApiKey().trim();
    if (!key) return "No API key configured.";
    const url = `https://api.rawg.io/api/games?page_size=1&key=${encodeURIComponent(key)}`;
    try {
      const resp = await this.fetchImpl(url, { signal: opts.signal });
      if (resp.status === 401 || resp.status === 403) return "RAWG rejected the API key.";
      if (!resp.ok) return `RAWG returned HTTP ${resp.status}.`;
      return true;
    } catch (err) {
      return `Could not reach RAWG: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// ── MobyGames ────────────────────────────────────────────────────────────────

/**
 * RetroOasis systemId → MobyGames platform id. Values are from the
 * MobyGames API platform catalogue. Systems without a clean 1:1 mapping
 * are omitted.
 */
const MOBYGAMES_PLATFORM_MAP: Readonly<Record<string, number>> = Object.freeze({
  nes:        22,
  snes:       15,
  gb:         10,
  gbc:        57,
  gba:        12,
  nds:        44,
  n64:        9,
  segaMD:     16,
  segaMS:     26,
  segaGG:     25,
  segaSaturn: 23,
  segaDC:     8,
  psx:        6,
  psp:        46,
  atari2600:  28,
  atari7800:  34,
  lynx:       18,
  ngp:        52,
});

/** Return the MobyGames platform id for a systemId, or undefined. */
export function systemIdToMobyPlatformId(systemId: string): number | undefined {
  return MOBYGAMES_PLATFORM_MAP[systemId];
}

/** Tunable options for `MobyGamesCoverArtProvider`. */
export interface MobyGamesProviderOptions {
  getApiKey: () => string;
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
}

/** Shape (subset) of the MobyGames `/games` response we rely on. */
interface MobyGamesGamesResponse {
  games?: Array<{
    game_id?: number;
    title?: string;
    sample_cover?: {
      image?: string | null;
      thumbnail_image?: string | null;
    } | null;
  }>;
}

/**
 * MobyGames-backed cover art provider. Requires the user to supply their
 * own MobyGames API key via the Settings "API Keys" tab.
 *
 * Per MobyGames API terms, results include an attribution label — the
 * `sourceName` ("MobyGames") is surfaced in the candidate picker.
 */
export class MobyGamesCoverArtProvider implements ApiKeyedProvider {
  readonly id = "mobygames";
  readonly name = "MobyGames";
  readonly requiresApiKey = true as const;
  readonly providerId = "mobygames";
  readonly signupUrl = "https://www.mobygames.com/info/api/";

  private readonly getApiKey: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: KeyedProviderCache;

  constructor(opts: MobyGamesProviderOptions) {
    this.getApiKey = opts.getApiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.cache = new KeyedProviderCache(opts.cacheTtlMs);
  }

  isAvailable(): boolean {
    return this.getApiKey().trim() !== "";
  }

  async search(
    name: string,
    systemId: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<CoverArtCandidate[]> {
    if (opts.signal?.aborted) return [];
    const key = this.getApiKey().trim();
    if (!key) return [];
    const platform = systemIdToMobyPlatformId(systemId);
    if (platform === undefined) return [];
    const normQuery = normalizeRomName(name);
    if (!normQuery) return [];

    const limit = Math.max(1, Math.min(20, opts.limit ?? 6));
    const cacheKey = `moby|${systemId}|${normQuery}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached.slice(0, limit);

    const url =
      "https://api.mobygames.com/v1/games" +
      `?title=${encodeURIComponent(normQuery)}` +
      `&platform=${platform}` +
      `&format=normal` +
      `&api_key=${encodeURIComponent(key)}`;

    let body: MobyGamesGamesResponse;
    try {
      const resp = await this.fetchImpl(url, { signal: opts.signal });
      if (!resp.ok) return [];
      body = (await resp.json()) as MobyGamesGamesResponse;
    } catch {
      return [];
    }

    const out: CoverArtCandidate[] = [];
    const seen = new Set<string>();
    for (const g of body.games ?? []) {
      const title = typeof g.title === "string" ? g.title : "";
      if (!title) continue;
      const cover = g.sample_cover;
      const img = cover && typeof cover.image === "string" ? cover.image : null;
      if (!img || seen.has(img)) continue;
      seen.add(img);
      const normCandidate = normalizeRomName(title);
      const score = diceCoefficient(normQuery, normCandidate);
      if (score <= 0) continue;
      out.push({ title, systemId, imageUrl: img, sourceName: this.name, score });
    }
    out.sort((a, b) => b.score - a.score);
    const trimmed = out.slice(0, limit);
    this.cache.set(cacheKey, trimmed);
    return trimmed;
  }

  async testConnection(opts: { signal?: AbortSignal } = {}): Promise<true | string> {
    const key = this.getApiKey().trim();
    if (!key) return "No API key configured.";
    const url = `https://api.mobygames.com/v1/games?limit=1&api_key=${encodeURIComponent(key)}`;
    try {
      const resp = await this.fetchImpl(url, { signal: opts.signal });
      if (resp.status === 401 || resp.status === 403) return "MobyGames rejected the API key.";
      if (!resp.ok) return `MobyGames returned HTTP ${resp.status}.`;
      return true;
    } catch (err) {
      return `Could not reach MobyGames: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/**
 * Type guard for providers that declare `requiresApiKey`. Useful in the
 * Settings UI when rendering a row per keyed provider.
 */
export function isApiKeyedProvider(p: CoverArtProvider): p is ApiKeyedProvider {
  return (p as Partial<ApiKeyedProvider>).requiresApiKey === true;
}

// ── TheGamesDB ──────────────────────────────────────────────────────────────

/**
 * RetroOasis systemId → TheGamesDB platform id. Values are from
 * TheGamesDB's public platform catalogue (https://api.thegamesdb.net/v1/Platforms).
 * Systems without a stable TGDB mapping are omitted; the provider returns
 * `[]` for unmapped systems rather than guessing.
 */
const TGDB_PLATFORM_MAP: Readonly<Record<string, number>> = Object.freeze({
  nes:        7,
  snes:       6,
  gb:         4,
  gbc:        41,
  gba:        5,
  nds:        8,
  n64:        3,
  segaMD:     36,   // Sega Genesis / Mega Drive
  segaMS:     35,
  segaGG:     20,
  segaSaturn: 17,
  segaDC:     16,
  psx:        10,   // Sony PlayStation
  psp:        13,
  atari2600:  22,
  atari7800:  27,
  lynx:       4924,
  ngp:        4922,
  arcade:     23,
});

/** Return the TheGamesDB platform id for a systemId, or undefined. */
export function systemIdToTgdbPlatformId(systemId: string): number | undefined {
  return TGDB_PLATFORM_MAP[systemId];
}

/** Tunable options for `TheGamesDBCoverArtProvider`. */
export interface TheGamesDBProviderOptions {
  getApiKey: () => string;
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
}

/** Subset of TheGamesDB `/v1/Games/ByGameName` response we rely on. */
interface TgdbGamesByNameResponse {
  data?: {
    games?: Array<{
      id?: number;
      game_title?: string;
      platform?: number;
    }>;
  };
}

/** Subset of TheGamesDB `/v1/Games/Images` response we rely on. */
interface TgdbImagesResponse {
  data?: {
    base_url?: {
      original?: string;
      large?: string;
      medium?: string;
      small?: string;
      thumb?: string;
    };
    images?: Record<string, Array<{
      id?: number;
      type?: string;
      side?: string | null;
      filename?: string;
    }>>;
  };
}

/**
 * TheGamesDB-backed cover art provider. Requires the user to supply their
 * own TheGamesDB API key via the Settings "API Keys" tab (free for personal
 * use; request at https://thegamesdb.net/).
 *
 * Strategy:
 *   1. Call `/v1/Games/ByGameName?name=<q>&filter[platform]=<id>&apikey=<key>`.
 *   2. Collect up to `limit` game ids.
 *   3. Call `/v1/Games/Images?games_id=<comma-list>&filter[type]=boxart`
 *      to batch-fetch the box-art URLs for those ids.
 *   4. Score against the normalised query name with the existing Dice
 *      coefficient, prefer "front" boxart over "back".
 */
export class TheGamesDBCoverArtProvider implements ApiKeyedProvider {
  readonly id = "thegamesdb";
  readonly name = "TheGamesDB";
  readonly requiresApiKey = true as const;
  readonly providerId = "thegamesdb";
  readonly signupUrl = "https://thegamesdb.net/";

  private readonly getApiKey: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: KeyedProviderCache;

  constructor(opts: TheGamesDBProviderOptions) {
    this.getApiKey = opts.getApiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.cache = new KeyedProviderCache(opts.cacheTtlMs);
  }

  isAvailable(): boolean {
    return this.getApiKey().trim() !== "";
  }

  async search(
    name: string,
    systemId: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<CoverArtCandidate[]> {
    if (opts.signal?.aborted) return [];
    const key = this.getApiKey().trim();
    if (!key) return [];
    const platform = systemIdToTgdbPlatformId(systemId);
    if (platform === undefined) return [];
    const normQuery = normalizeRomName(name);
    if (!normQuery) return [];

    const limit = Math.max(1, Math.min(20, opts.limit ?? 6));
    const cacheKey = `tgdb|${systemId}|${normQuery}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached.slice(0, limit);

    // Step 1 — game list.
    const listUrl =
      "https://api.thegamesdb.net/v1/Games/ByGameName" +
      `?name=${encodeURIComponent(normQuery)}` +
      `&filter%5Bplatform%5D=${platform}` +
      `&apikey=${encodeURIComponent(key)}`;

    let listBody: TgdbGamesByNameResponse;
    try {
      const resp = await this.fetchImpl(listUrl, { signal: opts.signal });
      if (!resp.ok) return [];
      listBody = (await resp.json()) as TgdbGamesByNameResponse;
    } catch {
      return [];
    }

    const games = listBody.data?.games ?? [];
    if (games.length === 0) return [];

    // Keep the best `limit` candidates by title similarity before we spend a
    // second round-trip asking for images.
    const ranked = games
      .map((g) => {
        const title = typeof g.game_title === "string" ? g.game_title : "";
        const id = typeof g.id === "number" ? g.id : NaN;
        const score = diceCoefficient(normQuery, normalizeRomName(title));
        return { id, title, score };
      })
      .filter((g) => Number.isFinite(g.id) && g.title && g.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (ranked.length === 0) return [];
    if (opts.signal?.aborted) return [];

    // Step 2 — fetch boxart URLs for those ids.
    const idsCsv = ranked.map((r) => r.id).join(",");
    const imgUrl =
      "https://api.thegamesdb.net/v1/Games/Images" +
      `?games_id=${encodeURIComponent(idsCsv)}` +
      `&filter%5Btype%5D=boxart` +
      `&apikey=${encodeURIComponent(key)}`;

    let imgBody: TgdbImagesResponse;
    try {
      const resp = await this.fetchImpl(imgUrl, { signal: opts.signal });
      if (!resp.ok) return [];
      imgBody = (await resp.json()) as TgdbImagesResponse;
    } catch {
      return [];
    }

    const baseUrl =
      imgBody.data?.base_url?.original ||
      imgBody.data?.base_url?.large ||
      imgBody.data?.base_url?.medium ||
      "";
    const imagesByGame = imgBody.data?.images ?? {};

    const out: CoverArtCandidate[] = [];
    const seen = new Set<string>();
    for (const r of ranked) {
      const entries = imagesByGame[String(r.id)] ?? [];
      // Prefer the front cover, then any boxart, then fall back to no-side.
      const front = entries.find((e) => e.type === "boxart" && e.side === "front");
      const back  = entries.find((e) => e.type === "boxart" && e.side === "back");
      const any   = entries.find((e) => e.type === "boxart");
      const chosen = front ?? any ?? back ?? null;
      if (!chosen || typeof chosen.filename !== "string" || !chosen.filename) continue;
      // base_url may end with "/" already — handle both shapes safely.
      const fullUrl = baseUrl.endsWith("/")
        ? `${baseUrl}${chosen.filename}`
        : `${baseUrl}/${chosen.filename}`;
      if (!fullUrl || seen.has(fullUrl)) continue;
      seen.add(fullUrl);
      // Front cover is full score; back cover gets a small penalty so the
      // front image is surfaced first in the picker.
      const score = chosen === back && !front ? Math.max(0, r.score - 0.1) : r.score;
      out.push({ title: r.title, systemId, imageUrl: fullUrl, sourceName: this.name, score });
    }
    out.sort((a, b) => b.score - a.score);
    const trimmed = out.slice(0, limit);
    this.cache.set(cacheKey, trimmed);
    return trimmed;
  }

  async testConnection(opts: { signal?: AbortSignal } = {}): Promise<true | string> {
    const key = this.getApiKey().trim();
    if (!key) return "No API key configured.";
    // Minimal probe: the platforms endpoint is fixed-size and cheap.
    const url = `https://api.thegamesdb.net/v1/Platforms?apikey=${encodeURIComponent(key)}`;
    try {
      const resp = await this.fetchImpl(url, { signal: opts.signal });
      if (resp.status === 401 || resp.status === 403) return "TheGamesDB rejected the API key.";
      if (!resp.ok) return `TheGamesDB returned HTTP ${resp.status}.`;
      return true;
    } catch (err) {
      return `Could not reach TheGamesDB: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// ── SteamGridDB ───────────────────────────────────────────────────────────────

/** Tunable options for `SteamGridDBCoverArtProvider`. */
export interface SteamGridDBProviderOptions {
  getApiKey: () => string;
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
}

interface SteamGridDBResponse<T> {
  success?: boolean;
  data?: T;
  errors?: string[];
}

interface SteamGridDBGameSummary {
  id?: number;
  name?: string;
}

interface SteamGridDBGridAsset {
  id?: number;
  url?: string;
  thumb?: string;
  width?: number;
  height?: number;
}

/**
 * SteamGridDB-backed cover provider. SteamGridDB's "grid" assets include
 * portrait-style Steam library covers; these are useful when classic box-art
 * sources miss modern fan art, homebrew, translations, or PC-adjacent entries.
 */
export class SteamGridDBCoverArtProvider implements ApiKeyedProvider {
  readonly id = "steamgriddb";
  readonly name = "SteamGridDB";
  readonly requiresApiKey = true as const;
  readonly providerId = "steamgriddb";
  readonly signupUrl = "https://www.steamgriddb.com/profile/api";

  private readonly getApiKey: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: KeyedProviderCache;

  constructor(opts: SteamGridDBProviderOptions) {
    this.getApiKey = opts.getApiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.cache = new KeyedProviderCache(opts.cacheTtlMs);
  }

  isAvailable(): boolean {
    return this.getApiKey().trim() !== "";
  }

  async search(
    name: string,
    systemId: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<CoverArtCandidate[]> {
    if (opts.signal?.aborted) return [];
    const key = this.getApiKey().trim();
    if (!key) return [];
    const normQuery = normalizeRomName(name);
    if (!normQuery) return [];

    const limit = Math.max(1, Math.min(20, opts.limit ?? 6));
    const cacheKey = `sgdb|${systemId}|${normQuery}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached.slice(0, limit);

    const searchUrl =
      "https://www.steamgriddb.com/api/v2/search/autocomplete/" +
      encodeURIComponent(normQuery);

    let games: SteamGridDBGameSummary[];
    try {
      const resp = await this.fetchImpl(searchUrl, {
        signal: opts.signal,
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!resp.ok) return [];
      const body = (await resp.json()) as SteamGridDBResponse<SteamGridDBGameSummary[]>;
      games = Array.isArray(body.data) ? body.data : [];
    } catch {
      return [];
    }

    const rankedGames = games
      .map((g) => {
        const title = typeof g.name === "string" ? g.name : "";
        const id = typeof g.id === "number" ? g.id : NaN;
        const score = diceCoefficient(normQuery, normalizeRomName(title));
        return { id, title, score };
      })
      .filter((g) => Number.isFinite(g.id) && g.title && g.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(limit, 4));

    if (rankedGames.length === 0) return [];

    const out: CoverArtCandidate[] = [];
    const seen = new Set<string>();
    for (const game of rankedGames) {
      if (opts.signal?.aborted) return [];
      const gridsUrl =
        `https://www.steamgriddb.com/api/v2/grids/game/${game.id}` +
        "?dimensions=600x900,342x482,660x930,512x512" +
        "&types=static";
      let grids: SteamGridDBGridAsset[];
      try {
        const resp = await this.fetchImpl(gridsUrl, {
          signal: opts.signal,
          headers: { Authorization: `Bearer ${key}` },
        });
        if (!resp.ok) continue;
        const body = (await resp.json()) as SteamGridDBResponse<SteamGridDBGridAsset[]>;
        grids = Array.isArray(body.data) ? body.data : [];
      } catch {
        continue;
      }

      const sortedGrids = grids
        .filter((grid) => typeof grid.url === "string" && grid.url)
        .sort((a, b) => {
          const portraitA = (a.height ?? 0) > (a.width ?? 0) ? 1 : 0;
          const portraitB = (b.height ?? 0) > (b.width ?? 0) ? 1 : 0;
          return portraitB - portraitA;
        });

      for (const grid of sortedGrids) {
        const imageUrl = grid.url!;
        if (seen.has(imageUrl)) continue;
        seen.add(imageUrl);
        const portraitBonus = (grid.height ?? 0) > (grid.width ?? 0) ? 0 : -0.08;
        out.push({
          title: game.title,
          systemId,
          imageUrl,
          sourceName: this.name,
          score: Math.max(0, game.score + portraitBonus),
        });
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }

    out.sort((a, b) => b.score - a.score);
    const trimmed = out.slice(0, limit);
    this.cache.set(cacheKey, trimmed);
    return trimmed;
  }

  async testConnection(opts: { signal?: AbortSignal } = {}): Promise<true | string> {
    const key = this.getApiKey().trim();
    if (!key) return "No API key configured.";
    const url = "https://www.steamgriddb.com/api/v2/search/autocomplete/portal";
    try {
      const resp = await this.fetchImpl(url, {
        signal: opts.signal,
        headers: { Authorization: `Bearer ${key}` },
      });
      if (resp.status === 401 || resp.status === 403) return "SteamGridDB rejected the API key.";
      if (!resp.ok) return `SteamGridDB returned HTTP ${resp.status}.`;
      return true;
    } catch (err) {
      return `Could not reach SteamGridDB: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// ── ScreenScraper provider ───────────────────────────────────────────────────

/**
 * ScreenScraper.fr-backed cover art provider.
 *
 * Primary path: ROM hash (MD5) → exact database match → box-2D media URL.
 * Fallback path: ROM filename → near-exact match.
 *
 * Requires a ScreenScraper account (ssid:sspassword in the API Keys settings).
 */
export class ScreenScraperCoverArtProvider implements ApiKeyedProvider {
  readonly id = "screenscraper";
  readonly name = "ScreenScraper.fr";
  readonly requiresApiKey = true as const;
  readonly providerId = "screenscraper";
  readonly signupUrl = "https://www.screenscraper.fr/";

  constructor(private readonly getApiKey: () => string) {}

  isAvailable(): boolean {
    return !!this.getApiKey().trim();
  }

  async search(
    name: string,
    systemId: string,
    opts: {
      limit?: number;
      signal?: AbortSignal;
      hashes?: { md5?: string; sha1?: string };
      /** Original ROM filename — used as fallback when no hash is available. */
      fileName?: string;
    } = {},
  ): Promise<CoverArtCandidate[]> {
    const key = this.getApiKey().trim();
    if (!key) return [];

    // Lazy-import to avoid bundling SS code until actually needed
    const [{ SYSTEMS }, { ScreenScraperClient, pickBestCoverMedia }] = await Promise.all([
      import("./systems.js"),
      import("./screenscraper.js"),
    ]);

    const sysInfo = SYSTEMS.find(s => s.id === systemId);
    if (!sysInfo?.screenscraperId) return [];

    const client = new ScreenScraperClient(key);
    const { signal } = opts;

    let game: import("./screenscraper.js").ScreenScraperGame | null = null;

    // ── 1. Hash-based lookup (most accurate) ──────────────────────────────────
    const md5 = opts.hashes?.md5;
    const sha1 = opts.hashes?.sha1;

    if (md5) {
      try {
        game = await client.getGameByHash(md5, "md5", sysInfo.screenscraperId, signal);
      } catch (err) {
        // Non-fatal: log and fall through to filename fallback
        diagDevWarn("[ScreenScraper] Hash lookup (md5) failed:", err instanceof Error ? err.message : err);
      }
    }

    if (!game && sha1) {
      try {
        game = await client.getGameByHash(sha1, "sha1", sysInfo.screenscraperId, signal);
      } catch (err) {
        diagDevWarn("[ScreenScraper] Hash lookup (sha1) failed:", err instanceof Error ? err.message : err);
      }
    }

    // ── 2. Filename fallback ──────────────────────────────────────────────────
    if (!game) {
      // Use the raw filename if available, otherwise construct one from the display name.
      // ScreenScraper filename matching expects the extension to be present.
      const fileName = opts.fileName || name;
      try {
        game = await client.getGameByFileName(fileName, sysInfo.screenscraperId, signal);
      } catch (err) {
        diagDevWarn("[ScreenScraper] Filename lookup failed:", err instanceof Error ? err.message : err);
      }
    }

    if (!game) return [];

    // ── 3. Pick best media ────────────────────────────────────────────────────
    const best = pickBestCoverMedia(game.medias);
    if (!best?.url) return [];

    const title = game.names.find(n => n.region === "us")?.name
      || game.names.find(n => n.region === "wor")?.name
      || game.names[0]?.name
      || name;

    // Hash match = 1.0 confidence; filename match = 0.85
    const wasHashMatch = !!(md5 || sha1);
    const score = wasHashMatch ? 1.0 : 0.85;

    return [{
      title,
      systemId,
      imageUrl: best.url,
      sourceName: this.name,
      score,
    }];
  }

  async testConnection(opts: { signal?: AbortSignal } = {}): Promise<true | string> {
    const key = this.getApiKey().trim();
    if (!key) return "No credentials configured. Enter your ScreenScraper.fr userid:password.";

    const { ScreenScraperClient } = await import("./screenscraper.js");
    const client = new ScreenScraperClient(key);
    const result = await client.testCredentials(opts.signal);
    if (result.ok) return true;
    return `ScreenScraper authentication failed: ${result.message}`;
  }
}
