/**
 * touchControls.ts — Virtual gamepad overlay for touch devices
 *
 * Renders a virtual gamepad over the emulator canvas.  Button presses are
 * forwarded to the emulator via synthetic keyboard events, matching the
 * RetroArch/EmulatorJS default key bindings.
 *
 * Overhaul highlights:
 *   - D-pad is now a single cross-shaped element that supports 8-way
 *     (diagonal) directional input via angle-based detection.  The four
 *     separate circular arrow buttons have been replaced by this element.
 *   - All event handling has been migrated from the legacy split
 *     (touchstart/touchmove/touchend + mousedown/mousemove/mouseup) to the
 *     unified Pointer Events API (pointerdown/pointermove/pointerup/
 *     pointercancel).  setPointerCapture() ensures pressed inputs remain
 *     tracked even when the pointer slides outside the element boundary —
 *     no document-level listener hacks required.
 *   - Multi-touch is handled by tracking a Set<number> of active pointer IDs
 *     instead of an integer counter, making the semantics explicit.
 *
 * Layout profiles are stored per system in localStorage so the user's
 * arrangement persists across sessions.  Each button is independently
 * positioned as a percentage of the overlay dimensions, so layouts work
 * across different screen sizes and orientations.
 *
 * Haptic feedback via navigator.vibrate() fires on button press/release
 * when enabled — only on Android Chrome (iOS silently ignores it).
 */

// ── Key bindings (EmulatorJS defaults) ────────────────────────────────────────

/**
 * Maps each virtual button id to the keyboard key that EmulatorJS binds by
 * default for player 1.  These match the `defaultControllers[0]` entries in
 * emulator.js:
 *   button 0  (Cross/A)    → x
 *   button 8  (Circle/B)   → z
 *   button 9  (Triangle/X) → a
 *   button 1  (Square/Y)   → s
 *   button 10 (L)          → q
 *   button 11 (R)          → e
 *   button 2  (Select)     → v
 *   button 3  (Start)      → Enter
 *   analog right (16)      → h
 *   analog left  (17)      → f
 *   analog down  (18)      → g
 *   analog up    (19)      → t
 *
 * The D-pad directions (up/down/left/right) are also present here so that
 * the cross-shaped D-pad element can fire the correct key events.
 */
const KEY_MAP: Record<string, { key: string; code: string }> = {
  up:          { key: "ArrowUp",    code: "ArrowUp"    },
  down:        { key: "ArrowDown",  code: "ArrowDown"  },
  left:        { key: "ArrowLeft",  code: "ArrowLeft"  },
  right:       { key: "ArrowRight", code: "ArrowRight" },
  a:           { key: "z",          code: "KeyZ"       },
  b:           { key: "x",          code: "KeyX"       },
  x:           { key: "a",          code: "KeyA"       },
  y:           { key: "s",          code: "KeyS"       },
  l:           { key: "q",          code: "KeyQ"       },
  r:           { key: "e",          code: "KeyE"       },
  start:       { key: "Enter",      code: "Enter"      },
  select:      { key: "v",          code: "KeyV"       },
  stick_right: { key: "h",          code: "KeyH"       },
  stick_left:  { key: "f",          code: "KeyF"       },
  stick_down:  { key: "g",          code: "KeyG"       },
  stick_up:    { key: "t",          code: "KeyT"       },
};

// ── Button definitions ────────────────────────────────────────────────────────

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
   *   `stick_up/down/left/right` in KEY_MAP.
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
  const defaults = portrait ? DEFAULT_PORTRAIT_LAYOUT     : DEFAULT_LAYOUT;
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
  return (portrait ? DEFAULT_PORTRAIT_LAYOUT : DEFAULT_LAYOUT).map((b) => ({ ...b }));
}

// ── Haptic feedback ───────────────────────────────────────────────────────────

/** Vibrate briefly on button press. No-op if not supported (iOS, desktop). */
export function vibratePress(): void {
  try {
    navigator.vibrate?.(12);
  } catch { /* ignore */ }
}

/** Vibrate briefly on button release (lighter than press). */
export function vibrateRelease(): void {
  try {
    navigator.vibrate?.(6);
  } catch { /* ignore */ }
}

// ── TouchControlsOverlay ─────────────────────────────────────────────────────

/**
 * Manages the virtual gamepad overlay DOM and interaction model.
 *
 * Usage:
 *   const overlay = new TouchControlsOverlay(container, systemId);
 *   overlay.show();           // show during gameplay
 *   overlay.hide();           // hide when returning to library
 *   overlay.setEditing(true); // enter drag-to-reposition mode
 *   overlay.destroy();        // clean up on page unload
 */
export class TouchControlsOverlay {
  private _container: HTMLElement;
  private _overlay: HTMLElement | null = null;
  private _systemId: string;
  private _buttons: TouchButtonDef[] = [];
  private _buttonEls: Map<string, HTMLElement> = new Map();
  private _visible = false;
  private _editing = false;
  private _hapticEnabled: boolean;
  private _opacity: number;
  private _scale: number;
  private _pressedKeys = new Set<string>();
  private _portrait: boolean;
  private _orientationHandler: (() => void) | null = null;
  /**
   * Cleanup callback set by _bindDpad to release its internal active-direction
   * Set when keys need to be force-released (e.g. entering edit mode).
   */
  private _dpadCleanup: (() => void) | null = null;

  /** Called when the layout is saved (after drag ends in edit mode). */
  onLayoutSaved?: (systemId: string, layout: TouchButtonDef[]) => void;

  constructor(container: HTMLElement, systemId: string, hapticEnabled = true, opacity = 0.85, scale = 1.0) {
    this._container = container;
    this._systemId = systemId;
    this._hapticEnabled = hapticEnabled;
    this._opacity = Math.max(0.1, Math.min(1, opacity));
    this._scale   = Math.max(0.5, Math.min(2, scale));
    this._portrait = isPortrait();
    this._buttons = loadLayout(systemId, this._portrait);

    // Listen for orientation changes and swap to the appropriate layout.
    // The `nowPortrait === this._portrait` guard at the top of the handler
    // means that even if both `orientationchange` and `resize` fire for a
    // single physical rotation, the (expensive) layout reload and DOM rebuild
    // only runs once.
    this._orientationHandler = () => {
      const nowPortrait = isPortrait();
      if (nowPortrait === this._portrait) return;
      this._portrait = nowPortrait;
      this._buttons = loadLayout(this._systemId, this._portrait);
      if (this._visible) this._rebuild();
    };
    window.addEventListener("orientationchange", this._orientationHandler);
    // `resize` catches browsers (notably some desktop Chromium builds) that
    // fire resize instead of orientationchange when the viewport rotates.
    window.addEventListener("resize", this._orientationHandler);
  }

  /** True when the overlay is currently visible. */
  get visible(): boolean { return this._visible; }

  /** True when in drag-to-edit mode. */
  get editing(): boolean { return this._editing; }

  /** Change haptic feedback on/off at runtime. */
  setHapticEnabled(enabled: boolean): void {
    this._hapticEnabled = enabled;
  }

  /** Change button opacity (0.1–1.0) at runtime. */
  setOpacity(opacity: number): void {
    const clamped = Math.max(0.1, Math.min(1, opacity));
    if (clamped === this._opacity) return;
    this._opacity = clamped;
    if (this._overlay) {
      this._overlay.style.setProperty("--tc-opacity", String(this._opacity));
    }
  }

  /** Change global button scale (0.5–2.0) at runtime — rebuilds DOM if visible. */
  setScale(scale: number): void {
    const clamped = Math.max(0.5, Math.min(2, scale));
    if (clamped === this._scale) return;
    this._scale = clamped;
    if (this._visible) this._rebuild();
  }

  /** Swap to a different system (reloads its layout). */
  setSystem(systemId: string): void {
    this._systemId = systemId;
    this._buttons = loadLayout(systemId, this._portrait);
    if (this._visible) this._rebuild();
  }

  show(): void {
    if (this._visible) return;
    this._visible = true;
    this._build();
  }

  hide(): void {
    if (!this._visible) return;
    this._visible = false;
    // Leaving gameplay always exits edit mode so the next session
    // starts in normal play mode.
    this._editing = false;
    this._releaseAllKeys();
    this._overlay?.remove();
    this._overlay = null;
    this._buttonEls.clear();
    this._dpadCleanup = null;
  }

  setEditing(editing: boolean): void {
    // Release all currently-held inputs before entering edit mode so that no
    // key gets stuck while the user is dragging buttons around.
    if (editing && !this._editing) {
      this._releaseAllKeys();
    }
    this._editing = editing;
    if (!this._overlay) return;
    this._overlay.classList.toggle("touch-controls--editing", editing);
    // Update each button's cursor and add/remove edit label
    for (const el of this._buttonEls.values()) {
      el.style.cursor = editing ? "grab" : "";
      const editHint = el.querySelector(".tc-edit-hint");
      if (editing && !editHint) {
        const hint = document.createElement("span");
        hint.className = "tc-edit-hint";
        hint.textContent = "✥";
        el.appendChild(hint);
      } else if (!editing && editHint) {
        editHint.remove();
      }
      // When entering edit mode, reset any displaced stick knob to centre so
      // the user doesn't see a stuck-offset knob while repositioning the stick.
      if (editing && el.classList.contains("tc-stick")) {
        el.classList.remove("tc-stick--active");
        const knob = el.querySelector<HTMLElement>(".tc-stick__knob");
        if (knob) knob.style.transform = "translate(-50%, -50%)";
      }
    }
  }

  /** Reset layout for the current system to defaults. */
  resetToDefaults(): void {
    this._buttons = resetLayout(this._systemId, this._portrait);
    if (this._visible) this._rebuild();
    this.onLayoutSaved?.(this._systemId, this._buttons);
  }

  destroy(): void {
    if (this._orientationHandler) {
      window.removeEventListener("orientationchange", this._orientationHandler);
      window.removeEventListener("resize", this._orientationHandler);
      this._orientationHandler = null;
    }
    this.hide();
  }

  // ── Private: DOM building ─────────────────────────────────────────────────

  private _rebuild(): void {
    this._releaseAllKeys();
    this._overlay?.remove();
    this._overlay = null;
    this._buttonEls.clear();
    this._dpadCleanup = null;
    this._build();
  }

  private _build(): void {
    const overlay = document.createElement("div");
    overlay.className = "touch-controls";
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.setProperty("--tc-opacity", String(this._opacity));

    for (const btn of this._buttons) {
      const el =
        btn.type === "stick" ? this._buildStick(btn) :
        btn.type === "dpad"  ? this._buildDpad(btn)  :
        this._buildButton(btn);
      overlay.appendChild(el);
      this._buttonEls.set(btn.id, el);
    }

    if (this._editing) {
      overlay.classList.add("touch-controls--editing");
    }

    this._container.appendChild(overlay);
    this._overlay = overlay;

    // Re-apply editing visuals when rebuilding while edit mode is active
    // (e.g. system change with overlay already visible).
    this.setEditing(this._editing);
  }

  private _buildButton(btn: TouchButtonDef): HTMLElement {
    const scaled = Math.round(btn.size * this._scale);
    const el = document.createElement("div");
    el.className = "tc-btn";
    el.dataset.btnId = btn.id;
    el.textContent = btn.label;
    el.style.cssText = [
      `left:${btn.x}%`,
      `top:${btn.y}%`,
      `width:${scaled}px`,
      `height:${scaled}px`,
      `margin-left:-${scaled / 2}px`,
      `margin-top:-${scaled / 2}px`,
      `background:${btn.color}`,
    ].join(";");

    this._bindButton(el, btn);
    return el;
  }

  /**
   * Build a cross-shaped directional pad element.
   *
   * The outer element is a square whose full bounding box acts as the touch
   * target.  Five inner divs (up/down/left/right arms + center) form the
   * visible cross/plus shape.  Touches anywhere in the bounding box fire
   * directional keys based on the angle from the center; corners naturally
   * produce diagonal (two-key) inputs.
   */
  private _buildDpad(btn: TouchButtonDef): HTMLElement {
    const scaled = Math.round(btn.size * this._scale);
    const outer = document.createElement("div");
    outer.className = "tc-dpad";
    outer.dataset.btnId = btn.id;
    outer.style.cssText = [
      `left:${btn.x}%`,
      `top:${btn.y}%`,
      `width:${scaled}px`,
      `height:${scaled}px`,
      `margin-left:-${scaled / 2}px`,
      `margin-top:-${scaled / 2}px`,
    ].join(";");

    // Create the four directional arm divs and the center piece.
    const armDirs: { id: "up" | "down" | "left" | "right"; label: string }[] = [
      { id: "up",    label: "▲" },
      { id: "down",  label: "▼" },
      { id: "left",  label: "◀" },
      { id: "right", label: "▶" },
    ];
    const arms = new Map<string, HTMLElement>();
    for (const { id, label } of armDirs) {
      const arm = document.createElement("div");
      arm.className = `tc-dpad__arm tc-dpad__arm--${id}`;
      arm.textContent = label;
      arm.style.background = btn.color;
      outer.appendChild(arm);
      arms.set(id, arm);
    }
    const center = document.createElement("div");
    center.className = "tc-dpad__center";
    center.style.background = btn.color;
    outer.appendChild(center);

    this._bindDpad(outer, arms, btn, scaled);
    return outer;
  }

  /**
   * Bind pointer events to the cross-shaped D-pad element.
   *
   * Direction is determined by the angle of the pointer relative to the
   * element's centre.  Two keys fire simultaneously for diagonal inputs
   * (e.g. up + right when touching the top-right quadrant).
   *
   * A dead-zone radius (12 % of half the element size) suppresses accidental
   * firing when the finger is resting near the centre.
   *
   * In edit mode the element drags as a whole unit instead of firing keys.
   */
  private _bindDpad(
    outer: HTMLElement,
    arms: Map<string, HTMLElement>,
    btn: TouchButtonDef,
    scaledSize: number,
  ): void {
    const DEAD_ZONE  = scaledSize * 0.06; // 6% of element size
    // A direction fires when its component exceeds 40% of the distance from
    // centre.  This gives ~24° pure-cardinal zones and ~45° diagonal zones.
    const DIAGONAL_THRESHOLD = 0.4;

    const active = new Set<string>(); // D-pad directions currently pressed

    // Expose a cleanup function so _releaseAllKeys() can clear this Set.
    this._dpadCleanup = () => {
      for (const id of [...active]) {
        active.delete(id);
        arms.get(id)?.classList.remove("tc-dpad__arm--active");
      }
      outer.classList.remove("tc-dpad--active");
    };

    const fireDir = (id: string) => {
      if (active.has(id) || this._editing) return;
      active.add(id);
      const kd = KEY_MAP[id];
      if (!kd) return;
      this._pressedKeys.add(id);
      if (this._hapticEnabled) vibratePress();
      arms.get(id)?.classList.add("tc-dpad__arm--active");
      outer.classList.add("tc-dpad--active");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: kd.key, code: kd.code, bubbles: true, cancelable: true }));
    };

    const releaseDir = (id: string) => {
      if (!active.has(id)) return;
      active.delete(id);
      const kd = KEY_MAP[id];
      if (!kd) return;
      this._pressedKeys.delete(id);
      if (this._hapticEnabled) vibrateRelease();
      arms.get(id)?.classList.remove("tc-dpad__arm--active");
      if (active.size === 0) outer.classList.remove("tc-dpad--active");
      document.dispatchEvent(new KeyboardEvent("keyup", { key: kd.key, code: kd.code, bubbles: true, cancelable: true }));
    };

    const releaseAll = () => {
      for (const id of [...active]) releaseDir(id);
    };

    /** Compute which directions should be active for a pointer at (cx, cy). */
    const getDirs = (cx: number, cy: number): Set<string> => {
      const rect = outer.getBoundingClientRect();
      const dx   = cx - (rect.left + rect.width  / 2);
      const dy   = cy - (rect.top  + rect.height / 2);
      const dist = Math.sqrt(dx * dx + dy * dy);
      const dirs = new Set<string>();
      if (dist < DEAD_ZONE) return dirs;
      if (dy < -dist * DIAGONAL_THRESHOLD) dirs.add("up");
      if (dy >  dist * DIAGONAL_THRESHOLD) dirs.add("down");
      if (dx < -dist * DIAGONAL_THRESHOLD) dirs.add("left");
      if (dx >  dist * DIAGONAL_THRESHOLD) dirs.add("right");
      return dirs;
    };

    const updateDirs = (cx: number, cy: number) => {
      const newDirs = getDirs(cx, cy);
      // Release directions no longer active
      for (const id of [...active]) {
        if (!newDirs.has(id)) releaseDir(id);
      }
      // Fire newly active directions
      for (const id of newDirs) fireDir(id);
    };

    // ── Edit-mode drag ────────────────────────────────────────────────────
    let dragPointerId = -1;
    let dragStartX = 0, dragStartY = 0;
    let origX = btn.x, origY = btn.y;

    // ── Play-mode pointer tracking ────────────────────────────────────────
    // Track only the first pointer that lands on the D-pad; subsequent
    // simultaneous pointers are ignored (multi-finger D-pad isn't useful).
    let playPointerId = -1;

    outer.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      outer.setPointerCapture(e.pointerId);

      if (this._editing) {
        if (dragPointerId !== -1) return; // already dragging
        dragPointerId = e.pointerId;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        origX = btn.x;
        origY = btn.y;
        outer.style.cursor = "grabbing";
        return;
      }

      if (playPointerId !== -1) return; // already tracking a pointer
      playPointerId = e.pointerId;
      updateDirs(e.clientX, e.clientY);
    }, { passive: false });

    outer.addEventListener("pointermove", (e) => {
      if (dragPointerId === e.pointerId) {
        if (!this._overlay) return;
        const rect = this._overlay.getBoundingClientRect();
        btn.x = Math.max(0, Math.min(100, origX + ((e.clientX - dragStartX) / rect.width)  * 100));
        btn.y = Math.max(0, Math.min(100, origY + ((e.clientY - dragStartY) / rect.height) * 100));
        outer.style.left = `${btn.x}%`;
        outer.style.top  = `${btn.y}%`;
        return;
      }
      if (e.pointerId === playPointerId) {
        updateDirs(e.clientX, e.clientY);
      }
    });

    const onPointerEnd = (e: PointerEvent) => {
      if (dragPointerId === e.pointerId) {
        dragPointerId = -1;
        outer.style.cursor = "grab";
        saveLayout(this._systemId, this._buttons, this._portrait);
        this.onLayoutSaved?.(this._systemId, this._buttons);
        return;
      }
      if (e.pointerId === playPointerId) {
        playPointerId = -1;
        releaseAll();
      }
    };

    outer.addEventListener("pointerup",     onPointerEnd);
    outer.addEventListener("pointercancel", onPointerEnd);
  }

  /**
   * Build a draggable analog joystick element.
   *
   * The stick zone is a fixed outer circle.  A smaller inner dot ("knob")
   * tracks the user's finger within the zone and shows the current deflection.
   * Movement is mapped to stick_up/down/left/right key events with a ~25%
   * dead-zone so accidental grazes don't trigger inputs.
   */
  private _buildStick(btn: TouchButtonDef): HTMLElement {
    const scaled = Math.round(btn.size * this._scale);
    const outer = document.createElement("div");
    outer.className = "tc-stick";
    outer.dataset.btnId = btn.id;
    outer.style.cssText = [
      `left:${btn.x}%`,
      `top:${btn.y}%`,
      `width:${scaled}px`,
      `height:${scaled}px`,
      `margin-left:-${scaled / 2}px`,
      `margin-top:-${scaled / 2}px`,
      `background:${btn.color}`,
    ].join(";");

    const knobSize = Math.round(scaled * 0.44);
    const knob = document.createElement("div");
    knob.className = "tc-stick__knob";
    knob.style.cssText = `width:${knobSize}px;height:${knobSize}px;`;
    outer.appendChild(knob);

    this._bindStick(outer, knob, btn, scaled);
    return outer;
  }

  private _bindStick(outer: HTMLElement, knob: HTMLElement, btn: TouchButtonDef, scaledSize: number): void {
    const radius   = scaledSize / 2;
    const maxMove  = radius * 0.52;  // knob travel range
    const deadZone = 0.25;           // fraction of maxMove before input fires

    // Currently-active stick key IDs (stick_up / stick_down / etc.)
    const active = new Set<string>();

    const fireKey = (id: string) => {
      if (active.has(id) || this._editing) return;
      active.add(id);
      const kd = KEY_MAP[id];
      if (!kd) return;
      this._pressedKeys.add(id);
      if (this._hapticEnabled) vibratePress();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: kd.key, code: kd.code, bubbles: true, cancelable: true }));
    };

    const releaseKey = (id: string) => {
      if (!active.has(id)) return;
      active.delete(id);
      const kd = KEY_MAP[id];
      if (!kd) return;
      this._pressedKeys.delete(id);
      if (this._hapticEnabled) vibrateRelease();
      document.dispatchEvent(new KeyboardEvent("keyup", { key: kd.key, code: kd.code, bubbles: true, cancelable: true }));
    };

    const releaseAll = () => {
      for (const id of [...active]) releaseKey(id);
      knob.style.transform = "translate(-50%, -50%)";
    };

    const onPlayMove = (cx: number, cy: number) => {
      if (this._editing) return;
      const rect   = outer.getBoundingClientRect();
      const dx     = cx - (rect.left + rect.width  / 2);
      const dy     = cy - (rect.top  + rect.height / 2);
      const dist   = Math.sqrt(dx * dx + dy * dy);

      // Clamp knob within the travel range
      const clamped = Math.min(dist, maxMove);
      const angle   = Math.atan2(dy, dx);
      const kx      = clamped * Math.cos(angle);
      const ky      = clamped * Math.sin(angle);
      knob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;

      const threshold = maxMove * deadZone;
      if (dx >  threshold) fireKey("stick_right"); else releaseKey("stick_right");
      if (dx < -threshold) fireKey("stick_left");  else releaseKey("stick_left");
      if (dy >  threshold) fireKey("stick_down");  else releaseKey("stick_down");
      if (dy < -threshold) fireKey("stick_up");    else releaseKey("stick_up");
    };

    const setPlayActive = (isActive: boolean) => {
      outer.classList.toggle("tc-stick--active", isActive);
    };

    // ── Edit-mode drag ────────────────────────────────────────────────────
    let dragPointerId = -1;
    let dragStartX = 0, dragStartY = 0;
    let origX = btn.x, origY = btn.y;

    // ── Play-mode pointer tracking ────────────────────────────────────────
    let playPointerId = -1;

    outer.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      outer.setPointerCapture(e.pointerId);

      if (this._editing) {
        if (dragPointerId !== -1) return;
        dragPointerId = e.pointerId;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        origX = btn.x;
        origY = btn.y;
        outer.style.cursor = "grabbing";
        return;
      }

      if (playPointerId !== -1) return;
      playPointerId = e.pointerId;
      setPlayActive(true);
      onPlayMove(e.clientX, e.clientY);
    }, { passive: false });

    outer.addEventListener("pointermove", (e) => {
      if (dragPointerId === e.pointerId) {
        if (!this._overlay) return;
        const rect = this._overlay.getBoundingClientRect();
        btn.x = Math.max(0, Math.min(100, origX + ((e.clientX - dragStartX) / rect.width)  * 100));
        btn.y = Math.max(0, Math.min(100, origY + ((e.clientY - dragStartY) / rect.height) * 100));
        outer.style.left = `${btn.x}%`;
        outer.style.top  = `${btn.y}%`;
        return;
      }
      if (e.pointerId === playPointerId) {
        onPlayMove(e.clientX, e.clientY);
      }
    });

    const onPointerEnd = (e: PointerEvent) => {
      if (dragPointerId === e.pointerId) {
        dragPointerId = -1;
        outer.style.cursor = "grab";
        saveLayout(this._systemId, this._buttons, this._portrait);
        this.onLayoutSaved?.(this._systemId, this._buttons);
        return;
      }
      if (e.pointerId === playPointerId) {
        playPointerId = -1;
        setPlayActive(false);
        releaseAll();
      }
    };

    outer.addEventListener("pointerup",     onPointerEnd);
    outer.addEventListener("pointercancel", onPointerEnd);
  }

  private _bindButton(el: HTMLElement, btn: TouchButtonDef): void {
    const keyDef = KEY_MAP[btn.id];

    // ── Edit mode: drag to reposition ────────────────────────────────────────
    let dragPointerId = -1;
    let dragStartX = 0, dragStartY = 0;
    let origX = btn.x, origY = btn.y;

    // ── Play mode: track active pointer IDs so the key is released only
    //   when the last finger lifts.  Using a Set of pointer IDs makes the
    //   semantics explicit and handles simultaneous presses correctly.
    const activePointers = new Set<number>();

    const pressKey = () => {
      if (this._editing || !keyDef) return;
      if (this._pressedKeys.has(btn.id)) return;
      this._pressedKeys.add(btn.id);
      if (this._hapticEnabled) vibratePress();
      el.classList.add("tc-btn--pressed");
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: keyDef.key, code: keyDef.code, bubbles: true, cancelable: true,
      }));
    };

    const releaseKey = () => {
      if (!keyDef) return;
      if (!this._pressedKeys.has(btn.id)) return;
      this._pressedKeys.delete(btn.id);
      if (this._hapticEnabled) vibrateRelease();
      el.classList.remove("tc-btn--pressed");
      document.dispatchEvent(new KeyboardEvent("keyup", {
        key: keyDef.key, code: keyDef.code, bubbles: true, cancelable: true,
      }));
    };

    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);

      if (this._editing) {
        if (dragPointerId !== -1) return; // already dragging with another pointer
        dragPointerId = e.pointerId;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        origX = btn.x;
        origY = btn.y;
        el.style.cursor = "grabbing";
        return;
      }

      activePointers.add(e.pointerId);
      pressKey();
    }, { passive: false });

    el.addEventListener("pointermove", (e) => {
      if (dragPointerId === e.pointerId) {
        if (!this._overlay) return;
        const rect = this._overlay.getBoundingClientRect();
        btn.x = Math.max(0, Math.min(100, origX + ((e.clientX - dragStartX) / rect.width)  * 100));
        btn.y = Math.max(0, Math.min(100, origY + ((e.clientY - dragStartY) / rect.height) * 100));
        el.style.left = `${btn.x}%`;
        el.style.top  = `${btn.y}%`;
      }
    });

    const onPointerEnd = (e: PointerEvent) => {
      if (dragPointerId === e.pointerId) {
        dragPointerId = -1;
        el.style.cursor = "grab";
        saveLayout(this._systemId, this._buttons, this._portrait);
        this.onLayoutSaved?.(this._systemId, this._buttons);
        return;
      }
      activePointers.delete(e.pointerId);
      if (activePointers.size === 0) releaseKey();
    };

    el.addEventListener("pointerup",     onPointerEnd);
    el.addEventListener("pointercancel", onPointerEnd);
  }

  /** Release all currently-held virtual keys (on hide or entering edit mode). */
  private _releaseAllKeys(): void {
    for (const id of this._pressedKeys) {
      const keyDef = KEY_MAP[id];
      if (!keyDef) continue;
      document.dispatchEvent(new KeyboardEvent("keyup", {
        key: keyDef.key, code: keyDef.code, bubbles: true, cancelable: true,
      }));
    }
    this._pressedKeys.clear();
    for (const el of this._buttonEls.values()) {
      el.classList.remove("tc-btn--pressed");
    }
    // Clear the D-pad's internal active-direction Set and arm highlighting.
    this._dpadCleanup?.();
  }
}

// ── Utility: detect touch capability ─────────────────────────────────────────

/** True when the primary input is a touchscreen (not a mouse). */
export function isTouchDevice(): boolean {
  return (
    "ontouchstart" in window ||
    navigator.maxTouchPoints > 0
  );
}

/** True when the viewport is currently in portrait orientation. */
export function isPortrait(): boolean {
  if (typeof window === "undefined") return false;
  try {
    // matchMedia is widely supported and more reliable than window.innerWidth/Height
    // comparisons when the virtual keyboard is open.
    return window.matchMedia("(orientation: portrait)").matches;
  } catch {
    // Fallback for environments where matchMedia is unavailable (e.g. jsdom in tests).
    return window.innerHeight > window.innerWidth;
  }
}
