/**
 * cloudSync.spec.ts - E2E journey: cloud settings and provider wizard.
 *
 * The WebDAV HTTP calls are intercepted so the suite never talks to a real
 * cloud account or server.
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

async function openCloudStorageSettings(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.locator("#settings-panel")).toBeVisible({ timeout: 5_000 });
  // Click the Cloud Storage tab by its role and name
  await page.getByRole("tab", { name: "Cloud Storage" }).click();
  // Wait for the cloud tab content to appear
  await expect(page.locator(".cloud-bar, .cloud-connect-btn, button:has-text('Connect')").first()).toBeVisible({ timeout: 5_000 });
}

async function openCloudConnectDialog(page: import("@playwright/test").Page): Promise<void> {
  await openCloudStorageSettings(page);
  await page.locator("button:has-text('Connect')").first().click();
  await expect(
    page.locator("[aria-label*='Cloud Connection'], .cloud-wizard-box").first()
  ).toBeVisible({ timeout: 5_000 });
}

async function selectWebDavProvider(page: import("@playwright/test").Page): Promise<void> {
  const dialog = page.locator("[aria-label='Cloud Connection']");
  await dialog.locator("button:has-text('WebDAV')").click();
  await dialog.locator("button:has-text('Next')").click();
  await expect(dialog.getByLabel("Server URL")).toBeVisible({ timeout: 5_000 });
}

test.describe("Cloud Sync journey", () => {
  test.beforeEach(async ({ appPage: page }) => {
    await page.route("**/mock-dav/**", (route) => {
      const method = route.request().method().toUpperCase();
      if (method === "PROPFIND") {
        route.fulfill({
          status: 207,
          contentType: "application/xml; charset=utf-8",
          body: MOCK_PROPFIND,
        });
      } else if (method === "OPTIONS" || method === "GET") {
        route.fulfill({ status: 200 });
      } else if (method === "PUT" || method === "MKCOL") {
        route.fulfill({ status: 201 });
      } else {
        route.fulfill({ status: 200 });
      }
    });
  });

  test("Settings panel opens to the Cloud Storage section", async ({ appPage: page }) => {
    await openCloudStorageSettings(page);

    await expect(
      page.locator(".cloud-bar, .cloud-connect-btn, button:has-text('Connect')").first()
    ).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press("Escape");
  });

  test("Cloud connect dialog opens when Connect button is clicked", async ({ appPage: page }) => {
    await openCloudConnectDialog(page);
    await page.keyboard.press("Escape");
  });

  test("WebDAV provider card is present in the cloud wizard", async ({ appPage: page }) => {
    await openCloudConnectDialog(page);

    await expect(
      page.locator("button:has-text('WebDAV')").first()
    ).toBeVisible({ timeout: 5_000 });
  });

  test("WebDAV cloud save backup can connect with mocked credentials", async ({ appPage: page }) => {
    await openCloudConnectDialog(page);
    await selectWebDavProvider(page);

    const dialog = page.locator("[aria-label='Cloud Connection']");
    await dialog.getByLabel("Server URL").fill("/mock-dav/saves");
    await dialog.getByLabel("Username").fill("demo-user");
    await dialog.getByLabel("Password").fill("demo-pass");
    await dialog.getByRole("button", { name: "Connect" }).click();

    await expect(page.locator("[aria-label='Cloud Connection']")).toBeHidden({ timeout: 5_000 });
    await expect(page.locator(".cloud-save-status-row")).toContainText("Connected", { timeout: 5_000 });
    await expect(page.locator(".cloud-save-status-row")).toContainText("WebDAV backup active");
  });
});
