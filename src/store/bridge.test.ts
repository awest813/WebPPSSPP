/**
 * Unit tests for src/store/bridge.ts — the glue between the `Settings`
 * object in main.ts and the RetroOasisStore.
 */
import { describe, it, expect } from "vitest";
import { RetroOasisStore } from "./RetroOasisStore.js";
import {
  hydrateSettingsIntoStore,
  mirrorSettingsPatchToStore,
  toNetplayIceServers,
  fromNetplayIceServers,
} from "./bridge.js";
import type { SettingsSlice } from "./RetroOasisStore.js";

function fullSettings(partial: Partial<SettingsSlice> = {}): SettingsSlice {
  return {
    volume: 0.42,
    lastGameName: "Chrono Trigger",
    performanceMode: "performance",
    showFPS: true,
    showAudioVis: true,
    useWebGPU: true,
    postProcessEffect: "crt",
    autoSaveEnabled: false,
    touchControls: true,
    touchControlsBySystem: { snes: true },
    hapticFeedback: false,
    touchOpacity: 0.5,
    touchButtonScale: 1.25,
    orientationLock: false,
    netplayEnabled: true,
    netplayServerUrl: "wss://netplay.example/",
    netplayUsername: "player1",
    netplayIceServers: [{ urls: "stun:stun.example:3478" }],
    verboseLogging: true,
    cloudLibraries: [],
    audioFilterType: "lowpass",
    audioFilterCutoff: 8_000,
    uiMode: "lite",
    libraryLayout: "list",
    libraryGrouped: false,
    recordPlayHistory: false,
    coreOptions: { psx_resolution: "2x" },
    ...partial,
  };
}

describe("hydrateSettingsIntoStore", () => {
  it("populates every SettingsSlice key in a single batch notification", () => {
    const store = new RetroOasisStore();
    let notifications = 0;
    store.subscribe("settings", () => { notifications++; });

    hydrateSettingsIntoStore(fullSettings(), store);

    expect(notifications).toBe(1);
    const s = store.get("settings");
    expect(s.volume).toBe(0.42);
    expect(s.postProcessEffect).toBe("crt");
    expect(s.netplayIceServers).toEqual([{ urls: "stun:stun.example:3478" }]);
    expect(s.recordPlayHistory).toBe(false);
    expect(s.coreOptions).toEqual({ psx_resolution: "2x" });
  });

  it("ignores extra fields not present on SettingsSlice", () => {
    const store = new RetroOasisStore();
    hydrateSettingsIntoStore(
      { ...fullSettings(), legacyField: "drop-me" } as unknown as SettingsSlice,
      store,
    );
    const snapshot = store.get("settings") as unknown as Record<string, unknown>;
    expect("legacyField" in snapshot).toBe(false);
  });

  it("applies a partial settings object without resetting untouched keys", () => {
    const store = new RetroOasisStore();
    hydrateSettingsIntoStore(fullSettings({ volume: 0.9 }), store);
    // Now apply a partial patch: only volume.
    hydrateSettingsIntoStore({ volume: 0.1 }, store);
    const s = store.get("settings");
    expect(s.volume).toBe(0.1);
    // Other values remain from the first hydration.
    expect(s.postProcessEffect).toBe("crt");
    expect(s.lastGameName).toBe("Chrono Trigger");
  });
});

describe("mirrorSettingsPatchToStore", () => {
  it("forwards only known keys and returns true when any key was mirrored", () => {
    const store = new RetroOasisStore();
    const notifications: Array<SettingsSlice> = [];
    store.subscribe("settings", (s) => notifications.push(s));

    const result = mirrorSettingsPatchToStore(
      { volume: 0.33, nonExistentKey: "x" } as unknown as SettingsSlice,
      store,
    );
    expect(result).toBe(true);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.volume).toBe(0.33);
  });

  it("returns false and fires no notification when patch contains no known keys", () => {
    const store = new RetroOasisStore();
    const notifications: Array<SettingsSlice> = [];
    store.subscribe("settings", (s) => notifications.push(s));

    const result = mirrorSettingsPatchToStore(
      { foo: 1, bar: 2 } as unknown as SettingsSlice,
      store,
    );
    expect(result).toBe(false);
    expect(notifications).toHaveLength(0);
  });
});

describe("toNetplayIceServers / fromNetplayIceServers", () => {
  it("round-trips a typical ICE server list", () => {
    const input: RTCIceServer[] = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: ["stun:a", "stun:b"] },
      { urls: "turn:turn.example", username: "alice", credential: "s3cret" },
    ];
    const plain = toNetplayIceServers(input);
    const back = fromNetplayIceServers(plain);
    expect(back).toEqual(input);
  });

  it("drops DOM-only fields when converting to the plain shape", () => {
    const domServer = {
      urls: "stun:x",
      username: "u",
      credential: "c",
      credentialType: "password",
      domOnlyField: true,
    } as unknown as RTCIceServer;
    const [converted] = toNetplayIceServers([domServer]);
    expect(converted).toEqual({ urls: "stun:x", username: "u", credential: "c" });
    expect("credentialType" in (converted as unknown as Record<string, unknown>)).toBe(false);
    expect("domOnlyField" in (converted as unknown as Record<string, unknown>)).toBe(false);
  });

  it("omits optional fields when they are absent", () => {
    const [converted] = toNetplayIceServers([{ urls: "stun:y" }]);
    expect(converted).toEqual({ urls: "stun:y" });
    expect("username" in (converted as unknown as Record<string, unknown>)).toBe(false);
    expect("credential" in (converted as unknown as Record<string, unknown>)).toBe(false);
  });
});
