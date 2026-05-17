import { describe, expect, it } from "vitest";
import { WikipediaMetadataClient } from "./freeMetadata.js";

describe("WikipediaMetadataClient", () => {
  it("returns no-key summary metadata for likely game pages", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("origin=*");
      expect(url).toContain("generator=search");
      return new Response(JSON.stringify({
        query: {
          pages: {
            "1": {
              title: "Portal",
              extract: "Portal is a puzzle-platform video game developed by Valve.",
            },
          },
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const data = await new WikipediaMetadataClient({ fetchImpl }).searchGame("Portal.iso");
    expect(data?.summary).toContain("puzzle-platform video game");
  });

  it("returns null on network failures", async () => {
    const fetchImpl = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await expect(new WikipediaMetadataClient({ fetchImpl }).searchGame("Portal")).resolves.toBeNull();
  });
});
