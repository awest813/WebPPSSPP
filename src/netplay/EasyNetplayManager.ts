/**
 * EasyNetplayManager.ts — Central session state machine for Easy Netplay.
 *
 * Coordinates the signaling client, compatibility checks, and diagnostics into
 * a single typed state machine.  The UI layer subscribes to events via
 * `onEvent()` and drives the session with `hostRoom()` / `joinRoom()` /
 * `watchRoom()` / `leaveRoom()`.
 *
 * The manager deliberately does NOT perform WebRTC negotiation itself — that
 * is delegated to EmulatorJS via the existing `window.EJS_*` globals.  Our
 * role is to make room discovery and setup effortless.
 */

import type {
  NetplaySessionState,
  EasyNetplayRoom,
  NetplayEvent,
  SpectatorSession,
  HostRoomOptions,
  JoinRoomOptions,
  WatchRoomOptions,
} from "./netplayTypes.js";
import {
  HttpSignalingClient,
  signalingRoomToEasyRoom,
  normaliseInviteCode,
  generateInviteCode,
  type SignalingClient,
  type CreateRoomOptions,
} from "./signalingClient.js";
import { DiagnosticsLog, MSG } from "./diagnostics.js";
import { checkSystemSupport, checkGameCompatibility } from "./compatibility.js";

// ── EasyNetplayManager ────────────────────────────────────────────────────────

/**
 * Central coordinator for a single Easy Netplay session.
 *
 * Lifecycle:
 *   1. Construct with a server URL.
 *   2. Register an event listener via `onEvent()`.
 *   3. Call `hostRoom()` or `joinRoom()`.
 *   4. Call `leaveRoom()` when done (or on page unload).
 *
 * The manager is single-session: once a session ends it returns to `idle`
 * and can be reused for a new host/join.
 */
export class EasyNetplayManager {
  private _state:            NetplaySessionState = "idle";
  private _room:             EasyNetplayRoom | null = null;
  private _spectatorSession: SpectatorSession | null = null;
  private _sigClient:        SignalingClient | null = null;
  private _serverUrl:        string = "";
  private _listeners:  Array<(ev: NetplayEvent) => void> = [];
  private _hostAbort:  AbortController | null = null;
  private _joinAbort:  AbortController | null = null;
  private _diagnostics = new DiagnosticsLog();

  constructor(serverUrl?: string) {
    if (serverUrl) this.setServerUrl(serverUrl);
    // Wire diagnostics events through as netplay events so listeners get them.
    this._diagnostics.onEntry(entry => {
      this._emit({ type: "diagnostic", diagnostic: entry });
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Update the signaling server URL. */
  setServerUrl(url: string): void {
    this.cancelPendingOperations();
    this._serverUrl = url.trim();
    this._sigClient = this._serverUrl.length > 0
      ? new HttpSignalingClient(this._serverUrl)
      : null;
  }

  /** Current session state. */
  get state(): NetplaySessionState { return this._state; }

  /** Current active room, or null when idle/failed. */
  get room(): EasyNetplayRoom | null { return this._room; }

  /** True when the local user is spectating (not playing). */
  get isSpectating(): boolean { return this._state === "watching"; }

  /** The current spectator session, or null when not spectating. */
  get spectatorSession(): SpectatorSession | null { return this._spectatorSession; }

  /** Diagnostic log for this session. */
  get diagnostics(): DiagnosticsLog { return this._diagnostics; }

  /**
   * Register a listener for all netplay events.
   * Returns an unsubscribe function.
   */
  onEvent(fn: (ev: NetplayEvent) => void): () => void {
    this._listeners.push(fn);
    return () => {
      this._listeners = this._listeners.filter(l => l !== fn);
    };
  }

  /**
   * Abort in-flight host/join requests without changing room/session state.
   *
   * Useful when the UI that initiated a request is dismissed (e.g. a modal is
   * closed) and we want to avoid stale completion callbacks.
   */
  cancelPendingOperations(): void {
    this._cancelPendingRequests();
    if ((this._state === "hosting" || this._state === "joining" || this._state === "spectating" || this._state === "reconnecting") && !this._room) {
      this._setState("idle");
    }
  }

  /**
   * Host a new room.
   *
   * Validates system support, creates the room via the signaling server, and
   * transitions state to `hosting`.  If the signaling server is unreachable
   * we emit an offline room with a locally-generated invite code so the user
   * can still share it manually.
   */
  async hostRoom(options: HostRoomOptions): Promise<void> {
    if (this._state !== "idle") {
      await this.leaveRoom();
    }

    this._diagnostics.clear();
    this._setState("hosting");

    // Compatibility check.
    const sysCheck = checkSystemSupport(options.systemId);
    if (!sysCheck.compatible) {
      const msg = sysCheck.errors[0] ?? MSG.unsupportedSystem;
      this._diagnostics.error(msg);
      this._emit({ type: "error", code: "unsupported_system", message: msg });
      this._setState("failed");
      return;
    }

    this._diagnostics.info(MSG.signalingConnecting);

    if (!this._sigClient) {
      // No server configured — create a local-only stub room.
      this._diagnostics.warn(
        "No netplay server configured. Room is local-only.",
        "Set a server URL in Settings → Play Together to share with friends over the internet."
      );
      const stubRoom = this._makeLocalStubRoom(options);
      this._room = stubRoom;
      this._diagnostics.info(MSG.roomCreated);
      this._emit({ type: "room_created", room: stubRoom });
      this._diagnostics.info(MSG.waitingForPlayer);
      return;
    }

    this._hostAbort = new AbortController();

    try {
      const displayName = options.hostName.trim() || "Player";
      const createOpts: CreateRoomOptions = {
        name:       `${displayName}'s Room`,
        gameId:     options.gameId,
        gameName:   options.gameName,
        systemId:   options.systemId,
        hostName:   options.hostName,
        privacy:    options.privacy ?? "local",
        maxPlayers: options.maxPlayers ?? 2,
        password:   options.password,
      };

      const sigRoom = await this._sigClient.createRoom(createOpts, this._hostAbort.signal);
      this._diagnostics.info(MSG.signalingConnected);

      const room = signalingRoomToEasyRoom(sigRoom);
      this._room = room;
      this._diagnostics.info(MSG.roomCreated);
      this._emit({ type: "room_created", room });
      this._diagnostics.info(MSG.waitingForPlayer);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      const msg = MSG.serverUnavailable;
      this._diagnostics.warn(
        msg,
        err instanceof Error ? err.message : String(err)
      );
      // Fall back to local-only stub room on server error.
      const stubRoom = this._makeLocalStubRoom(options);
      this._room = stubRoom;
      this._diagnostics.info("Using local room (server unavailable). Share your code manually.");
      this._emit({ type: "room_created", room: stubRoom });
      this._diagnostics.info(MSG.waitingForPlayer);
    } finally {
      this._hostAbort = null;
    }
  }

  /**
   * Join an existing room by invite code.
   *
   * Validates the invite code format, resolves it via the signaling server,
   * runs compatibility checks against the reported room metadata, then
   * transitions to `joining`.
   */
  async joinRoom(options: JoinRoomOptions): Promise<void> {
    if (this._state !== "idle") {
      await this.leaveRoom();
    }

    this._diagnostics.clear();
    this._setState("joining");

    const normCode = normaliseInviteCode(options.code);
    if (normCode.length < 4) {
      const msg = "Invalid invite code — please check and try again.";
      this._diagnostics.error(msg);
      this._emit({ type: "error", code: "invalid_code", message: msg });
      this._setState("failed");
      return;
    }

    if (!this._sigClient) {
      const msg = MSG.serverUnavailable;
      this._diagnostics.error(
        msg,
        "No netplay server URL is configured. Go to Settings → Play Together and add a server URL."
      );
      this._emit({ type: "error", code: "server_unavailable", message: msg });
      this._setState("failed");
      return;
    }

    this._diagnostics.info(MSG.signalingConnecting);
    this._joinAbort = new AbortController();

    try {
      const sigRoom = await this._sigClient.joinRoom(normCode, this._joinAbort.signal);
      this._diagnostics.info(MSG.signalingConnected);

      const room = signalingRoomToEasyRoom(sigRoom);

      // Run compatibility check: compare local game/system against the remote room.
      // Only performed when the caller provides local game metadata.
      if (options.localGameId || options.localSystemId) {
        const compatResult = checkGameCompatibility(
          options.localGameId  ?? room.gameId,
          options.localSystemId ?? room.systemId,
          room.gameId,
          room.systemId,
        );
        for (const w of compatResult.warnings) {
          this._diagnostics.warn(w);
        }
        if (!compatResult.compatible) {
          const msg = compatResult.errors[0] ?? MSG.gameMismatch;
          this._diagnostics.error(msg);
          this._emit({ type: "error", code: "incompatible_rom", message: msg });
          this._setState("failed");
          return;
        }
      }

      this._room = room;
      this._diagnostics.info(MSG.roomJoined);
      this._emit({ type: "room_joined", room });
      this._setState("connected");
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      const code = (err instanceof Error && "code" in err)
        ? String((err as Record<string, unknown>).code)
        : "unknown";
      const msg = err instanceof Error ? err.message : MSG.unknownError;
      this._diagnostics.error(msg, err instanceof Error ? err.stack : undefined);
      this._emit({ type: "error", code, message: msg });
      this._setState("failed");
    } finally {
      this._joinAbort = null;
    }
  }

  /**
   * Fetch the current room list from the signaling server.
   *
   * Returns an empty array when the server is unreachable or not configured.
   */
  async listRooms(signal?: AbortSignal): Promise<EasyNetplayRoom[]> {
    if (!this._sigClient) return [];
    try {
      const rooms = await this._sigClient.listRooms(signal);
      return rooms.map(signalingRoomToEasyRoom);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      return [];
    }
  }

  /** Leave the current room and return to idle. */
  async leaveRoom(): Promise<void> {
    // Cancel any in-flight host/join request.
    this._cancelPendingRequests();

    if (this._room && this._sigClient) {
      try {
        await this._sigClient.leaveRoom(this._room.id);
      } catch {
        // Leave failures are non-fatal — always clean up local state.
      }
    }

    const reason = this._room?.name ? `Left ${this._room.name}` : undefined;
    this._room             = null;
    this._spectatorSession = null;
    this._diagnostics.info(MSG.roomLeft);
    this._emit({ type: "disconnected", reason });
    this._setState("idle");
  }

  /**
   * Join a room as a read-only spectator.
   *
   * Spectators see the game being played but do not participate.  The session
   * transitions to the `watching` state on success.  Spectators can leave
   * via `leaveRoom()` exactly like active players.
   */
  async watchRoom(options: WatchRoomOptions): Promise<void> {
    if (this._state !== "idle") {
      await this.leaveRoom();
    }

    this._diagnostics.clear();
    this._setState("spectating");

    const normCode = normaliseInviteCode(options.code);
    if (normCode.length < 4) {
      const msg = "Invalid invite code — please check and try again.";
      this._diagnostics.error(msg);
      this._emit({ type: "error", code: "invalid_code", message: msg });
      this._setState("failed");
      return;
    }

    if (!this._sigClient) {
      const msg = MSG.serverUnavailable;
      this._diagnostics.error(
        msg,
        "No netplay server URL is configured. Go to Settings → Play Together and add a server URL."
      );
      this._emit({ type: "error", code: "server_unavailable", message: msg });
      this._setState("failed");
      return;
    }

    this._diagnostics.info("Looking up room to spectate…");
    this._joinAbort = new AbortController();

    try {
      const sigRoom = await this._sigClient.joinRoom(normCode, this._joinAbort.signal);
      this._diagnostics.info(MSG.signalingConnected);

      const room = signalingRoomToEasyRoom(sigRoom);
      const session: SpectatorSession = {
        room,
        spectatorCount: 0,
      };
      this._room             = room;
      this._spectatorSession = session;
      this._diagnostics.info("Joined as spectator — watching the game.");
      this._emit({ type: "spectator_joined", session });
      this._setState("watching");
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      const code = (err instanceof Error && "code" in err)
        ? String((err as Record<string, unknown>).code)
        : "unknown";
      const msg = err instanceof Error ? err.message : MSG.unknownError;
      this._diagnostics.error(msg, err instanceof Error ? err.stack : undefined);
      this._emit({ type: "error", code, message: msg });
      this._setState("failed");
    } finally {
      this._joinAbort = null;
    }
  }

  /**
   * Update the live player count for the current room and broadcast to listeners.
   *
   * Called by the Browse panel's auto-refresh to surface updated player counts
   * without requiring a full list reload.
   *
   * Silently ignores non-finite or negative counts to prevent bad data from
   * propagating to the UI.
   */
  updatePlayerCount(roomId: string, count: number): void {
    if (!Number.isFinite(count) || count < 0) return;
    this._emit({ type: "player_count", roomId, count });
  }

  /** Transition to `in_game` state once EmulatorJS has started the session. */
  markInGame(): void {
    if (this._state === "connected") {
      this._setState("in_game");
      this._diagnostics.info(MSG.sessionStarting);
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _setState(state: NetplaySessionState): void {
    this._state = state;
    this._emit({ type: "state_changed", state });
  }

  private _emit(ev: NetplayEvent): void {
    for (const fn of this._listeners) {
      try { fn(ev); } catch (err) {
        // Listener errors must never crash the session state machine.
        // Log to console so bugs in UI layer are still visible during development.
        console.error("[EasyNetplayManager] Listener threw an error:", err);
      }
    }
  }

  private _cancelPendingRequests(): void {
    this._hostAbort?.abort();
    this._hostAbort = null;
    this._joinAbort?.abort();
    this._joinAbort = null;
  }

  /**
   * Create a locally-scoped stub room when the signaling server is unavailable.
   *
   * The invite code is derived from a stable hash so it stays the same for
   * the same game on the same device session.
   */
  private _makeLocalStubRoom(options: HostRoomOptions): EasyNetplayRoom {
    const sessionSeed = `local_${options.gameId}_${Date.now()}`;
    const id   = sessionSeed;
    const code = generateInviteCode(sessionSeed);
    const displayName = options.hostName.trim() || "Player";
    return {
      id,
      code,
      name:        `${displayName}'s Room`,
      privacy:     options.privacy ?? "local",
      gameId:      options.gameId,
      gameName:    options.gameName,
      systemId:    options.systemId,
      hostName:    options.hostName,
      playerCount: 1,
      maxPlayers:  options.maxPlayers ?? 2,
      hasPassword: Boolean(options.password),
      isLocal:     true,
      createdAt:   Date.now(),
    };
  }
}
