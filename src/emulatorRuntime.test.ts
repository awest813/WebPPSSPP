import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("bundled EmulatorJS runtime patches", () => {
  it("passes EJS_corePath from the loader into the runtime config", () => {
    const loader = readFileSync(resolve("data/loader.js"), "utf8");

    expect(loader).toContain("config.corePath = window.EJS_corePath");
  });

  it("registers runtime core guards and downloads external core bundles directly", () => {
    const runtime = readFileSync(resolve("data/src/emulator.js"), "utf8");

    expect(runtime).toContain('"segaDC": ["flycast"]');
    expect(runtime).toContain('"3ds": ["azahar"]');
    expect(runtime).toContain('const requiresThreads = ["ppsspp", "dosbox_pure", "azahar"]');
    expect(runtime).toContain('const requiresWebGL2 = ["ppsspp", "flycast", "azahar"]');
    expect(runtime).toContain("this.config.corePath");
    expect(runtime).toContain("[EJS Core] Downloading external core:");
  });

  it("strips cache-busting query strings before matching EJS_paths keys", () => {
    const runtime = readFileSync(resolve("data/src/emulator.js"), "utf8");

    expect(runtime).toContain('const filePathKey = path.split("/").pop().split("?")[0].split("#")[0];');
    expect(runtime).toContain("this.config.filePaths[filePathKey]");
  });

  it("routes PPSSPP asset zips through EJS_paths before falling back local", () => {
    const gameManager = readFileSync(resolve("data/src/GameManager.js"), "utf8");

    expect(gameManager).toContain('this.EJS.config?.filePaths?.["ppsspp-assets.zip"]');
    expect(gameManager).toContain('"data/cores/ppsspp-assets.zip"');
  });
});
