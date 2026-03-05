import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  NullCloudProvider,
  CloudSaveSync,
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
