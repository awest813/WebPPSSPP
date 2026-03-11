/**
 * saves.ts — Save state library backed by IndexedDB
 *
 * Schema
 * ------
 * Database : "retrovault-saves"
 * Version  : 3
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
 *   version     number   — save format version (optional, added in v3)
 *   checksum    string   — djb2 hex checksum of raw stateData bytes (optional, added in v3)
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
  /** Save format version. Defaults to 1 for legacy entries. */
  version?: number;
  /** djb2 hex checksum of the raw stateData bytes (empty string when stateData is null). */
  checksum?: string;
}

export type SaveStateMetadata = Omit<SaveStateEntry, "thumbnail" | "stateData">;

export const MAX_SAVE_SLOTS = 8;
export const AUTO_SAVE_SLOT = 0;
export const SAVE_FORMAT_VERSION = 1;

// ── Constants ─────────────────────────────────────────────────────────────────

const DB_NAME    = "retrovault-saves";
const DB_VERSION = 3;
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

      // v3: version and checksum fields are optional — no new indexes needed.
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
 *
 * The type assertion is required because TypeScript parameterises Uint8Array
 * as <ArrayBufferLike>, which includes SharedArrayBuffer, while the Blob
 * constructor only accepts ArrayBufferView<ArrayBuffer>.  Emulator FS data
 * is always backed by a plain ArrayBuffer, so the assertion is safe.
 */
export function stateBytesToBlob(stateBytes: Uint8Array | null | undefined): Blob | null {
  if (!stateBytes || stateBytes.byteLength === 0) return null;
  return new Blob([stateBytes as unknown as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" });
}

// ── Checksum ──────────────────────────────────────────────────────────────────

/**
 * Compute a djb2 checksum over a Uint8Array, returned as an 8-character
 * lowercase hex string.  Fast, dependency-free integrity check for save data.
 */
export function computeChecksum(data: Uint8Array): string {
  let hash = 5381;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) + hash + data[i]!) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Verify that a save entry's stateData matches its stored checksum.
 * Returns true if the entry has no checksum (legacy), or if there is no
 * stateData (nothing to verify).  Only returns false on a detected mismatch.
 */
export async function verifySaveChecksum(entry: SaveStateEntry): Promise<boolean> {
  if (!entry.checksum || !entry.stateData) return true;
  const bytes = new Uint8Array(await entry.stateData.arrayBuffer());
  return computeChecksum(bytes) === entry.checksum;
}

// ── Compression ───────────────────────────────────────────────────────────────

/**
 * Compress a Uint8Array with the gzip algorithm via CompressionStream.
 * Falls back to returning the original data unchanged when CompressionStream
 * is not available in the current environment (e.g., older browsers, jsdom).
 */
export async function compressStateData(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") return data;
  try {
    const cs     = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    await writer.write(data as unknown as Uint8Array<ArrayBuffer>);
    await writer.close();
    return _collectStream(cs.readable);
  } catch {
    return data;
  }
}

/**
 * Decompress a gzip-compressed Uint8Array via DecompressionStream.
 * Falls back to returning the original data unchanged when DecompressionStream
 * is not available or decompression fails.
 */
export async function decompressStateData(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") return data;
  try {
    const ds     = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    await writer.write(data as unknown as Uint8Array<ArrayBuffer>);
    await writer.close();
    return _collectStream(ds.readable);
  } catch {
    return data;
  }
}

async function _collectStream(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = readable.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// ── Save Event Bus ────────────────────────────────────────────────────────────

export type SaveEventType = "saved" | "deleted" | "migrated" | "cleared";

export interface SaveEvent {
  type: SaveEventType;
  gameId?: string;
  slot?: number;
  timestamp: number;
}

type SaveEventListener = (event: SaveEvent) => void;

/**
 * Simple synchronous event bus for save-system lifecycle events.
 * Subscribe with `saveEvents.on(type, handler)` or `saveEvents.on('*', handler)`
 * for all event types.  Returns an unsubscribe function.
 */
export class SaveEventBus {
  private readonly _listeners = new Map<SaveEventType | "*", Set<SaveEventListener>>();

  on(type: SaveEventType | "*", listener: SaveEventListener): () => void {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, new Set());
    }
    this._listeners.get(type)!.add(listener);
    return () => this.off(type, listener);
  }

  off(type: SaveEventType | "*", listener: SaveEventListener): void {
    this._listeners.get(type)?.delete(listener);
  }

  emit(event: SaveEvent): void {
    this._listeners.get(event.type)?.forEach((l) => l(event));
    this._listeners.get("*")?.forEach((l) => l(event));
  }

  /** Remove all listeners (useful in tests). */
  clear(): void {
    this._listeners.clear();
  }
}

/** Module-level singleton — subscribe to save lifecycle events here. */
export const saveEvents = new SaveEventBus();

// ── SaveStateLibrary ──────────────────────────────────────────────────────────

export class SaveStateLibrary {
  /**
   * Store a save state entry.
   * If an entry for the same game+slot already exists, it is replaced.
   * Entries without a label get the default slot label.
   * Automatically populates `version` and computes `checksum` from stateData.
   */
  async saveState(entry: SaveStateEntry): Promise<void> {
    const db = await openDB();

    let checksum = entry.checksum;
    if (!checksum && entry.stateData) {
      const bytes = new Uint8Array(await entry.stateData.arrayBuffer());
      checksum = computeChecksum(bytes);
    }

    const normalized: SaveStateEntry = {
      ...entry,
      label:    entry.label || defaultSlotLabel(entry.slot),
      version:  entry.version ?? SAVE_FORMAT_VERSION,
      checksum: checksum ?? "",
    };
    await promisify(tx(db, "readwrite").put(normalized));
    saveEvents.emit({ type: "saved", gameId: entry.gameId, slot: entry.slot, timestamp: Date.now() });
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
    saveEvents.emit({ type: "deleted", gameId, slot, timestamp: Date.now() });
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
    saveEvents.emit({ type: "deleted", gameId, timestamp: Date.now() });
  }

  /**
   * Update the user-defined label for a save slot.
   */
  async updateStateLabel(gameId: string, slot: number, label: string): Promise<void> {
    const state = await this.getState(gameId, slot);
    if (!state) return;
    const db = await openDB();
    await promisify(tx(db, "readwrite").put({ ...state, label: label.trim() || defaultSlotLabel(slot) }));
    saveEvents.emit({ type: "saved", gameId, slot, timestamp: Date.now() });
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

    saveEvents.emit({ type: "migrated", gameId: newGameId, timestamp: Date.now() });
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
   * Computes checksum from the blob before delegating to saveState() so that
   * version/checksum population is handled in one place.
   */
  async importState(
    gameId: string,
    gameName: string,
    systemId: string,
    slot: number,
    stateBlob: Blob,
    label?: string
  ): Promise<void> {
    const bytes    = new Uint8Array(await stateBlob.arrayBuffer());
    const checksum = computeChecksum(bytes);
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
      version:    SAVE_FORMAT_VERSION,
      checksum,
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
    saveEvents.emit({ type: "cleared", timestamp: Date.now() });
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
    if (!ctx) {
      bitmap.close();
      return null;
    }

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
  try { a.click(); } finally {
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 100);
  }
}
