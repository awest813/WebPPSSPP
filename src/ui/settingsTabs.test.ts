import { describe, it, expect, beforeEach } from "vitest";
import { buildApiKeysTab } from "./settingsTabs.js";
import { ApiKeyStore, type ApiKeyProviderConfig } from "../apiKeyStore.js";

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

const cfgs: ApiKeyProviderConfig[] = [
  {
    id: "rawg", name: "RAWG", description: "RAWG desc",
    signupUrl: "https://rawg.io/apidocs",
    validate: (k) => (k.length >= 16 ? true : "too short"),
  },
  {
    id: "mobygames", name: "MobyGames", description: "Moby desc",
    signupUrl: "https://www.mobygames.com/info/api/",
    validate: (k) => (k.length >= 16 ? true : "too short"),
  },
];

function mount(): { container: HTMLElement; store: ApiKeyStore; errors: string[] } {
  document.body.innerHTML = "";
  const container = document.createElement("div");
  document.body.appendChild(container);
  const store = new ApiKeyStore({ storage: makeStorage(), providers: cfgs });
  const errors: string[] = [];
  buildApiKeysTab(container, store, {
    appName: "RetroOasis",
    getTester: (id) => ({
      testConnection: async () => id === "rawg" ? true : "MobyGames rejected the API key.",
    }),
    onError: (m) => errors.push(m),
  });
  return { container, store, errors };
}

describe("buildApiKeysTab", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("renders one row per registered provider", () => {
    const { container } = mount();
    const rows = container.querySelectorAll(".api-key-row");
    expect(rows.length).toBe(2);
    expect(container.querySelector('[data-provider-id="rawg"]')).toBeTruthy();
    expect(container.querySelector('[data-provider-id="mobygames"]')).toBeTruthy();
  });

  it("masks the key input by default and toggles with the Show button", () => {
    const { container } = mount();
    const input = container.querySelector('[data-provider-id="rawg"] .api-key-input') as HTMLInputElement;
    expect(input.type).toBe("password");
    const showBtn = container.querySelector('[data-provider-id="rawg"] .api-key-show-btn') as HTMLButtonElement;
    showBtn.click();
    expect(input.type).toBe("text");
    expect(showBtn.getAttribute("aria-pressed")).toBe("true");
    showBtn.click();
    expect(input.type).toBe("password");
  });

  it("renders a signup link pointing to the provider's URL", () => {
    const { container } = mount();
    const link = container.querySelector('[data-provider-id="rawg"] .api-key-row__signup') as HTMLAnchorElement;
    expect(link.href).toContain("rawg.io");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
  });

  it("starts with status 'No key'", () => {
    const { container } = mount();
    const pill = container.querySelector('[data-provider-id="rawg"] .api-key-status')!;
    expect(pill.textContent).toContain("No key");
  });

  it("Save persists a valid key and updates the status to Active", () => {
    const { container, store } = mount();
    const input = container.querySelector('[data-provider-id="rawg"] .api-key-input') as HTMLInputElement;
    input.value = "0123456789abcdef0123456789abcdef";
    const saveBtn = Array.from(
      container.querySelectorAll('[data-provider-id="rawg"] button'),
    ).find((b) => b.textContent === "Save") as HTMLButtonElement;
    saveBtn.click();
    expect(store.getKey("rawg")).toBe("0123456789abcdef0123456789abcdef");
    const pill = container.querySelector('[data-provider-id="rawg"] .api-key-status')!;
    expect(pill.textContent).toContain("Active");
  });

  it("Save surfaces validator errors through onError without persisting", () => {
    const { container, store, errors } = mount();
    const input = container.querySelector('[data-provider-id="rawg"] .api-key-input') as HTMLInputElement;
    input.value = "short";
    const saveBtn = Array.from(
      container.querySelectorAll('[data-provider-id="rawg"] button'),
    ).find((b) => b.textContent === "Save") as HTMLButtonElement;
    saveBtn.click();
    expect(store.getKey("rawg")).toBe("");
    expect(errors.some((e) => /too short/i.test(e))).toBe(true);
  });

  it("Remove clears a stored key", () => {
    const { container, store } = mount();
    store.setKey("rawg", "0123456789abcdef0123456789abcdef");
    // Force rebuild by emitting a change (setKey already emits)
    const removeBtn = Array.from(
      container.querySelectorAll('[data-provider-id="rawg"] button'),
    ).find((b) => b.textContent === "Remove") as HTMLButtonElement;
    removeBtn.click();
    expect(store.getKey("rawg")).toBe("");
  });

  it("Enabled checkbox reflects and updates the store", () => {
    const { container, store } = mount();
    const checkbox = container.querySelector('[data-provider-id="rawg"] .api-key-enabled__box') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));
    expect(store.getState("rawg").enabled).toBe(false);
  });

  it("Test button reports success for a valid tester and updates status", async () => {
    const { container, store } = mount();
    store.setKey("rawg", "0123456789abcdef0123456789abcdef");
    const testBtn = Array.from(
      container.querySelectorAll('[data-provider-id="rawg"] button'),
    ).find((b) => b.textContent === "Test") as HTMLButtonElement;
    testBtn.click();
    // Wait a microtask for the async resolver.
    await Promise.resolve(); await Promise.resolve();
    const pill = container.querySelector('[data-provider-id="rawg"] .api-key-status')!;
    expect(pill.textContent).toMatch(/Active/);
  });

  it("Test button reports failure for a rejecting tester", async () => {
    const { container, store, errors } = mount();
    store.setKey("mobygames", "0123456789abcdef0123456789abcdef");
    const testBtn = Array.from(
      container.querySelectorAll('[data-provider-id="mobygames"] button'),
    ).find((b) => b.textContent === "Test") as HTMLButtonElement;
    testBtn.click();
    await Promise.resolve(); await Promise.resolve();
    const pill = container.querySelector('[data-provider-id="mobygames"] .api-key-status')!;
    expect(pill.textContent).toMatch(/Invalid/);
    expect(errors.some((e) => /MobyGames/.test(e))).toBe(true);
  });

  it("typing a URL shows a warning hint", () => {
    const { container } = mount();
    const input = container.querySelector('[data-provider-id="rawg"] .api-key-input') as HTMLInputElement;
    const warn = container.querySelector('[data-provider-id="rawg"] .api-key-row__warn') as HTMLElement;
    expect(warn.hidden).toBe(true);
    input.value = "https://rawg.io/apidocs";
    input.dispatchEvent(new Event("input"));
    expect(warn.hidden).toBe(false);
    input.value = "0123456789abcdef0123456789abcdef";
    input.dispatchEvent(new Event("input"));
    expect(warn.hidden).toBe(true);
  });

  it("reorder down button moves a provider and updates store order", () => {
    const { container, store } = mount();
    // Initial order: ["rawg","mobygames"].
    const rawgRow = container.querySelector('[data-provider-id="rawg"]')!;
    const downBtn = Array.from(rawgRow.querySelectorAll("button")).find((b) => b.getAttribute("aria-label")?.includes("Move RAWG down")) as HTMLButtonElement;
    downBtn.click();
    expect(store.getOrder()).toEqual(["mobygames", "rawg"]);
  });

  it("restore-default-order button clears the ordering", () => {
    const { container, store } = mount();
    store.setOrder(["mobygames", "rawg"]);
    const resetBtn = Array.from(container.querySelectorAll(".api-keys-footer button")).find((b) => b.textContent?.includes("Restore default")) as HTMLButtonElement;
    resetBtn.click();
    // Order defaults to registration order.
    expect(store.getOrder()).toEqual(["rawg", "mobygames"]);
  });
});
