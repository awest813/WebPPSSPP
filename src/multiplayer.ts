/**
 * multiplayer.ts — Phase 6: Multiplayer & Social
 *
 * Provides `NetplayManager`, which manages the EmulatorJS netplay integration:
 *   - Netplay server URL (WebSocket endpoint that EmulatorJS connects to for
 *     room creation, room listing, and signalling)
 *   - ICE server list (STUN/TURN) forwarded to WebRTC peer connections
 *   - Enable/disable flag
 *   - Per-game numeric ID derived from the game's string ID
 *
 * Settings are persisted to `localStorage` under the key `rv:netplay`.
 *
 * The singleton is wired into `PSPEmulator.launch()` via `LaunchOptions` so
 * the appropriate `window.EJS_netplayServer`, `window.EJS_netplayICEServers`,
 * and `window.EJS_gameID` globals are set before EmulatorJS's loader.js runs.
 */

// ── Default public STUN servers ───────────────────────────────────────────────

/**
 * Default ICE server list used when no custom TURN servers are configured.
 * Public Google STUN servers work for direct peer connections; add TURN for
 * networks with symmetric NAT or strict firewalls.
 */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// ── Storage ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = "rv:netplay";

export interface NetplaySettings {
  enabled:    boolean;
  serverUrl:  string;
  iceServers: RTCIceServer[];
}

const DEFAULT_NETPLAY_SETTINGS: NetplaySettings = {
  enabled:    false,
  serverUrl:  "",
  iceServers: DEFAULT_ICE_SERVERS,
};

// ── Game ID hashing ───────────────────────────────────────────────────────────

/**
 * Compute a stable 31-bit positive integer from a string game ID.
 *
 * EmulatorJS requires `config.gameId` to be a `number` (not a string) before
 * it shows the Netplay button. We derive one deterministically so the same ROM
 * always maps to the same lobby — players launching the same game automatically
 * see each other's rooms without manual coordination.
 *
 * Uses djb2 (Daniel J. Bernstein hash 2) with a 32-bit wrap then masks to 31
 * bits to ensure a safe positive JavaScript integer.
 */
export function hashGameId(gameId: string): number {
  let hash = 5381;
  for (let i = 0; i < gameId.length; i++) {
    hash = ((hash << 5) + hash + gameId.charCodeAt(i)) >>> 0; // force uint32
  }
  // Mask to 31 bits so the result is always a safe positive integer.
  // EJS checks `typeof this.config.gameId !== "number"` to enable the Netplay
  // button; any truthy number works. We avoid 0 as a defensive measure since
  // some server implementations may treat it as "unset".
  return (hash & 0x7fff_ffff) || 1; // never return 0
}

// ── NetplayManager ────────────────────────────────────────────────────────────

export class NetplayManager {
  private _settings: NetplaySettings;

  constructor() {
    this._settings = this._load();
  }

  // ── Getters ────────────────────────────────────────────────────────────────

  get enabled(): boolean   { return this._settings.enabled; }
  get serverUrl(): string  { return this._settings.serverUrl; }
  get iceServers(): RTCIceServer[] { return [...this._settings.iceServers]; }

  /**
   * True if netplay is enabled *and* a server URL has been configured.
   * Only when both are true should the EJS netplay globals be set.
   */
  get isActive(): boolean {
    return this._settings.enabled && this._settings.serverUrl.trim().length > 0;
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  setEnabled(enabled: boolean): void {
    this._settings = { ...this._settings, enabled };
    this._save();
  }

  setServerUrl(url: string): void {
    this._settings = { ...this._settings, serverUrl: url.trim() };
    this._save();
  }

  setIceServers(servers: RTCIceServer[]): void {
    this._settings = { ...this._settings, iceServers: servers };
    this._save();
  }

  /** Reset ICE server list to the built-in public STUN defaults. */
  resetIceServers(): void {
    this.setIceServers(DEFAULT_ICE_SERVERS);
  }

  /**
   * Return a stable numeric game ID for the given string game identifier.
   * The returned value is suitable for `window.EJS_gameID`.
   */
  gameIdFor(gameId: string): number {
    return hashGameId(gameId);
  }

  /**
   * Validate a netplay server URL string.
   *
   * Returns `null` when the URL is valid (or empty, which means "not yet
   * configured").  Returns a human-readable error message when the URL is
   * present but malformed.
   *
   * Rules:
   *  - An empty / whitespace-only string is considered unset — returns `null`.
   *  - A non-empty string must begin with `ws://` or `wss://` (case-insensitive).
   *  - The remaining portion must be parseable by the `URL` constructor.
   */
  validateServerUrl(url: string): string | null {
    const trimmed = url.trim();
    if (trimmed.length === 0) return null;
    if (!/^wss?:\/\//i.test(trimmed)) {
      return "Server URL must start with ws:// or wss://";
    }
    try {
      new URL(trimmed);
    } catch {
      return "Server URL is not a valid URL";
    }
    return null;
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private _load(): NetplaySettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_NETPLAY_SETTINGS, iceServers: DEFAULT_ICE_SERVERS };
      const parsed = JSON.parse(raw) as Partial<NetplaySettings>;
      return {
        enabled:    typeof parsed.enabled === "boolean"
                      ? parsed.enabled
                      : DEFAULT_NETPLAY_SETTINGS.enabled,
        serverUrl:  typeof parsed.serverUrl === "string"
                      ? parsed.serverUrl
                      : DEFAULT_NETPLAY_SETTINGS.serverUrl,
        iceServers: Array.isArray(parsed.iceServers) && parsed.iceServers.length > 0
                      ? (parsed.iceServers as RTCIceServer[])
                      : DEFAULT_ICE_SERVERS,
      };
    } catch {
      return { ...DEFAULT_NETPLAY_SETTINGS, iceServers: DEFAULT_ICE_SERVERS };
    }
  }

  private _save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._settings));
    } catch {
      // localStorage write failures are non-fatal
    }
  }
}
