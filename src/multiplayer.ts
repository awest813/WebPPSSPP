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

/**
 * Systems with first-class netplay support in this app.
 *
 * Netplay remains globally configurable in settings, but launch integration is
 * intentionally gated per-system for deterministic behavior while support is
 * rolled out incrementally.
 */
export const NETPLAY_SUPPORTED_SYSTEM_IDS = ["n64", "psp"] as const;

// ── Storage ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = "rv:netplay";

export interface NetplaySettings {
  enabled:    boolean;
  serverUrl:  string;
  iceServers: RTCIceServer[];
  /** Display name shown to other players in a netplay room. Empty means anonymous. */
  username:   string;
}

export interface NetplayLobbyRoom {
  id:      string;
  gameId?: number;
  name?:   string;
  host?:   string;
  players?: number;
  maxPlayers?: number;
}

const DEFAULT_NETPLAY_SETTINGS: NetplaySettings = {
  enabled:    false,
  serverUrl:  "",
  iceServers: DEFAULT_ICE_SERVERS,
  username:   "",
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

// ── ICE server URL validation ─────────────────────────────────────────────────

/**
 * Validate a single ICE / STUN / TURN server URL string.
 *
 * Returns `null` when the URL is valid.  Returns a human-readable error
 * message when the URL is empty or does not start with a recognised scheme.
 *
 * Rules:
 *  - An empty / whitespace-only string is invalid — ICE URLs must be
 *    explicitly provided.
 *  - The URL must start with `stun:`, `turn:`, or `turns:` (case-insensitive).
 */
export function validateIceServerUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return "ICE server URL must not be empty";
  if (!/^(stun|turn|turns):/i.test(trimmed)) {
    return "URL must start with stun:, turn:, or turns:";
  }
  return null;
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
  /** Player display name shown to others in a netplay room. Empty string means anonymous. */
  get username(): string   { return this._settings.username; }

  /**
   * True if netplay is enabled *and* a server URL has been configured.
   * Only when both are true should the EJS netplay globals be set.
   */
  get isActive(): boolean {
    return this._settings.enabled && this._settings.serverUrl.trim().length > 0;
  }

  /**
   * True when netplay is active and the given system is currently supported.
   */
  isSupportedForSystem(systemId: string): boolean {
    return this.isActive && NETPLAY_SUPPORTED_SYSTEM_IDS.includes(systemId as typeof NETPLAY_SUPPORTED_SYSTEM_IDS[number]);
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
   * Set the player display name shown to others in a netplay room.
   * Trims surrounding whitespace before storing.  An empty string means
   * the player will appear as "anonymous" or use the server-assigned name.
   */
  setUsername(name: string): void {
    this._settings = { ...this._settings, username: name.trim() };
    this._save();
  }

  /**
   * Validate a proposed player username.
   *
   * Returns `null` when the name is valid.  Returns a human-readable error
   * message for names that are too long or contain only whitespace.
   *
   * Rules:
   *  - An empty / whitespace-only string is valid (represents anonymous).
   *  - Trimmed length must not exceed 32 characters.
   */
  validateUsername(name: string): string | null {
    const trimmed = name.trim();
    if (trimmed.length > 32) return "Display name must be 32 characters or fewer";
    return null;
  }

  /**
   * Return a stable numeric game ID for the given string game identifier.
   * The returned value is suitable for `window.EJS_gameID`.
   */
  gameIdFor(gameId: string): number {
    return hashGameId(gameId);
  }

  /**
   * Validate a single ICE / STUN / TURN server URL string.
   * Delegates to the module-level {@link validateIceServerUrl} function.
   */
  validateIceServerUrl(url: string): string | null {
    return validateIceServerUrl(url);
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

  /**
   * Fetch available netplay rooms for a lightweight lobby browser.
   *
   * Different netplay server implementations expose this data under different
   * routes, so we try a small list of common JSON endpoints and return the
   * first successful response.
   */
  async fetchLobbyRooms(signal?: AbortSignal): Promise<NetplayLobbyRoom[]> {
    const err = this.validateServerUrl(this._settings.serverUrl);
    if (err || !this.isActive) return [];

    const base = this._settings.serverUrl
      .replace(/^ws:\/\//i, "http://")
      .replace(/^wss:\/\//i, "https://")
      .replace(/\/+$/, "");

    const endpoints = ["/rooms", "/lobby/rooms", "/netplay/rooms"];

    for (const path of endpoints) {
      try {
        const res = await fetch(`${base}${path}`, {
          method: "GET",
          headers: { "Accept": "application/json" },
          signal,
        });
        if (!res.ok) continue;

        const body = await res.json() as unknown;
        const rooms = this._coerceLobbyRooms(body);
        if (rooms.length > 0) return rooms;
      } catch {
        // Keep trying alternative endpoints.
      }
    }
    return [];
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
        username:   typeof parsed.username === "string"
                      ? parsed.username
                      : DEFAULT_NETPLAY_SETTINGS.username,
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

  private _coerceLobbyRooms(body: unknown): NetplayLobbyRoom[] {
    const raw = Array.isArray(body)
      ? body
      : (body && typeof body === "object" && Array.isArray((body as { rooms?: unknown }).rooms)
        ? (body as { rooms: unknown[] }).rooms
        : []);

    const out: NetplayLobbyRoom[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;

      const id = typeof row.id === "string"
        ? row.id
        : (typeof row.roomId === "string" ? row.roomId : null);
      if (!id) continue;

      out.push({
        id,
        gameId: typeof row.gameId === "number" ? row.gameId : undefined,
        name: typeof row.name === "string" ? row.name : undefined,
        host: typeof row.host === "string" ? row.host : undefined,
        players: typeof row.players === "number" ? row.players : undefined,
        maxPlayers: typeof row.maxPlayers === "number" ? row.maxPlayers : undefined,
      });
    }
    return out;
  }
}
