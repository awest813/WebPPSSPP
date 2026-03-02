/// <reference types="vite/client" />

import type { PSPEmulator } from "./emulator.js";
import type { GameLibrary } from "./library.js";
import type { BiosLibrary } from "./bios.js";
import type { Settings } from "./main.js";
import type { DeviceCapabilities } from "./performance.js";

declare global {
  interface Window {
    __retrovault?: {
      emulator: PSPEmulator;
      library: GameLibrary;
      biosLibrary: BiosLibrary;
      settings: Settings;
      deviceCaps: DeviceCapabilities;
    };

    requestIdleCallback?: (
      callback: IdleRequestCallback,
      options?: IdleRequestOptions,
    ) => number;
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
