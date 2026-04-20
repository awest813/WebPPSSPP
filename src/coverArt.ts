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
