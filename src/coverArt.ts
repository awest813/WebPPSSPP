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
    opts?: { limit?: number; signal?: AbortSignal },
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
  gb:          ["Game Boy", "GB", "GameBoy"],
  gbc:         ["Game Boy Color", "GBC", "GameBoy Color"],
  gba:         ["Game Boy Advance", "GBA", "GameBoy Advance"],
  nds:         ["Nintendo DS", "NDS", "DS"],
  n64:         ["Nintendo 64", "N64"],
  segaMD:      ["Sega Genesis", "Mega Drive", "Genesis", "Sega Mega Drive"],
  segaMS:      ["Sega Master System", "Master System"],
  segaGG:      ["Sega Game Gear", "Game Gear"],
  segaSaturn:  ["Sega Saturn", "Saturn"],
  segaDC:      ["Sega Dreamcast", "Dreamcast"],
  psx:         ["Sony Playstation", "PlayStation", "PS1", "PSX", "Sony PlayStation"],
  psp:         ["Sony PSP", "PSP", "PlayStation Portable"],
  atari2600:   ["Atari 2600", "2600"],
  atari7800:   ["Atari 7800", "7800"],
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
    return [];
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

/**
 * Fetch a candidate's image URL and validate the response with
 * `createImageBitmap`, mirroring the existing "Use Image URL" flow in the
 * cover art picker. Returns the validated Blob on success; throws otherwise.
 */
export async function fetchAndValidateCoverArt(
  url: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<Blob> {
  const impl = opts.fetchImpl ?? fetch.bind(globalThis);
  const resp = await impl(url, { mode: "cors", signal: opts.signal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();
  // Guard against non-image responses masquerading behind image/* content-type.
  const bitmap = await createImageBitmap(blob);
  bitmap.close();
  return blob;
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
  gb:         ["Nintendo - Game Boy"],
  gbc:        ["Nintendo - Game Boy Color"],
  gba:        ["Nintendo - Game Boy Advance"],
  nds:        ["Nintendo - Nintendo DS"],
  n64:        ["Nintendo - Nintendo 64"],
  segaMD:     ["Sega - Mega Drive - Genesis"],
  segaMS:     ["Sega - Master System - Mark III"],
  segaGG:     ["Sega - Game Gear"],
  segaSaturn: ["Sega - Saturn"],
  segaDC:     ["Sega - Dreamcast"],
  psx:        ["Sony - PlayStation"],
  psp:        ["Sony - PlayStation Portable"],
  atari2600:  ["Atari - 2600"],
  atari7800:  ["Atari - 7800"],
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
 */
export class ChainedCoverArtProvider implements CoverArtProvider {
  readonly id = "chained";
  readonly name = "All Sources";

  constructor(private readonly providers: readonly CoverArtProvider[]) {}

  async search(
    name: string,
    systemId: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<CoverArtCandidate[]> {
    const limit = Math.max(1, Math.min(20, opts.limit ?? 6));
    const all: CoverArtCandidate[] = [];
    const seenUrls = new Set<string>();

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
