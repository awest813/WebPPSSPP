export interface RACredentials {
  username: string;
  apiKey: string;
}

/**
 * Parse the RetroAchievements key format stored by ApiKeyStore.
 */
export function parseRAKey(raw: string): RACredentials | null {
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator !== raw.lastIndexOf(":")) return null;

  const username = raw.slice(0, separator).trim();
  const apiKey = raw.slice(separator + 1).trim();
  if (!username || !apiKey) return null;

  return { username, apiKey };
}
