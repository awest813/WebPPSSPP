/**
 * wasmCache.ts — IndexedDB-backed WebAssembly.Module cache
 *
 * Caches compiled WebAssembly modules in IndexedDB so subsequent page loads
 * skip the (often multi-second) streaming compilation step. Falls back
 * gracefully when the API is unavailable (private browsing, Firefox < 115
 * when IDB module storage is disabled, or when the WASM file changes).
 *
 * ### Cache invalidation
 * Each entry is keyed by the full URL of the .wasm file. The cache stores the
 * `ETag` or `Last-Modified` response header (when present) alongside the
 * compiled module. On the next load, a conditional HEAD request is made; if
 * the ETag matches, the cached module is returned instead of re-downloading.
 *
 * ### Storage
 * Database : "retrovault-wasm"
 * Version  : 1
 * Store    : "modules"  (keyPath = "url")
 *   url         string              — absolute URL of the .wasm file
 *   module      WebAssembly.Module  — the compiled module object
 *   etag        string | null       — ETag from the last successful fetch
 *   lastModified string | null      — Last-Modified from the last fetch
 *   cachedAt    number              — Unix ms timestamp
 */

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

const WASM_DB_NAME    = "retrovault-wasm";
const WASM_DB_VERSION = 1;
const WASM_STORE_NAME = "modules";

interface WasmCacheEntry {
  url:          string;
  module:       WebAssembly.Module;
  etag:         string | null;
  lastModified: string | null;
  cachedAt:     number;
}

function openWasmDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(WASM_DB_NAME, WASM_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(WASM_STORE_NAME)) {
        db.createObjectStore(WASM_STORE_NAME, { keyPath: "url" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ── WasmModuleCache ───────────────────────────────────────────────────────────

/**
 * IndexedDB-backed cache for compiled `WebAssembly.Module` objects.
 *
 * `WebAssembly.Module` objects are serialisable (structured clone) and
 * survive IndexedDB round-trips in Chromium and Firefox. Storing them avoids
 * re-compilation on every page reload, which can save several seconds on
 * large cores (PPSSPP: ~25 MB WASM).
 *
 * ### Usage
 * ```typescript
 * const cache = new WasmModuleCache();
 *
 * // During emulator initialisation
 * const module = await cache.getOrFetch("https://cdn.emulatorjs.org/stable/data/cores/ppsspp_libretro.wasm");
 * // module is a compiled WebAssembly.Module ready for instantiation
 * ```
 */
export class WasmModuleCache {
  private _db: IDBDatabase | null = null;
  private _dbPromise: Promise<IDBDatabase> | null = null;

  /** Whether WebAssembly.Module is serialisable in this browser. */
  static isSupported(): boolean {
    return (
      typeof indexedDB !== "undefined" &&
      typeof WebAssembly !== "undefined" &&
      typeof WebAssembly.compile === "function"
    );
  }

  /**
   * Return a compiled `WebAssembly.Module` for the given WASM URL.
   *
   * 1. Check IndexedDB for a cached entry.
   * 2. If found, send a conditional HEAD request to validate freshness
   *    (ETag / Last-Modified).
   * 3. If still fresh, return the cached module.
   * 4. Otherwise fetch the WASM, compile it, and store the new entry.
   *
   * All errors are caught — on any failure the method falls back to a
   * plain streaming compile so the emulator always loads.
   *
   * @param url  Absolute URL of the .wasm file.
   * @returns Compiled `WebAssembly.Module`.
   */
  async getOrFetch(url: string): Promise<WebAssembly.Module> {
    if (!WasmModuleCache.isSupported()) {
      return this._fetchAndCompile(url);
    }

    try {
      const db    = await this._openDb();
      const entry = await this._read(db, url);

      if (entry) {
        const fresh = await this._isStillFresh(url, entry);
        if (fresh) return entry.module;
      }

      // Cache miss or stale — fetch, compile, and store
      const { module, etag, lastModified } = await this._fetchCompileAndStore(url, db);
      return module;
    } catch {
      // IDB unavailable, module not serialisable, or network error — fall back
      return this._fetchAndCompile(url);
    }
  }

  /**
   * Explicitly store a pre-compiled module in the cache.
   *
   * Useful when the caller has already compiled the module via
   * `WebAssembly.compileStreaming()` and wants to persist it.
   */
  async store(url: string, module: WebAssembly.Module, etag: string | null = null, lastModified: string | null = null): Promise<void> {
    if (!WasmModuleCache.isSupported()) return;
    try {
      const db = await this._openDb();
      const entry: WasmCacheEntry = {
        url,
        module,
        etag,
        lastModified,
        cachedAt: Date.now(),
      };
      await this._write(db, entry);
    } catch { /* ignore write failures */ }
  }

  /**
   * Remove a single entry from the cache.
   *
   * @param url  The WASM URL to evict.
   */
  async evict(url: string): Promise<void> {
    try {
      const db = await this._openDb();
      await new Promise<void>((resolve, reject) => {
        const txn = db.transaction(WASM_STORE_NAME, "readwrite");
        const req = txn.objectStore(WASM_STORE_NAME).delete(url);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
      });
    } catch { /* ignore */ }
  }

  /** Clear all cached entries. */
  async clear(): Promise<void> {
    try {
      const db = await this._openDb();
      await new Promise<void>((resolve, reject) => {
        const txn = db.transaction(WASM_STORE_NAME, "readwrite");
        const req = txn.objectStore(WASM_STORE_NAME).clear();
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
      });
    } catch { /* ignore */ }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _openDb(): Promise<IDBDatabase> {
    if (this._db) return Promise.resolve(this._db);
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = openWasmDb().then(db => {
      this._db = db;
      return db;
    });
    return this._dbPromise;
  }

  private _read(db: IDBDatabase, url: string): Promise<WasmCacheEntry | null> {
    return new Promise((resolve, reject) => {
      const txn = db.transaction(WASM_STORE_NAME, "readonly");
      const req = txn.objectStore(WASM_STORE_NAME).get(url);
      req.onsuccess = () => resolve((req.result as WasmCacheEntry) ?? null);
      req.onerror   = () => reject(req.error);
    });
  }

  private _write(db: IDBDatabase, entry: WasmCacheEntry): Promise<void> {
    return new Promise((resolve, reject) => {
      const txn = db.transaction(WASM_STORE_NAME, "readwrite");
      const req = txn.objectStore(WASM_STORE_NAME).put(entry);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  private async _isStillFresh(url: string, entry: WasmCacheEntry): Promise<boolean> {
    // If we have no ETag or Last-Modified we cannot validate — treat as fresh
    // for 1 hour to avoid unnecessary HEAD requests on every load.
    if (!entry.etag && !entry.lastModified) {
      return Date.now() - entry.cachedAt < 60 * 60 * 1000;
    }

    try {
      const headers: Record<string, string> = {};
      if (entry.etag)         headers["If-None-Match"]     = entry.etag;
      if (entry.lastModified) headers["If-Modified-Since"] = entry.lastModified;

      const res = await fetch(url, { method: "HEAD", headers, mode: "cors", credentials: "omit" });
      return res.status === 304 || res.status === 200;
    } catch {
      // Network error — use cached module
      return true;
    }
  }

  private async _fetchCompileAndStore(
    url: string,
    db: IDBDatabase
  ): Promise<{ module: WebAssembly.Module; etag: string | null; lastModified: string | null }> {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) throw new Error(`WASM fetch failed: ${res.status}`);

    const etag         = res.headers.get("ETag");
    const lastModified = res.headers.get("Last-Modified");

    const module = await WebAssembly.compile(await res.arrayBuffer());
    const entry: WasmCacheEntry = {
      url,
      module,
      etag,
      lastModified,
      cachedAt: Date.now(),
    };
    // Best-effort store — don't block returning the module
    this._write(db, entry).catch(() => {});
    return { module, etag, lastModified };
  }

  private async _fetchAndCompile(url: string): Promise<WebAssembly.Module> {
    if (typeof WebAssembly.compileStreaming === "function") {
      try {
        const streamRes = await fetch(url, { mode: "cors", credentials: "omit" });
        return await WebAssembly.compileStreaming(streamRes);
      } catch { /* streaming compile failed or not supported — fall through to arrayBuffer path */ }
    }
    // Fresh fetch for the fallback path (streaming may have consumed the previous response body)
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    return WebAssembly.compile(await res.arrayBuffer());
  }
}

/** Shared singleton cache — reuse across emulator instances. */
export const wasmModuleCache = new WasmModuleCache();
