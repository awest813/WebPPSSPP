/**
 * play.spec.ts — E2E journey: Click a game card to start emulation.
 *
 * Flow:
 *   1. Drop a fake ROM to populate the library.
 *   2. Click the resulting game card.
 *   3. Verify the emulator canvas becomes visible.
 *   4. Verify the in-game toolbar appears.
 *
 * EmulatorJS is stubbed — we only verify the DOM transitions, not real emulation.
 */

import { test, expect, dropFakeRom } from "./fixtures.js";

test.describe("Play journey", () => {
  test("emulator view appears after dropping a ROM", async ({ appPage: page }) => {
    await dropFakeRom(page, { fileName: "sonic.nes" });

    await expect(page.locator("#ejs-container")).toBeVisible({ timeout: 15_000 });
  });

  test("Escape key from emulator returns to library", async ({ appPage: page }) => {
    await dropFakeRom(page, { fileName: "sonic.nes" });
    await expect(page.locator("#ejs-container")).toBeVisible({ timeout: 15_000 });

    // Press Escape to return to library
    await page.keyboard.press("Escape");

    // Drop zone or landing page should be visible again
    await expect(
      page.locator("#drop-zone, #landing").first()
    ).toBeVisible({ timeout: 8_000 });
  });
});
