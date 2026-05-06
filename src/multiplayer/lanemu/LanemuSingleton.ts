/**
 * LanemuSingleton.ts — Lazy-loading singleton for the LanemuService.
 */

import { LanemuService } from "./LanemuService.js";
import { DEFAULT_LANEMU_SETTINGS } from "./LanemuSettings.js";
import type { IProcessLaunchService } from "./LanemuProcessService.js";
import type { INetworkService, NetworkInterface } from "./LanemuNetworkService.js";

/**
 * A dummy implementation of IProcessLaunchService for the browser environment.
 * In a real desktop build (Electron/Tauri), this would be replaced with
 * a native bridge implementation.
 */
class BrowserProcessLauncher implements IProcessLaunchService {
  async spawn(command: string, args: string[]): Promise<number> {
    console.warn("[Lanemu] spawn() called in browser. Command:", command, args);
    throw new Error("Native process spawning is not supported in the browser. Please use the RetroOasis Desktop app.");
  }
  async kill(pid: number): Promise<void> {
    console.warn("[Lanemu] kill() called for PID:", pid);
  }
  async isProcessRunning(_pid: number): Promise<boolean> {
    return false;
  }
  async exists(path: string): Promise<boolean> {
    console.warn("[Lanemu] exists() called in browser for path:", path);
    return false;
  }
  async validateJava(path: string): Promise<boolean> {
    console.warn("[Lanemu] validateJava() called in browser for path:", path);
    return false;
  }
}

/**
 * A browser-safe network service that uses standard Web APIs where possible.
 */
class BrowserNetworkService implements INetworkService {
  async getInterfaces(): Promise<NetworkInterface[]> {
    return []; // Browsers cannot list network interfaces
  }
  async ping(ip: string): Promise<boolean> {
    console.warn("[Lanemu] ping() not supported in browser for IP:", ip);
    return false;
  }
  async checkTcpPort(_ip: string, _port: number): Promise<boolean> {
    // We could potentially try to fetch() or use WebSockets to check ports,
    // but browser security (CORS/mixed content) makes this unreliable.
    return false;
  }
}

let _instance: LanemuService | null = null;

export function getLanemuService(): LanemuService {
  if (!_instance) {
    _instance = new LanemuService(
      DEFAULT_LANEMU_SETTINGS,
      new BrowserProcessLauncher(),
      new BrowserNetworkService()
    );
  }
  return _instance;
}

/**
 * Allows the desktop wrapper to inject real native implementations of
 * the process and network services at startup.
 */
export function initializeLanemu(launcher: IProcessLaunchService, network: INetworkService): void {
  _instance = new LanemuService(DEFAULT_LANEMU_SETTINGS, launcher, network);
}
