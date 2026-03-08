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
export const NETPLAY_SUPPORTED_SYSTEM_IDS = ["n64", "psp", "nds", "gba", "gbc", "gb"] as const;

export const SYSTEM_LINK_CAPABILITIES: Record<string, boolean> = {
  nes: false,
  snes: false,
  n64: true,
  psp: true,
  gb: true,
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
  // Original Game Boy (gb) shares compatibility aliases with GBC: GB cartridges
  // run on GBC hardware and Pokémon Gen 1 link-cable trading works across both.
  if (inferredSystem === "gbc") {
    acc["gb"] ??= [];
    for (const pattern of patterns) {
      acc["gb"].push({ match: new RegExp(pattern, "i"), roomKey });
    }
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

/**
 * Normalize a ROM title for display and alias grouping.
 *
 * Strips region tags (USA, Japan, Europe…), revision tags (Rev 1, v1.1…),
 * dump annotations, file extensions, and diacritics.  Returns a lowercase
 * space-separated string suitable for use in alias generation pipelines and
 * the debug CLI.
 *
 * Example:
 *   `normalizeRomTitle("Pokemon - FireRed Version (USA) (Rev 1)")` → `"pokemon firered version"`
 */
export function normalizeRomTitle(title: string): string {
  const noRegion = stripRegionSuffix(title);
  const noRevision = stripRevisionSuffix(noRegion);
  return noRevision
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\.(?:gba|gbc|gb|nds|nes|sfc|smc|n64|z64|v64|psp|iso|bin|rom)$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function aliasConfidence(canonicalGameId: string): number {
  if (/^pokemon(?:_|$)|^pocket_monsters(?:_|$)/.test(canonicalGameId)) return 1;
  return 0.25;
}

// ── Resolution cache ──────────────────────────────────────────────────────────

/**
 * Module-level cache keyed on `"<gameId>\0<systemId>"`.
 *
 * Each entry stores the result of a full alias-resolution pass so that repeated
 * calls with the same (gameId, systemId) pair avoid redundant regex evaluation
 * and string normalization.  This reduces average resolution time from O(n)
 * regex evaluations to O(1) map lookup after the first call.
 *
 * The cache is intentionally unbounded: alias tables are small and game ID
 * strings are short, so memory pressure is negligible in practice.
 *
 * Cache key format: `"<gameId>\0<systemId>"`.  The null-byte separator is used
 * because it cannot appear in a valid game title or system ID string, so there
 * is no risk of two different (gameId, systemId) pairs colliding on the same
 * key.
 */
const _resolutionCache = new Map<string, { roomKey: string; confidence: number }>();

/**
 * Clear the compatibility-resolution cache.
 *
 * Intended for use in tests that need to verify resolution from a cold start,
 * and for callers that update alias rules at runtime.
 */
export function clearNetplayResolutionCache(): void {
  _resolutionCache.clear();
}

function resolveNetplayRoom(gameId: string, systemId?: string): { roomKey: string; confidence: number } {
  const cacheKey = `${gameId}\0${systemId ?? ""}`;
  const cached = _resolutionCache.get(cacheKey);
  if (cached) return cached;

  const canonicalGameId = canonicalizeGameId(gameId);
  const normalizedSystem = systemId?.toLowerCase();
  if (!normalizedSystem) {
    const result = { roomKey: canonicalGameId || gameId, confidence: 0 };
    _resolutionCache.set(cacheKey, result);
    return result;
  }

  const aliases = NETPLAY_ROOM_COMPAT_ALIASES[normalizedSystem];
  if (!aliases || aliases.length === 0) {
    const result = { roomKey: canonicalGameId || gameId, confidence: 0 };
    _resolutionCache.set(cacheKey, result);
    return result;
  }

  for (const alias of aliases) {
    if (alias.match.test(canonicalGameId)) {
      const confidence = aliasConfidence(canonicalGameId);
      const result = confidence >= NETPLAY_ALIAS_CONFIDENCE_THRESHOLD
        ? { roomKey: alias.roomKey, confidence }
        : { roomKey: canonicalGameId || gameId, confidence };
      _resolutionCache.set(cacheKey, result);
      return result;
    }
  }
  const result = { roomKey: canonicalGameId || gameId, confidence: 0 };
  _resolutionCache.set(cacheKey, result);
  return result;
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
  id:          string;
  gameId?:     number;
  name?:       string;
  host?:       string;
  players?:    number;
  maxPlayers?: number;
  hasPassword?: boolean;
  /** System identifier (e.g. "gba", "nds") reported by the server. */
  systemId?:   string;
  /** Round-trip latency in milliseconds as measured or reported by the server. */
  latencyMs?:  number;
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
  return resolved.roomKey;
}

export function roomDisplayNameForKey(roomKey: string): string {
  return ROOM_KEY_DISPLAY_NAMES[roomKey] ?? roomKey;
}

// ── Alias table integrity ─────────────────────────────────────────────────────

/**
 * Validate the compiled alias table for integrity issues.
 *
 * Checks for:
 *  - Duplicate `roomKey` values within the same system bucket (same canonical
 *    key registered twice under different patterns).
 *  - Overlapping regex patterns — two rules that both match the same synthetic
 *    canonical ID derived from the room key itself, which would cause
 *    non-deterministic resolution depending on insertion order.
 *
 * Returns an array of human-readable violation strings.  An empty array means
 * the table is clean.
 */
export function validateAliasTable(): string[] {
  const violations: string[] = [];

  for (const [systemId, rules] of Object.entries(NETPLAY_ROOM_COMPAT_ALIASES)) {
    const seenRoomKeys = new Map<string, number>();

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];

      // Detect duplicate roomKey registrations within the same system bucket.
      const prev = seenRoomKeys.get(rule.roomKey);
      if (prev !== undefined) {
        violations.push(
          `[${systemId}] Duplicate roomKey "${rule.roomKey}" at rule indices ${prev} and ${i}`
        );
      } else {
        seenRoomKeys.set(rule.roomKey, i);
      }

      // Detect overlapping patterns: if two rules both match the same
      // test ID (the roomKey itself), later rules would never fire and the
      // ordering becomes load-order-dependent.
      const testId = rule.roomKey;
      for (let j = i + 1; j < rules.length; j++) {
        if (rules[j].match.test(testId)) {
          violations.push(
            `[${systemId}] Overlapping patterns: rule ${i} (roomKey "${rule.roomKey}") and rule ${j} (roomKey "${rules[j].roomKey}") both match test ID "${testId}"`
          );
        }
        if (rule.match.test(rules[j].roomKey)) {
          violations.push(
            `[${systemId}] Overlapping patterns: rule ${i} (roomKey "${rule.roomKey}") matches test ID "${rules[j].roomKey}" of rule ${j}`
          );
        }
      }
    }
  }

  return violations;
}

// ── Compatibility error handling ──────────────────────────────────────────────

/**
 * Known netplay compatibility / connection failure codes.
 *
 * These are returned by the UI layer when a netplay attempt fails so the
 * error message renderer can show a clear, localised string to the user
 * instead of a raw technical error or a silent failure.
 */
export const NetplayCompatibilityErrorCode = {
  IncompatibleRom:   "incompatible_rom",
  UnsupportedSystem: "unsupported_system",
  NetworkTimeout:    "network_timeout",
  RoomFull:          "room_full",
  RoomNotFound:      "room_not_found",
  ServerUnavailable: "server_unavailable",
} as const;

export type NetplayCompatibilityErrorCode =
  typeof NetplayCompatibilityErrorCode[keyof typeof NetplayCompatibilityErrorCode];

const _ERROR_MESSAGES: Record<string, string> = {
  [NetplayCompatibilityErrorCode.IncompatibleRom]:
    "This game version is not compatible with the host.",
  [NetplayCompatibilityErrorCode.UnsupportedSystem]:
    "This system does not support netplay.",
  [NetplayCompatibilityErrorCode.NetworkTimeout]:
    "Connection timed out. Please check your network and try again.",
  [NetplayCompatibilityErrorCode.RoomFull]:
    "This room is full. Please try another room or create a new one.",
  [NetplayCompatibilityErrorCode.RoomNotFound]:
    "Room not found. It may have been closed by the host.",
  [NetplayCompatibilityErrorCode.ServerUnavailable]:
    "Netplay server is unavailable. Please try again later.",
};

/**
 * Return a human-readable error message for the given compatibility error code.
 *
 * Falls back to a generic message for unknown codes so callers never receive
 * an empty string.
 */
export function netplayErrorMessage(code: string): string {
  return _ERROR_MESSAGES[code] ?? "An unknown netplay error occurred.";
}

// ── Session metrics ───────────────────────────────────────────────────────────

/**
 * A snapshot of netplay session performance metrics.
 *
 * Produced by {@link NetplayMetricsCollector.snapshot} and suitable for
 * display in a debug overlay or for logging at the end of a session.
 */
export interface NetplaySessionMetrics {
  /** Mean round-trip latency across all recorded samples, in milliseconds. */
  averageLatencyMs:  number;
  /** Highest recorded round-trip latency, in milliseconds. */
  worstLatencyMs:    number;
  /** Fraction of packets lost (0–1).  0 means no loss, 1 means total loss. */
  packetLoss:        number;
  /** Mean frame delay across all recorded samples, in emulator frames. */
  averageFrameDelay: number;
  /** Total number of state re-synchronisation events recorded. */
  resyncCount:       number;
  /** Wall-clock duration of the session so far, in milliseconds. */
  sessionDurationMs: number;
}

/**
 * Collects and aggregates netplay session performance metrics.
 *
 * Callers feed raw measurements via {@link recordLatency}, {@link recordFrameDelay},
 * {@link recordPacket}, and {@link recordResync}.  At any point a
 * {@link snapshot} can be taken that returns the current aggregated
 * {@link NetplaySessionMetrics}.
 *
 * All aggregations (running sum, worst-case) are maintained incrementally so
 * that {@link snapshot} is O(1) regardless of how many samples have been
 * recorded.
 *
 * Example:
 * ```ts
 * const metrics = new NetplayMetricsCollector();
 * metrics.recordLatency(42);
 * metrics.recordPacket();
 * const report = metrics.snapshot();
 * console.log(report.averageLatencyMs); // 42
 * ```
 */
export class NetplayMetricsCollector {
  private _latencySum      = 0;
  private _latencyCount    = 0;
  private _worstLatency    = 0;
  private _frameDelaySum   = 0;
  private _frameDelayCount = 0;
  private _packetsSent     = 0;
  private _packetsLost     = 0;
  private _resyncCount     = 0;
  private _startTime:      number;

  constructor() {
    this._startTime = Date.now();
  }

  /** Record a round-trip latency measurement in milliseconds. */
  recordLatency(ms: number): void {
    this._latencySum += ms;
    this._latencyCount++;
    if (ms > this._worstLatency) this._worstLatency = ms;
  }

  /** Record a frame-delay measurement in emulator frames. */
  recordFrameDelay(frames: number): void {
    this._frameDelaySum += frames;
    this._frameDelayCount++;
  }

  /**
   * Record that a packet was sent.
   * Pass `lost = true` when the packet is confirmed dropped.
   */
  recordPacket(lost = false): void {
    this._packetsSent++;
    if (lost) this._packetsLost++;
  }

  /** Record a state re-synchronisation event. */
  recordResync(): void {
    this._resyncCount++;
  }

  /** Reset all accumulated metrics and restart the session clock. */
  reset(): void {
    this._latencySum       = 0;
    this._latencyCount     = 0;
    this._worstLatency     = 0;
    this._frameDelaySum    = 0;
    this._frameDelayCount  = 0;
    this._packetsSent      = 0;
    this._packetsLost      = 0;
    this._resyncCount      = 0;
    this._startTime        = Date.now();
  }

  /** Return a point-in-time snapshot of the current session metrics. */
  snapshot(): NetplaySessionMetrics {
    return {
      averageLatencyMs:  this._latencyCount > 0
                           ? this._latencySum / this._latencyCount
                           : 0,
      worstLatencyMs:    this._worstLatency,
      packetLoss:        this._packetsSent > 0
                           ? this._packetsLost / this._packetsSent
                           : 0,
      averageFrameDelay: this._frameDelayCount > 0
                           ? this._frameDelaySum / this._frameDelayCount
                           : 0,
      resyncCount:       this._resyncCount,
      sessionDurationMs: Date.now() - this._startTime,
    };
  }
}

// ── ICE server URL validation ─────────────────────────────────────────────────

/**
 * Validate a single ICE / STUN / TURN server URL string.
 *
 * Returns `null` when the URL is valid.  Returns a human-readable error
 * message when the URL is empty, has an unrecognised scheme, or has no
 * hostname after the scheme separator.
 *
 * Rules:
 *  - An empty / whitespace-only string is invalid — ICE URLs must be
 *    explicitly provided.
 *  - The URL must start with `stun:`, `turn:`, or `turns:` (case-insensitive).
 *  - There must be a non-empty hostname immediately after the colon (e.g.
 *    `stun:` alone is rejected — WebRTC ignores servers without a host).
 */
export function validateIceServerUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return "ICE server URL must not be empty";
  if (!/^(stun|turn|turns):/i.test(trimmed)) {
    return "URL must start with stun:, turn:, or turns:";
  }
  // Verify there is a non-empty hostname after the scheme colon.
  const colonIdx = trimmed.indexOf(":");
  const afterColon = trimmed.slice(colonIdx + 1).replace(/^\/\//, "").trim();
  if (afterColon.length === 0) {
    return "ICE server URL must include a hostname (e.g. stun:stun.example.com:3478)";
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
   *
   * Once an endpoint responds with HTTP 200 we stop probing — even if the
   * room list is empty — to avoid returning stale or mismatched data from a
   * fallback endpoint that happens to have different rooms.  Non-2xx responses
   * (e.g. 404) are treated as "this endpoint doesn't exist" and we continue
   * to the next candidate.
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

        // HTTP 200: this endpoint is active. Parse rooms and return immediately
        // regardless of room count — the server authoritatively said there are
        // none, so there's no point querying an alternative endpoint.
        const body = await res.json() as unknown;
        return this._coerceLobbyRooms(body);
      } catch {
        // Network error or non-JSON body — keep trying alternative endpoints.
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
        systemId:  this._readOptionalString(row, ["systemId", "system_id", "system"]),
        latencyMs: this._readOptionalNumber(row, ["latencyMs", "latency_ms", "latency", "ping"]),
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
