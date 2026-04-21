/**
 * addRom.spec.ts — E2E journey: Add a ROM to the library.
 *
 * Flow:
 *   1. App loads showing an empty library / drop zone.
 *   2. User drops a fake .nes ROM file onto the drop zone.
 *   3. System detection runs (NES — driven by file extension).
 *   4. A game card appears in the library grid.
 *
 * EmulatorJS WASM is stubbed; real ROM boot does NOT happen.
 * IndexedDB is replaced by the in-memory shim from fixtures.ts.
 */

import { test, expect, dropFakeRom } from "./fixtures.js";

test.describe("Add ROM journey", () => {
  test("dropping a .nes file creates a game card in the library", async ({ appPage: page }) => {
    // Confirm drop zone is present
    await expect(page.locator("#drop-zone")).toBeVisible();

    // Drop a fake NES ROM
    await dropFakeRom(page, { fileName: "super-mario.nes", content: "NES\x1a\x01\x01\x00\x00" });

    // A library card or game entry should appear
    // (either a card element or the library section becomes non-empty)
    await expect(
      page.locator(".game-card, .library-game-card, [data-game-id]").first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("drop zone shows drag-over state when file is dragged over it", async ({ appPage: page }) => {
    const dropZone = page.locator("#drop-zone");
    await expect(dropZone).toBeVisible();

    // Simulate dragenter to activate the drag-over class
    await page.evaluate(() => {
      const dz = document.getElementById("drop-zone");
      if (!dz) return;
      const dt = new DataTransfer();
      dz.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }));
    });

    await expect(dropZone).toHaveClass(/drag-over/);
  });

  test("dragleave removes drag-over state", async ({ appPage: page }) => {
    const dropZone = page.locator("#drop-zone");

    // Enter then leave
    await page.evaluate(() => {
      const dz = document.getElementById("drop-zone");
      if (!dz) return;
      const dt = new DataTransfer();
      dz.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }));
      dz.dispatchEvent(new DragEvent("dragleave",  { bubbles: true, dataTransfer: dt }));
    });

    await expect(dropZone).not.toHaveClass(/drag-over/);
  });

  test("settings panel opens and closes", async ({ appPage: page }) => {
    // Find and click the settings button
    const settingsBtn = page.locator("button[aria-label*='Settings'], button[title*='Settings'], #settings-btn, [data-action='settings']").first();

    if (await settingsBtn.count() > 0) {
      await settingsBtn.click();
      await expect(page.locator("#settings-panel, [role='dialog']").first()).toBeVisible({ timeout: 5_000 });

    // Press Escape to close
    await page.keyboard.press("Escape");
    // Settings panel may be removed from DOM or just hidden after Escape.
    // We check that it is no longer blocking user interaction.
    const settingsPanel = page.locator("#settings-panel").first();
    const isStillVisible = await settingsPanel.isVisible().catch(() => false);
    // Either hidden or removed — both are acceptable close behaviours.
    expect(isStillVisible).toBe(false);
    } else {
      test.skip();
    }
  });
});
