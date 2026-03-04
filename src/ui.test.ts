import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { buildDOM, initUI, openSettingsPanel } from "./ui.js";
import { NetplayManager, DEFAULT_ICE_SERVERS } from "./multiplayer.js";
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
    verboseLogging: false,
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

  it("renders a format hint in the drop zone", () => {
    const app = document.createElement("div");
    document.body.appendChild(app);
    buildDOM(app);

    const hint = app.querySelector(".drop-zone__formats");
    expect(hint).toBeTruthy();
    // Should mention at least one ROM extension and ZIP auto-extraction
    expect(hint!.textContent).toMatch(/\.iso/);
    expect(hint!.textContent).toMatch(/ZIP auto-extracted/i);
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

// ── Multiplayer settings tab ──────────────────────────────────────────────────

describe("buildMultiplayerTab", () => {
  let settings: Settings;
  let onSettingsChange: ReturnType<typeof vi.fn>;
  let mgr: NetplayManager;

  /** Open the settings panel and activate the Multiplayer tab. */
  function openMultiplayerTab() {
    const caps: DeviceCapabilities = {
      isLowSpec: false,
      isChromOS: false,
      gpuRenderer: "unknown",
      isSoftwareGPU: false,
      recommendedMode: "quality",
      tier: "medium",
      deviceMemoryGB: 4,
      cpuCores: 4,
      gpuBenchmarkScore: 50,
      prefersReducedMotion: false,
      webgpuAvailable: false,
      connectionQuality: "unknown",
      jsHeapLimitMB: null,
      gpuCaps: {
        renderer: "unknown",
        vendor: "unknown",
        maxTextureSize: 4096,
        maxVertexAttribs: 16,
        maxVaryingVectors: 30,
        maxRenderbufferSize: 4096,
        anisotropicFiltering: false,
        maxAnisotropy: 0,
        floatTextures: false,
        halfFloatTextures: false,
        instancedArrays: true,
        webgl2: true,
        vertexArrayObject: true,
        compressedTextures: false,
        maxColorAttachments: 4,
        multiDraw: false,
      },
    };
    openSettingsPanel(
      settings,
      caps,
      {
        getAllGamesMetadata: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        totalSize: vi.fn().mockResolvedValue(0),
      } as unknown as GameLibrary,
      { findBios: vi.fn().mockResolvedValue(null) } as unknown as BiosLibrary,
      onSettingsChange,
      undefined,
      undefined,
      undefined,
      mgr
    );
    const tabBtn = document.getElementById("tab-multiplayer") as HTMLButtonElement;
    tabBtn.click();
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    const app = document.createElement("div");
    document.body.appendChild(app);
    buildDOM(app);
    settings = makeSettings();
    onSettingsChange = vi.fn();
    mgr = new NetplayManager();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("server section is hidden when netplay is disabled by default", () => {
    openMultiplayerTab();
    const serverInput = document.getElementById("netplay-server-url") as HTMLInputElement;
    expect(serverInput).toBeTruthy();
    // The server section wraps the URL input and ICE section — it should be hidden
    const serverSection = serverInput.closest(".settings-section") as HTMLElement;
    expect(serverSection.hidden).toBe(true);
  });

  it("enabling netplay shows the server section and calls onSettingsChange", () => {
    openMultiplayerTab();
    // The Enable Netplay toggle is the first checkbox in the Multiplayer tab panel
    const panel = document.getElementById("tab-panel-multiplayer")!;
    const checkbox = panel.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    expect(checkbox).toBeTruthy();
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));

    const serverInput = document.getElementById("netplay-server-url") as HTMLInputElement;
    const serverSection = serverInput.closest(".settings-section") as HTMLElement;
    expect(serverSection.hidden).toBe(false);
    expect(onSettingsChange).toHaveBeenCalledWith({ netplayEnabled: true });
  });

  it("disabling netplay hides the server section and calls onSettingsChange", () => {
    settings = makeSettings({ netplayEnabled: true });
    openMultiplayerTab();

    const panel = document.getElementById("tab-panel-multiplayer")!;
    const checkbox = panel.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    expect(checkbox.checked).toBe(true);
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));

    const serverInput = document.getElementById("netplay-server-url") as HTMLInputElement;
    const serverSection = serverInput.closest(".settings-section") as HTMLElement;
    expect(serverSection.hidden).toBe(true);
    expect(onSettingsChange).toHaveBeenCalledWith({ netplayEnabled: false });
  });

  it("valid wss:// server URL calls onSettingsChange and netplayManager.setServerUrl", () => {
    settings = makeSettings({ netplayEnabled: true });
    openMultiplayerTab();

    const setServerUrl = vi.spyOn(mgr, "setServerUrl");
    const urlInput = document.getElementById("netplay-server-url") as HTMLInputElement;
    urlInput.value = "wss://netplay.example.com";
    urlInput.dispatchEvent(new Event("change"));

    expect(onSettingsChange).toHaveBeenCalledWith({ netplayServerUrl: "wss://netplay.example.com" });
    expect(setServerUrl).toHaveBeenCalledWith("wss://netplay.example.com");
  });

  it("invalid server URL (http://) does not call onSettingsChange", () => {
    settings = makeSettings({ netplayEnabled: true });
    openMultiplayerTab();

    const urlInput = document.getElementById("netplay-server-url") as HTMLInputElement;
    urlInput.value = "http://example.com";
    urlInput.dispatchEvent(new Event("change"));

    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("typing in the URL input clears custom validity", () => {
    settings = makeSettings({ netplayEnabled: true });
    openMultiplayerTab();

    const urlInput = document.getElementById("netplay-server-url") as HTMLInputElement;
    // Set an error first
    urlInput.value = "http://bad.example.com";
    urlInput.dispatchEvent(new Event("change"));

    // Now simulate typing (input event) — custom validity should be cleared
    urlInput.dispatchEvent(new Event("input"));
    expect(urlInput.validationMessage).toBe("");
  });

  it("adding a valid stun: ICE server updates the list and calls netplayManager.setIceServers", () => {
    openMultiplayerTab();
    const setIceServers = vi.spyOn(mgr, "setIceServers");

    const panel = document.getElementById("tab-panel-multiplayer")!;
    const addInput = panel.querySelector<HTMLInputElement>(".settings-input:not(#netplay-server-url)")!;
    const addBtn   = panel.querySelector<HTMLButtonElement>(".btn--primary")!;
    expect(addInput).toBeTruthy();
    expect(addBtn).toBeTruthy();

    addInput.value = "stun:custom.stun.example.com:3478";
    addBtn.click();

    expect(setIceServers).toHaveBeenCalled();
    const updatedServers = setIceServers.mock.calls[0][0] as RTCIceServer[];
    expect(updatedServers.some(s => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.includes("stun:custom.stun.example.com:3478");
    })).toBe(true);

    // The input should be cleared
    expect(addInput.value).toBe("");
  });

  it("adding an invalid ICE server URL does not call netplayManager.setIceServers", () => {
    openMultiplayerTab();
    const setIceServers = vi.spyOn(mgr, "setIceServers");

    const panel = document.getElementById("tab-panel-multiplayer")!;
    const addInput = panel.querySelector<HTMLInputElement>(".settings-input:not(#netplay-server-url)")!;
    const addBtn   = panel.querySelector<HTMLButtonElement>(".btn--primary")!;

    addInput.value = "http://invalid-ice-server.com";
    addBtn.click();

    expect(setIceServers).not.toHaveBeenCalled();
  });

  it("removing an ICE server updates the list", () => {
    openMultiplayerTab();
    const setIceServers = vi.spyOn(mgr, "setIceServers");

    const panel = document.getElementById("tab-panel-multiplayer")!;
    const removeBtn = panel.querySelector<HTMLButtonElement>(".netplay-ice-remove")!;
    expect(removeBtn).toBeTruthy();
    removeBtn.click();

    expect(setIceServers).toHaveBeenCalled();
    const updated = setIceServers.mock.calls[0][0] as RTCIceServer[];
    // Should have one fewer entry than the default
    expect(updated.length).toBe(DEFAULT_ICE_SERVERS.length - 1);
  });

  it("resetting ICE servers restores defaults and calls netplayManager.resetIceServers", () => {
    openMultiplayerTab();
    const resetIce = vi.spyOn(mgr, "resetIceServers");

    const panel = document.getElementById("tab-panel-multiplayer")!;
    // Remove one entry first so we have something to reset
    const removeBtn = panel.querySelector<HTMLButtonElement>(".netplay-ice-remove")!;
    removeBtn.click();

    // Click Reset to defaults
    const resetBtn = Array.from(panel.querySelectorAll<HTMLButtonElement>("button"))
      .find(b => b.textContent?.includes("Reset to defaults"))!;
    expect(resetBtn).toBeTruthy();
    resetBtn.click();

    expect(resetIce).toHaveBeenCalled();
    // The rendered list should show all defaults again
    const iceUrls = Array.from(panel.querySelectorAll<HTMLElement>(".netplay-ice-url"))
      .map(el => el.textContent?.trim() ?? "");
    const defaultUrls = DEFAULT_ICE_SERVERS.map(s => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.join(", ");
    });
    expect(iceUrls).toEqual(defaultUrls);
  });

  it("enabling netplay calls netplayManager.setEnabled(true)", () => {
    openMultiplayerTab();
    const setEnabled = vi.spyOn(mgr, "setEnabled");

    const panel = document.getElementById("tab-panel-multiplayer")!;
    const checkbox = panel.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));

    expect(setEnabled).toHaveBeenCalledWith(true);
  });

  it("default ICE servers are rendered in the list", () => {
    openMultiplayerTab();
    const panel = document.getElementById("tab-panel-multiplayer")!;
    const iceUrls = Array.from(panel.querySelectorAll<HTMLElement>(".netplay-ice-url"))
      .map(el => el.textContent?.trim() ?? "");
    expect(iceUrls.length).toBe(DEFAULT_ICE_SERVERS.length);
    DEFAULT_ICE_SERVERS.forEach(srv => {
      const urls = Array.isArray(srv.urls) ? srv.urls : [srv.urls];
      expect(iceUrls).toContain(urls.join(", "));
    });
  });

  it("pre-configured server URL is shown in the input", () => {
    settings = makeSettings({ netplayEnabled: true, netplayServerUrl: "wss://my.server.com" });
    openMultiplayerTab();
    const urlInput = document.getElementById("netplay-server-url") as HTMLInputElement;
    expect(urlInput.value).toBe("wss://my.server.com");
  });

  it("removing all ICE servers shows an empty-state message", () => {
    openMultiplayerTab();
    const panel = document.getElementById("tab-panel-multiplayer")!;
    // Remove every default server
    const removeBtns = [...panel.querySelectorAll<HTMLButtonElement>(".netplay-ice-remove")];
    expect(removeBtns.length).toBeGreaterThan(0);
    for (const btn of removeBtns) btn.click();

    const emptyMsg = panel.querySelector(".netplay-ice-empty");
    expect(emptyMsg).toBeTruthy();
    expect(emptyMsg!.textContent).toContain("No ICE servers");
  });

  it("server URL input has autocomplete off and spellcheck false", () => {
    settings = makeSettings({ netplayEnabled: true });
    openMultiplayerTab();
    const urlInput = document.getElementById("netplay-server-url") as HTMLInputElement;
    expect(urlInput.getAttribute("autocomplete")).toBe("off");
    expect(urlInput.getAttribute("spellcheck")).toBe("false");
  });
});

// ── Debug settings tab ────────────────────────────────────────────────────────

describe("buildDebugTab", () => {
  const caps: DeviceCapabilities = {
    isLowSpec: false,
    isChromOS: false,
    gpuRenderer: "unknown",
    isSoftwareGPU: false,
    recommendedMode: "quality",
    tier: "medium",
    deviceMemoryGB: 4,
    cpuCores: 4,
    gpuBenchmarkScore: 50,
    prefersReducedMotion: false,
    webgpuAvailable: false,
    connectionQuality: "unknown",
    jsHeapLimitMB: null,
    gpuCaps: {
      renderer: "unknown",
      vendor: "unknown",
      maxTextureSize: 4096,
      maxVertexAttribs: 16,
      maxVaryingVectors: 30,
      maxRenderbufferSize: 4096,
      anisotropicFiltering: false,
      maxAnisotropy: 0,
      floatTextures: false,
      halfFloatTextures: false,
      instancedArrays: true,
      webgl2: true,
      vertexArrayObject: true,
      compressedTextures: false,
      maxColorAttachments: 4,
      multiDraw: false,
    },
  };

  let settings: Settings;
  let onSettingsChange: ReturnType<typeof vi.fn>;

  function openDebugTab(s?: Settings) {
    openSettingsPanel(
      s ?? settings,
      caps,
      { getAllGamesMetadata: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0), totalSize: vi.fn().mockResolvedValue(0) } as unknown as GameLibrary,
      { findBios: vi.fn().mockResolvedValue(null) } as unknown as BiosLibrary,
      onSettingsChange,
      undefined,
      undefined,
      undefined,
      undefined,
      "debug"
    );
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    const app = document.createElement("div");
    document.body.appendChild(app);
    buildDOM(app);
    settings = makeSettings();
    onSettingsChange = vi.fn();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("opens directly to the Debug tab when initialTab is 'debug'", () => {
    openDebugTab();
    const debugPanel = document.getElementById("tab-panel-debug")!;
    expect(debugPanel).toBeTruthy();
    expect(debugPanel.hidden).toBe(false);
    // Performance panel should be hidden
    const perfPanel = document.getElementById("tab-panel-performance")!;
    expect(perfPanel.hidden).toBe(true);
  });

  it("Debug tab button has aria-selected true when initialTab is 'debug'", () => {
    openDebugTab();
    const debugTabBtn = document.getElementById("tab-debug") as HTMLButtonElement;
    expect(debugTabBtn.getAttribute("aria-selected")).toBe("true");
  });

  it("clicking another tab updates selected state and panel visibility", () => {
    openDebugTab();
    const displayTabBtn = document.getElementById("tab-display") as HTMLButtonElement;
    displayTabBtn.click();
    const displayPanel = document.getElementById("tab-panel-display")!;
    const debugPanel = document.getElementById("tab-panel-debug")!;
    expect(displayTabBtn.getAttribute("aria-selected")).toBe("true");
    expect(displayTabBtn.getAttribute("tabindex")).toBe("0");
    expect(displayPanel.hidden).toBe(false);
    expect(debugPanel.hidden).toBe(true);
  });

  it("ArrowLeft keyboard navigation switches tabs from Debug to Multiplayer", () => {
    openDebugTab();
    const debugTabBtn = document.getElementById("tab-debug") as HTMLButtonElement;
    debugTabBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    const mpTabBtn = document.getElementById("tab-multiplayer") as HTMLButtonElement;
    const mpPanel = document.getElementById("tab-panel-multiplayer")!;
    const debugPanel = document.getElementById("tab-panel-debug")!;
    expect(mpTabBtn.getAttribute("aria-selected")).toBe("true");
    expect(mpTabBtn.getAttribute("tabindex")).toBe("0");
    expect(mpPanel.hidden).toBe(false);
    expect(debugPanel.hidden).toBe(true);
  });

  it("verbose logging toggle is unchecked by default", () => {
    openDebugTab();
    const panel = document.getElementById("tab-panel-debug")!;
    const checkbox = panel.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    expect(checkbox).toBeTruthy();
    expect(checkbox.checked).toBe(false);
  });

  it("verbose logging toggle is checked when verboseLogging is true", () => {
    openDebugTab(makeSettings({ verboseLogging: true }));
    const panel = document.getElementById("tab-panel-debug")!;
    const checkbox = panel.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    expect(checkbox.checked).toBe(true);
  });

  it("toggling verbose logging calls onSettingsChange with verboseLogging: true", () => {
    openDebugTab();
    const panel = document.getElementById("tab-panel-debug")!;
    const checkbox = panel.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    expect(onSettingsChange).toHaveBeenCalledWith({ verboseLogging: true });
  });

  it("disabling verbose logging calls onSettingsChange with verboseLogging: false", () => {
    openDebugTab(makeSettings({ verboseLogging: true }));
    const panel = document.getElementById("tab-panel-debug")!;
    const checkbox = panel.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));
    expect(onSettingsChange).toHaveBeenCalledWith({ verboseLogging: false });
  });
});
