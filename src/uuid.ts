/**
 * Generate a UUID suitable for client-side storage keys.
 *
 * Uses the platform implementation when available and falls back to
 * a crypto-backed RFC4122 v4-compatible generator for older browsers.
 */
export function createUuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0]! & 0x0f;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
