/**
 * RetroOasisStore — Centralised application state with Observer pattern.
 *
 * Provides typed, synchronous state management for the five core slices of
 * application state.  Consumers call `store.subscribe(slice, cb)` to react
 * to changes without prop-drilling through component trees.
 *
 * Atomic batching via `store.batch(fn)` collects all mutations made inside
 * `fn` and fires each slice's subscribers exactly once after `fn` returns,
 * eliminating cascading re-renders (e.g. 20 settings loaded at startup →
 * one library re-render, not 20).
 */

import type { PerformanceMode } from "../performance.js";
import type { PostProcessEffect } from "../webgpuPostProcess.js";

// ── Slice type definitions ─────────────────────────────────────────────────

export interface SettingsSlice {
  volume: number;
  lastGameName: string | null;
  performanceMode: PerformanceMode;
  showFPS: boolean;
  showAudioVis: boolean;
  useWebGPU: boolean;
  postProcessEffect: PostProcessEffect;
  autoSaveEnabled: boolean;
  touchControls: boolean;
  touchControlsBySystem: Record<string, boolean>;
  hapticFeedback: boolean;
  touchOpacity: number;
  touchButtonScale: number;
  orientationLock: boolean;
  netplayEnabled: boolean;
  netplayServerUrl: string;
  netplayUsername: string;
  verboseLogging: boolean;
  cloudLibraries: CloudLibrarySlice[];
  audioFilterType: "none" | "lowpass" | "highpass";
  audioFilterCutoff: number;
  uiMode: "auto" | "quality" | "lite";
  libraryLayout: "grid" | "list" | "compact";
  libraryGrouped: boolean;
  coreOptions: Record<string, string>;
}

export interface CloudLibrarySlice {
  id: string;
  provider: "gdrive" | "dropbox" | "onedrive" | "pcloud" | "webdav" | "blomp" | "box";
  name: string;
  enabled: boolean;
  config: string;
}

export interface LibrarySlice {
  /** ISO timestamp of last full render, used to avoid redundant re-renders. */
  lastRenderedAt: number;
  searchQuery: string;
  sortMode: "lastPlayed" | "name" | "added" | "system";
  systemFilter: string;
  showFavorites: boolean;
  layout: "grid" | "list" | "compact";
  grouped: boolean;
}

export interface SessionSlice {
  gameId: string | null;
  gameName: string | null;
  systemId: string | null;
  /** Emulator lifecycle phase. */
  phase: "idle" | "loading" | "running" | "paused" | "error";
}

export interface CloudSyncSlice {
  /** Whether a cloud-save provider is connected. */
  connected: boolean;
  /** Display name of the active provider, or null when disconnected. */
  providerName: string | null;
  /** ISO timestamp of the most recent successful sync. */
  lastSyncAt: number | null;
  /** Number of in-progress syncs (for spinner state). */
  syncing: number;
}

export interface NetplaySlice {
  /** Whether EasyNetplay is currently open / active. */
  active: boolean;
  /** Room key the local player is hosting or has joined. */
  roomKey: string | null;
  /** Number of connected peers (0 = solo / not connected). */
  peerCount: number;
}

// ── Slice map ──────────────────────────────────────────────────────────────

export interface StoreSlices {
  settings:  SettingsSlice;
  library:   LibrarySlice;
  session:   SessionSlice;
  cloudSync: CloudSyncSlice;
  netplay:   NetplaySlice;
}

export type SliceKey = keyof StoreSlices;

// ── Subscription token ─────────────────────────────────────────────────────

/** Opaque token returned by `subscribe`; pass to `unsubscribe` to cancel. */
export type SubscriptionToken = symbol;

type Listener<K extends SliceKey> = (state: StoreSlices[K]) => void;

// ── Default slice states ───────────────────────────────────────────────────

function defaultSettings(): SettingsSlice {
  return {
    volume: 0.7,
    lastGameName: null,
    performanceMode: "auto",
    showFPS: false,
    showAudioVis: false,
    useWebGPU: false,
    postProcessEffect: "none" as PostProcessEffect,
    autoSaveEnabled: true,
    touchControls: false,
    touchControlsBySystem: {},
    hapticFeedback: true,
    touchOpacity: 0.85,
    touchButtonScale: 1.0,
    orientationLock: true,
    netplayEnabled: false,
    netplayServerUrl: "",
    netplayUsername: "",
    verboseLogging: false,
    cloudLibraries: [],
    audioFilterType: "none",
    audioFilterCutoff: 10_000,
    uiMode: "auto",
    libraryLayout: "grid",
    libraryGrouped: true,
    coreOptions: {},
  };
}

function defaultLibrary(): LibrarySlice {
  return {
    lastRenderedAt: 0,
    searchQuery: "",
    sortMode: "lastPlayed",
    systemFilter: "",
    showFavorites: false,
    layout: "grid",
    grouped: true,
  };
}

function defaultSession(): SessionSlice {
  return {
    gameId: null,
    gameName: null,
    systemId: null,
    phase: "idle",
  };
}

function defaultCloudSync(): CloudSyncSlice {
  return {
    connected: false,
    providerName: null,
    lastSyncAt: null,
    syncing: 0,
  };
}

function defaultNetplay(): NetplaySlice {
  return {
    active: false,
    roomKey: null,
    peerCount: 0,
  };
}

// ── RetroOasisStore ────────────────────────────────────────────────────────

/**
 * Centralised typed state store with Observer pattern.
 *
 * @example
 * ```ts
 * import { store } from "./store/index.js";
 *
 * // Read state
 * const { volume } = store.get("settings");
 *
 * // Write state
 * store.set("settings", { volume: 0.5 });
 *
 * // Subscribe
 * const unsub = store.subscribe("session", (s) => console.log(s.phase));
 *
 * // Batch multiple mutations into a single notification round
 * store.batch(() => {
 *   store.set("settings", { showFPS: true });
 *   store.set("library",  { sortMode: "name" });
 * });
 * ```
 */
export class RetroOasisStore {
  private readonly state: StoreSlices;
  private readonly listeners: {
    [K in SliceKey]: Map<SubscriptionToken, Listener<K>>;
  };
  private _batchDepth = 0;
  private _dirtySlices = new Set<SliceKey>();

  constructor(initial?: { [K in keyof StoreSlices]?: Partial<StoreSlices[K]> }) {
    this.state = {
      settings:  { ...defaultSettings(),  ...(initial?.settings  ?? {}) },
      library:   { ...defaultLibrary(),   ...(initial?.library   ?? {}) },
      session:   { ...defaultSession(),   ...(initial?.session   ?? {}) },
      cloudSync: { ...defaultCloudSync(), ...(initial?.cloudSync ?? {}) },
      netplay:   { ...defaultNetplay(),   ...(initial?.netplay   ?? {}) },
    };
    this.listeners = {
      settings:  new Map(),
      library:   new Map(),
      session:   new Map(),
      cloudSync: new Map(),
      netplay:   new Map(),
    };
  }

  /**
   * Return a snapshot of a slice. The returned object is a shallow clone;
   * callers must not mutate it.
   */
  get<K extends SliceKey>(key: K): StoreSlices[K] {
    return { ...this.state[key] } as StoreSlices[K];
  }

  /**
   * Merge `patch` into slice `key` and notify subscribers.
   * Inside a `batch()` call, notifications are deferred until the batch ends.
   */
  set<K extends SliceKey>(key: K, patch: Partial<StoreSlices[K]>): void {
    Object.assign(this.state[key], patch);
    if (this._batchDepth > 0) {
      this._dirtySlices.add(key);
    } else {
      this._notify(key);
    }
  }

  /**
   * Subscribe to changes on `key`.  `callback` is called synchronously
   * after each mutation (or once per batch).
   *
   * @returns An unsubscribe function.
   */
  subscribe<K extends SliceKey>(key: K, callback: Listener<K>): () => void {
    const token: SubscriptionToken = Symbol();
    (this.listeners[key] as Map<SubscriptionToken, Listener<K>>).set(token, callback);
    return () => {
      (this.listeners[key] as Map<SubscriptionToken, Listener<K>>).delete(token);
    };
  }

  /**
   * Unsubscribe using the token returned by subscribe.
   * Prefer calling the unsubscribe function returned by `subscribe` directly.
   */
  unsubscribe<K extends SliceKey>(key: K, token: SubscriptionToken): void {
    (this.listeners[key] as Map<SubscriptionToken, Listener<SliceKey>>).delete(token);
  }

  /**
   * Run `fn` synchronously, deferring all subscriber notifications until
   * after `fn` returns.  Each dirty slice notifies exactly once.
   *
   * Batches can be nested; notifications only fire when the outermost batch
   * completes.
   */
  batch(fn: () => void): void {
    this._batchDepth++;
    try {
      fn();
    } finally {
      this._batchDepth--;
      if (this._batchDepth === 0) {
        const dirty = [...this._dirtySlices];
        this._dirtySlices.clear();
        for (const key of dirty) {
          this._notify(key);
        }
      }
    }
  }

  /** Return the number of active subscribers for a slice (useful for tests). */
  subscriberCount(key: SliceKey): number {
    return this.listeners[key].size;
  }

  private _notify<K extends SliceKey>(key: K): void {
    const snapshot = this.get(key);
    for (const cb of this.listeners[key].values()) {
      try {
        (cb as Listener<K>)(snapshot);
      } catch {
        // Listener errors must not break sibling listeners.
      }
    }
  }
}

// ── Module-level singleton ─────────────────────────────────────────────────

/** Application-wide store singleton. */
export const store = new RetroOasisStore();
