/**
 * peerChannel.ts — WebRTC peer-to-peer data channel abstraction.
 *
 * Provides a clean, typed wrapper around `RTCPeerConnection` and
 * `RTCDataChannel` so the rest of the netplay system is decoupled from
 * raw WebRTC APIs.
 *
 * Two classes are exported:
 *   - `PeerDataChannel`  — bidirectional channel used by active players.
 *   - `SpectatorChannel` — receive-only channel used by spectators.
 *
 * Neither class manages signaling (SDP / ICE exchange); callers are
 * responsible for routing `offer`, `answer`, and `candidate` messages
 * through their signaling transport of choice (e.g. the HTTP/WebSocket
 * signaling server in `signalingClient.ts`).
 *
 * Design constraints:
 *   - Zero external dependencies.
 *   - No global side-effects; safe to instantiate in test environments.
 *   - Graceful degradation when WebRTC APIs are unavailable.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** ICE configuration forwarded to `RTCPeerConnection`. */
export interface PeerChannelIceConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Options for constructing a `PeerDataChannel`. */
export interface PeerDataChannelOptions {
  /**
   * Label for the RTCDataChannel.
   * Defaults to "retrovault-netplay".
   */
  label?: string;
  /**
   * ICE server list.  Defaults to a single Google STUN server so local
   * network connections work out of the box.
   */
  iceServers?: PeerChannelIceConfig[];
  /**
   * Maximum number of automatic reconnection attempts before giving up.
   * Defaults to 3.
   */
  maxReconnectAttempts?: number;
}

/** Possible states for a `PeerDataChannel`. */
export type PeerChannelState =
  | "new"
  | "connecting"
  | "open"
  | "closed"
  | "failed"
  | "reconnecting";

/** A serialisable message sent over the data channel. */
export type PeerMessage =
  | { type: "ping"; timestamp: number }
  | { type: "pong"; timestamp: number; echoTimestamp: number }
  | { type: "state"; seq: number; payload: string }
  | { type: "input"; seq: number; playerId: string; payload: string }
  | { type: "chat"; text: string; senderName: string }
  | { type: "spectator_count"; count: number };

// ── Default ICE servers ───────────────────────────────────────────────────────

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function toRtcIceServers(cfg?: PeerChannelIceConfig[]): RTCIceServer[] {
  if (!cfg || cfg.length === 0) return DEFAULT_ICE_SERVERS;
  return cfg.map((s) => ({
    urls:       s.urls,
    username:   s.username,
    credential: s.credential,
  }));
}

function isWebRTCAvailable(): boolean {
  return (
    typeof RTCPeerConnection !== "undefined" &&
    typeof RTCSessionDescription !== "undefined"
  );
}

/** Extract an Error from an RTCErrorEvent, with a fallback message. */
function extractRTCError(ev: Event, fallbackMsg: string): Error {
  return (ev as RTCErrorEvent).error instanceof Error
    ? (ev as RTCErrorEvent).error
    : new Error(fallbackMsg);
}

// ── PeerDataChannel ───────────────────────────────────────────────────────────

/**
 * Bidirectional WebRTC data channel used by active players.
 *
 * Lifecycle:
 *   1. Instantiate.
 *   2. Register callbacks (`onOpen`, `onMessage`, `onClose`, `onError`).
 *   3. **Offerer** calls `createOffer()` → sends SDP offer to peer via signaling.
 *   4. **Answerer** calls `createAnswer(offer)` → sends SDP answer back.
 *   5. Both sides call `addIceCandidate()` as ICE candidates arrive.
 *   6. On `onOpen`, call `send()` / `sendMessage()` freely.
 *   7. Call `close()` to cleanly terminate.
 */
export class PeerDataChannel {
  private _pc:      RTCPeerConnection | null = null;
  private _dc:      RTCDataChannel    | null = null;
  private _state:   PeerChannelState  = "new";
  private _label:   string;
  private _iceServers: RTCIceServer[];
  private _reconnectAttempts: number = 0;
  private _maxReconnectAttempts: number;

  // Callback hooks
  onOpen?:    () => void;
  onClose?:   (reason?: string) => void;
  onError?:   (error: Error) => void;
  onMessage?: (msg: PeerMessage) => void;
  onRawMessage?: (data: string | ArrayBuffer | Blob) => void;
  onStateChange?: (state: PeerChannelState) => void;
  onIceCandidate?: (candidate: RTCIceCandidate) => void;

  constructor(opts: PeerDataChannelOptions = {}) {
    this._label              = opts.label              ?? "retrovault-netplay";
    this._iceServers         = toRtcIceServers(opts.iceServers);
    this._maxReconnectAttempts = opts.maxReconnectAttempts ?? 3;
  }

  /** Current channel state. */
  get state(): PeerChannelState { return this._state; }

  /** Whether the data channel is open and ready to send. */
  get isOpen(): boolean { return this._state === "open"; }

  // ── Offer / Answer negotiation ──────────────────────────────────────────────

  /**
   * Create an SDP offer and initialise the peer connection.
   *
   * Call this on the **offerer** side (e.g. the host).
   * Returns the serialised offer that must be sent to the remote peer
   * via the signaling channel.
   */
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this._assertWebRTC();
    this._initPeerConnection(true /* isOfferer */);
    const offer = await this._pc!.createOffer();
    await this._pc!.setLocalDescription(offer);
    return offer;
  }

  /**
   * Process an incoming SDP offer from the remote peer and create an answer.
   *
   * Call this on the **answerer** side (e.g. the joiner).
   * Returns the serialised answer that must be sent back to the offerer.
   */
  async createAnswer(
    offer: RTCSessionDescriptionInit
  ): Promise<RTCSessionDescriptionInit> {
    this._assertWebRTC();
    this._initPeerConnection(false /* isOfferer */);
    await this._pc!.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this._pc!.createAnswer();
    await this._pc!.setLocalDescription(answer);
    return answer;
  }

  /**
   * Apply the remote SDP answer.  Call on the offerer side once the answerer's
   * SDP arrives through the signaling channel.
   */
  async applyAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (!this._pc) throw new Error("No peer connection — call createOffer() first.");
    await this._pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  /**
   * Add an ICE candidate received from the remote peer via the signaling channel.
   */
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this._pc) return;
    try {
      await this._pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      // Silently ignore candidates that arrive after the connection closes.
    }
  }

  // ── Data sending ────────────────────────────────────────────────────────────

  /**
   * Send a raw string or binary buffer.
   * Throws if the channel is not open.
   */
  send(data: string | ArrayBuffer): void {
    if (!this._dc || this._dc.readyState !== "open") {
      throw new Error("Data channel is not open.");
    }
    if (typeof data === "string") {
      this._dc.send(data);
    } else {
      this._dc.send(data);
    }
  }

  /**
   * Serialise and send a typed `PeerMessage`.
   */
  sendMessage(msg: PeerMessage): void {
    this.send(JSON.stringify(msg));
  }

  /**
   * Convenience: send a ping and return the round-trip time in milliseconds
   * via a Promise that resolves when the corresponding pong arrives.
   * Times out after `timeoutMs` (default 5000 ms).
   */
  ping(timeoutMs = 5_000): Promise<number> {
    return new Promise((resolve, reject) => {
      const sentAt = Date.now();
      const timeoutId = setTimeout(() => {
        reject(new Error("Ping timed out"));
      }, timeoutMs);

      const prev = this.onMessage;
      this.onMessage = (msg) => {
        if (msg.type === "pong" && msg.echoTimestamp === sentAt) {
          clearTimeout(timeoutId);
          this.onMessage = prev;
          resolve(Date.now() - sentAt);
          return;
        }
        prev?.(msg);
      };
      try {
        this.sendMessage({ type: "ping", timestamp: sentAt });
      } catch (err) {
        clearTimeout(timeoutId);
        this.onMessage = prev;
        reject(err);
      }
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /** Close the peer connection and data channel. */
  close(): void {
    if (this._state === "closed") return;
    this._setState("closed");
    this._dc?.close();
    this._pc?.close();
    this._dc = null;
    this._pc = null;
    this.onClose?.();
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _assertWebRTC(): void {
    if (!isWebRTCAvailable()) {
      throw new Error(
        "WebRTC is not available in this environment. " +
        "PeerDataChannel requires a browser with RTCPeerConnection support."
      );
    }
  }

  private _setState(state: PeerChannelState): void {
    if (this._state === state) return;
    this._state = state;
    this.onStateChange?.(state);
  }

  /**
   * Initialise the `RTCPeerConnection` and wire up event handlers.
   *
   * On the offerer side we also create the data channel immediately so that
   * SDP negotiation includes it.  On the answerer side the channel is created
   * by the peer connection's `ondatachannel` event.
   */
  private _initPeerConnection(isOfferer: boolean): void {
    if (this._pc) {
      this._pc.close();
    }
    this._pc = new RTCPeerConnection({ iceServers: this._iceServers });
    this._setState("connecting");

    // ── ICE candidates ───────────────────────────────────────────────────────
    this._pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.onIceCandidate?.(ev.candidate);
      }
    };

    // ── Connection state ─────────────────────────────────────────────────────
    this._pc.onconnectionstatechange = () => {
      const cs = this._pc?.connectionState;
      if (cs === "failed") {
        this._handleConnectionFailure();
      } else if (cs === "disconnected") {
        this._setState("reconnecting");
      }
    };

    // ── Data channel ─────────────────────────────────────────────────────────
    if (isOfferer) {
      this._dc = this._pc.createDataChannel(this._label, {
        ordered:  true,
      });
      this._wireDataChannel(this._dc);
    } else {
      this._pc.ondatachannel = (ev) => {
        this._dc = ev.channel;
        this._wireDataChannel(this._dc);
      };
    }
  }

  private _wireDataChannel(dc: RTCDataChannel): void {
    dc.onopen = () => {
      this._reconnectAttempts = 0;
      this._setState("open");
      this.onOpen?.();
    };

    dc.onclose = () => {
      if (this._state !== "closed" && this._state !== "failed") {
        this._handleConnectionFailure();
      }
    };

    dc.onerror = (ev) => {
      this.onError?.(extractRTCError(ev, "Data channel error"));
    };

    dc.onmessage = (ev) => {
      const raw = ev.data as unknown;
      this.onRawMessage?.(raw as string | ArrayBuffer | Blob);
      if (typeof raw === "string") {
        try {
          const msg = JSON.parse(raw) as PeerMessage;
          // Auto-respond to pings.
          if (msg.type === "ping") {
            try {
              this.sendMessage({ type: "pong", timestamp: Date.now(), echoTimestamp: msg.timestamp });
            } catch { /* ignore send failures during shutdown */ }
            return;
          }
          this.onMessage?.(msg);
        } catch {
          // Non-JSON messages are forwarded via onRawMessage only.
        }
      }
    };
  }

  private _handleConnectionFailure(): void {
    if (this._reconnectAttempts < this._maxReconnectAttempts) {
      this._reconnectAttempts++;
      this._setState("reconnecting");
    } else {
      this._setState("failed");
      this.onClose?.("Connection failed after maximum reconnect attempts.");
    }
  }
}

// ── SpectatorChannel ──────────────────────────────────────────────────────────

/**
 * Receive-only data channel for spectators.
 *
 * A `SpectatorChannel` joins a room as a read-only observer.  It shares the
 * same WebRTC negotiation flow as `PeerDataChannel` but exposes no `send()`
 * method, making the spectator intent explicit.
 *
 * The host should create a dedicated data channel (or broadcast via its
 * existing channel) for spectator updates.  This class works with either
 * approach: it accepts incoming data channels via `ondatachannel` and
 * exposes received messages via `onMessage`.
 *
 * Usage:
 *   1. Construct with ice servers (same as `PeerDataChannel`).
 *   2. Register `onOpen`, `onMessage`, `onClose`, `onError`, `onIceCandidate`.
 *   3. Call `acceptOffer(offer)` to start the answerer-side negotiation.
 *   4. Add ICE candidates via `addIceCandidate()`.
 *   5. `onOpen` fires when the first data channel is established.
 */
export class SpectatorChannel {
  private _pc:    RTCPeerConnection | null = null;
  private _dc:    RTCDataChannel    | null = null;
  private _state: PeerChannelState  = "new";
  private _iceServers: RTCIceServer[];

  onOpen?:         () => void;
  onClose?:        (reason?: string) => void;
  onError?:        (error: Error) => void;
  onMessage?:      (msg: PeerMessage) => void;
  onRawMessage?:   (data: string | ArrayBuffer | Blob) => void;
  onStateChange?:  (state: PeerChannelState) => void;
  onIceCandidate?: (candidate: RTCIceCandidate) => void;

  constructor(opts: Pick<PeerDataChannelOptions, "iceServers"> = {}) {
    this._iceServers = toRtcIceServers(opts.iceServers);
  }

  /** Current channel state. */
  get state(): PeerChannelState { return this._state; }

  /** Whether the spectator channel is receiving data. */
  get isWatching(): boolean { return this._state === "open"; }

  /**
   * Process an incoming SDP offer from the host and return an answer.
   * The host should treat spectator connections the same as player connections
   * at the WebRTC level; the spectator label is enforced here by omitting
   * `send()`.
   */
  async acceptOffer(
    offer: RTCSessionDescriptionInit
  ): Promise<RTCSessionDescriptionInit> {
    if (!isWebRTCAvailable()) {
      throw new Error("WebRTC is not available in this environment.");
    }
    if (this._pc) this._pc.close();

    this._pc = new RTCPeerConnection({ iceServers: this._iceServers });
    this._setState("connecting");

    this._pc.onicecandidate = (ev) => {
      if (ev.candidate) this.onIceCandidate?.(ev.candidate);
    };

    this._pc.onconnectionstatechange = () => {
      if (this._pc?.connectionState === "failed") {
        this._setState("failed");
        this.onClose?.("Connection failed.");
      }
    };

    this._pc.ondatachannel = (ev) => {
      this._dc = ev.channel;

      this._dc.onopen  = () => { this._setState("open"); this.onOpen?.(); };
      this._dc.onclose = () => { this._setState("closed"); this.onClose?.(); };
      this._dc.onerror = (e) => {
        this.onError?.(extractRTCError(e, "Spectator data channel error"));
      };
      this._dc.onmessage = (e) => {
        const raw = e.data as unknown;
        this.onRawMessage?.(raw as string | ArrayBuffer | Blob);
        if (typeof raw === "string") {
          try {
            this.onMessage?.(JSON.parse(raw) as PeerMessage);
          } catch { /* non-JSON ignored */ }
        }
      };
    };

    await this._pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this._pc.createAnswer();
    await this._pc.setLocalDescription(answer);
    return answer;
  }

  /**
   * Add an ICE candidate received via the signaling channel.
   */
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this._pc) return;
    try {
      await this._pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch { /* ignore stale candidates */ }
  }

  /** Close the spectator channel. */
  close(): void {
    this._setState("closed");
    this._dc?.close();
    this._pc?.close();
    this._dc = null;
    this._pc = null;
    this.onClose?.();
  }

  private _setState(state: PeerChannelState): void {
    if (this._state === state) return;
    this._state = state;
    this.onStateChange?.(state);
  }
}
