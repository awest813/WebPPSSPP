export {
  getTouchControlsDefaultForSystem,
  isPortrait,
  isTouchDevice,
  setTouchControlsPreferenceForSystem,
  type TouchControlsPreferenceSettings,
} from "./preferences.js";

export {
  TOUCH_KEY_MAP,
  vibratePress,
  vibrateRelease,
  type TouchKeyBinding,
} from "./input.js";

export {
  DEFAULT_LAYOUT,
  DEFAULT_PORTRAIT_LAYOUT,
  getDefaultTouchLayoutForSystem,
  loadLayout,
  resetLayout,
  saveLayout,
  type TouchButtonDef,
} from "./layouts.js";

export { TouchControlsOverlay } from "../touchControls.js";
