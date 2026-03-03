/**
 * saves.ts — Save state library backed by IndexedDB
 *
 * Schema
 * ------
 * Database : "retrovault-saves"
 * Version  : 2
 * Store    : "states"  (keyPath = "id")
 *   id          string   — composite key "{gameId}:{slot}"
 *   gameId      string   — UUID from the game library
 *   gameName    string   — display name at time of save
 *   systemId    string   — EmulatorJS core id
 *   slot        number   — 0 = auto-save, 1–8 = manual slots
 *   label       string   — user-defined slot name (optional)
 *   timestamp   number   — Unix timestamp (ms) of the save
 *   thumbnail   Blob     — JPEG screenshot captured at save time (nullable)
 *   stateData   Blob     — raw emulator state bytes (nullable if EJS FS unavailable)
 *   isAutoSave  boolean  — true for slot 0 crash-recovery saves
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SaveStateEntry {
  id: string;
  gameId: string;
  gameName: string;
  systemId: string;
  slot: number;
  label: string;
  timestamp: number;
  thumbnail: Blob | null;
  stateData: Blob | null;
  isAutoSave: boolean;
}

export type SaveStateMetadata = Omit<SaveStateEntry, "thumbnail" | "stateData">;

export const MAX_SAVE_SLOTS = 8;
export const AUTO_SAVE_SLOT = 0;

// ── Constants ─────────────────────────────────────────────────────────────────

const DB_NAME    = "retrovault-saves";
const DB_VERSION = 2;
const STORE_NAME = "states";

// ── Database helpers ──────────────────────────────────────────────────────────

let _db: IDBDatabase | null = null;
let _dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("gameId",    "gameId",    { unique: false });
        store.createIndex("timestamp", "timestamp", { unique: false });
      }

      if (oldVersion < 2) {
        const store = req.transaction!.objectStore(STORE_NAME);
        if (!store.indexNames.contains("label")) {
          store.createIndex("label", "label", { unique: false });
        }
      }
    };

    req.onsuccess = () => {
      _db = req.result;
      _db.onclose = () => { _db = null; _dbPromise = null; };
      resolve(_db);
    };

    req.onerror = () => {
      _dbPromise = null;
      reject(new Error(`Failed to open save state database: ${req.error?.message}`));
    };
  });

  return _dbPromise;
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** Composite key for a save state: "{gameId}:{slot}" */
export function saveStateKey(gameId: string, slot: number): string {
  return `${gameId}:${slot}`;
}

/** Default slot label for a given slot number. */
export function defaultSlotLabel(slot: number): string {
  return slot === AUTO_SAVE_SLOT ? "Auto-Save" : `Slot ${slot}`;
}

/**
 * Convert emulator save-state bytes to a Blob for IndexedDB persistence.
 * Passes the Uint8Array view directly to the Blob constructor, which reads
 * the correct byte range (including subarray offsets) without an extra copy.
 */
export function stateBytesToBlob(stateBytes: Uint8Array | null | undefined): Blob | null {
  if (!stateBytes || stateBytes.byteLength === 0) return null;
  return new Blob([stateBytes], { type: "application/octet-stream" });
}

// ── SaveStateLibrary ──────────────────────────────────────────────────────────

export class SaveStateLibrary {
  /**
   * Store a save state entry.
   * If an entry for the same game+slot already exists, it is replaced.
   * Entries without a label get the default slot label.
   */
  async saveState(entry: SaveStateEntry): Promise<void> {
    const db = await openDB();
    const normalized: SaveStateEntry = {
      ...entry,
      label: entry.label || defaultSlotLabel(entry.slot),
    };
    await promisify(tx(db, "readwrite").put(normalized));
  }

  /**
   * Get a save state by game ID and slot.
   */
  async getState(gameId: string, slot: number): Promise<SaveStateEntry | null> {
    const db = await openDB();
    const id = saveStateKey(gameId, slot);
    const result = await promisify<SaveStateEntry | undefined>(tx(db, "readonly").get(id));
    return result ?? null;
  }

  /**
   * Get all save states for a specific game (all slots), sorted by slot.
   */
  async getStatesForGame(gameId: string): Promise<SaveStateEntry[]> {
    const db    = await openDB();
    const store = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME);
    const idx   = store.index("gameId");
    const all   = await promisify<SaveStateEntry[]>(idx.getAll(gameId));
    return all.sort((a, b) => a.slot - b.slot);
  }

  /**
   * Get metadata-only list for a game (no thumbnail or stateData blobs).
   */
  async getMetadataForGame(gameId: string): Promise<SaveStateMetadata[]> {
    const states = await this.getStatesForGame(gameId);
    return states.map(({ thumbnail: _t, stateData: _s, ...meta }) => meta);
  }

  /**
   * Get the most recently created manual save for a game (slot 1–MAX_SAVE_SLOTS).
   * Returns null if no manual saves exist.
   */
  async getLatestManualSave(gameId: string): Promise<SaveStateEntry | null> {
    const states = await this.getStatesForGame(gameId);
    const manual = states.filter(s => s.slot !== AUTO_SAVE_SLOT);
    if (manual.length === 0) return null;
    return manual.reduce((latest, s) => s.timestamp > latest.timestamp ? s : latest);
  }

  /**
   * Delete a save state by game ID and slot.
   */
  async deleteState(gameId: string, slot: number): Promise<void> {
    const db = await openDB();
    const id = saveStateKey(gameId, slot);
    await promisify(tx(db, "readwrite").delete(id));
  }

  /**
   * Delete all save states for a game.
   */
  async deleteAllForGame(gameId: string): Promise<void> {
    const states = await this.getStatesForGame(gameId);
    const db = await openDB();
    const store = tx(db, "readwrite");
    for (const s of states) {
      store.delete(s.id);
    }
    await new Promise<void>((resolve, reject) => {
      store.transaction.oncomplete = () => resolve();
      store.transaction.onerror    = () => reject(store.transaction.error);
    });
  }

  /**
   * Update the user-defined label for a save slot.
   */
  async updateStateLabel(gameId: string, slot: number, label: string): Promise<void> {
    const state = await this.getState(gameId, slot);
    if (!state) return;
    const db = await openDB();
    await promisify(tx(db, "readwrite").put({ ...state, label: label.trim() || defaultSlotLabel(slot) }));
  }

  /**
   * Check if a crash-recovery auto-save exists for a game.
   */
  async hasAutoSave(gameId: string): Promise<boolean> {
    const state = await this.getState(gameId, AUTO_SAVE_SLOT);
    return state !== null;
  }

  /**
   * Migrate all saves from one game ID to another (used when a ROM is renamed).
   * The old entries are deleted and new entries with the updated gameId are created.
   */
  async migrateSaves(oldGameId: string, newGameId: string, newGameName?: string): Promise<number> {
    const states = await this.getStatesForGame(oldGameId);
    if (states.length === 0) return 0;

    const db = await openDB();
    const store = tx(db, "readwrite");

    for (const s of states) {
      store.delete(s.id);
      const migrated: SaveStateEntry = {
        ...s,
        id:       saveStateKey(newGameId, s.slot),
        gameId:   newGameId,
        gameName: newGameName ?? s.gameName,
      };
      store.put(migrated);
    }

    await new Promise<void>((resolve, reject) => {
      store.transaction.oncomplete = () => resolve();
      store.transaction.onerror    = () => reject(store.transaction.error);
    });

    return states.length;
  }

  /**
   * Export a save state as a downloadable `.state` file.
   * Returns null if no state data is stored for the slot.
   */
  async exportState(gameId: string, slot: number): Promise<{ blob: Blob; fileName: string } | null> {
    const state = await this.getState(gameId, slot);
    if (!state?.stateData) return null;

    const slotLabel = slot === AUTO_SAVE_SLOT ? "autosave" : `slot${slot}`;
    const safeName  = state.gameName.replace(/[^a-zA-Z0-9_\-. ]/g, "_");
    const fileName  = `${safeName}_${slotLabel}.state`;

    return { blob: state.stateData, fileName };
  }

  /**
   * Export all save states for a game as an array of {blob, fileName} pairs.
   * Only returns slots that have stateData.
   */
  async exportAllForGame(gameId: string): Promise<Array<{ blob: Blob; fileName: string }>> {
    const states = await this.getStatesForGame(gameId);
    const results: Array<{ blob: Blob; fileName: string }> = [];
    for (const state of states) {
      if (!state.stateData) continue;
      const slotLabel = state.slot === AUTO_SAVE_SLOT ? "autosave" : `slot${state.slot}`;
      const safeName  = state.gameName.replace(/[^a-zA-Z0-9_\-. ]/g, "_");
      results.push({ blob: state.stateData, fileName: `${safeName}_${slotLabel}.state` });
    }
    return results;
  }

  /**
   * Import a `.state` file into a specific slot for a game.
   */
  async importState(
    gameId: string,
    gameName: string,
    systemId: string,
    slot: number,
    stateBlob: Blob,
    label?: string
  ): Promise<void> {
    const entry: SaveStateEntry = {
      id:         saveStateKey(gameId, slot),
      gameId,
      gameName,
      systemId,
      slot,
      label:      label || defaultSlotLabel(slot),
      timestamp:  Date.now(),
      thumbnail:  null,
      stateData:  stateBlob,
      isAutoSave: slot === AUTO_SAVE_SLOT,
    };
    await this.saveState(entry);
  }

  /**
   * Get all unique gameIds that have at least one save state.
   *
   * Uses IDBIndex.openKeyCursor() with "nextunique" direction so each
   * unique gameId (the index key) is visited exactly once. This is
   * more correct than getAllKeys() which returns the object store's
   * primary keys (the composite "gameId:slot" strings), not the
   * gameId values themselves.
   */
  async getAllSavedGameIds(): Promise<string[]> {
    const db = await openDB();
    return new Promise<string[]>((resolve, reject) => {
      const store = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME);
      const idx   = store.index("gameId");
      const ids: string[] = [];
      const req = idx.openKeyCursor(null, "nextunique");
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          ids.push(cursor.key as string);
          cursor.continue();
        } else {
          resolve(ids);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Get total number of save states stored.
   */
  async count(): Promise<number> {
    const db = await openDB();
    return promisify(tx(db, "readonly").count());
  }

  /**
   * Clear all save states.
   */
  async clearAll(): Promise<void> {
    const db = await openDB();
    await promisify(tx(db, "readwrite").clear());
  }

  /**
   * Pre-warm the IndexedDB connection.
   */
  async warmUp(): Promise<void> {
    await openDB();
  }
}

// ── Screenshot capture ────────────────────────────────────────────────────────

/**
 * Capture a JPEG screenshot from the emulator canvas.
 * Returns null if the canvas is not found or capture fails.
 */
export function captureScreenshot(playerId: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      const playerEl = document.getElementById(playerId);
      if (!playerEl) { resolve(null); return; }

      const canvas = playerEl.querySelector("canvas");
      if (!canvas || canvas.width === 0 || canvas.height === 0) {
        resolve(null);
        return;
      }

      canvas.toBlob(
        (blob) => resolve(blob),
        "image/jpeg",
        0.75
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Create a thumbnail (smaller image) from a screenshot blob.
 * Resizes to max 240×160 for display in the grid-based gallery.
 */
export async function createThumbnail(screenshot: Blob): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(screenshot);
    const MAX_W = 240;
    const MAX_H = 160;
    const scale = Math.min(MAX_W / bitmap.width, MAX_H / bitmap.height, 1);
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width  = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();

    return new Promise<Blob | null>((resolve) => {
      canvas.toBlob(
        (blob) => resolve(blob),
        "image/jpeg",
        0.8
      );
    });
  } catch {
    return null;
  }
}

// ── File download helper ──────────────────────────────────────────────────────

/** Trigger a browser download of a Blob. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement("a");
  a.href     = url;
  a.download = fileName;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}
