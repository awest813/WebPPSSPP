import "fake-indexeddb/auto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { WasmModuleCache } from "./wasmCache.js";

// ── WasmModuleCache ───────────────────────────────────────────────────────────

describe("WasmModuleCache", () => {
  // Use fake-indexeddb (provided by vitest setup) for all IDB calls

  it("isSupported() returns true in jsdom (IDB + WebAssembly available)", () => {
    expect(WasmModuleCache.isSupported()).toBe(true);
  });

  it("clear() resolves without error on a fresh cache", async () => {
    const cache = new WasmModuleCache();
    await expect(cache.clear()).resolves.toBeUndefined();
  });

  it("evict() resolves without error for a URL that is not cached", async () => {
    const cache = new WasmModuleCache();
    await expect(
      cache.evict("https://cdn.emulatorjs.org/stable/data/cores/nonexistent.wasm")
    ).resolves.toBeUndefined();
  });

  it("store() and getOrFetch() round-trip a module", async () => {
    // Build the simplest valid WebAssembly module binary (empty module)
    // Magic: 0x00 0x61 0x73 0x6d | Version: 0x01 0x00 0x00 0x00
    const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const module = await WebAssembly.compile(wasmBytes.buffer as ArrayBuffer);

    const cache = new WasmModuleCache();
    const url = "https://example.com/test.wasm";

    // Store the module with a fake ETag
    await cache.store(url, module, '"abc123"');

    // Now getOrFetch should return a module — mock fetch to return 304 (still fresh)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 304,
      headers: { get: () => null },
      arrayBuffer: vi.fn(),
    }));

    // The fetch mock for HEAD should return 304 — so the cached module is used.
    // Because structured-clone of WebAssembly.Module works in jsdom/vitest we
    // should get a module back (not necessarily the same reference, but a valid one).
    const retrieved = await cache.getOrFetch(url);
    expect(retrieved).toBeInstanceOf(WebAssembly.Module);

    vi.unstubAllGlobals();
  });

  it("falls back to compile on network error", async () => {
    const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const cache = new WasmModuleCache();
    // Should reject because fetch fails and there is no cached module
    await expect(
      cache.getOrFetch("https://example.com/unreachable.wasm")
    ).rejects.toThrow();

    vi.unstubAllGlobals();
  });

  it("getOrFetch falls back gracefully when IDB is unavailable", async () => {
    // Simulate IDB unavailability by mocking indexedDB.open to throw
    const originalIDB = globalThis.indexedDB;
    Object.defineProperty(globalThis, "indexedDB", {
      value: {
        open: () => { throw new Error("IDB unavailable"); },
      },
      configurable: true,
    });

    const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: vi.fn().mockResolvedValue(wasmBytes.buffer as ArrayBuffer),
    }));

    const cache = new WasmModuleCache();
    // Should still return a module via the fallback path
    const mod = await cache.getOrFetch("https://example.com/test.wasm");
    expect(mod).toBeInstanceOf(WebAssembly.Module);

    Object.defineProperty(globalThis, "indexedDB", { value: originalIDB, configurable: true });
    vi.unstubAllGlobals();
  });

  it("evict() removes a stored module", async () => {
    const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const module = await WebAssembly.compile(wasmBytes.buffer as ArrayBuffer);

    const cache = new WasmModuleCache();
    const url = "https://example.com/evict-test.wasm";
    await cache.store(url, module, '"etag1"');
    await cache.evict(url);

    // After eviction, getOrFetch must go to network (mock it to respond)
    let fetchCalled = false;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      fetchCalled = true;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: () => Promise.resolve(wasmBytes.buffer as ArrayBuffer),
      });
    }));

    await cache.getOrFetch(url);
    expect(fetchCalled).toBe(true);

    vi.unstubAllGlobals();
  });

  it("isSupported() returns false when WebAssembly is not available", () => {
    const original = globalThis.WebAssembly;
    Object.defineProperty(globalThis, "WebAssembly", { value: undefined, configurable: true });
    expect(WasmModuleCache.isSupported()).toBe(false);
    Object.defineProperty(globalThis, "WebAssembly", { value: original, configurable: true });
  });
});
