import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/testSetup.ts"],
    // Automatically restore all spies/mocks to their original implementation
    // between tests so afterEach cleanup is never accidentally omitted.
    restoreMocks: true,
    // Automatically clear mock call history (calls, instances, results) between
    // tests so assertions on call counts are always independent.
    clearMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/env.d.ts"],
      reporter: ["text", "html"],
    },
  },
});
