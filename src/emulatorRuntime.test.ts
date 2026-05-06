import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("bundled EmulatorJS runtime patches", () => {
  it("passes EJS_corePath from the loader into the runtime config", () => {
    const loader = readFileSync(resolve("data/loader.js"), "utf8");

    expect(loader).toContain("config.corePath = window.EJS_corePath");
  });

  it("registers Dreamcast/Flycast and downloads external core bundles directly", () => {
    const runtime = readFileSync(resolve("data/src/emulator.js"), "utf8");

    expect(runtime).toContain('"segaDC": ["flycast"]');
    expect(runtime).toContain('const requiresWebGL2 = ["ppsspp", "flycast"]');
    expect(runtime).toContain("this.config.corePath");
    expect(runtime).toContain("[EJS Core] Downloading external core:");
  });
});
