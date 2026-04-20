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
  cleanRomNameForLibretro,
  systemIdToLibretroSystems,
  LibretroCoverArtProvider,
  ChainedCoverArtProvider,
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

// ── cleanRomNameForLibretro ───────────────────────────────────────────────────

describe("cleanRomNameForLibretro", () => {
  it("returns empty string for empty input", () => {
    expect(cleanRomNameForLibretro("")).toBe("");
  });

  it("strips file extensions", () => {
    expect(cleanRomNameForLibretro("Super Mario World.smc")).toBe("Super Mario World");
    expect(cleanRomNameForLibretro("Zelda.nes")).toBe("Zelda");
  });

  it("preserves parenthesised region tags (No-Intro style)", () => {
    expect(cleanRomNameForLibretro("Super Mario World (USA).smc")).toBe("Super Mario World (USA)");
    expect(cleanRomNameForLibretro("Chrono Trigger (USA) (En,Fr,De).sfc")).toBe("Chrono Trigger (USA) (En,Fr,De)");
  });

  it("strips bracketed dump / verification tags", () => {
    expect(cleanRomNameForLibretro("Zelda [!].nes")).toBe("Zelda");
    expect(cleanRomNameForLibretro("Sonic (Europe) [b1].bin")).toBe("Sonic (Europe)");
    expect(cleanRomNameForLibretro("Mario [!][h2].smc")).toBe("Mario");
  });

  it("preserves parenthesised revision markers", () => {
    // No-Intro revision tags are in parentheses, not brackets.
    expect(cleanRomNameForLibretro("Pokemon Red (Rev A).gb")).toBe("Pokemon Red (Rev A)");
  });

  it("handles path prefixes", () => {
    expect(cleanRomNameForLibretro("roms/snes/Super Metroid (USA).smc")).toBe("Super Metroid (USA)");
  });

  it("collapses extra whitespace left by removals", () => {
    expect(cleanRomNameForLibretro("Sonic [b1]  (Europe).bin")).toBe("Sonic (Europe)");
  });
});

// ── systemIdToLibretroSystems ─────────────────────────────────────────────────

describe("systemIdToLibretroSystems", () => {
  it("maps common systems to at least one folder", () => {
    expect(systemIdToLibretroSystems("nes").length).toBeGreaterThan(0);
    expect(systemIdToLibretroSystems("snes").length).toBeGreaterThan(0);
    expect(systemIdToLibretroSystems("gba").length).toBeGreaterThan(0);
    expect(systemIdToLibretroSystems("segaMD").length).toBeGreaterThan(0);
    expect(systemIdToLibretroSystems("psx").length).toBeGreaterThan(0);
  });

  it("returns the correct Libretro folder names", () => {
    expect(systemIdToLibretroSystems("snes")).toEqual(["Nintendo - Super Nintendo Entertainment System"]);
    expect(systemIdToLibretroSystems("psx")).toEqual(["Sony - PlayStation"]);
    expect(systemIdToLibretroSystems("segaMD")).toEqual(["Sega - Mega Drive - Genesis"]);
  });

  it("returns an empty array for unknown systems", () => {
    expect(systemIdToLibretroSystems("unknown")).toEqual([]);
    expect(systemIdToLibretroSystems("")).toEqual([]);
  });

  it("returns a copy so callers cannot mutate the internal table", () => {
    const a = systemIdToLibretroSystems("snes");
    a.push("mutated");
    const b = systemIdToLibretroSystems("snes");
    expect(b).not.toContain("mutated");
  });
});

// ── LibretroCoverArtProvider ──────────────────────────────────────────────────

describe("LibretroCoverArtProvider", () => {
  it("returns [] for unknown systems without calling fetch", async () => {
    let called = 0;
    const fetchImpl = (async (): Promise<Response> => {
      called++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const p = new LibretroCoverArtProvider({ fetchImpl });
    expect(await p.search("Zelda", "unknown-system")).toEqual([]);
    expect(called).toBe(0);
  });

  it("returns [] when the name is empty after cleaning", async () => {
    let called = 0;
    const fetchImpl = (async (): Promise<Response> => {
      called++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const p = new LibretroCoverArtProvider({ fetchImpl });
    // Only bracketed dump tags — nothing left after cleaning.
    expect(await p.search("[!][b1]", "snes")).toEqual([]);
    expect(called).toBe(0);
  });

  it("constructs valid Libretro CDN URLs", async () => {
    const urls: string[] = [];
    const fetchImpl = (() => {
      // No-op fetch — we only care what URLs are constructed.
      return Promise.resolve(new Response("", { status: 200 }));
    }) as unknown as typeof fetch;
    const p = new LibretroCoverArtProvider({ fetchImpl, imageTypes: ["Named_Boxarts"] });
    const results = await p.search("Super Mario World (USA).smc", "snes");
    for (const r of results) urls.push(r.imageUrl);
    // Every URL must start with the Libretro base URL.
    for (const url of urls) {
      expect(url).toMatch(/^https:\/\/thumbnails\.libretro\.com\//);
    }
    // Must contain the correct system directory.
    expect(urls.some((u) => u.includes("Nintendo%20-%20Super%20Nintendo%20Entertainment%20System"))).toBe(true);
    // Must end with .png.
    for (const url of urls) expect(url).toMatch(/\.png$/);
  });

  it("returns a No-Intro candidate (score >= threshold) and a normalised fallback", async () => {
    const p = new LibretroCoverArtProvider({ imageTypes: ["Named_Boxarts"] });
    const results = await p.search("Super Mario World (USA) [!].smc", "snes");
    // At least one candidate has the No-Intro name preserved.
    const noIntro = results.find((r) => r.title === "Super Mario World (USA)");
    expect(noIntro).toBeDefined();
    expect(noIntro!.score).toBeGreaterThanOrEqual(AUTO_APPLY_CONFIDENCE_THRESHOLD);
    // sourceName identifies the provider.
    for (const r of results) expect(r.sourceName).toBe("Libretro Thumbnails");
  });

  it("respects the limit option", async () => {
    const p = new LibretroCoverArtProvider();
    const results = await p.search("Zelda (USA).nes", "nes", { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("returns [] when aborted before starting", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const p = new LibretroCoverArtProvider();
    expect(await p.search("Zelda", "nes", { signal: ctrl.signal })).toEqual([]);
  });

  it("sorts candidates by score descending", async () => {
    const p = new LibretroCoverArtProvider({ imageTypes: ["Named_Boxarts"] });
    const results = await p.search("Super Mario World (USA).smc", "snes");
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });
});

// ── ChainedCoverArtProvider ───────────────────────────────────────────────────

describe("ChainedCoverArtProvider", () => {
  it("merges results from all providers sorted by score", async () => {
    const providerA = {
      id: "a", name: "A",
      search: async () => [
        { title: "Title A", systemId: "snes", imageUrl: "https://a.example/1.png", sourceName: "A", score: 0.7 },
      ],
    };
    const providerB = {
      id: "b", name: "B",
      search: async () => [
        { title: "Title B", systemId: "snes", imageUrl: "https://b.example/2.png", sourceName: "B", score: 0.9 },
      ],
    };
    const chain = new ChainedCoverArtProvider([providerA, providerB]);
    const results = await chain.search("Some Game", "snes");
    // Highest-scoring candidate should be first.
    expect(results[0]!.score).toBe(0.9);
    expect(results[1]!.score).toBe(0.7);
  });

  it("deduplicates candidates with the same imageUrl", async () => {
    const shared = { title: "T", systemId: "nes", imageUrl: "https://x.example/img.png", sourceName: "X", score: 0.8 };
    const p1 = { id: "p1", name: "P1", search: async () => [shared] };
    const p2 = { id: "p2", name: "P2", search: async () => [shared] };
    const chain = new ChainedCoverArtProvider([p1, p2]);
    const results = await chain.search("T", "nes");
    expect(results.length).toBe(1);
  });

  it("continues past a failing provider", async () => {
    const broken = {
      id: "bad", name: "Bad",
      search: async (): Promise<never> => { throw new Error("network down"); },
    };
    const good = {
      id: "good", name: "Good",
      search: async () => [
        { title: "Good Result", systemId: "nes", imageUrl: "https://good.example/img.png", sourceName: "Good", score: 0.8 },
      ],
    };
    const chain = new ChainedCoverArtProvider([broken, good]);
    const results = await chain.search("Zelda", "nes");
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Good Result");
  });

  it("returns [] for an empty provider list", async () => {
    const chain = new ChainedCoverArtProvider([]);
    expect(await chain.search("Mario", "snes")).toEqual([]);
  });

  it("respects the limit option", async () => {
    const manyResults = Array.from({ length: 10 }, (_, i) => ({
      title: `Title ${i}`, systemId: "snes",
      imageUrl: `https://x.example/${i}.png`, sourceName: "X", score: 1 - i * 0.05,
    }));
    const p = { id: "x", name: "X", search: async () => manyResults };
    const chain = new ChainedCoverArtProvider([p]);
    const results = await chain.search("Game", "snes", { limit: 3 });
    expect(results.length).toBe(3);
  });
});
