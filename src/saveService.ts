import { CloudSaveManager } from "./cloudSave.js";
import {
  AUTO_SAVE_SLOT,
  SaveStateLibrary,
  captureScreenshot,
  createThumbnail,
  defaultSlotLabel,
  saveStateKey,
  stateBytesToBlob,
  verifySaveChecksum,
  type SaveStateEntry,
} from "./saves.js";

export type SaveOperationStatus =
  | "idle"
  | "saving-local"
  | "loading-local"
  | "syncing-cloud"
  | "sync-success"
  | "sync-error"
  | "conflict"
  | "emulator-not-ready"
  | "integrity-warning";

export interface SaveStatusEvent {
  status: SaveOperationStatus;
  gameId: string;
  slot?: number;
  message?: string;
  timestamp: number;
}

export interface SaveRuntimeAdapter {
  state?: "idle" | "loading" | "running" | "paused" | "error";
  readStateData(slot: number): Uint8Array | null;
  writeStateData(slot: number, data: Uint8Array): boolean;
  quickLoad(slot: number): void;
  quickSave(slot: number): void;
  captureScreenshotAsync?(): Promise<Blob | null>;
  playerId?: string;
}

interface SaveGameContext {
  gameId: string;
  gameName: string;
  systemId: string;
}

export interface SaveGameServiceOptions {
  saveLibrary: SaveStateLibrary;
  cloudManager?: CloudSaveManager;
  emulator: SaveRuntimeAdapter;
  getCurrentGameContext: () => SaveGameContext | null;
  readinessRetries?: number;
  readinessRetryDelayMs?: number;
}

export class SaveGameService {
  private readonly saveLibrary: SaveStateLibrary;
  private readonly cloudManager?: CloudSaveManager;
  private readonly emulator: SaveRuntimeAdapter;
  private readonly getCurrentGameContext: () => SaveGameContext | null;
  private readonly readinessRetries: number;
  private readonly readinessRetryDelayMs: number;
  private queue: Promise<void> = Promise.resolve();
  private pendingSaveSlots = new Set<number>();
  private listeners = new Set<(event: SaveStatusEvent) => void>();

  constructor(opts: SaveGameServiceOptions) {
    this.saveLibrary = opts.saveLibrary;
    this.cloudManager = opts.cloudManager;
    this.emulator = opts.emulator;
    this.getCurrentGameContext = opts.getCurrentGameContext;
    this.readinessRetries = opts.readinessRetries ?? 5;
    this.readinessRetryDelayMs = opts.readinessRetryDelayMs ?? 160;
  }

  onStatus(listener: (event: SaveStatusEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: Omit<SaveStatusEvent, "timestamp">): void {
    const withTimestamp: SaveStatusEvent = { ...event, timestamp: Date.now() };
    this.listeners.forEach((listener) => listener(withTimestamp));
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async waitForEmulatorReady(context: SaveGameContext, slot: number): Promise<boolean> {
    for (let attempt = 0; attempt <= this.readinessRetries; attempt++) {
      const state = this.emulator.state;
      if (state === "running" || state === "paused") return true;
      if (attempt < this.readinessRetries) {
        await new Promise((resolve) => setTimeout(resolve, this.readinessRetryDelayMs));
      }
    }
    this.emit({
      status: "emulator-not-ready",
      gameId: context.gameId,
      slot,
      message: "Emulator core is still starting. Try again in a moment.",
    });
    return false;
  }


  private resolveContext(override?: Partial<SaveGameContext>): SaveGameContext | null {
    if (override?.gameId && override.gameName && override.systemId) {
      return { gameId: override.gameId, gameName: override.gameName, systemId: override.systemId };
    }
    return this.getCurrentGameContext();
  }

  async saveSlot(slot: number, override?: Partial<SaveGameContext>): Promise<SaveStateEntry | null> {
    const context = this.resolveContext(override);
    if (!context) return null;

    if (this.pendingSaveSlots.has(slot)) {
      return this.saveLibrary.getState(context.gameId, slot);
    }

    this.pendingSaveSlots.add(slot);

    try {
      return await this.enqueue(async () => {
        this.emit({ status: "saving-local", gameId: context.gameId, slot });

        const ready = await this.waitForEmulatorReady(context, slot);
        if (!ready) return null;

        this.emulator.quickSave(slot);
        const stateBytes = this.emulator.readStateData(slot);
        const stateData = stateBytesToBlob(stateBytes);
        const screenshot = this.emulator.captureScreenshotAsync
          ? await this.emulator.captureScreenshotAsync()
          : (this.emulator.playerId ? await captureScreenshot(this.emulator.playerId) : null);
        const thumbnail = screenshot ? await createThumbnail(screenshot) : null;

        // Preserve the user-defined label if one already exists for this slot.
        const existing = await this.saveLibrary.getState(context.gameId, slot);
        const entry: SaveStateEntry = {
          id: saveStateKey(context.gameId, slot),
          gameId: context.gameId,
          gameName: context.gameName,
          systemId: context.systemId,
          slot,
          label: existing?.label || defaultSlotLabel(slot),
          timestamp: Date.now(),
          thumbnail,
          stateData,
          isAutoSave: slot === AUTO_SAVE_SLOT,
        };

        await this.saveLibrary.saveState(entry);
        const saved = await this.saveLibrary.getState(context.gameId, slot);

        if (saved && this.cloudManager?.isConnected() && this.cloudManager.autoSyncEnabled) {
          this.emit({ status: "syncing-cloud", gameId: context.gameId, slot });
          try {
            await this.cloudManager.push(saved);
            this.emit({ status: "sync-success", gameId: context.gameId, slot, message: "Synced to cloud." });
          } catch (error) {
            this.emit({
              status: "sync-error",
              gameId: context.gameId,
              slot,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }

        this.emit({ status: "idle", gameId: context.gameId, slot });
        return saved;
      });
    } finally {
      this.pendingSaveSlots.delete(slot);
    }
  }

  async loadSlot(slot: number, override?: Partial<SaveGameContext>): Promise<boolean> {
    const context = this.resolveContext(override);
    if (!context) return false;

    return this.enqueue(async () => {
      this.emit({ status: "loading-local", gameId: context.gameId, slot });
      const entry = await this.saveLibrary.getState(context.gameId, slot);
      if (!entry?.stateData) {
        this.emit({ status: "idle", gameId: context.gameId, slot });
        return false;
      }

      const checksumOk = await verifySaveChecksum(entry);
      if (!checksumOk) {
        this.emit({
          status: "integrity-warning",
          gameId: context.gameId,
          slot,
          message: "This save appears corrupted (checksum mismatch).",
        });
      }

      const ready = await this.waitForEmulatorReady(context, slot);
      if (!ready) return false;

      const bytes = new Uint8Array(await entry.stateData.arrayBuffer());
      const written = this.emulator.writeStateData(slot, bytes);
      if (!written) {
        this.emit({ status: "emulator-not-ready", gameId: context.gameId, slot, message: "Could not write save data to emulator." });
        return false;
      }

      this.emulator.quickLoad(slot);
      this.emit({ status: "idle", gameId: context.gameId, slot });
      return true;
    });
  }
}
