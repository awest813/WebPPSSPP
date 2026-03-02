/**
 * touchControls.test.ts — Tests for the Phase 5 virtual gamepad overlay.
 *
 * Covers:
 *   - Default layout structure (button count, required fields)
 *   - Layout persistence (save → load round-trip, partial restore, reset)
 *   - isTouchDevice() detection
 *   - Haptic helpers (vibrate call routing)
 *   - TouchControlsOverlay lifecycle (show, hide, setEditing, setSystem)
 *   - Key event dispatch on button press/release
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_LAYOUT,
  loadLayout,
  saveLayout,
  resetLayout,
  isTouchDevice,
  vibratePress,
  vibrateRelease,
  TouchControlsOverlay,
  type TouchButtonDef,
} from "./touchControls.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const LS_KEY = (sys: string) => `rv:touch-layout:${sys}`;

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
  it("contains 12 buttons", () => {
    expect(DEFAULT_LAYOUT).toHaveLength(12);
  });

  it("includes all required D-pad buttons", () => {
    const ids = DEFAULT_LAYOUT.map((b) => b.id);
    expect(ids).toContain("up");
    expect(ids).toContain("down");
    expect(ids).toContain("left");
    expect(ids).toContain("right");
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
    layout[0].x = 999;
    const layout2 = loadLayout("__test_isolation__");
    expect(layout2[0].x).not.toBe(999);
    cleanLS("__test_isolation__");
  });
});

// ── loadLayout ────────────────────────────────────────────────────────────────

describe("loadLayout", () => {
  const SYS = "test_load";

  afterEach(() => cleanLS(SYS));

  it("returns defaults when no saved layout exists", () => {
    const layout = loadLayout(SYS);
    expect(layout).toHaveLength(DEFAULT_LAYOUT.length);
    expect(layout[0].id).toBe(DEFAULT_LAYOUT[0].id);
  });

  it("restores saved positions on round-trip", () => {
    const layout = loadLayout(SYS);
    layout[0].x = 42;
    layout[0].y = 77;
    saveLayout(SYS, layout);

    const restored = loadLayout(SYS);
    expect(restored[0].x).toBeCloseTo(42);
    expect(restored[0].y).toBeCloseTo(77);
  });

  it("falls back to defaults for buttons absent from the saved blob", () => {
    // Save only partial layout (missing some buttons)
    localStorage.setItem(LS_KEY(SYS), JSON.stringify([{ id: "up", x: 5, y: 5 }]));
    const layout = loadLayout(SYS);
    // "up" should have the saved position
    const upBtn = layout.find((b) => b.id === "up")!;
    expect(upBtn.x).toBe(5);
    // "down" was not saved — should get the default
    const downBtn = layout.find((b) => b.id === "down")!;
    const defaultDown = DEFAULT_LAYOUT.find((b) => b.id === "down")!;
    expect(downBtn.x).toBe(defaultDown.x);
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
    layout[2].x = 55;
    layout[2].y = 66;
    saveLayout(SYS, layout);

    const raw = localStorage.getItem(LS_KEY(SYS));
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Array<{ id: string; x: number; y: number }>;
    const entry = parsed.find((p) => p.id === layout[2].id)!;
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
    layout[0].x = 88;
    saveLayout(SYS, layout);

    const defaults = resetLayout(SYS);
    expect(defaults[0].x).toBe(DEFAULT_LAYOUT[0].x);
    expect(localStorage.getItem(LS_KEY(SYS))).toBeNull();
  });
});

// ── isTouchDevice ─────────────────────────────────────────────────────────────

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

  it("show() creates one button element per default button", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    const btns = container.querySelectorAll(".tc-btn");
    expect(btns.length).toBe(DEFAULT_LAYOUT.length);
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
    const upBtn = nesLayout.find((b) => b.id === "up")!;
    upBtn.x = 33;
    saveLayout("nes", nesLayout);

    overlay.setSystem("nes");
    // After setSystem, buttons should be rebuilt; the overlay re-appears
    const upEl = Array.from(container.querySelectorAll(".tc-btn")).find(
      (el) => (el as HTMLElement).dataset.btnId === "up"
    ) as HTMLElement | undefined;

    // The left% style should reflect x=33
    expect(upEl?.style.left).toBe("33%");
  });

  it("resetToDefaults() resets layout and fires onLayoutSaved", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();

    const layout = loadLayout("psp");
    layout[0].x = 77;
    saveLayout("psp", layout);

    const saved: Array<{ systemId: string; layout: TouchButtonDef[] }> = [];
    overlay.onLayoutSaved = (sid, lay) => saved.push({ systemId: sid, layout: lay });

    overlay.resetToDefaults();

    expect(saved).toHaveLength(1);
    expect(saved[0].systemId).toBe("psp");
    // Positions should be back to defaults
    const upDefault = DEFAULT_LAYOUT.find((b) => b.id === "up")!;
    const upRestored = saved[0].layout.find((b) => b.id === "up")!;
    expect(upRestored.x).toBe(upDefault.x);
  });

  it("dispatches keydown/keyup on mousedown/mouseup in play mode", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();

    const keyEvents: string[] = [];
    document.addEventListener("keydown", (e) => keyEvents.push(`down:${e.key}`));
    document.addEventListener("keyup",   (e) => keyEvents.push(`up:${e.key}`));

    const upEl = Array.from(container.querySelectorAll(".tc-btn")).find(
      (el) => (el as HTMLElement).dataset.btnId === "up"
    ) as HTMLElement | undefined;

    expect(upEl).toBeDefined();
    upEl!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    upEl!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(keyEvents).toContain("down:ArrowUp");
    expect(keyEvents).toContain("up:ArrowUp");
  });

  it("does NOT dispatch key events while in editing mode", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    overlay.setEditing(true);

    const keyEvents: string[] = [];
    document.addEventListener("keydown", (e) => keyEvents.push(e.key));

    const downEl = Array.from(container.querySelectorAll(".tc-btn")).find(
      (el) => (el as HTMLElement).dataset.btnId === "down"
    ) as HTMLElement | undefined;
    downEl?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(keyEvents).toHaveLength(0);
  });

  it("destroy() is equivalent to hide()", () => {
    const overlay = new TouchControlsOverlay(container, "psp", false);
    overlay.show();
    overlay.destroy();
    expect(container.querySelector(".touch-controls")).toBeNull();
    expect(overlay.visible).toBe(false);
  });
});
