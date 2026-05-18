import { defineConfig, devices } from "@playwright/test";

const E2E_PORT = Number(process.env.E2E_PORT ?? 5177);
const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/**
 * Playwright configuration for RetroOasis integration tests.
 *
 * Tests live in tests/e2e/ and run against the Vite dev server.
 * The server is started automatically when running `npm run test:e2e`.
 *
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["list"],
  ],
  use: {
    /** Base URL pointing at the Vite dev server. */
    baseURL: E2E_BASE_URL,
    trace: "on-first-retry",
    // Fewer flaky clicks while the in-game menu glass transition runs
    reducedMotion: "reduce",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], reducedMotion: "reduce" },
    },
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${E2E_PORT} --strictPort`,
    url: E2E_BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
