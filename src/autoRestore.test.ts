import { describe, it, expect, vi, afterEach } from "vitest";
import { scheduleAutoRestoreOnGameStart } from "./autoRestore.js";

describe("scheduleAutoRestoreOnGameStart", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("restores state and quick-loads once on game start", () => {
    vi.useFakeTimers();
    const writeStateData = vi.fn(() => true);
    const quickLoad = vi.fn();
    const stateBytes = new Uint8Array([1, 2, 3]);
    const onConsumed = vi.fn();

    scheduleAutoRestoreOnGameStart({
      emulator: { writeStateData, quickLoad },
      stateBytes,
      slot: 0,
      delayMs: 250,
      onConsumed,
    });

    document.dispatchEvent(new CustomEvent("retrovault:gameStarted"));
    document.dispatchEvent(new CustomEvent("retrovault:gameStarted"));

    expect(onConsumed).toHaveBeenCalledTimes(1);
    expect(writeStateData).not.toHaveBeenCalled();
    expect(quickLoad).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);

    expect(writeStateData).toHaveBeenCalledTimes(1);
    expect(writeStateData).toHaveBeenCalledWith(0, stateBytes);
    expect(quickLoad).toHaveBeenCalledTimes(1);
    expect(quickLoad).toHaveBeenCalledWith(0);
  });

  it("does not quick-load when writeStateData fails", () => {
    vi.useFakeTimers();
    const writeStateData = vi.fn(() => false);
    const quickLoad = vi.fn();

    scheduleAutoRestoreOnGameStart({
      emulator: { writeStateData, quickLoad },
      stateBytes: new Uint8Array([9, 9, 9]),
      slot: 1,
      delayMs: 100,
    });

    document.dispatchEvent(new CustomEvent("retrovault:gameStarted"));
    vi.advanceTimersByTime(100);

    expect(writeStateData).toHaveBeenCalledTimes(1);
    expect(quickLoad).not.toHaveBeenCalled();
  });

  it("cancel() removes pending listener before game start", () => {
    vi.useFakeTimers();
    const writeStateData = vi.fn(() => true);
    const quickLoad = vi.fn();

    const reg = scheduleAutoRestoreOnGameStart({
      emulator: { writeStateData, quickLoad },
      stateBytes: new Uint8Array([7]),
      slot: 0,
      delayMs: 50,
    });

    reg.cancel();
    document.dispatchEvent(new CustomEvent("retrovault:gameStarted"));
    vi.advanceTimersByTime(100);

    expect(writeStateData).not.toHaveBeenCalled();
    expect(quickLoad).not.toHaveBeenCalled();
  });
});
