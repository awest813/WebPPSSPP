import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { GameCompatibilityDb } from "./compatibility.js";

// ── GameCompatibilityDb ───────────────────────────────────────────────────────

describe("GameCompatibilityDb", () => {
  beforeEach(() => {
    localStorage.removeItem("rv:compatDb:custom");
  });

  afterEach(() => {
    localStorage.removeItem("rv:compatDb:custom");
    vi.restoreAllMocks();
  });

  // ── lookup ────────────────────────────────────────────────────────────────

  it("lookup() finds a built-in entry by exact ID", () => {
    const db = new GameCompatibilityDb();
    const entry = db.lookup("tekken_dark_resurrection");
    expect(entry).not.toBeNull();
    expect(entry!.title).toBe("Tekken: Dark Resurrection");
  });

  it("lookup() normalises the ID to lowercase with underscores", () => {
    const db = new GameCompatibilityDb();
    // Mixed case + spaces should match the stored key
    const entry = db.lookup("Tekken Dark Resurrection");
    expect(entry).not.toBeNull();
    expect(entry!.tierOverride).toBe("high");
  });

  it("lookup() normalises special characters to underscores", () => {
    const db = new GameCompatibilityDb();
    const entry = db.lookup("tekken: dark resurrection");
    expect(entry).not.toBeNull();
  });

  it("lookup() returns null for an unknown game", () => {
    const db = new GameCompatibilityDb();
    expect(db.lookup("a_totally_unknown_game_xyz_123")).toBeNull();
  });

  it("lookup() strips leading and trailing underscores from normalised ID", () => {
    const db = new GameCompatibilityDb();
    const entry = db.lookup("___tekken_dark_resurrection___");
    expect(entry).not.toBeNull();
  });

  // ── upsert / remove ───────────────────────────────────────────────────────

  it("upsert() adds a new entry that is immediately findable", () => {
    const db = new GameCompatibilityDb();
    db.upsert("my_custom_game", { title: "My Custom Game", tierOverride: "medium" });
    const entry = db.lookup("my_custom_game");
    expect(entry).not.toBeNull();
    expect(entry!.title).toBe("My Custom Game");
    expect(entry!.tierOverride).toBe("medium");
  });

  it("upsert() persists custom entries to localStorage", () => {
    const db = new GameCompatibilityDb();
    db.upsert("persistent_game", { title: "Persistent" });
    const raw = localStorage.getItem("rv:compatDb:custom");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed["persistent_game"]).toBeTruthy();
  });

  it("upsert() replaces an existing entry", () => {
    const db = new GameCompatibilityDb();
    db.upsert("replaceable", { title: "v1" });
    db.upsert("replaceable", { title: "v2" });
    expect(db.lookup("replaceable")!.title).toBe("v2");
  });

  it("remove() deletes a custom entry", () => {
    const db = new GameCompatibilityDb();
    db.upsert("temp_game", { title: "Temp" });
    expect(db.lookup("temp_game")).not.toBeNull();
    db.remove("temp_game");
    expect(db.lookup("temp_game")).toBeNull();
  });

  it("remove() does not throw when the entry does not exist", () => {
    const db = new GameCompatibilityDb();
    expect(() => db.remove("nonexistent_game_abc")).not.toThrow();
  });

  it("built-in entries cannot be permanently deleted via remove()", () => {
    const db = new GameCompatibilityDb();
    db.remove("tekken_dark_resurrection");
    // The built-in entry should no longer appear in THIS instance but should
    // be absent in a fresh instance that has no custom overlay for it.
    // (remove() only removes from the custom overlay)
    const fresh = new GameCompatibilityDb();
    expect(fresh.lookup("tekken_dark_resurrection")).not.toBeNull();
  });

  // ── mergeRemote ───────────────────────────────────────────────────────────

  it("mergeRemote() adds entries from a remote database", () => {
    const db = new GameCompatibilityDb();
    db.mergeRemote({ "remote_game": { title: "Remote Game", verified: true } });
    expect(db.lookup("remote_game")).not.toBeNull();
    expect(db.lookup("remote_game")!.verified).toBe(true);
  });

  it("mergeRemote() overwrites built-in entries with remote data", () => {
    const db = new GameCompatibilityDb();
    db.mergeRemote({ "tekken_dark_resurrection": { title: "Overridden", tierOverride: "low" } });
    expect(db.lookup("tekken_dark_resurrection")!.tierOverride).toBe("low");
  });

  it("mergeRemote() ignores non-object input gracefully", () => {
    const db = new GameCompatibilityDb();
    const sizeBefore = db.size;
    db.mergeRemote(null as unknown as Record<string, unknown>);
    db.mergeRemote([1, 2, 3] as unknown as Record<string, unknown>);
    db.mergeRemote("string" as unknown as Record<string, unknown>);
    expect(db.size).toBe(sizeBefore);
  });

  it("mergeRemote() normalises keys", () => {
    const db = new GameCompatibilityDb();
    db.mergeRemote({ "Remote Game With Spaces": { title: "Remote" } });
    expect(db.lookup("remote_game_with_spaces")).not.toBeNull();
  });

  // ── importJson / exportJson ───────────────────────────────────────────────

  it("importJson() returns false for invalid JSON", () => {
    const db = new GameCompatibilityDb();
    expect(db.importJson("{invalid}")).toBe(false);
  });

  it("importJson() returns false for a valid JSON array (not an object)", () => {
    const db = new GameCompatibilityDb();
    expect(db.importJson("[1,2,3]")).toBe(false);
  });

  it("importJson() imports valid entries and makes them findable", () => {
    const db = new GameCompatibilityDb();
    const json = JSON.stringify({ "imported_game": { title: "Imported", tierOverride: "ultra" } });
    expect(db.importJson(json)).toBe(true);
    const entry = db.lookup("imported_game");
    expect(entry).not.toBeNull();
    expect(entry!.tierOverride).toBe("ultra");
  });

  it("exportJson() returns a valid JSON string", () => {
    const db = new GameCompatibilityDb();
    const json = db.exportJson();
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("exportJson() includes built-in entries", () => {
    const db = new GameCompatibilityDb();
    const parsed = JSON.parse(db.exportJson()) as Record<string, unknown>;
    expect(parsed["tekken_dark_resurrection"]).toBeTruthy();
  });

  // ── size / keys ───────────────────────────────────────────────────────────

  it("size returns the number of entries", () => {
    const db = new GameCompatibilityDb();
    const initialSize = db.size;
    db.upsert("extra_game", { title: "Extra" });
    expect(db.size).toBe(initialSize + 1);
  });

  it("keys() returns all game IDs", () => {
    const db = new GameCompatibilityDb();
    const keys = db.keys();
    expect(keys).toContain("tekken_dark_resurrection");
    expect(keys.length).toBe(db.size);
  });

  // ── fetchAndMerge ─────────────────────────────────────────────────────────

  it("fetchAndMerge() merges a successful remote response", async () => {
    const remoteData = { "fetched_game": { title: "Fetched" } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(remoteData),
    }));

    const db = new GameCompatibilityDb();
    await db.fetchAndMerge("https://example.com/compat.json");
    expect(db.lookup("fetched_game")).not.toBeNull();

    vi.unstubAllGlobals();
  });

  it("fetchAndMerge() ignores network errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const db = new GameCompatibilityDb();
    await expect(db.fetchAndMerge("https://example.com/compat.json")).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("fetchAndMerge() ignores non-ok responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const db = new GameCompatibilityDb();
    const sizeBefore = db.size;
    await db.fetchAndMerge("https://example.com/compat.json");
    expect(db.size).toBe(sizeBefore);
    vi.unstubAllGlobals();
  });

  // ── localStorage persistence ──────────────────────────────────────────────

  it("custom entries survive a fresh instance creation", () => {
    const db1 = new GameCompatibilityDb();
    db1.upsert("persistent_custom", { title: "Persistent Custom", tierOverride: "high" });

    const db2 = new GameCompatibilityDb();
    const entry = db2.lookup("persistent_custom");
    expect(entry).not.toBeNull();
    expect(entry!.tierOverride).toBe("high");
  });

  it("handles corrupt localStorage value gracefully", () => {
    localStorage.setItem("rv:compatDb:custom", "{not json}");
    expect(() => new GameCompatibilityDb()).not.toThrow();
  });
});
