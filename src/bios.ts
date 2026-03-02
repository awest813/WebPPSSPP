/**
 * bios.ts — System BIOS file management
 *
 * BIOS files are stored in a dedicated IndexedDB database separate from the
 * game library so BIOS updates never require a game-library schema migration.
 *
 * Systems that require BIOS files:
 *   PlayStation 1  — SCPH-1001.bin / SCPH-5501.bin (optional but improves compatibility)
 *   Sega Saturn    — sega_101.bin or mpr-17933.bin  (required)
 *   Dreamcast      — dc_boot.bin + dc_flash.bin     (required)
 *   Atari Lynx     — lynxboot.img                   (optional)
 *
 * Schema
 * ------
 * Database : "retrovault-bios"
 * Version  : 1
 * Store    : "bios"  (keyPath = "id")
 *   id          string   — UUID v4
 *   systemId    string   — EmulatorJS core id, e.g. "psx" / "segaSaturn"
 *   fileName    string   — Normalised (lowercase) filename
 *   displayName string   — Original filename as provided by the user
 *   size        number   — Byte count
 *   addedAt     number   — Unix timestamp (ms)
 *   blob        Blob     — The actual BIOS file
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BiosEntry {
  id: string;
  systemId: string;
  fileName: string;
  displayName: string;
  size: number;
  addedAt: number;
  blob: Blob;
}

export type BiosMetadata = Omit<BiosEntry, "blob">;

export interface BiosRequirement {
  /** Canonical lowercase filename the core expects. */
  fileName: string;
  /** Human-readable label for the settings UI. */
  displayName: string;
  /** If true, the system will not boot without this file. */
  required: boolean;
  /** Short description shown beneath the upload control. */
  description: string;
}

// ── Known BIOS requirements per system ────────────────────────────────────────

export const BIOS_REQUIREMENTS: Record<string, BiosRequirement[]> = {
  psx: [
    {
      fileName: "scph5501.bin",
      displayName: "PS1 BIOS NTSC-U v3.0 (SCPH-5501)",
      required: false,
      description: "Recommended US BIOS — improves compatibility with NTSC-U titles",
    },
    {
      fileName: "scph1001.bin",
      displayName: "PS1 BIOS NTSC-U v2.0 (SCPH-1001)",
      required: false,
      description: "Original US launch BIOS — broadest compatibility",
    },
    {
      fileName: "scph5502.bin",
      displayName: "PS1 BIOS PAL v3.0 (SCPH-5502)",
      required: false,
      description: "European BIOS — required for PAL-locked titles",
    },
  ],
  segaSaturn: [
    {
      fileName: "sega_101.bin",
      displayName: "Saturn BIOS JP (sega_101.bin)",
      required: true,
      description: "Sega Saturn Japanese BIOS — required for Saturn emulation",
    },
    {
      fileName: "mpr-17933.bin",
      displayName: "Saturn BIOS US/EU (mpr-17933.bin)",
      required: true,
      description: "Sega Saturn North-American / European BIOS",
    },
  ],
  segaDC: [
    {
      fileName: "dc_boot.bin",
      displayName: "Dreamcast BIOS (dc_boot.bin)",
      required: true,
      description: "Main Dreamcast BIOS ROM — emulation will not start without this",
    },
    {
      fileName: "dc_flash.bin",
      displayName: "Dreamcast Flash ROM (dc_flash.bin)",
      required: true,
      description: "Dreamcast flash memory containing regional settings",
    },
  ],
  lynx: [
    {
      fileName: "lynxboot.img",
      displayName: "Lynx Boot ROM (lynxboot.img)",
      required: false,
      description: "Atari Lynx bootstrap ROM — optional; most games work without it",
    },
  ],
};

// ── Constants ─────────────────────────────────────────────────────────────────

const DB_NAME    = "retrovault-bios";
const DB_VERSION = 1;
const STORE_NAME = "bios";

// ── Database helpers ──────────────────────────────────────────────────────────

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
      store.createIndex("systemId", "systemId", { unique: false });
      store.createIndex("fileName", "fileName", { unique: false });
    };

    req.onsuccess = () => {
      _db = req.result;
      _db.onclose = () => { _db = null; _dbPromise = null; };
      resolve(_db);
    };

    req.onerror = () => {
      _dbPromise = null;
      reject(new Error(`Failed to open BIOS database: ${req.error?.message}`));
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

function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── BiosLibrary class ─────────────────────────────────────────────────────────

export class BiosLibrary {
  /**
   * Store a BIOS file. If a BIOS with the same filename + system already
   * exists it is replaced so re-uploading is safe.
   */
  async addBios(file: File, systemId: string): Promise<BiosEntry> {
    const db           = await openDB();
    const normalised   = file.name.toLowerCase();
    const existing     = await this.findBios(systemId, normalised);
    if (existing) await this.removeBios(existing.id);

    const entry: BiosEntry = {
      id:          uuid(),
      systemId,
      fileName:    normalised,
      displayName: file.name,
      size:        file.size,
      addedAt:     Date.now(),
      blob:        file,
    };
    await promisify(tx(db, "readwrite").put(entry));
    return entry;
  }

  /**
   * Find a stored BIOS by system + filename (case-insensitive).
   */
  async findBios(systemId: string, fileName: string): Promise<BiosEntry | null> {
    const db    = await openDB();
    const store = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME);
    const idx   = store.index("systemId");
    const all   = await promisify<BiosEntry[]>(idx.getAll(systemId));
    const lower = fileName.toLowerCase();
    return all.find(b => b.fileName === lower) ?? null;
  }

  /**
   * Return the first stored BIOS for a system (tries required files first).
   * Returns null when no BIOS has been uploaded.
   */
  async getPrimaryBios(systemId: string): Promise<BiosEntry | null> {
    const reqs = BIOS_REQUIREMENTS[systemId];
    if (!reqs) return null;
    for (const r of reqs) {
      const entry = await this.findBios(systemId, r.fileName);
      if (entry) return entry;
    }
    return null;
  }

  /**
   * Create a temporary blob URL for the primary BIOS of a system.
   * Returns null if no BIOS is stored.
   * The caller MUST call URL.revokeObjectURL(url) when it is no longer needed.
   */
  async getPrimaryBiosUrl(systemId: string): Promise<string | null> {
    const entry = await this.getPrimaryBios(systemId);
    if (!entry) return null;
    return URL.createObjectURL(entry.blob);
  }

  /**
   * Returns a map of fileName → isPresent for every known BIOS requirement
   * for the given system.
   */
  async getBiosStatus(systemId: string): Promise<Map<string, boolean>> {
    const reqs   = BIOS_REQUIREMENTS[systemId] ?? [];
    const status = new Map<string, boolean>();
    for (const r of reqs) {
      const found = await this.findBios(systemId, r.fileName);
      status.set(r.fileName, found !== null);
    }
    return status;
  }

  /**
   * True when all *required* BIOS files for a system are present.
   * Systems with no requirements return true.
   */
  async isBiosReady(systemId: string): Promise<boolean> {
    const reqs = BIOS_REQUIREMENTS[systemId];
    if (!reqs) return true;
    for (const r of reqs) {
      if (!r.required) continue;
      const found = await this.findBios(systemId, r.fileName);
      if (!found) return false;
    }
    return true;
  }

  /**
   * List all stored BIOS entries (metadata only, no blob).
   */
  async listAll(): Promise<BiosMetadata[]> {
    const db  = await openDB();
    const all = await promisify<BiosEntry[]>(tx(db, "readonly").getAll());
    return all.map(({ blob: _blob, ...meta }) => meta);
  }

  /**
   * Delete a BIOS entry by id.
   */
  async removeBios(id: string): Promise<void> {
    const db = await openDB();
    await promisify(tx(db, "readwrite").delete(id));
  }

  /**
   * Pre-warm the IndexedDB connection at startup.
   */
  async warmUp(): Promise<void> {
    await openDB();
  }
}
