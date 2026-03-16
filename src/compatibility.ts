/**
 * compatibility.ts — Game compatibility database
 *
 * Provides a client-side game compatibility database that maps game IDs to
 * known-good tier overrides, required BIOS files, and known compatibility
 * issues. Checked at launch to surface warnings before the emulator starts.
 *
 * ### Data sources
 * 1. Built-in entries defined at compile time (BUILTIN_COMPAT_DB).
 * 2. User-imported JSON entries stored in localStorage under
 *    "rv:compatDb:custom".
 * 3. Remote JSON (optional) fetched once per session from a configurable URL
 *    and merged at runtime.
 *
 * ### Game ID format
 * The game ID is the string passed to `saveGameTierProfile()` and related
 * functions — typically the ROM filename without extension, lowercased.
 *
 * ### Priority
 * Remote > User > Built-in (later sources override earlier ones for the
 * same game ID).
 */

import type { PerformanceTier } from "./performance.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A single entry in the compatibility database.
 */
export interface CompatibilityEntry {
  /** Human-readable game title (informational). */
  title?: string;
  /**
   * Known-good performance tier override. When set, the emulator will use
   * this tier regardless of the device's detected tier (unless the user has
   * already saved a per-game profile).
   */
  tierOverride?: PerformanceTier;
  /**
   * BIOS file names that are required for this game to run correctly.
   * The caller is responsible for surfacing a warning if any are missing.
   */
  requiredBios?: string[];
  /**
   * Freeform list of known issues with this game.
   * Displayed in the pre-launch info panel when non-empty.
   */
  knownIssues?: string[];
  /**
   * When `true`, this game is known to be fully compatible with the default
   * settings on most devices.
   */
  verified?: boolean;
}

/** The full database shape — a map from game ID to entry. */
export type CompatibilityDb = Record<string, CompatibilityEntry>;

// ── Built-in entries ──────────────────────────────────────────────────────────

/**
 * Minimal set of built-in entries for well-known games and edge cases.
 *
 * Community additions should be submitted via the custom import flow
 * rather than hardcoded here.
 */
const BUILTIN_COMPAT_DB: CompatibilityDb = {
  // PSP — games known to require specific tier settings
  "tekken_dark_resurrection": {
    title:        "Tekken: Dark Resurrection",
    tierOverride: "high",
    verified:     true,
  },
  "god_of_war_chains_of_olympus": {
    title:        "God of War: Chains of Olympus",
    tierOverride: "high",
    verified:     true,
  },

  // PS1 — games that benefit from PGXP or specific BIOS
  "gran_turismo_2": {
    title:        "Gran Turismo 2",
    tierOverride: "high",
    knownIssues:  ["Mild audio desync in garage menus"],
    verified:     false,
  },

  // NDS — games with known DeSmuME quirks
  "pokemon_black": {
    title:        "Pokémon Black",
    knownIssues:  ["Wi-Fi features unavailable (netplay not supported for Gen 5)"],
    verified:     true,
  },
  "pokemon_white": {
    title:        "Pokémon White",
    knownIssues:  ["Wi-Fi features unavailable (netplay not supported for Gen 5)"],
    verified:     true,
  },
};

// ── Persistence helpers ───────────────────────────────────────────────────────

const CUSTOM_DB_KEY = "rv:compatDb:custom";

function loadCustomDb(): CompatibilityDb {
  try {
    const raw = localStorage.getItem(CUSTOM_DB_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as CompatibilityDb;
    }
    return {};
  } catch {
    return {};
  }
}

function saveCustomDb(db: CompatibilityDb): void {
  try {
    localStorage.setItem(CUSTOM_DB_KEY, JSON.stringify(db));
  } catch { /* ignore write failures */ }
}

// ── GameCompatibilityDb ───────────────────────────────────────────────────────

/**
 * In-memory compatibility database backed by built-in entries, user-imported
 * JSON, and an optional remotely fetched database.
 *
 * ### Usage
 * ```typescript
 * const compat = new GameCompatibilityDb();
 *
 * // At launch: check before starting the emulator
 * const entry = compat.lookup("god_of_war_chains_of_olympus");
 * if (entry?.tierOverride) {
 *   opts.tierOverride = entry.tierOverride;
 * }
 * if (entry?.knownIssues?.length) {
 *   showInfoToast(`Known issue: ${entry.knownIssues[0]}`);
 * }
 * ```
 */
export class GameCompatibilityDb {
  private _db: CompatibilityDb;

  constructor() {
    const custom = loadCustomDb();
    this._db = { ...BUILTIN_COMPAT_DB, ...custom };
  }

  /**
   * Look up a game by ID.
   *
   * The lookup is case-insensitive and normalises the ID by converting to
   * lowercase and replacing runs of non-alphanumeric characters with `_`.
   *
   * @param gameId  Game identifier (filename without extension, or arbitrary).
   * @returns The entry, or `null` if not found.
   */
  lookup(gameId: string): CompatibilityEntry | null {
    const key = this._normalise(gameId);
    return this._db[key] ?? null;
  }

  /**
   * Add or replace a single entry (persisted to localStorage).
   *
   * @param gameId  Normalised game ID.
   * @param entry   Compatibility entry to store.
   */
  upsert(gameId: string, entry: CompatibilityEntry): void {
    const key = this._normalise(gameId);
    this._db[key] = entry;
    this._persistCustom();
  }

  /**
   * Remove a custom entry (built-in entries are not affected).
   *
   * @param gameId  Game ID to remove from the custom overlay.
   */
  remove(gameId: string): void {
    const key = this._normalise(gameId);
    delete this._db[key];
    this._persistCustom();
  }

  /**
   * Merge an externally loaded database (e.g. fetched from a community URL)
   * into the in-memory database without persisting to localStorage.
   *
   * Remote entries have the highest priority — they overwrite built-in and
   * custom entries for the same game ID.
   *
   * @param remote  Parsed JSON object that conforms to `CompatibilityDb`.
   */
  mergeRemote(remote: CompatibilityDb): void {
    if (typeof remote !== "object" || remote === null || Array.isArray(remote)) return;
    for (const [key, entry] of Object.entries(remote)) {
      const k = this._normalise(key);
      if (k && typeof entry === "object" && entry !== null) {
        this._db[k] = entry as CompatibilityEntry;
      }
    }
  }

  /**
   * Fetch and merge a remote compatibility database.
   *
   * The fetch is best-effort: network errors and non-JSON responses are
   * silently ignored.
   *
   * @param url  URL of a JSON file conforming to `CompatibilityDb`.
   */
  async fetchAndMerge(url: string): Promise<void> {
    try {
      const res = await fetch(url, { mode: "cors", credentials: "omit" });
      if (!res.ok) return;
      const data = await res.json() as unknown;
      if (typeof data === "object" && data !== null && !Array.isArray(data)) {
        this.mergeRemote(data as CompatibilityDb);
      }
    } catch { /* network error — ignore */ }
  }

  /**
   * Import a user-supplied JSON string, replacing the current custom overlay.
   *
   * @param json  JSON string of the form `{ gameId: CompatibilityEntry, … }`.
   * @returns `true` on success, `false` if the JSON is invalid.
   */
  importJson(json: string): boolean {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
      // Re-build the DB from built-in + new custom data
      const custom: CompatibilityDb = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          custom[this._normalise(key)] = value as CompatibilityEntry;
        }
      }
      saveCustomDb(custom);
      this._db = { ...BUILTIN_COMPAT_DB, ...custom };
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Export the current in-memory database as a JSON string.
   *
   * @returns Formatted JSON string of all entries (built-in + custom + remote).
   */
  exportJson(): string {
    return JSON.stringify(this._db, null, 2);
  }

  /** Total number of entries in the current database. */
  get size(): number {
    return Object.keys(this._db).length;
  }

  /** Return all game IDs in the database (normalised). */
  keys(): string[] {
    return Object.keys(this._db);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _normalise(id: string): string {
    return id.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }

  private _persistCustom(): void {
    const custom: CompatibilityDb = {};
    for (const [key, entry] of Object.entries(this._db)) {
      if (!BUILTIN_COMPAT_DB[key]) {
        custom[key] = entry;
      }
    }
    saveCustomDb(custom);
  }
}

/** Shared singleton database — reuse across the app. */
export const gameCompatibilityDb = new GameCompatibilityDb();
