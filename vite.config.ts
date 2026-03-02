import { defineConfig } from "vite";

export default defineConfig({
  // Serve from repo root; Vite will pick up index.html automatically.
  root: ".",

  server: {
    port: 5173,
    // PPSSPP core requires SharedArrayBuffer, which is gated behind
    // Cross-Origin Isolation (COOP + COEP). The dev server sets these
    // headers directly; for static production deployments the included
    // coi-serviceworker.js injects them at the service-worker level.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },

  preview: {
    port: 4173,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },

  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "index.html",
      output: {
        /**
         * Code splitting strategy (Phase 5):
         *
         * - core: emulator engine, system definitions, performance detection,
         *         game library, saves, BIOS — everything needed for the initial
         *         paint and first game launch.
         * - tools: archive extraction and ROM patching — lazily loaded only
         *          when the user drops a ZIP or patch file. Keeps the initial
         *          bundle ~15 KB smaller.
         * - touch: virtual gamepad overlay — lazily loaded only on first game
         *          start on a touch device.
         */
        manualChunks(id: string) {
          if (id.includes("/src/archive.") || id.includes("/src/patcher.")) {
            return "tools";
          }
          if (id.includes("/src/touchControls.")) {
            return "touch";
          }
        },
      },
    },
  },
});
