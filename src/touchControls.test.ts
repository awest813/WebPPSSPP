/**
 * touchControls.test.ts — Tests for the virtual gamepad overlay.
 *
 * Covers:
 *   - Default layout structure (button count, required fields)
 *   - Portrait layout structure
 *   - Layout persistence (save → load round-trip, partial restore, reset)
 *   - Button size persistence
 *   - Portrait orientation: separate storage key, auto-switch on resize
 *   - isPortrait() detection
 *   - isTouchDevice() detection
 *   - Haptic helpers (vibrate call routing)
 *   - TouchControlsOverlay lifecycle (show, hide, setEditing, setSystem)
 *   - Key event dispatch on button press/release (pointer events)
 *   - Pointer capture semantics (key released on pointercancel)
 *   - Edit mode suppresses key events
 *   - D-pad cross element: directional input, diagonal input
 *   - Orientation switching with automatic layout reload
 *   - Multi-pointer handling (simultaneous pointers on a button)
 *   - Analog stick active class
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_LAYOUT,
  DEFAULT_PORTRAIT_LAYOUT,
  loadLayout,
  saveLayout,
  resetLayout,
  isTouchDevice,
  isPortrait,
  vibratePress,
  vibrateRelease,
  TouchControlsOverlay,
  type TouchButtonDef,
} from "./touchControls.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const LS_KEY          = (sys: string) => `rv:touch-layout:${sys}`;
const LS_KEY_PORTRAIT = (sys: string) => `rv:touch-layout-portrait:${sys}`;

function cleanLS(sys: string) {
  localStorage.removeItem(LS_KEY(sys));
}

function makeContainer(): HTMLElement {
  const div = document.createElement("div");
  document.body.appendChild(div);
  return div;
}

function removeContainer(el: HTMLElement) {
  el.parentNode?.removeChild(el);
}

// ── DEFAULT_LAYOUT ────────────────────────────────────────────────────────────

describe("DEFAULT_LAYOUT", () => {
  it("contains 10 buttons (dpad + 4 face + 2 shoulder + 2 meta + stick)", () => {
    expect(DEFAULT_LAYOUT).toHaveLength(10);
  });

  it("includes a single cross-shaped D-pad element (type: dpad)", () => {
    const dpad = DEFAULT_LAYOUT.find((b) => b.id === "dpad");
    expect(dpad).toBeDefined();
    expect(dpad!.type).toBe("dpad");
  });

  it("includes all required face buttons", () => {
    const ids = DEFAULT_LAYOUT.map((b) => b.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("x");
    expect(ids).toContain("y");
  });

  it("includes shoulder and meta buttons", () => {
    const ids = DEFAULT_LAYOUT.map((b) => b.id);
    expect(ids).toContain("l");
    expect(ids).toContain("r");
    expect(ids).toContain("start");
    expect(ids).toContain("select");
  });

  it("does not contain individual directional buttons (up/down/left/right)", () => {
    const ids = DEFAULT_LAYOUT.map((b) => b.id);
    expect(ids).not.toContain("up");
    expect(ids).not.toContain("down");
    expect(ids).not.toContain("left");
    expect(ids).not.toContain("right");
  });

  it("all buttons have numeric x, y, size fields in valid ranges", () => {
    for (const btn of DEFAULT_LAYOUT) {
      expect(typeof btn.x).toBe("number");
      expect(typeof btn.y).toBe("number");
      expect(typeof btn.size).toBe("number");
      expect(btn.x).toBeGreaterThanOrEqual(0);
      expect(btn.x).toBeLessThanOrEqual(100);
      expect(btn.y).toBeGreaterThanOrEqual(0);
      expect(btn.y).toBeLessThanOrEqual(100);
      expect(btn.size).toBeGreaterThan(0);
    }
  });

  it("returns independent copies from DEFAULT_LAYOUT (mutations don't leak)", () => {
    const layout = loadLayout("__test_isolation__");
    layout[0]!.x = 999;
    const layout2 = loadLayout("__test_isolation__");
    expect(layout2[0]!.x).not.toBe(999);
    cleanLS("__test_isolation__");
  });
});

// ── DEFAULT_PORTRAIT_LAYOUT ───────────────────────────────────────────────────

describe("DEFAULT_PORTRAIT_LAYOUT", () => {
  it("contains 10 buttons", () => {
    expect(DEFAULT_PORTRAIT_LAYOUT).toHaveLength(10);
  });

  it("has the same button ids as DEFAULT_LAYOUT", () => {
    const landscapeIds = DEFAULT_LAYOUT.map((b) => b.id).sort();
    const portraitIds  = DEFAULT_PORTRAIT_LAYOUT.map((b) => b.id).sort();
    expect(portraitIds).toEqual(landscapeIds);
  });

  it("all buttons have numeric x, y, size fields in valid ranges", () => {
    for (const btn of DEFAULT_PORTRAIT_LAYOUT) {
      expect(typeof btn.x).toBe("number");
      expect(typeof btn.y).toBe("number");
      expect(typeof btn.size).toBe("number");
      expect(btn.x).toBeGreaterThanOrEqual(0);
      expect(btn.x).toBeLessThanOrEqual(100);
      expect(btn.y).toBeGreaterThanOrEqual(0);
      expect(btn.y).toBeLessThanOrEqual(100);
      expect(btn.size).toBeGreaterThan(0);
    }
  });

  it("D-pad is positioned lower in portrait for thumb reach", () => {
    const portraitDpad  = DEFAULT_PORTRAIT_LAYOUT.find((b) => b.id === "dpad")!;
    const landscapeDpad = DEFAULT_LAYOUT.find((b) => b.id === "dpad")!;
    // Portrait D-pad should be lower on the screen (higher y %)
    expect(portraitDpad.y).toBeGreaterThan(landscapeDpad.y);
  });
});

// ── loadLayout ────────────────────────────────────────────────────────────────

describe("loadLayout", () => {
  const SYS = "test_load";

  afterEach(() => cleanLS(SYS));

  it("returns defaults when no saved layout exists", () => {
    const layout = loadLayout(SYS);
    expect(layout).toHaveLength(DEFAULT_LAYOUT.length);
    expect(layout[0]!.id).toBe(DEFAULT_LAYOUT[0]!.id);
  });

  it("restores saved positions on round-trip", () => {
    const layout = loadLayout(SYS);
    layout[0]!.x = 42;
    layout[0]!.y = 77;
    saveLayout(SYS, layout);

    const restored = loadLayout(SYS);
    expect(restored[0]!.x).toBeCloseTo(42);
    expect(restored[0]!.y).toBeCloseTo(77);
  });

  it("falls back to defaults for buttons absent from the saved blob", () => {
    // Save only partial layout (missing some buttons)
    localStorage.setItem(LS_KEY(SYS), JSON.stringify([{ id: "dpad", x: 5, y: 5 }]));
    const layout = loadLayout(SYS);
    // "dpad" should have the saved position
    const dpadBtn = layout.find((b) => b.id === "dpad")!;
    expect(dpadBtn.x).toBe(5);
    // "a" was not saved — should get the default
    const aBtn = layout.find((b) => b.id === "a")!;
    const defaultA = DEFAULT_LAYOUT.find((b) => b.id === "a")!;
    expect(aBtn.x).toBe(defaultA.x);
  });

  it("handles corrupt localStorage data gracefully", () => {
    localStorage.setItem(LS_KEY(SYS), "not valid json{{{");
    const layout = loadLayout(SYS);
    expect(layout).toHaveLength(DEFAULT_LAYOUT.length);
  });
});

// ── saveLayout ────────────────────────────────────────────────────────────────

describe("saveLayout", () => {
  const SYS = "test_save";

  afterEach(() => cleanLS(SYS));

  it("persists positions so they survive a loadLayout call", () => {
    const layout: TouchButtonDef[] = DEFAULT_LAYOUT.map((b) => ({ ...b }));
    layout[2]!.x = 55;
    layout[2]!.y = 66;
    saveLayout(SYS, layout);

    const raw = localStorage.getItem(LS_KEY(SYS));
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Array<{ id: string; x: number; y: number }>;
    const entry = parsed.find((p) => p.id === layout[2]!.id)!;
    expect(entry.x).toBeCloseTo(55);
    expect(entry.y).toBeCloseTo(66);
  });
});

// ── resetLayout ───────────────────────────────────────────────────────────────

describe("resetLayout", () => {
  const SYS = "test_reset";

  afterEach(() => cleanLS(SYS));

  it("removes saved layout and returns defaults", () => {
    const layout = loadLayout(SYS);
    layout[0]!.x = 88;
    saveLayout(SYS, layout);

    const defaults = resetLayout(SYS);
    expect(defaults[0]!.x).toBe(DEFAULT_LAYOUT[0]!.x);
    expect(localStorage.getItem(LS_KEY(SYS))).toBeNull();
  });
});

// ── loadLayout (portrait) ─────────────────────────────────────────────────────

describe("loadLayout — portrait mode", () => {
  const SYS = "test_load_portrait";

  afterEach(() => {
    localStorage.removeItem(LS_KEY_PORTRAIT(SYS));
    localStorage.removeItem(LS_KEY(SYS));
  });

  it("returns portrait defaults when portrait=true and no saved layout exists", () => {
    const layout = loadLayout(SYS, true);
    expect(layout).toHaveLength(DEFAULT_PORTRAIT_LAYOUT.length);
    const dpadBtn = layout.find((b) => b.id === "dpad")!;
    const portraitDefault = DEFAULT_PORTRAIT_LAYOUT.find((b) => b.id === "dpad")!;
    expect(dpadBtn.y).toBe(portraitDefault.y);
  });

  it("landscape and portrait use separate storage keys", () => {
    const landscape = loadLayout(SYS, false);
    landscape[0]!.x = 11;
    saveLayout(SYS, landscape, false);

    const portrait = loadLayout(SYS, true);
    portrait[0]!.x = 55;
    saveLayout(SYS, portrait, true);

    // Landscape slot must not be affected by the portrait write
    const reloadedLandscape = loadLayout(SYS, false);
    expect(reloadedLandscape[0]!.x).toBeCloseTo(11);

    // Portrait slot must not be affected by the landscape write
    const reloadedPortrait = loadLayout(SYS, true);
    expect(reloadedPortrait[0]!.x).toBeCloseTo(55);
  });
});

// ── saveLayout — size persistence ────────────────────────────────────────────

describe("saveLayout — size persistence", () => {
  const SYS = "test_save_size";

  afterEach(() => {
    localStorage.removeItem(LS_KEY(SYS));
    localStorage.removeItem(LS_KEY_PORTRAIT(SYS));
  });

  it("persists custom size on round-trip (landscape)", () => {
    const layout = loadLayout(SYS, false);
    const btn = layout.find((b) => b.id === "a")!;
    btn.size = 72;
    saveLayout(SYS, layout, false);

    const restored = loadLayout(SYS, false);
    const restoredBtn = restored.find((b) => b.id === "a")!;
    expect(restoredBtn.size).toBe(72);
  });

  it("persists custom size on round-trip (portrait)", () => {
    const layout = loadLayout(SYS, true);
    const btn = layout.find((b) => b.id === "l")!;
    btn.size = 64;
    saveLayout(SYS, layout, true);

    const restored = loadLayout(SYS, true);
    const restoredBtn = restored.find((b) => b.id === "l")!;
    expect(restoredBtn.size).toBe(64);
  });

  it("falls back to default size when size absent from saved blob", () => {
    // Write a blob that predates size persistence (no size field)
    localStorage.setItem(LS_KEY(SYS), JSON.stringify([{ id: "b", x: 10, y: 20 }]));
    const layout = loadLayout(SYS, false);
    const btn = layout.find((b) => b.id === "b")!;
    const defaultBtn = DEFAULT_LAYOUT.find((b) => b.id === "b")!;
    expect(btn.size).toBe(defaultBtn.size);
  });
});

// ── resetLayout (portrait) ────────────────────────────────────────────────────

describe("resetLayout — portrait mode", () => {
  const SYS = "test_reset_portrait";

  afterEach(() => {
    localStorage.removeItem(LS_KEY_PORTRAIT(SYS));
    localStorage.removeItem(LS_KEY(SYS));
  });

  it("removes the portrait layout and returns portrait defaults", () => {
    const layout = loadLayout(SYS, true);
    layout[0]!.x = 88;
    saveLayout(SYS, layout, true);
    expect(localStorage.getItem(LS_KEY_PORTRAIT(SYS))).not.toBeNull();

    const defaults = resetLayout(SYS, true);
    expect(defaults[0]!.x).toBe(DEFAULT_PORTRAIT_LAYOUT[0]!.x);
    expect(localStorage.getItem(LS_KEY_PORTRAIT(SYS))).toBeNull();
  });

  it("landscape slot is unaffected when resetting the portrait slot", () => {
    const ls = loadLayout(SYS, false);
    ls[0]!.x = 77;
    saveLayout(SYS, ls, false);

    resetLayout(SYS, true); // reset portrait only

    const reloaded = loadLayout(SYS, false);
    expect(reloaded[0]!.x).toBeCloseTo(77);
  });
});

// ── isPortrait ────────────────────────────────────────────────────────────────

describe("isPortrait", () => {
  it("returns false by default in jsdom (landscape stub)", () => {
    // The testSetup stub always returns matches:false
    expect(isPortrait()).toBe(false);
  });

  it("returns true when matchMedia reports portrait", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("portrait"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    expect(isPortrait()).toBe(true);
    vi.unstubAllGlobals();
  });

  it("falls back to innerHeight > innerWidth when matchMedia throws", () => {
    vi.stubGlobal("matchMedia", () => { throw new Error("not supported"); });
    // jsdom default innerHeight (768) > innerWidth (1024) is false, so portrait=false
    expect(isPortrait()).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("isTouchDevice", () => {
  it("returns true when maxTouchPoints > 0", () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
    Object.defineProperty(navigator, "maxTouchPoints", { value: 5, configurable: true });
    expect(isTouchDevice()).toBe(true);
    if (orig) Object.defineProperty(navigator, "maxTouchPoints", orig);
    else Object.defineProperty(navigator, "maxTouchPoints", { value: 0, configurable: true });
  });

  it("returns false when maxTouchPoints is 0 and ontouchstart absent", () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
    Object.defineProperty(navigator, "maxTouchPoints", { value: 0, configurable: true });

    // Ensure ontouchstart is not on window for this test
    const hadTouch = "ontouchstart" in window;
    if (hadTouch) delete (window as unknown as Record<string, unknown>).ontouchstart;

    expect(isTouchDevice()).toBe(false);

    if (orig) Object.defineProperty(navigator, "maxTouchPoints", orig);
    else Object.defineProperty(navigator, "maxTouchPoints", { value: 0, configurable: true });
  });
});

// ── Haptic helpers ────────────────────────────────────────────────────────────

describe("vibratePress / vibrateRelease", () => {
  it("calls navigator.vibrate with a short duration on press", () => {
    const spy = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, vibrate: spy });
    vibratePress();
    expect(spy).toHaveBeenCalledWith(12);
    vi.unstubAllGlobals();
  });

  it("calls navigator.vibrate with a shorter duration on release", () => {
    const spy = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, vibrate: spy });
    vibrateRelease();
    expect(spy).toHaveBeenCalledWith(6);
    vi.unstubAllGlobals();
  });

  it("does not throw when navigator.vibrate is absent", () => {
    vi.stubGlobal("navigator", { ...navigator, vibrate: undefined });
    expect(() => vibratePress()).not.toThrow();
    expect(() => vibrateRelease()).not.toThrow();
    vi.unstubAllGlobals();
  });
});

// ── TouchControlsOverlay ──────────────────────────────────────────────────────

describe("TouchControlsOverlay", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = makeContainer();
  });

  afterEach(() => {
    removeContainer(container);
    cleanLS("psp");
    cleanLS("nes");
  });

  it("creates no DOM elements before show()", () => {
    new TouchControlsOverlay(container, "psp", false);
    expect(container.querySelector(".touch-controls")).toBeNull();
  });

  it("show() appends the overlay to the container", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    expect(container.querySelector(".touch-controls")).not.toBeNull();
  });

  it("show() creates one control element per default button", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    // Both regular buttons (.tc-btn), the D-pad (.tc-dpad), and the analog
    // stick (.tc-stick) carry a data-btn-id attribute.
    const btns = container.querySelectorAll("[data-btn-id]");
    expect(btns.length).toBe(DEFAULT_LAYOUT.length);
  });

  it("show() renders a .tc-dpad element for the D-pad button", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    const dpadEl = container.querySelector(".tc-dpad");
    expect(dpadEl).not.toBeNull();
    expect((dpadEl as HTMLElement).dataset.btnId).toBe("dpad");
    overlay.destroy();
  });

  it("D-pad element contains four directional arm children", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    const dpadEl = container.querySelector(".tc-dpad")!;
    expect(dpadEl.querySelector(".tc-dpad__arm--up")).not.toBeNull();
    expect(dpadEl.querySelector(".tc-dpad__arm--down")).not.toBeNull();
    expect(dpadEl.querySelector(".tc-dpad__arm--left")).not.toBeNull();
    expect(dpadEl.querySelector(".tc-dpad__arm--right")).not.toBeNull();
    overlay.destroy();
  });

  it("hide() removes the overlay DOM", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    overlay.hide();
    expect(container.querySelector(".touch-controls")).toBeNull();
  });

  it("visible getter reflects show/hide state", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    expect(overlay.visible).toBe(false);
    overlay.show();
    expect(overlay.visible).toBe(true);
    overlay.hide();
    expect(overlay.visible).toBe(false);
  });

  it("setEditing(true) adds editing class to overlay", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    overlay.setEditing(true);
    expect(container.querySelector(".touch-controls--editing")).not.toBeNull();
  });

  it("setEditing(false) removes editing class", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    overlay.setEditing(true);
    overlay.setEditing(false);
    expect(container.querySelector(".touch-controls--editing")).toBeNull();
  });

  it("editing getter reflects setEditing()", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    expect(overlay.editing).toBe(false);
    overlay.show();
    overlay.setEditing(true);
    expect(overlay.editing).toBe(true);
  });

  it("setSystem() switches to a different system layout", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();

    // Save a custom layout for NES with modified position
    const nesLayout = DEFAULT_LAYOUT.map((b) => ({ ...b }));
    const dpadBtn = nesLayout.find((b) => b.id === "dpad")!;
    dpadBtn.x = 33;
    saveLayout("nes", nesLayout);

    overlay.setSystem("nes");
    // After setSystem, buttons should be rebuilt
    const dpadEl = Array.from(container.querySelectorAll(".tc-dpad")).find(
      (el) => (el as HTMLElement).dataset.btnId === "dpad"
    ) as HTMLElement | undefined;

    // The left% style should reflect x=33
    expect(dpadEl?.style.left).toBe("33%");
  });

  it("hide() exits editing mode so a new show() starts in play mode", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    overlay.setEditing(true);
    expect(overlay.editing).toBe(true);

    overlay.hide();
    expect(overlay.editing).toBe(false);

    overlay.show();
    expect(container.querySelector(".touch-controls--editing")).toBeNull();
  });

  it("setSystem() keeps editing visuals coherent during rebuild", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    overlay.setEditing(true);

    overlay.setSystem("nes");

    expect(container.querySelector(".touch-controls--editing")).not.toBeNull();
  });

  it("resetToDefaults() resets layout and fires onLayoutSaved", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();

    const layout = loadLayout("psp");
    layout[0]!.x = 77;
    saveLayout("psp", layout);

    const saved: Array<{ systemId: string; layout: TouchButtonDef[] }> = [];
    overlay.onLayoutSaved = (sid, lay) => saved.push({ systemId: sid, layout: lay });

    overlay.resetToDefaults();

    expect(saved).toHaveLength(1);
    expect(saved[0]!.systemId).toBe("psp");
    // Positions should be back to defaults
    const dpadDefault = DEFAULT_LAYOUT.find((b) => b.id === "dpad")!;
    const dpadRestored = saved[0]!.layout.find((b) => b.id === "dpad")!;
    expect(dpadRestored.x).toBe(dpadDefault.x);
  });

  it("dispatches keydown/keyup on pointerdown/pointerup in play mode", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();

    const keyEvents: string[] = [];
    document.addEventListener("keydown", (e) => keyEvents.push(`down:${e.key}`));
    document.addEventListener("keyup",   (e) => keyEvents.push(`up:${e.key}`));

    const aEl = Array.from(container.querySelectorAll(".tc-btn")).find(
      (el) => (el as HTMLElement).dataset.btnId === "a"
    ) as HTMLElement | undefined;

    expect(aEl).toBeDefined();
    aEl!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1 }));
    aEl!.dispatchEvent(new PointerEvent("pointerup",   { bubbles: true, cancelable: true, pointerId: 1 }));

    expect(keyEvents).toContain("down:z");
    expect(keyEvents).toContain("up:z");
  });

  it("releases the key on pointercancel (pointer capture lost mid-press)", () => {
    // With setPointerCapture, a captured pointer fires events on the element
    // even outside its bounds.  pointercancel covers cases like the browser
    // stealing the pointer (scroll, zoom, incoming call, etc.).
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();

    const keyEvents: string[] = [];
    document.addEventListener("keydown", (e) => keyEvents.push(`down:${e.key}`));
    document.addEventListener("keyup",   (e) => keyEvents.push(`up:${e.key}`));

    const aEl = Array.from(container.querySelectorAll(".tc-btn")).find(
      (el) => (el as HTMLElement).dataset.btnId === "a"
    ) as HTMLElement | undefined;
    expect(aEl).toBeDefined();

    // Press button
    aEl!.dispatchEvent(new PointerEvent("pointerdown",  { bubbles: true, cancelable: true, pointerId: 1 }));
    expect(keyEvents).toContain("down:z");

    // Pointer is cancelled (e.g. browser interrupt)
    aEl!.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, cancelable: true, pointerId: 1 }));

    // The key must have been released
    expect(keyEvents).toContain("up:z");
  });

  it("does NOT dispatch key events while in editing mode", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    overlay.setEditing(true);

    const keyEvents: string[] = [];
    document.addEventListener("keydown", (e) => keyEvents.push(e.key));

    const downEl = Array.from(container.querySelectorAll(".tc-btn")).find(
      (el) => (el as HTMLElement).dataset.btnId === "b"
    ) as HTMLElement | undefined;
    downEl?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1 }));

    expect(keyEvents).toHaveLength(0);
  });

  it("destroy() is equivalent to hide()", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    overlay.destroy();
    expect(container.querySelector(".touch-controls")).toBeNull();
    expect(overlay.visible).toBe(false);
  });

  it("destroy() removes orientation change listeners (no rebuild after destroy)", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    overlay.destroy();

    // Trigger a resize — should not throw or rebuild since listeners were removed
    expect(() => window.dispatchEvent(new Event("resize"))).not.toThrow();
    // Overlay should remain hidden
    expect(container.querySelector(".touch-controls")).toBeNull();
  });

  it("setEditing(true) resets a displaced stick knob to centre", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();

    // Manually displace the knob to simulate an active stick position
    const stickEl = container.querySelector<HTMLElement>(".tc-stick")!;
    const knob    = stickEl.querySelector<HTMLElement>(".tc-stick__knob")!;
    knob.style.transform = "translate(calc(-50% + 20px), calc(-50% + 10px))";

    // Entering edit mode should reset the knob to centre
    overlay.setEditing(true);
    expect(knob.style.transform).toBe("translate(-50%, -50%)");
  });

  it("setEditing(true) removes tc-stick--active class from stick element", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();

    const stickEl = container.querySelector<HTMLElement>(".tc-stick")!;
    // Simulate the stick being active
    stickEl.classList.add("tc-stick--active");

    overlay.setEditing(true);
    expect(stickEl.classList.contains("tc-stick--active")).toBe(false);
  });

  it("setEditing(true) releases any currently-pressed keys", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();

    const keyEvents: string[] = [];
    document.addEventListener("keyup", (e) => keyEvents.push(e.key));

    // Press a face button
    const aEl = Array.from(container.querySelectorAll(".tc-btn")).find(
      (el) => (el as HTMLElement).dataset.btnId === "a"
    ) as HTMLElement;
    aEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1 }));

    // Enter edit mode — key should be released immediately
    overlay.setEditing(true);
    expect(keyEvents).toContain("z");
  });
});

// ── TouchControlsOverlay — D-pad directional input ───────────────────────────

describe("TouchControlsOverlay — D-pad directional input", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = makeContainer();
  });

  afterEach(() => {
    removeContainer(container);
    cleanLS("psp");
  });

  function getDpadEl(): HTMLElement {
    const el = container.querySelector<HTMLElement>(".tc-dpad");
    if (!el) throw new Error(".tc-dpad not found");
    return el;
  }

  function mockDpadRect(el: HTMLElement, size = 120) {
    // Place the element at (0,0) with the given size so that the centre is
    // at (size/2, size/2) in client coordinates.
    Object.defineProperty(el, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0, top: 0,
        width: size, height: size,
        right: size, bottom: size,
        x: 0, y: 0,
        toJSON: () => ({}),
      }),
    });
  }

  it("fires ArrowUp when pointer touches above centre", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    const dpad = getDpadEl();
    mockDpadRect(dpad);

    const keys: string[] = [];
    document.addEventListener("keydown", (e) => keys.push(e.key));

    // Centre is at (60, 60). Touch at (60, 5) → dy=-55, dx=0 → up.
    dpad.dispatchEvent(new PointerEvent("pointerdown", { clientX: 60, clientY: 5, pointerId: 1, bubbles: true, cancelable: true }));
    expect(keys).toContain("ArrowUp");
    expect(keys).not.toContain("ArrowDown");
    overlay.destroy();
  });

  it("fires ArrowDown when pointer touches below centre", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    const dpad = getDpadEl();
    mockDpadRect(dpad);

    const keys: string[] = [];
    document.addEventListener("keydown", (e) => keys.push(e.key));

    dpad.dispatchEvent(new PointerEvent("pointerdown", { clientX: 60, clientY: 115, pointerId: 1, bubbles: true, cancelable: true }));
    expect(keys).toContain("ArrowDown");
    expect(keys).not.toContain("ArrowUp");
    overlay.destroy();
  });

  it("fires ArrowLeft when pointer touches left of centre", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    const dpad = getDpadEl();
    mockDpadRect(dpad);

    const keys: string[] = [];
    document.addEventListener("keydown", (e) => keys.push(e.key));

    dpad.dispatchEvent(new PointerEvent("pointerdown", { clientX: 5, clientY: 60, pointerId: 1, bubbles: true, cancelable: true }));
    expect(keys).toContain("ArrowLeft");
    expect(keys).not.toContain("ArrowRight");
    overlay.destroy();
  });

  it("fires ArrowRight when pointer touches right of centre", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    const dpad = getDpadEl();
    mockDpadRect(dpad);

    const keys: string[] = [];
    document.addEventListener("keydown", (e) => keys.push(e.key));

    dpad.dispatchEvent(new PointerEvent("pointerdown", { clientX: 115, clientY: 60, pointerId: 1, bubbles: true, cancelable: true }));
    expect(keys).toContain("ArrowRight");
    expect(keys).not.toContain("ArrowLeft");
    overlay.destroy();
  });

  it("fires both ArrowUp and ArrowRight for diagonal up-right input", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    const dpad = getDpadEl();
    mockDpadRect(dpad);

    const keys: string[] = [];
    document.addEventListener("keydown", (e) => keys.push(e.key));

    // Touching the top-right corner: dx=+55, dy=-55 → both up and right
    dpad.dispatchEvent(new PointerEvent("pointerdown", { clientX: 115, clientY: 5, pointerId: 1, bubbles: true, cancelable: true }));
    expect(keys).toContain("ArrowUp");
    expect(keys).toContain("ArrowRight");
    overlay.destroy();
  });

  it("releases direction key when pointer moves back to centre (dead zone)", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    const dpad = getDpadEl();
    mockDpadRect(dpad);

    const downKeys: string[] = [];
    const upKeys:   string[] = [];
    document.addEventListener("keydown", (e) => downKeys.push(e.key));
    document.addEventListener("keyup",   (e) => upKeys.push(e.key));

    // Press upward
    dpad.dispatchEvent(new PointerEvent("pointerdown", { clientX: 60, clientY: 5, pointerId: 1, bubbles: true, cancelable: true }));
    expect(downKeys).toContain("ArrowUp");

    // Move to dead zone near centre
    dpad.dispatchEvent(new PointerEvent("pointermove", { clientX: 61, clientY: 59, pointerId: 1, bubbles: true }));
    expect(upKeys).toContain("ArrowUp");
    overlay.destroy();
  });

  it("releases all D-pad keys on pointerup", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    const dpad = getDpadEl();
    mockDpadRect(dpad);

    const upKeys: string[] = [];
    document.addEventListener("keyup", (e) => upKeys.push(e.key));

    dpad.dispatchEvent(new PointerEvent("pointerdown", { clientX: 60, clientY: 5, pointerId: 1, bubbles: true, cancelable: true }));
    dpad.dispatchEvent(new PointerEvent("pointerup",   { clientX: 60, clientY: 5, pointerId: 1, bubbles: true, cancelable: true }));
    expect(upKeys).toContain("ArrowUp");
    overlay.destroy();
  });

  it("does NOT fire direction keys in edit mode", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    overlay.setEditing(true);
    const dpad = getDpadEl();
    mockDpadRect(dpad);

    const keys: string[] = [];
    document.addEventListener("keydown", (e) => keys.push(e.key));

    dpad.dispatchEvent(new PointerEvent("pointerdown", { clientX: 60, clientY: 5, pointerId: 1, bubbles: true, cancelable: true }));
    expect(keys.filter((k) => k.startsWith("Arrow"))).toHaveLength(0);
    overlay.destroy();
  });

  it("arm element gains tc-dpad__arm--active class when its direction is pressed", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    const dpad = getDpadEl();
    mockDpadRect(dpad);

    dpad.dispatchEvent(new PointerEvent("pointerdown", { clientX: 60, clientY: 5, pointerId: 1, bubbles: true, cancelable: true }));
    expect(dpad.querySelector(".tc-dpad__arm--up")!.classList.contains("tc-dpad__arm--active")).toBe(true);

    dpad.dispatchEvent(new PointerEvent("pointerup", { clientX: 60, clientY: 5, pointerId: 1, bubbles: true, cancelable: true }));
    expect(dpad.querySelector(".tc-dpad__arm--up")!.classList.contains("tc-dpad__arm--active")).toBe(false);
    overlay.destroy();
  });
});

// ── TouchControlsOverlay — orientation switching ──────────────────────────────

describe("TouchControlsOverlay — orientation switching", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = makeContainer();
    // Reset to landscape stub (the testSetup default)
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false, // landscape by default
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
  });

  afterEach(() => {
    removeContainer(container);
    cleanLS("psp");
    localStorage.removeItem("rv:touch-layout-portrait:psp");
    vi.unstubAllGlobals();
  });

  it("loads portrait layout when constructed in portrait orientation", () => {
    // Simulate portrait orientation at construction time
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("portrait"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));

    // Save a portrait-specific position so we can detect which layout loaded
    const portraitLayout = DEFAULT_PORTRAIT_LAYOUT.map((b) => ({ ...b }));
    const dpadBtn = portraitLayout.find((b) => b.id === "dpad")!;
    dpadBtn.x = 99;
    saveLayout("psp", portraitLayout, true);

    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();

    const dpadEl = Array.from(container.querySelectorAll(".tc-dpad")).find(
      (el) => (el as HTMLElement).dataset.btnId === "dpad"
    ) as HTMLElement | undefined;

    expect(dpadEl?.style.left).toBe("99%");
  });

  it("rebuilds with portrait layout when a resize event switches to portrait", () => {
    // Save a distinct portrait position so we can detect the rebuild
    const portraitLayout = DEFAULT_PORTRAIT_LAYOUT.map((b) => ({ ...b }));
    portraitLayout.find((b) => b.id === "dpad")!.x = 42;
    saveLayout("psp", portraitLayout, true);

    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();

    // Confirm we started in landscape
    const dpadBefore = Array.from(container.querySelectorAll(".tc-dpad")).find(
      (el) => (el as HTMLElement).dataset.btnId === "dpad"
    ) as HTMLElement | undefined;
    expect(dpadBefore?.style.left).not.toBe("42%");

    // Switch to portrait and fire resize
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("portrait"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    window.dispatchEvent(new Event("resize"));

    // After rebuild the overlay should reflect the portrait layout
    const dpadAfter = Array.from(container.querySelectorAll(".tc-dpad")).find(
      (el) => (el as HTMLElement).dataset.btnId === "dpad"
    ) as HTMLElement | undefined;
    expect(dpadAfter?.style.left).toBe("42%");

    overlay.destroy();
  });

  it("does not rebuild if the orientation has not changed on resize", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();

    let rebuilds = 0;
    const origBuild = (overlay as unknown as { _rebuild: () => void })._rebuild?.bind(overlay);
    (overlay as unknown as { _rebuild: () => void })._rebuild = () => {
      rebuilds++;
      origBuild?.();
    };

    // Fire resize but keep same orientation (landscape → landscape)
    window.dispatchEvent(new Event("resize"));

    expect(rebuilds).toBe(0);
    overlay.destroy();
  });
});

// ── Analog stick active-class behaviour ──────────────────────────────────────

describe("TouchControlsOverlay — analog stick active class", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = makeContainer();
  });

  afterEach(() => {
    removeContainer(container);
    cleanLS("psp");
  });

  it("adds tc-stick--active on pointerdown and removes it on pointerup", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();

    const stickEl = container.querySelector<HTMLElement>(".tc-stick")!;
    expect(stickEl).not.toBeNull();

    stickEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1 }));
    expect(stickEl.classList.contains("tc-stick--active")).toBe(true);

    stickEl.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1 }));
    expect(stickEl.classList.contains("tc-stick--active")).toBe(false);
  });
});

// ── Multi-pointer handling ────────────────────────────────────────────────────

describe("TouchControlsOverlay — multi-pointer", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.parentNode?.removeChild(container);
    localStorage.removeItem("rv:touch-layout:psp");
  });

  function getButtonEl(id: string): HTMLElement {
    const el = Array.from(container.querySelectorAll(".tc-btn")).find(
      (e) => (e as HTMLElement).dataset.btnId === id
    ) as HTMLElement | undefined;
    if (!el) throw new Error(`Button "${id}" not found`);
    return el;
  }

  it("pressing a button with two simultaneous pointers fires keydown only once", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();

    const keyEvents: string[] = [];
    document.addEventListener("keydown", (e) => keyEvents.push(e.key));

    const aEl = getButtonEl("a");

    // Two pointers land on the same button
    aEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1 }));
    aEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 2 }));

    // Only one keydown should fire (pressKey guard: key already in _pressedKeys)
    expect(keyEvents.filter((k) => k === "z")).toHaveLength(1);
  });

  it("key stays pressed when first of two simultaneous pointers ends", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();

    const downKeys: string[] = [];
    const upKeys:   string[] = [];
    document.addEventListener("keydown", (e) => downKeys.push(`down:${e.key}`));
    document.addEventListener("keyup",   (e) => upKeys.push(`up:${e.key}`));

    const aEl = getButtonEl("a");

    // Both pointers land
    aEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1 }));
    aEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 2 }));

    // First pointer lifts — key must NOT be released yet (pointer 2 still active)
    aEl.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1 }));
    expect(upKeys.some((e) => e.startsWith("up:"))).toBe(false);

    // Second pointer lifts — now the key should be released
    aEl.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 2 }));
    expect(upKeys).toContain("up:z");
  });

  it("pointercancel releases key only after all active pointers are cancelled", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();

    const upKeys: string[] = [];
    document.addEventListener("keyup", (e) => upKeys.push(e.key));

    const bEl = getButtonEl("b");

    // Two pointers start
    bEl.dispatchEvent(new PointerEvent("pointerdown",  { bubbles: true, cancelable: true, pointerId: 3 }));
    bEl.dispatchEvent(new PointerEvent("pointerdown",  { bubbles: true, cancelable: true, pointerId: 4 }));

    // One pointer cancelled
    bEl.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, cancelable: true, pointerId: 3 }));
    // Key must still be held
    expect(upKeys).not.toContain("x");

    // Second pointer cancelled
    bEl.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, cancelable: true, pointerId: 4 }));
    // Now the key should be released
    expect(upKeys).toContain("x");
  });
});
