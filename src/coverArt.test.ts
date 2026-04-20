import { describe, it, expect } from "vitest";
import {
  normalizeRomName,
  tokenizeName,
  diceCoefficient,
  systemIdToCollectionFolders,
  listGamesMissingCoverArt,
  fetchAndValidateCoverArt,
  GitHubCoverArtProvider,
  AUTO_APPLY_CONFIDENCE_THRESHOLD,
} from "./coverArt.js";
import type { GameMetadata } from "./library.js";

// ── normalizeRomName ─────────────────────────────────────────────────────────

describe("normalizeRomName", () => {
  it("returns empty string for empty input", () => {
    expect(normalizeRomName("")).toBe("");
  });

  it("strips file extensions", () => {
    expect(normalizeRomName("Super Mario World.smc")).toBe("super mario world");
    expect(normalizeRomName("Zelda.nes")).toBe("zelda");
  });

  it("strips parenthesised region / language tags", () => {
    expect(normalizeRomName("Super Mario World (USA).smc")).toBe("super mario world");
    expect(normalizeRomName("Chrono Trigger (USA) (En,Fr,De).sfc")).toBe("chrono trigger");
  });

  it("strips bracketed dump tags", () => {
    expect(normalizeRomName("Zelda [!].nes")).toBe("zelda");
    expect(normalizeRomName("Sonic [b1][h2].bin")).toBe("sonic");
  });

  it("strips revision and disc markers", () => {
    expect(normalizeRomName("Final Fantasy VII (Disc 1).bin")).toBe("final fantasy vii");
    expect(normalizeRomName("Pokemon Red (Rev A).gb")).toBe("pokemon red");
  });

  it("normalises punctuation and case", () => {
    expect(normalizeRomName("Mega_Man-2!.nes")).toBe("mega man 2");
  });

  it("handles path prefixes", () => {
    expect(normalizeRomName("roms/snes/Super Metroid (USA).smc")).toBe("super metroid");
  });

  it("does not strip suffix that looks too long to be an extension", () => {
    // e.g. "Pocahontas" — no real extension; must not lose the last word.
    expect(normalizeRomName("Pocahontas")).toBe("pocahontas");
  });
});

// ── tokenizeName ─────────────────────────────────────────────────────────────

describe("tokenizeName", () => {
  it("splits on whitespace", () => {
    expect(tokenizeName("super mario world")).toEqual(["super", "mario", "world"]);
  });
  it("returns [] for empty", () => {
    expect(tokenizeName("")).toEqual([]);
  });
});

// ── diceCoefficient ──────────────────────────────────────────────────────────

describe("diceCoefficient", () => {
  it("is 1.0 for identical strings", () => {
    expect(diceCoefficient("zelda", "zelda")).toBe(1);
  });

  it("is 1.0 for two empty strings", () => {
    expect(diceCoefficient("", "")).toBe(1);
  });

  it("is 0 when exactly one side is empty", () => {
    expect(diceCoefficient("zelda", "")).toBe(0);
    expect(diceCoefficient("", "zelda")).toBe(0);
  });

  it("ranks closer matches higher", () => {
    const a = diceCoefficient("super mario world", "super mario world");
    const b = diceCoefficient("super mario world", "super mario bros");
    const c = diceCoefficient("super mario world", "tetris");
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it("is symmetric", () => {
    expect(diceCoefficient("zelda", "zelda ii")).toBeCloseTo(
      diceCoefficient("zelda ii", "zelda"),
      10,
    );
  });

  it("returns a value in [0, 1]", () => {
    for (const [a, b] of [
      ["mario", "luigi"],
      ["final fantasy", "fantasy final"],
      ["contra", "super c"],
    ] as const) {
      const s = diceCoefficient(a, b);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

// ── systemIdToCollectionFolders ──────────────────────────────────────────────

describe("systemIdToCollectionFolders", () => {
  it("maps common systems to at least one folder", () => {
    expect(systemIdToCollectionFolders("snes").length).toBeGreaterThan(0);
    expect(systemIdToCollectionFolders("nes").length).toBeGreaterThan(0);
    expect(systemIdToCollectionFolders("gba").length).toBeGreaterThan(0);
    expect(systemIdToCollectionFolders("segaMD").length).toBeGreaterThan(0);
    expect(systemIdToCollectionFolders("psx").length).toBeGreaterThan(0);
  });

  it("returns an empty array for unknown systems", () => {
    expect(systemIdToCollectionFolders("unknown")).toEqual([]);
    expect(systemIdToCollectionFolders("")).toEqual([]);
  });

  it("returns a copy so callers cannot mutate the internal table", () => {
    const a = systemIdToCollectionFolders("snes");
    a.push("mutated");
    const b = systemIdToCollectionFolders("snes");
    expect(b).not.toContain("mutated");
  });
});

// ── listGamesMissingCoverArt ─────────────────────────────────────────────────

describe("listGamesMissingCoverArt", () => {
  const base = {
    id: "x",
    name: "x",
    fileName: "x.smc",
    systemId: "snes",
    size: 0,
    addedAt: 0,
    lastPlayedAt: null,
  } as const;
  const mk = (over: Partial<GameMetadata>): GameMetadata => ({ ...base, ...over } as GameMetadata);

  it("excludes games with local cover art", () => {
    expect(listGamesMissingCoverArt([mk({ id: "a", hasCoverArt: true })])).toEqual([]);
  });

  it("excludes games with a remote thumbnail URL", () => {
    expect(
      listGamesMissingCoverArt([mk({ id: "b", thumbnailUrl: "https://example.com/x.jpg" })]),
    ).toEqual([]);
  });

  it("includes games missing both", () => {
    const games = [
      mk({ id: "a", hasCoverArt: true }),
      mk({ id: "b", thumbnailUrl: "https://example.com/x.jpg" }),
      mk({ id: "c" }),
      mk({ id: "d", hasCoverArt: false }),
    ];
    const missing = listGamesMissingCoverArt(games);
    expect(missing.map((g) => g.id)).toEqual(["c", "d"]);
  });
});

// ── GitHubCoverArtProvider (with mocked fetch) ───────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GitHubCoverArtProvider", () => {
  it("returns [] for unknown systems without calling fetch", async () => {
    let called = 0;
    const fetchImpl = (async (): Promise<Response> => {
      called++;
      return jsonResponse([]);
    }) as unknown as typeof fetch;
    const p = new GitHubCoverArtProvider({ fetchImpl });
    expect(await p.search("Zelda", "unknown-system")).toEqual([]);
    expect(called).toBe(0);
  });

  it("returns [] when the normalised query is empty", async () => {
    let called = 0;
    const fetchImpl = (async (): Promise<Response> => {
      called++;
      return jsonResponse([]);
    }) as unknown as typeof fetch;
    const p = new GitHubCoverArtProvider({ fetchImpl });
    expect(await p.search("   (USA) [!]   ", "snes")).toEqual([]);
    expect(called).toBe(0);
  });

  it("ranks candidates by score and limits results", async () => {
    const listing = [
      { name: "Super Mario World (USA).png", path: "SNES/Super Mario World (USA).png", type: "file", download_url: "https://raw.example/smw.png" },
      { name: "Super Mario All-Stars (USA).png", path: "SNES/Super Mario All-Stars (USA).png", type: "file", download_url: "https://raw.example/smas.png" },
      { name: "Tetris (USA).png", path: "SNES/Tetris (USA).png", type: "file", download_url: "https://raw.example/tetris.png" },
      { name: "Readme.md", path: "SNES/Readme.md", type: "file", download_url: "https://raw.example/readme.md" },
      { name: "subfolder", path: "SNES/subfolder", type: "dir", download_url: null },
    ];
    let calls = 0;
    const fetchImpl = (async (url: RequestInfo | URL): Promise<Response> => {
      calls++;
      expect(String(url)).toContain("/repos/ramiabraham/cover-art-collection/contents/SNES");
      return jsonResponse(listing);
    }) as unknown as typeof fetch;

    const provider = new GitHubCoverArtProvider({ fetchImpl });
    const results = await provider.search("Super Mario World (USA).smc", "snes", { limit: 2 });

    expect(calls).toBe(1);
    expect(results.length).toBe(2);
    expect(results[0]!.title).toBe("Super Mario World (USA)");
    expect(results[0]!.sourceName).toBe("cover-art-collection");
    expect(results[0]!.imageUrl).toBe("https://raw.example/smw.png");
    expect(results[0]!.systemId).toBe("snes");
    // Top match should be near-perfect (>= threshold).
    expect(results[0]!.score).toBeGreaterThanOrEqual(AUTO_APPLY_CONFIDENCE_THRESHOLD);
    // Results are sorted by score descending.
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
    // Non-image files are filtered out.
    for (const r of results) expect(r.title).not.toMatch(/readme/i);
  });

  it("caches folder listings across calls", async () => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls++;
      return jsonResponse([
        { name: "Zelda (USA).jpg", path: "NES/Zelda (USA).jpg", type: "file", download_url: "https://raw.example/z.jpg" },
      ]);
    }) as unknown as typeof fetch;
    const p = new GitHubCoverArtProvider({ fetchImpl });
    await p.search("Zelda", "nes");
    await p.search("Zelda II", "nes");
    expect(calls).toBe(1);
  });

  it("falls back to the next folder candidate on 404", async () => {
    const fetchImpl = (async (url: RequestInfo | URL): Promise<Response> => {
      const s = String(url);
      if (s.includes("/contents/NES?")) return new Response("not found", { status: 404 });
      if (s.includes("/contents/Nintendo%20Entertainment%20System?")) {
        return jsonResponse([
          { name: "Zelda (USA).jpg", path: "x", type: "file", download_url: "https://raw.example/z.jpg" },
        ]);
      }
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    const p = new GitHubCoverArtProvider({ fetchImpl });
    const results = await p.search("Zelda", "nes");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.imageUrl).toBe("https://raw.example/z.jpg");
  });

  it("returns [] when the network consistently fails", async () => {
    const fetchImpl = (async (): Promise<Response> => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const p = new GitHubCoverArtProvider({ fetchImpl });
    expect(await p.search("Zelda", "nes")).toEqual([]);
  });

  it("deduplicates concurrent listings for the same folder", async () => {
    let calls = 0;
    let resolveFn!: (r: Response) => void;
    const fetchImpl = ((): Promise<Response> => {
      calls++;
      return new Promise<Response>((r) => { resolveFn = r; });
    }) as unknown as typeof fetch;
    const p = new GitHubCoverArtProvider({ fetchImpl });
    const a = p.search("Zelda", "nes");
    const b = p.search("Mario", "nes");
    // Resolve the single pending request both calls are waiting on.
    resolveFn(jsonResponse([
      { name: "Zelda (USA).jpg", path: "x", type: "file", download_url: "https://raw.example/z.jpg" },
      { name: "Super Mario Bros (USA).jpg", path: "y", type: "file", download_url: "https://raw.example/m.jpg" },
    ]));
    const [ra, rb] = await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(ra.length).toBeGreaterThan(0);
    expect(rb.length).toBeGreaterThan(0);
  });
});

// ── fetchAndValidateCoverArt ─────────────────────────────────────────────────

describe("fetchAndValidateCoverArt", () => {
  it("throws on non-OK responses", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchAndValidateCoverArt("https://x", { fetchImpl })).rejects.toThrow(/404/);
  });

  it("returns the validated blob on success", async () => {
    // A minimal 1×1 PNG.
    const pngBytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
      0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const expectedBlob = new Blob([pngBytes], { type: "image/png" });
    const fetchImpl = (async (): Promise<Response> =>
      new Response(expectedBlob, { status: 200, headers: { "Content-Type": "image/png" } })) as unknown as typeof fetch;

    // jsdom may lack createImageBitmap; stub it to accept any blob for this test.
    const originalBitmap = (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    (globalThis as unknown as { createImageBitmap: (b: Blob) => Promise<{ close(): void }> })
      .createImageBitmap = async () => ({ close: () => {} });
    try {
      const blob = await fetchAndValidateCoverArt("https://x/p.png", { fetchImpl });
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);
    } finally {
      (globalThis as { createImageBitmap?: unknown }).createImageBitmap = originalBitmap;
    }
  });
});
