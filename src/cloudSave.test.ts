import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  NullCloudProvider,
  CloudSaveSync,
  WebDAVProvider,
  GoogleDriveProvider,
  DropboxProvider,
  pCloudProvider,
  BlompProvider,
  BoxProvider,
  OneDriveProvider,
  MegaProvider,
  CloudSaveManager,
  type CloudSaveProvider,
  type CloudSaveManifest,
  type SyncConflict,
} from "./cloudSave.js";
import type { SaveStateEntry } from "./saves.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<SaveStateEntry> = {}): SaveStateEntry {
  const gameId = overrides.gameId ?? "game-1";
  const slot   = overrides.slot   ?? 1;
  return {
    id:         `${gameId}:${slot}`,
    gameId,
    gameName:   overrides.gameName   ?? "Test Game",
    systemId:   overrides.systemId   ?? "psp",
    slot,
    label:      overrides.label      ?? `Slot ${slot}`,
    timestamp:  overrides.timestamp  ?? 1_000_000,
    thumbnail:  overrides.thumbnail  ?? null,
    stateData:  overrides.stateData  ?? new Blob(["state"]),
    isAutoSave: overrides.isAutoSave ?? false,
    version:    overrides.version    ?? 1,
    checksum:   overrides.checksum   ?? "abc12345",
  };
}

function makeManifest(overrides: Partial<CloudSaveManifest> = {}): CloudSaveManifest {
  return {
    gameId:    overrides.gameId    ?? "game-1",
    slot:      overrides.slot      ?? 1,
    timestamp: overrides.timestamp ?? 1_000_000,
    checksum:  overrides.checksum  ?? "abc12345",
    label:     overrides.label     ?? "Slot 1",
    gameName:  overrides.gameName  ?? "Test Game",
    systemId:  overrides.systemId  ?? "psp",
    version:   overrides.version   ?? 1,
  };
}

/** Build a mock CloudSaveProvider with every method as a vi.fn(). */
function makeMockProvider(available = true): CloudSaveProvider & {
  upload: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
  listManifests: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  return {
    providerId:   "mock",
    displayName:  "Mock Provider",
    isAvailable:  vi.fn().mockResolvedValue(available),
    upload:       vi.fn().mockResolvedValue(undefined),
    download:     vi.fn().mockResolvedValue(null),
    listManifests: vi.fn().mockResolvedValue([]),
    delete:       vi.fn().mockResolvedValue(undefined),
  };
}

// ── NullCloudProvider ─────────────────────────────────────────────────────────

describe("NullCloudProvider", () => {
  let provider: NullCloudProvider;

  beforeEach(() => {
    provider = new NullCloudProvider();
  });

  it("has providerId 'null'", () => {
    expect(provider.providerId).toBe("null");
  });

  it("has a non-empty displayName", () => {
    expect(provider.displayName.length).toBeGreaterThan(0);
  });

  it("isAvailable() returns false", async () => {
    expect(await provider.isAvailable()).toBe(false);
  });

  it("upload() resolves without error", async () => {
    await expect(provider.upload(makeEntry())).resolves.toBeUndefined();
  });

  it("download() returns null", async () => {
    expect(await provider.download("game-1", 1)).toBeNull();
  });

  it("listManifests() returns empty array", async () => {
    expect(await provider.listManifests("game-1")).toEqual([]);
  });

  it("delete() resolves without error", async () => {
    await expect(provider.delete("game-1", 1)).resolves.toBeUndefined();
  });
});

// ── CloudSaveSync — isAvailable / push / pull ─────────────────────────────────

describe("CloudSaveSync — push / pull", () => {
  it("push() calls provider.upload when available", async () => {
    const provider = makeMockProvider(true);
    const sync     = new CloudSaveSync(provider);
    const entry    = makeEntry();

    await sync.push(entry);

    expect(provider.upload).toHaveBeenCalledTimes(1);
    expect(provider.upload).toHaveBeenCalledWith(entry);
  });

  it("push() does not call provider.upload when unavailable", async () => {
    const provider = makeMockProvider(false);
    const sync     = new CloudSaveSync(provider);

    await sync.push(makeEntry());

    expect(provider.upload).not.toHaveBeenCalled();
  });

  it("pull() returns remote entry when available", async () => {
    const provider   = makeMockProvider(true);
    const remoteEntry = makeEntry({ timestamp: 9999 });
    provider.download.mockResolvedValue(remoteEntry);
    const sync = new CloudSaveSync(provider);

    const result = await sync.pull("game-1", 1);

    expect(result).toBe(remoteEntry);
    expect(provider.download).toHaveBeenCalledWith("game-1", 1);
  });

  it("pull() returns null when provider is unavailable", async () => {
    const provider = makeMockProvider(false);
    const sync     = new CloudSaveSync(provider);

    const result = await sync.pull("game-1", 1);

    expect(result).toBeNull();
    expect(provider.download).not.toHaveBeenCalled();
  });

  it("pull() returns null when no cloud save exists", async () => {
    const provider = makeMockProvider(true);
    const sync     = new CloudSaveSync(provider);

    const result = await sync.pull("game-1", 1);

    expect(result).toBeNull();
  });

  it("isAvailable() delegates to provider", async () => {
    const p1 = makeMockProvider(true);
    const p2 = makeMockProvider(false);
    expect(await new CloudSaveSync(p1).isAvailable()).toBe(true);
    expect(await new CloudSaveSync(p2).isAvailable()).toBe(false);
  });

  it("providerId reflects the underlying provider", () => {
    const provider = makeMockProvider();
    const sync     = new CloudSaveSync(provider);
    expect(sync.providerId).toBe("mock");
  });
});

// ── CloudSaveSync — resolveConflict ───────────────────────────────────────────

describe("CloudSaveSync — resolveConflict", () => {
  function makeConflict(localTs: number, remoteTs: number): SyncConflict {
    return {
      local:  makeEntry({ timestamp: localTs }),
      remote: makeEntry({ timestamp: remoteTs }),
      gameId: "game-1",
      slot:   1,
    };
  }

  it('"newest" picks remote when remote is newer', () => {
    const sync   = new CloudSaveSync(makeMockProvider(), "newest");
    const result = sync.resolveConflict(makeConflict(1000, 2000));
    expect(result.timestamp).toBe(2000);
  });

  it('"newest" picks local when local is newer', () => {
    const sync   = new CloudSaveSync(makeMockProvider(), "newest");
    const result = sync.resolveConflict(makeConflict(5000, 3000));
    expect(result.timestamp).toBe(5000);
  });

  it('"newest" picks remote when timestamps are equal (tie-break to remote)', () => {
    const sync   = new CloudSaveSync(makeMockProvider(), "newest");
    const result = sync.resolveConflict(makeConflict(1000, 1000));
    expect(result.timestamp).toBe(1000);
  });

  it('"local" always returns the local entry', () => {
    const sync   = new CloudSaveSync(makeMockProvider(), "local");
    const conflict = makeConflict(100, 9999);
    const result   = sync.resolveConflict(conflict);
    expect(result).toBe(conflict.local);
  });

  it('"remote" always returns the remote entry', () => {
    const sync   = new CloudSaveSync(makeMockProvider(), "remote");
    const conflict = makeConflict(9999, 100);
    const result   = sync.resolveConflict(conflict);
    expect(result).toBe(conflict.remote);
  });
});

// ── CloudSaveSync — syncSlot ──────────────────────────────────────────────────

describe("CloudSaveSync — syncSlot", () => {
  it("returns null when provider is unavailable", async () => {
    const sync   = new CloudSaveSync(makeMockProvider(false));
    const result = await sync.syncSlot(makeEntry(), "game-1", 1);
    expect(result).toBeNull();
  });

  it("returns null when neither local nor remote exists", async () => {
    const provider = makeMockProvider(true);
    const sync     = new CloudSaveSync(provider);

    const result = await sync.syncSlot(null, "game-1", 1);

    expect(result).toBeNull();
    expect(provider.upload).not.toHaveBeenCalled();
  });

  it("pushes local entry when no remote exists and returns 'pushed'", async () => {
    const provider   = makeMockProvider(true);
    const localEntry = makeEntry({ timestamp: 1000 });
    const sync       = new CloudSaveSync(provider);

    const result = await sync.syncSlot(localEntry, "game-1", 1);

    expect(result).not.toBeNull();
    expect(result!.direction).toBe("pushed");
    expect(result!.entry).toBe(localEntry);
    expect(provider.upload).toHaveBeenCalledWith(localEntry);
  });

  it("returns remote entry as 'pulled' when no local exists", async () => {
    const provider    = makeMockProvider(true);
    const remoteEntry = makeEntry({ timestamp: 5000 });
    provider.download.mockResolvedValue(remoteEntry);
    const sync = new CloudSaveSync(provider);

    const result = await sync.syncSlot(null, "game-1", 1);

    expect(result).not.toBeNull();
    expect(result!.direction).toBe("pulled");
    expect(result!.entry).toBe(remoteEntry);
    expect(provider.upload).not.toHaveBeenCalled();
  });

  it("pushes local when local wins conflict ('local' strategy)", async () => {
    const provider    = makeMockProvider(true);
    const localEntry  = makeEntry({ timestamp: 1000 });
    const remoteEntry = makeEntry({ timestamp: 9999 });
    provider.download.mockResolvedValue(remoteEntry);
    const sync = new CloudSaveSync(provider, "local");

    const result = await sync.syncSlot(localEntry, "game-1", 1);

    expect(result!.direction).toBe("pushed");
    expect(result!.entry).toBe(localEntry);
    expect(provider.upload).toHaveBeenCalledWith(localEntry);
  });

  it("returns remote as 'pulled' when remote wins conflict ('remote' strategy)", async () => {
    const provider    = makeMockProvider(true);
    const localEntry  = makeEntry({ timestamp: 9999 });
    const remoteEntry = makeEntry({ timestamp: 1000 });
    provider.download.mockResolvedValue(remoteEntry);
    const sync = new CloudSaveSync(provider, "remote");

    const result = await sync.syncSlot(localEntry, "game-1", 1);

    expect(result!.direction).toBe("pulled");
    expect(result!.entry).toBe(remoteEntry);
    expect(provider.upload).not.toHaveBeenCalled();
  });

  it("pushes local when local is newer ('newest' strategy)", async () => {
    const provider    = makeMockProvider(true);
    const localEntry  = makeEntry({ timestamp: 9000 });
    const remoteEntry = makeEntry({ timestamp: 1000 });
    provider.download.mockResolvedValue(remoteEntry);
    const sync = new CloudSaveSync(provider, "newest");

    const result = await sync.syncSlot(localEntry, "game-1", 1);

    expect(result!.direction).toBe("pushed");
    expect(result!.entry).toBe(localEntry);
  });

  it("returns remote as 'pulled' when remote is newer ('newest' strategy)", async () => {
    const provider    = makeMockProvider(true);
    const localEntry  = makeEntry({ timestamp: 1000 });
    const remoteEntry = makeEntry({ timestamp: 9000 });
    provider.download.mockResolvedValue(remoteEntry);
    const sync = new CloudSaveSync(provider, "newest");

    const result = await sync.syncSlot(localEntry, "game-1", 1);

    expect(result!.direction).toBe("pulled");
    expect(result!.entry).toBe(remoteEntry);
  });

  it("returns remote as 'pulled' when timestamps are equal ('newest' tie-breaks to remote)", async () => {
    const provider    = makeMockProvider(true);
    const localEntry  = makeEntry({ timestamp: 1000 });
    const remoteEntry = makeEntry({ timestamp: 1000 });
    provider.download.mockResolvedValue(remoteEntry);
    const sync = new CloudSaveSync(provider, "newest");

    const result = await sync.syncSlot(localEntry, "game-1", 1);

    expect(result!.direction).toBe("pulled");
    expect(result!.entry).toBe(remoteEntry);
    expect(provider.upload).not.toHaveBeenCalled();
  });
});

// ── CloudSaveSync — listManifests ─────────────────────────────────────────────

describe("CloudSaveSync — listManifests", () => {
  it("returns empty array when provider is unavailable", async () => {
    const sync = new CloudSaveSync(makeMockProvider(false));
    expect(await sync.listManifests("game-1")).toEqual([]);
  });

  it("delegates to provider.listManifests when available", async () => {
    const provider  = makeMockProvider(true);
    const manifests = [makeManifest({ slot: 1 }), makeManifest({ slot: 2 })];
    provider.listManifests.mockResolvedValue(manifests);
    const sync = new CloudSaveSync(provider);

    const result = await sync.listManifests("game-1");

    expect(result).toBe(manifests);
    expect(provider.listManifests).toHaveBeenCalledWith("game-1");
  });
});

// ── WebDAVProvider ────────────────────────────────────────────────────────────

describe("WebDAVProvider — construction", () => {
  it("has providerId 'webdav' and a non-empty displayName", () => {
    const p = new WebDAVProvider("https://dav.example.com/saves", "user", "pass");
    expect(p.providerId).toBe("webdav");
    expect(p.displayName.length).toBeGreaterThan(0);
  });
});

describe("WebDAVProvider — isAvailable", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns true when the server responds with a 2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true }));
    const p = new WebDAVProvider("https://dav.example.com/saves", "u", "p");
    expect(await p.isAvailable()).toBe(true);
  });

  it("returns true when the server responds with 4xx (server reachable, auth denied)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401, ok: false }));
    const p = new WebDAVProvider("https://dav.example.com/saves", "u", "p");
    expect(await p.isAvailable()).toBe(true);
  });

  it("returns false when fetch throws (network error / CORS)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const p = new WebDAVProvider("https://dav.example.com/saves", "u", "p");
    expect(await p.isAvailable()).toBe(false);
  });

  it("returns false when the server responds with 5xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 503, ok: false }));
    const p = new WebDAVProvider("https://dav.example.com/saves", "u", "p");
    expect(await p.isAvailable()).toBe(false);
  });
});

describe("WebDAVProvider — upload", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("sends PUT requests for manifest.json, state.bin, and thumb.jpg", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal("fetch", mockFetch);

    const entry = makeEntry({ gameId: "g1", slot: 1, stateData: new Blob(["state"]), thumbnail: new Blob(["img"], { type: "image/jpeg" }) });
    const p = new WebDAVProvider("https://dav.example.com/saves", "u", "p");
    await p.upload(entry);

    const methods = mockFetch.mock.calls.map((c: unknown[]) => (c[1] as { method: string }).method);
    const urls    = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);

    expect(methods).toContain("MKCOL");
    expect(methods).toContain("PUT");
    expect(urls.some((u: string) => u.includes("manifest.json"))).toBe(true);
    expect(urls.some((u: string) => u.includes("state.bin"))).toBe(true);
    expect(urls.some((u: string) => u.includes("thumb.jpg"))).toBe(true);
  });

  it("throws when a PUT request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    const entry = makeEntry({ stateData: null, thumbnail: null });
    const p = new WebDAVProvider("https://dav.example.com/saves", "u", "p");
    await expect(p.upload(entry)).rejects.toThrow(/WebDAV PUT failed/);
  });
});

describe("WebDAVProvider — download", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns null when manifest.json is not found (404)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const p = new WebDAVProvider("https://dav.example.com/saves", "u", "p");
    expect(await p.download("game-1", 1)).toBeNull();
  });

  it("returns a SaveStateEntry when manifest and state exist", async () => {
    const manifest: CloudSaveManifest = makeManifest({ gameId: "game-1", slot: 1 });
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => manifest })  // manifest
      .mockResolvedValueOnce({ ok: true, status: 200, blob: async () => new Blob(["state"]) }) // state
      .mockResolvedValueOnce({ ok: false, status: 404 }); // no thumbnail

    vi.stubGlobal("fetch", mockFetch);
    const p = new WebDAVProvider("https://dav.example.com/saves", "u", "p");
    const result = await p.download("game-1", 1);

    expect(result).not.toBeNull();
    expect(result!.gameId).toBe("game-1");
    expect(result!.slot).toBe(1);
    expect(result!.stateData).not.toBeNull();
    expect(result!.thumbnail).toBeNull();
  });
});

describe("WebDAVProvider — listManifests", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns manifests for slots that exist", async () => {
    const manifest = makeManifest({ slot: 2 });
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if ((url as string).includes("/2/manifest.json")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => manifest });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const p = new WebDAVProvider("https://dav.example.com/saves", "u", "p");
    const results = await p.listManifests("game-1");

    expect(results).toHaveLength(1);
    expect(results[0]!.slot).toBe(2);
  });

  it("returns empty array when no slots exist", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const p = new WebDAVProvider("https://dav.example.com/saves", "u", "p");
    expect(await p.listManifests("game-1")).toEqual([]);
  });
});

describe("WebDAVProvider — delete", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("sends DELETE requests for all three files", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", mockFetch);

    const p = new WebDAVProvider("https://dav.example.com/saves", "u", "p");
    await p.delete("game-1", 2);

    const methods = mockFetch.mock.calls.map((c: unknown[]) => (c[1] as { method: string }).method);
    expect(methods.filter((m: string) => m === "DELETE")).toHaveLength(3);
  });

  it("resolves even when individual DELETE requests fail (allSettled semantics)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    vi.stubGlobal("fetch", mockFetch);

    const p = new WebDAVProvider("https://dav.example.com/saves", "u", "p");
    // delete() uses Promise.allSettled so it should not throw even if _deleteFile throws
    await expect(p.delete("game-1", 1)).resolves.toBeUndefined();
  });
});

// ── CloudSaveManager ──────────────────────────────────────────────────────────

describe("CloudSaveManager — initial state", () => {
  beforeEach(() => localStorage.clear());

  it("starts disconnected", () => {
    const m = new CloudSaveManager();
    expect(m.isConnected()).toBe(false);
  });

  it("defaults to conflictResolution 'newest' and autoSyncEnabled false", () => {
    const m = new CloudSaveManager();
    expect(m.conflictResolution).toBe("newest");
    expect(m.autoSyncEnabled).toBe(false);
  });
});

describe("CloudSaveManager — connect / disconnect", () => {
  beforeEach(() => localStorage.clear());

  it("connect() sets isConnected() true when provider is available", async () => {
    const m = new CloudSaveManager();
    await m.connect(makeMockProvider(true));
    expect(m.isConnected()).toBe(true);
  });

  it("connect() throws when provider reports unavailable", async () => {
    const m = new CloudSaveManager();
    await expect(m.connect(makeMockProvider(false))).rejects.toThrow();
    expect(m.isConnected()).toBe(false);
  });

  it("disconnect() sets isConnected() false", async () => {
    const m = new CloudSaveManager();
    await m.connect(makeMockProvider(true));
    m.disconnect();
    expect(m.isConnected()).toBe(false);
  });

  it("fires onStatusChange on connect and disconnect", async () => {
    const m = new CloudSaveManager();
    const spy = vi.fn();
    m.onStatusChange = spy;
    await m.connect(makeMockProvider(true));
    expect(spy).toHaveBeenCalledTimes(1);
    m.disconnect();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("CloudSaveManager — push / pull", () => {
  beforeEach(() => localStorage.clear());

  it("push() delegates to the underlying sync when connected", async () => {
    const provider = makeMockProvider(true);
    const m = new CloudSaveManager();
    await m.connect(provider);
    const entry = makeEntry();
    await m.push(entry);
    expect(provider.upload).toHaveBeenCalledWith(entry);
  });

  it("push() is a no-op when disconnected", async () => {
    const provider = makeMockProvider(false);
    const m = new CloudSaveManager();
    await m.push(makeEntry()).catch(() => {}); // provider unavailable, no-op
    expect(provider.upload).not.toHaveBeenCalled();
    expect(m.lastSyncAt).toBeNull();
  });

  it("pull() returns null when disconnected", async () => {
    const m = new CloudSaveManager();
    expect(await m.pull("game-1", 1)).toBeNull();
    expect(m.lastSyncAt).toBeNull();
  });

  it("pull() records lastSyncAt on success", async () => {
    const provider = makeMockProvider(true);
    provider.download.mockResolvedValue(makeEntry());
    const m = new CloudSaveManager();
    await m.connect(provider);
    await m.pull("game-1", 1);
    expect(m.lastSyncAt).not.toBeNull();
  });

  it("push() records lastError and re-throws on provider error", async () => {
    const provider = makeMockProvider(true);
    provider.upload.mockRejectedValue(new Error("network fail"));
    const m = new CloudSaveManager();
    await m.connect(provider);
    await expect(m.push(makeEntry())).rejects.toThrow("network fail");
    expect(m.lastError).toBe("network fail");
  });
});

describe("CloudSaveManager — syncGame", () => {
  beforeEach(() => localStorage.clear());

  it("returns pushed/pulled counts after syncing all slots", async () => {
    const provider = makeMockProvider(true);
    // provider has no remote saves → every local save gets pushed
    const m = new CloudSaveManager();
    await m.connect(provider);

    const states = [makeEntry({ slot: 1 }), makeEntry({ slot: 2 })];
    const fakeLib = { getStatesForGame: vi.fn().mockResolvedValue(states) };
    const result = await m.syncGame("game-1", fakeLib);

    expect(result.pushed).toBe(2);
    expect(result.pulled).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("counts errors without throwing", async () => {
    const provider = makeMockProvider(true);
    provider.upload.mockRejectedValue(new Error("quota exceeded"));
    const m = new CloudSaveManager();
    await m.connect(provider);

    const states = [makeEntry({ slot: 1 })];
    const fakeLib = { getStatesForGame: vi.fn().mockResolvedValue(states) };
    const result = await m.syncGame("game-1", fakeLib);

    expect(result.errors).toBeGreaterThan(0);
  });

  it("persists pulled remote entries locally when saveState() is available", async () => {
    const provider = makeMockProvider(true);
    const remoteEntry = makeEntry({ slot: 1, timestamp: 2_000_000 });
    provider.download.mockImplementation(async (_gameId: string, slot: number) =>
      slot === 1 ? remoteEntry : null
    );

    const m = new CloudSaveManager();
    await m.connect(provider);

    const fakeLib = {
      getStatesForGame: vi.fn().mockResolvedValue([]),
      saveState: vi.fn().mockResolvedValue(undefined),
    };

    const result = await m.syncGame("game-1", fakeLib);

    expect(result.pushed).toBe(0);
    expect(result.pulled).toBe(1);
    expect(result.errors).toBe(0);
    expect(fakeLib.saveState).toHaveBeenCalledWith(remoteEntry);
  });
});

describe("CloudSaveManager — settings persistence", () => {
  beforeEach(() => localStorage.clear());

  it("persists autoSyncEnabled via setAutoSync()", () => {
    const m = new CloudSaveManager();
    m.setAutoSync(true);
    const m2 = new CloudSaveManager();
    expect(m2.autoSyncEnabled).toBe(true);
  });

  it("persists conflictResolution via setConflictResolution()", () => {
    const m = new CloudSaveManager();
    m.setConflictResolution("local");
    const m2 = new CloudSaveManager();
    expect(m2.conflictResolution).toBe("local");
  });

  it("saveWebDAVConfig / loadWebDAVConfig round-trip", () => {
    const m = new CloudSaveManager();
    m.saveWebDAVConfig("https://dav.example.com", "alice", "s3cr3t");
    const cfg = m.loadWebDAVConfig();
    expect(cfg?.url).toBe("https://dav.example.com");
    expect(cfg?.username).toBe("alice");
    expect(cfg?.password).toBe("s3cr3t");
  });

  it("clearWebDAVConfig removes stored credentials", () => {
    const m = new CloudSaveManager();
    m.saveWebDAVConfig("https://dav.example.com", "alice", "pass");
    m.clearWebDAVConfig();
    expect(m.loadWebDAVConfig()).toBeNull();
  });
});

// ── GoogleDriveProvider ───────────────────────────────────────────────────────

describe("GoogleDriveProvider — construction", () => {
  it("has providerId 'gdrive' and a non-empty displayName", () => {
    const p = new GoogleDriveProvider("fake-token");
    expect(p.providerId).toBe("gdrive");
    expect(p.displayName.length).toBeGreaterThan(0);
  });
});

describe("GoogleDriveProvider — isAvailable", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns true when /about responds with 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true }));
    const p = new GoogleDriveProvider("tok");
    expect(await p.isAvailable()).toBe(true);
  });

  it("returns false when the server returns a non-200 status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401, ok: false }));
    const p = new GoogleDriveProvider("tok");
    expect(await p.isAvailable()).toBe(false);
  });

  it("returns false when fetch throws (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const p = new GoogleDriveProvider("tok");
    expect(await p.isAvailable()).toBe(false);
  });
});

describe("GoogleDriveProvider — upload", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("creates files via multipart POST when no existing file is found", async () => {
    const mockFetch = vi.fn()
      // _findFileId calls for state.bin, thumb.jpg, manifest.json
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ files: [] }) }) // state.bin search
      .mockResolvedValueOnce({ ok: true, status: 200 }) // state.bin upload (POST multipart)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ files: [] }) }) // thumb.jpg search
      .mockResolvedValueOnce({ ok: true, status: 200 }) // thumb.jpg upload
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ files: [] }) }) // manifest.json search
      .mockResolvedValueOnce({ ok: true, status: 200 }); // manifest.json upload

    vi.stubGlobal("fetch", mockFetch);

    const entry = makeEntry({ gameId: "g1", slot: 1, stateData: new Blob(["state"]), thumbnail: new Blob(["img"]) });
    const p = new GoogleDriveProvider("tok");
    await p.upload(entry);

    const urls: string[] = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(urls.some(u => u.includes("?uploadType=multipart"))).toBe(true);
    // The upload endpoint does NOT include the filename in the URL path (it's in the body)
    expect(urls.filter(u => u.includes("?uploadType=multipart"))).toHaveLength(3);
  });

  it("updates existing files via PATCH when file already exists", async () => {
    const mockFetch = vi.fn()
      // state.bin and thumb.jpg _findFileId calls run in parallel
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ files: [{ id: "id-state" }] }) })   // findFileId state.bin
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ files: [{ id: "id-thumb" }] }) })   // findFileId thumb.jpg (parallel)
      // then their PATCH calls run in parallel
      .mockResolvedValueOnce({ ok: true, status: 200 }) // PATCH state.bin
      .mockResolvedValueOnce({ ok: true, status: 200 }) // PATCH thumb.jpg (parallel)
      // then manifest
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ files: [{ id: "id-manifest" }] }) })
      .mockResolvedValueOnce({ ok: true, status: 200 }); // PATCH manifest.json

    vi.stubGlobal("fetch", mockFetch);

    const entry = makeEntry({ gameId: "g1", slot: 1, stateData: new Blob(["state"]), thumbnail: new Blob(["img"]) });
    const p = new GoogleDriveProvider("tok");
    await p.upload(entry);

    const methods: string[] = mockFetch.mock.calls.map((c: unknown[]) => (c[1] as { method: string }).method);
    expect(methods.filter(m => m === "PATCH")).toHaveLength(3);
  });

  it("throws when a file operation fails with a non-auth error", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ files: [] }) })
      .mockResolvedValueOnce({ ok: false, status: 500 }), // upload fails with server error
    );
    const entry = makeEntry({ stateData: new Blob(["x"]), thumbnail: null });
    const p = new GoogleDriveProvider("tok");
    await expect(p.upload(entry)).rejects.toThrow(/Google Drive upload failed/);
  });

  it("throws an auth error message when upload fails with 401", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ files: [] }) })
      .mockResolvedValueOnce({ ok: false, status: 401 }), // token expired
    );
    const entry = makeEntry({ stateData: new Blob(["x"]), thumbnail: null });
    const p = new GoogleDriveProvider("tok");
    await expect(p.upload(entry)).rejects.toThrow(/authentication failed/);
  });
});

describe("GoogleDriveProvider — download", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns null when manifest file is not found", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ files: [] }),
    }));
    const p = new GoogleDriveProvider("tok");
    expect(await p.download("game-1", 1)).toBeNull();
  });

  it("returns a SaveStateEntry when manifest and state exist", async () => {
    const manifest: CloudSaveManifest = makeManifest({ gameId: "game-1", slot: 1 });
    const mockFetch = vi.fn()
      // _findFileId(manifest.json) → found
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ files: [{ id: "manifest-id" }] }) })
      // download manifest content
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => manifest })
      // _findFileId(state.bin) and _findFileId(thumb.jpg) run in parallel
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ files: [{ id: "state-id" }] }) })   // state.bin found
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ files: [] }) })                     // thumb.jpg not found
      // download state content (parallel with thumb which resolves null immediately)
      .mockResolvedValueOnce({ ok: true, status: 200, blob: async () => new Blob(["state"]) });

    vi.stubGlobal("fetch", mockFetch);

    const p = new GoogleDriveProvider("tok");
    const result = await p.download("game-1", 1);

    expect(result).not.toBeNull();
    expect(result!.gameId).toBe("game-1");
    expect(result!.slot).toBe(1);
    expect(result!.stateData).not.toBeNull();
    expect(result!.thumbnail).toBeNull();
  });
});

describe("GoogleDriveProvider — delete", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("sends DELETE for each file that exists", async () => {
    const mockFetch = vi.fn()
      // _findFileId for manifest, state, thumb
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ files: [{ id: "mid" }] }) })
      .mockResolvedValueOnce({ ok: true, status: 200 }) // DELETE manifest
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ files: [{ id: "sid" }] }) })
      .mockResolvedValueOnce({ ok: true, status: 200 }) // DELETE state
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ files: [] }) }); // thumb not found

    vi.stubGlobal("fetch", mockFetch);

    const p = new GoogleDriveProvider("tok");
    await p.delete("game-1", 1);

    const methods: string[] = mockFetch.mock.calls.map((c: unknown[]) => (c[1] as { method?: string }).method ?? "GET");
    expect(methods.filter(m => m === "DELETE")).toHaveLength(2);
  });

  it("resolves even when DELETE requests fail (allSettled semantics)", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ files: [{ id: "x" }] }) }),
    );
    // override to make actual DELETE fail
    const inner = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ files: [{ id: "x" }] }) })
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ files: [] }) });
    vi.stubGlobal("fetch", inner);

    const p = new GoogleDriveProvider("tok");
    await expect(p.delete("game-1", 1)).resolves.toBeUndefined();
  });
});

// ── DropboxProvider ───────────────────────────────────────────────────────────

describe("DropboxProvider — construction", () => {
  it("has providerId 'dropbox' and a non-empty displayName", () => {
    const p = new DropboxProvider("fake-token");
    expect(p.providerId).toBe("dropbox");
    expect(p.displayName.length).toBeGreaterThan(0);
  });
});

describe("DropboxProvider — isAvailable", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns true when get_current_account responds with 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true }));
    const p = new DropboxProvider("tok");
    expect(await p.isAvailable()).toBe(true);
  });

  it("returns false when status is 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401, ok: false }));
    const p = new DropboxProvider("tok");
    expect(await p.isAvailable()).toBe(false);
  });

  it("returns false when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const p = new DropboxProvider("tok");
    expect(await p.isAvailable()).toBe(false);
  });
});

describe("DropboxProvider — upload", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("sends upload POST requests for state.bin, thumb.jpg, and manifest.json", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", mockFetch);

    const entry = makeEntry({ gameId: "g1", slot: 1, stateData: new Blob(["state"]), thumbnail: new Blob(["img"]) });
    const p = new DropboxProvider("tok");
    await p.upload(entry);

    const headers: Record<string, string>[] = mockFetch.mock.calls.map(
      (c: unknown[]) => (c[1] as { headers: Record<string, string> }).headers,
    );
    const args = headers.map(h => h["Dropbox-API-Arg"] ?? "").filter(Boolean);
    expect(args.some(a => a.includes("state.bin"))).toBe(true);
    expect(args.some(a => a.includes("thumb.jpg"))).toBe(true);
    expect(args.some(a => a.includes("manifest.json"))).toBe(true);
  });

  it("throws when an upload request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const entry = makeEntry({ stateData: new Blob(["x"]), thumbnail: null });
    const p = new DropboxProvider("tok");
    await expect(p.upload(entry)).rejects.toThrow(/Dropbox upload failed/);
  });
});

describe("DropboxProvider — download", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns null when manifest download returns non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    const p = new DropboxProvider("tok");
    expect(await p.download("game-1", 1)).toBeNull();
  });

  it("returns a SaveStateEntry when manifest and state download succeed", async () => {
    const manifest: CloudSaveManifest = makeManifest({ gameId: "game-1", slot: 1 });
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, blob: async () => new Blob([JSON.stringify(manifest)]) }) // manifest
      .mockResolvedValueOnce({ ok: true, status: 200, blob: async () => new Blob(["state"]) })  // state
      .mockResolvedValueOnce({ ok: false, status: 409 }); // no thumbnail

    vi.stubGlobal("fetch", mockFetch);

    const p = new DropboxProvider("tok");
    const result = await p.download("game-1", 1);

    expect(result).not.toBeNull();
    expect(result!.gameId).toBe("game-1");
    expect(result!.slot).toBe(1);
    expect(result!.stateData).not.toBeNull();
    expect(result!.thumbnail).toBeNull();
  });
});

describe("DropboxProvider — delete", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("sends DELETE requests for all three files via allSettled", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", mockFetch);

    const p = new DropboxProvider("tok");
    await p.delete("game-1", 1);

    // 3 delete_v2 POST calls
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("resolves even when individual delete requests fail (allSettled semantics)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    const p = new DropboxProvider("tok");
    await expect(p.delete("game-1", 1)).resolves.toBeUndefined();
  });
});

// ── CloudSaveManager — new provider credential helpers ─────────────────────────

describe("CloudSaveManager — Google Drive credential storage", () => {
  beforeEach(() => localStorage.clear());

  it("saveGDriveConfig / loadGDriveConfig round-trip", () => {
    const m = new CloudSaveManager();
    m.saveGDriveConfig("ya29.test-token");
    const cfg = m.loadGDriveConfig();
    expect(cfg?.accessToken).toBe("ya29.test-token");
  });

  it("clearGDriveConfig removes stored token", () => {
    const m = new CloudSaveManager();
    m.saveGDriveConfig("ya29.test-token");
    m.clearGDriveConfig();
    expect(m.loadGDriveConfig()).toBeNull();
  });
});

describe("CloudSaveManager — Dropbox credential storage", () => {
  beforeEach(() => localStorage.clear());

  it("saveDropboxConfig / loadDropboxConfig round-trip", () => {
    const m = new CloudSaveManager();
    m.saveDropboxConfig("sl.test-token");
    const cfg = m.loadDropboxConfig();
    expect(cfg?.accessToken).toBe("sl.test-token");
  });

  it("clearDropboxConfig removes stored token", () => {
    const m = new CloudSaveManager();
    m.saveDropboxConfig("sl.test-token");
    m.clearDropboxConfig();
    expect(m.loadDropboxConfig()).toBeNull();
  });
});

describe("CloudSaveManager — providerId includes gdrive and dropbox", () => {
  beforeEach(() => localStorage.clear());

  it("persists 'gdrive' providerId after connecting a GoogleDriveProvider", async () => {
    const mockProvider: CloudSaveProvider = {
      providerId:   "gdrive",
      displayName:  "Google Drive",
      isAvailable:  vi.fn().mockResolvedValue(true),
      upload:       vi.fn().mockResolvedValue(undefined),
      download:     vi.fn().mockResolvedValue(null),
      listManifests: vi.fn().mockResolvedValue([]),
      delete:       vi.fn().mockResolvedValue(undefined),
    };
    const m = new CloudSaveManager();
    await m.connect(mockProvider);
    expect(m.providerId).toBe("gdrive");

    // Persisted value should survive a fresh instance
    const m2 = new CloudSaveManager();
    expect(m2.providerId).toBe("gdrive");
  });

  it("persists 'dropbox' providerId after connecting a DropboxProvider", async () => {
    const mockProvider: CloudSaveProvider = {
      providerId:   "dropbox",
      displayName:  "Dropbox",
      isAvailable:  vi.fn().mockResolvedValue(true),
      upload:       vi.fn().mockResolvedValue(undefined),
      download:     vi.fn().mockResolvedValue(null),
      listManifests: vi.fn().mockResolvedValue([]),
      delete:       vi.fn().mockResolvedValue(undefined),
    };
    const m = new CloudSaveManager();
    await m.connect(mockProvider);
    expect(m.providerId).toBe("dropbox");

    const m2 = new CloudSaveManager();
    expect(m2.providerId).toBe("dropbox");
  });
});

// ── CloudSaveManager — early bail when disconnected ────────────────────────────

describe("CloudSaveManager — disconnected no-ops", () => {
  beforeEach(() => localStorage.clear());

  it("push() is a no-op and does not call provider when disconnected", async () => {
    const provider = makeMockProvider(true);
    const m = new CloudSaveManager();
    // Never connect — manager stays disconnected
    await m.push(makeEntry());
    expect(provider.upload).not.toHaveBeenCalled();
    expect(m.lastSyncAt).toBeNull();
  });

  it("pull() returns null immediately without calling provider when disconnected", async () => {
    const provider = makeMockProvider(true);
    const m = new CloudSaveManager();
    const result = await m.pull("game-1", 1);
    expect(result).toBeNull();
    expect(provider.download).not.toHaveBeenCalled();
    expect(m.lastSyncAt).toBeNull();
  });

  it("syncGame() returns zeros immediately without calling provider when disconnected", async () => {
    const provider = makeMockProvider(true);
    const m = new CloudSaveManager();
    const fakeLib = { getStatesForGame: vi.fn().mockResolvedValue([makeEntry()]) };
    const result = await m.syncGame("game-1", fakeLib);
    expect(result).toEqual({ pushed: 0, pulled: 0, errors: 0 });
    // Library should not even be queried when disconnected
    expect(fakeLib.getStatesForGame).not.toHaveBeenCalled();
    expect(provider.upload).not.toHaveBeenCalled();
  });
});

// ── Dropbox — auth error detection ────────────────────────────────────────────

describe("DropboxProvider — auth error surfacing", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("upload() throws an auth error message on 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const entry = makeEntry({ stateData: new Blob(["x"]), thumbnail: null });
    const p = new DropboxProvider("tok");
    await expect(p.upload(entry)).rejects.toThrow(/authentication failed/);
  });

  it("upload() throws an auth error message on 403", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    const entry = makeEntry({ stateData: new Blob(["x"]), thumbnail: null });
    const p = new DropboxProvider("tok");
    await expect(p.upload(entry)).rejects.toThrow(/authentication failed/);
  });

  it("download() propagates auth error instead of returning null on 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const p = new DropboxProvider("tok");
    await expect(p.download("game-1", 1)).rejects.toThrow(/authentication failed/);
  });

  it("download() returns null for non-auth non-ok responses (e.g. file not found)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    const p = new DropboxProvider("tok");
    expect(await p.download("game-1", 1)).toBeNull();
  });
});

// ── pCloudProvider ────────────────────────────────────────────────────────────

describe("pCloudProvider — construction", () => {
  it("has providerId 'pcloud' and a non-empty displayName", () => {
    const p = new pCloudProvider("fake-token");
    expect(p.providerId).toBe("pcloud");
    expect(p.displayName.length).toBeGreaterThan(0);
  });

  it("uses US API by default", () => {
    // The US API host is used when no region is specified.
    // We can't read the private field directly, but isAvailable() will hit it.
    const p = new pCloudProvider("tok");
    expect(p).toBeInstanceOf(pCloudProvider);
  });

  it("accepts 'eu' region without throwing", () => {
    const p = new pCloudProvider("tok", "eu");
    expect(p).toBeInstanceOf(pCloudProvider);
  });
});

describe("pCloudProvider — isAvailable", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns true when /userinfo responds with result:0", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ result: 0, email: "user@example.com" }),
    }));
    const p = new pCloudProvider("tok");
    expect(await p.isAvailable()).toBe(true);
  });

  it("returns false when /userinfo responds with non-zero result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ result: 2000 }),
    }));
    const p = new pCloudProvider("tok");
    expect(await p.isAvailable()).toBe(false);
  });

  it("returns false when status is 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const p = new pCloudProvider("tok");
    expect(await p.isAvailable()).toBe(false);
  });

  it("returns false when fetch throws (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const p = new pCloudProvider("tok");
    expect(await p.isAvailable()).toBe(false);
  });
});

describe("pCloudProvider — upload", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("sends POST requests for state.bin, thumb.jpg, and manifest.json", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", mockFetch);

    const entry = makeEntry({ gameId: "g1", slot: 1, stateData: new Blob(["state"]), thumbnail: new Blob(["img"]) });
    const p = new pCloudProvider("tok");
    await p.upload(entry);

    const urls: string[] = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(urls.some(u => u.includes("filename=state.bin"))).toBe(true);
    expect(urls.some(u => u.includes("filename=thumb.jpg"))).toBe(true);
    expect(urls.some(u => u.includes("filename=manifest.json"))).toBe(true);
  });

  it("throws when an upload request returns a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 503,
      json: async () => ({ result: -1 }),
    }));
    const entry = makeEntry({ stateData: new Blob(["x"]), thumbnail: null });
    const p = new pCloudProvider("tok");
    await expect(p.upload(entry)).rejects.toThrow(/pCloud upload failed/);
  });

  it("throws an auth error when result is 2000 (login required)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 200,
      json: async () => ({ result: 2000 }),
    }));
    const entry = makeEntry({ stateData: new Blob(["x"]), thumbnail: null });
    const p = new pCloudProvider("tok");
    await expect(p.upload(entry)).rejects.toThrow(/authentication failed/);
  });
});

describe("pCloudProvider — download", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns null when getfilelink returns result 2009 (file not found)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ result: 2009 }),
    }));
    const p = new pCloudProvider("tok");
    expect(await p.download("game-1", 1)).toBeNull();
  });

  it("returns null when the link request returns non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const p = new pCloudProvider("tok");
    expect(await p.download("game-1", 1)).toBeNull();
  });

  it("returns a SaveStateEntry when manifest and state download succeed", async () => {
    const manifest: CloudSaveManifest = makeManifest({ gameId: "game-1", slot: 1 });
    const mockFetch = vi.fn()
      // getfilelink for manifest.json — sequential, before parallel downloads start
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ result: 0, hosts: ["cdn.pcloud.com"], path: "/manifest.json" }),
      })
      // CDN download of manifest.json — sequential
      .mockResolvedValueOnce({ ok: true, status: 200, blob: async () => new Blob([JSON.stringify(manifest)]) })
      // getfilelink for state.bin — parallel with thumb getfilelink (started first)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ result: 0, hosts: ["cdn.pcloud.com"], path: "/state.bin" }),
      })
      // getfilelink for thumb.jpg — parallel (started second)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ result: 2009 }),
      })
      // CDN download of state.bin — after state getfilelink resolves
      .mockResolvedValueOnce({ ok: true, status: 200, blob: async () => new Blob(["state"]) });

    vi.stubGlobal("fetch", mockFetch);

    const p = new pCloudProvider("tok");
    const result = await p.download("game-1", 1);

    expect(result).not.toBeNull();
    expect(result!.gameId).toBe("game-1");
    expect(result!.slot).toBe(1);
    expect(result!.stateData).not.toBeNull();
    expect(result!.thumbnail).toBeNull();
  });

  it("throws auth error when getfilelink returns result 2000", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ result: 2000 }),
    }));
    const p = new pCloudProvider("tok");
    await expect(p.download("game-1", 1)).rejects.toThrow(/authentication failed/);
  });
});

describe("pCloudProvider — delete", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("sends GET deletefile requests for all three files via allSettled", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", mockFetch);

    const p = new pCloudProvider("tok");
    await p.delete("game-1", 1);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    const urls: string[] = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(urls.some(u => u.includes("deletefile"))).toBe(true);
  });

  it("resolves even when individual delete requests fail (allSettled semantics)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    const p = new pCloudProvider("tok");
    await expect(p.delete("game-1", 1)).resolves.toBeUndefined();
  });
});

describe("CloudSaveManager — pCloud credential storage", () => {
  beforeEach(() => localStorage.clear());

  it("savePCloudConfig / loadPCloudConfig round-trip (US region)", () => {
    const m = new CloudSaveManager();
    m.savePCloudConfig("pcloud-tok", "us");
    const cfg = m.loadPCloudConfig();
    expect(cfg?.accessToken).toBe("pcloud-tok");
    expect(cfg?.region).toBe("us");
  });

  it("savePCloudConfig / loadPCloudConfig round-trip (EU region)", () => {
    const m = new CloudSaveManager();
    m.savePCloudConfig("pcloud-eu-tok", "eu");
    const cfg = m.loadPCloudConfig();
    expect(cfg?.accessToken).toBe("pcloud-eu-tok");
    expect(cfg?.region).toBe("eu");
  });

  it("clearPCloudConfig removes stored token", () => {
    const m = new CloudSaveManager();
    m.savePCloudConfig("pcloud-tok", "us");
    m.clearPCloudConfig();
    expect(m.loadPCloudConfig()).toBeNull();
  });
});

describe("CloudSaveManager — persists pcloud providerId", () => {
  beforeEach(() => localStorage.clear());

  it("persists 'pcloud' providerId after connecting a pCloudProvider", async () => {
    const mockProvider: CloudSaveProvider = {
      providerId:    "pcloud",
      displayName:   "pCloud",
      isAvailable:   vi.fn().mockResolvedValue(true),
      upload:        vi.fn().mockResolvedValue(undefined),
      download:      vi.fn().mockResolvedValue(null),
      listManifests: vi.fn().mockResolvedValue([]),
      delete:        vi.fn().mockResolvedValue(undefined),
    };
    const m = new CloudSaveManager();
    await m.connect(mockProvider);
    expect(m.providerId).toBe("pcloud");

    // Persisted value should survive a fresh instance
    const m2 = new CloudSaveManager();
    expect(m2.providerId).toBe("pcloud");
  });
});

// ── GoogleDriveProvider — batch listManifests ─────────────────────────────────

describe("GoogleDriveProvider — listManifests (batch search)", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("uses a single prefix search and returns manifests for matching files", async () => {
    const manifest1 = makeManifest({ slot: 1 });
    const manifest2 = makeManifest({ slot: 2 });
    const mockFetch = vi.fn()
      // Single batch search returns two manifest files
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({
          files: [
            { id: "m1-id", name: "rv__game-1__1__manifest.json" },
            { id: "m2-id", name: "rv__game-1__2__manifest.json" },
          ],
        }),
      })
      // Download manifest 1
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => manifest1 })
      // Download manifest 2
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => manifest2 });

    vi.stubGlobal("fetch", mockFetch);

    const p = new GoogleDriveProvider("tok");
    const results = await p.listManifests("game-1");

    // Only 3 fetch calls: 1 batch search + 2 manifest downloads
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(2);
    expect(results.map(m => m.slot).sort()).toEqual([1, 2]);
  });

  it("returns empty array when no manifest files exist for the game", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ files: [] }),
    }));
    const p = new GoogleDriveProvider("tok");
    expect(await p.listManifests("game-1")).toEqual([]);
  });

  it("does not include files from a different game that shares a common prefix", async () => {
    // "game-1" and "game-10" share the prefix "rv__game-1__" — the suffix
    // check ("__manifest.json") combined with the full-name startsWith/endsWith
    // guards should prevent cross-game contamination.
    const manifest = makeManifest({ gameId: "game-1", slot: 1 });
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        files: [
          // Belongs to game-1
          { id: "m1", name: "rv__game-1__1__manifest.json" },
          // Belongs to game-10 — must NOT be included in game-1 results
          { id: "m10", name: "rv__game-10__1__manifest.json" },
        ],
      }),
    })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => manifest });

    vi.stubGlobal("fetch", mockFetch);

    const p = new GoogleDriveProvider("tok");
    const results = await p.listManifests("game-1");
    expect(results).toHaveLength(1);
    expect(results[0]!.gameId).toBe("game-1");
  });
});

// ── CloudSaveManager — sync badges ──────────────────────────────────────────

describe("CloudSaveManager — sync badges", () => {
  let manager: CloudSaveManager;

  beforeEach(() => {
    localStorage.clear();
    manager = new CloudSaveManager();
  });

  it("defaults to 'local-only' for untracked slots", () => {
    expect(manager.getSlotBadge("game-1", 1)).toBe("local-only");
  });

  it("setSlotBadge persists and fires onStatusChange", () => {
    const spy = vi.fn();
    manager.onStatusChange = spy;
    manager.setSlotBadge("game-1", 1, "synced");
    expect(manager.getSlotBadge("game-1", 1)).toBe("synced");
    expect(spy).toHaveBeenCalled();
  });

  it("tracks badges independently per game+slot", () => {
    manager.setSlotBadge("game-1", 1, "synced");
    manager.setSlotBadge("game-1", 2, "error");
    manager.setSlotBadge("game-2", 1, "syncing");
    expect(manager.getSlotBadge("game-1", 1)).toBe("synced");
    expect(manager.getSlotBadge("game-1", 2)).toBe("error");
    expect(manager.getSlotBadge("game-2", 1)).toBe("syncing");
  });
});

// ── CloudSaveManager — sync history ─────────────────────────────────────────

describe("CloudSaveManager — sync history", () => {
  let manager: CloudSaveManager;

  beforeEach(() => {
    localStorage.clear();
    manager = new CloudSaveManager();
  });

  it("starts with an empty history", () => {
    expect(manager.syncHistory).toHaveLength(0);
  });

  it("addHistoryEntry adds entries newest-first", () => {
    manager.addHistoryEntry("Pushed slot 1", true);
    manager.addHistoryEntry("Pull slot 2 failed", false);
    expect(manager.syncHistory).toHaveLength(2);
    expect(manager.syncHistory[0]!.action).toBe("Pull slot 2 failed");
    expect(manager.syncHistory[0]!.ok).toBe(false);
    expect(manager.syncHistory[1]!.action).toBe("Pushed slot 1");
    expect(manager.syncHistory[1]!.ok).toBe(true);
  });

  it("caps history at MAX_HISTORY entries", () => {
    for (let i = 0; i < CloudSaveManager.MAX_HISTORY + 5; i++) {
      manager.addHistoryEntry(`Action ${i}`, true);
    }
    expect(manager.syncHistory).toHaveLength(CloudSaveManager.MAX_HISTORY);
  });

  it("fires onStatusChange when history is added", () => {
    const spy = vi.fn();
    manager.onStatusChange = spy;
    manager.addHistoryEntry("test", true);
    expect(spy).toHaveBeenCalled();
  });

  it("addStatusListener notifies listeners and supports unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = manager.addStatusListener(listener);

    manager.setAutoSync(true);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    manager.setAutoSync(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ── CloudSaveManager — push/pull/sync track badges and history ──────────────

describe("CloudSaveManager — push records badge + history", () => {
  let manager: CloudSaveManager;

  beforeEach(async () => {
    localStorage.clear();
    manager = new CloudSaveManager();
    const provider = makeMockProvider(true);
    await manager.connect(provider);
  });

  it("push sets badge to synced and adds a history entry", async () => {
    const entry = makeEntry({ gameId: "g1", slot: 2 });
    await manager.push(entry);
    expect(manager.getSlotBadge("g1", 2)).toBe("synced");
    expect(manager.syncHistory.length).toBeGreaterThan(0);
    expect(manager.syncHistory[0]!.action).toContain("Pushed slot 2");
    expect(manager.syncHistory[0]!.ok).toBe(true);
  });

  it("push sets badge to error on failure", async () => {
    const failing = makeMockProvider(true);
    failing.upload.mockRejectedValueOnce(new Error("net down"));
    await manager.connect(failing);
    const entry = makeEntry({ gameId: "g1", slot: 3 });
    await expect(manager.push(entry)).rejects.toThrow("net down");
    expect(manager.getSlotBadge("g1", 3)).toBe("error");
    expect(manager.syncHistory[0]!.ok).toBe(false);
  });
});

// ── CloudSaveManager — onConflict callback ──────────────────────────────────

describe("CloudSaveManager — onConflict callback", () => {
  let manager: CloudSaveManager;
  let provider: ReturnType<typeof makeMockProvider>;

  beforeEach(async () => {
    localStorage.clear();
    manager = new CloudSaveManager();
    provider = makeMockProvider(true);
    await manager.connect(provider);
  });

  it("invokes onConflict when both local and remote exist and callback is set", async () => {
    const local  = makeEntry({ gameId: "g1", slot: 1, timestamp: 100 });
    const remote = makeEntry({ gameId: "g1", slot: 1, timestamp: 200 });
    provider.download.mockResolvedValueOnce(remote);
    // Fixed: remote is downloaded exactly once — no second round-trip.

    manager.onConflict = vi.fn().mockResolvedValue("local");

    const result = await manager.syncSlot("g1", 1, local);
    expect(manager.onConflict).toHaveBeenCalled();
    expect(provider.download).toHaveBeenCalledTimes(1);
    // With "local" resolution + both sides present, local should be pushed
    expect(result?.direction).toBe("pushed");
  });

  it("does NOT invoke onConflict when no remote exists", async () => {
    const local = makeEntry({ gameId: "g1", slot: 1, timestamp: 100 });
    provider.download.mockResolvedValueOnce(null);

    manager.onConflict = vi.fn().mockResolvedValue("newest");

    const result = await manager.syncSlot("g1", 1, local);
    expect(manager.onConflict).not.toHaveBeenCalled();
    expect(provider.download).toHaveBeenCalledTimes(1);
    expect(result?.direction).toBe("pushed");
  });

  it("syncSlot() returns null immediately when disconnected without calling the provider", async () => {
    manager.disconnect();
    const result = await manager.syncSlot("g1", 1, makeEntry());
    expect(result).toBeNull();
    expect(provider.download).not.toHaveBeenCalled();
    expect(provider.upload).not.toHaveBeenCalled();
  });

  it("syncGame adds a summary history entry", async () => {
    const lib = {
      getStatesForGame: vi.fn().mockResolvedValue([]),
      saveState: vi.fn(),
    };
    await manager.syncGame("g1", lib);
    expect(manager.syncHistory.some(e => e.action.includes("Sync game"))).toBe(true);
  });
});

// ── BlompProvider ─────────────────────────────────────────────────────────────

describe("BlompProvider — construction", () => {
  it("has providerId 'blomp' and a non-empty displayName", () => {
    const p = new BlompProvider("user@example.com", "secret");
    expect(p.providerId).toBe("blomp");
    expect(p.displayName.length).toBeGreaterThan(0);
  });

  it("accepts a custom container name without throwing", () => {
    const p = new BlompProvider("user@example.com", "secret", "my-games");
    expect(p).toBeInstanceOf(BlompProvider);
  });
});

describe("BlompProvider — isAvailable", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns true and caches token when auth endpoint responds with 200 + auth headers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        "X-Auth-Token":   "tok-abc",
        "X-Storage-Url":  "https://storage.blomp.com/v1/AUTH_123",
      }),
    }));
    const p = new BlompProvider("user", "pass");
    expect(await p.isAvailable()).toBe(true);
  });

  it("returns false when the server returns a non-200 status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, headers: new Headers() }));
    const p = new BlompProvider("user", "pass");
    expect(await p.isAvailable()).toBe(false);
  });

  it("returns false when the auth headers are absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers(),  // no X-Auth-Token / X-Storage-Url
    }));
    const p = new BlompProvider("user", "pass");
    expect(await p.isAvailable()).toBe(false);
  });

  it("returns false when fetch throws (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const p = new BlompProvider("user", "pass");
    expect(await p.isAvailable()).toBe(false);
  });
});

describe("BlompProvider — upload", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function authResponse() {
    return {
      ok: true, status: 200,
      headers: new Headers({
        "X-Auth-Token":  "tok-abc",
        "X-Storage-Url": "https://storage.blomp.com/v1/AUTH_123",
      }),
    };
  }

  it("sends PUT requests for state.bin, thumb.jpg, and manifest.json", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(authResponse()) // isAvailable / _ensureAuth
      .mockResolvedValue({ ok: true, status: 201 }); // PUT calls

    vi.stubGlobal("fetch", mockFetch);

    const entry = makeEntry({ gameId: "g1", slot: 1, stateData: new Blob(["state"]), thumbnail: new Blob(["img"]) });
    const p = new BlompProvider("user", "pass");
    await p.upload(entry);

    const methods: string[] = mockFetch.mock.calls
      .slice(1) // skip auth call
      .map((c: unknown[]) => (c[1] as { method?: string }).method ?? "GET");
    const urls: string[] = mockFetch.mock.calls
      .slice(1)
      .map((c: unknown[]) => c[0] as string);

    expect(methods.every(m => m === "PUT")).toBe(true);
    expect(urls.some(u => u.includes("state.bin"))).toBe(true);
    expect(urls.some(u => u.includes("thumb.jpg"))).toBe(true);
    expect(urls.some(u => u.includes("manifest.json"))).toBe(true);
  });

  it("throws when a PUT request fails with a non-auth error", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(authResponse())
      .mockResolvedValue({ ok: false, status: 500 });

    vi.stubGlobal("fetch", mockFetch);

    const entry = makeEntry({ stateData: new Blob(["x"]), thumbnail: null });
    const p = new BlompProvider("user", "pass");
    await expect(p.upload(entry)).rejects.toThrow(/Blomp upload failed/);
  });

  it("throws an auth error and clears the cached token on 401", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(authResponse())
      .mockResolvedValue({ ok: false, status: 401 });

    vi.stubGlobal("fetch", mockFetch);

    const entry = makeEntry({ stateData: new Blob(["x"]), thumbnail: null });
    const p = new BlompProvider("user", "pass");
    await expect(p.upload(entry)).rejects.toThrow(/authentication failed/);
  });
});

describe("BlompProvider — download", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function authResponse() {
    return {
      ok: true, status: 200,
      headers: new Headers({
        "X-Auth-Token":  "tok-abc",
        "X-Storage-Url": "https://storage.blomp.com/v1/AUTH_123",
      }),
    };
  }

  it("returns null when manifest.json is not found (404)", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(authResponse())
      .mockResolvedValue({ ok: false, status: 404 });

    vi.stubGlobal("fetch", mockFetch);

    const p = new BlompProvider("user", "pass");
    expect(await p.download("game-1", 1)).toBeNull();
  });

  it("returns a SaveStateEntry when manifest and state exist", async () => {
    const manifest: CloudSaveManifest = makeManifest({ gameId: "game-1", slot: 1 });
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(authResponse())                                                                          // _ensureAuth
      .mockResolvedValueOnce({ ok: true, status: 200, blob: async () => new Blob([JSON.stringify(manifest)]) })      // manifest.json
      .mockResolvedValueOnce({ ok: true, status: 200, blob: async () => new Blob(["state"]) })                       // state.bin
      .mockResolvedValueOnce({ ok: false, status: 404 });                                                            // thumb.jpg not found

    vi.stubGlobal("fetch", mockFetch);

    const p = new BlompProvider("user", "pass");
    const result = await p.download("game-1", 1);

    expect(result).not.toBeNull();
    expect(result!.gameId).toBe("game-1");
    expect(result!.slot).toBe(1);
    expect(result!.stateData).not.toBeNull();
    expect(result!.thumbnail).toBeNull();
  });

  it("propagates auth error instead of returning null on 401 manifest response", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(authResponse())
      .mockResolvedValue({ ok: false, status: 401 });

    vi.stubGlobal("fetch", mockFetch);

    const p = new BlompProvider("user", "pass");
    await expect(p.download("game-1", 1)).rejects.toThrow(/authentication failed/);
  });
});

describe("BlompProvider — delete", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function authResponse() {
    return {
      ok: true, status: 200,
      headers: new Headers({
        "X-Auth-Token":  "tok-abc",
        "X-Storage-Url": "https://storage.blomp.com/v1/AUTH_123",
      }),
    };
  }

  it("sends DELETE requests for all three files via allSettled", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(authResponse())
      .mockResolvedValue({ ok: true, status: 204 });

    vi.stubGlobal("fetch", mockFetch);

    const p = new BlompProvider("user", "pass");
    await p.delete("game-1", 1);

    const methods: string[] = mockFetch.mock.calls
      .slice(1)
      .map((c: unknown[]) => (c[1] as { method?: string }).method ?? "GET");
    expect(methods.filter(m => m === "DELETE")).toHaveLength(3);
  });

  it("resolves even when individual DELETE requests fail (allSettled semantics)", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(authResponse())
      .mockResolvedValue({ ok: false, status: 403 });

    vi.stubGlobal("fetch", mockFetch);

    const p = new BlompProvider("user", "pass");
    await expect(p.delete("game-1", 1)).resolves.toBeUndefined();
  });
});

describe("CloudSaveManager — Blomp credential storage", () => {
  beforeEach(() => localStorage.clear());

  it("saveBlompConfig / loadBlompConfig round-trip", () => {
    const m = new CloudSaveManager();
    m.saveBlompConfig("alice@example.com", "s3cr3t", "my-games");
    const cfg = m.loadBlompConfig();
    expect(cfg?.username).toBe("alice@example.com");
    expect(cfg?.password).toBe("s3cr3t");
    expect(cfg?.container).toBe("my-games");
  });

  it("loadBlompConfig uses default container when not stored", () => {
    const m = new CloudSaveManager();
    m.saveBlompConfig("user", "pass");
    const cfg = m.loadBlompConfig();
    expect(cfg?.container).toBe("retrovault");
  });

  it("clearBlompConfig removes stored credentials", () => {
    const m = new CloudSaveManager();
    m.saveBlompConfig("user", "pass");
    m.clearBlompConfig();
    expect(m.loadBlompConfig()).toBeNull();
  });
});

describe("CloudSaveManager — persists blomp providerId", () => {
  beforeEach(() => localStorage.clear());

  it("persists 'blomp' providerId after connecting a BlompProvider", async () => {
    const mockProvider: CloudSaveProvider = {
      providerId:    "blomp",
      displayName:   "Blomp",
      isAvailable:   vi.fn().mockResolvedValue(true),
      upload:        vi.fn().mockResolvedValue(undefined),
      download:      vi.fn().mockResolvedValue(null),
      listManifests: vi.fn().mockResolvedValue([]),
      delete:        vi.fn().mockResolvedValue(undefined),
    };
    const m = new CloudSaveManager();
    await m.connect(mockProvider);
    expect(m.providerId).toBe("blomp");

    const m2 = new CloudSaveManager();
    expect(m2.providerId).toBe("blomp");
  });
});

// ── BoxProvider ───────────────────────────────────────────────────────────────

describe("BoxProvider — construction", () => {
  it("has providerId 'box' and a non-empty displayName", () => {
    const p = new BoxProvider("fake-token");
    expect(p.providerId).toBe("box");
    expect(p.displayName.length).toBeGreaterThan(0);
  });

  it("accepts a custom rootFolderId without throwing", () => {
    const p = new BoxProvider("tok", "12345");
    expect(p).toBeInstanceOf(BoxProvider);
  });
});

describe("BoxProvider — isAvailable", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns true when /users/me responds with 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true }));
    const p = new BoxProvider("tok");
    expect(await p.isAvailable()).toBe(true);
  });

  it("returns false when status is 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401, ok: false }));
    const p = new BoxProvider("tok");
    expect(await p.isAvailable()).toBe(false);
  });

  it("returns false when fetch throws (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const p = new BoxProvider("tok");
    expect(await p.isAvailable()).toBe(false);
  });
});

describe("BoxProvider — upload", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("creates files when none exist (no existing file ID)", async () => {
    // state.bin and thumb.jpg _findFileId calls run in parallel, so both
    // listing responses come before either upload response.
    const mockFetch = vi.fn()
      // folder listing for state.bin → not found
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ entries: [] }) })
      // folder listing for thumb.jpg → not found (parallel with above)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ entries: [] }) })
      // upload state.bin
      .mockResolvedValueOnce({ ok: true, status: 201 })
      // upload thumb.jpg
      .mockResolvedValueOnce({ ok: true, status: 201 })
      // folder listing for manifest.json → not found (sequential)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ entries: [] }) })
      // upload manifest.json
      .mockResolvedValueOnce({ ok: true, status: 201 });

    vi.stubGlobal("fetch", mockFetch);

    const entry = makeEntry({ gameId: "g1", slot: 1, stateData: new Blob(["state"]), thumbnail: new Blob(["img"]) });
    const p = new BoxProvider("tok");
    await p.upload(entry);

    const urls: string[] = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(urls.some(u => u.includes("/files/content"))).toBe(true);
  });

  it("updates existing files via versioned upload URL", async () => {
    // state.bin and thumb.jpg _findFileId calls run in parallel — both listings
    // are consumed before either upload response.
    const mockFetch = vi.fn()
      // folder listing for state.bin → found
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ entries: [{ id: "sid", name: "rv__g1__1__state.bin", type: "file" }] }) })
      // folder listing for thumb.jpg → not found (parallel)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ entries: [] }) })
      // update state.bin
      .mockResolvedValueOnce({ ok: true, status: 200 })
      // upload thumb.jpg (new)
      .mockResolvedValueOnce({ ok: true, status: 201 })
      // folder listing for manifest → found (sequential)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ entries: [{ id: "mid", name: "rv__g1__1__manifest.json", type: "file" }] }) })
      // update manifest.json
      .mockResolvedValueOnce({ ok: true, status: 200 });

    vi.stubGlobal("fetch", mockFetch);

    const entry = makeEntry({ gameId: "g1", slot: 1, stateData: new Blob(["state"]), thumbnail: new Blob(["img"]) });
    const p = new BoxProvider("tok");
    await p.upload(entry);

    const urls: string[] = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
    // Versioned upload URL contains the file ID
    expect(urls.some(u => u.includes("/files/sid/content"))).toBe(true);
    expect(urls.some(u => u.includes("/files/mid/content"))).toBe(true);
  });

  it("throws when an upload request fails", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ entries: [] }) }) // _findFileId
      .mockResolvedValueOnce({ ok: false, status: 500 }), // upload fails
    );
    const entry = makeEntry({ stateData: new Blob(["x"]), thumbnail: null });
    const p = new BoxProvider("tok");
    await expect(p.upload(entry)).rejects.toThrow(/Box upload failed/);
  });

  it("throws an auth error on 401 upload failure", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ entries: [] }) }) // _findFileId
      .mockResolvedValueOnce({ ok: false, status: 401 }), // upload fails
    );
    const entry = makeEntry({ stateData: new Blob(["x"]), thumbnail: null });
    const p = new BoxProvider("tok");
    await expect(p.upload(entry)).rejects.toThrow(/authentication failed/);
  });
});

describe("BoxProvider — download", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns null when manifest file is not found", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ entries: [] }),
    }));
    const p = new BoxProvider("tok");
    expect(await p.download("game-1", 1)).toBeNull();
  });

  it("returns a SaveStateEntry when manifest and state exist", async () => {
    const manifest: CloudSaveManifest = makeManifest({ gameId: "game-1", slot: 1 });
    const mockFetch = vi.fn()
      // _findFileId(manifest.json) → found
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ entries: [{ id: "mid", name: "rv__game-1__1__manifest.json", type: "file" }] }) })
      // download manifest
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => manifest })
      // _findFileId(state.bin) and _findFileId(thumb.jpg) in parallel
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ entries: [{ id: "sid", name: "rv__game-1__1__state.bin", type: "file" }] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ entries: [] }) })   // thumb not found
      // download state.bin
      .mockResolvedValueOnce({ ok: true, status: 200, blob: async () => new Blob(["state"]) });

    vi.stubGlobal("fetch", mockFetch);

    const p = new BoxProvider("tok");
    const result = await p.download("game-1", 1);

    expect(result).not.toBeNull();
    expect(result!.gameId).toBe("game-1");
    expect(result!.slot).toBe(1);
    expect(result!.stateData).not.toBeNull();
    expect(result!.thumbnail).toBeNull();
  });
});

describe("BoxProvider — delete", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("sends DELETE for each file that exists", async () => {
    // All three _findFileId calls run in parallel (Promise.allSettled), so all
    // three folder-listing responses are consumed before any DELETE call fires.
    const mockFetch = vi.fn()
      // folder listing 1 → manifest.json found
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ entries: [{ id: "mid", name: "rv__game-1__1__manifest.json", type: "file" }] }) })
      // folder listing 2 → state.bin found
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ entries: [{ id: "sid", name: "rv__game-1__1__state.bin", type: "file" }] }) })
      // folder listing 3 → thumb.jpg not found
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ entries: [] }) })
      // DELETE manifest.json
      .mockResolvedValueOnce({ ok: true, status: 204 })
      // DELETE state.bin
      .mockResolvedValueOnce({ ok: true, status: 204 });

    vi.stubGlobal("fetch", mockFetch);

    const p = new BoxProvider("tok");
    await p.delete("game-1", 1);

    const methods: string[] = mockFetch.mock.calls.map((c: unknown[]) => (c[1] as { method?: string }).method ?? "GET");
    expect(methods.filter(m => m === "DELETE")).toHaveLength(2);
  });

  it("resolves even when DELETE requests fail (allSettled semantics)", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ entries: [{ id: "x", name: "f", type: "file" }] }) }),
    );
    const inner = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ entries: [{ id: "x", name: "f", type: "file" }] }) })
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ entries: [] }) });
    vi.stubGlobal("fetch", inner);

    const p = new BoxProvider("tok");
    await expect(p.delete("game-1", 1)).resolves.toBeUndefined();
  });
});

describe("BoxProvider — listManifests (batch folder scan)", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("uses a single folder listing and returns manifests for matching files", async () => {
    const manifest1 = makeManifest({ slot: 1 });
    const manifest2 = makeManifest({ slot: 2 });
    const mockFetch = vi.fn()
      // Single folder listing
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({
          entries: [
            { id: "m1", name: "rv__game-1__1__manifest.json", type: "file" },
            { id: "m2", name: "rv__game-1__2__manifest.json", type: "file" },
            { id: "s1", name: "rv__game-1__1__state.bin",     type: "file" }, // should be ignored
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => manifest1 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => manifest2 });

    vi.stubGlobal("fetch", mockFetch);

    const p = new BoxProvider("tok");
    const results = await p.listManifests("game-1");

    // 3 fetch calls: 1 folder list + 2 manifest downloads
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(2);
    expect(results.map(m => m.slot).sort()).toEqual([1, 2]);
  });

  it("returns empty array when no manifest files exist", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ entries: [] }),
    }));
    const p = new BoxProvider("tok");
    expect(await p.listManifests("game-1")).toEqual([]);
  });
});

describe("CloudSaveManager — Box credential storage", () => {
  beforeEach(() => localStorage.clear());

  it("saveBoxConfig / loadBoxConfig round-trip", () => {
    const m = new CloudSaveManager();
    m.saveBoxConfig("box-access-token", "98765");
    const cfg = m.loadBoxConfig();
    expect(cfg?.accessToken).toBe("box-access-token");
    expect(cfg?.rootFolderId).toBe("98765");
  });

  it("loadBoxConfig uses root folder '0' when not stored", () => {
    const m = new CloudSaveManager();
    m.saveBoxConfig("tok");
    const cfg = m.loadBoxConfig();
    expect(cfg?.rootFolderId).toBe("0");
  });

  it("clearBoxConfig removes stored credentials", () => {
    const m = new CloudSaveManager();
    m.saveBoxConfig("tok");
    m.clearBoxConfig();
    expect(m.loadBoxConfig()).toBeNull();
  });
});

describe("CloudSaveManager — persists box providerId", () => {
  beforeEach(() => localStorage.clear());

  it("persists 'box' providerId after connecting a BoxProvider", async () => {
    const mockProvider: CloudSaveProvider = {
      providerId:    "box",
      displayName:   "Box",
      isAvailable:   vi.fn().mockResolvedValue(true),
      upload:        vi.fn().mockResolvedValue(undefined),
      download:      vi.fn().mockResolvedValue(null),
      listManifests: vi.fn().mockResolvedValue([]),
      delete:        vi.fn().mockResolvedValue(undefined),
    };
    const m = new CloudSaveManager();
    await m.connect(mockProvider);
    expect(m.providerId).toBe("box");

    const m2 = new CloudSaveManager();
    expect(m2.providerId).toBe("box");
  });
});

// ── OneDriveProvider tests ────────────────────────────────────────────────────

describe("OneDriveProvider — construction", () => {
  it("has providerId 'onedrive' and a non-empty displayName", () => {
    const p = new OneDriveProvider("test-token");
    expect(p.providerId).toBe("onedrive");
    expect(p.displayName.length).toBeGreaterThan(0);
  });

  it("accepts a custom rootId without throwing", () => {
    const p = new OneDriveProvider("test-token", "folder-123");
    expect(p).toBeInstanceOf(OneDriveProvider);
  });
});

describe("OneDriveProvider — isAvailable", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns true when /me/drive responds with 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    const p = new OneDriveProvider("tok");
    expect(await p.isAvailable()).toBe(true);
  });

  it("returns false when status is 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401 }));
    const p = new OneDriveProvider("tok");
    expect(await p.isAvailable()).toBe(false);
  });

  it("returns false when fetch throws (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const p = new OneDriveProvider("tok");
    expect(await p.isAvailable()).toBe(false);
  });
});

describe("OneDriveProvider — upload", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("sends PUT requests for state.bin, thumb.jpg, and manifest.json", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", mockFetch);

    const p = new OneDriveProvider("tok");
    await p.upload(makeEntry({ stateData: new Blob(["st"]), thumbnail: new Blob(["th"]) }));

    // Should have 3 calls: state.bin, thumb.jpg, manifest.json
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const urls = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(urls.some((u: string) => u.includes("state.bin"))).toBe(true);
    expect(urls.some((u: string) => u.includes("thumb.jpg"))).toBe(true);
    expect(urls.some((u: string) => u.includes("manifest.json"))).toBe(true);
  });

  it("throws an auth error on 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const p = new OneDriveProvider("tok");
    await expect(p.upload(makeEntry())).rejects.toThrow(/authentication failed/);
  });
});

describe("OneDriveProvider — download", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns null when manifest.json is not found (404)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const p = new OneDriveProvider("tok");
    expect(await p.download("g1", 1)).toBeNull();
  });

  it("returns a SaveStateEntry when manifest and state exist", async () => {
    const manifest = makeManifest({ gameId: "g1", slot: 1 });
    const manifestBlob = new Blob([JSON.stringify(manifest)], { type: "application/json" });
    const stateBlob = new Blob(["state-data"]);

    vi.stubGlobal("fetch", vi.fn()
      // manifest download
      .mockResolvedValueOnce({ ok: true, status: 200, blob: () => Promise.resolve(manifestBlob) })
      // state.bin download
      .mockResolvedValueOnce({ ok: true, status: 200, blob: () => Promise.resolve(stateBlob) })
      // thumb.jpg — missing
      .mockResolvedValueOnce({ ok: false, status: 404 }),
    );

    const p = new OneDriveProvider("tok");
    const result = await p.download("g1", 1);
    expect(result).not.toBeNull();
    expect(result!.gameId).toBe("g1");
    expect(result!.slot).toBe(1);
    expect(result!.stateData).toBe(stateBlob);
    expect(result!.thumbnail).toBeNull();
  });

  it("propagates auth error on 401 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const p = new OneDriveProvider("tok");
    await expect(p.download("g1", 1)).rejects.toThrow(/authentication failed/);
  });
});

describe("OneDriveProvider — delete", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("sends DELETE requests for all three files via allSettled", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", mockFetch);

    const p = new OneDriveProvider("tok");
    await p.delete("g1", 1);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    const methods = mockFetch.mock.calls.map((c: unknown[]) => (c[1] as RequestInit).method);
    expect(methods.every((m: string | undefined) => m === "DELETE")).toBe(true);
  });

  it("resolves even when individual DELETE requests fail (allSettled semantics)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fail")));
    const p = new OneDriveProvider("tok");
    // Should not throw.
    await expect(p.delete("g1", 1)).resolves.toBeUndefined();
  });
});

describe("OneDriveProvider — listManifests", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns manifests for slots that have them", async () => {
    const manifest = makeManifest({ gameId: "g1", slot: 1 });
    const manifestBlob = new Blob([JSON.stringify(manifest)], { type: "application/json" });

    vi.stubGlobal("fetch", vi.fn()
      // slot 0 — missing
      .mockResolvedValueOnce({ ok: false, status: 404 })
      // slot 1 — exists
      .mockResolvedValueOnce({ ok: true, status: 200, blob: () => Promise.resolve(manifestBlob) })
      // slots 2-8 — missing
      .mockResolvedValue({ ok: false, status: 404 }),
    );

    const p = new OneDriveProvider("tok");
    const manifests = await p.listManifests("g1");
    expect(manifests.length).toBe(1);
    expect(manifests[0]!.slot).toBe(1);
  });
});

describe("CloudSaveManager — OneDrive credential storage", () => {
  beforeEach(() => localStorage.clear());

  it("saveOneDriveConfig / loadOneDriveConfig round-trip", () => {
    const m = new CloudSaveManager();
    m.saveOneDriveConfig("my-token", "folder-abc");
    const cfg = m.loadOneDriveConfig();
    expect(cfg).toEqual({ accessToken: "my-token", rootId: "folder-abc" });
  });

  it("loadOneDriveConfig uses default rootId 'root' when not stored", () => {
    const m = new CloudSaveManager();
    m.saveOneDriveConfig("tok");
    expect(m.loadOneDriveConfig()!.rootId).toBe("root");
  });

  it("clearOneDriveConfig removes stored credentials", () => {
    const m = new CloudSaveManager();
    m.saveOneDriveConfig("tok");
    m.clearOneDriveConfig();
    expect(m.loadOneDriveConfig()).toBeNull();
  });
});

describe("CloudSaveManager — persists onedrive providerId", () => {
  beforeEach(() => localStorage.clear());

  it("persists 'onedrive' providerId after connecting an OneDriveProvider", async () => {
    const mockProvider: CloudSaveProvider = {
      providerId:    "onedrive",
      displayName:   "OneDrive",
      isAvailable:   vi.fn().mockResolvedValue(true),
      upload:        vi.fn().mockResolvedValue(undefined),
      download:      vi.fn().mockResolvedValue(null),
      listManifests: vi.fn().mockResolvedValue([]),
      delete:        vi.fn().mockResolvedValue(undefined),
    };
    const m = new CloudSaveManager();
    await m.connect(mockProvider);
    expect(m.providerId).toBe("onedrive");

    const m2 = new CloudSaveManager();
    expect(m2.providerId).toBe("onedrive");
  });
});

// ── MegaProvider tests ────────────────────────────────────────────────────────

describe("MegaProvider — construction", () => {
  it("has providerId 'mega' and a non-empty displayName", () => {
    const p = new MegaProvider("user@mega.nz", "password123");
    expect(p.providerId).toBe("mega");
    expect(p.displayName.length).toBeGreaterThan(0);
  });
});

describe("MegaProvider — isAvailable", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns false when login fails (API returns error number)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([-9]),
    }));
    const p = new MegaProvider("user@mega.nz", "wrong");
    expect(await p.isAvailable()).toBe(false);
  });

  it("returns false when fetch throws (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const p = new MegaProvider("user@mega.nz", "pass");
    expect(await p.isAvailable()).toBe(false);
  });
});

describe("MegaProvider — delete", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("is a no-op when slot folder is not found", async () => {
    // Login succeeds, then folder listing returns no matching folder.
    const loginResp = { tsid: "session123", k: "AAAAAAAAAAAAAAAAAAAAAA" };
    const nodesResp = { f: [{ h: "rootH", t: 2, p: "", a: "", k: "" }] };

    const mockFetch = vi.fn()
      // login
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve([loginResp]) })
      // fetch nodes for root
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve([nodesResp]) })
      // delete -> findSlotFolder -> fetch nodes (no matching children)
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve([nodesResp]) });

    vi.stubGlobal("fetch", mockFetch);

    const p = new MegaProvider("user@mega.nz", "pass");
    // First ensure session is established
    try { await p.isAvailable(); } catch { /* ignore */ }
    // delete should be a no-op when folder not found
    await expect(p.delete("game1", 1)).resolves.toBeUndefined();
  });
});

describe("CloudSaveManager — MEGA credential storage", () => {
  beforeEach(() => localStorage.clear());

  it("saveMegaConfig / loadMegaConfig round-trip", () => {
    const m = new CloudSaveManager();
    m.saveMegaConfig("user@mega.nz", "secret123");
    const cfg = m.loadMegaConfig();
    expect(cfg).toEqual({ email: "user@mega.nz", password: "secret123" });
  });

  it("loadMegaConfig returns null when not set", () => {
    const m = new CloudSaveManager();
    expect(m.loadMegaConfig()).toBeNull();
  });

  it("clearMegaConfig removes stored credentials", () => {
    const m = new CloudSaveManager();
    m.saveMegaConfig("user@mega.nz", "secret");
    m.clearMegaConfig();
    expect(m.loadMegaConfig()).toBeNull();
  });
});

describe("CloudSaveManager — persists mega providerId", () => {
  beforeEach(() => localStorage.clear());

  it("persists 'mega' providerId after connecting a MegaProvider", async () => {
    const mockProvider: CloudSaveProvider = {
      providerId:    "mega",
      displayName:   "MEGA",
      isAvailable:   vi.fn().mockResolvedValue(true),
      upload:        vi.fn().mockResolvedValue(undefined),
      download:      vi.fn().mockResolvedValue(null),
      listManifests: vi.fn().mockResolvedValue([]),
      delete:        vi.fn().mockResolvedValue(undefined),
    };
    const m = new CloudSaveManager();
    await m.connect(mockProvider);
    expect(m.providerId).toBe("mega");

    const m2 = new CloudSaveManager();
    expect(m2.providerId).toBe("mega");
  });
});
