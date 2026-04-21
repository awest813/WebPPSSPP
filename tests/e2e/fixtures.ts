/**
 * tests/e2e/fixtures.ts — Shared Playwright fixtures and helpers.
 *
 * - Injects fake-indexeddb shims via page.addInitScript so test runs don't
 *   touch the real browser database.
 * - Stubs the EmulatorJS WASM load so tests don't wait for a real ROM boot.
 * - Provides a typed `app` fixture that wraps common page interactions.
 */

import { test as base, expect, type Page } from "@playwright/test";
import * as path from "path";

// ── Stubs injected before any app script runs ─────────────────────────────────

const IDB_STUB_SCRIPT = `
// Minimal in-memory IndexedDB shim for Playwright tests.
// Replaces window.indexedDB with a Map-backed implementation that avoids
// touching the real browser database.
(function() {
  const _stores = new Map();

  function makeRequest(result) {
    const req = { result, error: null, onsuccess: null, onerror: null };
    Promise.resolve().then(() => req.onsuccess?.({ target: req }));
    return req;
  }

  function makeStore(storeName, data) {
    // Use a sequential counter as fallback key to avoid non-deterministic Math.random() collisions
    let _fallbackKeyCounter = 0;
    return {
      put(value) { data.set(value.id ?? ++_fallbackKeyCounter, value); return makeRequest(undefined); },
      get(key)   { return makeRequest(data.get(key)); },
      getAll()   { return makeRequest([...data.values()]); },
      delete(key){ data.delete(key); return makeRequest(undefined); },
      openCursor(){ return makeRequest(null); },
      index()    { return makeStore(storeName, data); },
    };
  }

  const _fakeIDB = {
    open(name, version) {
      const req = {
        result: null, error: null,
        onupgradeneeded: null, onsuccess: null, onerror: null,
      };
      Promise.resolve().then(() => {
        if (!_stores.has(name)) _stores.set(name, new Map());
        const storeMap = _stores.get(name);
        const db = {
          objectStoreNames: { contains: () => true },
          createObjectStore(storeName) {
            if (!storeMap.has(storeName)) storeMap.set(storeName, new Map());
            return makeStore(storeName, storeMap.get(storeName));
          },
          transaction(storeNames, _mode) {
            const names = Array.isArray(storeNames) ? storeNames : [storeNames];
            const stores = {};
            for (const n of names) {
              if (!storeMap.has(n)) storeMap.set(n, new Map());
              stores[n] = makeStore(n, storeMap.get(n));
            }
            return {
              objectStore: (n) => stores[n],
              oncomplete: null, onerror: null,
              commit() { },
            };
          },
          close() {},
        };
        req.result = db;
        req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
      return req;
    },
    deleteDatabase() { return makeRequest(undefined); },
  };

  try {
    Object.defineProperty(window, 'indexedDB', { value: _fakeIDB, writable: true, configurable: true });
  } catch {
    // Some browsers (or other init scripts) may prevent this override —
    // acceptable in test environments since the real IDB is sandboxed anyway.
  }
})();
`;

const EMULATOR_STUB_SCRIPT = `
// Stub EmulatorJS so tests don't wait for real WASM/ROM loading.
window._RETRO_OASIS_E2E_STUB = true;

// Prevent EJS from booting
window.EJS_player = undefined;
window.EJS_startOnLoaded = false;
`;

// ── Base fixture ───────────────────────────────────────────────────────────────

export interface RetroOasisFixtures {
  /** Page with shims pre-loaded; navigated to the app root. */
  appPage: Page;
}

export const test = base.extend<RetroOasisFixtures>({
  appPage: async ({ page }, use) => {
    // Inject stubs before the app boots
    await page.addInitScript({ content: IDB_STUB_SCRIPT });
    await page.addInitScript({ content: EMULATOR_STUB_SCRIPT });

    await page.goto("/");
    // Wait for the library container to appear before handing off to the test
    await page.waitForSelector("#library-container, #drop-zone, #landing", {
      timeout: 15_000,
    });

    await use(page);
  },
});

export { expect };

// ── Common helpers ─────────────────────────────────────────────────────────────

/** Create a minimal fake ROM File object and drop it on the app drop zone. */
export async function dropFakeRom(
  page: Page,
  opts: { fileName?: string; content?: string } = {},
): Promise<void> {
  const fileName = opts.fileName ?? "sonic.nes";
  const content  = opts.content  ?? "NES\x1a"; // iNES magic bytes

  await page.evaluate(
    ({ fileName, content }) => {
      const bytes = new TextEncoder().encode(content);
      const file  = new File([bytes], fileName, { type: "application/octet-stream" });
      const dt    = new DataTransfer();
      dt.items.add(file);

      const dropZone = document.getElementById("drop-zone") ?? document.body;
      dropZone.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }));
      dropZone.dispatchEvent(new DragEvent("dragover",  { bubbles: true, dataTransfer: dt }));
      dropZone.dispatchEvent(new DragEvent("drop",      { bubbles: true, dataTransfer: dt }));
    },
    { fileName, content },
  );
}

/** Resolve the absolute path to a fixture file in tests/e2e/fixtures/. */
export function fixturePath(name: string): string {
  return path.resolve(__dirname, "fixtures", name);
}
