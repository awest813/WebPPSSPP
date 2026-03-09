import { describe, expect, it, vi } from "vitest";
import { SaveGameService } from "./saveService.js";
import type { SaveStateEntry } from "./saves.js";

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
  it("queues duplicate saves for same slot", async () => {
    const saveState = vi.fn().mockResolvedValue(undefined);
    const getState = vi.fn().mockImplementation(async (_gameId: string, slot: number) => makeEntry(slot));
    const saveLibrary = {
      saveState,
      getState,
    } as any;

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

    const saveLibrary = { saveState: vi.fn(), getState: vi.fn() } as any;

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
    } as any;

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
});
