/**
 * touchControls.ts — Virtual gamepad overlay for touch devices
 *
 * Renders a set of draggable virtual buttons over the emulator canvas.
 * Button presses are forwarded to the emulator via synthetic keyboard events,
 * matching RetroArch/EmulatorJS default key bindings.
 *
 * Layout profiles are stored per system in localStorage so the user's
 * arrangement persists across sessions. Each button is independently
 * positioned as a percentage of the overlay dimensions, so layouts work
 * across different screen sizes and orientations.
 *
 * Haptic feedback via navigator.vibrate() fires on button press/release
 * when enabled — only on Android Chrome (iOS silently ignores it).
 */

// ── Key bindings (RetroArch defaults) ─────────────────────────────────────────

/**
 * Maps each virtual button id to the keyboard key that EmulatorJS/RetroArch
 * binds by default. These are the standard "player 1" defaults; users who
 * rebind keys in the EJS settings menu will need to remap here too.
 */
const KEY_MAP: Record<string, { key: string; code: string }> = {
  up:     { key: "ArrowUp",    code: "ArrowUp"    },
  down:   { key: "ArrowDown",  code: "ArrowDown"  },
  left:   { key: "ArrowLeft",  code: "ArrowLeft"  },
  right:  { key: "ArrowRight", code: "ArrowRight" },
  a:      { key: "z",          code: "KeyZ"       },
  b:      { key: "x",          code: "KeyX"       },
  x:      { key: "a",          code: "KeyA"       },
  y:      { key: "s",          code: "KeyS"       },
  l:      { key: "q",          code: "KeyQ"       },
  r:      { key: "w",          code: "KeyW"       },
  start:  { key: "Enter",      code: "Enter"      },
  select: { key: "Shift",      code: "ShiftLeft"  },
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
}

/** Default button layout for landscape orientation. */
export const DEFAULT_LAYOUT: TouchButtonDef[] = [
  // D-pad cluster — bottom left
  { id: "up",     label: "▲",   x: 11,  y: 52, size: 46, color: "rgba(60,60,80,0.82)"   },
  { id: "down",   label: "▼",   x: 11,  y: 78, size: 46, color: "rgba(60,60,80,0.82)"   },
  { id: "left",   label: "◀",   x: 5.5, y: 65, size: 46, color: "rgba(60,60,80,0.82)"   },
  { id: "right",  label: "▶",   x: 16.5,y: 65, size: 46, color: "rgba(60,60,80,0.82)"   },
  // Face buttons — bottom right (SNES/PS layout)
  { id: "a",      label: "A",   x: 90,  y: 65, size: 48, color: "rgba(190,50,50,0.82)"  },
  { id: "b",      label: "B",   x: 83,  y: 78, size: 48, color: "rgba(190,130,30,0.82)" },
  { id: "x",      label: "X",   x: 83,  y: 52, size: 48, color: "rgba(50,100,200,0.82)" },
  { id: "y",      label: "Y",   x: 76,  y: 65, size: 48, color: "rgba(50,160,80,0.82)"  },
  // Shoulder buttons — top corners
  { id: "l",      label: "L",   x: 3,   y: 8,  size: 52, color: "rgba(40,40,60,0.85)"   },
  { id: "r",      label: "R",   x: 93,  y: 8,  size: 52, color: "rgba(40,40,60,0.85)"   },
  // Meta buttons — bottom centre
  { id: "select", label: "SEL", x: 39,  y: 90, size: 40, color: "rgba(40,40,60,0.85)"   },
  { id: "start",  label: "STA", x: 56,  y: 90, size: 40, color: "rgba(40,40,60,0.85)"   },
];

/**
 * Default button layout for portrait orientation.
 *
 * Buttons are pushed lower and spread wider to stay in thumb reach when
 * the device is held vertically.  Shoulder buttons sit at mid-screen height
 * so they remain accessible without awkward finger stretching.
 */
export const DEFAULT_PORTRAIT_LAYOUT: TouchButtonDef[] = [
  // D-pad cluster — lower-left, spread to use the wider relative thumb zone
  { id: "up",     label: "▲",   x: 15,  y: 58, size: 46, color: "rgba(60,60,80,0.82)"   },
  { id: "down",   label: "▼",   x: 15,  y: 80, size: 46, color: "rgba(60,60,80,0.82)"   },
  { id: "left",   label: "◀",   x: 7,   y: 69, size: 46, color: "rgba(60,60,80,0.82)"   },
  { id: "right",  label: "▶",   x: 23,  y: 69, size: 46, color: "rgba(60,60,80,0.82)"   },
  // Face buttons — lower-right
  { id: "a",      label: "A",   x: 88,  y: 69, size: 48, color: "rgba(190,50,50,0.82)"  },
  { id: "b",      label: "B",   x: 80,  y: 80, size: 48, color: "rgba(190,130,30,0.82)" },
  { id: "x",      label: "X",   x: 80,  y: 58, size: 48, color: "rgba(50,100,200,0.82)" },
  { id: "y",      label: "Y",   x: 72,  y: 69, size: 48, color: "rgba(50,160,80,0.82)"  },
  // Shoulder buttons — mid-screen corners so thumbs can reach without moving the hand
  { id: "l",      label: "L",   x: 4,   y: 42, size: 52, color: "rgba(40,40,60,0.85)"   },
  { id: "r",      label: "R",   x: 92,  y: 42, size: 52, color: "rgba(40,40,60,0.85)"   },
  // Meta buttons — bottom centre
  { id: "select", label: "SEL", x: 37,  y: 91, size: 40, color: "rgba(40,40,60,0.85)"   },
  { id: "start",  label: "STA", x: 57,  y: 91, size: 40, color: "rgba(40,40,60,0.85)"   },
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
 *   overlay.show();          // show during gameplay
 *   overlay.hide();          // hide when returning to library
 *   overlay.setEditing(true); // enter drag-to-reposition mode
 *   overlay.destroy();       // clean up on page unload
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
  private _pressedKeys = new Set<string>();
  private _portrait: boolean;
  private _orientationHandler: (() => void) | null = null;

  /** Called when the layout is saved (after drag ends in edit mode). */
  onLayoutSaved?: (systemId: string, layout: TouchButtonDef[]) => void;

  constructor(container: HTMLElement, systemId: string, hapticEnabled = true) {
    this._container = container;
    this._systemId = systemId;
    this._hapticEnabled = hapticEnabled;
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
    // Leaving gameplay should always exit edit mode so the next session
    // starts in normal play mode.
    this._editing = false;
    this._releaseAllKeys();
    this._overlay?.remove();
    this._overlay = null;
    this._buttonEls.clear();
  }

  setEditing(editing: boolean): void {
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
    this._build();
  }

  private _build(): void {
    const overlay = document.createElement("div");
    overlay.className = "touch-controls";
    overlay.setAttribute("aria-hidden", "true");

    for (const btn of this._buttons) {
      const el = this._buildButton(btn);
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
    const el = document.createElement("div");
    el.className = "tc-btn";
    el.dataset.btnId = btn.id;
    el.textContent = btn.label;
    el.style.cssText = [
      `left:${btn.x}%`,
      `top:${btn.y}%`,
      `width:${btn.size}px`,
      `height:${btn.size}px`,
      `margin-left:-${btn.size / 2}px`,
      `margin-top:-${btn.size / 2}px`,
      `background:${btn.color}`,
    ].join(";");

    this._bindButton(el, btn);
    return el;
  }

  private _bindButton(el: HTMLElement, btn: TouchButtonDef): void {
    const keyDef = KEY_MAP[btn.id];

    // ── Edit mode: drag to reposition ───────────────────────────────────────
    let dragActive = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let origX = btn.x;
    let origY = btn.y;

    const onDragStart = (cx: number, cy: number) => {
      if (!this._editing) return false;
      dragActive = true;
      dragStartX = cx;
      dragStartY = cy;
      origX = btn.x;
      origY = btn.y;
      el.style.cursor = "grabbing";
      return true;
    };

    const onDragMove = (cx: number, cy: number) => {
      if (!dragActive || !this._overlay) return;
      const rect = this._overlay.getBoundingClientRect();
      const dx = ((cx - dragStartX) / rect.width)  * 100;
      const dy = ((cy - dragStartY) / rect.height) * 100;
      btn.x = Math.max(0, Math.min(100, origX + dx));
      btn.y = Math.max(0, Math.min(100, origY + dy));
      el.style.left = `${btn.x}%`;
      el.style.top  = `${btn.y}%`;
    };

    const onDragEnd = () => {
      if (!dragActive) return;
      dragActive = false;
      el.style.cursor = "grab";
      saveLayout(this._systemId, this._buttons, this._portrait);
      this.onLayoutSaved?.(this._systemId, this._buttons);
    };

    // ── Play mode: press/release → key events ───────────────────────────────
    // Track active touch count so that a key is only released when the last
    // finger leaves the button. Without this, lifting one finger while a
    // second is still on the same button would prematurely release the key.
    //
    // JavaScript is single-threaded; touch event handlers run serially on the
    // event loop, so there are no concurrent-modification concerns here.
    //
    // The counter is guarded by Math.max(0, ...) on decrement as a safety net
    // for browsers that occasionally fire touchend/touchcancel for a touch
    // point that was never seen in a corresponding touchstart (e.g. when the
    // element is created while a touch sequence is already in progress). In
    // normal operation the counter should never go negative.
    let activeTouchCount = 0;

    const pressKey = () => {
      if (this._editing || !keyDef) return;
      if (this._pressedKeys.has(btn.id)) return;
      this._pressedKeys.add(btn.id);
      if (this._hapticEnabled) vibratePress();
      el.classList.add("tc-btn--pressed");
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key:      keyDef.key,
        code:     keyDef.code,
        bubbles:  true,
        cancelable: true,
      }));
    };

    const releaseKey = () => {
      if (this._editing || !keyDef) return;
      if (!this._pressedKeys.has(btn.id)) return;
      this._pressedKeys.delete(btn.id);
      if (this._hapticEnabled) vibrateRelease();
      el.classList.remove("tc-btn--pressed");
      document.dispatchEvent(new KeyboardEvent("keyup", {
        key:      keyDef.key,
        code:     keyDef.code,
        bubbles:  true,
        cancelable: true,
      }));
    };

    // Touch events
    el.addEventListener("touchstart", (e) => {
      e.preventDefault();
      // Use the first changed touch for drag-start tracking; press the key
      // when the first finger lands on this button.
      const first = e.changedTouches[0];
      if (!onDragStart(first.clientX, first.clientY)) {
        activeTouchCount += e.changedTouches.length;
        pressKey();
      }
    }, { passive: false });

    el.addEventListener("touchmove", (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      onDragMove(t.clientX, t.clientY);
    }, { passive: false });

    el.addEventListener("touchend", (e) => {
      e.preventDefault();
      onDragEnd();
      activeTouchCount = Math.max(0, activeTouchCount - e.changedTouches.length);
      // Only release the key when the last active touch leaves the button.
      if (activeTouchCount === 0) releaseKey();
    }, { passive: false });

    el.addEventListener("touchcancel", (e) => {
      e.preventDefault();
      onDragEnd();
      activeTouchCount = Math.max(0, activeTouchCount - e.changedTouches.length);
      if (activeTouchCount === 0) releaseKey();
    }, { passive: false });

    // Mouse events (fallback for desktop testing).
    // Attach mousemove/mouseup to document on drag start so the button keeps
    // tracking even when the cursor moves outside the element boundary.
    el.addEventListener("mousedown", (e) => {
      if (!onDragStart(e.clientX, e.clientY)) {
        pressKey();
        return;
      }
      const onMove = (ev: MouseEvent) => onDragMove(ev.clientX, ev.clientY);
      const onUp   = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        onDragEnd();
        releaseKey();
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    // Release the key on mouseup in play mode (non-drag path).
    el.addEventListener("mouseup", () => {
      if (!dragActive) releaseKey();
    });
  }

  /** Release all currently-held virtual keys (on hide or swipe-away). */
  private _releaseAllKeys(): void {
    for (const id of this._pressedKeys) {
      const keyDef = KEY_MAP[id];
      if (!keyDef) continue;
      document.dispatchEvent(new KeyboardEvent("keyup", {
        key:      keyDef.key,
        code:     keyDef.code,
        bubbles:  true,
        cancelable: true,
      }));
    }
    this._pressedKeys.clear();
    for (const el of this._buttonEls.values()) {
      el.classList.remove("tc-btn--pressed");
    }
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
