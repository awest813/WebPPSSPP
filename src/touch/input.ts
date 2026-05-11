export interface TouchKeyBinding {
  key: string;
  code: string;
}

export const TOUCH_KEY_MAP: Record<string, TouchKeyBinding> = {
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
  c_up:        { key: "1",          code: "Digit1"     },
  c_down:      { key: "2",          code: "Digit2"     },
  c_left:      { key: "3",          code: "Digit3"     },
  c_right:     { key: "4",          code: "Digit4"     },
  z_btn:       { key: "5",          code: "Digit5"     },
  c_btn:       { key: "6",          code: "Digit6"     },
  l2:          { key: "Tab",        code: "Tab"        },
  r2:          { key: "r",          code: "KeyR"       },
};

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
