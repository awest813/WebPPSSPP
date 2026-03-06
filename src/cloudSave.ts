/**
 * cloudSave.ts — Foundation for cloud save-state provider integration
 *
 * Defines the CloudSaveProvider interface that any cloud-storage backend
 * must implement, along with the CloudSaveSync orchestrator that bridges
 * local IndexedDB saves with remote cloud storage.
 *
 * Included providers
 * ------------------
 * - NullCloudProvider  : No-op provider used when cloud sync is not configured.
 * - WebDAVProvider     : User-provided WebDAV server (URL / username / password).
 *
 * Manager
 * -------
 * - CloudSaveManager   : High-level orchestrator; persists settings in localStorage,
 *                        maintains connection state and exposes a simple API for the UI.
 *
 * Adding a new cloud provider
 * ---------------------------
 * 1. Implement the CloudSaveProvider interface.
 * 2. Instantiate CloudSaveSync with your provider.
 * 3. Call sync.push() after each local save and sync.pull() on launch.
 */

import { MAX_SAVE_SLOTS, AUTO_SAVE_SLOT, type SaveStateEntry } from "./saves.js";

// ── Manifest ──────────────────────────────────────────────────────────────────

/**
 * Lightweight descriptor of a cloud-hosted save state.
 * Transferred without the heavy Blob payloads so callers can compare
 * timestamps and checksums before deciding whether to download.
 */
export interface CloudSaveManifest {
  gameId: string;
  slot: number;
  timestamp: number;
  /** djb2 hex checksum matching the format used by computeChecksum() in saves.ts */
  checksum: string;
  label: string;
  gameName: string;
  systemId: string;
  /** Save format version (mirrors SaveStateEntry.version). */
  version: number;
}

// ── Provider interface ────────────────────────────────────────────────────────

/**
 * Contract that every cloud storage backend must satisfy.
 *
 * Implementations should be stateless (no internal caches) and surface
 * all errors as rejected Promises so callers can decide how to handle them.
 */
export interface CloudSaveProvider {
  /** Unique machine-readable identifier for this provider (e.g. "gdrive", "s3"). */
  readonly providerId: string;
  /** Human-readable display name shown in UI (e.g. "Google Drive"). */
  readonly displayName: string;

  /** Returns true when the user is authenticated and the remote storage is reachable. */
  isAvailable(): Promise<boolean>;

  /** Upload a complete save state entry to remote storage, overwriting any existing entry. */
  upload(entry: SaveStateEntry): Promise<void>;

  /**
   * Download the full save state entry for the given game + slot.
   * Returns null when no cloud save exists for that slot.
   */
  download(gameId: string, slot: number): Promise<SaveStateEntry | null>;

  /** List lightweight manifests for all cloud saves belonging to a game. */
  listManifests(gameId: string): Promise<CloudSaveManifest[]>;

  /** Delete the cloud save for the given game + slot. Does not throw if absent. */
  delete(gameId: string, slot: number): Promise<void>;
}

// ── Conflict resolution ───────────────────────────────────────────────────────

/**
 * Strategy applied when both a local and a remote save exist for the same slot.
 *
 * - "local"   — always keep the local copy and overwrite the cloud.
 * - "remote"  — always keep the cloud copy and overwrite local.
 * - "newest"  — keep whichever entry has the later timestamp (default).
 */
export type ConflictResolution = "local" | "remote" | "newest";

/** Describes a conflict between a local and a remote save for the same slot. */
export interface SyncConflict {
  local: SaveStateEntry;
  remote: SaveStateEntry;
  gameId: string;
  slot: number;
}

// ── CloudSaveSync ─────────────────────────────────────────────────────────────

/**
 * Orchestrates synchronisation between a local SaveStateLibrary and a remote
 * CloudSaveProvider.  Intentionally provider-agnostic — swap the provider
 * without changing any calling code.
 *
 * @example
 * ```ts
 * const sync = new CloudSaveSync(myGoogleDriveProvider, "newest");
 * // After a local save:
 * await sync.push(entry);
 * // On game launch (to restore the latest cloud state):
 * const remote = await sync.pull(gameId, slot);
 * if (remote) library.saveState(remote);
 * ```
 */
export class CloudSaveSync {
  constructor(
    private readonly provider: CloudSaveProvider,
    private readonly conflictResolution: ConflictResolution = "newest",
  ) {}

  /** The provider identifier forwarded from the underlying CloudSaveProvider. */
  get providerId(): string {
    return this.provider.providerId;
  }

  /** Checks whether the underlying provider is currently available. */
  async isAvailable(): Promise<boolean> {
    return this.provider.isAvailable();
  }

  /**
   * Push a local save state to the cloud provider.
   * Silently no-ops when the provider is not available.
   */
  async push(entry: SaveStateEntry): Promise<void> {
    if (!(await this.provider.isAvailable())) return;
    await this.provider.upload(entry);
  }

  /**
   * Pull the cloud save for a given game + slot.
   * Returns null when the provider is unavailable or no cloud save exists.
   */
  async pull(gameId: string, slot: number): Promise<SaveStateEntry | null> {
    if (!(await this.provider.isAvailable())) return null;
    return this.provider.download(gameId, slot);
  }

  /**
   * Resolve a conflict between a local and a remote save according to the
   * configured ConflictResolution strategy.
   * Returns the SaveStateEntry that should be considered the winner.
   */
  resolveConflict(conflict: SyncConflict): SaveStateEntry {
    switch (this.conflictResolution) {
      case "local":
        return conflict.local;
      case "remote":
        return conflict.remote;
      case "newest":
      default:
        return conflict.remote.timestamp >= conflict.local.timestamp
          ? conflict.remote
          : conflict.local;
    }
  }

  /**
   * Synchronise a single slot against the cloud.
   *
   * | Local | Remote | Result                                          |
   * |-------|--------|-------------------------------------------------|
   * | none  | none   | Returns null (nothing to do).                   |
   * | yes   | none   | Pushes local → cloud. direction = "pushed".     |
   * | none  | yes    | Returns remote entry. direction = "pulled".      |
   * | yes   | yes    | Resolves conflict; pushes if local wins.         |
   *
   * @param localEntry  The local save state, or null if no local save exists.
   * @param gameId      Game identifier.
   * @param slot        Save slot number.
   * @returns           The winning entry and sync direction, or null when the
   *                    provider is unavailable.
   */
  async syncSlot(
    localEntry: SaveStateEntry | null,
    gameId: string,
    slot: number,
  ): Promise<{ entry: SaveStateEntry; direction: "pushed" | "pulled" | "none" } | null> {
    if (!(await this.provider.isAvailable())) return null;

    const remoteEntry = await this.provider.download(gameId, slot);

    if (!localEntry && !remoteEntry) return null;

    if (!localEntry && remoteEntry) {
      return { entry: remoteEntry, direction: "pulled" };
    }

    if (localEntry && !remoteEntry) {
      await this.provider.upload(localEntry);
      return { entry: localEntry, direction: "pushed" };
    }

    // Both sides have a save — apply conflict resolution.
    const winner = this.resolveConflict({
      local: localEntry!,
      remote: remoteEntry!,
      gameId,
      slot,
    });

    if (winner === localEntry) {
      await this.provider.upload(localEntry!);
      return { entry: localEntry!, direction: "pushed" };
    }

    return { entry: remoteEntry!, direction: "pulled" };
  }

  /**
   * List manifests for all cloud saves belonging to a game.
   * Returns an empty array when the provider is unavailable.
   */
  async listManifests(gameId: string): Promise<CloudSaveManifest[]> {
    if (!(await this.provider.isAvailable())) return [];
    return this.provider.listManifests(gameId);
  }
}

// ── NullCloudProvider ─────────────────────────────────────────────────────────

/**
 * No-op CloudSaveProvider used when cloud sync is not configured or when the
 * user has not authenticated.
 *
 * - isAvailable() always returns false so CloudSaveSync skips all operations.
 * - All other methods are safe to call and succeed silently.
 */
export class NullCloudProvider implements CloudSaveProvider {
  readonly providerId   = "null";
  readonly displayName  = "None (cloud sync disabled)";

  async isAvailable(): Promise<boolean>                                   { return false; }
  async upload(_entry: SaveStateEntry): Promise<void>                     { /* no-op */ }
  async download(_gameId: string, _slot: number): Promise<SaveStateEntry | null> { return null; }
  async listManifests(_gameId: string): Promise<CloudSaveManifest[]>      { return []; }
  async delete(_gameId: string, _slot: number): Promise<void>             { /* no-op */ }
}

// ── WebDAVProvider ────────────────────────────────────────────────────────────

/** Timeout (ms) for the isAvailable() connectivity check. */
const AVAILABILITY_CHECK_TIMEOUT_MS = 8_000;
/** Timeout (ms) for all other WebDAV fetch operations (upload, download, etc.). */
const WEBDAV_OPERATION_TIMEOUT_MS   = 15_000;

/**
 * CloudSaveProvider backed by a user-supplied WebDAV endpoint.
 *
 * Folder structure stored on the server:
 * ```
 * {baseUrl}/
 *   {gameId}/
 *     {slot}/
 *       manifest.json  — CloudSaveManifest (JSON)
 *       state.bin      — raw emulator state bytes
 *       thumb.jpg      — JPEG thumbnail (optional)
 * ```
 *
 * Authentication uses HTTP Basic auth (Authorization header).  The server
 * must allow CORS requests from the app origin.
 */
export class WebDAVProvider implements CloudSaveProvider {
  readonly providerId  = "webdav";
  readonly displayName = "WebDAV";

  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(baseUrl: string, username: string, password: string) {
    this.baseUrl    = baseUrl.replace(/\/+$/, "");
    // Encode credentials as UTF-8 bytes then base64 — avoids the deprecated unescape() trick.
    // Build the binary string iteratively to avoid spreading large arrays into
    // String.fromCharCode(), which hits JS engine argument-count limits (~65k args).
    const credentials = `${username}:${password}`;
    const utf8Bytes   = new TextEncoder().encode(credentials);
    let binary = "";
    for (let i = 0; i < utf8Bytes.length; i++) {
      binary += String.fromCharCode(utf8Bytes[i]!);
    }
    this.authHeader   = "Basic " + btoa(binary);
  }

  // ── CloudSaveProvider implementation ───────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AVAILABILITY_CHECK_TIMEOUT_MS);
    try {
      const r = await fetch(this.baseUrl + "/", {
        method: "OPTIONS",
        headers: this._headers(),
        signal: controller.signal,
      });
      // Any HTTP response (even 4xx) means the server is reachable.
      return r.status < 500;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async upload(entry: SaveStateEntry): Promise<void> {
    const base = this._slotUrl(entry.gameId, entry.slot);

    // Ensure parent directories exist (ignores failures — PUT will surface errors)
    await this._ensureDir(`${this.baseUrl}/${entry.gameId}`);
    await this._ensureDir(base);

    const manifest: CloudSaveManifest = {
      gameId:    entry.gameId,
      slot:      entry.slot,
      timestamp: entry.timestamp,
      checksum:  entry.checksum ?? "",
      label:     entry.label,
      gameName:  entry.gameName,
      systemId:  entry.systemId,
      version:   entry.version ?? 1,
    };
    await this._put(`${base}/manifest.json`, JSON.stringify(manifest), "application/json");

    if (entry.stateData) {
      await this._putBlob(`${base}/state.bin`, entry.stateData, "application/octet-stream");
    }
    if (entry.thumbnail) {
      await this._putBlob(`${base}/thumb.jpg`, entry.thumbnail, "image/jpeg");
    }
  }

  async download(gameId: string, slot: number): Promise<SaveStateEntry | null> {
    const base = this._slotUrl(gameId, slot);

    const manifestRes = await this._timedFetch(`${base}/manifest.json`, { headers: this._headers() });
    if (!manifestRes.ok) return null;

    let manifest: CloudSaveManifest;
    try {
      manifest = await manifestRes.json() as CloudSaveManifest;
    } catch {
      // Non-JSON response (e.g. HTML error page with 200 status) — treat as no save.
      return null;
    }

    let stateData: Blob | null = null;
    const stateRes = await this._timedFetch(`${base}/state.bin`, { headers: this._headers() });
    if (stateRes.ok) stateData = await stateRes.blob();

    let thumbnail: Blob | null = null;
    const thumbRes = await this._timedFetch(`${base}/thumb.jpg`, { headers: this._headers() });
    if (thumbRes.ok) thumbnail = await thumbRes.blob();

    return {
      id:         `${gameId}:${slot}`,
      gameId,
      gameName:   manifest.gameName,
      systemId:   manifest.systemId,
      slot:       manifest.slot,
      label:      manifest.label,
      timestamp:  manifest.timestamp,
      thumbnail,
      stateData,
      isAutoSave: slot === AUTO_SAVE_SLOT,
      version:    manifest.version,
      checksum:   manifest.checksum,
    };
  }

  async listManifests(gameId: string): Promise<CloudSaveManifest[]> {
    const slots = [AUTO_SAVE_SLOT, ...Array.from({ length: MAX_SAVE_SLOTS }, (_, i) => i + 1)];
    const results = await Promise.allSettled(slots.map(slot => this._fetchManifest(gameId, slot)));
    return results
      .filter((r): r is PromiseFulfilledResult<CloudSaveManifest | null> => r.status === "fulfilled")
      .map(r => r.value)
      .filter((m): m is CloudSaveManifest => m !== null);
  }

  async delete(gameId: string, slot: number): Promise<void> {
    const base = this._slotUrl(gameId, slot);
    await Promise.allSettled([
      this._deleteFile(`${base}/manifest.json`),
      this._deleteFile(`${base}/state.bin`),
      this._deleteFile(`${base}/thumb.jpg`),
    ]);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _headers(): HeadersInit {
    return { Authorization: this.authHeader };
  }

  private _slotUrl(gameId: string, slot: number): string {
    return `${this.baseUrl}/${encodeURIComponent(gameId)}/${slot}`;
  }

  /**
   * Wrapper around fetch() that aborts after `timeoutMs` milliseconds.
   * Prevents slow or unresponsive WebDAV servers from hanging sync operations.
   */
  private async _timedFetch(url: string, init: RequestInit, timeoutMs = WEBDAV_OPERATION_TIMEOUT_MS): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async _fetchManifest(gameId: string, slot: number): Promise<CloudSaveManifest | null> {
    const res = await this._timedFetch(`${this._slotUrl(gameId, slot)}/manifest.json`, { headers: this._headers() });
    if (!res.ok) return null;
    try {
      return await res.json() as CloudSaveManifest;
    } catch {
      return null;
    }
  }

  private async _ensureDir(url: string): Promise<void> {
    try {
      await this._timedFetch(url, { method: "MKCOL", headers: this._headers() });
    } catch {
      // MKCOL is best-effort: ignore network/CORS errors; PUT will fail loudly if needed.
    }
  }

  private async _put(url: string, body: string, contentType: string): Promise<void> {
    const r = await this._timedFetch(url, {
      method:  "PUT",
      headers: { ...this._headers(), "Content-Type": contentType },
      body,
    });
    if (!r.ok) throw new Error(`WebDAV PUT failed (${r.status}): ${url}`);
  }

  private async _putBlob(url: string, blob: Blob, contentType: string): Promise<void> {
    const r = await this._timedFetch(url, {
      method:  "PUT",
      headers: { ...this._headers(), "Content-Type": contentType },
      body:    blob,
    });
    if (!r.ok) throw new Error(`WebDAV PUT failed (${r.status}): ${url}`);
  }

  private async _deleteFile(url: string): Promise<void> {
    await this._timedFetch(url, { method: "DELETE", headers: this._headers() });
  }
}

// ── CloudSaveManager ──────────────────────────────────────────────────────────

/** Settings persisted in localStorage under "retrovault-cloud". */
export interface CloudSaveSettings {
  providerId:         "null" | "webdav";
  autoSyncEnabled:    boolean;
  conflictResolution: ConflictResolution;
}

/** Summary returned by syncGame(). */
export interface GameSyncResult {
  pushed: number;
  pulled: number;
  errors: number;
}

/**
 * High-level cloud save orchestrator.
 *
 * Wraps a CloudSaveProvider + CloudSaveSync pair, tracks connection state,
 * persists minimal settings to localStorage, and exposes a clean API for the
 * UI layer to consume.
 *
 * @example
 * ```ts
 * const manager = new CloudSaveManager();
 * const provider = new WebDAVProvider("https://dav.example.com/saves", "user", "pass");
 * await manager.connect(provider);          // throws if not reachable
 * await manager.push(entry);               // auto-no-ops when disconnected
 * const { pushed, pulled } = await manager.syncGame("game-uuid", saveLibrary);
 * manager.disconnect();
 * ```
 */
export class CloudSaveManager {
  private _provider: CloudSaveProvider = new NullCloudProvider();
  private _sync:     CloudSaveSync;
  private _connected    = false;
  private _lastSyncAt:  number | null = null;
  private _lastError:   string | null = null;

  /** Persisted settings */
  providerId:         "null" | "webdav" = "null";
  autoSyncEnabled:    boolean           = false;
  conflictResolution: ConflictResolution = "newest";

  /** Called whenever connection status or lastSyncAt / lastError change. */
  onStatusChange?: () => void;

  private static readonly SETTINGS_KEY = "retrovault-cloud";
  private static readonly WEBDAV_KEY   = "retrovault-cloud-webdav";

  constructor() {
    this._sync = new CloudSaveSync(this._provider, this.conflictResolution);
    this._loadSettings();
  }

  // ── Read-only state ─────────────────────────────────────────────────────────

  /** True when a provider is connected and reachable. */
  isConnected(): boolean { return this._connected; }

  /** Unix timestamp (ms) of the last successful sync, or null. */
  get lastSyncAt():  number | null { return this._lastSyncAt; }

  /** Human-readable message from the last error, or null. */
  get lastError():   string | null { return this._lastError; }

  /** The active provider (NullCloudProvider when disconnected). */
  get activeProvider(): CloudSaveProvider { return this._provider; }

  // ── Connection management ───────────────────────────────────────────────────

  /**
   * Connect to the given provider.
   * Throws with a user-facing message when the provider is not reachable.
   */
  async connect(provider: CloudSaveProvider): Promise<void> {
    const ok = await provider.isAvailable();
    if (!ok) throw new Error(`${provider.displayName} is not reachable. Check the URL and credentials.`);

    this._provider      = provider;
    this._sync          = new CloudSaveSync(provider, this.conflictResolution);
    this._connected     = true;
    this.providerId     = provider.providerId as "null" | "webdav";
    this._lastError     = null;
    this._saveSettings();
    this.onStatusChange?.();
  }

  /** Disconnect from the current provider (does not erase WebDAV credentials). */
  disconnect(): void {
    this._connected   = false;
    this.providerId   = "null";
    this._provider    = new NullCloudProvider();
    this._sync        = new CloudSaveSync(this._provider, this.conflictResolution);
    this._lastError   = null;
    this._saveSettings();
    this.onStatusChange?.();
  }

  // ── Sync operations ─────────────────────────────────────────────────────────

  /**
   * Push a single save state entry to the cloud.
   * Silently no-ops when disconnected.
   */
  async push(entry: SaveStateEntry): Promise<void> {
    try {
      await this._sync.push(entry);
      this._lastSyncAt = Date.now();
      this._lastError  = null;
      this.onStatusChange?.();
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      this.onStatusChange?.();
      throw err;
    }
  }

  /**
   * Pull the cloud save for a given game + slot.
   * Returns null when disconnected or no cloud save exists.
   */
  async pull(gameId: string, slot: number): Promise<SaveStateEntry | null> {
    try {
      const result     = await this._sync.pull(gameId, slot);
      this._lastSyncAt = Date.now();
      this._lastError  = null;
      this.onStatusChange?.();
      return result;
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      this.onStatusChange?.();
      throw err;
    }
  }

  /**
   * Synchronise a single save slot (local ↔ cloud) using the configured
   * conflict-resolution strategy.
   *
   * @param gameId      Game identifier.
   * @param slot        Save slot number.
   * @param localEntry  The local save state, or null if absent.
   */
  async syncSlot(
    gameId:     string,
    slot:       number,
    localEntry: SaveStateEntry | null,
  ): Promise<{ entry: SaveStateEntry; direction: "pushed" | "pulled" | "none" } | null> {
    try {
      const result = await this._sync.syncSlot(localEntry, gameId, slot);
      if (result) {
        this._lastSyncAt = Date.now();
        this._lastError  = null;
        this.onStatusChange?.();
      }
      return result;
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      this.onStatusChange?.();
      throw err;
    }
  }

  /**
   * Synchronise all save slots for a game against the cloud.
   *
   * @param gameId      Game identifier.
   * @param saveLibrary Object exposing `getStatesForGame(gameId)`.
   */
  async syncGame(
    gameId: string,
    saveLibrary: { getStatesForGame(id: string): Promise<SaveStateEntry[]> },
  ): Promise<GameSyncResult> {
    const states   = await saveLibrary.getStatesForGame(gameId);
    const stateMap = new Map(states.map(s => [s.slot, s]));
    const slots    = [AUTO_SAVE_SLOT, ...Array.from({ length: MAX_SAVE_SLOTS }, (_, i) => i + 1)];

    let pushed = 0, pulled = 0, errors = 0;
    await Promise.allSettled(slots.map(async slot => {
      try {
        const result = await this.syncSlot(gameId, slot, stateMap.get(slot) ?? null);
        if (result?.direction === "pushed") pushed++;
        if (result?.direction === "pulled") pulled++;
      } catch { errors++; }
    }));

    return { pushed, pulled, errors };
  }

  // ── WebDAV credential storage ───────────────────────────────────────────────

  /** Persist WebDAV connection parameters (stored in a separate localStorage key). */
  saveWebDAVConfig(url: string, username: string, password: string): void {
    try {
      localStorage.setItem(
        CloudSaveManager.WEBDAV_KEY,
        JSON.stringify({ url, username, password }),
      );
    } catch { /* quota exceeded or private-browsing restriction */ }
  }

  /** Load previously saved WebDAV parameters, or null if none exist. */
  loadWebDAVConfig(): { url: string; username: string; password: string } | null {
    try {
      const raw = localStorage.getItem(CloudSaveManager.WEBDAV_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as { url: string; username: string; password: string };
    } catch { return null; }
  }

  /** Remove persisted WebDAV credentials from localStorage. */
  clearWebDAVConfig(): void {
    try { localStorage.removeItem(CloudSaveManager.WEBDAV_KEY); } catch { /* ignore */ }
  }

  // ── Settings persistence ────────────────────────────────────────────────────

  private _loadSettings(): void {
    try {
      const raw = localStorage.getItem(CloudSaveManager.SETTINGS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as Partial<CloudSaveSettings>;
      // providerId is stored as the literal string "null" (not JSON null) when
      // no provider is configured, matching the CloudSaveSettings type definition.
      if (p.providerId === "null" || p.providerId === "webdav") {
        this.providerId = p.providerId;
      }
      if (p.autoSyncEnabled === true) this.autoSyncEnabled = true;
      if (p.conflictResolution === "local" || p.conflictResolution === "remote" || p.conflictResolution === "newest") {
        this.conflictResolution = p.conflictResolution;
      }
    } catch { /* ignore */ }
  }

  private _saveSettings(): void {
    try {
      const s: CloudSaveSettings = {
        providerId:         this.providerId,
        autoSyncEnabled:    this.autoSyncEnabled,
        conflictResolution: this.conflictResolution,
      };
      localStorage.setItem(CloudSaveManager.SETTINGS_KEY, JSON.stringify(s));
    } catch { /* ignore */ }
  }

  /** Update autoSyncEnabled and persist to localStorage. */
  setAutoSync(enabled: boolean): void {
    this.autoSyncEnabled = enabled;
    this._saveSettings();
    this.onStatusChange?.();
  }

  /** Update conflictResolution and persist to localStorage. */
  setConflictResolution(strategy: ConflictResolution): void {
    this.conflictResolution = strategy;
    this._sync = new CloudSaveSync(this._provider, strategy);
    this._saveSettings();
  }
}
