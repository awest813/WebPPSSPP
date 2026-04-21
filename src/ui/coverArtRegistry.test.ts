import { describe, it, expect, beforeEach } from "vitest";
import {
  getApiKeyStore,
  getKeyedProviders,
  getCoverArtProvider,
  rebuildCoverArtProvider,
  _resetCoverArtRegistryForTests,
} from "./coverArtRegistry.js";

describe("coverArtRegistry", () => {
  beforeEach(() => {
    _resetCoverArtRegistryForTests();
    // Registry persists keys in localStorage via ApiKeyStore; wipe between
    // tests so enable/disable state doesn't leak.
    try { localStorage.clear(); } catch { /* jsdom safety */ }
  });

  it("returns the same ApiKeyStore instance on repeated calls", () => {
    const a = getApiKeyStore();
    const b = getApiKeyStore();
    expect(a).toBe(b);
  });

  it("registers rawg, mobygames, and thegamesdb keyed providers", () => {
    const providers = getKeyedProviders();
    expect(providers.has("rawg")).toBe(true);
    expect(providers.has("mobygames")).toBe(true);
    expect(providers.has("thegamesdb")).toBe(true);
  });

  it("builds a composed CoverArtProvider", () => {
    const provider = getCoverArtProvider();
    expect(provider).toBeDefined();
    // ChainedCoverArtProvider exposes .search via the interface.
    expect(typeof provider.search).toBe("function");
    expect(typeof provider.id).toBe("string");
  });

  it("returns the same provider instance until rebuildCoverArtProvider is called", () => {
    const a = getCoverArtProvider();
    const b = getCoverArtProvider();
    expect(a).toBe(b);
    rebuildCoverArtProvider();
    const c = getCoverArtProvider();
    expect(c).not.toBe(a);
  });

  it("rebuilds the provider chain when the key store changes", () => {
    const before = getCoverArtProvider();
    const store = getApiKeyStore();
    // Toggling enabled state notifies subscribers, which should trigger a rebuild.
    const currentOrder = store.getOrder();
    if (currentOrder.length > 0) {
      const first = currentOrder[0]!;
      const wasEnabled = store.getState(first).enabled;
      store.setEnabled(first, !wasEnabled);
      const after = getCoverArtProvider();
      expect(after).not.toBe(before);
      // Restore so localStorage state is clean for other tests.
      store.setEnabled(first, wasEnabled);
    }
  });

  it("_resetCoverArtRegistryForTests fully discards the cached singletons", () => {
    const storeA = getApiKeyStore();
    _resetCoverArtRegistryForTests();
    const storeB = getApiKeyStore();
    expect(storeB).not.toBe(storeA);
  });
});
