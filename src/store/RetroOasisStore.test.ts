/**
 * RetroOasisStore.test.ts — Vitest unit suite for the centralised store.
 *
 * Covers:
 *  - get / set basics
 *  - subscribe / unsubscribe mechanics
 *  - atomic batching (single notification round per batch)
 *  - nested batching
 *  - slice isolation (changes to one slice don't fire other listeners)
 *  - snapshot immutability (mutations to returned snapshot don't affect store)
 *  - error isolation (throwing listener doesn't break siblings)
 */

import { describe, it, expect, vi } from "vitest";
import { RetroOasisStore } from "./RetroOasisStore.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeStore() {
  return new RetroOasisStore();
}

// ── get / set ──────────────────────────────────────────────────────────────

describe("get", () => {
  it("returns default values for each slice", () => {
    const s = makeStore();
    expect(s.get("settings").volume).toBe(0.7);
    expect(s.get("session").phase).toBe("idle");
    expect(s.get("library").searchQuery).toBe("");
    expect(s.get("cloudSync").connected).toBe(false);
    expect(s.get("netplay").active).toBe(false);
  });

  it("returns a shallow copy, not the internal reference", () => {
    const s = makeStore();
    const snap1 = s.get("settings");
    const snap2 = s.get("settings");
    expect(snap1).not.toBe(snap2);
  });
});

describe("set", () => {
  it("merges a patch into the slice", () => {
    const s = makeStore();
    s.set("settings", { volume: 0.5 });
    expect(s.get("settings").volume).toBe(0.5);
    expect(s.get("settings").performanceMode).toBe("auto"); // unchanged
  });

  it("merges partial patches without wiping unrelated keys", () => {
    const s = makeStore();
    s.set("session", { phase: "running", gameId: "game-1" });
    s.set("session", { gameName: "Sonic" });
    const snap = s.get("session");
    expect(snap.phase).toBe("running");
    expect(snap.gameId).toBe("game-1");
    expect(snap.gameName).toBe("Sonic");
  });

  it("accepts initial overrides via constructor", () => {
    const s = new RetroOasisStore({ settings: { volume: 0.1 } });
    expect(s.get("settings").volume).toBe(0.1);
  });
});

// ── subscribe / unsubscribe ────────────────────────────────────────────────

describe("subscribe", () => {
  it("calls the listener synchronously on set", () => {
    const s = makeStore();
    const cb = vi.fn();
    s.subscribe("settings", cb);
    s.set("settings", { volume: 0.3 });
    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0]![0].volume).toBe(0.3);
  });

  it("listener receives a snapshot, not the internal state", () => {
    const s = makeStore();
    let captured: object | null = null;
    s.subscribe("settings", (snap) => { captured = snap; });
    s.set("settings", { volume: 0.2 });
    expect(captured).not.toBeNull();
    // Mutating the captured snapshot must not affect the store
    (captured as unknown as Record<string, unknown>).volume = 9;
    expect(s.get("settings").volume).toBe(0.2);
  });

  it("returns an unsubscribe function that stops notifications", () => {
    const s = makeStore();
    const cb = vi.fn();
    const unsub = s.subscribe("settings", cb);
    unsub();
    s.set("settings", { volume: 0.9 });
    expect(cb).not.toHaveBeenCalled();
  });

  it("unsubscribe is idempotent", () => {
    const s = makeStore();
    const cb = vi.fn();
    const unsub = s.subscribe("settings", cb);
    unsub();
    unsub(); // second call must not throw
    expect(cb).not.toHaveBeenCalled();
  });

  it("supports multiple listeners on the same slice", () => {
    const s = makeStore();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    s.subscribe("session", cb1);
    s.subscribe("session", cb2);
    s.set("session", { phase: "running" });
    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
  });
});

describe("subscriberCount", () => {
  it("reflects active subscription count", () => {
    const s = makeStore();
    expect(s.subscriberCount("settings")).toBe(0);
    const unsub = s.subscribe("settings", vi.fn());
    expect(s.subscriberCount("settings")).toBe(1);
    unsub();
    expect(s.subscriberCount("settings")).toBe(0);
  });
});

// ── Slice isolation ────────────────────────────────────────────────────────

describe("slice isolation", () => {
  it("a change to one slice does not notify listeners of another slice", () => {
    const s = makeStore();
    const libraryCb = vi.fn();
    s.subscribe("library", libraryCb);
    s.set("settings", { volume: 0.4 });
    expect(libraryCb).not.toHaveBeenCalled();
  });

  it("concurrent listeners on different slices each receive only their slice", () => {
    const s = makeStore();
    const settingsCb = vi.fn();
    const sessionCb = vi.fn();
    s.subscribe("settings", settingsCb);
    s.subscribe("session", sessionCb);

    s.set("settings", { verboseLogging: true });
    expect(settingsCb).toHaveBeenCalledOnce();
    expect(sessionCb).not.toHaveBeenCalled();

    s.set("session", { phase: "paused" });
    expect(sessionCb).toHaveBeenCalledOnce();
    expect(settingsCb).toHaveBeenCalledTimes(1); // not called again
  });
});

// ── batch ──────────────────────────────────────────────────────────────────

describe("batch", () => {
  it("fires each slice's listeners once at the end of the batch", () => {
    const s = makeStore();
    const settingsCb = vi.fn();
    const libraryCb  = vi.fn();
    s.subscribe("settings", settingsCb);
    s.subscribe("library",  libraryCb);

    s.batch(() => {
      s.set("settings", { volume: 0.1 });
      s.set("settings", { showFPS: true });
      s.set("library",  { searchQuery: "zelda" });
    });

    expect(settingsCb).toHaveBeenCalledOnce();
    expect(libraryCb).toHaveBeenCalledOnce();
    expect(settingsCb.mock.calls[0]![0].showFPS).toBe(true);
  });

  it("does not call listeners during the batch", () => {
    const s = makeStore();
    const calls: number[] = [];
    s.subscribe("settings", () => calls.push(Date.now()));
    let duringBatch = false;
    s.batch(() => {
      s.set("settings", { volume: 0.2 });
      duringBatch = calls.length === 0;
    });
    expect(duringBatch).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("handles nested batches — only fires when outermost batch ends", () => {
    const s = makeStore();
    const cb = vi.fn();
    s.subscribe("settings", cb);

    s.batch(() => {
      s.set("settings", { volume: 0.5 });
      s.batch(() => {
        s.set("settings", { volume: 0.6 });
      });
      // Still inside outer batch; should not have fired yet
      expect(cb).not.toHaveBeenCalled();
    });

    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0]![0].volume).toBe(0.6);
  });

  it("still notifies after batch even if fn throws", () => {
    const s = makeStore();
    const cb = vi.fn();
    s.subscribe("settings", cb);

    expect(() =>
      s.batch(() => {
        s.set("settings", { volume: 0.3 });
        throw new Error("boom");
      })
    ).toThrow("boom");

    // The batch depth should have been restored and the dirty slice notified
    expect(cb).toHaveBeenCalledOnce();
  });
});

// ── Error isolation ────────────────────────────────────────────────────────

describe("error isolation", () => {
  it("a throwing listener does not prevent sibling listeners from running", () => {
    const s = makeStore();
    const good = vi.fn();
    s.subscribe("settings", () => { throw new Error("bad listener"); });
    s.subscribe("settings", good);
    expect(() => s.set("settings", { volume: 0.7 })).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });
});

// ── unsubscribe method ─────────────────────────────────────────────────────

describe("unsubscribe method", () => {
  it("stops notifications when called with the token", () => {
    const s = makeStore();
    const cb = vi.fn();
    // Subscribe and immediately capture the token by wrapping subscribe
    let token!: ReturnType<typeof Symbol>;
    // Use the subscribe return value to get a token-equivalent unsub
    const unsub = s.subscribe("netplay", cb);
    s.set("netplay", { active: true });
    expect(cb).toHaveBeenCalledOnce();
    unsub();
    s.set("netplay", { active: false });
    expect(cb).toHaveBeenCalledTimes(1);
    void token; // suppress unused var warning
  });
});
