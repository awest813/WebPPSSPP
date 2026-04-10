/**
 * netplaySingleton.ts — Lazy-loading singleton for the NetplayManager.
 * Helps move netplay logic off the critical path for faster initial load.
 */

let _instance: import("./multiplayer.js").NetplayManager | null = null;

/**
 * Gets the NetplayManager instance, lazily importing and instantiating
 * it only when first accessed.
 */
export async function getNetplayManager(): Promise<import("./multiplayer.js").NetplayManager> {
  if (!_instance) {
    const { NetplayManager } = await import("./multiplayer.js");
    _instance = new NetplayManager();
  }
  return _instance;
}

/** Returns the instance if already loaded, otherwise null. */
export function peekNetplayManager(): import("./multiplayer.js").NetplayManager | null {
  return _instance;
}

/**
 * Register a pre-existing NetplayManager instance as the singleton.
 * Useful for tests and for wiring an externally-created manager into
 * the global singleton so that peekNetplayManager() returns it.
 */
export function registerNetplayInstance(mgr: import("./multiplayer.js").NetplayManager): void {
  _instance = mgr;
}
