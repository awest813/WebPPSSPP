/**
 * signalingClient.ts — HTTP-based signaling abstraction for Easy Netplay.
 *
 * Provides a clean interface for room creation, discovery, and joining so the
 * rest of the system is decoupled from any specific server implementation.
 *
 * The default `HttpSignalingClient` works with any server that exposes:
 *   POST   /rooms           — create a room
 *   GET    /rooms           — list open rooms
 *   GET    /rooms/:code     — look up a room by invite code or room ID
 *   POST   /rooms/:id/leave — leave a room (best-effort)
 *
 * Servers that use different URL schemas (e.g. the legacy EmulatorJS netplay
 * server's /list?domain=… endpoint) are handled by the fallback probe loop
 * inherited from NetplayManager.fetchLobbyRooms().
 */

import type { EasyNetplayRoom, RoomPrivacy } from "./netplayTypes.js";

// ── Public types ──────────────────────────────────────────────────────────────

/** Options forwarded when asking the server to create a new room. */
export interface CreateRoomOptions {
  name?:       string;
  gameId:      string;
  gameName:    string;
  systemId:    string;
  hostName:    string;
  privacy:     RoomPrivacy;
  maxPlayers?: number;
  password?:   string;
}

/** Minimal room representation returned by the signaling server. */
export interface SignalingRoom {
  id:          string;
  code:        string;
  name:        string;
  gameId:      string;
  gameName:    string;
  systemId:    string;
  hostName:    string;
  privacy:     RoomPrivacy;
  playerCount: number;
  maxPlayers:  number;
  hasPassword: boolean;
  createdAt:   number;
  latencyMs?:  number;
}

/**
 * Abstract signaling client interface.
 *
 * Swap the implementation to support different backends (PlaySocketJS,
 * custom REST APIs, local mock for tests, etc.).
 */
export interface SignalingClient {
  /** Create a new room and return its details including the invite code. */
  createRoom(options: CreateRoomOptions, signal?: AbortSignal): Promise<SignalingRoom>;
  /** Resolve a short invite code (or room ID) to its room details. */
  joinRoom(code: string, signal?: AbortSignal): Promise<SignalingRoom>;
  /** List all open rooms visible to this client. */
  listRooms(signal?: AbortSignal): Promise<SignalingRoom[]>;
  /** Leave / close a room.  Failures are non-fatal. */
  leaveRoom(roomId: string): Promise<void>;
}

// ── Invite code helpers ───────────────────────────────────────────────────────

/** Alphabet used for invite codes (uppercase, no ambiguous chars 0/O, 1/I/L). */
const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const INVITE_CODE_LEN = 6;

/**
 * Derive a stable, short invite code from a room ID string.
 *
 * Uses djb2 with base-32 encoding from an unambiguous alphabet so users can
 * reliably transcribe codes from voice, chat, or a shared screen.
 */
export function generateInviteCode(roomId: string): string {
  let hash = 5381;
  for (let i = 0; i < roomId.length; i++) {
    hash = ((hash << 5) + hash + roomId.charCodeAt(i)) >>> 0;
  }
  let code = "";
  let h = hash;
  for (let i = 0; i < INVITE_CODE_LEN; i++) {
    code += INVITE_ALPHABET[h % INVITE_ALPHABET.length];
    // Rotate right by 5 bits to mix different parts of the hash into each
    // character position, avoiding repeated characters for low-entropy IDs.
    h = (h >>> 5) | (h << (32 - 5));
    h >>>= 0;
  }
  return code;
}

/**
 * Normalise a user-typed invite code for comparison.
 * Strips spaces/dashes, uppercases, and trims to the expected length.
 */
export function normaliseInviteCode(raw: string): string {
  return raw.replace(/[\s\-_]/g, "").toUpperCase().slice(0, INVITE_CODE_LEN);
}

// ── HTTP signaling client ─────────────────────────────────────────────────────

/**
 * REST-based signaling client that works with any standard netplay server.
 *
 * The base URL should be the WebSocket URL configured in settings; this class
 * converts it to an HTTP/HTTPS URL for REST calls.
 */
export class HttpSignalingClient implements SignalingClient {
  private readonly _httpBase: string;

  constructor(wsUrl: string) {
    this._httpBase = wsUrl
      .replace(/^ws:\/\//i,  "http://")
      .replace(/^wss:\/\//i, "https://")
      .replace(/\/+$/, "");
  }

  async createRoom(options: CreateRoomOptions, signal?: AbortSignal): Promise<SignalingRoom> {
    const res = await fetch(`${this._httpBase}/rooms`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        gameId:     options.gameId,
        gameName:   options.gameName,
        systemId:   options.systemId,
        host:       options.hostName,
        name:       options.name ?? `${options.hostName}'s Room`,
        privacy:    options.privacy,
        maxPlayers: options.maxPlayers ?? 2,
        password:   options.password,
      }),
      signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw Object.assign(
        new Error(`Server returned ${res.status}${detail ? ": " + detail : ""}`),
        { status: res.status }
      );
    }

    const body = await res.json() as Record<string, unknown>;
    return this._coerce(body);
  }

  async joinRoom(code: string, signal?: AbortSignal): Promise<SignalingRoom> {
    const normalised = normaliseInviteCode(code);
    const res = await fetch(
      `${this._httpBase}/rooms/${encodeURIComponent(normalised)}`,
      { headers: { Accept: "application/json" }, signal }
    );

    if (res.status === 404) {
      throw Object.assign(
        new Error("Room not found — it may have been closed by the host."),
        { code: "room_not_found" }
      );
    }
    if (!res.ok) {
      throw Object.assign(
        new Error(`Server returned ${res.status}`),
        { status: res.status }
      );
    }

    const body = await res.json() as Record<string, unknown>;
    return this._coerce(body);
  }

  async listRooms(signal?: AbortSignal): Promise<SignalingRoom[]> {
    // Try multiple common endpoint paths used by different server implementations.
    const candidates = ["/rooms", "/lobby/rooms", "/netplay/rooms"];

    for (const path of candidates) {
      try {
        const res = await fetch(`${this._httpBase}${path}`, {
          headers: { Accept: "application/json" },
          signal,
        });
        if (!res.ok) continue;
        const body = await res.json() as unknown;
        return this._coerceList(body);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        // Try next candidate.
      }
    }
    return [];
  }

  async leaveRoom(roomId: string): Promise<void> {
    try {
      await fetch(`${this._httpBase}/rooms/${encodeURIComponent(roomId)}/leave`, {
        method: "POST",
      });
    } catch {
      // Leave failures are non-fatal.
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private _coerceList(body: unknown): SignalingRoom[] {
    let arr: unknown[] = [];
    if (Array.isArray(body)) {
      arr = body;
    } else if (body && typeof body === "object") {
      const wrapped = (body as Record<string, unknown>).rooms;
      if (Array.isArray(wrapped)) arr = wrapped;
    }
    return arr
      .filter(item => item && typeof item === "object")
      .map(item => this._coerce(item as Record<string, unknown>));
  }

  private _coerce(row: Record<string, unknown>): SignalingRoom {
    const rawId = row.id ?? row.roomId ?? row.room_id ?? "";
    const id    = String(rawId);
    const code  = String(
      row.code ?? row.invite_code ?? row.inviteCode ?? generateInviteCode(id)
    );

    const privacyRaw = String(row.privacy ?? "public");
    const privacy: RoomPrivacy = (["local", "private", "public"] as const).includes(
      privacyRaw as RoomPrivacy
    )
      ? (privacyRaw as RoomPrivacy)
      : "public";

    return {
      id,
      code,
      name:        String(row.name ?? row.room_name ?? `Room ${id}`),
      gameId:      String(row.gameId ?? row.game_id ?? ""),
      gameName:    String(row.gameName ?? row.game_name ?? ""),
      systemId:    String(row.systemId ?? row.system_id ?? ""),
      hostName:    String(row.host ?? row.hostName ?? row.host_name ?? "Host"),
      privacy,
      playerCount: Number(row.players ?? row.playerCount ?? row.player_count ?? 1),
      maxPlayers:  Number(row.maxPlayers ?? row.max_players ?? row.max ?? 2),
      hasPassword: Boolean(row.hasPassword ?? row.has_password ?? false),
      latencyMs:   typeof row.latencyMs === "number" ? row.latencyMs
                 : typeof row.latency   === "number" ? row.latency
                 : typeof row.ping      === "number" ? row.ping
                 : undefined,
      createdAt:   Number(row.createdAt ?? row.created_at ?? Date.now()),
    };
  }
}

// ── Helpers to convert SignalingRoom → EasyNetplayRoom ────────────────────────

/** Local-room heuristic: privacy is "local" OR latency under 50 ms. */
const LOCAL_LATENCY_THRESHOLD_MS = 50;

export function signalingRoomToEasyRoom(r: SignalingRoom): EasyNetplayRoom {
  const isLocal =
    r.privacy === "local" ||
    (r.latencyMs !== undefined && r.latencyMs < LOCAL_LATENCY_THRESHOLD_MS);
  return { ...r, isLocal };
}
