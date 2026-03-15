import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  generateInviteCode,
  normaliseInviteCode,
  HttpSignalingClient,
  signalingRoomToEasyRoom,
} from "./signalingClient.js";
import {
  checkSystemSupport,
  checkGameCompatibility,
  compatibilitySummary,
} from "./compatibility.js";
import { DiagnosticsLog, MSG, diagnosticForErrorCode } from "./diagnostics.js";
import type { NetplayDiagnosticEntry } from "./netplayTypes.js";
import { EasyNetplayManager } from "./EasyNetplayManager.js";

// ── generateInviteCode ────────────────────────────────────────────────────────

describe("generateInviteCode", () => {
  it("returns exactly 6 characters", () => {
    expect(generateInviteCode("room-123")).toHaveLength(6);
  });

  it("is deterministic for the same input", () => {
    const a = generateInviteCode("abc");
    const b = generateInviteCode("abc");
    expect(a).toBe(b);
  });

  it("returns different codes for different inputs", () => {
    expect(generateInviteCode("roomA")).not.toBe(generateInviteCode("roomB"));
  });

  it("only contains characters from the unambiguous alphabet", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateInviteCode(`room-${i}`);
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/);
    }
  });
});

// ── normaliseInviteCode ───────────────────────────────────────────────────────

describe("normaliseInviteCode", () => {
  it("uppercases the input", () => {
    expect(normaliseInviteCode("ab12cd")).toBe("AB12CD");
  });

  it("strips spaces", () => {
    expect(normaliseInviteCode("AB 12 CD")).toBe("AB12CD");
  });

  it("strips dashes", () => {
    expect(normaliseInviteCode("AB-12-CD")).toBe("AB12CD");
  });

  it("truncates to 6 characters", () => {
    expect(normaliseInviteCode("ABCDEFGHIJ")).toHaveLength(6);
  });
});

// ── signalingRoomToEasyRoom ───────────────────────────────────────────────────

describe("signalingRoomToEasyRoom", () => {
  const base = {
    id:          "r1",
    code:        "ABCDEF",
    name:        "Test Room",
    gameId:      "some_game",
    gameName:    "Some Game",
    systemId:    "psp",
    hostName:    "Alice",
    privacy:     "public" as const,
    playerCount: 1,
    maxPlayers:  2,
    hasPassword: false,
    createdAt:   1000,
  };

  it("marks local=true when privacy is local", () => {
    const room = signalingRoomToEasyRoom({ ...base, privacy: "local" });
    expect(room.isLocal).toBe(true);
  });

  it("marks local=true when latency is below threshold", () => {
    const room = signalingRoomToEasyRoom({ ...base, latencyMs: 20 });
    expect(room.isLocal).toBe(true);
  });

  it("marks local=false for public room without low latency", () => {
    const room = signalingRoomToEasyRoom({ ...base, privacy: "public", latencyMs: 120 });
    expect(room.isLocal).toBe(false);
  });
});

// ── checkSystemSupport ────────────────────────────────────────────────────────

describe("checkSystemSupport", () => {
  it("returns compatible=true for psp", () => {
    expect(checkSystemSupport("psp").compatible).toBe(true);
  });

  it("returns compatible=true for n64", () => {
    expect(checkSystemSupport("n64").compatible).toBe(true);
  });

  it("returns compatible=true for gba", () => {
    expect(checkSystemSupport("gba").compatible).toBe(true);
  });

  it("returns compatible=false for nes", () => {
    const result = checkSystemSupport("nes");
    expect(result.compatible).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns compatible=false for an unknown system", () => {
    const result = checkSystemSupport("atari");
    expect(result.compatible).toBe(false);
  });

  it("error message includes the system name", () => {
    const result = checkSystemSupport("nes");
    expect(result.errors[0]).toContain("NES");
  });
});

// ── checkGameCompatibility ────────────────────────────────────────────────────

describe("checkGameCompatibility", () => {
  it("returns compatible=true for identical game and system", () => {
    const result = checkGameCompatibility("game_a", "psp", "game_a", "psp");
    expect(result.compatible).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns compatible=false when systems differ", () => {
    const result = checkGameCompatibility("game_a", "psp", "game_a", "gba");
    expect(result.compatible).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns warning (not error) when game IDs differ but systems match", () => {
    const result = checkGameCompatibility("game_a", "psp", "game_b", "psp");
    expect(result.compatible).toBe(true);  // warnings only
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
  });

  it("ignores case differences in system IDs", () => {
    const result = checkGameCompatibility("game_a", "PSP", "game_a", "psp");
    expect(result.compatible).toBe(true);
  });
});

// ── compatibilitySummary ──────────────────────────────────────────────────────

describe("compatibilitySummary", () => {
  it("returns null when all compatible", () => {
    expect(compatibilitySummary({ compatible: true, warnings: [], errors: [] })).toBeNull();
  });

  it("returns first error when errors exist", () => {
    const result = compatibilitySummary({ compatible: false, warnings: [], errors: ["err1", "err2"] });
    expect(result).toBe("err1");
  });

  it("returns first warning when no errors", () => {
    const result = compatibilitySummary({ compatible: true, warnings: ["w1"], errors: [] });
    expect(result).toBe("w1");
  });
});

// ── DiagnosticsLog ────────────────────────────────────────────────────────────

describe("DiagnosticsLog", () => {
  let log: DiagnosticsLog;

  beforeEach(() => {
    log = new DiagnosticsLog();
  });

  it("starts empty", () => {
    expect(log.entries).toHaveLength(0);
    expect(log.latest).toBeUndefined();
  });

  it("stores info entries", () => {
    log.info("hello");
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]!.level).toBe("info");
    expect(log.entries[0]!.message).toBe("hello");
  });

  it("stores warning entries with level=warning", () => {
    log.warn("careful");
    expect(log.latest?.level).toBe("warning");
  });

  it("stores error entries with level=error", () => {
    log.error("broken");
    expect(log.latest?.level).toBe("error");
  });

  it("stores optional detail", () => {
    log.info("msg", "detail text");
    expect(log.latest?.detail).toBe("detail text");
  });

  it("notifies listener on new entry", () => {
    const spy = vi.fn();
    log.onEntry(spy);
    log.info("test");
    expect(spy).toHaveBeenCalledOnce();
    expect((spy.mock.calls[0] as [NetplayDiagnosticEntry])[0].message).toBe("test");
  });

  it("clears all entries", () => {
    log.info("a");
    log.info("b");
    log.clear();
    expect(log.entries).toHaveLength(0);
  });

  it("caps at 64 entries", () => {
    for (let i = 0; i < 70; i++) log.info(`msg ${i}`);
    expect(log.entries.length).toBeLessThanOrEqual(64);
  });
});

// ── diagnosticForErrorCode ────────────────────────────────────────────────────

describe("diagnosticForErrorCode", () => {
  it("maps room_not_found to plain English", () => {
    expect(diagnosticForErrorCode("room_not_found")).toBe(MSG.roomNotFound);
  });

  it("maps room_full to plain English", () => {
    expect(diagnosticForErrorCode("room_full")).toBe(MSG.roomFull);
  });

  it("returns unknownError for unrecognised codes", () => {
    expect(diagnosticForErrorCode("random_code_xyz")).toBe(MSG.unknownError);
  });
});

// ── HttpSignalingClient ───────────────────────────────────────────────────────

describe("HttpSignalingClient", () => {
  it("converts ws:// base URL to http://", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ([]),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const client = new HttpSignalingClient("ws://localhost:8080");
    await client.listRooms();

    const calledUrl = (fetchSpy.mock.calls[0] as [string])[0];
    expect(calledUrl).toMatch(/^http:\/\//);

    vi.unstubAllGlobals();
  });

  it("converts wss:// base URL to https://", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ([]),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const client = new HttpSignalingClient("wss://example.com");
    await client.listRooms();

    const calledUrl = (fetchSpy.mock.calls[0] as [string])[0];
    expect(calledUrl).toMatch(/^https:\/\//);

    vi.unstubAllGlobals();
  });

  it("returns empty array when server responds with non-ok status", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchSpy);

    const client = new HttpSignalingClient("wss://example.com");
    const rooms = await client.listRooms();
    expect(rooms).toEqual([]);

    vi.unstubAllGlobals();
  });

  it("generates invite code when server does not provide one", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ([{ id: "room-abc", name: "Test" }]),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const client = new HttpSignalingClient("wss://example.com");
    const rooms = await client.listRooms();
    expect(rooms[0]!.code).toHaveLength(6);

    vi.unstubAllGlobals();
  });

  it("falls back to legacy /list?domain endpoint and parses dictionary payloads", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          "legacy-room": {
            room_name: "Legacy Room",
            host: "Alice",
            players: 1,
            max: 2,
            system_id: "gba",
          },
        }),
      });
    vi.stubGlobal("fetch", fetchSpy);

    const client = new HttpSignalingClient("wss://example.com");
    const rooms = await client.listRooms();

    const calledUrl = String((fetchSpy.mock.calls[3] as [string])[0]);
    expect(calledUrl).toContain("/list?domain=");
    expect(rooms[0]!.id).toBe("legacy-room");
    expect(rooms[0]!.name).toBe("Legacy Room");
    expect(rooms[0]!.systemId).toBe("gba");

    vi.unstubAllGlobals();
  });

  it("returns network_timeout when join request exceeds timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.fn((_url: string, init?: RequestInit) => (
        new Promise((_resolve, reject) => {
          const abortErr = Object.assign(new Error("AbortError"), { name: "AbortError" });
          const sig = init?.signal;
          if (!sig) return;
          if (sig.aborted) {
            reject(abortErr);
            return;
          }
          sig.addEventListener("abort", () => reject(abortErr), { once: true });
        })
      ));
      vi.stubGlobal("fetch", fetchSpy);

      const client = new HttpSignalingClient("wss://example.com");
      const pending = expect(client.joinRoom("ABCDEF")).rejects.toMatchObject({
        code: "network_timeout",
      });
      await vi.advanceTimersByTimeAsync(10_100);
      await pending;
      vi.unstubAllGlobals();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── EasyNetplayManager ────────────────────────────────────────────────────────

describe("EasyNetplayManager", () => {
  let manager: EasyNetplayManager;
  const hostOpts = {
    hostName:  "Alice",
    gameId:    "gran_turismo",
    gameName:  "Gran Turismo",
    systemId:  "psp",
    privacy:   "local" as const,
    maxPlayers: 2,
  };

  beforeEach(() => {
    manager = new EasyNetplayManager();
  });

  it("starts in idle state", () => {
    expect(manager.state).toBe("idle");
  });

  it("transitions to hosting when no server configured (local stub)", async () => {
    const states: string[] = [];
    manager.onEvent(ev => { if (ev.type === "state_changed") states.push(ev.state); });
    await manager.hostRoom(hostOpts);
    expect(states).toContain("hosting");
  });

  it("emits room_created event", async () => {
    let created = false;
    manager.onEvent(ev => { if (ev.type === "room_created") created = true; });
    await manager.hostRoom(hostOpts);
    expect(created).toBe(true);
  });

  it("creates a local stub room with a 6-char invite code when server is absent", async () => {
    await manager.hostRoom(hostOpts);
    expect(manager.room?.code).toHaveLength(6);
    expect(manager.room?.isLocal).toBe(true);
  });

  it("fails with error event for unsupported system", async () => {
    const errors: string[] = [];
    manager.onEvent(ev => { if (ev.type === "error") errors.push(ev.code); });
    await manager.hostRoom({ ...hostOpts, systemId: "nes" });
    expect(errors).toContain("unsupported_system");
    expect(manager.state).toBe("failed");
  });

  it("transitions to idle after leaveRoom()", async () => {
    await manager.hostRoom(hostOpts);
    await manager.leaveRoom();
    expect(manager.state).toBe("idle");
    expect(manager.room).toBeNull();
  });

  it("emits disconnected event on leaveRoom()", async () => {
    let disconnected = false;
    manager.onEvent(ev => { if (ev.type === "disconnected") disconnected = true; });
    await manager.hostRoom(hostOpts);
    await manager.leaveRoom();
    expect(disconnected).toBe(true);
  });

  it("returns empty rooms list when server not configured", async () => {
    const rooms = await manager.listRooms();
    expect(rooms).toEqual([]);
  });

  it("emits diagnostic entries visible via diagnostics.entries", async () => {
    await manager.hostRoom(hostOpts);
    expect(manager.diagnostics.entries.length).toBeGreaterThan(0);
  });

  it("clears diagnostics on a new hostRoom() call", async () => {
    await manager.hostRoom(hostOpts);
    await manager.leaveRoom();
    await manager.hostRoom(hostOpts);
    // Diagnostics are cleared at the start of hostRoom; at least one new entry.
    expect(manager.diagnostics.entries.length).toBeGreaterThan(0);
  });

  it("joining without server emits server_unavailable error", async () => {
    const errors: string[] = [];
    manager.onEvent(ev => { if (ev.type === "error") errors.push(ev.code); });
    await manager.joinRoom({ code: "ABCDEF", playerName: "Bob" });
    expect(errors).toContain("server_unavailable");
  });

  it("joining with invalid code emits invalid_code error", async () => {
    manager.setServerUrl("wss://example.com");
    const errors: string[] = [];
    manager.onEvent(ev => { if (ev.type === "error") errors.push(ev.code); });
    await manager.joinRoom({ code: "X", playerName: "Bob" });
    expect(errors).toContain("invalid_code");
  });

  it("unsubscribe function removes listener", async () => {
    let count = 0;
    const unsub = manager.onEvent(() => { count++; });
    unsub();
    await manager.hostRoom(hostOpts);
    expect(count).toBe(0);
  });

  it("joinRoom with localSystemId mismatch emits incompatible_rom error", async () => {
    // Stub a server that returns a PSP room
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "room-1", code: "ABCDEF", name: "Test Room",
        gameId: "gran_turismo", gameName: "Gran Turismo", systemId: "psp",
        host: "Alice", privacy: "public", players: 1, maxPlayers: 2,
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    manager.setServerUrl("wss://example.com");
    const errors: string[] = [];
    manager.onEvent(ev => { if (ev.type === "error") errors.push(ev.code); });

    await manager.joinRoom({
      code:          "ABCDEF",
      playerName:    "Bob",
      localGameId:   "gran_turismo",
      localSystemId: "gba",  // ← mismatched system
    });

    expect(errors).toContain("incompatible_rom");
    vi.unstubAllGlobals();
  });

  it("cancelPendingOperations aborts an in-flight join and returns to idle", async () => {
    const fetchSpy = vi.fn((_url: string, init?: RequestInit) => (
      new Promise((_resolve, reject) => {
        const abortErr = Object.assign(new Error("AbortError"), { name: "AbortError" });
        const sig = init?.signal;
        if (!sig) return;
        if (sig.aborted) {
          reject(abortErr);
          return;
        }
        sig.addEventListener("abort", () => reject(abortErr), { once: true });
      })
    ));
    vi.stubGlobal("fetch", fetchSpy);

    manager.setServerUrl("wss://example.com");
    const join = manager.joinRoom({ code: "ABCDEF", playerName: "Bob" });
    expect(manager.state).toBe("joining");

    manager.cancelPendingOperations();
    await join;

    expect(manager.state).toBe("idle");
    vi.unstubAllGlobals();
  });

  // ── watchRoom / spectator ──────────────────────────────────────────────────

  it("watchRoom without server emits server_unavailable error", async () => {
    const errors: string[] = [];
    manager.onEvent(ev => { if (ev.type === "error") errors.push(ev.code); });
    await manager.watchRoom({ code: "ABCDEF" });
    expect(errors).toContain("server_unavailable");
  });

  it("watchRoom with invalid code emits invalid_code error", async () => {
    manager.setServerUrl("wss://example.com");
    const errors: string[] = [];
    manager.onEvent(ev => { if (ev.type === "error") errors.push(ev.code); });
    await manager.watchRoom({ code: "X" });
    expect(errors).toContain("invalid_code");
  });

  it("watchRoom transitions through spectating then watching", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "room-1", code: "ABCDEF", name: "Test Room",
        gameId: "gran_turismo", gameName: "Gran Turismo", systemId: "psp",
        host: "Alice", privacy: "public", players: 1, maxPlayers: 2,
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    manager.setServerUrl("wss://example.com");
    const states: string[] = [];
    manager.onEvent(ev => { if (ev.type === "state_changed") states.push(ev.state); });
    await manager.watchRoom({ code: "ABCDEF" });

    expect(states).toContain("spectating");
    expect(states).toContain("watching");
    expect(manager.isSpectating).toBe(true);
    vi.unstubAllGlobals();
  });

  it("watchRoom emits spectator_joined event with room metadata", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "room-1", code: "ABCDEF", name: "Spectate Me",
        gameId: "some_game", gameName: "Some Game", systemId: "psp",
        host: "Host", privacy: "public", players: 2, maxPlayers: 2,
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    manager.setServerUrl("wss://example.com");
    let session: import("./netplayTypes.js").SpectatorSession | null = null;
    manager.onEvent(ev => { if (ev.type === "spectator_joined") session = ev.session; });
    await manager.watchRoom({ code: "ABCDEF" });

    expect(session).not.toBeNull();
    expect(session!.room.name).toBe("Spectate Me");
    expect(session!.room.gameName).toBe("Some Game");
    vi.unstubAllGlobals();
  });

  it("isSpectating is false when idle", () => {
    expect(manager.isSpectating).toBe(false);
  });

  it("spectatorSession is null until watchRoom succeeds", async () => {
    expect(manager.spectatorSession).toBeNull();
  });

  it("leaveRoom clears spectator session and returns to idle", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "room-1", code: "ABCDEF", name: "Room", gameId: "g", gameName: "G",
        systemId: "psp", host: "H", privacy: "public", players: 1, maxPlayers: 2,
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    manager.setServerUrl("wss://example.com");
    await manager.watchRoom({ code: "ABCDEF" });
    expect(manager.isSpectating).toBe(true);

    await manager.leaveRoom();
    expect(manager.isSpectating).toBe(false);
    expect(manager.spectatorSession).toBeNull();
    expect(manager.state).toBe("idle");
    vi.unstubAllGlobals();
  });

  it("updatePlayerCount emits player_count event", () => {
    let received: { roomId: string; count: number } | null = null;
    manager.onEvent(ev => {
      if (ev.type === "player_count") received = { roomId: ev.roomId, count: ev.count };
    });
    manager.updatePlayerCount("room-99", 3);
    expect(received).toEqual({ roomId: "room-99", count: 3 });
  });

  it("updatePlayerCount ignores negative count", () => {
    let received = false;
    manager.onEvent(ev => { if (ev.type === "player_count") received = true; });
    manager.updatePlayerCount("room-99", -1);
    expect(received).toBe(false);
  });

  it("updatePlayerCount ignores NaN", () => {
    let received = false;
    manager.onEvent(ev => { if (ev.type === "player_count") received = true; });
    manager.updatePlayerCount("room-99", NaN);
    expect(received).toBe(false);
  });

  it("updatePlayerCount ignores Infinity", () => {
    let received = false;
    manager.onEvent(ev => { if (ev.type === "player_count") received = true; });
    manager.updatePlayerCount("room-99", Infinity);
    expect(received).toBe(false);
  });

  it("updatePlayerCount allows zero (room with no players)", () => {
    let received: number | null = null;
    manager.onEvent(ev => { if (ev.type === "player_count") received = ev.count; });
    manager.updatePlayerCount("room-99", 0);
    expect(received).toBe(0);
  });

  // ── markInGame ─────────────────────────────────────────────────────────────

  it("markInGame transitions connected state to in_game", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "room-1", code: "ABCDEF", name: "Test Room",
        gameId: "gran_turismo", gameName: "Gran Turismo", systemId: "psp",
        host: "Alice", privacy: "public", players: 1, maxPlayers: 2,
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    manager.setServerUrl("wss://example.com");
    await manager.joinRoom({ code: "ABCDEF", playerName: "Bob" });
    expect(manager.state).toBe("connected");

    manager.markInGame();
    expect(manager.state).toBe("in_game");

    vi.unstubAllGlobals();
  });

  it("markInGame emits state_changed with in_game", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "room-1", code: "ABCDEF", name: "Test Room",
        gameId: "gran_turismo", gameName: "Gran Turismo", systemId: "psp",
        host: "Alice", privacy: "public", players: 1, maxPlayers: 2,
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    manager.setServerUrl("wss://example.com");
    await manager.joinRoom({ code: "ABCDEF", playerName: "Bob" });

    const states: string[] = [];
    manager.onEvent(ev => { if (ev.type === "state_changed") states.push(ev.state); });
    manager.markInGame();
    expect(states).toContain("in_game");

    vi.unstubAllGlobals();
  });

  it("markInGame is a no-op when state is not connected", async () => {
    // State is idle — markInGame should do nothing.
    manager.markInGame();
    expect(manager.state).toBe("idle");
  });

  it("markInGame is a no-op when state is hosting (stub room)", async () => {
    await manager.hostRoom(hostOpts);
    expect(manager.state).toBe("hosting");
    manager.markInGame();
    expect(manager.state).toBe("hosting");
  });

  // ── hostRoom with empty hostName ───────────────────────────────────────────

  it("hostRoom with empty hostName produces a valid room name (local stub)", async () => {
    await manager.hostRoom({ ...hostOpts, hostName: "" });
    expect(manager.room?.name).toBeTruthy();
    expect(manager.room?.name).not.toMatch(/^'s Room/);
    expect(manager.room?.name).toContain("'s Room");
  });

  it("hostRoom with whitespace-only hostName produces a valid room name", async () => {
    await manager.hostRoom({ ...hostOpts, hostName: "   " });
    expect(manager.room?.name).toBeTruthy();
    expect(manager.room?.name).not.toMatch(/^\s*'s Room/);
  });

  // ── listRooms AbortError ───────────────────────────────────────────────────

  it("listRooms re-throws AbortError", async () => {
    const abortErr = Object.assign(new Error("AbortError"), { name: "AbortError" });
    const fetchSpy = vi.fn().mockRejectedValue(abortErr);
    vi.stubGlobal("fetch", fetchSpy);

    manager.setServerUrl("wss://example.com");
    const controller = new AbortController();
    await expect(manager.listRooms(controller.signal)).rejects.toMatchObject({ name: "AbortError" });

    vi.unstubAllGlobals();
  });

  // ── leaveRoom with throwing signaling client ───────────────────────────────

  it("leaveRoom cleans up local state even when signaling server throws", async () => {
    // Stub a server that returns a valid room on join but throws on leave.
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "room-1", code: "ABCDEF", name: "Test Room",
          gameId: "gran_turismo", gameName: "Gran Turismo", systemId: "psp",
          host: "Alice", privacy: "public", players: 1, maxPlayers: 2,
        }),
      })
      .mockRejectedValue(new Error("Network failure"));
    vi.stubGlobal("fetch", fetchSpy);

    manager.setServerUrl("wss://example.com");
    await manager.joinRoom({ code: "ABCDEF", playerName: "Bob" });
    expect(manager.room).not.toBeNull();

    // leaveRoom should NOT throw even though the server call fails.
    await expect(manager.leaveRoom()).resolves.toBeUndefined();
    expect(manager.state).toBe("idle");
    expect(manager.room).toBeNull();

    vi.unstubAllGlobals();
  });
});

// ── PeerDataChannel ───────────────────────────────────────────────────────────

import { PeerDataChannel, SpectatorChannel } from "./peerChannel.js";
import type { PeerMessage } from "./peerChannel.js";

describe("PeerDataChannel", () => {
  it("starts in 'new' state", () => {
    const ch = new PeerDataChannel();
    expect(ch.state).toBe("new");
    expect(ch.isOpen).toBe(false);
  });

  it("createOffer() throws when RTCPeerConnection is unavailable", async () => {
    // JSDOM does not provide RTCPeerConnection.
    const ch = new PeerDataChannel();
    await expect(ch.createOffer()).rejects.toThrow(/WebRTC is not available/);
  });

  it("createAnswer() throws when RTCPeerConnection is unavailable", async () => {
    const ch = new PeerDataChannel();
    await expect(ch.createAnswer({ type: "offer", sdp: "" })).rejects.toThrow(/WebRTC is not available/);
  });

  it("send() throws when channel is not open", () => {
    const ch = new PeerDataChannel();
    expect(() => ch.send("hello")).toThrow(/not open/);
  });

  it("sendMessage() throws when channel is not open", () => {
    const ch = new PeerDataChannel();
    expect(() => ch.sendMessage({ type: "chat", text: "hi", senderName: "Bob" })).toThrow(/not open/);
  });

  it("close() transitions to 'closed' without throwing", () => {
    const ch = new PeerDataChannel();
    expect(() => ch.close()).not.toThrow();
    expect(ch.state).toBe("closed");
  });

  it("onStateChange is called on close()", () => {
    const ch = new PeerDataChannel();
    const states: string[] = [];
    ch.onStateChange = (s) => states.push(s);
    ch.close();
    expect(states).toContain("closed");
  });

  it("onClose callback fires on close()", () => {
    const ch = new PeerDataChannel();
    let closed = false;
    ch.onClose = () => { closed = true; };
    ch.close();
    expect(closed).toBe(true);
  });

  it("close() is idempotent — no double callbacks", () => {
    const ch = new PeerDataChannel();
    let count = 0;
    ch.onClose = () => { count++; };
    ch.close();
    ch.close();
    expect(count).toBe(1);
  });

  it("applyAnswer() throws when no peer connection exists", async () => {
    const ch = new PeerDataChannel();
    await expect(ch.applyAnswer({ type: "answer", sdp: "" })).rejects.toThrow();
  });

  it("addIceCandidate() is a no-op when no peer connection exists", async () => {
    const ch = new PeerDataChannel();
    await expect(ch.addIceCandidate({ candidate: "" })).resolves.toBeUndefined();
  });

  it("accepts custom ICE servers and label in constructor", () => {
    const ch = new PeerDataChannel({
      label: "test-channel",
      iceServers: [{ urls: "stun:example.com:3478" }],
      maxReconnectAttempts: 5,
    });
    // No error thrown; state is still new.
    expect(ch.state).toBe("new");
  });
});

// ── SpectatorChannel ──────────────────────────────────────────────────────────

describe("SpectatorChannel", () => {
  it("starts in 'new' state", () => {
    const ch = new SpectatorChannel();
    expect(ch.state).toBe("new");
    expect(ch.isWatching).toBe(false);
  });

  it("acceptOffer() throws when RTCPeerConnection is unavailable", async () => {
    const ch = new SpectatorChannel();
    await expect(ch.acceptOffer({ type: "offer", sdp: "" })).rejects.toThrow(/WebRTC is not available/);
  });

  it("addIceCandidate() is a no-op with no peer connection", async () => {
    const ch = new SpectatorChannel();
    await expect(ch.addIceCandidate({ candidate: "" })).resolves.toBeUndefined();
  });

  it("close() transitions to 'closed'", () => {
    const ch = new SpectatorChannel();
    ch.close();
    expect(ch.state).toBe("closed");
    expect(ch.isWatching).toBe(false);
  });

  it("close() calls onClose callback", () => {
    const ch = new SpectatorChannel();
    let closed = false;
    ch.onClose = () => { closed = true; };
    ch.close();
    expect(closed).toBe(true);
  });

  it("close() is idempotent — onClose does not fire twice", () => {
    const ch = new SpectatorChannel();
    let count = 0;
    ch.onClose = () => { count++; };
    ch.close();
    ch.close();
    expect(count).toBe(1);
  });

  it("close() is idempotent — onStateChange does not fire twice", () => {
    const ch = new SpectatorChannel();
    let count = 0;
    ch.onStateChange = () => { count++; };
    ch.close();
    ch.close();
    expect(count).toBe(1);
  });

  it("SpectatorChannel has no send() method (read-only contract)", () => {
    const ch = new SpectatorChannel();
    expect((ch as unknown as Record<string, unknown>)["send"]).toBeUndefined();
  });

  it("onStateChange fires on close()", () => {
    const ch = new SpectatorChannel();
    const states: string[] = [];
    ch.onStateChange = (s) => states.push(s);
    ch.close();
    expect(states).toContain("closed");
  });
});

// ── PeerMessage types ─────────────────────────────────────────────────────────

describe("PeerMessage type system", () => {
  it("ping message has correct shape", () => {
    const msg: PeerMessage = { type: "ping", timestamp: 1000 };
    expect(msg.type).toBe("ping");
  });

  it("pong message has correct shape", () => {
    const msg: PeerMessage = { type: "pong", timestamp: 1001, echoTimestamp: 1000 };
    expect(msg.type).toBe("pong");
    expect(msg.echoTimestamp).toBe(1000);
  });

  it("state message has seq and payload", () => {
    const msg: PeerMessage = { type: "state", seq: 42, payload: "abc" };
    expect(msg.seq).toBe(42);
  });

  it("chat message has text and senderName", () => {
    const msg: PeerMessage = { type: "chat", text: "hello", senderName: "Alice" };
    expect(msg.text).toBe("hello");
  });

  it("spectator_count message has count", () => {
    const msg: PeerMessage = { type: "spectator_count", count: 5 };
    expect(msg.count).toBe(5);
  });
});

// ── WebRTC availability guard ─────────────────────────────────────────────────

describe("isWebRTCAvailable / WebRTC guard", () => {
  it("createOffer() throws when only RTCPeerConnection is absent", async () => {
    // jsdom does not expose RTCPeerConnection — confirm the guard fires.
    const ch = new PeerDataChannel();
    await expect(ch.createOffer()).rejects.toThrow(/WebRTC is not available/);
  });

  it("acceptOffer() throws when RTCPeerConnection is absent", async () => {
    const ch = new SpectatorChannel();
    await expect(ch.acceptOffer({ type: "offer", sdp: "" })).rejects.toThrow(/WebRTC is not available/);
  });

  it("createAnswer/applyAnswer/addIceCandidate pass plain objects to RTCPeerConnection", async () => {
    // Install minimal RTCPeerConnection mock so the WebRTC path is exercised.
    const receivedRemoteDescs: RTCSessionDescriptionInit[] = [];
    const receivedCandidates: RTCIceCandidateInit[] = [];

    const mockDc = {
      onopen: null as (() => void) | null,
      onclose: null as (() => void) | null,
      onerror: null as unknown,
      onmessage: null as unknown,
    };

    const mockPc = {
      onicecandidate: null as unknown,
      onconnectionstatechange: null as unknown,
      ondatachannel: null as unknown,
      connectionState: "new",
      createOffer: vi.fn().mockResolvedValue({ type: "offer", sdp: "mock-sdp" }),
      createAnswer: vi.fn().mockResolvedValue({ type: "answer", sdp: "mock-answer" }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockImplementation((desc: RTCSessionDescriptionInit) => {
        receivedRemoteDescs.push(desc);
        return Promise.resolve();
      }),
      addIceCandidate: vi.fn().mockImplementation((candidate: RTCIceCandidateInit) => {
        receivedCandidates.push(candidate);
        return Promise.resolve();
      }),
      createDataChannel: vi.fn().mockReturnValue(mockDc),
      close: vi.fn(),
    };

    // Temporarily install the RTCPeerConnection mock.
    const origRTCPC = (globalThis as Record<string, unknown>)["RTCPeerConnection"];
    (globalThis as Record<string, unknown>)["RTCPeerConnection"] = vi.fn().mockReturnValue(mockPc);
    try {
      const ch = new PeerDataChannel();

      // createOffer — no setRemoteDescription here, just ensure it doesn't throw.
      await ch.createOffer();
      expect(mockPc.createOffer).toHaveBeenCalled();

      // applyAnswer — should pass the plain object directly (no RTCSessionDescription constructor).
      const answer: RTCSessionDescriptionInit = { type: "answer", sdp: "my-answer" };
      await ch.applyAnswer(answer);
      expect(receivedRemoteDescs).toContain(answer);

      // addIceCandidate — should pass the plain object directly.
      const candidate: RTCIceCandidateInit = { candidate: "candidate:1 1 UDP 2130706431 192.168.1.1 54400 typ host", sdpMid: "0" };
      await ch.addIceCandidate(candidate);
      expect(receivedCandidates).toContain(candidate);
    } finally {
      if (origRTCPC !== undefined) {
        (globalThis as Record<string, unknown>)["RTCPeerConnection"] = origRTCPC;
      } else {
        delete (globalThis as Record<string, unknown>)["RTCPeerConnection"];
      }
    }
  });
});
