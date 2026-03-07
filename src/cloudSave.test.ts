import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  NullCloudProvider,
  CloudSaveSync,
  WebDAVProvider,
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
    expect(results[0].slot).toBe(2);
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
