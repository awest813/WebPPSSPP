import { readFileSync, writeFileSync, existsSync, cpSync, rmSync } from "node:fs";
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

/**
 * Emit `dist/pwa-precache.json`: every hashed JS/CSS/WASM under ./assets plus shell URLs.
 * The COI service worker loads this at install time so the installed PWA precaches the full app shell.
 */
function pwaPrecacheManifestPlugin(): Plugin {
  return {
    name: "pwa-precache-manifest",
    closeBundle() {
      const distDir = resolve("dist");
      const indexPath = resolve(distDir, "index.html");
      if (!existsSync(indexPath)) return;

      const urls = new Set<string>();
      const addRel = (rel: string) => {
        if (!rel || !rel.startsWith("assets/")) return;
        urls.add(`./${rel}`);
      };

      const html = readFileSync(indexPath, "utf-8");
      for (const m of html.matchAll(/\b(?:src|href)="(\.\/assets\/[^"]+)"/g)) {
        addRel(m[1]!.replace(/^\.\//, ""));
      }

      const viteManifestPath = resolve(distDir, ".vite", "manifest.json");
      if (existsSync(viteManifestPath)) {
        try {
          const vm = JSON.parse(readFileSync(viteManifestPath, "utf-8")) as Record<
            string,
            { file?: string; css?: string[]; assets?: string[] }
          >;
          for (const chunk of Object.values(vm)) {
            if (chunk.file) addRel(chunk.file);
            for (const c of chunk.css ?? []) addRel(c);
            for (const a of chunk.assets ?? []) addRel(a);
          }
        } catch {
          // Non-fatal — HTML-derived list is enough for the critical path.
        }
      }

      urls.add("./index.html");
      urls.add("./manifest.json");
      urls.add("./audio-processor.js");

      const list = [...urls]
        .filter((u) => {
          if (u === "./index.html" || u === "./manifest.json" || u === "./audio-processor.js") return true;
          if (!u.startsWith("./assets/")) return false;
          const tail = u.slice("./assets/".length);
          return tail.length > 0 && !tail.includes("..") && !tail.startsWith("/");
        })
        .sort();
      writeFileSync(resolve(distDir, "pwa-precache.json"), `${JSON.stringify(list)}\n`, "utf-8");
      console.info(`[pwa-precache-manifest] ${list.length} URLs for service worker precache`);
    },
  };
}

export default defineConfig({
  // Serve from repo root; Vite will pick up index.html automatically.
  root: ".",
  plugins: [copyEmulatorDataPlugin(), pwaPrecacheManifestPlugin()],

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
    manifest: ".vite/manifest.json",
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
          if (id.includes("/src/multiplayer.") || id.includes("/src/netplay/")) {
            return "multiplayer";
          }
          if (id.includes("/src/cloudSave.") || id.includes("/src/saveService.") || id.includes("/src/saves.")) {
            return "saves";
          }
          if (id.includes("/src/ui/modals.")) {
            return "modals";
          }
          if (id.includes("/src/ui/virtualGrid.")) {
            return "virtualgrid";
          }
          if (id.includes("/src/ui/highlightsPanel.")) {
            return "highlights";
          }
        },
      },
    },
  },
});
