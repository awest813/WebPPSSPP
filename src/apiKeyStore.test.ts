import { describe, it, expect, beforeEach } from "vitest";
import {
  ApiKeyStore,
  redactKey,
  looksLikePlaceholderOrUrl,
  DEFAULT_API_KEY_PROVIDERS,
  type ApiKeyChangeEvent,
  type ApiKeyProviderConfig,
} from "./apiKeyStore.js";

function makeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
  };
}

const rawgCfg: ApiKeyProviderConfig = {
  id: "rawg",
  name: "RAWG",
  description: "test",
  signupUrl: "https://example.com/",
  validate: (k) => (k.length >= 16 ? true : "too short"),
};
const mobyCfg: ApiKeyProviderConfig = {
  id: "mobygames",
  name: "MobyGames",
  description: "test",
  signupUrl: "https://example.com/",
  validate: (k) => (k.length >= 16 ? true : "too short"),
};

describe("redactKey", () => {
  it("returns empty for empty input", () => {
    expect(redactKey("")).toBe("");
    expect(redactKey("   ")).toBe("");
  });
  it("fully masks short keys", () => {
    expect(redactKey("abc")).toBe("•••");
    expect(redactKey("12345678")).toBe("••••••••");
  });
  it("keeps first/last 4 for longer keys", () => {
    expect(redactKey("abcdefghijklmnop")).toBe("abcd••••••••mnop");
  });
});

describe("looksLikePlaceholderOrUrl", () => {
  it("flags http/https URLs", () => {
    expect(looksLikePlaceholderOrUrl("https://rawg.io/apidocs")).toBe(true);
  });
  it("flags <placeholder> strings", () => {
    expect(looksLikePlaceholderOrUrl("<your-key>")).toBe(true);
    expect(looksLikePlaceholderOrUrl("your_api_key")).toBe(true);
  });
  it("accepts plausible keys", () => {
    expect(looksLikePlaceholderOrUrl("0123456789abcdef0123456789abcdef")).toBe(false);
  });
});

describe("ApiKeyStore", () => {
  let storage: Storage;
  let store: ApiKeyStore;

  beforeEach(() => {
    storage = makeStorage();
    store = new ApiKeyStore({ storage, providers: [rawgCfg, mobyCfg] });
  });

  it("round-trips a key via storage", () => {
    expect(store.setKey("rawg", "0123456789abcdef0123456789abcdef")).toBe(true);
    const other = new ApiKeyStore({ storage, providers: [rawgCfg, mobyCfg] });
    expect(other.getKey("rawg")).toBe("0123456789abcdef0123456789abcdef");
  });

  it("rejects invalid keys with validator message", () => {
    expect(store.setKey("rawg", "short")).toBe("too short");
    expect(store.getKey("rawg")).toBe("");
  });

  it("rejects empty keys", () => {
    expect(store.setKey("rawg", "   ")).toBe("Key is required.");
  });

  it("trims whitespace before storing", () => {
    expect(store.setKey("rawg", "  0123456789abcdef0123456789abcdef  ")).toBe(true);
    expect(store.getKey("rawg")).toBe("0123456789abcdef0123456789abcdef");
  });

  it("removeKey clears only the key, keeps enabled flag", () => {
    store.setKey("rawg", "0123456789abcdef0123456789abcdef");
    store.setEnabled("rawg", false);
    store.removeKey("rawg");
    expect(store.getKey("rawg")).toBe("");
    expect(store.getState("rawg").enabled).toBe(false);
  });

  it("notifies subscribers on key/enabled/order changes", () => {
    const events: ApiKeyChangeEvent[] = [];
    const unsub = store.subscribe((ev) => events.push(ev));
    store.setKey("rawg", "0123456789abcdef0123456789abcdef");
    store.setEnabled("rawg", false);
    store.setOrder(["mobygames", "rawg"]);
    store.resetOrder();
    unsub();
    store.setKey("mobygames", "0123456789abcdef0123456789abcdef");
    expect(events.map((e) => e.kind)).toEqual(["key", "enabled", "order", "reset"]);
    expect(events[0]!.providerId).toBe("rawg");
  });

  it("getOrder appends unknown / unordered providers at the end", () => {
    store.setOrder(["mobygames"]);
    expect(store.getOrder()).toEqual(["mobygames", "rawg"]);
  });

  it("setOrder filters out unknown ids", () => {
    store.setOrder(["does-not-exist", "rawg"]);
    expect(store.getOrder()).toEqual(["rawg", "mobygames"]);
  });

  it("tolerates corrupt localStorage payloads", () => {
    storage.setItem("retrovault.apiKeys", "not-json");
    const s = new ApiKeyStore({ storage, providers: [rawgCfg] });
    expect(s.getKey("rawg")).toBe("");
    // And a subsequent write must succeed.
    expect(s.setKey("rawg", "0123456789abcdef0123456789abcdef")).toBe(true);
  });

  it("tolerates valid-JSON but unexpected shape", () => {
    storage.setItem("retrovault.apiKeys", JSON.stringify({ providers: "nope", order: 42 }));
    const s = new ApiKeyStore({ storage, providers: [rawgCfg] });
    expect(s.getKey("rawg")).toBe("");
    expect(s.getOrder()).toEqual(["rawg"]);
  });

  it("ships a default registry of providers with signup URLs", () => {
    const ids = DEFAULT_API_KEY_PROVIDERS.map((p) => p.id);
    expect(ids).toContain("rawg");
    expect(ids).toContain("mobygames");
    expect(ids).toContain("thegamesdb");
    for (const p of DEFAULT_API_KEY_PROVIDERS) {
      expect(p.signupUrl).toMatch(/^https:\/\//);
      expect(typeof p.validate).toBe("function");
    }
  });
});
