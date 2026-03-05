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
 *
 * Adding a new cloud provider
 * ---------------------------
 * 1. Implement the CloudSaveProvider interface.
 * 2. Instantiate CloudSaveSync with your provider.
 * 3. Call sync.push() after each local save and sync.pull() on launch.
 */

import type { SaveStateEntry } from "./saves.js";

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

    if (winner === localEntry || winner.timestamp === localEntry!.timestamp) {
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
