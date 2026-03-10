/**
 * diagnostics.ts — Plain-English connection diagnostics for Easy Netplay.
 *
 * Collects structured log entries and provides a curated set of user-facing
 * message strings that avoid WebRTC jargon.  Advanced details are available
 * for developers but are tucked away from the default view.
 */

import type { NetplayDiagnosticEntry, NetplayDiagnosticLevel } from "./netplayTypes.js";

// ── DiagnosticsLog ────────────────────────────────────────────────────────────

/** Maximum number of entries retained in the ring buffer. */
const MAX_ENTRIES = 64;

/**
 * Lightweight diagnostic log for a single netplay session.
 *
 * Callers push entries via `info()`, `warn()`, and `error()`.  A subscriber
 * registered via `onEntry()` is called synchronously on each new entry so
 * the UI can react immediately.
 */
export class DiagnosticsLog {
  private _entries: NetplayDiagnosticEntry[] = [];
  private _listener?: (entry: NetplayDiagnosticEntry) => void;

  /** Register a listener for new entries.  Only one listener at a time. */
  onEntry(fn: (entry: NetplayDiagnosticEntry) => void): void {
    this._listener = fn;
  }

  info(message: string, detail?: string): void {
    this._push("info", message, detail);
  }

  warn(message: string, detail?: string): void {
    this._push("warning", message, detail);
  }

  error(message: string, detail?: string): void {
    this._push("error", message, detail);
  }

  /** All retained entries, oldest first. */
  get entries(): readonly NetplayDiagnosticEntry[] {
    return this._entries;
  }

  /** The most recently added entry, or undefined if empty. */
  get latest(): NetplayDiagnosticEntry | undefined {
    return this._entries[this._entries.length - 1];
  }

  clear(): void {
    this._entries = [];
  }

  private _push(level: NetplayDiagnosticLevel, message: string, detail?: string): void {
    const entry: NetplayDiagnosticEntry = { level, message, detail, timestamp: Date.now() };
    if (this._entries.length >= MAX_ENTRIES) this._entries.shift();
    this._entries.push(entry);
    this._listener?.(entry);
  }
}

// ── Canned plain-English messages ─────────────────────────────────────────────

/**
 * Standard user-facing diagnostic messages.
 *
 * Using named constants avoids string duplication and makes it easy to update
 * copy without hunting through the codebase.
 */
export const MSG = {
  // Connection lifecycle
  signalingConnecting:  "Connecting to server…",
  signalingConnected:   "Connected to server",
  signalingLost:        "Connection to server lost — trying again",
  signalingFailed:      "Couldn't reach the server. Check the server URL in settings.",

  // Room lifecycle
  creatingRoom:         "Creating room…",
  roomCreated:          "Room created — share your code with a friend",
  joiningRoom:          "Joining room…",
  roomJoined:           "Joined room successfully",
  roomNotFound:         "Room not found — it may have been closed by the host.",
  roomFull:             "This room is full. Try another room or create your own.",
  roomLeft:             "You left the room.",

  // Peer connections
  peerConnecting:       "Connecting to player…",
  peerConnected:        "Player connected! Starting game…",
  peerDisconnected:     "Player disconnected",
  waitingForPlayer:     "Waiting for Player 2…",

  // Compatibility
  gameMismatch:         "Game versions may not match — make sure you and your friend have the same ROM.",
  systemMismatch:       "System mismatch — you and the host are not running the same system.",
  unsupportedSystem:    "This game doesn't support multiplayer.",

  // Session
  sessionStarting:      "Starting game session…",
  sessionEnded:         "Session ended",

  // Generic errors
  timeout:              "Connection timed out. Check your network and try again.",
  serverUnavailable:    "Netplay server is unavailable. Please try again later.",
  unknownError:         "Something went wrong — please try again.",
} as const;

export type MsgKey = keyof typeof MSG;

// ── Error code → plain-English mapping ───────────────────────────────────────

const _CODE_MAP: Record<string, string> = {
  room_not_found:    MSG.roomNotFound,
  room_full:         MSG.roomFull,
  incompatible_rom:  MSG.gameMismatch,
  unsupported_system: MSG.unsupportedSystem,
  network_timeout:   MSG.timeout,
  server_unavailable: MSG.serverUnavailable,
};

/**
 * Return a plain-English diagnostic message for the given error code.
 * Falls back to `MSG.unknownError` for unrecognised codes.
 */
export function diagnosticForErrorCode(code: string): string {
  return _CODE_MAP[code] ?? MSG.unknownError;
}
