import { describe, it, expect } from "vitest";
import { getEmulatorScreenPreset, syncEmulatorViewportLayout } from "./emulatorDisplay.js";

describe("getEmulatorScreenPreset", () => {
  it("returns null when system id is missing", () => {
    expect(getEmulatorScreenPreset(null)).toBeNull();
    expect(getEmulatorScreenPreset(undefined)).toBeNull();
    expect(getEmulatorScreenPreset("")).toBeNull();
    expect(getEmulatorScreenPreset("   ")).toBeNull();
  });

  it("uses handheld / console-specific aspects", () => {
    expect(getEmulatorScreenPreset("gba")?.aspectRatio).toBe("3 / 2");
    expect(getEmulatorScreenPreset("gba")?.crispPixels).toBe(true);
    expect(getEmulatorScreenPreset("nds")?.aspectRatio).toBe("2 / 3");
    expect(getEmulatorScreenPreset("psx")?.aspectRatio).toBe("4 / 3");
    expect(getEmulatorScreenPreset("psp")?.aspectRatio).toBe("30 / 17");
  });

  it("falls back to 4:3 for unknown systems", () => {
    expect(getEmulatorScreenPreset("futureCore")?.aspectRatio).toBe("4 / 3");
  });
});

describe("syncEmulatorViewportLayout", () => {
  it("sets data attributes and CSS variable when a system is active", () => {
    const el = document.createElement("div");
    syncEmulatorViewportLayout(el, "gba");
    expect(el.dataset.emuViewport).toBe("on");
    expect(el.dataset.emuPixelated).toBe("on");
    expect(el.style.getPropertyValue("--emu-screen-ar").trim()).toBe("3 / 2");
  });

  it("clears layout hooks when system is null", () => {
    const el = document.createElement("div");
    syncEmulatorViewportLayout(el, "gba");
    syncEmulatorViewportLayout(el, null);
    expect(el.hasAttribute("data-emu-viewport")).toBe(false);
    expect(el.hasAttribute("data-emu-pixelated")).toBe(false);
    expect(el.style.getPropertyValue("--emu-screen-ar")).toBe("");
  });
});
