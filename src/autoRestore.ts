/**
 * autoRestore.ts — one-shot auto-save restore wiring
 *
 * Encapsulates listener lifecycle so callers can safely cancel pending
 * restore handlers when launches fail or are superseded.
 */

export interface SaveStateRestorer {
  writeStateData(slot: number, data: Uint8Array): boolean;
  quickLoad(slot: number): void;
}

export interface AutoRestoreRegistration {
  cancel(): void;
}

export interface AutoRestoreOptions {
  emulator: SaveStateRestorer;
  stateBytes: Uint8Array;
  slot: number;
  delayMs?: number;
  eventTarget?: Pick<Document, "addEventListener" | "removeEventListener">;
  onConsumed?: () => void;
}

/**
 * Register a one-shot restore handler that runs when the game-start event fires.
 *
 * Returns a cancel function so callers can cleanly tear down the pending handler
 * if launch fails or if a new launch supersedes the pending restore.
 */
export function scheduleAutoRestoreOnGameStart(opts: AutoRestoreOptions): AutoRestoreRegistration {
  const {
    emulator,
    stateBytes,
    slot,
    delayMs = 500,
    eventTarget = document,
    onConsumed,
  } = opts;

  let active = true;
  const eventName = "retrovault:gameStarted";

  const onGameStart = () => {
    if (!active) return;
    active = false;
    eventTarget.removeEventListener(eventName, onGameStart);
    onConsumed?.();

    // Give the core a short window to render its first frame before loading.
    setTimeout(() => {
      if (emulator.writeStateData(slot, stateBytes)) {
        emulator.quickLoad(slot);
      }
    }, delayMs);
  };

  eventTarget.addEventListener(eventName, onGameStart);

  return {
    cancel(): void {
      if (!active) return;
      active = false;
      eventTarget.removeEventListener(eventName, onGameStart);
    },
  };
}
