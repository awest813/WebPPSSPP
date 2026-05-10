/**
 * Shared post-process effect identifiers and parsing — no WebGPU / shader code.
 * Used by settings persistence, per-game profiles, and `webgpuPostProcess.ts`.
 */

export type PostProcessEffect =
  | "none"
  | "crt"
  | "sharpen"
  | "lcd"
  | "bloom"
  | "fxaa"
  | "fsr"
  | "grain"
  | "retro"
  | "colorgrade"
  | "taa"
  | "pixelate"
  | "ntsc"
  | "hdr";

/**
 * Post-process effects compiled during emulator WebGPU pre-warm so the first
 * in-game effect switch avoids shader stalls. Omits `"none"`.
 */
export const POST_PROCESS_PIPELINE_WARMUP_EFFECTS: readonly Exclude<
  PostProcessEffect,
  "none"
>[] = [
  "crt", "sharpen", "lcd", "bloom", "fxaa",
  "fsr", "grain", "retro", "colorgrade", "taa",
  "pixelate", "ntsc", "hdr",
];

/** Full effect set including `"none"` — persistence validation and completeness checks. */
export const ALL_POST_PROCESS_EFFECTS: ReadonlySet<PostProcessEffect> = new Set<PostProcessEffect>([
  "none",
  ...POST_PROCESS_PIPELINE_WARMUP_EFFECTS,
]);

/**
 * Stable order for Settings → Visual Effects radios and the in-game filter dropdown
 * so every surface exposes the same effects.
 */
export const POST_PROCESS_EFFECT_UI_ORDER: readonly PostProcessEffect[] = [
  "none",
  "fsr",
  "taa",
  "crt",
  "sharpen",
  "lcd",
  "bloom",
  "fxaa",
  "grain",
  "retro",
  "colorgrade",
  "pixelate",
  "ntsc",
  "hdr",
];

/** Parse a stored / user-supplied string into a known effect, or `null` if invalid. */
export function parsePostProcessEffect(value: unknown): PostProcessEffect | null {
  if (typeof value !== "string") return null;
  return ALL_POST_PROCESS_EFFECTS.has(value as PostProcessEffect)
    ? (value as PostProcessEffect)
    : null;
}
