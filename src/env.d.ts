/// <reference types="vite/client" />

import type { PSPEmulator } from "./emulator.js";
import type { GameLibrary } from "./library.js";
import type { BiosLibrary } from "./bios.js";
import type { SaveStateLibrary } from "./saves.js";
import type { Settings } from "./main.js";
import type { DeviceCapabilities } from "./performance.js";

declare global {
  interface Window {
    __retrovault?: {
      emulator: PSPEmulator;
      library: GameLibrary;
      biosLibrary: BiosLibrary;
      saveLibrary: SaveStateLibrary;
      settings: Settings;
      deviceCaps: DeviceCapabilities;
    };

    requestIdleCallback?: (
      callback: IdleRequestCallback,
      options?: IdleRequestOptions,
    ) => number;

    /** WebSocket URL of the EmulatorJS netplay signalling server. */
    EJS_netplayServer?: string;
    /** ICE servers (STUN/TURN) forwarded to WebRTC peer connections. */
    EJS_netplayICEServers?: RTCIceServer[];
    /** Numeric game identifier used by the netplay server for room scoping. */
    EJS_gameID?: number;
    /** Player display name shown to other participants in a netplay room. */
    EJS_playerName?: string;
  }
}

interface IdleDeadline {
  readonly didTimeout: boolean;
  timeRemaining(): number;
}

type IdleRequestCallback = (deadline: IdleDeadline) => void;

interface IdleRequestOptions {
  timeout?: number;
}

export {};
