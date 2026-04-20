/**
 * cloudSave.ts — Foundation for cloud save-state provider integration
 *
 * Defines the CloudSaveProvider interface that any cloud-storage backend
 * must implement, along with the CloudSaveSync orchestrator that bridges
 * local IndexedDB saves with remote cloud storage.
 *
 * Included providers
 * ------------------
 * - NullCloudProvider   : No-op provider used when cloud sync is not configured.
 * - WebDAVProvider      : User-provided WebDAV server (URL / username / password).
 * - GoogleDriveProvider : Google Drive REST API v3 (OAuth access token).
 * - DropboxProvider     : Dropbox API v2 (OAuth access token).
 * - pCloudProvider      : pCloud REST API (OAuth access token, US or EU region).
 * - BlompProvider       : Blomp cloud storage (OpenStack Swift Auth v1, username / password).
 * - BoxProvider         : Box API v2 (OAuth access token).
 * - OneDriveProvider    : Microsoft OneDrive via Graph API v1.0 (OAuth access token).
 * - MegaProvider        : MEGA cloud storage (email / password, end-to-end encrypted).
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

// ── Sync badges ───────────────────────────────────────────────────────────────

/** Per-slot sync status badge for at-a-glance trust. */
export type SyncBadge = "local-only" | "syncing" | "synced" | "error";

// ── Sync history ──────────────────────────────────────────────────────────────

/** A single entry in the lightweight sync history log. */
export interface SyncHistoryEntry {
  timestamp: number;
  action: string;
  ok: boolean;
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
  ): Promise<{ entry: SaveStateEntry; direction: "pushed" | "pulled" } | null> {
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

    // Upload binary payloads first so the manifest only becomes visible on the
    // server after all data is in place. This prevents a partial-upload window
    // where the manifest references a state.bin that doesn't exist yet.
    if (entry.stateData) {
      await this._putBlob(`${base}/state.bin`, entry.stateData, "application/octet-stream");
    }
    if (entry.thumbnail) {
      await this._putBlob(`${base}/thumb.jpg`, entry.thumbnail, "image/jpeg");
    }

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
    let thumbnail: Blob | null = null;
    const [stateRes, thumbRes] = await Promise.all([
      this._timedFetch(`${base}/state.bin`, { headers: this._headers() }),
      this._timedFetch(`${base}/thumb.jpg`, { headers: this._headers() }),
    ]);
    if (stateRes.ok) stateData = await stateRes.blob();
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
    const r = await this._timedFetch(url, { method: "DELETE", headers: this._headers() });
    if (!r.ok) throw new Error(`WebDAV DELETE failed (${r.status}): ${url}`);
  }
}

// ── GoogleDriveProvider ───────────────────────────────────────────────────────

/** Timeout (ms) for Google Drive availability check. */
const GDRIVE_AVAILABILITY_TIMEOUT_MS = 8_000;
/** Timeout (ms) for all other Google Drive operations. */
const GDRIVE_OPERATION_TIMEOUT_MS    = 15_000;

/**
 * CloudSaveProvider backed by Google Drive REST API v3.
 *
 * Files are stored in the hidden `appDataFolder` space so they do not appear
 * in the user's regular Drive view.  The access token must be obtained via
 * OAuth 2.0 (implicit or PKCE flow) before constructing this provider.
 *
 * File naming convention (flat within appDataFolder):
 * ```
 * rv__{gameId}__{slot}__manifest.json
 * rv__{gameId}__{slot}__state.bin
 * rv__{gameId}__{slot}__thumb.jpg
 * ```
 *
 * Required OAuth scope: https://www.googleapis.com/auth/drive.appdata
 */
export class GoogleDriveProvider implements CloudSaveProvider {
  readonly providerId  = "gdrive";
  readonly displayName = "Google Drive";

  private static readonly API_BASE    = "https://www.googleapis.com/drive/v3";
  private static readonly UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
  private static readonly SPACE       = "appDataFolder";

  constructor(private readonly accessToken: string) {}

  // ── CloudSaveProvider implementation ───────────────────────────────────────

  private _headers(): HeadersInit {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  async isAvailable(): Promise<boolean> {
    const ctl   = new AbortController();
    const timer = setTimeout(() => ctl.abort(), GDRIVE_AVAILABILITY_TIMEOUT_MS);
    try {
      const r = await fetch(`${GoogleDriveProvider.API_BASE}/about?fields=user`, {
        headers: this._headers(),
        signal:  ctl.signal,
      });
      return r.status === 200;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async upload(entry: SaveStateEntry): Promise<void> {
    // Upload state.bin and thumb.jpg in parallel first, then the manifest last.
    // The manifest is written last so it only becomes visible after all data is
    // in place — this prevents a partial-upload window where the manifest
    // references a state.bin that hasn't finished uploading yet.
    const parallelUploads: Promise<void>[] = [];
    if (entry.stateData) {
      parallelUploads.push(this._upsertFile(
        this._fileName(entry.gameId, entry.slot, "state.bin"),
        entry.stateData,
        "application/octet-stream",
      ));
    }
    if (entry.thumbnail) {
      parallelUploads.push(this._upsertFile(
        this._fileName(entry.gameId, entry.slot, "thumb.jpg"),
        entry.thumbnail,
        "image/jpeg",
      ));
    }
    // Wait for all data files before writing the manifest.
    await Promise.all(parallelUploads);

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
    await this._upsertFile(
      this._fileName(entry.gameId, entry.slot, "manifest.json"),
      new Blob([JSON.stringify(manifest)], { type: "application/json" }),
      "application/json",
    );
  }

  async download(gameId: string, slot: number): Promise<SaveStateEntry | null> {
    const manifestId = await this._findFileId(this._fileName(gameId, slot, "manifest.json"));
    if (!manifestId) return null;

    let manifest: CloudSaveManifest;
    try {
      const r = await this._timedFetch(
        `${GoogleDriveProvider.API_BASE}/files/${manifestId}?alt=media`,
        { headers: this._headers() },
      );
      if (!r.ok) return null;
      manifest = await r.json() as CloudSaveManifest;
    } catch {
      return null;
    }

    // Look up state.bin and thumb.jpg file IDs in parallel, then download them
    // simultaneously.  This replaces four sequential round-trips with two.
    const [stateId, thumbId] = await Promise.all([
      this._findFileId(this._fileName(gameId, slot, "state.bin")),
      this._findFileId(this._fileName(gameId, slot, "thumb.jpg")),
    ]);

    const [stateData, thumbnail] = await Promise.all([
      stateId
        ? this._timedFetch(`${GoogleDriveProvider.API_BASE}/files/${stateId}?alt=media`, { headers: this._headers() })
            .then(r => (r.ok ? r.blob() : null))
            .catch(() => null)
        : Promise.resolve(null),
      thumbId
        ? this._timedFetch(`${GoogleDriveProvider.API_BASE}/files/${thumbId}?alt=media`, { headers: this._headers() })
            .then(r => (r.ok ? r.blob() : null))
            .catch(() => null)
        : Promise.resolve(null),
    ]);

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
    // Use a single prefix-based search to fetch all manifest file IDs for this
    // game in one request, then download each manifest in parallel.
    // This reduces the number of API calls from 2 * (MAX_SAVE_SLOTS + 1) to
    // 1 (search) + N (downloads), where N ≤ MAX_SAVE_SLOTS + 1.
    const manifestIds = await this._findManifestFileIds(gameId);

    const results = await Promise.allSettled(
      Object.entries(manifestIds).map(async ([, fileId]) => {
        const r = await this._timedFetch(
          `${GoogleDriveProvider.API_BASE}/files/${fileId}?alt=media`,
          { headers: this._headers() },
        );
        if (!r.ok) return null;
        try { return await r.json() as CloudSaveManifest; } catch { return null; }
      }),
    );
    return results
      .filter((r): r is PromiseFulfilledResult<CloudSaveManifest | null> => r.status === "fulfilled")
      .map(r => r.value)
      .filter((m): m is CloudSaveManifest => m !== null);
  }

  async delete(gameId: string, slot: number): Promise<void> {
    const suffixes = ["manifest.json", "state.bin", "thumb.jpg"];
    await Promise.allSettled(
      suffixes.map(async suffix => {
        const id = await this._findFileId(this._fileName(gameId, slot, suffix));
        if (!id) return;
        await this._timedFetch(
          `${GoogleDriveProvider.API_BASE}/files/${id}`,
          { method: "DELETE", headers: this._headers() },
        );
      }),
    );
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** Flat file name stored in appDataFolder. */
  private _fileName(gameId: string, slot: number, suffix: string): string {
    // Double-underscore separator is unlikely to appear in typical game IDs.
    return `rv__${gameId}__${slot}__${suffix}`;
  }

  /**
   * Find a file in appDataFolder by exact name.
   * Returns the Drive file ID, or null if not found.
   */
  private async _findFileId(name: string): Promise<string | null> {
    // Escape backslashes first, then single quotes, to prevent breaking the
    // Drive Files.list query syntax (both are special characters in the API).
    const safeName = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q = encodeURIComponent(`name='${safeName}' and trashed=false`);
    try {
      const r = await this._timedFetch(
        `${GoogleDriveProvider.API_BASE}/files?spaces=${GoogleDriveProvider.SPACE}&q=${q}&fields=files(id)`,
        { headers: this._headers() },
      );
      if (!r.ok) return null;
      const data = await r.json() as { files?: { id: string }[] };
      return data.files?.[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Search appDataFolder for all manifest files belonging to a game using a
   * single API request.  Returns a map of filename → Drive file ID so that
   * the caller can batch-download the manifests without further search calls.
   */
  private async _findManifestFileIds(gameId: string): Promise<Record<string, string>> {
    // Build a prefix that all manifest files for this game share.
    // We search for files whose name contains the prefix; exact-name matching
    // for each slot would require MAX_SAVE_SLOTS + 1 separate requests.
    const safeGameId = gameId.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const prefix     = `rv__${safeGameId}__`;
    const suffix     = `__manifest.json`;
    // Drive's `contains` operator is a substring match, so we filter client-side
    // with startsWith(prefix) — to exclude any file whose name merely contains
    // the prefix in the middle (e.g. an external backup tool) — and endsWith(suffix)
    // to keep only manifest files rather than state or thumbnail files.
    const q = encodeURIComponent(`name contains '${prefix}' and trashed=false`);
    try {
      const r = await this._timedFetch(
        `${GoogleDriveProvider.API_BASE}/files?spaces=${GoogleDriveProvider.SPACE}&q=${q}&fields=files(id,name)`,
        { headers: this._headers() },
      );
      if (!r.ok) return {};
      const data = await r.json() as { files?: { id: string; name: string }[] };
      const out: Record<string, string> = {};
      for (const f of data.files ?? []) {
        if (f.name.startsWith(prefix) && f.name.endsWith(suffix)) {
          out[f.name] = f.id;
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * Create or update (upsert) a file in appDataFolder.
   * If a file with the given name already exists, its content is replaced;
   * otherwise a new file is created via a multipart upload.
   */
  private async _upsertFile(name: string, content: Blob, contentType: string): Promise<void> {
    const existingId = await this._findFileId(name);

    if (existingId) {
      // Update existing file content via media-only PATCH.
      const r = await this._timedFetch(
        `${GoogleDriveProvider.UPLOAD_BASE}/files/${existingId}?uploadType=media`,
        {
          method:  "PATCH",
          headers: { ...this._headers(), "Content-Type": contentType },
          body:    content,
        },
      );
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) {
          throw new Error(`Google Drive authentication failed (${r.status}) — your token may have expired. Please reconnect.`);
        }
        throw new Error(`Google Drive update failed (${r.status}): ${name}`);
      }
    } else {
      // Create new file via multipart upload (metadata + media in one request).
      const metadata = JSON.stringify({ name, parents: [GoogleDriveProvider.SPACE] });
      const boundary = `rv_boundary_${Math.random().toString(36).slice(2)}`;
      const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
        metadata,
        `\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
        content,
        `\r\n--${boundary}--`,
      ]);
      const r = await this._timedFetch(
        `${GoogleDriveProvider.UPLOAD_BASE}/files?uploadType=multipart`,
        {
          method:  "POST",
          headers: { ...this._headers(), "Content-Type": `multipart/related; boundary=${boundary}` },
          body,
        },
      );
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) {
          throw new Error(`Google Drive authentication failed (${r.status}) — your token may have expired. Please reconnect.`);
        }
        throw new Error(`Google Drive upload failed (${r.status}): ${name}`);
      }
    }
  }

  private async _timedFetch(url: string, init: RequestInit): Promise<Response> {
    const ctl   = new AbortController();
    const timer = setTimeout(() => ctl.abort(), GDRIVE_OPERATION_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── DropboxProvider ───────────────────────────────────────────────────────────

/** Timeout (ms) for Dropbox availability check. */
const DROPBOX_AVAILABILITY_TIMEOUT_MS = 8_000;
/** Timeout (ms) for all other Dropbox operations. */
const DROPBOX_OPERATION_TIMEOUT_MS    = 15_000;

/**
 * CloudSaveProvider backed by the Dropbox API v2.
 *
 * Files are stored in the app's Dropbox folder under:
 * ```
 * /retrovault/{gameId}/{slot}/manifest.json
 * /retrovault/{gameId}/{slot}/state.bin
 * /retrovault/{gameId}/{slot}/thumb.jpg
 * ```
 *
 * The access token is obtained via OAuth 2.0 and passed directly to the
 * constructor.
 *
 * Required OAuth scopes: files.content.read, files.content.write
 */
export class DropboxProvider implements CloudSaveProvider {
  readonly providerId  = "dropbox";
  readonly displayName = "Dropbox";

  private static readonly CONTENT_API = "https://content.dropboxapi.com/2";
  private static readonly API_BASE    = "https://api.dropboxapi.com/2";
  private static readonly ROOT_FOLDER = "/retrovault";

  constructor(private readonly accessToken: string) {}

  // ── CloudSaveProvider implementation ───────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    const ctl   = new AbortController();
    const timer = setTimeout(() => ctl.abort(), DROPBOX_AVAILABILITY_TIMEOUT_MS);
    try {
      const r = await fetch(`${DropboxProvider.API_BASE}/users/get_current_account`, {
        method:  "POST",
        headers: { ...this._headers(), "Content-Type": "application/json" },
        body:    "null",
        signal:  ctl.signal,
      });
      return r.status === 200;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async upload(entry: SaveStateEntry): Promise<void> {
    const base = this._slotPath(entry.gameId, entry.slot);

    // Upload binary payloads before the manifest (same atomicity logic as
    // WebDAVProvider — manifest last so it signals a complete upload).
    if (entry.stateData) {
      await this._uploadFile(`${base}/state.bin`, entry.stateData);
    }
    if (entry.thumbnail) {
      await this._uploadFile(`${base}/thumb.jpg`, entry.thumbnail);
    }

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
    await this._uploadFile(
      `${base}/manifest.json`,
      new Blob([JSON.stringify(manifest)], { type: "application/json" }),
    );
  }

  async download(gameId: string, slot: number): Promise<SaveStateEntry | null> {
    const base = this._slotPath(gameId, slot);

    const manifestBlob = await this._downloadFile(`${base}/manifest.json`);
    if (!manifestBlob) return null;

    let manifest: CloudSaveManifest;
    try {
      manifest = JSON.parse(await manifestBlob.text()) as CloudSaveManifest;
    } catch {
      return null;
    }

    const [stateData, thumbnail] = await Promise.all([
      this._downloadFile(`${base}/state.bin`),
      this._downloadFile(`${base}/thumb.jpg`),
    ]);

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
    const results = await Promise.allSettled(
      slots.map(async slot => {
        const blob = await this._downloadFile(`${this._slotPath(gameId, slot)}/manifest.json`);
        if (!blob) return null;
        try {
          return JSON.parse(await blob.text()) as CloudSaveManifest;
        } catch {
          return null;
        }
      }),
    );
    return results
      .filter((r): r is PromiseFulfilledResult<CloudSaveManifest | null> => r.status === "fulfilled")
      .map(r => r.value)
      .filter((m): m is CloudSaveManifest => m !== null);
  }

  async delete(gameId: string, slot: number): Promise<void> {
    const base = this._slotPath(gameId, slot);
    await Promise.allSettled([
      this._deleteFile(`${base}/manifest.json`),
      this._deleteFile(`${base}/state.bin`),
      this._deleteFile(`${base}/thumb.jpg`),
    ]);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _headers(): HeadersInit {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  /** Dropbox path for a specific game + slot folder. */
  private _slotPath(gameId: string, slot: number): string {
    // Sanitise gameId for use as a Dropbox path component.  Dropbox path names
    // are case-insensitive and must not contain control characters; replacing
    // everything outside the safe alphanumeric/punctuation set avoids issues.
    const safeId = Array.from(new TextEncoder().encode(gameId))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
    return `${DropboxProvider.ROOT_FOLDER}/${safeId}/${slot}`;
  }

  private async _uploadFile(path: string, content: Blob): Promise<void> {
    // The Dropbox /files/upload endpoint requires Content-Type to be
    // application/octet-stream regardless of the actual content MIME type.
    const r = await this._timedFetch(`${DropboxProvider.CONTENT_API}/files/upload`, {
      method:  "POST",
      headers: {
        ...this._headers(),
        "Content-Type":    "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({ path, mode: "overwrite", autorename: false, mute: true }),
      },
      body: content,
    });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) {
        throw new Error(`Dropbox authentication failed (${r.status}) — your token may have expired. Please reconnect.`);
      }
      throw new Error(`Dropbox upload failed (${r.status}): ${path}`);
    }
  }

  private async _downloadFile(path: string): Promise<Blob | null> {
    try {
      const r = await this._timedFetch(`${DropboxProvider.CONTENT_API}/files/download`, {
        method:  "POST",
        headers: {
          ...this._headers(),
          "Dropbox-API-Arg": JSON.stringify({ path }),
        },
      });
      if (r.status === 401 || r.status === 403) {
        throw new Error(`Dropbox authentication failed (${r.status}) — your token may have expired. Please reconnect.`);
      }
      if (!r.ok) return null;
      return r.blob();
    } catch (err) {
      // Re-throw auth errors; swallow other errors (e.g. file not found).
      if (err instanceof Error && err.message.includes("authentication failed")) throw err;
      return null;
    }
  }

  private async _deleteFile(path: string): Promise<void> {
    const r = await this._timedFetch(`${DropboxProvider.API_BASE}/files/delete_v2`, {
      method:  "POST",
      headers: { ...this._headers(), "Content-Type": "application/json" },
      body:    JSON.stringify({ path }),
    });
    if (!r.ok) throw new Error(`Dropbox delete failed (${r.status}): ${path}`);
  }

  private async _timedFetch(url: string, init: RequestInit): Promise<Response> {
    const ctl   = new AbortController();
    const timer = setTimeout(() => ctl.abort(), DROPBOX_OPERATION_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── pCloudProvider ────────────────────────────────────────────────────────────

/** Timeout (ms) for pCloud availability check. */
const PCLOUD_AVAILABILITY_TIMEOUT_MS = 8_000;
/** Timeout (ms) for all other pCloud operations. */
const PCLOUD_OPERATION_TIMEOUT_MS    = 15_000;

/**
 * CloudSaveProvider backed by the pCloud REST API.
 *
 * Files are stored in a pCloud folder under:
 * ```
 * /RetroVault/{gameId}/{slot}/manifest.json
 * /RetroVault/{gameId}/{slot}/state.bin
 * /RetroVault/{gameId}/{slot}/thumb.jpg
 * ```
 *
 * The access token is obtained via OAuth 2.0 and passed directly to the
 * constructor.  pCloud has two API regions (US / EU); the correct one must
 * match the account's home location — mismatches will return an auth error.
 */
export class pCloudProvider implements CloudSaveProvider {
  readonly providerId  = "pcloud";
  readonly displayName = "pCloud";

  private static readonly US_API      = "https://api.pcloud.com";
  private static readonly EU_API      = "https://eapi.pcloud.com";
  private static readonly ROOT_FOLDER = "/RetroVault";

  // pCloud API result codes
  private static readonly ERR_LOGIN_REQUIRED = 2000; // Log in required
  private static readonly ERR_INVALID_TOKEN  = 2094; // Access token is not valid
  private static readonly ERR_FILE_NOT_FOUND = 2009; // File not found
  private static readonly ERR_DIR_NOT_FOUND  = 2010; // Directory not found

  private readonly apiBase: string;

  constructor(
    private readonly accessToken: string,
    region: "us" | "eu" = "us",
  ) {
    this.apiBase = region === "eu" ? pCloudProvider.EU_API : pCloudProvider.US_API;
  }

  // ── CloudSaveProvider implementation ───────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    const ctl   = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PCLOUD_AVAILABILITY_TIMEOUT_MS);
    try {
      const r = await fetch(`${this.apiBase}/userinfo`, {
        headers: this._headers(),
        signal:  ctl.signal,
      });
      if (!r.ok) return false;
      const data = await r.json() as { result: number };
      return data.result === 0;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async upload(entry: SaveStateEntry): Promise<void> {
    const folderPath = this._slotPath(entry.gameId, entry.slot);
    await this._ensureFolder(folderPath);

    // Upload state and thumbnail in parallel before writing the manifest.
    // The manifest is written last so it only becomes visible after all data
    // is in place — matching the atomicity approach used by other providers.
    const parallelUploads: Promise<void>[] = [];
    if (entry.stateData) {
      parallelUploads.push(this._uploadFile(folderPath, "state.bin", entry.stateData));
    }
    if (entry.thumbnail) {
      parallelUploads.push(this._uploadFile(folderPath, "thumb.jpg", entry.thumbnail));
    }
    await Promise.all(parallelUploads);

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
    await this._uploadFile(
      folderPath, "manifest.json",
      new Blob([JSON.stringify(manifest)], { type: "application/json" }),
    );
  }

  async download(gameId: string, slot: number): Promise<SaveStateEntry | null> {
    const base = this._slotPath(gameId, slot);

    const manifestBlob = await this._downloadFile(`${base}/manifest.json`);
    if (!manifestBlob) return null;

    let manifest: CloudSaveManifest;
    try {
      manifest = JSON.parse(await manifestBlob.text()) as CloudSaveManifest;
    } catch {
      return null;
    }

    const [stateData, thumbnail] = await Promise.all([
      this._downloadFile(`${base}/state.bin`),
      this._downloadFile(`${base}/thumb.jpg`),
    ]);

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
    const results = await Promise.allSettled(
      slots.map(async slot => {
        const blob = await this._downloadFile(`${this._slotPath(gameId, slot)}/manifest.json`);
        if (!blob) return null;
        try {
          return JSON.parse(await blob.text()) as CloudSaveManifest;
        } catch {
          return null;
        }
      }),
    );
    return results
      .filter((r): r is PromiseFulfilledResult<CloudSaveManifest | null> => r.status === "fulfilled")
      .map(r => r.value)
      .filter((m): m is CloudSaveManifest => m !== null);
  }

  async delete(gameId: string, slot: number): Promise<void> {
    const base = this._slotPath(gameId, slot);
    await Promise.allSettled([
      this._deleteFile(`${base}/manifest.json`),
      this._deleteFile(`${base}/state.bin`),
      this._deleteFile(`${base}/thumb.jpg`),
    ]);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _headers(): HeadersInit {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  /** pCloud path for a specific game + slot folder. */
  private _slotPath(gameId: string, slot: number): string {
    const safeId = Array.from(new TextEncoder().encode(gameId))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
    return `${pCloudProvider.ROOT_FOLDER}/${safeId}/${slot}`;
  }

  /** Create a folder (and all parents) if it does not already exist. */
  private async _ensureFolder(path: string): Promise<void> {
    try {
      const url = new URL(`${this.apiBase}/createfolderifnotexists`);
      url.searchParams.set("path", path);
      await this._timedFetch(url.toString(), {
        method:  "GET",
        headers: this._headers(),
      });
    } catch { /* non-fatal — upload will surface the real error if needed */ }
  }

  private async _uploadFile(folderPath: string, filename: string, content: Blob): Promise<void> {
    const url = new URL(`${this.apiBase}/uploadfile`);
    url.searchParams.set("path", folderPath);
    url.searchParams.set("filename", filename);
    url.searchParams.set("nopartial", "1");

    const r = await this._timedFetch(url.toString(), {
      method:  "POST",
      headers: { ...this._headers(), "Content-Type": "application/octet-stream" },
      body:    content,
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({ result: -1 })) as { result?: number };
      if (r.status === 401 || r.status === 403 ||
          data.result === pCloudProvider.ERR_LOGIN_REQUIRED ||
          data.result === pCloudProvider.ERR_INVALID_TOKEN) {
        throw new Error(`pCloud authentication failed — your token may have expired. Please reconnect.`);
      }
      throw new Error(`pCloud upload failed (${r.status}): ${folderPath}/${filename}`);
    }
  }

  private async _downloadFile(path: string): Promise<Blob | null> {
    try {
      // Step 1: Obtain a short-lived download link from the pCloud API.
      const linkUrl = new URL(`${this.apiBase}/getfilelink`);
      linkUrl.searchParams.set("path", path);
      const linkR = await this._timedFetch(linkUrl.toString(), {
        method:  "GET",
        headers: this._headers(),
      });
      if (!linkR.ok) return null;
      const linkData = await linkR.json() as { result: number; hosts?: string[]; path?: string };
      // result ERR_FILE_NOT_FOUND/ERR_DIR_NOT_FOUND = file not found — not an error in this context.
      if (linkData.result === pCloudProvider.ERR_FILE_NOT_FOUND ||
          linkData.result === pCloudProvider.ERR_DIR_NOT_FOUND) return null;
      if (linkData.result === pCloudProvider.ERR_LOGIN_REQUIRED ||
          linkData.result === pCloudProvider.ERR_INVALID_TOKEN) {
        throw new Error(`pCloud authentication failed — your token may have expired. Please reconnect.`);
      }
      if (linkData.result !== 0 || !linkData.hosts?.length || !linkData.path) return null;

      // Step 2: Download the file content from the CDN link.
      const downloadUrl = `https://${linkData.hosts[0]}${linkData.path}`;
      const fileR = await this._timedFetch(downloadUrl, { method: "GET" });
      if (!fileR.ok) return null;
      return fileR.blob();
    } catch (err) {
      if (err instanceof Error && err.message.includes("authentication failed")) throw err;
      return null;
    }
  }

  private async _deleteFile(path: string): Promise<void> {
    const url = new URL(`${this.apiBase}/deletefile`);
    url.searchParams.set("path", path);
    const r = await this._timedFetch(url.toString(), {
      method:  "GET",
      headers: this._headers(),
    });
    if (!r.ok) throw new Error(`pCloud delete failed (${r.status}): ${path}`);
  }

  private async _timedFetch(url: string, init: RequestInit): Promise<Response> {
    const ctl   = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PCLOUD_OPERATION_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── BlompProvider ─────────────────────────────────────────────────────────────

/** Timeout (ms) for Blomp authentication (Swift Auth v1). */
const BLOMP_AUTH_TIMEOUT_MS      = 8_000;
/** Timeout (ms) for all other Blomp object-storage operations. */
const BLOMP_OPERATION_TIMEOUT_MS = 15_000;

/**
 * CloudSaveProvider backed by Blomp cloud storage (OpenStack Swift).
 *
 * Authentication uses OpenStack Swift Auth v1:
 *   GET https://authenticate.blomp.com/v1/auth
 *   Headers: X-Auth-User: {username}, X-Auth-Key: {password}
 *   Response headers: X-Auth-Token, X-Storage-Url
 *
 * Files are stored in the specified Swift container under:
 * ```
 * {container}/
 *   RetroVault/{hex(gameId)}/{slot}/manifest.json
 *   RetroVault/{hex(gameId)}/{slot}/state.bin
 *   RetroVault/{hex(gameId)}/{slot}/thumb.jpg
 * ```
 *
 * The auth token is cached after the first successful authentication.
 * On 401 responses the token is cleared so the next operation will
 * re-authenticate via isAvailable().
 */
export class BlompProvider implements CloudSaveProvider {
  readonly providerId  = "blomp";
  readonly displayName = "Blomp";

  private static readonly AUTH_URL    = "https://authenticate.blomp.com/v1/auth";
  private static readonly ROOT_PREFIX = "RetroVault";

  private _authToken:  string | null = null;
  private _storageUrl: string | null = null;

  constructor(
    private readonly username:  string,
    private readonly password:  string,
    private readonly container: string = "retrovault",
  ) {}

  // ── CloudSaveProvider implementation ───────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    const ctl   = new AbortController();
    const timer = setTimeout(() => ctl.abort(), BLOMP_AUTH_TIMEOUT_MS);
    try {
      const r = await fetch(BlompProvider.AUTH_URL, {
        method:  "GET",
        headers: { "X-Auth-User": this.username, "X-Auth-Key": this.password },
        signal:  ctl.signal,
      });
      if (!r.ok) return false;
      const token      = r.headers.get("X-Auth-Token");
      const storageUrl = r.headers.get("X-Storage-Url");
      if (!token || !storageUrl) return false;
      this._authToken  = token;
      this._storageUrl = storageUrl;
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async upload(entry: SaveStateEntry): Promise<void> {
    await this._ensureAuth();
    const base = this._slotPath(entry.gameId, entry.slot);

    // Upload binary payloads in parallel first, then write the manifest last
    // so it only becomes visible after all data is in place.
    const parallelUploads: Promise<void>[] = [];
    if (entry.stateData) {
      parallelUploads.push(this._put(`${base}/state.bin`, entry.stateData, "application/octet-stream"));
    }
    if (entry.thumbnail) {
      parallelUploads.push(this._put(`${base}/thumb.jpg`, entry.thumbnail, "image/jpeg"));
    }
    await Promise.all(parallelUploads);

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
    await this._put(
      `${base}/manifest.json`,
      new Blob([JSON.stringify(manifest)], { type: "application/json" }),
      "application/json",
    );
  }

  async download(gameId: string, slot: number): Promise<SaveStateEntry | null> {
    await this._ensureAuth();
    const base = this._slotPath(gameId, slot);

    const manifestBlob = await this._get(`${base}/manifest.json`);
    if (!manifestBlob) return null;

    let manifest: CloudSaveManifest;
    try {
      manifest = JSON.parse(await manifestBlob.text()) as CloudSaveManifest;
    } catch {
      return null;
    }

    const [stateData, thumbnail] = await Promise.all([
      this._get(`${base}/state.bin`),
      this._get(`${base}/thumb.jpg`),
    ]);

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
    await this._ensureAuth();
    const slots = [AUTO_SAVE_SLOT, ...Array.from({ length: MAX_SAVE_SLOTS }, (_, i) => i + 1)];
    const results = await Promise.allSettled(
      slots.map(async slot => {
        const blob = await this._get(`${this._slotPath(gameId, slot)}/manifest.json`);
        if (!blob) return null;
        try {
          return JSON.parse(await blob.text()) as CloudSaveManifest;
        } catch {
          return null;
        }
      }),
    );
    return results
      .filter((r): r is PromiseFulfilledResult<CloudSaveManifest | null> => r.status === "fulfilled")
      .map(r => r.value)
      .filter((m): m is CloudSaveManifest => m !== null);
  }

  async delete(gameId: string, slot: number): Promise<void> {
    await this._ensureAuth();
    const base = this._slotPath(gameId, slot);
    await Promise.allSettled([
      this._delete(`${base}/manifest.json`),
      this._delete(`${base}/state.bin`),
      this._delete(`${base}/thumb.jpg`),
    ]);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** Swift object path for a specific game + slot. */
  private _slotPath(gameId: string, slot: number): string {
    const safeId = Array.from(new TextEncoder().encode(gameId))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
    return `${BlompProvider.ROOT_PREFIX}/${safeId}/${slot}`;
  }

  /**
   * Ensure an auth token is available.  If not, calls isAvailable() to
   * authenticate.  Throws with a user-facing message on failure.
   */
  private async _ensureAuth(): Promise<void> {
    if (this._authToken && this._storageUrl) return;
    const ok = await this.isAvailable();
    if (!ok) throw new Error("Blomp authentication failed — check your username and password.");
  }

  private _objectUrl(path: string): string {
    return `${this._storageUrl!}/${this.container}/${path}`;
  }

  private _authHeaders(): HeadersInit {
    return { "X-Auth-Token": this._authToken! };
  }

  private async _put(path: string, content: Blob, contentType: string): Promise<void> {
    const r = await this._timedFetch(this._objectUrl(path), {
      method:  "PUT",
      headers: { ...this._authHeaders(), "Content-Type": contentType },
      body:    content,
    });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) {
        this._authToken = null;
        throw new Error(`Blomp authentication failed (${r.status}) — your credentials may have expired. Please reconnect.`);
      }
      throw new Error(`Blomp upload failed (${r.status}): ${path}`);
    }
  }

  private async _get(path: string): Promise<Blob | null> {
    try {
      const r = await this._timedFetch(this._objectUrl(path), {
        headers: this._authHeaders(),
      });
      if (r.status === 401 || r.status === 403) {
        this._authToken = null;
        throw new Error(`Blomp authentication failed (${r.status}) — your credentials may have expired. Please reconnect.`);
      }
      if (!r.ok) return null;
      return r.blob();
    } catch (err) {
      if (err instanceof Error && err.message.includes("authentication failed")) throw err;
      return null;
    }
  }

  private async _delete(path: string): Promise<void> {
    const r = await this._timedFetch(this._objectUrl(path), {
      method:  "DELETE",
      headers: this._authHeaders(),
    });
    if (!r.ok) throw new Error(`Blomp delete failed (${r.status}): ${path}`);
  }

  private async _timedFetch(url: string, init: RequestInit): Promise<Response> {
    const ctl   = new AbortController();
    const timer = setTimeout(() => ctl.abort(), BLOMP_OPERATION_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── BoxProvider ───────────────────────────────────────────────────────────────

/** Timeout (ms) for Box availability check. */
const BOX_AVAILABILITY_TIMEOUT_MS = 8_000;
/** Timeout (ms) for all other Box operations. */
const BOX_OPERATION_TIMEOUT_MS    = 15_000;

/**
 * CloudSaveProvider backed by the Box API v2.
 *
 * Files are stored with flat names in the specified root folder so that no
 * sub-folder management is required:
 * ```
 * {rootFolderId}/
 *   rv__{gameId}__{slot}__manifest.json
 *   rv__{gameId}__{slot}__state.bin
 *   rv__{gameId}__{slot}__thumb.jpg
 * ```
 *
 * The access token must be obtained via OAuth 2.0 before constructing this
 * provider.  Required Box OAuth scopes: root_readwrite (or equivalent).
 */
export class BoxProvider implements CloudSaveProvider {
  readonly providerId  = "box";
  readonly displayName = "Box";

  private static readonly API_BASE    = "https://api.box.com/2.0";
  private static readonly UPLOAD_BASE = "https://upload.box.com/api/2.0";

  constructor(
    private readonly accessToken:   string,
    private readonly rootFolderId: string = "0",
  ) {}

  // ── CloudSaveProvider implementation ───────────────────────────────────────

  private _headers(): HeadersInit {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  async isAvailable(): Promise<boolean> {
    const ctl   = new AbortController();
    const timer = setTimeout(() => ctl.abort(), BOX_AVAILABILITY_TIMEOUT_MS);
    try {
      const r = await fetch(`${BoxProvider.API_BASE}/users/me`, {
        headers: this._headers(),
        signal:  ctl.signal,
      });
      return r.status === 200;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async upload(entry: SaveStateEntry): Promise<void> {
    // Upload state.bin and thumb.jpg in parallel first, then the manifest last.
    const parallelUploads: Promise<void>[] = [];
    if (entry.stateData) {
      parallelUploads.push(this._upsertFile(
        this._fileName(entry.gameId, entry.slot, "state.bin"),
        entry.stateData,
        "application/octet-stream",
      ));
    }
    if (entry.thumbnail) {
      parallelUploads.push(this._upsertFile(
        this._fileName(entry.gameId, entry.slot, "thumb.jpg"),
        entry.thumbnail,
        "image/jpeg",
      ));
    }
    await Promise.all(parallelUploads);

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
    await this._upsertFile(
      this._fileName(entry.gameId, entry.slot, "manifest.json"),
      new Blob([JSON.stringify(manifest)], { type: "application/json" }),
      "application/json",
    );
  }

  async download(gameId: string, slot: number): Promise<SaveStateEntry | null> {
    const manifestId = await this._findFileId(this._fileName(gameId, slot, "manifest.json"));
    if (!manifestId) return null;

    let manifest: CloudSaveManifest;
    try {
      const r = await this._timedFetch(
        `${BoxProvider.API_BASE}/files/${manifestId}/content`,
        { headers: this._headers() },
      );
      if (!r.ok) return null;
      manifest = await r.json() as CloudSaveManifest;
    } catch {
      return null;
    }

    const [stateId, thumbId] = await Promise.all([
      this._findFileId(this._fileName(gameId, slot, "state.bin")),
      this._findFileId(this._fileName(gameId, slot, "thumb.jpg")),
    ]);

    const [stateData, thumbnail] = await Promise.all([
      stateId
        ? this._timedFetch(`${BoxProvider.API_BASE}/files/${stateId}/content`, { headers: this._headers() })
            .then(r => (r.ok ? r.blob() : null))
            .catch(() => null)
        : Promise.resolve(null),
      thumbId
        ? this._timedFetch(`${BoxProvider.API_BASE}/files/${thumbId}/content`, { headers: this._headers() })
            .then(r => (r.ok ? r.blob() : null))
            .catch(() => null)
        : Promise.resolve(null),
    ]);

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
    const manifestIds = await this._findManifestFileIds(gameId);
    const results = await Promise.allSettled(
      Object.entries(manifestIds).map(async ([, fileId]) => {
        const r = await this._timedFetch(
          `${BoxProvider.API_BASE}/files/${fileId}/content`,
          { headers: this._headers() },
        );
        if (!r.ok) return null;
        try { return await r.json() as CloudSaveManifest; } catch { return null; }
      }),
    );
    return results
      .filter((r): r is PromiseFulfilledResult<CloudSaveManifest | null> => r.status === "fulfilled")
      .map(r => r.value)
      .filter((m): m is CloudSaveManifest => m !== null);
  }

  async delete(gameId: string, slot: number): Promise<void> {
    const suffixes = ["manifest.json", "state.bin", "thumb.jpg"];
    await Promise.allSettled(
      suffixes.map(async suffix => {
        const id = await this._findFileId(this._fileName(gameId, slot, suffix));
        if (!id) return;
        await this._timedFetch(
          `${BoxProvider.API_BASE}/files/${id}`,
          { method: "DELETE", headers: this._headers() },
        );
      }),
    );
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** Flat file name stored in the root folder. */
  private _fileName(gameId: string, slot: number, suffix: string): string {
    return `rv__${gameId}__${slot}__${suffix}`;
  }

  /**
   * Find a file in the root folder by exact name.
   * Returns the Box file ID, or null if not found.
   */
  private async _findFileId(name: string): Promise<string | null> {
    try {
      const r = await this._timedFetch(
        `${BoxProvider.API_BASE}/folders/${this.rootFolderId}/items?fields=id,name,type&limit=1000`,
        { headers: this._headers() },
      );
      if (!r.ok) return null;
      const data = await r.json() as { entries?: { id: string; name: string; type: string }[] };
      const match = (data.entries ?? []).find(e => e.name === name && e.type === "file");
      return match?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Find all manifest files for a game in the root folder using a single
   * listing request.  Returns a map of filename → Box file ID.
   */
  private async _findManifestFileIds(gameId: string): Promise<Record<string, string>> {
    const prefix = `rv__${gameId}__`;
    const suffix = `__manifest.json`;
    try {
      const r = await this._timedFetch(
        `${BoxProvider.API_BASE}/folders/${this.rootFolderId}/items?fields=id,name,type&limit=1000`,
        { headers: this._headers() },
      );
      if (!r.ok) return {};
      const data = await r.json() as { entries?: { id: string; name: string; type: string }[] };
      const out: Record<string, string> = {};
      for (const e of data.entries ?? []) {
        if (e.type === "file" && e.name.startsWith(prefix) && e.name.endsWith(suffix)) {
          out[e.name] = e.id;
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * Create or update (upsert) a file in the root folder using the Box upload
   * API (multipart/form-data).  If a file with the given name already exists,
   * its content is replaced; otherwise a new file is created.
   */
  private async _upsertFile(name: string, content: Blob, contentType: string): Promise<void> {
    const existingId = await this._findFileId(name);

    const attributes = existingId
      ? JSON.stringify({ name })
      : JSON.stringify({ name, parent: { id: this.rootFolderId } });

    const form = new FormData();
    form.append("attributes", new Blob([attributes], { type: "application/json" }));
    form.append("file", new File([content], name, { type: contentType }));

    const url = existingId
      ? `${BoxProvider.UPLOAD_BASE}/files/${existingId}/content`
      : `${BoxProvider.UPLOAD_BASE}/files/content`;

    // Box sets Content-Type automatically when given a FormData body, so we
    // only send the Authorization header here.
    const r = await this._timedFetch(url, {
      method: "POST",
      headers: this._headers(),
      body:   form,
    });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) {
        throw new Error(`Box authentication failed (${r.status}) — your token may have expired. Please reconnect.`);
      }
      throw new Error(`Box upload failed (${r.status}): ${name}`);
    }
  }

  private async _timedFetch(url: string, init: RequestInit): Promise<Response> {
    const ctl   = new AbortController();
    const timer = setTimeout(() => ctl.abort(), BOX_OPERATION_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── OneDriveProvider ──────────────────────────────────────────────────────────

/** Timeout (ms) for OneDrive availability check. */
const ONEDRIVE_AVAILABILITY_TIMEOUT_MS = 8_000;
/** Timeout (ms) for all other OneDrive operations. */
const ONEDRIVE_OPERATION_TIMEOUT_MS    = 15_000;

/**
 * CloudSaveProvider backed by Microsoft OneDrive via the Graph API v1.0.
 *
 * Files are stored in a dedicated app folder under the user's OneDrive:
 * ```
 * {rootFolderId}/
 *   RetroVault/{hex(gameId)}/{slot}/manifest.json
 *   RetroVault/{hex(gameId)}/{slot}/state.bin
 *   RetroVault/{hex(gameId)}/{slot}/thumb.jpg
 * ```
 *
 * The access token must be obtained via OAuth 2.0 before constructing this
 * provider.  Required scope: Files.ReadWrite.
 */
export class OneDriveProvider implements CloudSaveProvider {
  readonly providerId  = "onedrive";
  readonly displayName = "OneDrive";

  private static readonly API_BASE    = "https://graph.microsoft.com/v1.0";
  private static readonly ROOT_PREFIX = "RetroVault";

  constructor(
    private readonly accessToken: string,
    private readonly rootId:      string = "root",
  ) {}

  // ── CloudSaveProvider implementation ───────────────────────────────────────

  private _headers(): HeadersInit {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  async isAvailable(): Promise<boolean> {
    const ctl   = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ONEDRIVE_AVAILABILITY_TIMEOUT_MS);
    try {
      const r = await fetch(`${OneDriveProvider.API_BASE}/me/drive`, {
        headers: this._headers(),
        signal:  ctl.signal,
      });
      return r.status === 200;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async upload(entry: SaveStateEntry): Promise<void> {
    const base = this._slotPath(entry.gameId, entry.slot);

    // Upload binary payloads in parallel first, then write the manifest last.
    const parallelUploads: Promise<void>[] = [];
    if (entry.stateData) {
      parallelUploads.push(this._uploadFile(`${base}/state.bin`, entry.stateData, "application/octet-stream"));
    }
    if (entry.thumbnail) {
      parallelUploads.push(this._uploadFile(`${base}/thumb.jpg`, entry.thumbnail, "image/jpeg"));
    }
    await Promise.all(parallelUploads);

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
    await this._uploadFile(
      `${base}/manifest.json`,
      new Blob([JSON.stringify(manifest)], { type: "application/json" }),
      "application/json",
    );
  }

  async download(gameId: string, slot: number): Promise<SaveStateEntry | null> {
    const base = this._slotPath(gameId, slot);

    const manifestBlob = await this._downloadFile(`${base}/manifest.json`);
    if (!manifestBlob) return null;

    let manifest: CloudSaveManifest;
    try {
      manifest = JSON.parse(await manifestBlob.text()) as CloudSaveManifest;
    } catch {
      return null;
    }

    const [stateData, thumbnail] = await Promise.all([
      this._downloadFile(`${base}/state.bin`),
      this._downloadFile(`${base}/thumb.jpg`),
    ]);

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
    const results = await Promise.allSettled(
      slots.map(async slot => {
        const blob = await this._downloadFile(`${this._slotPath(gameId, slot)}/manifest.json`);
        if (!blob) return null;
        try {
          return JSON.parse(await blob.text()) as CloudSaveManifest;
        } catch {
          return null;
        }
      }),
    );
    return results
      .filter((r): r is PromiseFulfilledResult<CloudSaveManifest | null> => r.status === "fulfilled")
      .map(r => r.value)
      .filter((m): m is CloudSaveManifest => m !== null);
  }

  async delete(gameId: string, slot: number): Promise<void> {
    const base = this._slotPath(gameId, slot);
    await Promise.allSettled([
      this._deleteFile(`${base}/manifest.json`),
      this._deleteFile(`${base}/state.bin`),
      this._deleteFile(`${base}/thumb.jpg`),
    ]);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** OneDrive path for a specific game + slot folder. */
  private _slotPath(gameId: string, slot: number): string {
    const safeId = Array.from(new TextEncoder().encode(gameId))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
    return `${OneDriveProvider.ROOT_PREFIX}/${safeId}/${slot}`;
  }

  /** Build the Graph API URL for a file path relative to the root. */
  private _itemUrl(path: string): string {
    const parentId = this.rootId === "root" ? "root" : `items/${this.rootId}`;
    return `${OneDriveProvider.API_BASE}/me/drive/${parentId}:/${encodeURIComponent(path)}:`;
  }

  private async _uploadFile(path: string, content: Blob, contentType: string): Promise<void> {
    const url = `${this._itemUrl(path)}/content`;
    const r = await this._timedFetch(url, {
      method:  "PUT",
      headers: { ...this._headers(), "Content-Type": contentType },
      body:    content,
    });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) {
        throw new Error(`OneDrive authentication failed (${r.status}) — your token may have expired. Please reconnect.`);
      }
      throw new Error(`OneDrive upload failed (${r.status}): ${path}`);
    }
  }

  private async _downloadFile(path: string): Promise<Blob | null> {
    try {
      const url = `${this._itemUrl(path)}/content`;
      const r = await this._timedFetch(url, {
        headers: this._headers(),
      });
      if (r.status === 401 || r.status === 403) {
        throw new Error(`OneDrive authentication failed (${r.status}) — your token may have expired. Please reconnect.`);
      }
      if (!r.ok) return null;
      return r.blob();
    } catch (err) {
      if (err instanceof Error && err.message.includes("authentication failed")) throw err;
      return null;
    }
  }

  private async _deleteFile(path: string): Promise<void> {
    const parentId = this.rootId === "root" ? "root" : `items/${this.rootId}`;
    const url = `${OneDriveProvider.API_BASE}/me/drive/${parentId}:/${encodeURIComponent(path)}`;
    const r = await this._timedFetch(url, {
      method:  "DELETE",
      headers: this._headers(),
    });
    if (!r.ok && r.status !== 404) throw new Error(`OneDrive delete failed (${r.status}): ${path}`);
  }

  private async _timedFetch(url: string, init: RequestInit): Promise<Response> {
    const ctl   = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ONEDRIVE_OPERATION_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── MegaProvider ──────────────────────────────────────────────────────────────

/** Timeout (ms) for MEGA availability check. */
const MEGA_AVAILABILITY_TIMEOUT_MS = 15_000;
/** Timeout (ms) for all other MEGA operations. */
const MEGA_OPERATION_TIMEOUT_MS    = 30_000;

/**
 * CloudSaveProvider backed by MEGA cloud storage.
 *
 * MEGA uses end-to-end encryption.  This provider authenticates with
 * email + password, derives the AES master key, and stores save states
 * as files in a `/RetroVault/{hex(gameId)}/{slot}/` folder structure.
 *
 * Files are stored unencrypted at the MEGA layer (MEGA's own encryption
 * is handled transparently by the API); the provider does not add an
 * additional application-level encryption layer.
 */
export class MegaProvider implements CloudSaveProvider {
  readonly providerId  = "mega";
  readonly displayName = "MEGA";

  private static readonly API_URL     = "https://g.api.mega.co.nz/cs";

  private _sessionId:  string | null = null;
  private _masterKey:  Uint8Array | null = null;
  private _rootHandle: string | null = null;

  constructor(
    private readonly email:    string,
    private readonly password: string,
  ) {}

  // ── CloudSaveProvider implementation ───────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    const ctl   = new AbortController();
    const timer = setTimeout(() => ctl.abort(), MEGA_AVAILABILITY_TIMEOUT_MS);
    try {
      await this._ensureSession();
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async upload(entry: SaveStateEntry): Promise<void> {
    await this._ensureSession();
    const folderHandle = await this._ensureSlotFolder(entry.gameId, entry.slot);

    // Upload state and thumbnail in parallel before writing the manifest.
    const parallelUploads: Promise<void>[] = [];
    if (entry.stateData) {
      parallelUploads.push(this._megaUploadFile(folderHandle, "state.bin", entry.stateData));
    }
    if (entry.thumbnail) {
      parallelUploads.push(this._megaUploadFile(folderHandle, "thumb.jpg", entry.thumbnail));
    }
    await Promise.all(parallelUploads);

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
    await this._megaUploadFile(
      folderHandle, "manifest.json",
      new Blob([JSON.stringify(manifest)], { type: "application/json" }),
    );
  }

  async download(gameId: string, slot: number): Promise<SaveStateEntry | null> {
    await this._ensureSession();
    const slotHandle = await this._findSlotFolder(gameId, slot);
    if (!slotHandle) return null;

    const manifestBlob = await this._megaDownloadFile(slotHandle, "manifest.json");
    if (!manifestBlob) return null;

    let manifest: CloudSaveManifest;
    try {
      manifest = JSON.parse(await manifestBlob.text()) as CloudSaveManifest;
    } catch {
      return null;
    }

    const [stateData, thumbnail] = await Promise.all([
      this._megaDownloadFile(slotHandle, "state.bin"),
      this._megaDownloadFile(slotHandle, "thumb.jpg"),
    ]);

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
    await this._ensureSession();
    const slots = [AUTO_SAVE_SLOT, ...Array.from({ length: MAX_SAVE_SLOTS }, (_, i) => i + 1)];
    const results = await Promise.allSettled(
      slots.map(async slot => {
        const slotHandle = await this._findSlotFolder(gameId, slot);
        if (!slotHandle) return null;
        const blob = await this._megaDownloadFile(slotHandle, "manifest.json");
        if (!blob) return null;
        try {
          return JSON.parse(await blob.text()) as CloudSaveManifest;
        } catch {
          return null;
        }
      }),
    );
    return results
      .filter((r): r is PromiseFulfilledResult<CloudSaveManifest | null> => r.status === "fulfilled")
      .map(r => r.value)
      .filter((m): m is CloudSaveManifest => m !== null);
  }

  async delete(gameId: string, slot: number): Promise<void> {
    await this._ensureSession();
    const slotHandle = await this._findSlotFolder(gameId, slot);
    if (!slotHandle) return;
    // Delete the entire slot folder (MEGA moves to trash with 'a: "d"').
    try {
      await this._apiRequest([{ a: "d", n: slotHandle }]);
    } catch { /* best-effort */ }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async _ensureSession(): Promise<void> {
    if (this._sessionId && this._masterKey) return;
    await this._login();
  }

  private async _login(): Promise<void> {
    // Use the same crypto helpers from MegaLibraryProvider via dynamic import.
    const { MegaLibraryProvider } = await import("./cloudLibrary.js");

    const emailLower = this.email.toLowerCase();
    const passwordKey = MegaLibraryProvider._derivePasswordKey(this.password);
    const userHash = MegaLibraryProvider._computeUserHash(emailLower, passwordKey);

    const loginResp = await this._apiRequest([{ a: "us", user: emailLower, uh: userHash }]);
    const data = loginResp[0] as { tsid?: string; csid?: string; k?: string } | number;

    if (typeof data === "number" || !data || (!data.tsid && !data.csid)) {
      throw new Error("MEGA authentication failed — check your email and password.");
    }

    if (data.k) {
      const encryptedMasterKey = MegaLibraryProvider._base64ToUint8(data.k);
      this._masterKey = MegaLibraryProvider._aesEcbDecrypt(encryptedMasterKey, passwordKey);
    } else {
      throw new Error("MEGA login response missing master key.");
    }

    this._sessionId = data.tsid || data.csid || null;
    if (!this._sessionId) {
      throw new Error("MEGA login response missing session ID.");
    }

    // Cache root cloud drive handle.
    const nodesResp = await this._apiRequest([{ a: "f", c: 1 }]);
    const nodesData = nodesResp[0] as { f?: Array<{ h: string; t: number }> } | undefined;
    const rootNode = nodesData?.f?.find(n => n.t === 2);
    this._rootHandle = rootNode?.h ?? null;
  }

  /** Navigate to or create the RetroVault/{gameHex}/{slot} folder hierarchy. */
  private async _ensureSlotFolder(gameId: string, slot: number): Promise<string> {
    const safeId = Array.from(new TextEncoder().encode(gameId))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    let parentHandle = this._rootHandle;
    if (!parentHandle) throw new Error("MEGA root folder not found.");

    // Walk/create: RetroVault → safeId → slot
    for (const segment of ["RetroVault", safeId, String(slot)]) {
      const existing = await this._findChildFolder(parentHandle, segment);
      if (existing) {
        parentHandle = existing;
      } else {
        parentHandle = await this._createFolder(parentHandle, segment);
      }
    }
    return parentHandle;
  }

  /** Find an existing slot folder without creating it. Returns handle or null. */
  private async _findSlotFolder(gameId: string, slot: number): Promise<string | null> {
    const safeId = Array.from(new TextEncoder().encode(gameId))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    let parentHandle = this._rootHandle;
    if (!parentHandle) return null;

    for (const segment of ["RetroVault", safeId, String(slot)]) {
      const child = await this._findChildFolder(parentHandle, segment);
      if (!child) return null;
      parentHandle = child;
    }
    return parentHandle;
  }

  /** Find a child folder by name within a parent folder. */
  private async _findChildFolder(parentHandle: string, name: string): Promise<string | null> {
    const nodesResp = await this._apiRequest([{ a: "f", c: 1 }]);
    const nodesData = nodesResp[0] as { f?: Array<{ h: string; p: string; t: number; a: string; k: string }> } | undefined;
    const nodes = nodesData?.f ?? [];

    const { MegaLibraryProvider } = await import("./cloudLibrary.js");

    for (const n of nodes) {
      if (n.p !== parentHandle || n.t !== 1) continue;
      // Decrypt node name to match
      try {
        const keyParts = n.k.split(":");
        const encNodeKey = MegaLibraryProvider._base64ToUint8(keyParts[keyParts.length - 1]!);
        const decNodeKey = MegaLibraryProvider._aesEcbDecrypt(encNodeKey, this._masterKey!);
        // Derive attribute key: for folders (16 bytes) use directly;
        // for files (32 bytes) XOR the two halves.
        let attrKey: Uint8Array;
        if (decNodeKey.length >= 32) {
          attrKey = new Uint8Array(16);
          for (let i = 0; i < 16; i++) {
            attrKey[i] = (decNodeKey[i] ?? 0) ^ (decNodeKey[i + 16] ?? 0);
          }
        } else {
          attrKey = decNodeKey.slice(0, 16);
        }
        const encAttrs = MegaLibraryProvider._base64ToUint8(n.a);
        const decAttrs = MegaLibraryProvider._aesEcbDecrypt(encAttrs, attrKey);
        const attrStr = new TextDecoder().decode(decAttrs);
        const jsonStart = attrStr.indexOf("{");
        const jsonEnd = attrStr.lastIndexOf("}");
        if (jsonStart < 0 || jsonEnd < 0) continue;
        const attrs = JSON.parse(attrStr.slice(jsonStart, jsonEnd + 1)) as { n?: string };
        if (attrs.n === name) return n.h;
      } catch { continue; }
    }
    return null;
  }

  /** Create a folder under the given parent. Returns the new folder's handle. */
  private async _createFolder(parentHandle: string, name: string): Promise<string> {
    const resp = await this._apiRequest([{
      a: "p",
      t: parentHandle,
      n: [{ h: "xxxxxxxx", t: 1, a: btoa(JSON.stringify({ n: name })), k: "" }],
    }]);
    const data = resp[0] as { f?: Array<{ h: string }> } | number;
    if (typeof data === "number" || !data?.f?.[0]?.h) {
      throw new Error(`MEGA folder creation failed for "${name}".`);
    }
    return data.f[0].h;
  }

  /** Upload a file to a MEGA folder. */
  private async _megaUploadFile(folderHandle: string, filename: string, content: Blob): Promise<void> {
    // For simplicity, use MEGA's upload endpoint.
    // Step 1: Request an upload URL.
    const size = content.size;
    const ulResp = await this._apiRequest([{ a: "u", s: size }]);
    const ulData = ulResp[0] as { p?: string } | number;
    if (typeof ulData === "number" || !ulData?.p) {
      throw new Error(`MEGA upload request failed for "${filename}".`);
    }

    // Step 2: Upload the data to the URL.
    const uploadUrl = ulData.p;
    const buffer = await content.arrayBuffer();
    const r = await this._timedFetch(uploadUrl, {
      method: "POST",
      body:   buffer,
    });
    if (!r.ok) throw new Error(`MEGA upload failed (${r.status}): ${filename}`);
    const completionHandle = await r.text();

    // Step 3: Attach the uploaded file to the folder.
    const attachResp = await this._apiRequest([{
      a: "p",
      t: folderHandle,
      n: [{ h: completionHandle, t: 0, a: btoa(JSON.stringify({ n: filename })), k: "" }],
    }]);
    const attachData = attachResp[0] as { f?: Array<{ h: string }> } | number;
    if (typeof attachData === "number") {
      throw new Error(`MEGA file attach failed for "${filename}".`);
    }
  }

  /** Download a file by name from a MEGA folder. */
  private async _megaDownloadFile(folderHandle: string, filename: string): Promise<Blob | null> {
    try {
      // Find the file node within the folder.
      const nodesResp = await this._apiRequest([{ a: "f", c: 1 }]);
      const nodesData = nodesResp[0] as { f?: Array<{ h: string; p: string; t: number; a: string; k: string }> } | undefined;
      const nodes = nodesData?.f ?? [];
      const { MegaLibraryProvider } = await import("./cloudLibrary.js");

      let fileHandle: string | null = null;
      for (const n of nodes) {
        if (n.p !== folderHandle || n.t !== 0) continue;
        try {
          const keyParts = n.k.split(":");
          const encNodeKey = MegaLibraryProvider._base64ToUint8(keyParts[keyParts.length - 1]!);
          const decNodeKey = MegaLibraryProvider._aesEcbDecrypt(encNodeKey, this._masterKey!);
          let attrKey: Uint8Array;
          if (decNodeKey.length >= 32) {
            attrKey = new Uint8Array(16);
            for (let i = 0; i < 16; i++) {
              attrKey[i] = (decNodeKey[i] ?? 0) ^ (decNodeKey[i + 16] ?? 0);
            }
          } else {
            attrKey = decNodeKey.slice(0, 16);
          }
          const encAttrs = MegaLibraryProvider._base64ToUint8(n.a);
          const decAttrs = MegaLibraryProvider._aesEcbDecrypt(encAttrs, attrKey);
          const attrStr = new TextDecoder().decode(decAttrs);
          const jsonStart = attrStr.indexOf("{");
          const jsonEnd = attrStr.lastIndexOf("}");
          if (jsonStart < 0 || jsonEnd < 0) continue;
          const attrs = JSON.parse(attrStr.slice(jsonStart, jsonEnd + 1)) as { n?: string };
          if (attrs.n === filename) { fileHandle = n.h; break; }
        } catch { continue; }
      }

      if (!fileHandle) return null;

      // Get download URL.
      const dlResp = await this._apiRequest([{ a: "g", g: 1, n: fileHandle }]);
      const dlData = dlResp[0] as { g?: string } | number;
      if (typeof dlData === "number" || !dlData?.g) return null;

      const fileR = await this._timedFetch(dlData.g, { method: "GET" });
      if (!fileR.ok) return null;
      return fileR.blob();
    } catch {
      return null;
    }
  }

  private async _apiRequest(payload: unknown[]): Promise<unknown[]> {
    const url = new URL(MegaProvider.API_URL);
    if (this._sessionId) url.searchParams.set("sid", this._sessionId);

    const r = await this._timedFetch(url.toString(), {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`MEGA API failed: ${r.status}`);
    return await r.json() as unknown[];
  }

  private async _timedFetch(url: string, init: RequestInit): Promise<Response> {
    const ctl   = new AbortController();
    const timer = setTimeout(() => ctl.abort(), MEGA_OPERATION_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── CloudSaveManager ──────────────────────────────────────────────────────────

/** Settings persisted in localStorage under "retrovault-cloud". */
export interface CloudSaveSettings {
  providerId:         "null" | "webdav" | "gdrive" | "dropbox" | "pcloud" | "blomp" | "box" | "onedrive" | "mega";
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
  private _connected    = false;
  private _lastSyncAt:  number | null = null;
  private _lastError:   string | null = null;

  /** Persisted settings */
  providerId:         "null" | "webdav" | "gdrive" | "dropbox" | "pcloud" | "blomp" | "box" | "onedrive" | "mega" = "null";
  autoSyncEnabled:    boolean           = false;
  conflictResolution: ConflictResolution = "newest";

  /** Called whenever connection status or lastSyncAt / lastError change. */
  onStatusChange?: () => void;
  private readonly _statusListeners = new Set<() => void>();

  /**
   * Optional callback invoked when both local and remote saves exist for a
   * slot.  If provided, the UI can present a conflict-resolution modal and
   * return the user's choice.  When absent, the configured conflictResolution
   * strategy is applied automatically.
   */
  onConflict?: (conflict: SyncConflict) => Promise<ConflictResolution>;

  // ── Per-slot sync badges ──────────────────────────────────────────────────

  private _slotBadges = new Map<string, SyncBadge>();

  /** Return the sync badge for a game + slot, defaulting to "local-only". */
  getSlotBadge(gameId: string, slot: number): SyncBadge {
    return this._slotBadges.get(`${gameId}:${slot}`) ?? "local-only";
  }

  /** Update the sync badge for a game + slot and notify listeners. */
  setSlotBadge(gameId: string, slot: number, badge: SyncBadge): void {
    this._slotBadges.set(`${gameId}:${slot}`, badge);
    this._emitStatusChange();
  }

  // ── Sync history ──────────────────────────────────────────────────────────

  /** Maximum number of history entries retained. */
  static readonly MAX_HISTORY = 20;

  private _syncHistory: SyncHistoryEntry[] = [];

  /** Read-only copy of the recent sync history (newest first). */
  get syncHistory(): readonly SyncHistoryEntry[] { return this._syncHistory; }

  /** Append an entry to the sync history ring buffer. */
  addHistoryEntry(action: string, ok: boolean): void {
    this._syncHistory.unshift({ timestamp: Date.now(), action, ok });
    if (this._syncHistory.length > CloudSaveManager.MAX_HISTORY) {
      this._syncHistory.length = CloudSaveManager.MAX_HISTORY;
    }
    this._emitStatusChange();
  }

  /** Register a status-change listener. Returns an unsubscribe function. */
  addStatusListener(listener: () => void): () => void {
    this._statusListeners.add(listener);
    return () => {
      this._statusListeners.delete(listener);
    };
  }

  private _emitStatusChange(): void {
    this.onStatusChange?.();
    for (const listener of this._statusListeners) listener();
  }

  private static readonly SETTINGS_KEY  = "retrovault-cloud";
  private static readonly WEBDAV_KEY    = "retrovault-cloud-webdav";
  private static readonly GDRIVE_KEY    = "retrovault-cloud-gdrive";
  private static readonly DROPBOX_KEY   = "retrovault-cloud-dropbox";
  private static readonly PCLOUD_KEY    = "retrovault-cloud-pcloud";
  private static readonly BLOMP_KEY     = "retrovault-cloud-blomp";
  private static readonly BOX_KEY       = "retrovault-cloud-box";
  private static readonly ONEDRIVE_KEY  = "retrovault-cloud-onedrive";
  private static readonly MEGA_KEY      = "retrovault-cloud-mega";

  constructor() {
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
    this._connected     = true;
    this.providerId     = provider.providerId as "null" | "webdav" | "gdrive" | "dropbox" | "pcloud" | "blomp" | "box" | "onedrive" | "mega";
    this._lastError     = null;
    this._saveSettings();
    this._emitStatusChange();
  }

  /** Disconnect from the current provider (does not erase WebDAV credentials). */
  disconnect(): void {
    this._connected   = false;
    this.providerId   = "null";
    this._provider    = new NullCloudProvider();
    this._lastError   = null;
    this._saveSettings();
    this._emitStatusChange();
  }

  // ── Sync operations ─────────────────────────────────────────────────────────

  /**
   * Push a single save state entry to the cloud.
   * Silently no-ops when disconnected.
   */
  async push(entry: SaveStateEntry): Promise<void> {
    try {
      if (!this._connected) return;
      this.setSlotBadge(entry.gameId, entry.slot, "syncing");
      await this._provider.upload(entry);
      this._lastSyncAt = Date.now();
      this._lastError  = null;
      this.setSlotBadge(entry.gameId, entry.slot, "synced");
      this.addHistoryEntry(`Pushed slot ${entry.slot}`, true);
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      this.setSlotBadge(entry.gameId, entry.slot, "error");
      this.addHistoryEntry(`Push slot ${entry.slot} failed: ${this._lastError}`, false);
      throw err;
    }
  }

  /**
   * Pull the cloud save for a given game + slot.
   * Returns null when disconnected or no cloud save exists.
   */
  async pull(gameId: string, slot: number): Promise<SaveStateEntry | null> {
    try {
      if (!this._connected) return null;
      this.setSlotBadge(gameId, slot, "syncing");
      const result     = await this._provider.download(gameId, slot);
      this._lastSyncAt = Date.now();
      this._lastError  = null;
      this.setSlotBadge(gameId, slot, result ? "synced" : "local-only");
      this.addHistoryEntry(result ? `Pulled slot ${slot}` : `Pull slot ${slot}: no remote`, true);
      return result;
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      this.setSlotBadge(gameId, slot, "error");
      this.addHistoryEntry(`Pull slot ${slot} failed: ${this._lastError}`, false);
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
  ): Promise<{ entry: SaveStateEntry; direction: "pushed" | "pulled" } | null> {
    if (!this._connected) return null;

    try {
      this.setSlotBadge(gameId, slot, "syncing");

      // Download the remote entry once — reused for both conflict detection and
      // resolution, avoiding a second round-trip when onConflict is set.
      const remoteEntry = await this._provider.download(gameId, slot);

      if (!localEntry && !remoteEntry) {
        this.setSlotBadge(gameId, slot, "local-only");
        return null;
      }

      if (!localEntry && remoteEntry) {
        this._lastSyncAt = Date.now();
        this._lastError  = null;
        this.setSlotBadge(gameId, slot, "synced");
        this.addHistoryEntry(`Slot ${slot} pulled`, true);
        return { entry: remoteEntry, direction: "pulled" };
      }

      if (localEntry && !remoteEntry) {
        await this._provider.upload(localEntry);
        this._lastSyncAt = Date.now();
        this._lastError  = null;
        this.setSlotBadge(gameId, slot, "synced");
        this.addHistoryEntry(`Slot ${slot} pushed`, true);
        return { entry: localEntry, direction: "pushed" };
      }

      // Both sides have a save — resolve the conflict.
      let resolution: ConflictResolution;
      if (this.onConflict) {
        resolution = await this.onConflict({
          local: localEntry!, remote: remoteEntry!, gameId, slot,
        });
      } else {
        resolution = this.conflictResolution;
      }

      const tempSync = new CloudSaveSync(this._provider, resolution);
      const winner   = tempSync.resolveConflict({
        local: localEntry!, remote: remoteEntry!, gameId, slot,
      });
      const direction: "pushed" | "pulled" = winner === localEntry ? "pushed" : "pulled";
      if (direction === "pushed") await this._provider.upload(localEntry!);

      this._lastSyncAt = Date.now();
      this._lastError  = null;
      this.setSlotBadge(gameId, slot, "synced");
      const conflictLabel = this.onConflict
        ? `Slot ${slot} ${direction} (user chose ${resolution})`
        : `Slot ${slot} ${direction} (auto: ${resolution})`;
      this.addHistoryEntry(conflictLabel, true);
      return { entry: winner, direction };
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      this.setSlotBadge(gameId, slot, "error");
      this.addHistoryEntry(`Sync slot ${slot} failed: ${this._lastError}`, false);
      throw err;
    }
  }

  /**
   * Synchronise all save slots for a game against the cloud.
   *
   * @param gameId      Game identifier.
   * @param saveLibrary Object exposing `getStatesForGame(gameId)`.
   *                    When `saveState(entry)` is available, pulled remote
   *                    entries are persisted back to local storage.
   */
  async syncGame(
    gameId: string,
    saveLibrary: {
      getStatesForGame(id: string): Promise<SaveStateEntry[]>;
      saveState?(entry: SaveStateEntry): Promise<void>;
    },
  ): Promise<GameSyncResult> {
    // Bail immediately when disconnected to avoid making API calls for each slot.
    if (!this._connected) return { pushed: 0, pulled: 0, errors: 0 };

    const states   = await saveLibrary.getStatesForGame(gameId);
    const stateMap = new Map(states.map(s => [s.slot, s]));
    const slots    = [AUTO_SAVE_SLOT, ...Array.from({ length: MAX_SAVE_SLOTS }, (_, i) => i + 1)];

    let pushed = 0, pulled = 0, errors = 0;
    await Promise.allSettled(slots.map(async slot => {
      try {
        const result = await this.syncSlot(gameId, slot, stateMap.get(slot) ?? null);
        if (result?.direction === "pushed") {
          pushed++;
          return;
        }
        if (result?.direction === "pulled") {
          if (saveLibrary.saveState) {
            await saveLibrary.saveState(result.entry);
          }
          pulled++;
        }
      } catch { errors++; }
    }));

    const result: GameSyncResult = { pushed, pulled, errors };
    const parts: string[] = [];
    if (pushed > 0) parts.push(`↑${pushed}`);
    if (pulled > 0) parts.push(`↓${pulled}`);
    if (errors > 0) parts.push(`${errors} err`);
    this.addHistoryEntry(
      parts.length > 0 ? `Sync game: ${parts.join(", ")}` : "Sync game: no changes",
      errors === 0,
    );

    return result;
  }

  // ── WebDAV credential storage ───────────────────────────────────────────────

  /** Persist WebDAV connection parameters (stored in a separate localStorage key).
   *
   * ⚠️  Security note: the password is stored in plaintext in localStorage,
   * which is accessible to any JavaScript running on the same origin.
   * Users should be aware of this risk, particularly on shared devices.
   */
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

  // ── Google Drive credential storage ─────────────────────────────────────────

  /** Persist Google Drive OAuth access token.
   *
   * ⚠️  Security note: the token is stored in plaintext in localStorage.
   * OAuth access tokens are short-lived (typically 1 hour), which limits
   * exposure, but users should be aware on shared devices.
   */
  saveGDriveConfig(accessToken: string): void {
    try {
      localStorage.setItem(CloudSaveManager.GDRIVE_KEY, JSON.stringify({ accessToken }));
    } catch { /* quota exceeded or private-browsing restriction */ }
  }

  /** Load previously saved Google Drive access token, or null if none exist. */
  loadGDriveConfig(): { accessToken: string } | null {
    try {
      const raw = localStorage.getItem(CloudSaveManager.GDRIVE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as { accessToken: string };
    } catch { return null; }
  }

  /** Remove persisted Google Drive credentials from localStorage. */
  clearGDriveConfig(): void {
    try { localStorage.removeItem(CloudSaveManager.GDRIVE_KEY); } catch { /* ignore */ }
  }

  // ── Dropbox credential storage ───────────────────────────────────────────────

  /** Persist Dropbox OAuth access token.
   *
   * ⚠️  Security note: the token is stored in plaintext in localStorage,
   * which is accessible to any JavaScript running on the same origin.
   * Users should be aware of this risk, particularly on shared devices.
   */
  saveDropboxConfig(accessToken: string): void {
    try {
      localStorage.setItem(CloudSaveManager.DROPBOX_KEY, JSON.stringify({ accessToken }));
    } catch { /* quota exceeded or private-browsing restriction */ }
  }

  /** Load previously saved Dropbox access token, or null if none exist. */
  loadDropboxConfig(): { accessToken: string } | null {
    try {
      const raw = localStorage.getItem(CloudSaveManager.DROPBOX_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as { accessToken: string };
    } catch { return null; }
  }

  /** Remove persisted Dropbox credentials from localStorage. */
  clearDropboxConfig(): void {
    try { localStorage.removeItem(CloudSaveManager.DROPBOX_KEY); } catch { /* ignore */ }
  }

  // ── pCloud credential storage ─────────────────────────────────────────────

  /** Persist pCloud OAuth access token and selected region.
   *
   * ⚠️  Security note: the token is stored in plaintext in localStorage,
   * which is accessible to any JavaScript running on the same origin.
   * Users should be aware of this risk, particularly on shared devices.
   */
  savePCloudConfig(accessToken: string, region: "us" | "eu"): void {
    try {
      localStorage.setItem(CloudSaveManager.PCLOUD_KEY, JSON.stringify({ accessToken, region }));
    } catch { /* quota exceeded or private-browsing restriction */ }
  }

  /** Load previously saved pCloud access token and region, or null if none exist. */
  loadPCloudConfig(): { accessToken: string; region: "us" | "eu" } | null {
    try {
      const raw = localStorage.getItem(CloudSaveManager.PCLOUD_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw) as { accessToken?: string; region?: string };
      const region = p.region === "eu" ? "eu" : "us";
      return { accessToken: p.accessToken ?? "", region };
    } catch { return null; }
  }

  /** Remove persisted pCloud credentials from localStorage. */
  clearPCloudConfig(): void {
    try { localStorage.removeItem(CloudSaveManager.PCLOUD_KEY); } catch { /* ignore */ }
  }

  // ── Blomp credential storage ──────────────────────────────────────────────

  /** Persist Blomp username, password, and container.
   *
   * ⚠️  Security note: the password is stored in plaintext in localStorage,
   * which is accessible to any JavaScript running on the same origin.
   * Users should be aware of this risk, particularly on shared devices.
   */
  saveBlompConfig(username: string, password: string, container = "retrovault"): void {
    try {
      localStorage.setItem(CloudSaveManager.BLOMP_KEY, JSON.stringify({ username, password, container }));
    } catch { /* quota exceeded or private-browsing restriction */ }
  }

  /** Load previously saved Blomp credentials, or null if none exist. */
  loadBlompConfig(): { username: string; password: string; container: string } | null {
    try {
      const raw = localStorage.getItem(CloudSaveManager.BLOMP_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw) as { username?: string; password?: string; container?: string };
      return {
        username:  p.username  ?? "",
        password:  p.password  ?? "",
        container: p.container ?? "retrovault",
      };
    } catch { return null; }
  }

  /** Remove persisted Blomp credentials from localStorage. */
  clearBlompConfig(): void {
    try { localStorage.removeItem(CloudSaveManager.BLOMP_KEY); } catch { /* ignore */ }
  }

  // ── Box credential storage ────────────────────────────────────────────────

  /** Persist Box OAuth access token and root folder ID.
   *
   * ⚠️  Security note: the token is stored in plaintext in localStorage.
   * OAuth access tokens are short-lived (typically 1 hour), which limits
   * exposure, but users should be aware on shared devices.
   */
  saveBoxConfig(accessToken: string, rootFolderId = "0"): void {
    try {
      localStorage.setItem(CloudSaveManager.BOX_KEY, JSON.stringify({ accessToken, rootFolderId }));
    } catch { /* quota exceeded or private-browsing restriction */ }
  }

  /** Load previously saved Box access token and root folder ID, or null if none exist. */
  loadBoxConfig(): { accessToken: string; rootFolderId: string } | null {
    try {
      const raw = localStorage.getItem(CloudSaveManager.BOX_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw) as { accessToken?: string; rootFolderId?: string };
      return {
        accessToken:   p.accessToken   ?? "",
        rootFolderId:  p.rootFolderId  ?? "0",
      };
    } catch { return null; }
  }

  /** Remove persisted Box credentials from localStorage. */
  clearBoxConfig(): void {
    try { localStorage.removeItem(CloudSaveManager.BOX_KEY); } catch { /* ignore */ }
  }

  // ── OneDrive credential storage ──────────────────────────────────────────

  /** Persist OneDrive OAuth access token and root folder ID.
   *
   * ⚠️  Security note: the token is stored in plaintext in localStorage.
   * OAuth access tokens are short-lived (typically 1 hour), which limits
   * exposure, but users should be aware on shared devices.
   */
  saveOneDriveConfig(accessToken: string, rootId = "root"): void {
    try {
      localStorage.setItem(CloudSaveManager.ONEDRIVE_KEY, JSON.stringify({ accessToken, rootId }));
    } catch { /* quota exceeded or private-browsing restriction */ }
  }

  /** Load previously saved OneDrive access token and root ID, or null if none exist. */
  loadOneDriveConfig(): { accessToken: string; rootId: string } | null {
    try {
      const raw = localStorage.getItem(CloudSaveManager.ONEDRIVE_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw) as { accessToken?: string; rootId?: string };
      return {
        accessToken: p.accessToken ?? "",
        rootId:      p.rootId      ?? "root",
      };
    } catch { return null; }
  }

  /** Remove persisted OneDrive credentials from localStorage. */
  clearOneDriveConfig(): void {
    try { localStorage.removeItem(CloudSaveManager.ONEDRIVE_KEY); } catch { /* ignore */ }
  }

  // ── MEGA credential storage ──────────────────────────────────────────────

  /** Persist MEGA email and password.
   *
   * ⚠️  Security note: the password is stored in plaintext in localStorage,
   * which is accessible to any JavaScript running on the same origin.
   * Users should be aware of this risk, particularly on shared devices.
   */
  saveMegaConfig(email: string, password: string): void {
    try {
      localStorage.setItem(CloudSaveManager.MEGA_KEY, JSON.stringify({ email, password }));
    } catch { /* quota exceeded or private-browsing restriction */ }
  }

  /** Load previously saved MEGA credentials, or null if none exist. */
  loadMegaConfig(): { email: string; password: string } | null {
    try {
      const raw = localStorage.getItem(CloudSaveManager.MEGA_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw) as { email?: string; password?: string };
      return {
        email:    p.email    ?? "",
        password: p.password ?? "",
      };
    } catch { return null; }
  }

  /** Remove persisted MEGA credentials from localStorage. */
  clearMegaConfig(): void {
    try { localStorage.removeItem(CloudSaveManager.MEGA_KEY); } catch { /* ignore */ }
  }

  // ── Settings persistence ────────────────────────────────────────────────────

  private _loadSettings(): void {
    try {
      const raw = localStorage.getItem(CloudSaveManager.SETTINGS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as Partial<CloudSaveSettings>;
      // providerId is stored as the literal string "null" (not JSON null) when
      // no provider is configured, matching the CloudSaveSettings type definition.
      if (p.providerId === "null" || p.providerId === "webdav" ||
          p.providerId === "gdrive" || p.providerId === "dropbox" ||
          p.providerId === "pcloud" || p.providerId === "blomp" ||
          p.providerId === "box" || p.providerId === "onedrive" ||
          p.providerId === "mega") {
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
    this._emitStatusChange();
  }

  /** Update conflictResolution and persist to localStorage. */
  setConflictResolution(strategy: ConflictResolution): void {
    this.conflictResolution = strategy;
    this._saveSettings();
  }
}
