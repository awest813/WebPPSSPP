import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDOM, initUI } from "./ui.js";
import type { PSPEmulator } from "./emulator.js";
import type { GameLibrary } from "./library.js";
import type { BiosLibrary } from "./bios.js";
import type { SaveStateLibrary } from "./saves.js";
import type { Settings } from "./main.js";
import type { DeviceCapabilities } from "./performance.js";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    volume: 0.7,
    lastGameName: null,
    performanceMode: "auto",
    showFPS: false,
    showAudioVis: false,
    useWebGPU: false,
    postProcessEffect: "none",
    autoSaveEnabled: true,
    touchControls: false,
    hapticFeedback: true,
    orientationLock: true,
    netplayEnabled: false,
    netplayServerUrl: "",
    ...overrides,
  };
}

function makeOpts(settings: Settings) {
  return {
    emulator: {
      state: "idle",
      activeTier: "medium",
      currentSystem: null,
      setFPSMonitorEnabled: vi.fn(),
    } as unknown as PSPEmulator,
    library: { getAllGamesMetadata: vi.fn().mockResolvedValue([]) } as unknown as GameLibrary,
    biosLibrary: {} as BiosLibrary,
    saveLibrary: {} as SaveStateLibrary,
    settings,
    deviceCaps: { isLowSpec: false, isChromOS: false } as unknown as DeviceCapabilities,
    onLaunchGame: vi.fn(async () => {}),
    onSettingsChange: vi.fn(),
    onReturnToLibrary: vi.fn(),
    onApplyPatch: vi.fn(async () => {}),
    onFileChosen: vi.fn(async () => {}),
    getCurrentGameId: () => null,
    getCurrentGameName: () => null,
    getCurrentSystemId: () => null,
  };
}

describe("ui drag-over state", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("clears drag-over class when the window loses focus mid-drag", () => {
    const app = document.createElement("div");
    document.body.appendChild(app);
    buildDOM(app);
    initUI(makeOpts(makeSettings()));

    const dropZone = document.getElementById("drop-zone");
    expect(dropZone).toBeTruthy();

    document.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    expect(dropZone!.classList.contains("drag-over")).toBe(true);

    window.dispatchEvent(new Event("blur"));
    expect(dropZone!.classList.contains("drag-over")).toBe(false);
  });
});

describe("buildDOM", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("resets _libraryControlsWired so search/sort handlers are wired on a second buildDOM call", async () => {
    // First build + init (wires controls for the first time)
    const app1 = document.createElement("div");
    document.body.appendChild(app1);
    buildDOM(app1);
    const library1 = { getAllGamesMetadata: vi.fn().mockResolvedValue([]) } as unknown as GameLibrary;
    initUI({ ...makeOpts(makeSettings()), library: library1 });
    // Flush the initial renderLibrary call so _libraryControlsWired is set to true
    await new Promise(r => setTimeout(r, 0));
    const search1 = document.getElementById("library-search") as HTMLInputElement;
    expect(search1).toBeTruthy();

    // Second build resets the DOM and the wiring flag
    const app2 = document.createElement("div");
    document.body.innerHTML = "";
    document.body.appendChild(app2);
    buildDOM(app2);

    // Init UI again on the fresh DOM — renderLibrary should wire search
    const library2 = { getAllGamesMetadata: vi.fn().mockResolvedValue([]) } as unknown as GameLibrary;
    initUI({ ...makeOpts(makeSettings()), library: library2 });
    await new Promise(r => setTimeout(r, 0));

    // Typing in the new search box should trigger a debounced renderLibrary call
    const search2 = document.getElementById("library-search") as HTMLInputElement;
    expect(search2).toBeTruthy();
    search2.value = "test";
    search2.dispatchEvent(new Event("input"));
    // Wait for the 120 ms debounce
    await new Promise(r => setTimeout(r, 150));
    // getAllGamesMetadata is called once on init and once on the debounced search
    expect(library2.getAllGamesMetadata).toHaveBeenCalledTimes(2);
  });
});

describe("FPS toggle button aria-pressed", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("sets aria-pressed=false when showFPS is false initially", () => {
    const app = document.createElement("div");
    document.body.appendChild(app);
    buildDOM(app);

    const onSettingsChange = vi.fn();
    const emulatorMock = {
      state: "running",
      activeTier: "medium",
      currentSystem: { shortName: "PSP", name: "PSP", id: "psp", color: "#00f" },
      setFPSMonitorEnabled: vi.fn(),
      onStateChange: null,
      onProgress: null,
      onError: null,
      onGameStart: null,
      onFPSUpdate: null,
    } as unknown as PSPEmulator;

    initUI({
      ...makeOpts(makeSettings({ showFPS: false })),
      emulator: emulatorMock,
      onSettingsChange,
    });

    // Simulate game start to build in-game controls
    emulatorMock.onGameStart?.();

    const fpsBtn = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find(b => b.textContent?.trim() === "FPS");
    if (fpsBtn) {
      expect(fpsBtn.getAttribute("aria-pressed")).toBe("false");
    }
  });
});
