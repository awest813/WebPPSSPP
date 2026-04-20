/**
 * apiKeyStore.ts — bring-your-own-API-key storage for cover-art and metadata
 * providers.
 *
 * Keys are stored locally (browser localStorage by default) under a single
 * namespaced JSON blob. They are never uploaded by RetroOasis — they are sent
 * directly from the browser to the configured third-party API (RAWG,
 * MobyGames, etc.) when those providers run.
 *
 * The store is deliberately small and framework-free so it can be imported
 * from both the cover-art layer and the settings UI without pulling in extra
 * dependencies.
 */

/**
 * Metadata describing one provider that supports a bring-your-own API key.
 * The Settings UI uses this to render a "Get an API key" link and a
 * descriptive label for each row.
 */
export interface ApiKeyProviderConfig {
  /** Stable identifier used as the persistence key, e.g. `"rawg"`. */
  readonly id: string;
  /** Human-readable name shown in Settings, e.g. `"RAWG"`. */
  readonly name: string;
  /** One-sentence description of what this provider offers. */
  readonly description: string;
  /** URL the user visits to create an account and obtain a free API key. */
  readonly signupUrl: string;
  /**
   * Shape-validation for a trimmed key string. Return `true` for an
   * acceptable key; any string value is treated as an error message.
   * Must not make network calls — this is a local sanity check only.
   */
  validate(key: string): true | string;
}

/** Persisted per-provider state. */
export interface ApiKeyState {
  /** The API key. Empty string means "no key stored". */
  key: string;
  /** User toggle — false keeps the key but skips the provider in the chain. */
  enabled: boolean;
}

/** Event emitted whenever the store's contents change. */
export interface ApiKeyChangeEvent {
  providerId?: string;
  kind: "key" | "enabled" | "order" | "reset";
}

const DEFAULT_NAMESPACE = "retrovault.apiKeys";
const URL_LIKE_RE = /^https?:\/\//i;

/** Heuristics for detecting obviously-wrong pasted values. */
export function looksLikePlaceholderOrUrl(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (URL_LIKE_RE.test(s)) return true;
  if (/your[_ -]?api[_ -]?key/i.test(s)) return true;
  if (/<[^>]+>/.test(s)) return true; // `<your-key>` style placeholders
  return false;
}

/**
 * Mask a key for display, keeping the first and last 4 characters so the user
 * can visually confirm which key is stored without exposing it in the DOM.
 */
export function redactKey(key: string): string {
  const s = (key ?? "").trim();
  if (!s) return "";
  if (s.length <= 8) return "•".repeat(s.length);
  return `${s.slice(0, 4)}${"•".repeat(Math.max(4, s.length - 8))}${s.slice(-4)}`;
}

interface PersistedShape {
  version: 1;
  providers: Record<string, ApiKeyState>;
  order: string[];
}

function defaultState(): PersistedShape {
  return { version: 1, providers: {}, order: [] };
}

/**
 * Bring-your-own API key store.
 *
 * Instances are cheap to construct; multiple instances sharing the same
 * `namespace` and `storage` observe each other via the Web Storage API's
 * cross-tab `storage` event (when available). In-process changes are
 * dispatched synchronously via {@link ApiKeyStore.subscribe}.
 */
export class ApiKeyStore {
  private readonly storage: Storage;
  private readonly namespace: string;
  private readonly providers = new Map<string, ApiKeyProviderConfig>();
  private readonly listeners = new Set<(ev: ApiKeyChangeEvent) => void>();
  private state: PersistedShape;

  constructor(opts: { storage?: Storage; namespace?: string; providers?: readonly ApiKeyProviderConfig[] } = {}) {
    this.storage = opts.storage ?? getDefaultStorage();
    this.namespace = opts.namespace ?? DEFAULT_NAMESPACE;
    this.state = this.loadFromStorage();
    for (const p of opts.providers ?? []) this.registerProvider(p);
  }

  /** Register a provider. Idempotent; the latest config wins. */
  registerProvider(config: ApiKeyProviderConfig): void {
    this.providers.set(config.id, config);
    if (!this.state.providers[config.id]) {
      this.state.providers[config.id] = { key: "", enabled: true };
    }
  }

  /** List all registered providers in declaration order. */
  listProviders(): ApiKeyProviderConfig[] {
    return [...this.providers.values()];
  }

  /** Get the raw key for a provider, or `""` if unset. */
  getKey(providerId: string): string {
    return this.state.providers[providerId]?.key ?? "";
  }

  /** Get current state for a provider (always defined for registered ids). */
  getState(providerId: string): ApiKeyState {
    return this.state.providers[providerId] ?? { key: "", enabled: true };
  }

  /**
   * Save a key after validation. Returns `true` on success or an error
   * message on validation failure.
   */
  setKey(providerId: string, key: string): true | string {
    const trimmed = (key ?? "").trim();
    if (!trimmed) return "Key is required.";
    const cfg = this.providers.get(providerId);
    if (cfg) {
      const result = cfg.validate(trimmed);
      if (result !== true) return result;
    }
    const prev = this.state.providers[providerId] ?? { key: "", enabled: true };
    this.state.providers[providerId] = { ...prev, key: trimmed };
    this.persist();
    this.emit({ providerId, kind: "key" });
    return true;
  }

  /** Remove a stored key (leaves the enabled flag intact). */
  removeKey(providerId: string): void {
    const prev = this.state.providers[providerId];
    if (!prev || prev.key === "") return;
    this.state.providers[providerId] = { ...prev, key: "" };
    this.persist();
    this.emit({ providerId, kind: "key" });
  }

  /** Toggle whether a provider contributes to the chain. */
  setEnabled(providerId: string, enabled: boolean): void {
    const prev = this.state.providers[providerId] ?? { key: "", enabled: true };
    if (prev.enabled === enabled) return;
    this.state.providers[providerId] = { ...prev, enabled };
    this.persist();
    this.emit({ providerId, kind: "enabled" });
  }

  /** Ordered provider ids; unknown ids are filtered out. */
  getOrder(): string[] {
    const known = new Set(this.providers.keys());
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of this.state.order) {
      if (known.has(id) && !seen.has(id)) { seen.add(id); out.push(id); }
    }
    for (const id of this.providers.keys()) {
      if (!seen.has(id)) { seen.add(id); out.push(id); }
    }
    return out;
  }

  /** Replace the provider ordering. Unknown ids are dropped silently. */
  setOrder(order: readonly string[]): void {
    const known = new Set(this.providers.keys());
    const next: string[] = [];
    const seen = new Set<string>();
    for (const id of order) {
      if (known.has(id) && !seen.has(id)) { seen.add(id); next.push(id); }
    }
    this.state.order = next;
    this.persist();
    this.emit({ kind: "order" });
  }

  /** Clear provider ordering (does not clear keys). */
  resetOrder(): void {
    if (this.state.order.length === 0) return;
    this.state.order = [];
    this.persist();
    this.emit({ kind: "reset" });
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: (ev: ApiKeyChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private loadFromStorage(): PersistedShape {
    try {
      const raw = this.storage.getItem(this.namespace);
      if (!raw) return defaultState();
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return defaultState();
      const rec = parsed as Record<string, unknown>;
      const out = defaultState();
      const providers = rec.providers;
      if (providers && typeof providers === "object") {
        for (const [id, v] of Object.entries(providers as Record<string, unknown>)) {
          if (!v || typeof v !== "object") continue;
          const entry = v as Record<string, unknown>;
          const key = typeof entry.key === "string" ? entry.key : "";
          const enabled = typeof entry.enabled === "boolean" ? entry.enabled : true;
          out.providers[id] = { key, enabled };
        }
      }
      const order = rec.order;
      if (Array.isArray(order)) {
        out.order = order.filter((x): x is string => typeof x === "string");
      }
      return out;
    } catch {
      // Corrupt JSON or unavailable storage — start fresh without throwing.
      return defaultState();
    }
  }

  private persist(): void {
    try {
      this.storage.setItem(this.namespace, JSON.stringify(this.state));
    } catch {
      // Quota / privacy-mode — nothing we can do, drop silently.
    }
  }

  private emit(ev: ApiKeyChangeEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(ev); } catch { /* listener errors must not break siblings */ }
    }
  }
}

/**
 * Return a working `Storage` object, preferring `window.localStorage` when
 * available. Falls back to an in-memory stub so the store is usable in
 * environments (SSR, tests) where `localStorage` is unavailable or throws.
 */
function getDefaultStorage(): Storage {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      // Touch the API to surface SecurityError (e.g. some privacy modes).
      const probeKey = "__retrovault_probe__";
      window.localStorage.setItem(probeKey, "1");
      window.localStorage.removeItem(probeKey);
      return window.localStorage;
    }
  } catch { /* fall through to the in-memory stub */ }
  const memory = new Map<string, string>();
  return {
    getItem(key) { return memory.get(key) ?? null; },
    setItem(key, value) { memory.set(key, String(value)); },
    removeItem(key) { memory.delete(key); },
    clear() { memory.clear(); },
    get length() { return memory.size; },
    key(index) { return [...memory.keys()][index] ?? null; },
  } satisfies Storage;
}

// ── Default provider configs ────────────────────────────────────────────────

/**
 * Validator: trims whitespace and requires a plausible hex / alnum token.
 * RAWG keys are 32-character lowercase hex; MobyGames keys are ~28 chars of
 * alnum + some punctuation. We keep the check loose — users should be able
 * to paste new formats without a client-side update.
 */
function genericKeyValidator(minLen: number, label: string) {
  return (key: string): true | string => {
    const s = key.trim();
    if (s.length < minLen) return `${label} key looks too short (expected at least ${minLen} characters).`;
    if (looksLikePlaceholderOrUrl(s)) return `${label} key looks like a placeholder or URL, not an API key.`;
    if (!/^[A-Za-z0-9._~+\-/]+$/.test(s)) return `${label} key contains characters that aren't expected in an API key.`;
    return true;
  };
}

/** Default set of bring-your-own-key provider configs shipped with the app. */
export const DEFAULT_API_KEY_PROVIDERS: readonly ApiKeyProviderConfig[] = Object.freeze([
  {
    id: "rawg",
    name: "RAWG",
    description: "Free video game database. Covers, screenshots, and basic metadata. Free tier: 20,000 requests per month.",
    signupUrl: "https://rawg.io/apidocs",
    validate: genericKeyValidator(16, "RAWG"),
  },
  {
    id: "mobygames",
    name: "MobyGames",
    description: "Long-running games database with box art and platform-accurate covers. Free personal-use API key available on request.",
    signupUrl: "https://www.mobygames.com/info/api/",
    validate: genericKeyValidator(16, "MobyGames"),
  },
  {
    id: "thegamesdb",
    name: "TheGamesDB",
    description: "Community-driven open games database. Front/back boxart, screenshots, and metadata. Personal-use API keys are free.",
    signupUrl: "https://thegamesdb.net/",
    validate: genericKeyValidator(16, "TheGamesDB"),
  },
]);
