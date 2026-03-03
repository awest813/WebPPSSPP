/**
 * shaderCache.ts — WebGL and WGSL shader source cache backed by IndexedDB
 *
 * Persists GLSL vertex + fragment shader source strings (and WGSL module
 * sources) across sessions so that the GPU driver's internal shader cache can
 * be pre-warmed on subsequent launches. On first visit the browser must
 * compile every shader from source; on repeat visits the driver typically has
 * a binary in its disk cache — this module ensures those shaders are presented
 * to the compiler early (during idle time) so the first rendered frame has no
 * recompile stutter.
 *
 * Design constraints:
 *   - WebGL has no standard API to save/restore compiled GPU binaries
 *   - We store GLSL source text (small, typically <4 KB per program)
 *   - WGSL sources are stored under a separate object store and pre-compiled
 *     via GPUDevice.createShaderModule() — also best-effort and async
 *   - Pre-compilation runs on a throw-away off-screen canvas / device so it
 *     never interferes with the game's WebGL/WebGPU context
 *   - The GLSL cache is capped at MAX_PROGRAMS to avoid unbounded IDB growth
 *   - KHR_parallel_shader_compile is used when available to avoid stalling
 *     the main thread during GLSL pre-compilation
 */

const CACHE_DB_NAME    = "retrovault-shaders";
const CACHE_DB_VERSION = 2;
const CACHE_STORE      = "programs";
const WGSL_STORE       = "wgslModules";
const MAX_PROGRAMS     = 64;
const MAX_WGSL_MODULES = 32;

export interface CachedProgram {
  /** Stable key: djb2 hash of vsSource + "\0" + fsSource. */
  key:      string;
  vsSource: string;
  fsSource: string;
  /** Number of times this program pair has been recorded (for eviction). */
  hits:     number;
  /** Unix timestamp (ms) of the last access (for LRU eviction). */
  lastUsed: number;
}

export interface CachedWGSLModule {
  /** Stable key: djb2 hash of the WGSL source. */
  key:      string;
  source:   string;
  /** Descriptive label for debugging (e.g. "crt-fragment"). */
  label:    string;
  /** Number of times this module has been recorded (for eviction). */
  hits:     number;
  /** Unix timestamp (ms) of the last access (for LRU eviction). */
  lastUsed: number;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

let _cacheDB: IDBDatabase | null = null;
let _cacheDBPromise: Promise<IDBDatabase> | null = null;

function openCacheDB(): Promise<IDBDatabase> {
  if (_cacheDB)        return Promise.resolve(_cacheDB);
  if (_cacheDBPromise) return _cacheDBPromise;

  _cacheDBPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = req.result;

      // v1: GLSL program store (may already exist when upgrading from v1→v2)
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        const store = db.createObjectStore(CACHE_STORE, { keyPath: "key" });
        store.createIndex("lastUsed", "lastUsed", { unique: false });
      } else if (event.oldVersion < 2) {
        // Ensure the index exists on the existing store
        const txn = (event.target as IDBOpenDBRequest).transaction!;
        const existingStore = txn.objectStore(CACHE_STORE);
        if (!existingStore.indexNames.contains("lastUsed")) {
          existingStore.createIndex("lastUsed", "lastUsed", { unique: false });
        }
      }

      // v2: WGSL module store (new in version 2)
      if (!db.objectStoreNames.contains(WGSL_STORE)) {
        const wgslStore = db.createObjectStore(WGSL_STORE, { keyPath: "key" });
        wgslStore.createIndex("lastUsed", "lastUsed", { unique: false });
      }
    };

    req.onsuccess = () => {
      _cacheDB = req.result;
      _cacheDB.onclose = () => { _cacheDB = null; _cacheDBPromise = null; };
      resolve(_cacheDB);
    };

    req.onerror = () => {
      _cacheDBPromise = null;
      reject(req.error);
    };
  });

  return _cacheDBPromise;
}

function idbGet<T>(store: IDBObjectStore, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror   = () => reject(req.error);
  });
}

function idbPut(store: IDBObjectStore, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = store.put(value);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

function idbGetAll<T>(store: IDBObjectStore): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror   = () => reject(req.error);
  });
}

// ── Hash function ─────────────────────────────────────────────────────────────

/**
 * djb2 hash of a string, returned as an 8-character hex string.
 * Fast and collision-resistant enough for shader keys.
 */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function shaderProgramKey(vsSource: string, fsSource: string): string {
  return hashString(vsSource + "\0" + fsSource);
}

export function wgslModuleKey(source: string): string {
  return hashString(source);
}

// ── KHR_parallel_shader_compile ───────────────────────────────────────────────

interface ParallelShaderExt {
  COMPLETION_STATUS_KHR: number;
}

// ── ShaderCache class ─────────────────────────────────────────────────────────

export class ShaderCache {
  private _writesSinceEviction = 0;
  private _wgslWritesSinceEviction = 0;
  /**
   * Load all cached shader programs from IndexedDB.
   * Returns an empty array if the cache is empty or IDB is unavailable.
   */
  async load(): Promise<CachedProgram[]> {
    try {
      const db    = await openCacheDB();
      const store = db.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE);
      return await idbGetAll<CachedProgram>(store);
    } catch {
      return [];
    }
  }

  /**
   * Record that a shader program pair was used.
   *
   * If the program is new it is inserted; if it already exists its hit count
   * and lastUsed timestamp are updated. LRU eviction removes the oldest entry
   * once the store exceeds MAX_PROGRAMS.
   */
  async record(vsSource: string, fsSource: string): Promise<void> {
    try {
      const db  = await openCacheDB();
      const key = shaderProgramKey(vsSource, fsSource);

      // Read then write in separate transactions: awaiting across an IDB
      // transaction boundary causes TransactionInactiveError in some browsers.
      const existing = await idbGet<CachedProgram>(
        db.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE),
        key,
      );
      const entry: CachedProgram = {
        key,
        vsSource,
        fsSource,
        hits:     (existing?.hits ?? 0) + 1,
        lastUsed: Date.now(),
      };
      await idbPut(db.transaction(CACHE_STORE, "readwrite").objectStore(CACHE_STORE), entry);

      // LRU eviction: only check every 10 writes to avoid reading
      // all records on every shader compilation.
      this._writesSinceEviction++;
      if (this._writesSinceEviction >= 10) {
        this._writesSinceEviction = 0;
        const all = await idbGetAll<CachedProgram>(
          db.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE),
        );
        if (all.length > MAX_PROGRAMS) {
          all.sort((a, b) => a.lastUsed - b.lastUsed);
          const toDelete = all.slice(0, all.length - MAX_PROGRAMS);
          const evictTxn = db.transaction(CACHE_STORE, "readwrite").objectStore(CACHE_STORE);
          for (const old of toDelete) {
            evictTxn.delete(old.key);
          }
        }
      }
    } catch {
      // Best-effort — shader recording must never block gameplay
    }
  }

  /**
   * Pre-compile all cached shader programs on a throw-away WebGL context.
   *
   * This primes the GPU driver's internal disk-backed shader cache so that
   * when EmulatorJS compiles the same (or similar) shaders during game boot,
   * the driver can serve them from its cache rather than re-running the
   * full GLSL → SPIRV / GLSL → HLSL compilation pipeline.
   *
   * Uses KHR_parallel_shader_compile when available to avoid blocking the
   * main thread while the GPU driver compiles each program.
   */
  async preCompile(): Promise<void> {
    try {
      const programs = await this.load();
      if (programs.length === 0) return;

      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!gl) return;

      const parallelExt = gl.getExtension("KHR_parallel_shader_compile") as ParallelShaderExt | null;

      const compiled: Array<{ vs: WebGLShader; fs: WebGLShader; prog: WebGLProgram }> = [];

      for (const p of programs) {
        try {
          const vs = gl.createShader(gl.VERTEX_SHADER)!;
          gl.shaderSource(vs, p.vsSource);
          gl.compileShader(vs);

          const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
          gl.shaderSource(fs, p.fsSource);
          gl.compileShader(fs);

          const prog = gl.createProgram()!;
          gl.attachShader(prog, vs);
          gl.attachShader(prog, fs);
          gl.linkProgram(prog);

          // Skip entries that failed to compile/link — they would stall
          // the parallel-compile poll and occupy GPU resources for nothing.
          if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS) ||
              !gl.getShaderParameter(fs, gl.COMPILE_STATUS) ||
              !gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            gl.deleteShader(vs);
            gl.deleteShader(fs);
            gl.deleteProgram(prog);
            continue;
          }

          compiled.push({ vs, fs, prog });
        } catch {
          // skip broken entries
        }
      }

      if (parallelExt) {
        // Poll until all programs finish compiling — avoids a synchronous stall
        const poll = () => {
          const allDone = compiled.every(({ prog }) =>
            gl.getProgramParameter(prog, parallelExt.COMPLETION_STATUS_KHR) === true
          );
          if (!allDone) {
            setTimeout(poll, 4);
          } else {
            cleanup();
          }
        };
        poll();
      } else {
        cleanup();
      }

      function cleanup() {
        for (const { vs, fs, prog } of compiled) {
          gl!.deleteShader(vs);
          gl!.deleteShader(fs);
          gl!.deleteProgram(prog);
        }
        gl!.getExtension("WEBGL_lose_context")?.loseContext();
      }
    } catch {
      // best-effort
    }
  }

  /** Remove all cached shader programs. */
  async clear(): Promise<void> {
    try {
      const db = await openCacheDB();
      await new Promise<void>((resolve, reject) => {
        const req = db.transaction(CACHE_STORE, "readwrite").objectStore(CACHE_STORE).clear();
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
      });
    } catch {
      // best-effort
    }
  }

  /** Total number of cached programs. */
  async count(): Promise<number> {
    try {
      const db = await openCacheDB();
      return await new Promise<number>((resolve, reject) => {
        const req = db.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });
    } catch {
      return 0;
    }
  }

  // ── WGSL module cache ──────────────────────────────────────────────────────

  /**
   * Record a WGSL shader module source so it can be pre-compiled on the next
   * session startup. Call this alongside GPU pipeline builds so the sources
   * are persisted for subsequent warm-up runs.
   *
   * Uses the same LRU eviction strategy as the GLSL cache, capped at
   * MAX_WGSL_MODULES entries.
   */
  async recordWGSL(source: string, label = ""): Promise<void> {
    try {
      const db  = await openCacheDB();
      const key = wgslModuleKey(source);

      // Read then write in separate transactions to avoid TransactionInactiveError.
      const existing = await idbGet<CachedWGSLModule>(
        db.transaction(WGSL_STORE, "readonly").objectStore(WGSL_STORE),
        key,
      );
      const entry: CachedWGSLModule = {
        key,
        source,
        label,
        hits:     (existing?.hits ?? 0) + 1,
        lastUsed: Date.now(),
      };
      await idbPut(db.transaction(WGSL_STORE, "readwrite").objectStore(WGSL_STORE), entry);

      // LRU eviction: only check every 10 writes (mirrors the GLSL cache strategy).
      this._wgslWritesSinceEviction++;
      if (this._wgslWritesSinceEviction >= 10) {
        this._wgslWritesSinceEviction = 0;
        const all = await idbGetAll<CachedWGSLModule>(
          db.transaction(WGSL_STORE, "readonly").objectStore(WGSL_STORE),
        );
        if (all.length > MAX_WGSL_MODULES) {
          all.sort((a, b) => a.lastUsed - b.lastUsed);
          const toDelete = all.slice(0, all.length - MAX_WGSL_MODULES);
          const evictTxn = db.transaction(WGSL_STORE, "readwrite").objectStore(WGSL_STORE);
          for (const old of toDelete) {
            evictTxn.delete(old.key);
          }
        }
      }
    } catch {
      // Best-effort — must never block gameplay
    }
  }

  /**
   * Load all cached WGSL module entries from IndexedDB.
   * Returns an empty array if the cache is empty or IDB is unavailable.
   */
  async loadWGSL(): Promise<CachedWGSLModule[]> {
    try {
      const db    = await openCacheDB();
      const store = db.transaction(WGSL_STORE, "readonly").objectStore(WGSL_STORE);
      return await idbGetAll<CachedWGSLModule>(store);
    } catch {
      return [];
    }
  }

  /**
   * Pre-compile all cached WGSL modules using the provided GPUDevice.
   *
   * Calling device.createShaderModule() is sufficient to trigger the browser's
   * WGSL→native-binary compilation path and prime the GPU process shader
   * cache. The module objects are discarded immediately after creation.
   *
   * This should be called after preWarmWebGPU() has acquired a GPUDevice,
   * ideally in a requestIdleCallback so it does not block the UI thread.
   */
  async preCompileWGSL(device: GPUDevice): Promise<void> {
    try {
      const modules = await this.loadWGSL();
      if (modules.length === 0) return;

      for (const m of modules) {
        try {
          // createShaderModule() is non-blocking; the browser compiles
          // asynchronously. The resulting module is intentionally unused —
          // we only need the side-effect of warming the shader compiler cache.
          device.createShaderModule({ code: m.source, label: m.label || undefined });
        } catch {
          // A broken cached entry should not abort the rest of the pre-warm
        }
      }
    } catch {
      // best-effort
    }
  }

  /** Total number of cached WGSL modules. */
  async countWGSL(): Promise<number> {
    try {
      const db = await openCacheDB();
      return await new Promise<number>((resolve, reject) => {
        const req = db.transaction(WGSL_STORE, "readonly").objectStore(WGSL_STORE).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });
    } catch {
      return 0;
    }
  }

  /** Remove all cached WGSL modules. */
  async clearWGSL(): Promise<void> {
    try {
      const db = await openCacheDB();
      await new Promise<void>((resolve, reject) => {
        const req = db.transaction(WGSL_STORE, "readwrite").objectStore(WGSL_STORE).clear();
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
      });
    } catch {
      // best-effort
    }
  }
}

/** Singleton — one cache instance for the application lifetime. */
export const shaderCache = new ShaderCache();
