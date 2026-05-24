/**
 * bios.ts — System BIOS file management
 *
 * BIOS files are stored in a dedicated IndexedDB database separate from the
 * game library so BIOS updates never require a game-library schema migration.
 *
 * Systems that require BIOS files:
 *   PlayStation 1  — SCPH-5500 (NTSC-J) / SCPH-1001 / SCPH-5501 / SCPH-5502 (optional but improves compatibility)
 *   Sega Saturn    — sega_101.bin or mpr-17933.bin  (required)
 *   Dreamcast      — (dc_boot.bin or dreamdash.bin) + dc_flash.bin (required)
 *   Atari Lynx     — lynxboot.img                   (optional)
 *
 * Schema
 * ------
 * Database : "retro-oasis-bios"
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

import { createUuid } from "./uuid.js";
import { createStoredZip } from "./zip.js";

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
export type LaunchBiosAsset = Blob;

export interface BiosRequirement {
  /** Canonical lowercase filename the core expects. */
  fileName: string;
  /** Human-readable label for the settings UI. */
  displayName: string;
  /** If true, the system will not boot without this file. */
  required: boolean;
  /** Short description shown beneath the upload control. */
  description: string;
  /**
   * Optional group identifier for mutually-exclusive BIOS alternatives.
   * When set, `isBiosReady` requires that at least ONE entry sharing the
   * same group is present rather than requiring all of them.
   *
   * Example: Sega Saturn accepts either the JP BIOS (sega_101.bin) or the
   * US/EU BIOS (mpr-17933.bin). Both entries carry the same group so the
   * check passes as soon as one of them is found.
   *
   * Entries without a group are treated as standalone requirements —
   * each must individually be present (e.g. Dreamcast bootloader and
   * dc_flash.bin are two distinct files that are both needed).
   */
  group?: string;
  /**
   * Optional direct-download URL for a freely redistributable BIOS binary.
   * When present, the settings UI shows a "Download Free" button that
   * fetches the file and stores it in the BIOS library automatically.
   * Only set this for files that are legally redistributable (e.g. open-source BIOS).
   */
  downloadUrl?: string;
}

// ── Known BIOS requirements per system ────────────────────────────────────────

export const BIOS_REQUIREMENTS: Record<string, BiosRequirement[]> = {
  psx: [
    {
      fileName: "openbios.bin",
      displayName: "OpenBIOS (Free & Open Source — bundled)",
      required: false,
      description: "Free open-source PS1 BIOS from the PCSX-Redux project, bundled directly with RetroOasis. No external download needed. Compatible with most PS1 titles via the pcsx_rearmed core.",
      downloadUrl: "/bios/openbios.bin",
    },
    {
      fileName: "scph5500.bin",
      displayName: "PS1 BIOS NTSC-J v3.0 (SCPH-5500)",
      required: false,
      description: "Japanese BIOS — required for NTSC-J titles and Japanese region-locked games",
    },
    {
      fileName: "scph5501.bin",
      displayName: "PS1 BIOS NTSC-U v3.0 (SCPH-5501)",
      required: false,
      description: "Recommended US BIOS — improves compatibility with NTSC-U titles. Enables Beetle PSX HW (highest accuracy).",
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
      group: "saturn-bios",
      description: "Sega Saturn Japanese BIOS — required for Saturn emulation",
    },
    {
      fileName: "mpr-17933.bin",
      displayName: "Saturn BIOS US/EU (mpr-17933.bin)",
      required: true,
      group: "saturn-bios",
      description: "Sega Saturn North-American / European BIOS",
    },
  ],
  segaCD: [
    {
      fileName: "bios_cd_u.bin",
      displayName: "Sega CD BIOS USA (bios_CD_U.bin)",
      required: true,
      group: "sega-cd-bios",
      description: "Sega CD / Mega-CD US BIOS. One regional Sega CD BIOS is required for disc-based games.",
    },
    {
      fileName: "bios_cd_e.bin",
      displayName: "Mega-CD BIOS Europe (bios_CD_E.bin)",
      required: true,
      group: "sega-cd-bios",
      description: "Mega-CD European BIOS. One regional Sega CD BIOS is required for disc-based games.",
    },
    {
      fileName: "bios_cd_j.bin",
      displayName: "Mega-CD BIOS Japan (bios_CD_J.bin)",
      required: true,
      group: "sega-cd-bios",
      description: "Mega-CD Japanese BIOS. One regional Sega CD BIOS is required for disc-based games.",
    },
  ],
  segaDC: [
    {
      fileName: "dc_boot.bin",
      displayName: "Dreamcast BIOS (dc_boot.bin)",
      required: true,
      group: "dc-boot",
      description: "Official/retail SEGA Dreamcast BIOS boot ROM — required for standard boot",
    },
    {
      fileName: "dreamdash.bin",
      displayName: "DreamDash Custom BIOS (dreamdash.bin)",
      required: true,
      group: "dc-boot",
      description: "A modern, open-source replacement boot ROM for the Sega Dreamcast (https://github.com/darcagn/DreamDash)",
      downloadUrl: "./assets/dreamdash.bin",
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
  nds: [
    {
      fileName: "bios7.bin",
      displayName: "NDS ARM7 BIOS (bios7.bin)",
      required: false,
      description: "Nintendo DS ARM7 processor BIOS — optional; DeSmuME uses a built-in HLE replacement when absent, but some games require the real BIOS",
    },
    {
      fileName: "bios9.bin",
      displayName: "NDS ARM9 BIOS (bios9.bin)",
      required: false,
      description: "Nintendo DS ARM9 processor BIOS — optional; paired with bios7.bin for accurate hardware BIOS emulation",
    },
    {
      fileName: "firmware.bin",
      displayName: "NDS Firmware (firmware.bin)",
      required: false,
      description: "Nintendo DS firmware ROM — optional; provides proper regional settings and splash screen; some homebrew titles require it",
    },
  ],
};

// ── Constants ─────────────────────────────────────────────────────────────────

const DB_NAME    = "retro-oasis-bios";
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
      _db.onversionchange = () => { _db?.close(); _db = null; _dbPromise = null; };
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

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await new Response(blob).arrayBuffer());
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

    const entry: BiosEntry = {
      id:          createUuid(),
      systemId,
      fileName:    normalised,
      displayName: file.name,
      size:        file.size,
      addedAt:     Date.now(),
      blob:        file,
    };

    const store = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME);
    if (existing) store.delete(existing.id);
    await promisify(store.put(entry));
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
    return all.find(b => b.fileName.toLowerCase() === lower) ?? null;
  }

  /**
   * Return the first stored BIOS for a system (tries required files first).
   * Returns null when no BIOS has been uploaded.
   */
  async getPrimaryBios(systemId: string): Promise<BiosEntry | null> {
    const reqs = BIOS_REQUIREMENTS[systemId];
    if (!reqs) return null;
    const results = await Promise.all(
      reqs.map(r => this.findBios(systemId, r.fileName))
    );
    return results.find(entry => entry !== null) ?? null;
  }

  async getPrimaryBiosBlob(systemId: string): Promise<Blob | null> {
    const entry = await this.getPrimaryBios(systemId);
    if (!entry) return null;
    return entry.blob;
  }

  /**
   * Return the best BIOS launch asset for a system.
   *
   * Most systems use a single blob URL. Dreamcast needs both dc_boot.bin and
   * dc_flash.bin, so we bundle them into an in-memory ZIP containing the
   * expected /dc/ directory structure for Flycast/Reicast.
   */
  async getLaunchBiosAsset(systemId: string): Promise<LaunchBiosAsset | null> {
    if (systemId !== "segaDC") {
      return this.getPrimaryBiosBlob(systemId);
    }

    const boot = (await this.findBios(systemId, "dreamdash.bin")) || (await this.findBios(systemId, "dc_boot.bin"));
    const flash = await this.findBios(systemId, "dc_flash.bin");
    if (!boot || !flash) return null;

    const [bootBytes, flashBytes] = await Promise.all([
      blobToBytes(boot.blob),
      blobToBytes(flash.blob),
    ]);

    const zipBytes = createStoredZip([
      { path: "dc/dc_boot.bin", bytes: bootBytes },
      { path: "dc/dc_flash.bin", bytes: flashBytes },
    ]);

    const zipPayload = zipBytes.slice();

    return new File([zipPayload], "dreamcast-bios.zip", { type: "application/zip" });
  }

  /**
   * Returns a map of fileName → isPresent for every known BIOS requirement
   * for the given system.
   */
  async getBiosStatus(systemId: string): Promise<Map<string, boolean>> {
    const reqs = BIOS_REQUIREMENTS[systemId] ?? [];
    const results = await Promise.all(
      reqs.map(r => this.findBios(systemId, r.fileName))
    );

    const status = new Map<string, boolean>();
    reqs.forEach((r, i) => {
      status.set(r.fileName, results[i] !== null);
    });
    return status;
  }

  /**
   * True when all *required* BIOS files for a system are present.
   * Systems with no requirements return true.
   */
  async isBiosReady(systemId: string): Promise<boolean> {
    const reqs = BIOS_REQUIREMENTS[systemId];
    if (!reqs) return true;

    // Separate required entries from optional ones — optional never block boot.
    const required = reqs.filter(r => r.required);
    if (required.length === 0) return true;

    const results = await Promise.all(
      required.map(r => this.findBios(systemId, r.fileName))
    );

    // Group entries by their `group` key (entries without a group use their
    // fileName as a unique key so each is treated as its own requirement).
    // Every group must have at least one file present.
    const groups = new Map<string, boolean>();
    required.forEach((r, i) => {
      const key = r.group ?? r.fileName;
      if (results[i] !== null) {
        groups.set(key, true);
      } else if (!groups.has(key)) {
        groups.set(key, false);
      }
    });

    for (const ready of groups.values()) {
      if (!ready) return false;
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

  /**
   * Remove all stored BIOS entries.
   * Primarily used in tests to achieve a clean state between test cases.
   */
  async clearAll(): Promise<void> {
    const db = await openDB();
    await promisify(tx(db, "readwrite").clear());
  }
}
