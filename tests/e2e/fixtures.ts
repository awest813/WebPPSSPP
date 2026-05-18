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

  function makeCursorRequest(values) {
    const req = { result: null, error: null, onsuccess: null, onerror: null };
    let index = 0;

    const pump = () => {
      if (index >= values.length) {
        req.result = null;
      } else {
        req.result = {
          value: values[index++],
          continue: () => Promise.resolve().then(pump),
        };
      }
      req.onsuccess?.({ target: req });
    };

    Promise.resolve().then(pump);
    return req;
  }

  function makeIndex(data, keyPath) {
    function indexValue(record) {
      if (!keyPath || (Array.isArray(keyPath) && keyPath.some((field) => field == null))) {
        return null;
      }
      return Array.isArray(keyPath)
        ? keyPath.map((field) => record[field])
        : record[keyPath];
    }
    return {
      get(key) {
        const encodedKey = JSON.stringify(key);
        const match = [...data.values()].find((value) => {
          return JSON.stringify(indexValue(value)) === encodedKey;
        });
        return makeRequest(match);
      },
      // SaveStateLibrary.getStatesForGame() uses idx.getAll(gameId)
      getAll(query) {
        const values = [...data.values()];
        if (query === undefined) {
          return makeRequest(values);
        }
        const encodedKey = JSON.stringify(query);
        const matches = values.filter((value) => JSON.stringify(indexValue(value)) === encodedKey);
        return makeRequest(matches);
      },
    };
  }

  function makeStore(storeName, data) {
    // Use a sequential counter as fallback key to avoid non-deterministic Math.random() collisions
    let _fallbackKeyCounter = 0;
    const indexes = new Map([
      ['systemId', 'systemId'],
      ['addedAt', 'addedAt'],
      ['lastPlayedAt', 'lastPlayedAt'],
      ['fileNameSystemId', ['fileName', 'systemId']],
      ['isFavorite', 'isFavorite'],
      // retro-oasis-saves "states" store (indexed by gameId / timestamp / label)
      ['gameId', 'gameId'],
      ['timestamp', 'timestamp'],
      ['label', 'label'],
    ]);

    return {
      indexNames: { contains: (name) => indexes.has(name) },
      createIndex(name, keyPath) { indexes.set(name, keyPath); return makeIndex(data, keyPath); },
      put(value) { data.set(value.id ?? ++_fallbackKeyCounter, value); return makeRequest(undefined); },
      get(key)   { return makeRequest(data.get(key)); },
      getAll()   { return makeRequest([...data.values()]); },
      delete(key){ data.delete(key); return makeRequest(undefined); },
      openCursor(){ return makeCursorRequest([...data.values()]); },
      index(name) { return makeIndex(data, indexes.get(name)); },
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
        req.transaction = db.transaction('games', 'versionchange');
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

    await page.goto("/", { timeout: 60_000, waitUntil: "domcontentloaded" });
    // Wait for the current library shell before handing off to the test.
    await expect(page).toHaveTitle(/RetroOasis/i, { timeout: 15_000 });
    await expect(page.locator("#landing")).toBeVisible({ timeout: 45_000 });
    await expect(page.locator("#file-input")).toBeAttached({ timeout: 10_000 });

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

/** Create a minimal stored ZIP archive containing one fake ROM and drop it on the app. */
export async function dropFakeZipRom(
  page: Page,
  opts: { archiveName?: string; romName?: string; content?: string } = {},
): Promise<void> {
  const archiveName = opts.archiveName ?? "archive.zip";
  const romName = opts.romName ?? "sonic.nes";
  const content = opts.content ?? "NES\x1a";

  await page.evaluate(
    ({ archiveName, romName, content }) => {
      const enc = new TextEncoder();
      const nameBytes = enc.encode(romName);
      const data = enc.encode(content);

      const localHeaderSize = 30 + nameBytes.length;
      const centralEntrySize = 46 + nameBytes.length;
      const totalSize = localHeaderSize + data.length + centralEntrySize + 22;
      const buffer = new ArrayBuffer(totalSize);
      const view = new DataView(buffer);
      const bytes = new Uint8Array(buffer);
      let pos = 0;
      const u16 = (offset: number, value: number) => view.setUint16(offset, value, true);
      const u32 = (offset: number, value: number) => view.setUint32(offset, value, true);

      u32(pos, 0x04034b50);
      u16(pos + 4, 20);
      u16(pos + 6, 0);
      u16(pos + 8, 0);
      u16(pos + 10, 0);
      u16(pos + 12, 0);
      u32(pos + 14, 0);
      u32(pos + 18, data.length);
      u32(pos + 22, data.length);
      u16(pos + 26, nameBytes.length);
      u16(pos + 28, 0);
      bytes.set(nameBytes, pos + 30);
      pos += localHeaderSize;
      bytes.set(data, pos);
      pos += data.length;

      const centralOffset = pos;
      u32(pos, 0x02014b50);
      u16(pos + 4, 20);
      u16(pos + 6, 20);
      u16(pos + 8, 0);
      u16(pos + 10, 0);
      u16(pos + 12, 0);
      u16(pos + 14, 0);
      u32(pos + 16, 0);
      u32(pos + 20, data.length);
      u32(pos + 24, data.length);
      u16(pos + 28, nameBytes.length);
      u16(pos + 30, 0);
      u16(pos + 32, 0);
      u16(pos + 34, 0);
      u16(pos + 36, 0);
      u32(pos + 38, 0);
      u32(pos + 42, 0);
      bytes.set(nameBytes, pos + 46);
      pos += centralEntrySize;

      u32(pos, 0x06054b50);
      u16(pos + 4, 0);
      u16(pos + 6, 0);
      u16(pos + 8, 1);
      u16(pos + 10, 1);
      u32(pos + 12, centralEntrySize);
      u32(pos + 16, centralOffset);
      u16(pos + 20, 0);

      const file = new File([bytes], archiveName, { type: "application/zip" });
      const dt = new DataTransfer();
      dt.items.add(file);

      const dropZone = document.getElementById("drop-zone") ?? document.body;
      dropZone.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }));
      dropZone.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt }));
      dropZone.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
    },
    { archiveName, romName, content },
  );
}

/** Create a minimal TAR archive containing one fake ROM and drop it on the app. */
export async function dropFakeTarRom(
  page: Page,
  opts: { archiveName?: string; romName?: string; content?: string } = {},
): Promise<void> {
  const archiveName = opts.archiveName ?? "archive.tar";
  const romName = opts.romName ?? "sonic.nes";
  const content = opts.content ?? "NES\x1a";

  await page.evaluate(
    ({ archiveName, romName, content }) => {
      const enc = new TextEncoder();
      const nameBytes = enc.encode(romName);
      const data = enc.encode(content);
      const pad = (512 - (data.length % 512)) % 512;
      const bytes = new Uint8Array(512 + data.length + pad + 1024);
      const header = bytes.subarray(0, 512);

      const writeOctal = (start: number, length: number, value: number) => {
        const oct = value.toString(8).padStart(length - 1, "0");
        header.set(enc.encode(oct).slice(0, length - 1), start);
        header[start + length - 1] = 0;
      };

      header.set(nameBytes.slice(0, 100), 0);
      writeOctal(100, 8, 0o644);
      writeOctal(108, 8, 0);
      writeOctal(116, 8, 0);
      writeOctal(124, 12, data.length);
      writeOctal(136, 12, 0);
      for (let i = 148; i < 156; i++) header[i] = 0x20;
      header[156] = 0x30;
      header.set(enc.encode("ustar"), 257);
      header[262] = 0;
      header[263] = 0x30;
      header[264] = 0x30;

      let checksum = 0;
      for (const byte of header) checksum += byte;
      writeOctal(148, 8, checksum);
      bytes.set(data, 512);

      const file = new File([bytes], archiveName, { type: "application/x-tar" });
      const dt = new DataTransfer();
      dt.items.add(file);

      const dropZone = document.getElementById("drop-zone") ?? document.body;
      dropZone.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }));
      dropZone.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt }));
      dropZone.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
    },
    { archiveName, romName, content },
  );
}

/** Resolve the absolute path to a fixture file in tests/e2e/fixtures/. */
export function fixturePath(name: string): string {
  return path.resolve(__dirname, "fixtures", name);
}
