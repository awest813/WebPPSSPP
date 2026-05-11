import { describe, expect, it } from "vitest";
import { parseRAKey } from "./raCredentials.js";

describe("parseRAKey", () => {
  it("parses username and API key", () => {
    expect(parseRAKey("player:abc123")).toEqual({
      username: "player",
      apiKey: "abc123",
    });
  });

  it("trims whitespace around both fields", () => {
    expect(parseRAKey(" player : abc123 ")).toEqual({
      username: "player",
      apiKey: "abc123",
    });
  });

  it("rejects missing or ambiguous fields", () => {
    expect(parseRAKey("")).toBeNull();
    expect(parseRAKey("player")).toBeNull();
    expect(parseRAKey(":abc123")).toBeNull();
    expect(parseRAKey("player:")).toBeNull();
    expect(parseRAKey("player:abc:extra")).toBeNull();
  });
});
