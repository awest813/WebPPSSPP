import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  showConfirmDialog,
  pickSystem,
  showGamePickerDialog,
  showArchiveEntryPickerDialog,
  showCoverArtPickerDialog,
  isTopmostOverlay,
} from "./modals.js";
import type { SystemInfo } from "../systems.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeSystem(id: string, name: string, shortName: string): SystemInfo {
  return {
    id,
    name,
    shortName,
    extensions: ["bin"],
    color: "#555",
    experimental: false,
    stabilityNotice: null,
    touchControlMode: "overlay",
    coreOptions: {},
    biasedFor: [],
  } as unknown as SystemInfo;
}

// Mount the static system-picker DOM used by pickSystem()
function mountSystemPickerDom(): void {
  const extra = document.createElement("div");
  extra.innerHTML = `
    <div id="system-picker" hidden>
      <div id="system-picker-subtitle"></div>
      <div id="system-picker-list"></div>
      <button id="system-picker-close" type="button">Close</button>
      <div id="system-picker-backdrop"></div>
    </div>
  `;
  document.body.appendChild(extra);
}

// ── showConfirmDialog ─────────────────────────────────────────────────────────

describe("showConfirmDialog", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("resolves true when the confirm button is clicked", async () => {
    const promise = showConfirmDialog("Are you sure?", { title: "Delete", confirmLabel: "Yes" });
    await new Promise((r) => requestAnimationFrame(r));
    const btn = document.querySelector<HTMLButtonElement>(".btn--primary");
    expect(btn).toBeTruthy();
    btn!.click();
    expect(await promise).toBe(true);
  });

  it("resolves false when the cancel button is clicked", async () => {
    const promise = showConfirmDialog("Are you sure?");
    await new Promise((r) => requestAnimationFrame(r));
    const btn = document.querySelector<HTMLButtonElement>(".btn:not(.btn--primary):not(.btn--danger-filled)");
    expect(btn).toBeTruthy();
    btn!.click();
    expect(await promise).toBe(false);
  });

  it("resolves false when the backdrop is clicked", async () => {
    const promise = showConfirmDialog("Backdrop test");
    const overlay = document.querySelector<HTMLElement>(".confirm-overlay")!;
    overlay.click();
    expect(await promise).toBe(false);
  });

  it("resolves false when Escape is pressed and the overlay is topmost", async () => {
    const promise = showConfirmDialog("Escape test");
    await new Promise((r) => requestAnimationFrame(r));
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, composed: true }),
    );
    expect(await promise).toBe(false);
  });

  it("applies btn--danger-filled class to confirm button when isDanger is true", async () => {
    const promise = showConfirmDialog("Danger!", { isDanger: true });
    await new Promise((r) => requestAnimationFrame(r));
    const dangerBtn = document.querySelector<HTMLButtonElement>(".btn--danger-filled");
    expect(dangerBtn).toBeTruthy();
    dangerBtn!.click();
    await promise;
  });

  it("focuses the confirm button after rendering", async () => {
    const focusSpy = vi.spyOn(HTMLButtonElement.prototype, "focus");
    const promise = showConfirmDialog("Focus test", { confirmLabel: "Go" });
    await new Promise((r) => requestAnimationFrame(r));
    expect(focusSpy).toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>(".confirm-footer .btn")!.click();
    await promise;
  });

  it("removes the Escape handler after the dialog is resolved", async () => {
    const promise = showConfirmDialog("Cleanup test");
    document.querySelector<HTMLButtonElement>(".confirm-footer .btn")!.click();
    await promise;

    // A second Escape should not throw or do anything unexpected
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    // No assertion needed — absence of errors is the expectation
  });
});

// ── isTopmostOverlay ──────────────────────────────────────────────────────────

describe("isTopmostOverlay", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("returns false when there are no confirm overlays", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    expect(isTopmostOverlay(div)).toBe(false);
  });

  it("returns true for the single confirm overlay when only one exists", async () => {
    const promise = showConfirmDialog("Single overlay");
    const overlay = document.querySelector<HTMLElement>(".confirm-overlay")!;
    expect(isTopmostOverlay(overlay)).toBe(true);
    overlay.click();
    await promise;
  });

  it("returns true only for the last overlay when two are stacked", async () => {
    const p1 = showConfirmDialog("First");
    const p2 = showConfirmDialog("Second");

    const overlays = Array.from(document.querySelectorAll<HTMLElement>(".confirm-overlay"));
    expect(overlays.length).toBe(2);
    expect(isTopmostOverlay(overlays[0]!)).toBe(false);
    expect(isTopmostOverlay(overlays[1]!)).toBe(true);

    // Clean up
    overlays[1]!.click();
    overlays[0]!.click();
    await p1;
    await p2;
  });
});

// ── pickSystem ────────────────────────────────────────────────────────────────

describe("pickSystem", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mountSystemPickerDom();
  });

  it("resolves with the chosen system when a system button is clicked", async () => {
    const systems = [makeSystem("psp", "PlayStation Portable", "PSP"), makeSystem("nes", "Nintendo", "NES")];
    const promise = pickSystem("game.bin", systems);

    await new Promise((r) => requestAnimationFrame(r));
    const btns = document.querySelectorAll<HTMLButtonElement>(".system-pick-btn");
    expect(btns.length).toBe(2);
    btns[1]!.click();

    const result = await promise;
    expect(result?.id).toBe("nes");
  });

  it("resolves null when the close button is clicked", async () => {
    const systems = [makeSystem("psp", "PSP", "PSP")];
    const promise = pickSystem("game.bin", systems);

    document.getElementById("system-picker-close")!.click();
    expect(await promise).toBeNull();
  });

  it("resolves null when the backdrop is clicked", async () => {
    const systems = [makeSystem("psp", "PSP", "PSP")];
    const promise = pickSystem("game.bin", systems);

    document.getElementById("system-picker-backdrop")!.click();
    expect(await promise).toBeNull();
  });

  it("resolves null when Escape is pressed", async () => {
    const systems = [makeSystem("psp", "PSP", "PSP")];
    const promise = pickSystem("game.bin", systems);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(await promise).toBeNull();
  });

  it("hides the panel after resolution", async () => {
    const systems = [makeSystem("psp", "PSP", "PSP")];
    const promise = pickSystem("game.bin", systems);

    document.getElementById("system-picker-close")!.click();
    await promise;

    expect(document.getElementById("system-picker")!.hidden).toBe(true);
  });

  it("focuses the first system button on open", async () => {
    const systems = [makeSystem("psp", "PSP", "PSP"), makeSystem("nes", "NES", "NES")];
    const focusSpy = vi.spyOn(HTMLButtonElement.prototype, "focus");

    const promise = pickSystem("game.bin", systems);
    await new Promise((r) => requestAnimationFrame(r));

    expect(focusSpy).toHaveBeenCalled();

    document.getElementById("system-picker-close")!.click();
    await promise;
  });

  it("uses the custom subtitle when provided", async () => {
    const systems = [makeSystem("psp", "PSP", "PSP")];
    const promise = pickSystem("game.bin", systems, "Pick a console");

    const subtitle = document.getElementById("system-picker-subtitle")!;
    expect(subtitle.textContent).toBe("Pick a console");

    document.getElementById("system-picker-close")!.click();
    await promise;
  });

  it("does not resolve twice if both close and backdrop fire", async () => {
    const systems = [makeSystem("psp", "PSP", "PSP")];
    const promise = pickSystem("game.bin", systems);

    document.getElementById("system-picker-close")!.click();
    document.getElementById("system-picker-backdrop")!.click();
    const result = await promise;
    expect(result).toBeNull();
  });
});

// ── showGamePickerDialog ──────────────────────────────────────────────────────

describe("showGamePickerDialog", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("resolves with the chosen game when its button is clicked", async () => {
    const games = [
      { id: "g1", name: "Mario", systemId: "nes", fileName: "mario.nes", size: 512, addedAt: 0, lastPlayedAt: null },
      { id: "g2", name: "Zelda", systemId: "nes", fileName: "zelda.nes", size: 512, addedAt: 0, lastPlayedAt: null },
    ];
    const promise = showGamePickerDialog("Pick a game", "Choose one:", games);

    const btns = document.querySelectorAll<HTMLButtonElement>(".system-pick-btn");
    expect(btns.length).toBe(2);
    btns[1]!.click();

    const result = await promise;
    expect(result?.id).toBe("g2");
  });

  it("resolves null when the cancel button is clicked", async () => {
    const games = [{ id: "g1", name: "Mario", systemId: "nes", fileName: "mario.nes", size: 512, addedAt: 0, lastPlayedAt: null }];
    const promise = showGamePickerDialog("Pick", "Choose:", games);

    const cancelBtn = document.querySelector<HTMLButtonElement>(".confirm-box .btn");
    cancelBtn!.click();

    expect(await promise).toBeNull();
  });

  it("resolves null when Escape is pressed and this is the topmost overlay", async () => {
    const games = [{ id: "g1", name: "Mario", systemId: "nes", fileName: "mario.nes", size: 512, addedAt: 0, lastPlayedAt: null }];
    const promise = showGamePickerDialog("Pick", "Choose:", games);
    await new Promise((r) => requestAnimationFrame(r));

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, composed: true }),
    );

    expect(await promise).toBeNull();
  });

  it("resolves null when the backdrop is clicked", async () => {
    const games = [{ id: "g1", name: "Mario", systemId: "nes", fileName: "mario.nes", size: 512, addedAt: 0, lastPlayedAt: null }];
    const promise = showGamePickerDialog("Pick", "Choose:", games);

    const overlay = document.querySelector<HTMLElement>(".confirm-overlay")!;
    overlay.click();

    expect(await promise).toBeNull();
  });
});

// ── showArchiveEntryPickerDialog ──────────────────────────────────────────────

describe("showArchiveEntryPickerDialog", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  const makeEntry = (name: string) => ({
    name,
    blob: new Blob([name]),
    size: name.length,
  });

  it("resolves with the chosen entry when its button is clicked", async () => {
    const entries = [makeEntry("mario.nes"), makeEntry("zelda.nes")];
    const promise = showArchiveEntryPickerDialog("zip", entries);

    const btns = document.querySelectorAll<HTMLButtonElement>(".game-picker-btn");
    expect(btns.length).toBe(2);
    btns[0]!.click();

    const result = await promise;
    expect(result?.name).toBe("mario.nes");
  });

  it("resolves null when cancel is clicked", async () => {
    const entries = [makeEntry("game.nes")];
    const promise = showArchiveEntryPickerDialog("zip", entries);

    document.querySelector<HTMLButtonElement>(".confirm-footer .btn")!.click();
    expect(await promise).toBeNull();
  });

  it("resolves null when Escape is pressed", async () => {
    const entries = [makeEntry("game.nes")];
    const promise = showArchiveEntryPickerDialog("zip", entries);
    await new Promise((r) => requestAnimationFrame(r));

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, composed: true }),
    );

    expect(await promise).toBeNull();
  });

  it("resolves null when backdrop is clicked", async () => {
    const entries = [makeEntry("game.nes")];
    const promise = showArchiveEntryPickerDialog("zip", entries);

    document.querySelector<HTMLElement>(".confirm-overlay")!.click();
    expect(await promise).toBeNull();
  });

  it("does not double-resolve when close is triggered twice", async () => {
    const entries = [makeEntry("game.nes")];
    const resolveSpy = vi.fn();
    const promise = showArchiveEntryPickerDialog("zip", entries).then((r) => { resolveSpy(r); return r; });

    const cancelBtn = document.querySelector<HTMLButtonElement>(".confirm-footer .btn")!;
    cancelBtn.click();
    cancelBtn.click();

    await promise;
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  it("shows a pretty archive format name in the description", () => {
    const promise = showArchiveEntryPickerDialog("7z", [makeEntry("rom.nes")]);
    const body = document.querySelector<HTMLElement>(".confirm-body")!;
    expect(body.textContent).toContain("7Z");
    document.querySelector<HTMLButtonElement>(".confirm-footer .btn")!.click();
    return promise;
  });
});

// ── showCoverArtPickerDialog (offline discover UX) ────────────────────────────

describe("showCoverArtPickerDialog", () => {
  let onLineSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
    onLineSpy = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  });

  afterEach(() => {
    onLineSpy?.mockRestore();
    onLineSpy = null;
  });

  it("keeps Search & pick enabled when online", async () => {
    const promise = showCoverArtPickerDialog("My Game", false);
    await new Promise((r) => requestAnimationFrame(r));
    const discover = document.querySelector<HTMLButtonElement>(".cover-art-btn--discover");
    expect(discover).toBeTruthy();
    expect(discover!.disabled).toBe(false);
    expect(document.querySelector(".cover-art-panel--discover-offline")).toBeNull();
    expect(
      document.querySelector(".cover-art-panel--discover .cover-art-panel__label")?.textContent,
    ).toContain("Discover online");
    document.querySelector<HTMLButtonElement>(".confirm-footer .btn")!.click();
    await promise;
  });

  it("disables discover and shows offline hint when navigator reports offline", async () => {
    onLineSpy!.mockReturnValue(false);
    const promise = showCoverArtPickerDialog("My Game", false);
    await new Promise((r) => requestAnimationFrame(r));
    const discover = document.querySelector<HTMLButtonElement>(".cover-art-btn--discover");
    expect(discover!.disabled).toBe(true);
    expect(discover!.getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector(".cover-art-panel--discover-offline")).toBeTruthy();
    expect(
      document.querySelector(".cover-art-panel--discover .cover-art-panel__label")?.textContent,
    ).toContain("Unavailable offline");
    expect(document.querySelector(".cover-art-panel__hint--offline")?.textContent).toMatch(/offline/i);
    document.querySelector<HTMLButtonElement>(".confirm-footer .btn")!.click();
    await promise;
  });
});
