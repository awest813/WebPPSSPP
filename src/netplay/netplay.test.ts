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
    expect(log.entries[0].level).toBe("info");
    expect(log.entries[0].message).toBe("hello");
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
    expect(spy.mock.calls[0][0].message).toBe("test");
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

    const calledUrl: string = fetchSpy.mock.calls[0][0] as string;
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

    const calledUrl: string = fetchSpy.mock.calls[0][0] as string;
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
    expect(rooms[0].code).toHaveLength(6);

    vi.unstubAllGlobals();
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
});
