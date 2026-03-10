/**
 * netplayTypes.ts — Core types for the Easy Netplay system.
 *
 * Defines the session state machine, room models, player models, and event
 * types used across the netplay modules.  Keep this file free of business
 * logic; it is imported by every other netplay module.
 */

// ── Session state machine ─────────────────────────────────────────────────────

/**
 * All possible states for a netplay session.
 *
 * Transitions:
 *   idle → hosting | joining
 *   hosting → connected | failed
 *   joining → connected | failed
 *   connected → in_game | disconnected
 *   in_game → disconnected
 *   disconnected → reconnecting | idle
 *   reconnecting → connected | failed
 *   failed → idle
 */
export type NetplaySessionState =
  | "idle"
  | "hosting"
  | "joining"
  | "connected"
  | "in_game"
  | "disconnected"
  | "reconnecting"
  | "failed";

// ── Room types ────────────────────────────────────────────────────────────────

/** Privacy / visibility level for a netplay room. */
export type RoomPrivacy = "local" | "private" | "public";

/**
 * A netplay room as seen by our Easy Netplay layer.
 *
 * Fields marked optional may not be available from all server implementations.
 */
export interface EasyNetplayRoom {
  /** Unique server-assigned room identifier. */
  id: string;
  /** Short human-friendly invite code (e.g. "AB12CD"). */
  code: string;
  /** Display name shown in the room browser. */
  name: string;
  /** Privacy level: local (LAN-visible), private (code only), or public. */
  privacy: RoomPrivacy;
  /** Canonical game identifier (hashed room key from multiplayer.ts). */
  gameId: string;
  /** Human-readable game title. */
  gameName: string;
  /** System identifier (e.g. "psp", "gba"). */
  systemId: string;
  /** Display name of the host player. */
  hostName: string;
  /** Current player count. */
  playerCount: number;
  /** Maximum allowed players. */
  maxPlayers: number;
  /** Whether the room requires a password to join. */
  hasPassword: boolean;
  /**
   * True when the room appears to be on the same local network.
   * Heuristic: privacy === "local" or latency below a threshold.
   */
  isLocal: boolean;
  /** Round-trip latency in milliseconds, if known. */
  latencyMs?: number;
  /** Unix epoch ms when the room was created. */
  createdAt: number;
}

// ── Player ────────────────────────────────────────────────────────────────────

/** A player in a netplay session. */
export interface NetplayPlayer {
  /** Unique session-scoped player identifier. */
  id: string;
  /** Display name. */
  name: string;
  /** True for the room host. */
  isHost: boolean;
  /** True when the player is on the same local network. */
  isLocal: boolean;
  /** Round-trip latency to this player, in milliseconds. */
  latencyMs?: number;
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

export type NetplayDiagnosticLevel = "info" | "warning" | "error";

/** A single diagnostic entry surfaced to the user. */
export interface NetplayDiagnosticEntry {
  level: NetplayDiagnosticLevel;
  /** Plain-English message shown directly to the user. */
  message: string;
  /** Optional technical detail hidden behind an "Advanced" toggle. */
  detail?: string;
  timestamp: number;
}

// ── Events ────────────────────────────────────────────────────────────────────

/** Union of all events emitted by EasyNetplayManager. */
export type NetplayEvent =
  | { type: "state_changed";  state:      NetplaySessionState }
  | { type: "room_created";   room:       EasyNetplayRoom }
  | { type: "room_joined";    room:       EasyNetplayRoom }
  | { type: "player_joined";  player:     NetplayPlayer }
  | { type: "player_left";    player:     NetplayPlayer }
  | { type: "diagnostic";     diagnostic: NetplayDiagnosticEntry }
  | { type: "error";          code:       string; message: string }
  | { type: "disconnected";   reason?:    string };

// ── Host / Join options ───────────────────────────────────────────────────────

/** Options supplied when hosting a new room. */
export interface HostRoomOptions {
  /** Player display name. Empty means anonymous. */
  hostName:   string;
  /** Current game's canonical ID string. */
  gameId:     string;
  /** Human-readable game title. */
  gameName:   string;
  /** Current system identifier (e.g. "psp"). */
  systemId:   string;
  /** Room privacy level — defaults to "local". */
  privacy?:   RoomPrivacy;
  /** Maximum players — defaults to 2. */
  maxPlayers?: number;
  /** Optional room password. */
  password?:   string;
}

/** Options supplied when joining an existing room. */
export interface JoinRoomOptions {
  /** Short invite code shared by the host. */
  code: string;
  /** Player display name. Empty means anonymous. */
  playerName: string;
  /** Optional password for password-protected rooms. */
  password?:  string;
  /**
   * Local game identifier — used for pre-join compatibility checks.
   * If provided, it will be compared against the room's reported game ID.
   */
  localGameId?:    string;
  /** Local system identifier — used for pre-join compatibility checks. */
  localSystemId?:  string;
}
