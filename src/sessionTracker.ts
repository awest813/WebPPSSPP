/**
 * sessionTracker.ts — Play-time tracking backed by IndexedDB
 *
 * Records completed play sessions so users can see how much time they have
 * spent with each game.  All data lives on-device; nothing is uploaded anywhere.
 *
 * Sessions shorter than MIN_SESSION_MS are silently discarded — this avoids
 * polluting the history with accidental launches or failed starts.
 *
 * Schema
 * ------
 * Database : "retrovault-history"
 * Version  : 1
 * Store    : "playSessions"  (keyPath = "id")
 *   id          string   — UUID v4
 *   gameId      string   — UUID from the game library
 *   gameName    string   — display name at time of session
 *   systemId    string   — EmulatorJS core id, e.g. "psp" / "nes"
 *   startedAt   number   — Unix timestamp (ms) when the session started
 *   endedAt     number   — Unix timestamp (ms) when the session ended
 *   durationMs  number   — endedAt − startedAt (always >= MIN_SESSION_MS)
 *
 * Index: "gameId" → efficient per-game stats queries
 */

import { createUuid } from "./uuid.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PlaySession {
  id: string;
  gameId: string;
  gameName: string;
  systemId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

export interface GamePlayStats {
  /** Total milliseconds played across all recorded sessions. */
  totalMs: number;
  /** Number of recorded sessions. */
  sessionCount: number;
  /** Unix timestamp (ms) of the most recent session end, or null when no sessions exist. */
  lastPlayedAt: number | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DB_NAME    = "retrovault-history";
const DB_VERSION = 1;
const STORE_NAME = "playSessions";

/**
 * Sessions shorter than this threshold are not written to the database.
 * This prevents accidental launches or failed starts from appearing in history.
 */
export const MIN_SESSION_MS = 5_000;

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
      store.createIndex("gameId",    "gameId",    { unique: false });
      store.createIndex("startedAt", "startedAt", { unique: false });
    };

    req.onsuccess = () => {
      _db = req.result;
      _db.onclose = () => { _db = null; _dbPromise = null; };
      resolve(_db);
    };

    req.onerror = () => {
      _dbPromise = null;
      reject(new Error(`Failed to open play-history database: ${req.error?.message}`));
    };
  });

  return _dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ── SessionTracker ────────────────────────────────────────────────────────────

/**
 * Tracks a single in-progress play session and persists completed sessions to
 * IndexedDB.
 *
 * @example
 * ```ts
 * const tracker = new SessionTracker();
 *
 * // When the game starts:
 * tracker.startSession("game-id", "Sonic the Hedgehog", "genesis");
 *
 * // When the user returns to the library or closes the tab:
 * await tracker.endSession();
 *
 * // Query per-game stats:
 * const stats = await tracker.getStats("game-id");
 * console.log(`${stats.totalMs / 60_000} minutes played`);
 * ```
 */
export class SessionTracker {
  private _gameId:    string | null = null;
  private _gameName:  string | null = null;
  private _systemId:  string | null = null;
  private _startedAt: number | null = null;

  /** Whether a session is currently in progress. */
  get isTracking(): boolean {
    return this._startedAt !== null;
  }

  /**
   * Pre-open the IndexedDB connection so the first session end is fast.
   * Returns a resolved promise — errors are swallowed because warm-up
   * failures should not affect gameplay.
   */
  warmUp(): Promise<void> {
    return openDB().then(() => {}).catch(() => {});
  }

  /**
   * Begin tracking a new session.
   *
   * If a session is already in progress, it is ended first (best-effort,
   * without awaiting IDB persistence) before the new one begins.
   * This ensures back-to-back launches don't orphan an open session.
   */
  startSession(gameId: string, gameName: string, systemId: string): void {
    if (this._startedAt !== null) {
      // End the previous session synchronously with the current timestamp.
      void this._flush(Date.now());
    }
    this._gameId    = gameId;
    this._gameName  = gameName;
    this._systemId  = systemId;
    this._startedAt = Date.now();
  }

  /**
   * End the current session and persist it to IndexedDB.
   *
   * Resolves immediately when no session is in progress.
   * Short sessions (< MIN_SESSION_MS) are silently discarded.
   */
  async endSession(): Promise<void> {
    if (this._startedAt === null) return;
    await this._flush(Date.now());
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** Write the in-progress session to IDB and reset internal state. */
  private async _flush(endedAt: number): Promise<void> {
    const startedAt = this._startedAt;
    const gameId    = this._gameId;
    const gameName  = this._gameName;
    const systemId  = this._systemId;

    // Reset immediately so a second call (e.g. beforeunload + returnToLibrary)
    // is a reliable no-op even if the IDB write is still in flight.
    this._startedAt = null;
    this._gameId    = null;
    this._gameName  = null;
    this._systemId  = null;

    if (startedAt === null || gameId === null || gameName === null || systemId === null) {
      return;
    }

    const durationMs = endedAt - startedAt;
    if (durationMs < MIN_SESSION_MS) return;

    const session: PlaySession = {
      id:         createUuid(),
      gameId,
      gameName,
      systemId,
      startedAt,
      endedAt,
      durationMs,
    };

    try {
      const db = await openDB();
      await promisify(
        db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).add(session),
      );
    } catch {
      // Persistence failure must not surface to the user; play continues.
    }
  }

  // ── Query API ───────────────────────────────────────────────────────────────

  /**
   * Return aggregate play statistics for a single game.
   *
   * Returns `{ totalMs: 0, sessionCount: 0, lastPlayedAt: null }` when no
   * sessions exist for the given `gameId`.
   */
  async getStats(gameId: string): Promise<GamePlayStats> {
    const db  = await openDB();
    const req = db
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .index("gameId")
      .getAll(gameId);
    const sessions = await promisify<PlaySession[]>(req);
    return _aggregate(sessions);
  }

  /**
   * Return aggregate play statistics for every game that has at least one
   * recorded session, keyed by `gameId`.
   */
  async getAllStats(): Promise<Map<string, GamePlayStats>> {
    const db       = await openDB();
    const req      = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    const sessions = await promisify<PlaySession[]>(req);

    const byGame = new Map<string, PlaySession[]>();
    for (const s of sessions) {
      const list = byGame.get(s.gameId) ?? [];
      list.push(s);
      byGame.set(s.gameId, list);
    }

    const result = new Map<string, GamePlayStats>();
    for (const [id, list] of byGame) {
      result.set(id, _aggregate(list));
    }
    return result;
  }

  /**
   * Return all recorded sessions as a plain array.
   * Useful for export / backup features.
   */
  async exportAll(): Promise<PlaySession[]> {
    const db  = await openDB();
    const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    return promisify<PlaySession[]>(req);
  }

  /**
   * Delete all recorded sessions.
   * Called when the user clears their play history from the settings panel.
   */
  async clearAll(): Promise<void> {
    const db = await openDB();
    await promisify(
      db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).clear(),
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _aggregate(sessions: PlaySession[]): GamePlayStats {
  if (sessions.length === 0) {
    return { totalMs: 0, sessionCount: 0, lastPlayedAt: null };
  }
  let totalMs      = 0;
  let lastPlayedAt = 0;
  for (const s of sessions) {
    totalMs += s.durationMs;
    if (s.endedAt > lastPlayedAt) lastPlayedAt = s.endedAt;
  }
  return { totalMs, sessionCount: sessions.length, lastPlayedAt };
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/**
 * Format a duration in milliseconds as a human-readable string.
 *
 * @example
 * formatPlayTime(0)          // "0 min"
 * formatPlayTime(90_000)     // "1 min"
 * formatPlayTime(3_661_000)  // "1 h 1 min"
 */
export function formatPlayTime(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours   = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

// ── Module-level singleton ─────────────────────────────────────────────────────

/** Application-wide session tracker singleton. */
export const sessionTracker = new SessionTracker();
