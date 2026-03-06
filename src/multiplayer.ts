import compatibilityAliases from "./compatibility_aliases.json";

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
export const NETPLAY_SUPPORTED_SYSTEM_IDS = ["n64", "psp", "nds", "gba", "gbc"] as const;

export const SYSTEM_LINK_CAPABILITIES: Record<string, boolean> = {
  nes: false,
  snes: false,
  n64: true,
  psp: true,
  gbc: true,
  gba: true,
  nds: true,
};

export const ROOM_KEY_DISPLAY_NAMES: Record<string, string> = {
  pokemon_gen1: "Pokémon Gen1 Trading Room",
  pokemon_gen2: "Pokémon Gen2 Trading Room",
  pokemon_gen3_kanto: "Pokémon Gen3 Kanto Trading Room",
  pokemon_gen3_hoenn: "Pokémon Gen3 Hoenn Trading Room",
  pokemon_gen4_sinnoh: "Pokémon Gen4 Sinnoh Trading Room",
  pokemon_gen5_unova: "Pokémon Gen5 Unova Trading Room",
};

/**
 * Netplay room-key aliases used to group known cross-version compatible games.
 *
 * Pokémon titles are the primary use-case: trading/battling is often designed
 * to work between paired versions, but our default room scoping hashes each ROM
 * ID independently.  These aliases collapse compatible titles onto a shared key
 * so players on different versions can discover the same rooms.
 */
type RoomAliasRule = { match: RegExp; roomKey: string };

const NETPLAY_ALIAS_CONFIDENCE_THRESHOLD = 0.7;

const NETPLAY_ROOM_COMPAT_ALIASES: Record<string, RoomAliasRule[]> = Object.entries(
  compatibilityAliases as Record<string, string[]>
).reduce<Record<string, RoomAliasRule[]>>((acc, [roomKey, patterns]) => {
  const inferredSystem = roomKey.includes("gen1") || roomKey.includes("gen2")
    ? "gbc"
    : roomKey.includes("gen3")
      ? "gba"
      : "nds";
  acc[inferredSystem] ??= [];
  for (const pattern of patterns) {
    acc[inferredSystem].push({ match: new RegExp(pattern, "i"), roomKey });
  }
  return acc;
}, {});

const REGION_TAG_REGEX = /\s*[\[(](?:usa|us|u|europe|eu|e|japan|jp|j|world|korea|france|germany|spain|italy|australia|canada|brazil|china|asia|global|intl|international|eng|en(?:[,-]\s*[a-z]{2,})*)[\])]/gi;
const REVISION_TAG_REGEX = /\s*[\[(](?:rev(?:ision)?\s*[0-9a-z]+|v\s*\d+(?:\.\d+)*)[\])]/gi;

export function stripRegionSuffix(gameId: string): string {
  return gameId.replace(REGION_TAG_REGEX, " ").trim();
}

export function stripRevisionSuffix(gameId: string): string {
  return gameId.replace(REVISION_TAG_REGEX, " ").trim();
}

export function canonicalizeGameId(gameId: string): string {
  const noRegion = stripRegionSuffix(gameId);
  const noRevision = stripRevisionSuffix(noRegion);
  return noRevision
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\.(?:gba|gbc|gb|nds|nes|sfc|smc|n64|z64|v64|psp|iso|bin|rom)$/i, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function aliasConfidence(canonicalGameId: string): number {
  if (/^pokemon(?:_|$)|^pocket_monsters(?:_|$)/.test(canonicalGameId)) return 1;
  return 0.25;
}

function resolveNetplayRoom(gameId: string, systemId?: string): { roomKey: string; confidence: number } {
  const canonicalGameId = canonicalizeGameId(gameId);
  const normalizedSystem = systemId?.toLowerCase();
  if (!normalizedSystem) return { roomKey: canonicalGameId || gameId, confidence: 0 };

  const aliases = NETPLAY_ROOM_COMPAT_ALIASES[normalizedSystem];
  if (!aliases || aliases.length === 0) return { roomKey: canonicalGameId || gameId, confidence: 0 };

  for (const alias of aliases) {
    if (alias.match.test(canonicalGameId)) {
      const confidence = aliasConfidence(canonicalGameId);
      if (confidence >= NETPLAY_ALIAS_CONFIDENCE_THRESHOLD) {
        return { roomKey: alias.roomKey, confidence };
      }
      return { roomKey: canonicalGameId || gameId, confidence };
    }
  }
  return { roomKey: canonicalGameId || gameId, confidence: 0 };
}

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
  hasPassword?: boolean;
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

/**
 * Resolve a canonical room-key for netplay game scoping.
 *
 * By default this returns `gameId` unchanged.  For known cross-version title
 * families (for now: Pokémon on GBC/GBA/NDS), it returns a compatibility alias
 * so those versions hash into one shared lobby namespace.
 */
export function resolveNetplayRoomKey(gameId: string, systemId?: string): string {
  const resolved = resolveNetplayRoom(gameId, systemId);
  console.info(`[Netplay] Resolving room key\nGame: ${gameId}\nSystem: ${systemId ?? "unknown"}\nResolved Key: ${resolved.roomKey}`);
  return resolved.roomKey;
}

export function roomDisplayNameForKey(roomKey: string): string {
  return ROOM_KEY_DISPLAY_NAMES[roomKey] ?? roomKey;
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
    const normalizedSystemId = systemId.toLowerCase();
    return this.isActive
      && NETPLAY_SUPPORTED_SYSTEM_IDS.includes(normalizedSystemId as typeof NETPLAY_SUPPORTED_SYSTEM_IDS[number])
      && SYSTEM_LINK_CAPABILITIES[normalizedSystemId] === true;
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
  gameIdFor(gameId: string, systemId?: string): number {
    const resolved = resolveNetplayRoom(gameId, systemId);
    const hashKey = resolved.confidence >= NETPLAY_ALIAS_CONFIDENCE_THRESHOLD
      ? resolved.roomKey
      : canonicalizeGameId(gameId);
    return hashGameId(hashKey || gameId);
  }

  roomKeyFor(gameId: string, systemId?: string): string {
    return resolveNetplayRoomKey(gameId, systemId);
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

    const endpointCandidates: Array<{ path: string; includeLegacyQuery?: boolean }> = [
      { path: "/rooms" },
      { path: "/lobby/rooms" },
      { path: "/netplay/rooms" },
      { path: "/list", includeLegacyQuery: true },
    ];

    for (const candidate of endpointCandidates) {
      try {
        const url = new URL(`${base}${candidate.path}`);
        if (candidate.includeLegacyQuery) {
          url.searchParams.set("domain", window.location.host);
        }

        const res = await fetch(url.toString(), {
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
    const wrapped = body && typeof body === "object" ? (body as { rooms?: unknown }).rooms : undefined;
    const raw = Array.isArray(body)
      ? body
      : (Array.isArray(wrapped)
        ? wrapped
        : (body && typeof body === "object"
          ? this._mapLegacyRoomDictionary(body as Record<string, unknown>)
          : []));

    const out: NetplayLobbyRoom[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;

      const id = typeof row.id === "string"
        ? row.id
        : (typeof row.roomId === "string"
          ? row.roomId
          : (typeof row.room_id === "string" ? row.room_id : null));
      if (!id) continue;

      const gameId = this._readOptionalNumber(row, ["gameId", "game_id"]);
      const players = this._readOptionalNumber(row, ["players", "current", "player_count"]);
      const maxPlayers = this._readOptionalNumber(row, ["maxPlayers", "max", "max_players"]);

      out.push({
        id,
        gameId,
        name: this._readOptionalString(row, ["name", "room_name"]),
        host: typeof row.host === "string" ? row.host : undefined,
        players,
        maxPlayers,
        hasPassword: typeof row.hasPassword === "boolean"
          ? row.hasPassword
          : (typeof row.has_password === "boolean"
            ? row.has_password
            : undefined),
      });
    }
    return out;
  }

  private _mapLegacyRoomDictionary(body: Record<string, unknown>): unknown[] {
    const rows: unknown[] = [];
    for (const [id, value] of Object.entries(body)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      rows.push({ id, ...(value as Record<string, unknown>) });
    }
    return rows;
  }

  private _readOptionalNumber(row: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = row[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return undefined;
  }

  private _readOptionalString(row: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = row[key];
      if (typeof value === "string") return value;
    }
    return undefined;
  }
}
