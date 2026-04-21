/**
 * coverArtRegistry.ts — Process-wide cover-art provider registry.
 *
 * Owns the lazy singletons that were historically initialised at the top of
 * `ui.ts`:
 *
 *   - A shared {@link ApiKeyStore} seeded with {@link DEFAULT_API_KEY_PROVIDERS}.
 *   - A map of keyed cover-art providers (`rawg`, `mobygames`, `thegamesdb`).
 *   - The composed {@link ChainedCoverArtProvider} used by the UI, which
 *     always starts with the free Libretro + GitHub sources and appends the
 *     user-ordered, enabled keyed providers.
 *
 * Centralising the registry keeps `ui.ts` free of bootstrap state and lets
 * any future settings UI import the same singletons without pulling the
 * full UI module.
 *
 * The registry subscribes to the {@link ApiKeyStore} so changes made from
 * the Settings → API Keys tab (key edits, enable/disable toggles, reorder)
 * automatically rebuild the provider chain.
 */

import {
  ChainedCoverArtProvider,
  GitHubCoverArtProvider,
  LibretroCoverArtProvider,
  MobyGamesCoverArtProvider,
  RawgCoverArtProvider,
  TheGamesDBCoverArtProvider,
  type ApiKeyedProvider,
  type CoverArtProvider,
} from "../coverArt.js";
import { ApiKeyStore, DEFAULT_API_KEY_PROVIDERS } from "../apiKeyStore.js";

let _apiKeyStore:   ApiKeyStore | null = null;
let _keyedProviders: Map<string, ApiKeyedProvider> | null = null;
let _coverArtProvider: CoverArtProvider | null = null;
let _subscribed = false;

/** Single shared store for bring-your-own API keys (RAWG, MobyGames, …). */
export function getApiKeyStore(): ApiKeyStore {
  if (!_apiKeyStore) {
    _apiKeyStore = new ApiKeyStore({ providers: DEFAULT_API_KEY_PROVIDERS });
  }
  return _apiKeyStore;
}

/** Registry of keyed providers, keyed by provider id. */
export function getKeyedProviders(): Map<string, ApiKeyedProvider> {
  if (!_keyedProviders) {
    const store = getApiKeyStore();
    _keyedProviders = new Map();
    _keyedProviders.set("rawg",       new RawgCoverArtProvider({       getApiKey: () => store.getKey("rawg") }));
    _keyedProviders.set("mobygames",  new MobyGamesCoverArtProvider({  getApiKey: () => store.getKey("mobygames") }));
    _keyedProviders.set("thegamesdb", new TheGamesDBCoverArtProvider({ getApiKey: () => store.getKey("thegamesdb") }));
  }
  return _keyedProviders;
}

/**
 * Rebuild the chained cover-art provider from the current key-store state.
 * Free sources (Libretro, GitHub) always run first, then keyed providers in
 * the order set by the user, skipping any that are disabled.
 */
export function rebuildCoverArtProvider(): void {
  const store  = getApiKeyStore();
  const keyed  = getKeyedProviders();
  const ordered: ApiKeyedProvider[] = [];
  for (const id of store.getOrder()) {
    const p = keyed.get(id);
    if (!p) continue;
    if (!store.getState(id).enabled) continue;
    ordered.push(p);
  }
  _coverArtProvider = new ChainedCoverArtProvider([
    new LibretroCoverArtProvider(),
    new GitHubCoverArtProvider(),
    ...ordered,
  ]);
}

/** Return the lazily-built composed cover-art provider. */
export function getCoverArtProvider(): CoverArtProvider {
  if (!_coverArtProvider) rebuildCoverArtProvider();
  // Attach the rebuild subscription exactly once, on first consumer access,
  // so tests that swap the `ApiKeyStore` can initialise the chain without
  // leaking subscribers across test files.
  if (!_subscribed) {
    _subscribed = true;
    getApiKeyStore().subscribe(() => { rebuildCoverArtProvider(); });
  }
  return _coverArtProvider!;
}

/**
 * Reset the registry — intended for tests only.  After calling, the next
 * getter invocation re-creates the store, provider map, and chain.
 */
export function _resetCoverArtRegistryForTests(): void {
  _apiKeyStore        = null;
  _keyedProviders     = null;
  _coverArtProvider   = null;
  _subscribed         = false;
}
