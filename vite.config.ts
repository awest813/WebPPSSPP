import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

function copyEmulatorDataPlugin(): Plugin {
  return {
    name: "copy-emulator-data",
    closeBundle() {
      const source = resolve("data");
      const target = resolve("dist", "data");
      if (!existsSync(source)) return;
      if (existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
      }
      cpSync(source, target, { recursive: true });
    },
  };
}

export default defineConfig({
  // Serve from repo root; Vite will pick up index.html automatically.
  root: ".",
  plugins: [copyEmulatorDataPlugin()],

  // Base public path for GitHub Pages deployment (https://<user>.github.io/WebPPSSPP/).
  // Has no effect during local `vite dev` because the dev server serves from /.
  base: "./",

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
          if (id.includes("/src/multiplayer.") || id.includes("/src/netplay/")) {
            return "multiplayer";
          }
          if (id.includes("/src/cloudSave.") || id.includes("/src/saveService.") || id.includes("/src/saves.")) {
            return "saves";
          }
          if (id.includes("/src/ui.ts") || id.includes("/src/compatibility.")) {
            // Keep UI and compatibility in the main bundle for now as they are core to landing,
            // but we could split more specific UI panels later if needed.
          }
        },
      },
    },
  },
});
