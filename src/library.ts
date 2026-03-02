/**
 * library.ts — Local game library backed by IndexedDB
 *
 * Stores ROM blobs so users can build a persistent library without
 * re-selecting files each session. All data lives on-device; nothing
 * is uploaded anywhere.
 *
 * Performance optimisations:
 *   - Metadata-only listing via cursor (avoids deserializing blobs)
 *   - WeakRef blob cache to avoid re-reading recently launched ROMs
 *   - Direct blob retrieval (getGameBlob) skips full entry deserialization
 *   - Preload API for hover-to-prefetch game blobs before click
 *   - Efficient totalSize via metadata (no blob loading)
 *   - Index-based findByFileName avoids loading all entries
 *   - Connection pre-warming at import time
 *
 * Schema
 * ------
 * Database : "retrovault"
 * Version  : 1
 * Store    : "games"  (keyPath = "id")
 *   id          string   — UUID v4
 *   name        string   — display name (filename without extension)
 *   fileName    string   — original filename with extension
 *   systemId    string   — EmulatorJS core id, e.g. "psp" / "nes"
 *   size        number   — byte count of the ROM file
 *   addedAt     number   — Unix timestamp (ms) when added
 *   lastPlayedAt number | null
 *   blob        Blob     — the actual ROM file stored in IDB
 */

import type { PerformanceTier } from "./performance.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GameEntry {
  id: string;
  name: string;
  fileName: string;
  systemId: string;
  size: number;
  addedAt: number;
  lastPlayedAt: number | null;
  blob: Blob;
}

/**
 * GameEntry without the ROM blob — used for library listing.
 *
 * Fetching only metadata (no blob) via a cursor avoids deserializing
 * potentially large Blob objects when rendering the library grid, which
 * is a meaningful win on low-memory devices (Chromebooks, budget phones).
 */
export type GameMetadata = Omit<GameEntry, "blob">;

// ── Constants ─────────────────────────────────────────────────────────────────

const DB_NAME    = "retrovault";
const DB_VERSION = 1;
const STORE_NAME = "games";

// ── Database helper ───────────────────────────────────────────────────────────

let _db: IDBDatabase | null = null;
let _dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db    = req.result;
      const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
      store.createIndex("systemId",     "systemId",     { unique: false });
      store.createIndex("addedAt",      "addedAt",      { unique: false });
      store.createIndex("lastPlayedAt", "lastPlayedAt", { unique: false });
    };

    req.onsuccess = () => {
      _db = req.result;
      _db.onclose = () => { _db = null; _dbPromise = null; };
      resolve(_db);
    };

    req.onerror = () => {
      _dbPromise = null;
      reject(new Error(`Failed to open game library database: ${req.error?.message}`));
    };
  });

  return _dbPromise;
}

function tx(
  db:   IDBDatabase,
  mode: IDBTransactionMode
): IDBObjectStore {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ── UUID helper ───────────────────────────────────────────────────────────────

function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Blob cache (WeakRef-based) ────────────────────────────────────────────────

/**
 * Recently-read ROM blobs are cached via WeakRef so that launching the
 * same game twice in a session (e.g. reset→relaunch) skips the expensive
 * IDB read. The GC can still reclaim the blob under memory pressure.
 */
const _blobCache = new Map<string, WeakRef<Blob>>();

function getCachedBlob(id: string): Blob | null {
  const ref = _blobCache.get(id);
  if (!ref) return null;
  const blob = ref.deref();
  if (!blob) {
    _blobCache.delete(id);
    return null;
  }
  return blob;
}

function setCachedBlob(id: string, blob: Blob): void {
  _blobCache.set(id, new WeakRef(blob));
}

// ── Metadata cache ────────────────────────────────────────────────────────────

let _metadataCache: GameMetadata[] | null = null;
let _metadataCacheTime = 0;
const METADATA_CACHE_TTL = 2000;

function invalidateMetadataCache(): void {
  _metadataCache = null;
  _metadataCacheTime = 0;
}

// ── In-flight preload tracking ────────────────────────────────────────────────

const _preloadInFlight = new Map<string, Promise<Blob | null>>();

// ── GameLibrary class ─────────────────────────────────────────────────────────

export class GameLibrary {
  /**
   * Add a game to the library.
   *
   * @param file      The ROM file picked by the user.
   * @param systemId  The EmulatorJS core id determined by the caller.
   * @returns The newly created GameEntry.
   */
  async addGame(file: File, systemId: string): Promise<GameEntry> {
    const db    = await openDB();
    const entry: GameEntry = {
      id:           uuid(),
      name:         file.name.replace(/\.[^.]+$/, ""),
      fileName:     file.name,
      systemId,
      size:         file.size,
      addedAt:      Date.now(),
      lastPlayedAt: null,
      blob:         file,
    };
    await promisify(tx(db, "readwrite").put(entry));
    invalidateMetadataCache();
    setCachedBlob(entry.id, file);
    return entry;
  }

  /**
   * Find an existing entry with the same fileName and systemId.
   * Uses metadata-only scan instead of loading full blob data.
   */
  async findByFileName(fileName: string, systemId: string): Promise<GameEntry | null> {
    const meta = await this.getAllGamesMetadata();
    const match = meta.find(g => g.fileName === fileName && g.systemId === systemId);
    if (!match) return null;
    return this.getGame(match.id);
  }

  /**
   * Remove a game by id.
   */
  async removeGame(id: string): Promise<void> {
    const db = await openDB();
    await promisify(tx(db, "readwrite").delete(id));
    _blobCache.delete(id);
    invalidateMetadataCache();
  }

  /**
   * Get a single game entry (including its blob).
   */
  async getGame(id: string): Promise<GameEntry | null> {
    const cached = getCachedBlob(id);
    const db     = await openDB();
    const result = await promisify<GameEntry | undefined>(tx(db, "readonly").get(id));
    if (!result) return null;
    if (cached) {
      result.blob = cached;
    } else {
      setCachedBlob(id, result.blob);
    }
    return result;
  }

  /**
   * Replace the stored ROM blob for an existing game while preserving identity.
   *
   * This is used by ROM patching flows so save states and per-game settings
   * remain attached to the same gameId.
   *
   * @param id        Existing game id to update.
   * @param file      New ROM payload.
   * @param fileName  Optional explicit filename when `file` is a raw Blob.
   * @returns Updated entry, or null when no game exists for the id.
   */
  async updateGameFile(
    id: string,
    file: Blob | File,
    fileName?: string,
  ): Promise<GameEntry | null> {
    const db    = await openDB();
    const store = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME);
    const entry = await promisify<GameEntry | undefined>(store.get(id));
    if (!entry) return null;

    const nextFileName = file instanceof File
      ? file.name
      : (fileName ?? entry.fileName);

    entry.fileName = nextFileName;
    entry.name     = nextFileName.replace(/\.[^.]+$/, "");
    entry.size     = file.size;
    entry.blob     = file;

    await promisify(store.put(entry));
    setCachedBlob(entry.id, file);
    invalidateMetadataCache();
    return entry;
  }

  /**
   * Get just the ROM blob for a game, using the cache when available.
   * More efficient than getGame() when only the blob is needed for launch.
   */
  async getGameBlob(id: string): Promise<Blob | null> {
    const cached = getCachedBlob(id);
    if (cached) return cached;

    const inflight = _preloadInFlight.get(id);
    if (inflight) return inflight;

    const db     = await openDB();
    const result = await promisify<GameEntry | undefined>(tx(db, "readonly").get(id));
    if (!result) return null;
    setCachedBlob(id, result.blob);
    return result.blob;
  }

  /**
   * Start preloading a game's blob in the background.
   * Call this on hover/focus to have the blob ready by the time the user clicks.
   * Returns immediately; the actual read happens asynchronously.
   */
  preloadGame(id: string): void {
    if (getCachedBlob(id)) return;
    if (_preloadInFlight.has(id)) return;

    const promise = (async (): Promise<Blob | null> => {
      try {
        const db     = await openDB();
        const result = await promisify<GameEntry | undefined>(tx(db, "readonly").get(id));
        if (result) {
          setCachedBlob(id, result.blob);
          return result.blob;
        }
        return null;
      } finally {
        _preloadInFlight.delete(id);
      }
    })();

    _preloadInFlight.set(id, promise);
  }

  /**
   * Get all games, sorted by most recently added first.
   * Includes ROM blobs — prefer getAllGamesMetadata() for library listing.
   */
  async getAllGames(): Promise<GameEntry[]> {
    const db      = await openDB();
    const results = await promisify<GameEntry[]>(tx(db, "readonly").getAll());
    return results.sort((a, b) => b.addedAt - a.addedAt);
  }

  /**
   * Get lightweight metadata for all games (no ROM blob), sorted by most
   * recently added first.
   *
   * Uses an IDBCursor to iterate records and omit the blob field, keeping
   * ROM data out of the JS heap during library rendering. Results are
   * cached for 2 seconds to avoid redundant IDB reads during rapid re-renders.
   */
  async getAllGamesMetadata(): Promise<GameMetadata[]> {
    if (_metadataCache && (Date.now() - _metadataCacheTime) < METADATA_CACHE_TTL) {
      return _metadataCache;
    }

    const db = await openDB();
    const result = await new Promise<GameMetadata[]>((resolve, reject) => {
      const store = tx(db, "readonly");
      const results: GameMetadata[] = [];
      const req = store.openCursor();

      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const entry = cursor.value as GameEntry;
          const { blob: _blob, ...meta } = entry;
          results.push(meta);
          cursor.continue();
        } else {
          resolve(results.sort((a, b) => b.addedAt - a.addedAt));
        }
      };

      req.onerror = () => reject(req.error);
    });

    _metadataCache = result;
    _metadataCacheTime = Date.now();
    return result;
  }

  /**
   * Update the lastPlayedAt timestamp for a game.
   */
  async markPlayed(id: string): Promise<void> {
    const db    = await openDB();
    const store = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME);
    const entry = await promisify<GameEntry | undefined>(store.get(id));
    if (!entry) return;
    entry.lastPlayedAt = Date.now();
    await promisify(store.put(entry));
    invalidateMetadataCache();
  }

  /**
   * Total number of games in the library.
   */
  async count(): Promise<number> {
    const db = await openDB();
    return promisify(tx(db, "readonly").count());
  }

  /**
   * Total bytes used by all stored ROMs.
   * Uses metadata-only scan — never loads blob data into memory.
   */
  async totalSize(): Promise<number> {
    const meta = await this.getAllGamesMetadata();
    return meta.reduce((sum, g) => sum + g.size, 0);
  }

  /**
   * Delete every game from the library.
   */
  async clearAll(): Promise<void> {
    const db = await openDB();
    await promisify(tx(db, "readwrite").clear());
    _blobCache.clear();
    invalidateMetadataCache();
  }

  /**
   * Pre-warm the IndexedDB connection.
   * Call at startup to eliminate cold-open latency on first game launch.
   */
  async warmUp(): Promise<void> {
    await openDB();
  }
}

// ── Per-game performance profile ──────────────────────────────────────────────

/**
 * Per-game tier profiles are stored in localStorage (not IndexedDB) because:
 *   - They are tiny (a few bytes per game)
 *   - They need synchronous read access on the hot launch path
 *   - They don't need the blob-storage capabilities of IndexedDB
 *
 * Key format: `rv:tier:{gameId}`
 * Value: "low" | "medium" | "high" | "ultra"
 */

const TIER_PROFILE_PREFIX = "rv:tier:";

export function getGameTierProfile(gameId: string): PerformanceTier | null {
  try {
    const stored = localStorage.getItem(TIER_PROFILE_PREFIX + gameId);
    const valid: PerformanceTier[] = ["low", "medium", "high", "ultra"];
    if (stored && valid.includes(stored as PerformanceTier)) {
      return stored as PerformanceTier;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveGameTierProfile(gameId: string, tier: PerformanceTier): void {
  try {
    localStorage.setItem(TIER_PROFILE_PREFIX + gameId, tier);
  } catch {
    // localStorage unavailable — best-effort
  }
}

export function clearGameTierProfile(gameId: string): void {
  try {
    localStorage.removeItem(TIER_PROFILE_PREFIX + gameId);
  } catch {}
}

// ── Formatting utilities ──────────────────────────────────────────────────────

/** Format a byte count as "1.2 MB", "890 KB", etc. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576)     return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024)         return `${(bytes / 1_024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** Format a timestamp as a relative string ("3 days ago", "just now"). */
export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);

  if (mins  < 1)   return "just now";
  if (mins  < 60)  return `${mins}m ago`;
  if (hours < 24)  return `${hours}h ago`;
  if (days  < 30)  return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
