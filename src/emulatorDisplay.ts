/**
 * In-game viewport layout for EmulatorJS — per-system aspect presets so 2D
 * handhelds and 240p consoles are not stretched across ultrawide or tall phones.
 *
 * Applied via data attributes + CSS variables on `#ejs-container` (see style.css).
 */

/** DOM id of the EmulatorJS mount (shared with index template). */
export const EMULATOR_JS_CONTAINER_ID = "ejs-container";

export type EmulatorScreenPreset = {
  /** Passed to CSS `aspect-ratio` (e.g. `3 / 2`, `256 / 224`). */
  aspectRatio: string;
  /** Nearest-neighbour style scaling for low-res pixel systems. */
  crispPixels?: boolean;
};

const PRESETS: Readonly<Record<string, EmulatorScreenPreset>> = {
  // Handhelds (native PAR)
  gba: { aspectRatio: "3 / 2", crispPixels: true },
  gb:  { aspectRatio: "10 / 9", crispPixels: true },
  gbc: { aspectRatio: "10 / 9", crispPixels: true },
  nds: { aspectRatio: "2 / 3", crispPixels: true },
  segaGG: { aspectRatio: "10 / 9", crispPixels: true },
  lynx: { aspectRatio: "160 / 102", crispPixels: true },
  ngp:  { aspectRatio: "20 / 19", crispPixels: true },

  // 240p-class home — ~8:7 active; 4:3 safe TV frame
  nes:  { aspectRatio: "256 / 224", crispPixels: true },
  snes: { aspectRatio: "256 / 224", crispPixels: true },

  // 3D / CD — default 4:3 (widescreen hacks still letterbox inside)
  n64:      { aspectRatio: "4 / 3" },
  psx:      { aspectRatio: "4 / 3" },
  psp:      { aspectRatio: "30 / 17" },
  segaMD:   { aspectRatio: "4 / 3" },
  segaMS:   { aspectRatio: "4 / 3" },
  segaSaturn: { aspectRatio: "4 / 3" },
  segaDC:   { aspectRatio: "4 / 3" },
  atari2600: { aspectRatio: "4 / 3" },
  atari7800: { aspectRatio: "4 / 3" },
  arcade:   { aspectRatio: "4 / 3" },
  mame2003: { aspectRatio: "4 / 3" },
};

const FALLBACK: EmulatorScreenPreset = { aspectRatio: "4 / 3" };

export function getEmulatorScreenPreset(systemId: string | null | undefined): EmulatorScreenPreset | null {
  if (systemId == null) return null;
  const id = typeof systemId === "string" ? systemId.trim() : "";
  if (!id) return null;
  return PRESETS[id] ?? FALLBACK;
}

/**
 * Toggle layout hooks on the emulator mount; call with `null` when returning to the library.
 */
export function syncEmulatorViewportLayout(
  container: HTMLElement | null,
  systemId: string | null | undefined,
): void {
  if (!container) return;
  container.removeAttribute("data-emu-viewport");
  container.removeAttribute("data-emu-pixelated");
  container.style.removeProperty("--emu-screen-ar");

  const preset = getEmulatorScreenPreset(systemId);
  if (!preset) return;

  container.dataset.emuViewport = "on";
  container.style.setProperty("--emu-screen-ar", preset.aspectRatio);
  if (preset.crispPixels) container.dataset.emuPixelated = "on";

  // After the next frame so `aspect-ratio` / layout have applied before listeners (e.g. EJS) run.
  requestAnimationFrame(() => {
    try {
      window.dispatchEvent(new Event("resize"));
    } catch {
      /* ignore */
    }
  });
}
