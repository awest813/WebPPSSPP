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

    const stateData = await this._downloadFile(`${base}/state.bin`);
    const thumbnail  = await this._downloadFile(`${base}/thumb.jpg`);

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
    const safeId = gameId.replace(/[^a-zA-Z0-9_\-.]/g, "_");
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

// ── CloudSaveManager ──────────────────────────────────────────────────────────

/** Settings persisted in localStorage under "retrovault-cloud". */
export interface CloudSaveSettings {
  providerId:         "null" | "webdav" | "gdrive" | "dropbox";
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
  providerId:         "null" | "webdav" | "gdrive" | "dropbox" = "null";
  autoSyncEnabled:    boolean           = false;
  conflictResolution: ConflictResolution = "newest";

  /** Called whenever connection status or lastSyncAt / lastError change. */
  onStatusChange?: () => void;

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
    this.onStatusChange?.();
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
    this.onStatusChange?.();
  }

  private static readonly SETTINGS_KEY = "retrovault-cloud";
  private static readonly WEBDAV_KEY   = "retrovault-cloud-webdav";
  private static readonly GDRIVE_KEY   = "retrovault-cloud-gdrive";
  private static readonly DROPBOX_KEY  = "retrovault-cloud-dropbox";

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
    this.providerId     = provider.providerId as "null" | "webdav" | "gdrive" | "dropbox";
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
      if (!this._connected) return;
      this.setSlotBadge(entry.gameId, entry.slot, "syncing");
      await this._sync.push(entry);
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
      const result     = await this._sync.pull(gameId, slot);
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
    try {
      this.setSlotBadge(gameId, slot, "syncing");

      // When an interactive onConflict callback is registered, detect
      // conflicts manually so the user can choose.
      if (this.onConflict && this._connected && localEntry) {
        const remoteEntry = await this._provider.download(gameId, slot);
        if (remoteEntry) {
          const resolution = await this.onConflict({ local: localEntry, remote: remoteEntry, gameId, slot });
          const tempSync = new CloudSaveSync(this._provider, resolution);
          const result = await tempSync.syncSlot(localEntry, gameId, slot);
          if (result) {
            this._lastSyncAt = Date.now();
            this._lastError  = null;
            this.setSlotBadge(gameId, slot, "synced");
            this.addHistoryEntry(`Slot ${slot} ${result.direction} (user chose ${resolution})`, true);
          }
          return result;
        }
      }

      const result = await this._sync.syncSlot(localEntry, gameId, slot);
      if (result) {
        this._lastSyncAt = Date.now();
        this._lastError  = null;
        this.setSlotBadge(gameId, slot, "synced");
        this.addHistoryEntry(`Slot ${slot} ${result.direction}`, true);
      } else {
        this.setSlotBadge(gameId, slot, "local-only");
      }
      return result;
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

  // ── Settings persistence ────────────────────────────────────────────────────

  private _loadSettings(): void {
    try {
      const raw = localStorage.getItem(CloudSaveManager.SETTINGS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as Partial<CloudSaveSettings>;
      // providerId is stored as the literal string "null" (not JSON null) when
      // no provider is configured, matching the CloudSaveSettings type definition.
      if (p.providerId === "null" || p.providerId === "webdav" ||
          p.providerId === "gdrive" || p.providerId === "dropbox") {
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
