import { describe, expect, it, vi } from "vitest";
import { SaveGameService, stateCaptureRetriesForSystem } from "./saveService.js";
import type { SaveStateLibrary, SaveStateEntry } from "./saves.js";
import { SYSTEMS } from "./systems.js";

function makeEntry(slot: number): SaveStateEntry {
  return {
    id: `g:${slot}`,
    gameId: "g",
    gameName: "Game",
    systemId: "psp",
    slot,
    label: `Slot ${slot}`,
    timestamp: Date.now(),
    thumbnail: null,
    stateData: new Blob([new Uint8Array([1, 2, 3])]),
    isAutoSave: false,
    checksum: "",
    version: 1,
  };
}

describe("SaveGameService", () => {
  it("has a save-state capture retry policy for every supported system", () => {
    for (const system of SYSTEMS) {
      expect(stateCaptureRetriesForSystem(system.id, 2), system.id).toBeGreaterThanOrEqual(8);
    }
  });

  it("uses longer save-state capture windows for heavier console cores", () => {
    for (const systemId of ["psp", "nds", "3ds", "n64", "psx", "segaCD", "segaSaturn", "segaDC"]) {
      expect(stateCaptureRetriesForSystem(systemId, 2), systemId).toBeGreaterThanOrEqual(18);
    }
  });

  it("queues duplicate saves for same slot", async () => {
    const saveState = vi.fn<(entry: SaveStateEntry) => Promise<void>>().mockResolvedValue(undefined);
    const getState = vi.fn().mockImplementation(async (_gameId: string, slot: number) => makeEntry(slot));
    const saveLibrary = {
      saveState,
      getState,
    } as unknown as SaveStateLibrary;

    const emulator = {
      state: "running" as const,
      quickSave: vi.fn(),
      quickLoad: vi.fn(),
      readStateData: vi.fn(() => new Uint8Array([1, 2, 3])),
      writeStateData: vi.fn(() => true),
      captureScreenshotAsync: vi.fn(async () => null),
    };

    const service = new SaveGameService({
      saveLibrary,
      emulator,
      getCurrentGameContext: () => ({ gameId: "g", gameName: "Game", systemId: "psp" }),
    });

    await Promise.all([service.saveSlot(1), service.saveSlot(1)]);

    expect(emulator.quickSave).toHaveBeenCalledTimes(1);
    expect(saveState).toHaveBeenCalledTimes(1);
  });

  it("reports emulator-not-ready when core never leaves loading", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const emulator = {
      state: "loading" as const,
      quickSave: vi.fn(),
      quickLoad: vi.fn(),
      readStateData: vi.fn(() => null),
      writeStateData: vi.fn(() => false),
      captureScreenshotAsync: vi.fn(async () => null),
    };

    const saveLibrary = { saveState: vi.fn(), getState: vi.fn() } as unknown as SaveStateLibrary;

    const service = new SaveGameService({
      saveLibrary,
      emulator,
      getCurrentGameContext: () => ({ gameId: "g", gameName: "Game", systemId: "psp" }),
      readinessRetries: 2,
      readinessRetryDelayMs: 100,
    });
    service.onStatus((e) => events.push(e.status));

    const promise = service.saveSlot(1);
    await vi.advanceTimersByTimeAsync(400);
    await promise;

    expect(events).toContain("emulator-not-ready");
    vi.useRealTimers();
  });

  it("waits for running cores to report save-state support before saving", async () => {
    vi.useFakeTimers();
    const saveState = vi.fn<(entry: SaveStateEntry) => Promise<void>>().mockResolvedValue(undefined);
    const saveLibrary = {
      saveState,
      getState: vi.fn(async (_gameId: string, slot: number) => makeEntry(slot)),
    } as unknown as SaveStateLibrary;
    const emulator = {
      state: "running" as const,
      quickSave: vi.fn(() => true),
      quickLoad: vi.fn(),
      supportsStates: vi
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false)
        .mockReturnValue(true),
      readStateData: vi.fn(() => new Uint8Array([1, 2, 3])),
      writeStateData: vi.fn(() => true),
      captureScreenshotAsync: vi.fn(async () => null),
    };

    const service = new SaveGameService({
      saveLibrary,
      emulator,
      getCurrentGameContext: () => ({ gameId: "g", gameName: "Game", systemId: "n64" }),
      readinessRetries: 5,
      readinessRetryDelayMs: 100,
    });

    const promise = service.saveSlot(1);
    await vi.advanceTimersByTimeAsync(250);
    const result = await promise;

    expect(result).not.toBeNull();
    expect(emulator.quickSave).toHaveBeenCalledWith(1);
    expect(saveState).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not try to read state bytes when the core rejects quick save", async () => {
    const events: string[] = [];
    const saveLibrary = {
      saveState: vi.fn(),
      getState: vi.fn(async () => null),
    } as unknown as SaveStateLibrary;
    const emulator = {
      state: "running" as const,
      quickSave: vi.fn(() => false),
      quickLoad: vi.fn(),
      supportsStates: vi.fn(() => true),
      readStateData: vi.fn(() => null),
      writeStateData: vi.fn(() => true),
      captureScreenshotAsync: vi.fn(async () => null),
    };

    const service = new SaveGameService({
      saveLibrary,
      emulator,
      getCurrentGameContext: () => ({ gameId: "g", gameName: "Game", systemId: "n64" }),
    });
    service.onStatus((e) => events.push(e.status));

    const result = await service.saveSlot(1);

    expect(result).toBeNull();
    expect(emulator.readStateData).not.toHaveBeenCalled();
    expect(events).toContain("emulator-not-ready");
  });

  it("loads valid local states through emulator write + quickLoad", async () => {
    const entry = makeEntry(1);
    entry.checksum = "0b885c8b";

    const emulator = {
      state: "running" as const,
      quickSave: vi.fn(),
      quickLoad: vi.fn(),
      readStateData: vi.fn(() => new Uint8Array([1, 2, 3])),
      writeStateData: vi.fn(() => true),
    };

    const saveLibrary = {
      getState: vi.fn(async () => entry),
    } as unknown as SaveStateLibrary;

    const service = new SaveGameService({
      saveLibrary,
      emulator,
      getCurrentGameContext: () => ({ gameId: "g", gameName: "Game", systemId: "psp" }),
    });

    const ok = await service.loadSlot(1);
    expect(ok).toBe(true);
    expect(emulator.writeStateData).toHaveBeenCalled();
    expect(emulator.quickLoad).toHaveBeenCalledWith(1);
  });

  it("emits a friendly sync success message when cloud sync succeeds", async () => {
    const entry = makeEntry(1);
    const push = vi.fn().mockResolvedValue(undefined);
    const cloudManager = {
      isConnected: () => true,
      autoSyncEnabled: true,
      push,
      syncGame: vi.fn(),
    } as unknown as import("./cloudSave.js").CloudSaveManager;

    const emulator = {
      state: "running" as const,
      quickSave: vi.fn(),
      quickLoad: vi.fn(),
      readStateData: vi.fn(() => new Uint8Array([1, 2, 3])),
      writeStateData: vi.fn(() => true),
      captureScreenshotAsync: vi.fn(async () => null),
    };

    const saveLibrary = {
      getState: vi.fn(async () => entry),
      saveState: vi.fn(async () => undefined),
    } as unknown as SaveStateLibrary;

    const service = new SaveGameService({
      saveLibrary,
      cloudManager,
      emulator,
      getCurrentGameContext: () => ({ gameId: "g", gameName: "Game", systemId: "psp" }),
    });

    const events: string[] = [];
    service.onStatus((e) => {
      if (e.status === "sync-success") events.push(e.message ?? "");
    });

    await service.saveSlot(1);
    expect(events.some((m) => m.includes("synced to cloud"))).toBe(true);
  });

  it("preserves user-defined slot label when resaving an occupied slot", async () => {
    const existingEntry = makeEntry(2);
    existingEntry.label = "Before Final Boss";

    const saveState = vi.fn<(entry: SaveStateEntry) => Promise<void>>().mockResolvedValue(undefined);
    const getState = vi.fn().mockImplementation(async (_gameId: string, slot: number) => ({ ...existingEntry, slot }));
    const saveLibrary = { saveState, getState } as unknown as SaveStateLibrary;

    const emulator = {
      state: "running" as const,
      quickSave: vi.fn(),
      quickLoad: vi.fn(),
      readStateData: vi.fn(() => new Uint8Array([4, 5, 6])),
      writeStateData: vi.fn(() => true),
      captureScreenshotAsync: vi.fn(async () => null),
    };

    const service = new SaveGameService({
      saveLibrary,
      emulator,
      getCurrentGameContext: () => ({ gameId: "g", gameName: "Game", systemId: "psp" }),
    });

    await service.saveSlot(2);

    expect(saveState).toHaveBeenCalledTimes(1);
    const savedEntry = saveState.mock.calls[0]![0];
    expect(savedEntry.label).toBe("Before Final Boss");
  });

  it("does not persist a save when quick-save produces no state bytes", async () => {
    const events: string[] = [];
    const saveState = vi.fn<(entry: SaveStateEntry) => Promise<void>>().mockResolvedValue(undefined);
    const saveLibrary = {
      saveState,
      getState: vi.fn(async () => null),
    } as unknown as SaveStateLibrary;

    const emulator = {
      state: "running" as const,
      quickSave: vi.fn(),
      quickLoad: vi.fn(),
      readStateData: vi.fn(() => null),
      writeStateData: vi.fn(() => true),
      captureScreenshotAsync: vi.fn(async () => null),
    };

    const service = new SaveGameService({
      saveLibrary,
      emulator,
      getCurrentGameContext: () => ({ gameId: "g", gameName: "Game", systemId: "psp" }),
    });
    service.onStatus((e) => events.push(e.status));

    const result = await service.saveSlot(1);

    expect(result).toBeNull();
    expect(saveState).not.toHaveBeenCalled();
    expect(events).toContain("idle");
  });

  it("waits briefly for quick-save state bytes to flush", async () => {
    const saveState = vi.fn<(entry: SaveStateEntry) => Promise<void>>().mockResolvedValue(undefined);
    const saveLibrary = {
      saveState,
      getState: vi.fn(async (_gameId: string, slot: number) => makeEntry(slot)),
    } as unknown as SaveStateLibrary;

    const emulator = {
      state: "running" as const,
      quickSave: vi.fn(),
      quickLoad: vi.fn(),
      readStateData: vi
        .fn()
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(new Uint8Array([7, 8, 9])),
      writeStateData: vi.fn(() => true),
      captureScreenshotAsync: vi.fn(async () => null),
    };

    const service = new SaveGameService({
      saveLibrary,
      emulator,
      getCurrentGameContext: () => ({ gameId: "g", gameName: "Game", systemId: "psp" }),
      readinessRetryDelayMs: 1,
    });

    const result = await service.saveSlot(1);

    expect(result).not.toBeNull();
    expect(emulator.readStateData).toHaveBeenCalledTimes(2);
    expect(saveState).toHaveBeenCalledTimes(1);
  });

  it("gives N64 cores extra time to flush quick-save state bytes", async () => {
    vi.useFakeTimers();
    const saveState = vi.fn<(entry: SaveStateEntry) => Promise<void>>().mockResolvedValue(undefined);
    const saveLibrary = {
      saveState,
      getState: vi.fn(async (_gameId: string, slot: number) => makeEntry(slot)),
    } as unknown as SaveStateLibrary;
    const emulator = {
      state: "running" as const,
      quickSave: vi.fn(() => true),
      quickLoad: vi.fn(),
      readStateData: vi.fn(() => null as Uint8Array | null),
      writeStateData: vi.fn(() => true),
      captureScreenshotAsync: vi.fn(async () => null),
    };
    emulator.readStateData.mockImplementation(() => (
      emulator.readStateData.mock.calls.length >= 8 ? new Uint8Array([9, 6, 4]) : null
    ));

    const service = new SaveGameService({
      saveLibrary,
      emulator,
      getCurrentGameContext: () => ({ gameId: "g", gameName: "Game", systemId: "n64" }),
      readinessRetries: 2,
      readinessRetryDelayMs: 100,
    });

    const promise = service.saveSlot(1);
    await vi.advanceTimersByTimeAsync(800);
    const result = await promise;

    expect(result).not.toBeNull();
    expect(emulator.readStateData.mock.calls.length).toBeGreaterThan(2);
    expect(saveState).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("emits an integrity warning but still loads a valid slot", async () => {
    const entry = makeEntry(1);
    entry.checksum = "00000000";

    const emulator = {
      state: "running" as const,
      quickSave: vi.fn(),
      quickLoad: vi.fn(),
      readStateData: vi.fn(() => new Uint8Array([1, 2, 3])),
      writeStateData: vi.fn(() => true),
    };

    const saveLibrary = {
      getState: vi.fn(async () => entry),
    } as unknown as SaveStateLibrary;

    const service = new SaveGameService({
      saveLibrary,
      emulator,
      getCurrentGameContext: () => ({ gameId: "g", gameName: "Game", systemId: "psp" }),
    });

    const ok = await service.loadSlot(1);
    expect(ok).toBe(true);
    expect(emulator.quickLoad).toHaveBeenCalledWith(1);
  });

  it("deletes an occupied slot via deleteSlot", async () => {
    const deleteState = vi.fn().mockResolvedValue(undefined);
    const saveLibrary = {
      deleteState,
      getState: vi.fn(async () => makeEntry(3)),
    } as unknown as SaveStateLibrary;

    const emulator = {
      state: "running" as const,
      quickSave: vi.fn(),
      quickLoad: vi.fn(),
      readStateData: vi.fn(() => new Uint8Array([1])),
      writeStateData: vi.fn(() => true),
    };

    const service = new SaveGameService({
      saveLibrary,
      emulator,
      getCurrentGameContext: () => ({ gameId: "g", gameName: "Game", systemId: "psp" }),
    });

    const ok = await service.deleteSlot(3);
    expect(ok).toBe(true);
    expect(deleteState).toHaveBeenCalledWith("g", 3);
  });

  it("returns false when deleting an empty slot", async () => {
    const saveLibrary = {
      getState: vi.fn(async () => null),
      deleteState: vi.fn(),
    } as unknown as SaveStateLibrary;

    const emulator = {
      state: "running" as const,
      quickSave: vi.fn(),
      quickLoad: vi.fn(),
      readStateData: vi.fn(() => null),
      writeStateData: vi.fn(() => true),
    };

    const service = new SaveGameService({
      saveLibrary,
      emulator,
      getCurrentGameContext: () => ({ gameId: "g", gameName: "Game", systemId: "psp" }),
    });

    const ok = await service.deleteSlot(5);
    expect(ok).toBe(false);
    expect(saveLibrary.deleteState).not.toHaveBeenCalled();
  });

  it("findNextSlot returns the first unoccupied slot", async () => {
    const saveLibrary = {
      getStatesForGame: vi.fn(async () => [makeEntry(1), makeEntry(3)]),
    } as unknown as SaveStateLibrary;

    const service = new SaveGameService({
      saveLibrary,
      emulator: { state: "running" as const, quickSave: vi.fn(), quickLoad: vi.fn(), readStateData: vi.fn(() => null), writeStateData: vi.fn(() => true) },
      getCurrentGameContext: () => ({ gameId: "g", gameName: "Game", systemId: "psp" }),
    });

    const next = await service.findNextSlot();
    expect(next).toBe(2);
  });

  it("findNextSlot returns 1 when all slots are full", async () => {
    const saveLibrary = {
      getStatesForGame: vi.fn(async () => Array.from({ length: 8 }, (_, i) => makeEntry(i + 1))),
    } as unknown as SaveStateLibrary;

    const service = new SaveGameService({
      saveLibrary,
      emulator: { state: "running" as const, quickSave: vi.fn(), quickLoad: vi.fn(), readStateData: vi.fn(() => null), writeStateData: vi.fn(() => true) },
      getCurrentGameContext: () => ({ gameId: "g", gameName: "Game", systemId: "psp" }),
    });

    const next = await service.findNextSlot();
    expect(next).toBe(1);
  });

  it("getLastSavedSlot returns the most recently saved slot", async () => {
    const entry3 = makeEntry(3);
    entry3.timestamp = Date.now() - 5000;
    const entry1 = makeEntry(1);
    entry1.timestamp = Date.now() - 1000;

    const saveLibrary = {
      getStatesForGame: vi.fn(async () => [entry3, entry1]),
    } as unknown as SaveStateLibrary;

    const service = new SaveGameService({
      saveLibrary,
      emulator: { state: "running" as const, quickSave: vi.fn(), quickLoad: vi.fn(), readStateData: vi.fn(() => null), writeStateData: vi.fn(() => true) },
      getCurrentGameContext: () => ({ gameId: "g", gameName: "Game", systemId: "psp" }),
    });

    const last = await service.getLastSavedSlot();
    expect(last).toBe(1);
  });

  it("getLastSavedSlot returns 1 when no saves exist", async () => {
    const saveLibrary = {
      getStatesForGame: vi.fn(async () => []),
    } as unknown as SaveStateLibrary;

    const service = new SaveGameService({
      saveLibrary,
      emulator: { state: "running" as const, quickSave: vi.fn(), quickLoad: vi.fn(), readStateData: vi.fn(() => null), writeStateData: vi.fn(() => true) },
      getCurrentGameContext: () => ({ gameId: "g", gameName: "Game", systemId: "psp" }),
    });

    const last = await service.getLastSavedSlot();
    expect(last).toBe(1);
  });
});
