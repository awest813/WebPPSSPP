/**
 * Touch control layout definitions and per-system persistence.
 *
 * This module is deliberately DOM-light so callers can load layout data
 * without pulling in the full overlay implementation.
 */

export interface TouchButtonDef {
  id:    string;
  label: string;
  /** X position as percentage of overlay width (0–100). */
  x:     number;
  /** Y position as percentage of overlay height (0–100). */
  y:     number;
  /** Diameter in CSS pixels. */
  size:  number;
  color: string;
  /**
   * Optional element type.
   * - `"button"` (default) — a tappable circular button.
   * - `"stick"`            — a draggable analog joystick.  The `id` must be
   *   `"stick"` so the overlay can map directional movement to
   *   `stick_up/down/left/right` in TOUCH_KEY_MAP.
   * - `"dpad"`             — a cross-shaped directional pad that fires
   *   `up/down/left/right` (and diagonals) based on touch angle.
   */
  type?: "button" | "stick" | "dpad";
}

/**
 * Default button layout for landscape orientation.
 *
 * The D-pad is a single cross-shaped element positioned at the bottom-left.
 * Ten elements total: dpad, 4 face buttons, 2 shoulders, 2 meta, 1 stick.
 */
export const DEFAULT_LAYOUT: TouchButtonDef[] = [
  // D-pad — single cross element, bottom-left
  { id: "dpad",   label: "",    x: 11,  y: 65, size: 120, color: "rgba(35,35,55,0.85)", type: "dpad" },
  // Face buttons — bottom right (PSP/PlayStation layout: ○ top-right, × bottom, □ left, △ top)
  { id: "a",      label: "○",   x: 90,  y: 65, size: 48,  color: "rgba(190,50,50,0.82)"  },
  { id: "b",      label: "×",   x: 83,  y: 78, size: 48,  color: "rgba(190,130,30,0.82)" },
  { id: "x",      label: "△",   x: 83,  y: 52, size: 48,  color: "rgba(50,100,200,0.82)" },
  { id: "y",      label: "□",   x: 76,  y: 65, size: 48,  color: "rgba(50,160,80,0.82)"  },
  // Shoulder buttons — top corners
  { id: "l",      label: "L",   x: 3,   y: 8,  size: 52,  color: "rgba(40,40,60,0.85)"   },
  { id: "r",      label: "R",   x: 93,  y: 8,  size: 52,  color: "rgba(40,40,60,0.85)"   },
  // Meta buttons — bottom centre
  { id: "select", label: "SEL", x: 39,  y: 90, size: 40,  color: "rgba(40,40,60,0.85)"   },
  { id: "start",  label: "STA", x: 56,  y: 90, size: 40,  color: "rgba(40,40,60,0.85)"   },
  // Analog stick (PSP nub) — bottom left, to the right of the D-pad
  { id: "stick",  label: "",    x: 27,  y: 75, size: 78,  color: "rgba(35,35,55,0.80)", type: "stick" },
];

/**
 * Default button layout for portrait orientation.
 *
 * Buttons are pushed lower and spread wider to stay in thumb reach when
 * the device is held vertically.  Shoulder buttons sit at mid-screen height
 * so they remain accessible without awkward finger stretching.
 */
export const DEFAULT_PORTRAIT_LAYOUT: TouchButtonDef[] = [
  // D-pad — lower-left, wider than landscape to use the full thumb zone
  { id: "dpad",   label: "",    x: 15,  y: 70, size: 120, color: "rgba(35,35,55,0.85)", type: "dpad" },
  // Face buttons — lower-right (PSP/PlayStation layout)
  { id: "a",      label: "○",   x: 88,  y: 69, size: 48,  color: "rgba(190,50,50,0.82)"  },
  { id: "b",      label: "×",   x: 80,  y: 80, size: 48,  color: "rgba(190,130,30,0.82)" },
  { id: "x",      label: "△",   x: 80,  y: 58, size: 48,  color: "rgba(50,100,200,0.82)" },
  { id: "y",      label: "□",   x: 72,  y: 69, size: 48,  color: "rgba(50,160,80,0.82)"  },
  // Shoulder buttons — mid-screen corners so thumbs can reach without moving the hand
  { id: "l",      label: "L",   x: 4,   y: 42, size: 52,  color: "rgba(40,40,60,0.85)"   },
  { id: "r",      label: "R",   x: 92,  y: 42, size: 52,  color: "rgba(40,40,60,0.85)"   },
  // Meta buttons — bottom centre
  { id: "select", label: "SEL", x: 37,  y: 91, size: 40,  color: "rgba(40,40,60,0.85)"   },
  { id: "start",  label: "STA", x: 57,  y: 91, size: 40,  color: "rgba(40,40,60,0.85)"   },
  // Analog stick — to the right of the D-pad
  { id: "stick",  label: "",    x: 30,  y: 76, size: 78,  color: "rgba(35,35,55,0.80)", type: "stick" },
];

function cloneLayout(layout: TouchButtonDef[]): TouchButtonDef[] {
  return layout.map((b) => ({ ...b }));
}

/** Nintendo diamond labels on the four face buttons (Y,X,B,A mapping to ids y,x,b,a). */
function layoutNintendoLetterFace(layout: TouchButtonDef[]): TouchButtonDef[] {
  return layout.map((b) => {
    const c = { ...b };
    if (c.id === "y") c.label = "Y";
    else if (c.id === "x") c.label = "X";
    else if (c.id === "b") c.label = "B";
    else if (c.id === "a") c.label = "A";
    return c;
  });
}

/** Dreamcast A, B, X, Y labels on the PlayStation-shaped diamond. */
function layoutDreamcastFace(layout: TouchButtonDef[]): TouchButtonDef[] {
  return layout.map((b) => {
    const c = { ...b };
    if (c.id === "a") {
      c.label = "B";
      c.color = "rgba(210,55,55,0.85)";
    } else if (c.id === "b") {
      c.label = "A";
      c.color = "rgba(50,180,80,0.85)";
    } else if (c.id === "x") {
      c.label = "Y";
      c.color = "rgba(55,115,215,0.85)";
    } else if (c.id === "y") {
      c.label = "X";
      c.color = "rgba(200,130,40,0.85)";
    }
    return c;
  });
}

/** Game Boy / GB Color — D-pad + A/B + Select/Start only (no shoulders or analog). */
const LAYOUT_GB_GBC_LANDSCAPE: TouchButtonDef[] = [
  { id: "dpad", label: "", x: 11, y: 65, size: 128, color: "rgba(35,35,55,0.85)", type: "dpad" },
  { id: "b", label: "B", x: 82, y: 78, size: 54, color: "rgba(140,55,175,0.88)" },
  { id: "a", label: "A", x: 91, y: 61, size: 54, color: "rgba(210,50,50,0.88)" },
  { id: "select", label: "SEL", x: 38, y: 90, size: 42, color: "rgba(40,40,60,0.85)" },
  { id: "start", label: "STA", x: 58, y: 90, size: 42, color: "rgba(40,40,60,0.85)" },
];

const LAYOUT_GB_GBC_PORTRAIT: TouchButtonDef[] = [
  { id: "dpad", label: "", x: 15, y: 70, size: 125, color: "rgba(35,35,55,0.85)", type: "dpad" },
  { id: "b", label: "B", x: 80, y: 80, size: 54, color: "rgba(140,55,175,0.88)" },
  { id: "a", label: "A", x: 88, y: 65, size: 54, color: "rgba(210,50,50,0.88)" },
  { id: "select", label: "SEL", x: 37, y: 91, size: 40, color: "rgba(40,40,60,0.85)" },
  { id: "start", label: "STA", x: 57, y: 91, size: 40, color: "rgba(40,40,60,0.85)" },
];

/** NES / Famicom — D-pad + A/B + Select/Start (no shoulders, no analog). */
const LAYOUT_NES_LANDSCAPE: TouchButtonDef[] = [
  { id: "dpad",   label: "",    x: 11,  y: 65, size: 128, color: "rgba(35,35,55,0.85)", type: "dpad" },
  { id: "b",      label: "B",   x: 82,  y: 78, size: 54,  color: "rgba(180,130,30,0.82)" },
  { id: "a",      label: "A",   x: 91,  y: 61, size: 54,  color: "rgba(210,50,50,0.82)" },
  { id: "select", label: "SEL", x: 38,  y: 90, size: 42,  color: "rgba(40,40,60,0.85)" },
  { id: "start",  label: "STA", x: 58,  y: 90, size: 42,  color: "rgba(40,40,60,0.85)" },
];

const LAYOUT_NES_PORTRAIT: TouchButtonDef[] = [
  { id: "dpad",   label: "",    x: 15,  y: 70, size: 125, color: "rgba(35,35,55,0.85)", type: "dpad" },
  { id: "b",      label: "B",   x: 80,  y: 80, size: 54,  color: "rgba(180,130,30,0.82)" },
  { id: "a",      label: "A",   x: 88,  y: 65, size: 54,  color: "rgba(210,50,50,0.82)" },
  { id: "select", label: "SEL", x: 37,  y: 91, size: 40,  color: "rgba(40,40,60,0.85)" },
  { id: "start",  label: "STA", x: 57,  y: 91, size: 40,  color: "rgba(40,40,60,0.85)" },
];

/** SNES / Super Famicom — D-pad + Y/X/B/A diamond + L/R + Select/Start (no analog stick). */
const LAYOUT_SNES_LANDSCAPE: TouchButtonDef[] = [
  { id: "dpad",   label: "",    x: 11,  y: 65, size: 120, color: "rgba(35,35,55,0.85)", type: "dpad" },
  { id: "l",      label: "L",   x: 3,   y: 8,  size: 52,  color: "rgba(40,40,60,0.85)" },
  { id: "r",      label: "R",   x: 93,  y: 8,  size: 52,  color: "rgba(40,40,60,0.85)" },
  { id: "y",      label: "Y",   x: 76,  y: 65, size: 48,  color: "rgba(50,160,80,0.82)" },
  { id: "x",      label: "X",   x: 83,  y: 52, size: 48,  color: "rgba(50,100,200,0.82)" },
  { id: "b",      label: "B",   x: 83,  y: 78, size: 48,  color: "rgba(180,130,30,0.82)" },
  { id: "a",      label: "A",   x: 90,  y: 65, size: 48,  color: "rgba(210,50,50,0.82)" },
  { id: "select", label: "SEL", x: 39,  y: 90, size: 40,  color: "rgba(40,40,60,0.85)" },
  { id: "start",  label: "STA", x: 56,  y: 90, size: 40,  color: "rgba(40,40,60,0.85)" },
];

const LAYOUT_SNES_PORTRAIT: TouchButtonDef[] = [
  { id: "dpad",   label: "",    x: 15,  y: 70, size: 120, color: "rgba(35,35,55,0.85)", type: "dpad" },
  { id: "l",      label: "L",   x: 4,   y: 42, size: 52,  color: "rgba(40,40,60,0.85)" },
  { id: "r",      label: "R",   x: 92,  y: 42, size: 52,  color: "rgba(40,40,60,0.85)" },
  { id: "y",      label: "Y",   x: 72,  y: 69, size: 48,  color: "rgba(50,160,80,0.82)" },
  { id: "x",      label: "X",   x: 80,  y: 58, size: 48,  color: "rgba(50,100,200,0.82)" },
  { id: "b",      label: "B",   x: 80,  y: 80, size: 48,  color: "rgba(180,130,30,0.82)" },
  { id: "a",      label: "A",   x: 88,  y: 69, size: 48,  color: "rgba(210,50,50,0.82)" },
  { id: "select", label: "SEL", x: 37,  y: 91, size: 40,  color: "rgba(40,40,60,0.85)" },
  { id: "start",  label: "STA", x: 57,  y: 91, size: 40,  color: "rgba(40,40,60,0.85)" },
];

/** Atari 2600 — joystick + single fire button. */
const LAYOUT_ATARI2600_LANDSCAPE: TouchButtonDef[] = [
  { id: "dpad", label: "", x: 14, y: 62, size: 138, color: "rgba(35,35,55,0.85)", type: "dpad" },
  { id: "b", label: "Fire", x: 87, y: 67, size: 64, color: "rgba(195,48,48,0.9)" },
];

const LAYOUT_ATARI2600_PORTRAIT: TouchButtonDef[] = [
  { id: "dpad", label: "", x: 16, y: 67, size: 132, color: "rgba(35,35,55,0.85)", type: "dpad" },
  { id: "b", label: "Fire", x: 84, y: 73, size: 62, color: "rgba(195,48,48,0.9)" },
];

/** Sega Genesis / Mega Drive — D-pad + 6-button layout (A, B, C, X, Y, Z) + Start (no analog). */
const LAYOUT_GENESIS_LANDSCAPE: TouchButtonDef[] = [
  { id: "dpad",   label: "",    x: 11,  y: 65, size: 125, color: "rgba(35,35,55,0.85)", type: "dpad" },
  { id: "x",      label: "X",   x: 72,  y: 52, size: 40,  color: "rgba(55,115,215,0.85)" },
  { id: "y",      label: "Y",   x: 82,  y: 52, size: 40,  color: "rgba(50,160,80,0.85)" },
  { id: "z_btn",  label: "Z",   x: 92,  y: 52, size: 40,  color: "rgba(180,60,80,0.85)" },
  { id: "a",      label: "A",   x: 72,  y: 68, size: 44,  color: "rgba(210,55,55,0.85)" },
  { id: "b",      label: "B",   x: 82,  y: 68, size: 44,  color: "rgba(210,175,45,0.85)" },
  { id: "c_btn",  label: "C",   x: 92,  y: 68, size: 44,  color: "rgba(45,175,95,0.85)" },
  { id: "start",  label: "STA", x: 45,  y: 90, size: 42,  color: "rgba(40,40,60,0.85)" },
];

const LAYOUT_GENESIS_PORTRAIT: TouchButtonDef[] = [
  { id: "dpad",   label: "",    x: 15,  y: 70, size: 125, color: "rgba(35,35,55,0.85)", type: "dpad" },
  { id: "x",      label: "X",   x: 64,  y: 46, size: 36,  color: "rgba(55,115,215,0.85)" },
  { id: "y",      label: "Y",   x: 74,  y: 46, size: 36,  color: "rgba(50,160,80,0.85)" },
  { id: "z_btn",  label: "Z",   x: 84,  y: 46, size: 36,  color: "rgba(180,60,80,0.85)" },
  { id: "a",      label: "A",   x: 64,  y: 62, size: 40,  color: "rgba(210,55,55,0.85)" },
  { id: "b",      label: "B",   x: 74,  y: 62, size: 40,  color: "rgba(210,175,45,0.85)" },
  { id: "c_btn",  label: "C",   x: 84,  y: 62, size: 40,  color: "rgba(45,175,95,0.85)" },
  { id: "start",  label: "STA", x: 45,  y: 90, size: 40,  color: "rgba(40,40,60,0.85)" },
];

/** Saturn — D-pad + 6-button layout (A, B, C, X, Y, Z) + L/R + Start (no analog). */
const LAYOUT_SATURN_LANDSCAPE: TouchButtonDef[] = [
  { id: "dpad",   label: "",    x: 11,  y: 65, size: 120, color: "rgba(35,35,55,0.85)", type: "dpad" },
  { id: "l",      label: "L",   x: 3,   y: 8,  size: 52,  color: "rgba(40,40,60,0.85)" },
  { id: "r",      label: "R",   x: 93,  y: 8,  size: 52,  color: "rgba(40,40,60,0.85)" },
  { id: "x",      label: "X",   x: 72,  y: 48, size: 40,  color: "rgba(55,115,215,0.85)" },
  { id: "y",      label: "Y",   x: 82,  y: 48, size: 40,  color: "rgba(50,160,80,0.85)" },
  { id: "z_btn",  label: "Z",   x: 92,  y: 48, size: 40,  color: "rgba(180,60,80,0.85)" },
  { id: "a",      label: "A",   x: 72,  y: 65, size: 44,  color: "rgba(210,55,55,0.85)" },
  { id: "b",      label: "B",   x: 82,  y: 65, size: 44,  color: "rgba(210,175,45,0.85)" },
  { id: "c_btn",  label: "C",   x: 92,  y: 65, size: 44,  color: "rgba(45,175,95,0.85)" },
  { id: "start",  label: "STA", x: 45,  y: 90, size: 40,  color: "rgba(40,40,60,0.85)" },
];

const LAYOUT_SATURN_PORTRAIT: TouchButtonDef[] = [
  { id: "dpad",   label: "",    x: 15,  y: 70, size: 120, color: "rgba(35,35,55,0.85)", type: "dpad" },
  { id: "l",      label: "L",   x: 4,   y: 42, size: 50,  color: "rgba(40,40,60,0.85)" },
  { id: "r",      label: "R",   x: 92,  y: 42, size: 50,  color: "rgba(40,40,60,0.85)" },
  { id: "x",      label: "X",   x: 64,  y: 44, size: 36,  color: "rgba(55,115,215,0.85)" },
  { id: "y",      label: "Y",   x: 74,  y: 44, size: 36,  color: "rgba(50,160,80,0.85)" },
  { id: "z_btn",  label: "Z",   x: 84,  y: 44, size: 36,  color: "rgba(180,60,80,0.85)" },
  { id: "a",      label: "A",   x: 64,  y: 62, size: 40,  color: "rgba(210,55,55,0.85)" },
  { id: "b",      label: "B",   x: 74,  y: 62, size: 40,  color: "rgba(210,175,45,0.85)" },
  { id: "c_btn",  label: "C",   x: 84,  y: 62, size: 40,  color: "rgba(45,175,95,0.85)" },
  { id: "start",  label: "STA", x: 45,  y: 90, size: 40,  color: "rgba(40,40,60,0.85)" },
];

/** N64  — analog stick left, C-button diamond right, Z trigger, A/B below C-buttons */
const LAYOUT_N64_LANDSCAPE: TouchButtonDef[] = [
  { id: "dpad",   label: "",    x: 11,  y: 68, size: 110, color: "rgba(35,35,55,0.85)", type: "dpad" },
  { id: "stick",  label: "",    x: 27,  y: 42, size: 78,  color: "rgba(35,35,55,0.80)", type: "stick" },
  { id: "l",      label: "L",   x: 3,   y: 8,  size: 52,  color: "rgba(40,40,60,0.85)"  },
  { id: "r",      label: "R",   x: 93,  y: 8,  size: 52,  color: "rgba(40,40,60,0.85)"  },
  { id: "z_btn",  label: "Z",   x: 93,  y: 24, size: 48,  color: "rgba(180,60,80,0.85)" },
  { id: "c_up",   label: "C",   x: 78,  y: 30, size: 38,  color: "rgba(200,180,40,0.85)" },
  { id: "c_right",label: "C",   x: 90,  y: 40, size: 38,  color: "rgba(200,180,40,0.85)" },
  { id: "c_down", label: "C",   x: 78,  y: 50, size: 38,  color: "rgba(200,180,40,0.85)" },
  { id: "c_left", label: "C",   x: 66,  y: 40, size: 38,  color: "rgba(200,180,40,0.85)" },
  { id: "a",      label: "A",   x: 85,  y: 68, size: 44,  color: "rgba(50,160,50,0.82)" },
  { id: "b",      label: "B",   x: 72,  y: 74, size: 44,  color: "rgba(180,130,30,0.82)" },
  { id: "start",  label: "STA", x: 45,  y: 90, size: 40,  color: "rgba(40,40,60,0.85)" },
];

const LAYOUT_N64_PORTRAIT: TouchButtonDef[] = [
  { id: "dpad",   label: "",    x: 15,  y: 70, size: 115, color: "rgba(35,35,55,0.85)", type: "dpad" },
  { id: "stick",  label: "",    x: 30,  y: 78, size: 72,  color: "rgba(35,35,55,0.80)", type: "stick" },
  { id: "l",      label: "L",   x: 4,   y: 42, size: 50,  color: "rgba(40,40,60,0.85)" },
  { id: "r",      label: "R",   x: 92,  y: 42, size: 50,  color: "rgba(40,40,60,0.85)" },
  { id: "z_btn",  label: "Z",   x: 92,  y: 55, size: 46,  color: "rgba(180,60,80,0.85)" },
  { id: "c_up",   label: "C",   x: 70,  y: 26, size: 34,  color: "rgba(200,180,40,0.85)" },
  { id: "c_right",label: "C",   x: 82,  y: 35, size: 34,  color: "rgba(200,180,40,0.85)" },
  { id: "c_down", label: "C",   x: 70,  y: 44, size: 34,  color: "rgba(200,180,40,0.85)" },
  { id: "c_left", label: "C",   x: 58,  y: 35, size: 34,  color: "rgba(200,180,40,0.85)" },
  { id: "a",      label: "A",   x: 78,  y: 63, size: 40,  color: "rgba(50,160,50,0.82)" },
  { id: "b",      label: "B",   x: 64,  y: 70, size: 40,  color: "rgba(180,130,30,0.82)" },
  { id: "start",  label: "STA", x: 45,  y: 90, size: 36,  color: "rgba(40,40,60,0.85)" },
];

/** PlayStation (PSX) — L2/R2 added below L1/R1, same face button diamond. */
const LAYOUT_PSX_LANDSCAPE: TouchButtonDef[] = [
  { id: "dpad",   label: "",    x: 11,  y: 65, size: 120, color: "rgba(35,35,55,0.85)", type: "dpad" },
  { id: "stick",  label: "",    x: 27,  y: 75, size: 78,  color: "rgba(35,35,55,0.80)", type: "stick" },
  { id: "l",      label: "L1",  x: 3,   y: 6,  size: 48,  color: "rgba(40,40,60,0.85)" },
  { id: "l2",     label: "L2",  x: 3,   y: 20, size: 48,  color: "rgba(40,40,60,0.85)" },
  { id: "r",      label: "R1",  x: 93,  y: 6,  size: 48,  color: "rgba(40,40,60,0.85)" },
  { id: "r2",     label: "R2",  x: 93,  y: 20, size: 48,  color: "rgba(40,40,60,0.85)" },
  { id: "a",      label: "○",   x: 90,  y: 65, size: 48,  color: "rgba(190,50,50,0.82)" },
  { id: "b",      label: "×",   x: 83,  y: 78, size: 48,  color: "rgba(190,130,30,0.82)" },
  { id: "x",      label: "△",   x: 83,  y: 52, size: 48,  color: "rgba(50,100,200,0.82)" },
  { id: "y",      label: "□",   x: 76,  y: 65, size: 48,  color: "rgba(50,160,80,0.82)" },
  { id: "select", label: "SEL", x: 39,  y: 90, size: 40,  color: "rgba(40,40,60,0.85)" },
  { id: "start",  label: "STA", x: 56,  y: 90, size: 40,  color: "rgba(40,40,60,0.85)" },
];

const LAYOUT_PSX_PORTRAIT: TouchButtonDef[] = [
  { id: "dpad",   label: "",    x: 15,  y: 70, size: 120, color: "rgba(35,35,55,0.85)", type: "dpad" },
  { id: "stick",  label: "",    x: 30,  y: 76, size: 78,  color: "rgba(35,35,55,0.80)", type: "stick" },
  { id: "l",      label: "L1",  x: 4,   y: 38, size: 48,  color: "rgba(40,40,60,0.85)" },
  { id: "l2",     label: "L2",  x: 4,   y: 52, size: 48,  color: "rgba(40,40,60,0.85)" },
  { id: "r",      label: "R1",  x: 92,  y: 38, size: 48,  color: "rgba(40,40,60,0.85)" },
  { id: "r2",     label: "R2",  x: 92,  y: 52, size: 48,  color: "rgba(40,40,60,0.85)" },
  { id: "a",      label: "○",   x: 88,  y: 69, size: 48,  color: "rgba(190,50,50,0.82)" },
  { id: "b",      label: "×",   x: 80,  y: 80, size: 48,  color: "rgba(190,130,30,0.82)" },
  { id: "x",      label: "△",   x: 80,  y: 58, size: 48,  color: "rgba(50,100,200,0.82)" },
  { id: "y",      label: "□",   x: 72,  y: 69, size: 48,  color: "rgba(50,160,80,0.82)" },
  { id: "select", label: "SEL", x: 37,  y: 91, size: 40,  color: "rgba(40,40,60,0.85)" },
  { id: "start",  label: "STA", x: 57,  y: 91, size: 40,  color: "rgba(40,40,60,0.85)" },
];

/**
 * Built-in default layout for a console before any user customisation.
 * Unknown ids fall back to the PlayStation-style full layout.
 */
export function getDefaultTouchLayoutForSystem(systemId: string, portrait: boolean): TouchButtonDef[] {
  const id = typeof systemId === "string" ? systemId.trim().toLowerCase() : "";
  const land = (): TouchButtonDef[] => {
    switch (id) {
      case "gb":
      case "gbc":
      case "lynx":
      case "ngp":
        return cloneLayout(LAYOUT_GB_GBC_LANDSCAPE);
      case "nes":
        return cloneLayout(LAYOUT_NES_LANDSCAPE);
      case "atari7800":
        return cloneLayout(LAYOUT_NES_LANDSCAPE);
      case "atari2600":
        return cloneLayout(LAYOUT_ATARI2600_LANDSCAPE);
      case "snes":
        return cloneLayout(LAYOUT_SNES_LANDSCAPE);
      case "gba":
      case "nds":
        return cloneLayout(layoutNintendoLetterFace(DEFAULT_LAYOUT));
      case "n64":
        return cloneLayout(LAYOUT_N64_LANDSCAPE);
      case "segaDC":
        return cloneLayout(layoutDreamcastFace(DEFAULT_LAYOUT));
      case "segaMD":
      case "segaGG":
      case "segaMS":
        return cloneLayout(LAYOUT_GENESIS_LANDSCAPE);
      case "psp":
        return cloneLayout(DEFAULT_LAYOUT);
      case "psx":
        return cloneLayout(LAYOUT_PSX_LANDSCAPE);
      case "segasaturn":
        return cloneLayout(LAYOUT_SATURN_LANDSCAPE);
      case "arcade":
      case "mame2003":
        return cloneLayout(LAYOUT_GENESIS_LANDSCAPE);
      default:
        return cloneLayout(DEFAULT_LAYOUT);
    }
  };
  const port = (): TouchButtonDef[] => {
    switch (id) {
      case "gb":
      case "gbc":
      case "lynx":
      case "ngp":
        return cloneLayout(LAYOUT_GB_GBC_PORTRAIT);
      case "nes":
      case "atari7800":
        return cloneLayout(LAYOUT_NES_PORTRAIT);
      case "atari2600":
        return cloneLayout(LAYOUT_ATARI2600_PORTRAIT);
      case "snes":
        return cloneLayout(LAYOUT_SNES_PORTRAIT);
      case "gba":
      case "nds":
        return cloneLayout(layoutNintendoLetterFace(DEFAULT_PORTRAIT_LAYOUT));
      case "n64":
        return cloneLayout(LAYOUT_N64_PORTRAIT);
      case "segaDC":
        return cloneLayout(layoutDreamcastFace(DEFAULT_PORTRAIT_LAYOUT));
      case "segaMD":
      case "segaGG":
      case "segaMS":
        return cloneLayout(LAYOUT_GENESIS_PORTRAIT);
      case "psp":
        return cloneLayout(DEFAULT_PORTRAIT_LAYOUT);
      case "psx":
        return cloneLayout(LAYOUT_PSX_PORTRAIT);
      case "segasaturn":
        return cloneLayout(LAYOUT_SATURN_PORTRAIT);
      case "arcade":
      case "mame2003":
        return cloneLayout(LAYOUT_GENESIS_PORTRAIT);
      default:
        return cloneLayout(DEFAULT_PORTRAIT_LAYOUT);
    }
  };
  return portrait ? port() : land();
}

// ── Layout persistence ────────────────────────────────────────────────────────

const LAYOUT_KEY_PREFIX          = "rv:touch-layout:";
const PORTRAIT_LAYOUT_KEY_PREFIX = "rv:touch-layout-portrait:";

/**
 * Load a saved layout for a system, or fall back to the orientation default.
 *
 * When `portrait` is true the portrait-optimised defaults and storage key are
 * used, giving each orientation an independent, persistable layout.
 *
 * The merge step ensures that buttons added in future versions always appear
 * at their default positions even when the saved blob pre-dates them.
 * Saved `size` values are also restored so users don't lose custom scaling.
 */
export function loadLayout(systemId: string, portrait = false): TouchButtonDef[] {
  const prefix   = portrait ? PORTRAIT_LAYOUT_KEY_PREFIX : LAYOUT_KEY_PREFIX;
  const defaults = getDefaultTouchLayoutForSystem(systemId, portrait);
  try {
    const raw = localStorage.getItem(`${prefix}${systemId}`);
    if (!raw) return defaults.map((b) => ({ ...b }));
    const saved = JSON.parse(raw) as Partial<TouchButtonDef>[];
    return defaults.map((def) => {
      const match = saved.find((s) => s.id === def.id);
      if (!match) return { ...def };
      return {
        ...def,
        x:    typeof match.x    === "number" ? match.x    : def.x,
        y:    typeof match.y    === "number" ? match.y    : def.y,
        size: typeof match.size === "number" ? match.size : def.size,
      };
    });
  } catch {
    return defaults.map((b) => ({ ...b }));
  }
}

/**
 * Persist the current layout for a system.
 *
 * Saves `{id, x, y, size}` so that both position and scale survive a reload.
 * Pass `portrait = true` to write to the portrait-specific storage slot.
 */
export function saveLayout(systemId: string, buttons: TouchButtonDef[], portrait = false): void {
  const prefix = portrait ? PORTRAIT_LAYOUT_KEY_PREFIX : LAYOUT_KEY_PREFIX;
  try {
    const minimal = buttons.map(({ id, x, y, size }) => ({ id, x, y, size }));
    localStorage.setItem(`${prefix}${systemId}`, JSON.stringify(minimal));
  } catch {
    // localStorage write failure is non-fatal
  }
}

/**
 * Reset the layout for a system to defaults.
 *
 * Pass `portrait = true` to reset the portrait-specific slot.
 */
export function resetLayout(systemId: string, portrait = false): TouchButtonDef[] {
  const prefix = portrait ? PORTRAIT_LAYOUT_KEY_PREFIX : LAYOUT_KEY_PREFIX;
  try {
    localStorage.removeItem(`${prefix}${systemId}`);
  } catch { /* ignore */ }
  return getDefaultTouchLayoutForSystem(systemId, portrait);
}
