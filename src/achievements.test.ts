import { describe, expect, it, vi } from "vitest";
import { RAClient } from "./achievements.js";

function jsonResponse(body: unknown, ok = true, statusText = "OK"): Response {
  return {
    ok,
    statusText,
    json: async () => body,
  } as Response;
}

describe("RAClient", () => {
  it("tests a valid RetroAchievements login with the profile endpoint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ User: "player", TotalPoints: 123 }));
    const client = new RAClient("player", "apikey", { fetchImpl: fetchImpl as typeof fetch });

    await expect(client.testConnection()).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const firstCall = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit?];
    const url = new URL(String(firstCall[0]));
    expect(url.pathname).toContain("API_GetUserProfile.php");
    expect(url.searchParams.get("u")).toBe("player");
    expect(url.searchParams.get("z")).toBe("player");
    expect(url.searchParams.get("y")).toBe("apikey");
  });

  it("returns a user-facing auth error when RetroAchievements rejects credentials", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ Error: "Invalid Web API Key" }));
    const client = new RAClient("player", "bad", { fetchImpl: fetchImpl as typeof fetch });

    await expect(client.testConnection()).resolves.toMatch(/rejected/i);
  });

  it("returns a user-facing network error when the API is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const client = new RAClient("player", "apikey", { fetchImpl: fetchImpl as typeof fetch });

    await expect(client.testConnection()).resolves.toMatch(/could not reach/i);
  });
});
