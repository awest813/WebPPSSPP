/**
 * compatibility.ts — Game and session compatibility checking for Easy Netplay.
 *
 * Before a user joins a room we validate that the local game configuration is
 * compatible with the host's.  Checks run locally (no network call needed)
 * and return human-readable results that are surfaced directly in the UI.
 */

import {
  NETPLAY_SUPPORTED_SYSTEM_IDS,
  SYSTEM_LINK_CAPABILITIES,
  canonicalizeGameId,
} from "../multiplayer.js";

// ── Public types ──────────────────────────────────────────────────────────────

/** Result of a compatibility check. */
export interface CompatibilityResult {
  /** Whether the session can proceed without errors. */
  compatible: boolean;
  /** Informational messages (e.g. "compatible cross-version pairs"). */
  warnings: string[];
  /** Blocking issues that prevent joining or hosting. */
  errors: string[];
}

// ── System support check ──────────────────────────────────────────────────────

/**
 * Check whether the given system supports netplay in this app.
 *
 * Returns a CompatibilityResult with a single error when the system is
 * unsupported, or a clean compatible result otherwise.
 */
export function checkSystemSupport(systemId: string): CompatibilityResult {
  const id = systemId.toLowerCase();
  const isSupported =
    (NETPLAY_SUPPORTED_SYSTEM_IDS as readonly string[]).includes(id) &&
    SYSTEM_LINK_CAPABILITIES[id] === true;

  if (!isSupported) {
    return {
      compatible: false,
      warnings:   [],
      errors:     [`This system (${systemId.toUpperCase()}) doesn't support multiplayer.`],
    };
  }
  return { compatible: true, warnings: [], errors: [] };
}

// ── Game compatibility check ──────────────────────────────────────────────────

/**
 * Check whether the local game is compatible with the host's game.
 *
 * Both arguments are canonicalized before comparison so minor filename
 * differences (regions, revision tags) don't block a valid session.
 *
 * The caller is responsible for passing the room's recorded gameId and
 * systemId so this function can be used in both the host and join flows.
 */
export function checkGameCompatibility(
  localGameId:    string,
  localSystemId:  string,
  remoteGameId:   string,
  remoteSystemId: string,
): CompatibilityResult {
  const warnings: string[] = [];
  const errors:   string[] = [];

  // System mismatch — hard error.
  if (localSystemId.toLowerCase() !== remoteSystemId.toLowerCase()) {
    errors.push(
      `System mismatch: you are running ${localSystemId.toUpperCase()} ` +
      `but the host is on ${remoteSystemId.toUpperCase()}.`
    );
  }

  // Game mismatch — warn (may still work with alias-mapped titles).
  if (canonicalizeGameId(localGameId) !== canonicalizeGameId(remoteGameId)) {
    warnings.push(
      "Game versions may not match — make sure you and the host have the same ROM."
    );
  }

  return {
    compatible: errors.length === 0,
    warnings,
    errors,
  };
}

// ── Quick helper for the UI ───────────────────────────────────────────────────

/**
 * Return a single plain-English status line for display in the UI.
 *
 * - Returns null when everything looks compatible.
 * - Returns a warning string when there are only soft issues.
 * - Returns an error string when the session cannot proceed.
 */
export function compatibilitySummary(result: CompatibilityResult): string | null {
  if (result.errors.length > 0)   return result.errors[0]!;
  if (result.warnings.length > 0) return result.warnings[0]!;
  return null;
}
