/**
 * shaderCache.ts — WebGL shader source cache backed by IndexedDB
 *
 * Persists GLSL vertex + fragment shader source strings across sessions so
 * that the GPU driver's internal shader cache can be pre-warmed on subsequent
 * launches. On first visit the browser must compile every shader from source;
 * on repeat visits the driver typically has a binary in its disk cache — this
 * module ensures those shaders are presented to the compiler early (during
 * idle time) so the first rendered frame has no recompile stutter.
 *
 * Design constraints:
 *   - WebGL has no standard API to save/restore compiled GPU binaries
 *   - We store GLSL source text (small, typically <4 KB per program)
 *   - Pre-compilation runs on a throw-away off-screen canvas so it never
 *     interferes with the game's WebGL context
 *   - The cache is capped at MAX_PROGRAMS to avoid unbounded IDB growth
 *   - KHR_parallel_shader_compile is used when available to avoid stalling
 *     the main thread during pre-compilation
 */

const CACHE_DB_NAME    = "retrovault-shaders";
const CACHE_DB_VERSION = 1;
const CACHE_STORE      = "programs";
const MAX_PROGRAMS     = 64;

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

// ── DB helpers ────────────────────────────────────────────────────────────────

let _cacheDB: IDBDatabase | null = null;
let _cacheDBPromise: Promise<IDBDatabase> | null = null;

function openCacheDB(): Promise<IDBDatabase> {
  if (_cacheDB)        return Promise.resolve(_cacheDB);
  if (_cacheDBPromise) return _cacheDBPromise;

  _cacheDBPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);

    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(CACHE_STORE, { keyPath: "key" });
      store.createIndex("lastUsed", "lastUsed", { unique: false });
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

// ── KHR_parallel_shader_compile ───────────────────────────────────────────────

interface ParallelShaderExt {
  COMPLETION_STATUS_KHR: number;
}

// ── ShaderCache class ─────────────────────────────────────────────────────────

export class ShaderCache {
  private _writesSinceEviction = 0;
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
      const txn = db.transaction(CACHE_STORE, "readwrite");
      const store = txn.objectStore(CACHE_STORE);

      const existing = await idbGet<CachedProgram>(store, key);
      const entry: CachedProgram = {
        key,
        vsSource,
        fsSource,
        hits:     (existing?.hits ?? 0) + 1,
        lastUsed: Date.now(),
      };
      await idbPut(store, entry);

      // LRU eviction: only check every 10 writes to avoid reading
      // all records on every shader compilation.
      this._writesSinceEviction++;
      if (this._writesSinceEviction >= 10) {
        this._writesSinceEviction = 0;
        const all = await idbGetAll<CachedProgram>(store);
        if (all.length > MAX_PROGRAMS) {
          all.sort((a, b) => a.lastUsed - b.lastUsed);
          const toDelete = all.slice(0, all.length - MAX_PROGRAMS);
          for (const old of toDelete) {
            store.delete(old.key);
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
}

/** Singleton — one cache instance for the application lifetime. */
export const shaderCache = new ShaderCache();
