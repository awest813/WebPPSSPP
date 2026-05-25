/**
 * cloudSync.spec.ts - E2E journey: Save Sync settings and provider wizard.
 *
 * The WebDAV HTTP calls are intercepted so the suite never talks to a real
 * remote save account or server.
 */

import { test, expect } from "./fixtures.js";

const MOCK_PROPFIND = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/roms/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

async function openSaveSyncSettings(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.locator("#settings-panel")).toBeVisible({ timeout: 5_000 });
  await page.locator("#tab-cloud").click();
  const cloudPanel = page.locator("#tab-panel-cloud");
  await expect(cloudPanel).toBeVisible({ timeout: 5_000 });
  await expect(cloudPanel.getByRole("button", { name: /Turn on save sync/i })).toBeVisible({ timeout: 5_000 });
}

async function openCloudConnectDialog(page: import("@playwright/test").Page): Promise<void> {
  await openSaveSyncSettings(page);
  await page.locator("#tab-panel-cloud").getByRole("button", { name: /Turn on save sync/i }).click();
  await expect(
    page.locator("[aria-label='Save Sync Connection'], .cloud-wizard-box").first()
  ).toBeVisible({ timeout: 5_000 });
}

async function selectWebDavProvider(page: import("@playwright/test").Page): Promise<void> {
  const dialog = page.locator(".cloud-wizard-box");
  await dialog.getByRole("button", { name: /WebDAV save sync provider/i }).click();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.locator("#csd-url")).toBeVisible({ timeout: 5_000 });
}

test.describe("Save Sync journey", () => {
  test.beforeEach(async ({ appPage: page }) => {
    await page.route("**/mock-dav/**", async (route) => {
      const method = route.request().method().toUpperCase();
      if (method === "PROPFIND") {
        await route.fulfill({
          status: 207,
          contentType: "application/xml; charset=utf-8",
          body: MOCK_PROPFIND,
        });
      } else if (method === "OPTIONS" || method === "GET") {
        await route.fulfill({ status: 200 });
      } else if (method === "PUT" || method === "MKCOL") {
        await route.fulfill({ status: 201 });
      } else {
        await route.fulfill({ status: 200 });
      }
    });
  });

  test("Settings panel opens to the Save Sync section", async ({ appPage: page }) => {
    await openSaveSyncSettings(page);

    await expect(
      page.locator("#tab-panel-cloud").getByRole("button", { name: /Turn on save sync/i })
    ).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press("Escape");
  });

  test("Save Sync connect dialog opens when Connect button is clicked", async ({ appPage: page }) => {
    await openCloudConnectDialog(page);
    await page.keyboard.press("Escape");
  });

  test("WebDAV provider card is present in the Save Sync wizard", async ({ appPage: page }) => {
    await openCloudConnectDialog(page);

    await expect(
      page.locator("button:has-text('WebDAV')").first()
    ).toBeVisible({ timeout: 5_000 });
  });

  test("WebDAV save sync can connect with mocked credentials", async ({ appPage: page }) => {
    await openCloudConnectDialog(page);
    await selectWebDavProvider(page);

    const dialog = page.locator(".cloud-wizard-box");
    await dialog.locator("#csd-url").fill("/mock-dav/saves");
    await dialog.locator("#csd-user").fill("demo-user");
    await dialog.locator("#csd-pass").fill("demo-pass");
    await dialog.getByRole("button", { name: "Connect" }).click();

    await expect(page.locator(".cloud-wizard-box")).toBeHidden({ timeout: 5_000 });
    await expect(page.locator(".cloud-save-status-row")).toContainText("Connected", { timeout: 5_000 });
    await expect(page.locator(".cloud-save-status-row")).toContainText("WebDAV sync active");
  });
});
