/**
 * multiplayerUtils.ts — Lightweight constants and utilities for netplay.
 * This file is intended to be imported by UI components without pulling in
 * the full NetplayManager or signaling client logic.
 */

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export const NETPLAY_SUPPORTED_SYSTEM_IDS = [
  "n64", "psp", "nds", "gba", "gbc", "gb",
  "nes", "snes", "segaMD", "segaMS", "segaGG",
] as const;

export const SYSTEM_LINK_CAPABILITIES: Record<string, boolean> = {
  nes:    true,    // FCEUmm supports 2–4 player netplay
  snes:   true,    // Snes9x supports 2–5 player netplay
  n64:    true,
  psp:    true,
  gb:     true,
  gbc:    true,
  gba:    true,
  nds:    true,
  segaMD: true,    // Genesis Plus GX supports 2-player netplay
  segaMS: true,    // Sega Master System via Genesis Plus GX
  segaGG: true,    // Game Gear via Genesis Plus GX
};

export const ROOM_KEY_DISPLAY_NAMES: Record<string, string> = {
  pokemon_gen1:        "Pokémon Gen1 Trading Room (Red / Blue / Yellow)",
  pokemon_gen2:        "Pokémon Gen2 Trading Room (Gold / Silver / Crystal)",
  pokemon_gen3_kanto:  "Pokémon Gen3 Kanto Trading Room (FireRed / LeafGreen)",
  pokemon_gen3_hoenn:  "Pokémon Gen3 Hoenn Trading Room (Ruby / Sapphire / Emerald)",
  pokemon_gen4_sinnoh: "Pokémon Gen4 Sinnoh Trading Room (Diamond / Pearl / Platinum)",
  pokemon_gen4_johto:  "Pokémon Gen4 Johto Trading Room (HeartGold / SoulSilver)",
  pokemon_gen5_unova:  "Pokémon Gen5 Unova Trading Room (Black / White)",
  pokemon_gen5_unova2: "Pokémon Gen5 Unova Trading Room (Black 2 / White 2)",
};

export function roomDisplayNameForKey(roomKey: string): string {
  return ROOM_KEY_DISPLAY_NAMES[roomKey] ?? roomKey;
}

export function validateIceServerUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return "ICE server URL must not be empty";
  if (!/^(stun|turn|turns):/i.test(trimmed)) {
    return "URL must start with stun:, turn:, or turns:";
  }
  const colonIdx = trimmed.indexOf(":");
  const afterColon = trimmed.slice(colonIdx + 1).replace(/^\/\//, "").trim();
  if (afterColon.length === 0) {
    return "ICE server URL must include a hostname (e.g. stun:stun.example.com:3478)";
  }
  return null;
}
