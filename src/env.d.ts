/// <reference types="vite/client" />

import type { PSPEmulator } from "./emulator.js";
import type { GameLibrary } from "./library.js";
import type { Settings } from "./main.js";
import type { DeviceCapabilities } from "./performance.js";

declare global {
  interface Window {
    __onLaunchGame?: (file: File, systemId: string) => Promise<void>;
    __retrovault?: {
      emulator: PSPEmulator;
      library: GameLibrary;
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
