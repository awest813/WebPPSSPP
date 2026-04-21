/**
 * sessionTracker.test.ts — Vitest unit suite for play-time tracking.
 *
 * Covers:
 *  - startSession / endSession round-trip writes a PlaySession to IDB
 *  - Short sessions (< MIN_SESSION_MS) are silently discarded
 *  - Overlapping startSession calls end the previous session first
 *  - getStats aggregates correctly (totalMs, sessionCount, lastPlayedAt)
 *  - getAllStats returns a map over all games
 *  - clearAll removes all sessions
 *  - exportAll returns all sessions
 *  - endSession is a no-op when no session is in progress
 *  - formatPlayTime produces correct human-readable strings
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import {
  SessionTracker,
  formatPlayTime,
  MIN_SESSION_MS,
} from "./sessionTracker.js";

// ── Clock helpers ─────────────────────────────────────────────────────────────

/**
 * We spy on Date.now() instead of using vi.useFakeTimers() so that the
 * fake-indexeddb promise machinery (which relies on real microtask scheduling)
 * continues to work normally.
 */
let _now = 1_735_732_800_000; // 2025-01-01T12:00:00Z in ms

function advanceTime(ms: number): void {
  _now += ms;
}

// ── Shared tracker + per-test setup ──────────────────────────────────────────

// A single SessionTracker is shared across describes so they all talk to the
// same fake-indexeddb instance. clearAll() in beforeEach ensures test isolation.
const tracker = new SessionTracker();

beforeEach(async () => {
  _now = 1_735_732_800_000;
  vi.spyOn(Date, "now").mockImplementation(() => _now);
  await tracker.clearAll();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── formatPlayTime ────────────────────────────────────────────────────────────

describe("formatPlayTime", () => {
  it("returns '0 min' for zero milliseconds", () => {
    expect(formatPlayTime(0)).toBe("0 min");
  });

  it("returns minutes only when duration < 1 hour", () => {
    expect(formatPlayTime(60_000)).toBe("1 min");
    expect(formatPlayTime(90_000)).toBe("1 min");   // 1.5 min → floor to 1
    expect(formatPlayTime(3_540_000)).toBe("59 min");
  });

  it("returns hours only when minutes remainder is 0", () => {
    expect(formatPlayTime(3_600_000)).toBe("1 h");
    expect(formatPlayTime(7_200_000)).toBe("2 h");
  });

  it("returns hours and minutes when both are non-zero", () => {
    expect(formatPlayTime(3_661_000)).toBe("1 h 1 min");
    expect(formatPlayTime(5_400_000)).toBe("1 h 30 min");
    expect(formatPlayTime(7_260_000)).toBe("2 h 1 min");
  });
});

// ── endSession (no-op when idle) ──────────────────────────────────────────────

describe("SessionTracker.endSession when idle", () => {
  it("resolves without error when no session is active", async () => {
    await expect(tracker.endSession()).resolves.toBeUndefined();
  });

  it("isTracking is false initially", () => {
    expect(tracker.isTracking).toBe(false);
  });
});

// ── startSession / endSession round-trip ──────────────────────────────────────

describe("SessionTracker.startSession / endSession", () => {
  it("isTracking becomes true after startSession", () => {
    tracker.startSession("game-1", "Sonic", "genesis");
    expect(tracker.isTracking).toBe(true);
  });

  it("isTracking becomes false after endSession", async () => {
    tracker.startSession("game-1", "Sonic", "genesis");
    advanceTime(MIN_SESSION_MS);
    await tracker.endSession();
    expect(tracker.isTracking).toBe(false);
  });

  it("persists a session that meets the minimum duration", async () => {
    tracker.startSession("game-1", "Sonic", "genesis");
    advanceTime(MIN_SESSION_MS);
    await tracker.endSession();

    const stats = await tracker.getStats("game-1");
    expect(stats.sessionCount).toBe(1);
    expect(stats.totalMs).toBeGreaterThanOrEqual(MIN_SESSION_MS);
  });

  it("discards a session shorter than MIN_SESSION_MS", async () => {
    tracker.startSession("game-1", "Sonic", "genesis");
    advanceTime(MIN_SESSION_MS - 1);   // 1 ms too short
    await tracker.endSession();

    const stats = await tracker.getStats("game-1");
    expect(stats.sessionCount).toBe(0);
    expect(stats.totalMs).toBe(0);
  });

  it("records correct startedAt and endedAt timestamps", async () => {
    const startedAt = _now;
    tracker.startSession("game-1", "Sonic", "genesis");
    advanceTime(10_000);
    const endedAt = _now;
    await tracker.endSession();

    const sessions = await tracker.exportAll();
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.startedAt).toBe(startedAt);
    expect(s.endedAt).toBe(endedAt);
    expect(s.durationMs).toBe(10_000);
  });

  it("records correct game metadata", async () => {
    tracker.startSession("game-42", "Zelda", "snes");
    advanceTime(MIN_SESSION_MS);
    await tracker.endSession();

    const sessions = await tracker.exportAll();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.gameId).toBe("game-42");
    expect(sessions[0]!.gameName).toBe("Zelda");
    expect(sessions[0]!.systemId).toBe("snes");
  });

  it("second endSession after the first is a no-op", async () => {
    tracker.startSession("game-1", "Sonic", "genesis");
    advanceTime(MIN_SESSION_MS);
    await tracker.endSession();
    await tracker.endSession();   // should not write a second session

    const stats = await tracker.getStats("game-1");
    expect(stats.sessionCount).toBe(1);
  });
});

// ── Back-to-back sessions ─────────────────────────────────────────────────────

describe("SessionTracker — overlapping startSession", () => {
  it("ends the previous session when a new startSession is called", async () => {
    tracker.startSession("game-1", "Sonic", "genesis");
    advanceTime(MIN_SESSION_MS);
    // Start a second game without explicitly ending the first
    tracker.startSession("game-2", "Zelda", "snes");
    advanceTime(MIN_SESSION_MS);
    await tracker.endSession();

    // Both sessions should have been recorded
    const stats1 = await tracker.getStats("game-1");
    const stats2 = await tracker.getStats("game-2");
    expect(stats1.sessionCount).toBe(1);
    expect(stats2.sessionCount).toBe(1);
  });

  it("discards the implicit previous session if it was too short", async () => {
    tracker.startSession("game-1", "Sonic", "genesis");
    advanceTime(MIN_SESSION_MS - 1);   // too short
    tracker.startSession("game-2", "Zelda", "snes");
    advanceTime(MIN_SESSION_MS);
    await tracker.endSession();

    const stats1 = await tracker.getStats("game-1");
    const stats2 = await tracker.getStats("game-2");
    expect(stats1.sessionCount).toBe(0);
    expect(stats2.sessionCount).toBe(1);
  });
});

// ── getStats ─────────────────────────────────────────────────────────────────

describe("SessionTracker.getStats", () => {
  it("returns zeroed stats when no sessions exist for a gameId", async () => {
    const stats = await tracker.getStats("nonexistent-game");
    expect(stats).toEqual({ totalMs: 0, sessionCount: 0, lastPlayedAt: null });
  });

  it("sums multiple sessions for the same game", async () => {
    tracker.startSession("game-1", "Sonic", "genesis");
    advanceTime(10_000);
    await tracker.endSession();

    tracker.startSession("game-1", "Sonic", "genesis");
    advanceTime(20_000);
    await tracker.endSession();

    const stats = await tracker.getStats("game-1");
    expect(stats.sessionCount).toBe(2);
    expect(stats.totalMs).toBe(30_000);
  });

  it("lastPlayedAt is the endedAt of the most recent session", async () => {
    tracker.startSession("game-1", "Sonic", "genesis");
    advanceTime(10_000);
    await tracker.endSession();
    const afterFirst = _now;

    advanceTime(5_000);

    tracker.startSession("game-1", "Sonic", "genesis");
    advanceTime(10_000);
    await tracker.endSession();
    const afterSecond = _now;

    const stats = await tracker.getStats("game-1");
    expect(stats.lastPlayedAt).toBe(afterSecond);
    expect(stats.lastPlayedAt).toBeGreaterThan(afterFirst);
  });

  it("stats for one game do not bleed into another", async () => {
    tracker.startSession("game-1", "Sonic", "genesis");
    advanceTime(10_000);
    await tracker.endSession();

    const stats2 = await tracker.getStats("game-2");
    expect(stats2.sessionCount).toBe(0);
    expect(stats2.totalMs).toBe(0);
  });
});

// ── getAllStats ───────────────────────────────────────────────────────────────

describe("SessionTracker.getAllStats", () => {
  it("returns an empty Map when no sessions exist", async () => {
    const all = await tracker.getAllStats();
    expect(all.size).toBe(0);
  });

  it("aggregates sessions across multiple games", async () => {
    tracker.startSession("game-1", "Sonic", "genesis");
    advanceTime(10_000);
    await tracker.endSession();

    tracker.startSession("game-2", "Zelda", "snes");
    advanceTime(20_000);
    await tracker.endSession();

    const all = await tracker.getAllStats();
    expect(all.size).toBe(2);
    expect(all.get("game-1")!.totalMs).toBe(10_000);
    expect(all.get("game-2")!.totalMs).toBe(20_000);
  });
});

// ── clearAll ──────────────────────────────────────────────────────────────────

describe("SessionTracker.clearAll", () => {
  it("removes all sessions", async () => {
    tracker.startSession("game-1", "Sonic", "genesis");
    advanceTime(MIN_SESSION_MS);
    await tracker.endSession();

    await tracker.clearAll();

    const stats = await tracker.getStats("game-1");
    expect(stats.sessionCount).toBe(0);
  });

  it("exportAll returns an empty array after clearAll", async () => {
    tracker.startSession("game-1", "Sonic", "genesis");
    advanceTime(MIN_SESSION_MS);
    await tracker.endSession();

    await tracker.clearAll();

    const sessions = await tracker.exportAll();
    expect(sessions).toHaveLength(0);
  });
});

// ── exportAll ─────────────────────────────────────────────────────────────────

describe("SessionTracker.exportAll", () => {
  it("returns an empty array when no sessions exist", async () => {
    const sessions = await tracker.exportAll();
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions).toHaveLength(0);
  });

  it("returns all recorded sessions", async () => {
    tracker.startSession("game-1", "Sonic", "genesis");
    advanceTime(MIN_SESSION_MS);
    await tracker.endSession();

    tracker.startSession("game-2", "Zelda", "snes");
    advanceTime(MIN_SESSION_MS);
    await tracker.endSession();

    const sessions = await tracker.exportAll();
    expect(sessions).toHaveLength(2);
  });
});
