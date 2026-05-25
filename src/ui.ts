/**
 * ui.ts — Build and wire the full application UI
 *
 * Views:
 *   landing    — game library grid + "Add Game" drop zone (shown on startup)
 *   emulator   — EmulatorJS fills the screen (shown while a game runs)
 *
 * Panels (overlays over the current view):
 *   settings   — tabbed: Performance, Display, Library, BIOS
 *   systemPicker — shown when a file extension maps to multiple systems
 *   loading    — spinner during emulator boot
 *   error      — dismissible error banner
 *
 * Keyboard shortcuts (global, while a game session is active — running or paused):
 *   F5  → Quick Save slot 1
 *   F7  → Quick Load slot 1
 *   F1  → Reset (confirmation dialog — same as toolbar)
 *   Esc → Close in-game menu if open; otherwise open the in-game menu (immersive mode).
 *         Return to the library via the menu’s “Back to Library” action.
 *
 * All shortcut handlers use the capture phase and stopPropagation() so the
 * intercepted keys never reach the EmulatorJS key-input handler, while all
 * regular game-control keys (arrows, letters, etc.) pass through untouched.
 *
 * Global keyboard shortcuts (always active):
 *   F9  → Open Settings → Debug tab
 *   F3  → Toggle developer debug overlay (FPS, frame time, memory, draw calls)
 */

import { setNetworkDocumentState, subscribeToNetworkChanges } from "./connectivity.js";
import {
  PSPEmulator,
  type EmulatorState,
} from "./emulator.js";
import {
  SYSTEMS,
  ALL_EXTENSIONS,
  getSystemById,
} from "./systems.js";
import {
  GameLibrary,
  formatRelativeTime,
  type GameMetadata,
} from "./library.js";
import { parseCloudLibraryConnectionConfig } from "./cloudLibrary.js";
import {
  type DeviceCapabilities,
  type PerformanceTier,
  formatTierLabel,
} from "./performance.js";
import {
  BiosLibrary,
} from "./bios.js";
import {
  SaveStateLibrary,
} from "./saves.js";
import type { Settings } from "./types/settings.js";
import {
  EMULATOR_JS_CONTAINER_ID,
  syncEmulatorViewportLayout,
} from "./emulatorDisplay.js";
import { getNetplayManager, peekNetplayManager, registerNetplayInstance } from "./netplaySingleton.js";
import {
  ICON_ALERT_TRIANGLE_SVG,
  ICON_BATTERY_SVG,
  ICON_CLOSE_X_SVG,
  ICON_GRID_ALL_SVG,
  ICON_ROTATE_PHONE_SVG,
  ONBOARD_ICON_FAST_SVG,
  ONBOARD_ICON_INPUTS_SVG,
  ONBOARD_ICON_LOCK_SVG,
  isSvgMarkup,
} from "./chromeIcons.js";
import { getCloudSaveManager } from "./cloudSaveSingleton.js";
import { createProvider } from "./cloudLibrary.js";
import { SaveGameService } from "./saveService.js";
import { createStoredZip } from "./zip.js";
import { LEGACY_EVENTS } from "./legacy.js";
import { queryRequired as el, createElement as make } from "./ui/dom.js";
import {
  getApiKeyStore,
  getCoverArtProvider,
} from "./ui/coverArtRegistry.js";
import {
  showConfirmDialog as showConfirmDialogImpl,
} from "./ui/modals.js";
import {
  listGamesMissingCoverArt,
  AUTO_APPLY_CONFIDENCE_THRESHOLD,
  fetchFirstValidCoverArtCandidate,
} from "./coverArt.js";
import {
  buildFilteredLibraryEmptyState,
  updateLibraryLandingState,
} from "./ui/libraryView.js";
import {
  buildLibraryRow as buildLibraryRowSection,
} from "./ui/librarySections.js";
import { createDebugConsoleController } from "./ui/debugConsole.js";
import { sessionTracker, formatPlayTime } from "./sessionTracker.js";
import {
  toggleDevOverlay,
  updateDevOverlay,
  showFPSOverlay,
  resetDevOverlayCache,
} from "./modules/DevOverlay.js";
import { VirtualGrid, VIRTUAL_THRESHOLD } from "./ui/virtualGrid.js";
import { InputRouter } from "./ui/InputRouter.js";
import { openEasyNetplayModal as openEasyNetplayModalImpl } from "./ui/easyNetplayModal.js";
import { systemIcon, isEditableTarget } from "./ui/viewHelpers.js";
import { buildGameCard as buildGameCardImpl } from "./ui/widgets/gameCard.js";
import { startLibraryGamepadNavigation, stopLibraryGamepadNavigation, restartLibraryGamepadNavigation, invalidateLibraryGamepadCardCache, focusFirstLibraryCard } from "./ui/widgets/libraryNav.js";
import { resolveSystemAndAddImpl } from "./ui/screens/gameImport.js";
import { resetFpsOverlayElsCache, updateFPSOverlay, resetPerfSuggestion } from "./ui/widgets/fpsOverlay.js";
import {
  toLaunchFile,
  isTransientImportError,
  withRetry,
} from "./ui/gameImportHelpers.js";
export { isTransientImportError, withRetry };
import { openSettingsPanel, closeSettingsPanel, type SettingsTab } from "./ui/screens/settingsPanel.js";
export { openSettingsPanel, closeSettingsPanel };
import {
  showLoadingOverlay as showLoadingOverlayImpl,
  hideLoadingOverlay as hideLoadingOverlayImpl,
  setLoadingMessage as setLoadingMessageImpl,
  setLoadingSubtitle as setLoadingSubtitleImpl,
  setLoadingProgress as setLoadingProgressImpl,
} from "./ui/loadingOverlay.js";
import {
  showError as showErrorImpl,
  hideError as hideErrorImpl,
  showInfoToast as showInfoToastImpl,
  setErrorBannerSettingsOpener,
} from "./ui/toasts.js";
import { buildHighlightsPanel, MAX_SESSIONS as HIGHLIGHTS_MAX_SESSIONS } from "./ui/highlightsPanel.js";
// Re-export DevOverlay public API so external callers that imported from ui.ts
// continue to work without changes (e.g. ui.test.ts).
export { toggleDevOverlay, isDevOverlayVisible } from "./modules/DevOverlay.js";
export { openEasyNetplayModalImpl as openEasyNetplayModal };
const APP_BASE_URL = import.meta.env.BASE_URL;
const APP_NAME = "RetroOasis";
const LOGO_ASSET_PATH = "assets/retrooasis-logo.svg?v=minimal-20260523";
const resolveAssetUrl = (path: string): string => {
  const base = APP_BASE_URL === "/" ? "" : APP_BASE_URL;
  return `${base}${path}`;
};

// ── Settings opener callback (set once from initUI, used by showError action buttons) ──
let _openSettingsFn: ((tab?: string) => void) | null = null;

let _initUICleanup: (() => void) | null = null;

let _virtualGrid: VirtualGrid<GameMetadata> | null = null;

// ── Connection store + cover-art provider registry ───────────────────────────
// Registry singletons live in ./ui/coverArtRegistry.ts; see there for the
// rebuild subscription that wires Settings → Connections tab changes back into
// the composed provider chain.

// ── DOM helpers ───────────────────────────────────────────────────────────────

/** True when the primary input is a touchscreen (not a mouse). */
function isTouchDevice(): boolean {
  if ("ontouchstart" in window || navigator.maxTouchPoints > 0) return true;
  // Chromebooks in tablet mode expose a coarse pointer even though the
  // screen supports both touch and stylus.
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/** True when the app is running in installed PWA mode (standalone or WCO). */
function isPwaDisplayMode(): boolean {
  try {
    return window.matchMedia("(display-mode: standalone), (display-mode: window-controls-overlay)").matches;
  } catch {
    return false;
  }
}

/** True when the viewport is currently in portrait orientation. */
function isPortrait(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia("(orientation: portrait)").matches;
  } catch {
    return window.innerHeight > window.innerWidth;
  }
}

// ── Debug Console State & Logic ──────────────────────────────────────────────
const _debugConsole = createDebugConsoleController({ onToggleDevOverlay: () => toggleDevOverlay() });

function toggleDebugConsole(emulator?: PSPEmulator): void {
  _debugConsole.toggle(emulator);
}

function updateDebugConsoleLog(emulator: PSPEmulator): void {
  _debugConsole.update(emulator);
}

// ── Build DOM ─────────────────────────────────────────────────────────────────

const _LOGO_FALLBACK_SVG = `<svg class="brand-logo" width="44" height="44" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="${APP_NAME}" role="img">
  <rect x="4.5" y="4.5" width="35" height="35" rx="9" fill="#050506" />
  <rect x="5" y="5" width="34" height="34" rx="8.5" stroke="#FFFFFF" stroke-opacity="0.08" />
  <circle cx="22" cy="22" r="12.8" stroke="#DCCB9F" stroke-width="1.6" />
  <path d="M16.4 29.5V14.5H23.9C27.25 14.5 29.55 16.55 29.55 19.55C29.55 22.55 27.25 24.55 23.9 24.55H20.5V29.5H16.4ZM20.5 21.25H23.45C24.85 21.25 25.75 20.62 25.75 19.55C25.75 18.5 24.85 17.9 23.45 17.9H20.5V21.25Z" fill="#F4E9C8" />
  <path d="M27.2 29.5L22.3 24.25H27L31.8 29.5H27.2Z" fill="#BCA36F" />
</svg>`;

export function buildDOM(app: HTMLElement): void {
  // Fade out the static preloader if present (injected by index.html)
  const preloader = document.getElementById("preloader");
  if (preloader) {
    preloader.classList.add("fade-out");
    preloader.addEventListener("transitionend", () => preloader.remove(), { once: true });
  }

  // Reset module-level state that is tied to DOM nodes created below
  if (_librarySearchDebounce !== null) {
    clearTimeout(_librarySearchDebounce);
    _librarySearchDebounce = null;
  }
  _libraryControlsWired = false;
  _librarySearchQuery   = "";
  _librarySortMode      = "lastPlayed";
  _librarySystemFilter  = "";
  stopLibraryGamepadNavigation();
  document.body.classList.remove("using-gamepad");
  // Reset DevOverlay cached DOM references (nodes will be recreated below)
  resetDevOverlayCache();
  resetFpsOverlayElsCache();
  resetPerfSuggestion();

  const archivePickerExts = [
    "zip", "7z", "rar", "tar", "gz", "tgz",
    "bz2", "tbz", "tbz2", "xz", "txz",
    "zst", "lz", "lzma", "cab",
  ];
  const acceptExts = [...new Set([...ALL_EXTENSIONS, ...archivePickerExts])];
  const acceptList = acceptExts.map(e => `.${e}`).join(",");
  // Build a concise format hint: first extension of the first 8 systems + archive note
  const hintExts = SYSTEMS.slice(0, 8).map(s => `.${s.extensions[0]}`).join(" · ");
  const formatHint = `${hintExts} + more · ZIP auto-extracted · 7Z/RAR/TAR/GZ supported`;
  const touchUI = isTouchDevice();
  const pwaMode = isPwaDisplayMode();

  if (touchUI || pwaMode) {
    document.documentElement.classList.add("touch-ui");
  }

  app.innerHTML = `
    <!-- Skip navigation link for keyboard users -->
    <a class="skip-link" href="#landing">Skip to content</a>

    <!-- ── Header ── -->
    <header class="app-header">
        <div class="app-header__brand" aria-label="${APP_NAME}">
          <img src="${resolveAssetUrl(LOGO_ASSET_PATH)}" alt="" class="brand-logo" width="44" height="44" decoding="async" fetchpriority="high" draggable="false" aria-hidden="true" />
          <span class="brand-long">${APP_NAME}</span>
        </div>

      <div class="app-header__actions" id="header-actions">
        <!-- Populated by buildLandingControls() / buildInGameControls() -->
      </div>
    </header>

    <!-- ── Main content area ── -->
    <main class="app-main">

      <!-- Library / landing view -->
      <section id="landing" aria-label="Game Library" class="landing-layout">
        
        <!-- Left Sidebar -->
        <aside class="landing-sidebar" id="landing-sidebar">
          <div class="landing-sidebar__header">Platforms</div>
          <div class="system-filter" id="system-filter">
            <!-- System filter chips — populated by renderLibrary() -->
          </div>
        </aside>

        <!-- Main Center Content -->
        <div class="landing-main" id="library-section">
          <div class="library-toolbar">
            <div class="library-title-row">
              <h2 class="library-title">My Library</h2>
              <span class="library-count" id="library-count" aria-live="polite" aria-atomic="true"></span>
            </div>
            <div class="library-controls" role="group" aria-label="Library controls">
              <div class="library-search-wrap">
                <svg class="library-search-icon" width="14" height="14" viewBox="0 0 24 24"
                     fill="none" stroke="currentColor" stroke-width="2.5"
                     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input class="library-search" id="library-search"
                       type="search" placeholder="Search games…" autocomplete="off"
                       aria-label="Search games" />
                <button class="library-search-clear" id="library-search-clear"
                        type="button" aria-label="Clear search" hidden>${ICON_CLOSE_X_SVG}</button>
              </div>
              <div class="library-layout-toggle" id="library-layouts" role="radiogroup" aria-label="Layout">
                <button type="button" class="btn btn--ghost btn--icon layout-btn" data-layout="grid" title="Grid view" role="radio" aria-checked="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                </button>
                <button type="button" class="btn btn--ghost btn--icon layout-btn" data-layout="list" title="List view" role="radio" aria-checked="false">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                </button>
              </div>
              <button class="btn btn--ghost btn--icon library-fav-filter" id="library-fav-filter" aria-label="Show favorites only" title="Show favorites only" aria-pressed="false">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              </button>
              <select class="library-sort" id="library-sort" aria-label="Sort games">
                <option value="lastPlayed">Last Played</option>
                <option value="name">Name</option>
                <option value="added">Date Added</option>
                <option value="system">System</option>
              </select>
              <button class="btn btn--ghost library-controls__reset" id="library-controls-reset"
                      type="button" hidden aria-label="Reset all library filters">
                Reset
              </button>
              <button class="btn btn--ghost library-controls__fetch-covers" id="library-fetch-covers"
                      type="button" aria-label="Fetch missing cover art from online"
                      title="Match games against online cover databases (Settings → Connections)">
                <svg class="btn__icon library-controls__fetch-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="2"/>
                  <path d="m7 15 3-3 2.2 2.2L15 11l2 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <circle cx="8" cy="9" r="1" fill="currentColor"/>
                </svg>
                <span class="library-controls__fetch-label">Fetch covers</span>
              </button>
            </div>
          </div>
          <div class="library-overview" id="library-overview" aria-label="Library overview">
            <!-- Populated by renderLibrary() -->
          </div>
          <div id="library-highlights" aria-label="Library highlights">
            <!-- Favorites + recent-sessions feed populated by renderLibrary() -->
          </div>
          <div class="library-grid" id="library-grid">
            <!-- Cards populated by renderLibrary() -->
          </div>

        <!-- Drop zone -->
          <div class="drop-zone" id="drop-zone" tabindex="0" role="button" aria-label="Add a game file" aria-describedby="drop-zone-subtitle drop-zone-formats">
          <input type="file"
                 id="file-input"
                 accept="${acceptList}"
                 multiple
                 aria-label="Select game ROM file" />
          <div class="drop-zone__icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </div>
          <p class="drop-zone__label">${touchUI ? "Tap to add a game" : "Drop a game to begin"}</p>
          <p class="drop-zone__sub" id="drop-zone-subtitle">${touchUI ? "Choose a ROM, archive, or disc image from your device" : 'ROMs, archives, and disc images launch locally, or <span class="drop-zone__browse">browse your device</span>'}</p>
          <div class="drop-zone__actions">
            <button class="btn btn--primary btn--sm drop-zone__cta" id="btn-add-game-onboarding" type="button">Choose Files</button>
          </div>
          <p class="drop-zone__formats" id="drop-zone-formats" title="Supported file formats">${formatHint}</p>
        </div>

        <!-- Onboarding — only visible when library is empty -->
        <div class="onboarding" id="onboarding" role="region" aria-labelledby="onboarding-title" aria-hidden="true">
          <div class="welcome-hero">
            <p class="welcome-hero__eyebrow">First run</p>
            <h2 class="welcome-hero__title" id="onboarding-title">Your gaming escape.</h2>
            <p class="welcome-hero__tagline">${APP_NAME} keeps your retro library simple, calm, and ready to play.</p>
          </div>

          <div class="onboarding__grid">
            <div class="onboarding__card onboarding__card--main">
              <h3>Quiet start, fast launch</h3>
              <p>Pick one file and ${APP_NAME} handles detection, startup, and local save management for you.</p>
              <div class="welcome-steps">
                <div class="welcome-step">1. Import a game</div>
                <div class="welcome-step">2. Auto-detect the system</div>
                <div class="welcome-step">3. Play with local saves</div>
              </div>
            </div>
          </div>

          <div class="onboarding__quick-actions" aria-label="Quick start actions">
            <button class="btn btn--primary" id="btn-add-game-secondary" type="button">Choose Files</button>
            <button class="btn btn--ghost" id="btn-open-help-onboarding" type="button">View Guide</button>
          </div>

          <div class="onboarding__features">
            <div class="onboarding__feature">
              <span class="onboarding__feature-icon" aria-hidden="true">${ONBOARD_ICON_FAST_SVG}</span>
              <span><strong>Automatic setup</strong><br>No extra wizard. Bring one file and keep moving.</span>
            </div>
            <div class="onboarding__feature">
              <span class="onboarding__feature-icon" aria-hidden="true">${ONBOARD_ICON_INPUTS_SVG}</span>
              <span><strong>Inputs ready</strong><br>Keyboard, touch, USB gamepad, and Bluetooth all feel at home here.</span>
            </div>
            <div class="onboarding__feature">
              <span class="onboarding__feature-icon" aria-hidden="true">${ONBOARD_ICON_LOCK_SVG}</span>
              <span><strong>Private by default</strong><br>Your library and saves stay on this device unless you opt into cloud features.</span>
            </div>
          </div>
        </div>

        <p class="landing__legal">
          Bring your own legally obtained ROM files. This app does not provide ROMs or BIOS files.
          <a href="https://emulatorjs.org" target="_blank" rel="noopener">Powered by EmulatorJS</a>
        </p>
        </div> <!-- End landing-main -->

        <!-- Right Sidebar (Game Details) -->
        <aside class="landing-details" id="landing-details">
          <div class="landing-details__empty">Select a game to view details</div>
          <div class="landing-details__content" id="landing-details-content" hidden>
            <!-- Populated by showGameDetails() -->
          </div>
        </aside>
      </section>

      <!-- EmulatorJS mount point (hidden until a game launches) -->
      <div id="${EMULATOR_JS_CONTAINER_ID}">
        <div id="ejs-player"></div>
        <div id="in-game-overlay" class="in-game-overlay" hidden role="region" aria-label="In-game session controls"></div>
        <!-- Premium In-Game Performance Overlay -->
        <div id="fps-overlay" class="fps-overlay" hidden role="status" aria-label="Frame rate and performance overlay" aria-live="polite" aria-atomic="true">
          <div class="fps-current">
            <span id="fps-current-val" class="fps-val">--</span>
            <span class="fps-label">FPS</span>
          </div>
          <div class="fps-separator"></div>
          <span id="fps-avg" class="fps-detail">avg --</span>
          <span id="fps-tier" class="fps-detail"></span>
          <span id="fps-drs" class="fps-detail" hidden></span>
          <span id="fps-dropped" class="fps-detail fps-warn" hidden>0 dropped</span>
          <canvas id="fps-visualiser" class="fps-visualiser" width="60" height="18" hidden aria-hidden="true"></canvas>
        </div>
        <!-- High-Fidelity Developer Dashboard (F3) -->
        <div id="dev-overlay" class="dev-overlay" hidden role="status" aria-label="System diagnostic dashboard" aria-live="off">
          <div class="dev-overlay__title">System Diagnostic</div>
          <div class="dev-overlay__grid">
            <span class="dev-overlay__label">Frame Time</span><span id="dev-frame-time" class="dev-overlay__value">--ms</span>
            <span class="dev-overlay__label">Performance</span><span id="dev-fps" class="dev-overlay__value">-- FPS</span>
            <span class="dev-overlay__label">P95 Latency</span><span id="dev-p95" class="dev-overlay__value">--ms</span>
            <span class="dev-overlay__label">Dropped</span><span id="dev-dropped" class="dev-overlay__value">0</span>
            <span class="dev-overlay__label">Memory</span><span id="dev-memory" class="dev-overlay__value">--MB</span>
            <span class="dev-overlay__label">System State</span><span id="dev-state" class="dev-overlay__value">idle</span>
          </div>
          <canvas id="dev-framegraph" class="dev-overlay__graph" width="200" height="60" aria-hidden="true"></canvas>
        </div>
      </div>

      <!-- Loading overlay -->
      <div id="loading-overlay" role="status" aria-live="polite" aria-hidden="true">
        <div class="loading-brand" aria-hidden="true">
          <img src="${resolveAssetUrl(LOGO_ASSET_PATH)}" alt="" class="loading-brand__logo" width="72" height="72" decoding="async" draggable="false" />
        </div>
        <div class="loading-spinner" aria-hidden="true"></div>
        <div class="loading-content">
          <p id="loading-message">Loading…</p>
          <p id="loading-subtitle" hidden></p>
          <div class="loading-progress" id="loading-progress-container" hidden>
            <div class="loading-progress-bar" id="loading-progress-bar"></div>
          </div>
        </div>
      </div>

      <!-- Error banner -->
      <div id="error-banner" role="alert" aria-live="assertive" aria-atomic="true" tabindex="-1">
        <span class="error-icon" aria-hidden="true">${ICON_ALERT_TRIANGLE_SVG}</span>
        <span id="error-message"></span>
        <button class="error-close" id="error-close" title="Dismiss" aria-label="Dismiss error">${ICON_CLOSE_X_SVG}</button>
      </div>

      <!-- System picker modal -->
      <div id="system-picker" role="dialog" aria-modal="true" aria-labelledby="system-picker-title" hidden>
        <div class="modal-backdrop" id="system-picker-backdrop"></div>
        <div class="modal-box">
          <div class="modal-header">
            <h3 class="modal-title" id="system-picker-title">Choose System</h3>
            <button class="modal-close" id="system-picker-close" aria-label="Cancel">${ICON_CLOSE_X_SVG}</button>
          </div>
          <p class="modal-subtitle" id="system-picker-subtitle">
            This file extension is compatible with multiple systems.
          </p>
          <div class="system-picker-list" id="system-picker-list">
            <!-- Populated dynamically -->
          </div>
        </div>
      </div>

      <!-- Settings panel -->
      <div id="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-panel-title" hidden>
        <div class="modal-backdrop" id="settings-backdrop"></div>
        <div class="modal-box settings-modal-box">
          <div class="modal-header">
            <h3 class="modal-title" id="settings-panel-title">Settings</h3>
            <button class="modal-close" id="settings-close" aria-label="Close settings">${ICON_CLOSE_X_SVG}</button>
          </div>
          <div id="settings-content">
            <!-- Populated by buildSettingsContent() -->
          </div>
        </div>
      </div>

      <!-- Debug console (toggled with Shift+F3 or Debug button) -->
      <div id="debug-console" class="debug-console" hidden aria-label="Debug console" role="dialog">
        <div class="debug-console__header" id="debug-console-handle">
          <div class="debug-console__title">Debug Console</div>
          <div class="debug-console__actions">
            <button class="debug-console__btn" id="debug-console-clear" title="Clear log">Clear</button>
            <button class="debug-console__btn debug-console__btn--icon" id="debug-console-close" aria-label="Close">${ICON_CLOSE_X_SVG}</button>
          </div>
        </div>
        <div class="debug-console__body" id="debug-console-log"></div>
        <div class="debug-console__footer">
          <input type="text" class="debug-console__input" id="debug-console-input" 
                 placeholder="Type a command (reset, pause, step, help)…" 
                 spellcheck="false" autocomplete="off" />
        </div>
      </div>

      <!-- Mobile floating action button — touch devices only (CSS hides on pointer:fine) -->
      <button class="mobile-fab mobile-fab--hidden" id="mobile-fab"
              aria-label="Add a game" title="Add a game file">＋</button>

      <!-- Portrait rotation hint — visible when playing in portrait orientation -->
      <div class="rotate-hint" id="rotate-hint" aria-live="polite" aria-atomic="true">
        <span class="rotate-hint__icon" aria-hidden="true">${ICON_ROTATE_PHONE_SVG}</span> Rotate for best experience
      </div>

    </main>

    <!-- ── Footer ── -->
    <footer class="app-footer">
      <div class="footer-left">
        <div class="status-item">
          <div class="status-dot idle" id="status-dot"></div>
          <span class="status-item__value" id="status-state">Ready</span>
        </div>
        <div class="footer-connectivity" id="footer-connectivity" role="status" aria-live="polite"
             title="Network connection status">
          <span class="footer-connectivity__dot status--online" id="footer-connectivity-dot" aria-hidden="true"></span>
          <span class="footer-connectivity__label" id="footer-connectivity-label">Online</span>
        </div>
        ${!window.crossOriginIsolated ? `<span class="footer-info footer-coi-warning" role="note" aria-label="Cross-origin isolation is not active. Threaded cores such as PSP may be unavailable." title="Cross-origin isolation is not active — threaded cores such as PSP may be unavailable."><span class="footer-coi-warning__icon" aria-hidden="true">${ICON_ALERT_TRIANGLE_SVG}</span> COI</span>` : ""}
      </div>
      
      <div class="footer-center">
        <span id="footer-clock">--:--</span>
      </div>

      <div class="footer-right">
        <span class="footer-info">${APP_NAME} v1.4.2</span>
        <span class="footer-battery" id="footer-battery" hidden><span class="footer-battery__icon" aria-hidden="true">${ICON_BATTERY_SVG}</span> <span id="footer-battery-pct"></span></span>
      </div>
    </footer>
  `;

  const brandLogoImg = app.querySelector<HTMLImageElement>(".brand-logo");
  if (brandLogoImg) {
    brandLogoImg.onerror = () => {
      brandLogoImg.insertAdjacentHTML("afterend", _LOGO_FALLBACK_SVG);
      brandLogoImg.remove();
    };
  }
}

// ── Public init ───────────────────────────────────────────────────────────────

export interface UIOptions {
  emulator:          PSPEmulator;
  library:           GameLibrary;
  biosLibrary:       BiosLibrary;
  saveLibrary:       SaveStateLibrary;
  /** When omitted, a SaveGameService is built from emulator + saveLibrary + game getters. */
  saveService?:      SaveGameService;
  settings:          Settings;
  deviceCaps:        DeviceCapabilities;
  onLaunchGame:      (file: File, systemId: string, gameId?: string) => Promise<void>;
  onSettingsChange:  (patch: Partial<Settings>) => void;
  onReturnToLibrary: () => void;
  onApplyPatch:      (gameId: string, patchFile: File) => Promise<void>;
  onFileChosen:      (file: File) => Promise<void>;
  getCurrentGameId:   () => string | null;
  getCurrentGameName: () => string | null;
  getCurrentSystemId: () => string | null;
  /** Get all current core options (libretro keys). */
  getCurrentCoreOptions?: () => Record<string, string>;
  /** Update a specific core option at runtime. */
  onUpdateCoreOption?: (key: string, value: string) => void;
  getNetplayManager?:  () => Promise<import("./multiplayer.js").NetplayManager>;
  /** Pre-existing NetplayManager instance — registers it as the singleton when provided (useful for tests). */
  netplayManager?:    import("./multiplayer.js").NetplayManager;
  canInstallPWA?:     () => boolean;
  onInstallPWA?:      () => Promise<boolean>;
}

export const RESTART_REQUIRED_EVENT = LEGACY_EVENTS.restartRequired;

interface FileSystemEntryLike {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

interface FileSystemFileEntryLike extends FileSystemEntryLike {
  isFile: true;
  file(success: (file: File) => void, error?: (err: DOMException) => void): void;
}

interface FileSystemDirectoryEntryLike extends FileSystemEntryLike {
  isDirectory: true;
  createReader(): {
    readEntries(
      success: (entries: FileSystemEntryLike[]) => void,
      error?: (err: DOMException) => void,
    ): void;
  };
}

interface DirectoryCapableDataTransferItem {
  kind: string;
  getAsFile(): File | null;
  webkitGetAsEntry?: () => FileSystemEntryLike | null;
}

interface CollectedFile {
  file: File;
  path: string;
}

function filesToArray(files: FileList | DataTransferItemList | readonly File[] | null | undefined): File[] {
  if (!files) return [];
  const out: File[] = [];
  const length = "length" in files ? files.length : 0;
  for (let i = 0; i < length; i++) {
    const item = files[i];
    if (!item) continue;
    if (item instanceof File) {
      out.push(item);
      continue;
    }
    const file = item.kind === "file" ? item.getAsFile() : null;
    if (file) out.push(file);
  }
  return out;
}

function isDataTransferItemList(
  files: FileList | DataTransferItemList | readonly File[] | null | undefined,
): files is DataTransferItemList {
  if (!files || !("length" in files) || files.length === 0) return false;
  const first = files[0] as unknown;
  return !!first && typeof first === "object" && "kind" in first && "getAsFile" in first;
}

function readFileEntry(entry: FileSystemFileEntryLike, pathPrefix: string): Promise<CollectedFile> {
  return new Promise((resolve, reject) => {
    entry.file(
      (file) => resolve({ file, path: `${pathPrefix}${file.name}` }),
      (err) => reject(err),
    );
  });
}

async function readDirectoryEntries(entry: FileSystemDirectoryEntryLike): Promise<FileSystemEntryLike[]> {
  const reader = entry.createReader();
  const entries: FileSystemEntryLike[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntryLike[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) break;
    entries.push(...batch);
  }
  return entries;
}

async function collectEntryFiles(entry: FileSystemEntryLike, pathPrefix = ""): Promise<CollectedFile[]> {
  if (entry.isFile) {
    return [await readFileEntry(entry as FileSystemFileEntryLike, pathPrefix)];
  }
  if (!entry.isDirectory) return [];

  const dir = entry as FileSystemDirectoryEntryLike;
  const nextPrefix = `${pathPrefix}${dir.name}/`;
  const children = await readDirectoryEntries(dir);
  const nested = await Promise.all(children.map((child) => collectEntryFiles(child, nextPrefix)));
  return nested.flat();
}

async function createFolderZipFile(rootName: string, files: CollectedFile[]): Promise<File | null> {
  if (files.length === 0) return null;
  const entries = await Promise.all(files.map(async ({ file, path }) => ({
    path,
    bytes: new Uint8Array(await file.arrayBuffer()),
  })));
  const zipBytes = createStoredZip(entries);
  const safeRoot = (rootName.trim() || "folder").replace(/[\\/:*?"<>|]+/g, "-");
  return new File([zipBytes.slice()], `${safeRoot}.zip`, { type: "application/zip" });
}

async function fileFromDirectoryItems(items: DataTransferItemList): Promise<File | null> {
  const roots: FileSystemEntryLike[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as DirectoryCapableDataTransferItem | undefined;
    if (!item || item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  const directoryRoots = roots.filter((entry) => entry.isDirectory);
  if (directoryRoots.length === 0) return null;
  const collected = (await Promise.all(directoryRoots.map((entry) => collectEntryFiles(entry)))).flat();
  return createFolderZipFile(directoryRoots[0]?.name ?? "folder", collected);
}

function fileBaseName(fileName: string): string {
  return fileName.split(/[/\\]/).pop()?.toLowerCase() ?? fileName.toLowerCase();
}

async function parseCueReferencedFileNames(cueFile: File): Promise<string[]> {
  let text = "";
  try {
    text = await cueFile.text();
  } catch {
    return [];
  }

  const refs: string[] = [];
  const quoted = /^\s*FILE\s+"([^"]+)"/gim;
  const bare = /^\s*FILE\s+([^\r\n]+?)\s+(?:BINARY|MOTOROLA|AIFF|WAVE|MP3)\s*$/gim;

  for (const match of text.matchAll(quoted)) {
    const value = match[1]?.trim();
    if (value) refs.push(fileBaseName(value));
  }
  for (const match of text.matchAll(bare)) {
    const value = match[1]?.trim();
    if (value) refs.push(fileBaseName(value));
  }

  return [...new Set(refs)];
}

export async function selectImportFileFromSelection(
  files: FileList | DataTransferItemList | readonly File[] | null | undefined,
): Promise<File | null> {
  if (isDataTransferItemList(files)) {
    const folderZip = await fileFromDirectoryItems(files);
    if (folderZip) return folderZip;
  }
  const selected = filesToArray(files);
  if (selected.length === 0) return null;

  // Single non-CUE file — fast path, no special handling needed.
  if (selected.length === 1 && !selected[0]!.name.toLowerCase().endsWith(".cue")) {
    return selected[0]!;
  }

  const cueFiles = selected.filter(file => file.name.toLowerCase().endsWith(".cue"));
  const nonCueFiles = selected.filter(file => !file.name.toLowerCase().endsWith(".cue"));

  if (cueFiles.length > 0) {
    // Try to find the disc binary that this CUE sheet describes.
    for (const cueFile of cueFiles) {
      const referencedNames = await parseCueReferencedFileNames(cueFile);
      const referencedPayload = nonCueFiles.find(file =>
        referencedNames.includes(fileBaseName(file.name))
      );
      if (referencedPayload) return referencedPayload;
    }

    if (selected.length === 1) {
      // Only a .cue was provided — the binary track is missing.
      showError(
        "This disc image (.cue) needs its matching binary track file.\n\n" +
        "Select or drop both the .cue and .bin together, or use the .bin / .chd / .iso file directly."
      );
      return null;
    }

    // Multiple files selected but CUE names didn't match any — prefer the
    // non-CUE file over handing a bare .cue to the import pipeline.
    if (nonCueFiles.length > 0) return nonCueFiles[0]!;
  }

  return selected[0]!;
}

export function initUI(opts: UIOptions): void {
  // Re-initialisation safety: remove previously registered listeners so
  // repeated initUI() calls (tests/hot-reload) don't accumulate handlers.
  _initUICleanup?.();
  _initUICleanup = null;

  // If a pre-existing NetplayManager instance is provided, register it as the
  // global singleton so that peekNetplayManager() returns it synchronously.
  if (opts.netplayManager) {
    registerNetplayInstance(opts.netplayManager);
  }

  // ── Console Clock Loop ──
  let clockDisposed = false;
  const updateClock = (): boolean => {
    if (clockDisposed || typeof document === "undefined") return false;
    const clockEl = document.getElementById("footer-clock");
    if (!clockEl) return false;
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return true;
  };
  updateClock();
  // Align the repeating interval to the next wall-clock minute so the display
  // never lags more than ~1 s behind the actual time.
  const msToNextMinute = 60_000 - (Date.now() % 60_000);
  let clockInterval: ReturnType<typeof setInterval> | null = null;
  const clockAlignTimeout = setTimeout(() => {
    if (!updateClock()) return;
    clockInterval = setInterval(() => {
      if (!updateClock() && clockInterval !== null) {
        clearInterval(clockInterval);
        clockInterval = null;
      }
    }, 60_000);
  }, msToNextMinute);

  const { emulator, library, biosLibrary, saveLibrary, settings, deviceCaps,
          onLaunchGame, onSettingsChange, onReturnToLibrary,
          onApplyPatch, onFileChosen,
          getCurrentGameId, getCurrentGameName, getCurrentSystemId,
          getCurrentCoreOptions, onUpdateCoreOption } = opts;

  const saveService = opts.saveService ?? new SaveGameService({
    saveLibrary,
    cloudManager: getCloudSaveManager(),
    emulator,
    getCurrentGameContext: () => {
      const gameId = getCurrentGameId?.() ?? null;
      const gameName = getCurrentGameName?.() ?? null;
      const systemId = getCurrentSystemId?.() ?? null;
      return gameId && gameName && systemId
        ? { gameId, gameName, systemId }
        : null;
    },
  });

  const cleanupFns: Array<() => void> = [
    () => {
      clockDisposed = true;
      clearTimeout(clockAlignTimeout);
      if (clockInterval !== null) clearInterval(clockInterval);
    }
  ];
  const bindEvent = (
    target: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): void => {
    target.addEventListener(type, handler, options);
    cleanupFns.push(() => target.removeEventListener(type, handler, options));
  };

  // ── Gamepad connection toast ───────────────────────────────────────────
  // Apply initial UI scale
  document.documentElement.style.setProperty("--ui-scale", String(settings.uiScale));

  const _onGamepadConnected = (e: Event) => {
    showInfoToast(`Gamepad connected: ${(e as GamepadEvent).gamepad.id}`, "info");
  };
  const _onGamepadDisconnected = (e: Event) => {
    showInfoToast(`Disconnected: ${(e as GamepadEvent).gamepad.id}`, "warning");
  };
  bindEvent(window, "gamepadconnected", _onGamepadConnected);
  bindEvent(window, "gamepaddisconnected", _onGamepadDisconnected);

  // ── Live battery indicator ───────────────────────────────────────────────────
  if (navigator.getBattery) {
    navigator.getBattery()
      .then((battery) => {
        const batteryEl  = document.getElementById("footer-battery");
        const batteryPct = document.getElementById("footer-battery-pct");
        if (!batteryEl || !batteryPct) return;
        const update = () => {
          batteryPct.textContent = `${Math.round(battery.level * 100)}%`;
        };
        update();
        batteryEl.hidden = false;
        battery.addEventListener("levelchange",    update);
        battery.addEventListener("chargingchange", update);
        cleanupFns.push(() => {
          battery.removeEventListener("levelchange",    update);
          battery.removeEventListener("chargingchange", update);
        });
      })
      .catch(() => { /* Battery API unavailable or denied — keep element hidden */ });
  }

  // ── Chromebook tablet mode listener ──────────────────────────────────────────
  // When a Chromebook switches between laptop and tablet mode, the pointer type
  // changes from "fine" (trackpad) to "coarse" (touch). Toggle the touch-ui class
  // so the UI can adapt: show the FAB, use 44px tap targets, etc.
  try {
    const coarseMq = window.matchMedia("(pointer: coarse)");
    const onCoarseChange = () => {
      document.documentElement.classList.toggle("touch-ui", coarseMq.matches);
    };
    coarseMq.addEventListener("change", onCoarseChange);
    cleanupFns.push(() => coarseMq.removeEventListener("change", onCoarseChange));
  } catch {
    // matchMedia not supported (SSR, old browser)
  }

  const applyConnectivityFooter = (online: boolean): void => {
    setNetworkDocumentState(online);
    const label = document.getElementById("footer-connectivity-label");
    const dot = document.getElementById("footer-connectivity-dot");
    const wrap = document.getElementById("footer-connectivity");
    if (label) label.textContent = online ? "Online" : "Offline";
    if (dot) {
      dot.classList.toggle("status--online", online);
      dot.classList.toggle("status--offline", !online);
    }
    if (wrap) {
      wrap.classList.toggle("footer-connectivity--offline", !online);
      wrap.title = online
        ? "Network connection available"
        : "No network — online-only features are unavailable";
    }
    _syncLibraryControlState();
  };
  cleanupFns.push(subscribeToNetworkChanges(applyConnectivityFooter));

  const resumeAudioOnGesture = () => {
    emulator.resumeAudioOutput();
  };
  bindEvent(document, "pointerdown", resumeAudioOnGesture, { capture: true, once: true });
  const resumeAudioOnVisible = () => {
    if (document.visibilityState === "visible") emulator.resumeAudioOutput();
  };
  bindEvent(document, "visibilitychange", resumeAudioOnVisible);

  const refreshLibraryCatalog = () => {
    void renderLibrary(library, settings, onLaunchGame, emulator, onApplyPatch);
  };
  bindEvent(document, LEGACY_EVENTS.libraryCatalogNeedsRefresh, refreshLibraryCatalog);

  _openSettingsFn = (tab?: string) =>
    openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, getNetplayManager, tab as SettingsTab | undefined);
  setErrorBannerSettingsOpener(_openSettingsFn);

  /** Close the Multiplayer modal (if open) and jump to Play Together settings. */
  const openPlayTogetherSettings = () => {
    document.dispatchEvent(new CustomEvent(LEGACY_EVENTS.closeEasyNetplay));
    openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, getNetplayManager, "multiplayer");
  };

  const openPlayTogetherLobby = (): void => {
    if (!getNetplayManager) return;
    void getNetplayManager().then((nm) => {
      openEasyNetplayModalImpl({
        netplayManager: nm,
        currentGameName:  getCurrentGameName?.() ?? null,
        currentGameId:    getCurrentGameId?.() ?? null,
        currentSystemId:  getCurrentSystemId?.() ?? null,
        onOpenPlayTogetherSettings: openPlayTogetherSettings,
      });
    }).catch(err => {
      console.warn("Failed to open Play Together lobby:", err);
    });
  };

  // ── File drop / pick ──────────────────────────────────────────────────────
  const fileInput = el<HTMLInputElement>("#file-input");
  const dropZone  = el("#drop-zone");
  let dragDepth = 0;
  let dragOverActive = false;
  let lastFilePickerOpenAt = Number.NEGATIVE_INFINITY;
  let fileSelectionInProgress = false;
  const openFilePicker = () => {
    const now = performance.now();
    if (fileSelectionInProgress || now - lastFilePickerOpenAt < 750) return;
    lastFilePickerOpenAt = now;
    fileInput.click();
  };
  const clearDragOver = () => {
    dragDepth = 0;
    if (!dragOverActive) return;
    dragOverActive = false;
    dropZone.classList.remove("drag-over");
  };

  const onFileInputChange = async () => {
    const file = await selectImportFileFromSelection(fileInput.files);
    if (!file) {
      fileInput.value = "";
      return;
    }
    if (fileSelectionInProgress) {
      fileInput.value = "";
      return;
    }
    fileSelectionInProgress = true;
    try {
      await onFileChosen(file);
    } finally {
      fileInput.value = "";
      fileSelectionInProgress = false;
    }
  };
  bindEvent(fileInput, "change", onFileInputChange);

  const onDropZoneKeydown = (event: Event) => {
    const e = event as KeyboardEvent;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openFilePicker();
  };
  bindEvent(dropZone, "keydown", onDropZoneKeydown);
  bindEvent(dropZone, "click", (event: Event) => {
    const target = event.target as Element | null;
    if (target?.closest("button, input, select, textarea, a")) return;
    openFilePicker();
  });

  const bindFilePickerButton = (id: string) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    bindEvent(btn, "click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      openFilePicker();
    });
  };
  bindFilePickerButton("btn-add-game-onboarding");
  bindFilePickerButton("btn-add-game-secondary");

  const onDragOver = (event: Event) => {
    const e = event as DragEvent;
    e.preventDefault();
    if (!dragOverActive) {
      dragOverActive = true;
      dropZone.classList.add("drag-over");
    }
  };
  const onDragEnter = (event: Event) => {
    const e = event as DragEvent;
    e.preventDefault();
    dragDepth += 1;
    if (!dragOverActive) {
      dragOverActive = true;
      dropZone.classList.add("drag-over");
    }
  };
  const onDragLeave = (event: Event) => {
    const e = event as DragEvent;
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth > 0) return;
    clearDragOver();
  };
  const onDrop = (event: Event) => {
    const e = event as DragEvent;
    e.preventDefault();
    clearDragOver();
    if (emulator.state === "running") {
      showError("Return to the library first (Esc or ← Library) before loading a new game.");
      return;
    }
    void (async () => {
      const file = await selectImportFileFromSelection(e.dataTransfer?.files);
      if (!file) return;
      await onFileChosen(file);
    })();
  };
  bindEvent(document, "dragover", onDragOver);
  bindEvent(document, "dragenter", onDragEnter);
  bindEvent(document, "dragleave", onDragLeave);
  bindEvent(document, "drop", onDrop);
  bindEvent(window, "blur", clearDragOver);

  // ── Error banner ──────────────────────────────────────────────────────────
  bindEvent(el("#error-close"), "click", hideError);

  // ── Mobile FAB — "Add Game" button (touch devices) ───────────────────────
  // The FAB is visible on the library page; hidden during gameplay.
  // It is rendered in the DOM for all builds and hidden via CSS (pointer: fine).
  const mobileFab = document.getElementById("mobile-fab");
  if (mobileFab) {
    bindEvent(mobileFab, "click", () => openFilePicker());
  }

  // ── Portrait rotation hint ────────────────────────────────────────────────
  // Shown on touch devices when a game is running in portrait orientation.
  const rotateHintEl = document.getElementById("rotate-hint");
  const updateRotateHint = () => {
    if (!rotateHintEl) return;
    const inGame   = emulator.state === "running" || emulator.state === "paused";
    const portrait = isPortrait();
    rotateHintEl.classList.toggle("rotate-hint--visible", inGame && portrait);
  };
  bindEvent(window, "orientationchange", updateRotateHint);
  bindEvent(window, "resize", updateRotateHint);

  // ── FPS overlay wiring ────────────────────────────────────────────────────
  emulator.setFPSMonitorEnabled(settings.showFPS);
  emulator.onFPSUpdate = (snapshot) => {
    const fpsOverlay = document.getElementById("fps-overlay");
    if (fpsOverlay && !fpsOverlay.hidden) {
      updateFPSOverlay(snapshot, emulator);
    }
    updateDevOverlay(snapshot, emulator);
    const debugConsole = document.getElementById("debug-console");
    if (debugConsole && !debugConsole.hidden) {
      updateDebugConsoleLog(emulator);
    }
  };

  const getEmuJsContainerEl = (): HTMLElement | null =>
    document.getElementById(EMULATOR_JS_CONTAINER_ID);

  /** Letterbox viewport for the current system. */
  const syncViewportForCurrentGame = (sid: string | null) => {
    syncEmulatorViewportLayout(getEmuJsContainerEl(), sid);
  };

  // ── Emulator lifecycle → DOM ──────────────────────────────────────────────
  emulator.onStateChange = (state) => {
    updateStatusDot(state);
    updateRotateHint();
  };
  emulator.onProgress    = (msg)   => {
    setLoadingMessage(msg);
    const stabilityNotice = emulator.currentSystem?.experimental
      ? emulator.currentSystem.stabilityNotice ?? "Experimental support may be unstable."
      : "";
    setLoadingSubtitle(stabilityNotice);
  };
  emulator.onError       = (msg)   => { hideLoadingOverlay(); showError(msg); };
  emulator.onGameStart = () => {
    transitionToGame();
    const sys  = emulator.currentSystem;
    const name = settings.lastGameName ?? "Unknown";
    setStatusSystem(sys ? sys.shortName : "—");
    setStatusGame(name);
    setStatusTier(emulator.activeTier);
    document.title = `${name} — ${APP_NAME}`;
    const openSettingsWith = (tab?: SettingsTab) =>
      openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, getNetplayManager, tab);
    buildInGameControls(
      emulator, settings, onSettingsChange, onReturnToLibrary,
      saveLibrary, saveService, getCurrentGameId, getCurrentGameName, getCurrentSystemId,
      openSettingsWith, getNetplayManager, openPlayTogetherSettings,
      openPlayTogetherLobby,
      getCurrentCoreOptions, onUpdateCoreOption,
    );
    showFPSOverlay(settings.showFPS, emulator, settings.showAudioVis);
    {
      const sid = getCurrentSystemId?.() ?? emulator.currentSystem?.id ?? null;
      syncViewportForCurrentGame(sid);
    }
    afterNextPaint(() => {
      hideLoadingOverlay();
      requestAnimationFrame(() => {
        syncEmulatorViewportLayout(
          getEmuJsContainerEl(),
          getCurrentSystemId?.() ?? emulator.currentSystem?.id ?? null,
        );
        // Hide FAB and show rotate-hint when appropriate
        mobileFab?.classList.add("mobile-fab--hidden");
        updateRotateHint();
        resetPerfSuggestion();
        document.dispatchEvent(new CustomEvent(LEGACY_EVENTS.gameStarted));
      });
    });
  };

  const onResumeGameEvent = () => {
    transitionToGame();
    const sys  = emulator.currentSystem;
    const name = settings.lastGameName ?? "Unknown";
    document.title = `${name} — ${APP_NAME}`;
    setStatusSystem(sys ? sys.shortName : "—");
    setStatusGame(name);
    const openSettingsWithResume = (tab?: SettingsTab) =>
      openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, getNetplayManager, tab);
    buildInGameControls(
      emulator, settings, onSettingsChange, onReturnToLibrary,
      saveLibrary, saveService, getCurrentGameId, getCurrentGameName, getCurrentSystemId,
      openSettingsWithResume, getNetplayManager, openPlayTogetherSettings,
      openPlayTogetherLobby,
      getCurrentCoreOptions, onUpdateCoreOption,
    );
    showFPSOverlay(settings.showFPS, emulator, settings.showAudioVis);
    {
      const sid = getCurrentSystemId?.() ?? emulator.currentSystem?.id ?? null;
      syncViewportForCurrentGame(sid);
    }
    afterNextPaint(() => {
      requestAnimationFrame(() => {
        syncEmulatorViewportLayout(
          getEmuJsContainerEl(),
          getCurrentSystemId?.() ?? emulator.currentSystem?.id ?? null,
        );
        // Hide FAB and show rotate-hint when appropriate
        mobileFab?.classList.add("mobile-fab--hidden");
        updateRotateHint();
      });
    });
  };
  bindEvent(document, LEGACY_EVENTS.resumeGame, onResumeGameEvent);

  // Ensure overlay work is paused while browsing the library.
  const onReturnToLibraryEvent = () => {
    showFPSOverlay(false);
    resetPerfSuggestion();
    mobileFab?.classList.remove("mobile-fab--hidden");
    updateRotateHint();
  };
  bindEvent(document, LEGACY_EVENTS.returnToLibrary, onReturnToLibraryEvent);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  // Register in the capture phase (third argument `true`) so our shortcuts
  // are processed before the EmulatorJS keydown handler (which listens on the
  // player element). Calling stopPropagation() here prevents F5/F7/F1/F9/Esc
  // from ever reaching EmulatorJS while all other keys (game controls) pass
  // through normally and are handled by EmulatorJS as expected.

  const inputRouter = new InputRouter();
  // Global shortcuts context � always active. Handlers return true when they
  // consume the event so the router stops dispatch.
  inputRouter.register("global", [
    // Ctrl+K / / � focus library search (when no modal/panel is open)
    (e) => {
      if (
        ((e.key === "/" && !e.shiftKey) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) &&
        !isEditableTarget(e.target) &&
        !document.querySelector(".confirm-overlay, .easy-netplay-overlay, #settings-panel:not([hidden]), #system-picker:not([hidden])")
      ) {
        if (_focusLibrarySearch()) return true;
      }
      return false;
    },
    // F9 � open Debug tab
    (e) => { if (e.key === "F9") { openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, getNetplayManager, "debug"); return true; } return false; },
    // F3 � toggle dev overlay; Shift+F3 toggles debug console
    (e) => { if (e.key === "F3") { if (e.shiftKey) toggleDebugConsole(emulator); else toggleDevOverlay(); return true; } return false; },
    // Escape � dismiss overlays top-down: confirm, error, settings, system-picker,
    // netplay, in-game panel, or return to library
    (e) => {
      if (e.key !== "Escape") return false;
      const t = e.target;
      if (t instanceof HTMLElement && t.closest(".confirm-overlay--visible")) return false;
      const errorBanner = document.getElementById("error-banner");
      if (errorBanner?.classList.contains("visible")) { hideError(); return true; }
      const settingsEl = document.getElementById("settings-panel");
      if (settingsEl && !settingsEl.hidden) return false;
      if (document.querySelector("#system-picker:not([hidden])")) return false;
      if (document.querySelector(".easy-netplay-overlay")) return false;
      const inGamePanel = document.querySelector("#in-game-overlay .in-game-overlay__panel:not([hidden])");
      if (inGamePanel) {
        const closeBtn = inGamePanel.querySelector(".in-game-overlay__close") as HTMLElement | null;
        closeBtn?.click();
        return true;
      }
      if (document.body.classList.contains("is-playing")) { onReturnToLibrary(); return true; }
      return false;
    },
    // F5, F7, F8, F1 � in-game save/load/reset (only when game is active)
    (e) => {
      if (!_isInGameSession(emulator)) return false;
      switch (e.key) {
        case "F5": void saveService.saveSlot(1)
          .then((entry) => { if (entry) showInfoToast("Saved to Slot 1"); else showError(quickSaveFailureMessage(emulator, getCurrentGameId)); })
          .catch((err) => showError(`Quick save failed: ${err instanceof Error ? err.message : String(err)}`));
          return true;
        case "F7": void saveService.loadSlot(1)
          .then((ok) => { if (ok) showInfoToast("Loaded Slot 1"); else showError("Nothing saved in Slot 1 yet, or the emulator is still starting."); })
          .catch((err) => showError(`Quick load failed: ${err instanceof Error ? err.message : String(err)}`));
          return true;
        case "F8": void saveService.findNextSlot()
          .then((slot) => {
            void saveService.saveSlot(slot)
              .then((entry) => { if (entry) showInfoToast(`Saved to Slot ${slot}`); else showError("Save failed - wait for the core to finish starting."); })
              .catch((err) => showError(`Save failed: ${err instanceof Error ? err.message : String(err)}`));
          })
          .catch((err) => showError(`Could not choose a save slot: ${err instanceof Error ? err.message : String(err)}`));
          return true;
        case "F1": void (async () => { const confirmed = await showConfirmDialog("Unsaved progress will be lost.", { title: "Reset Game?", confirmLabel: "Reset", isDanger: true }); if (confirmed) emulator.reset(); })(); return true;
      }
      return false;
    },
  ]);

  // -- Landing header controls ---------------------------------------------
  buildLandingControls(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, undefined, saveLibrary, getNetplayManager, openPlayTogetherSettings);

  if (typeof ResizeObserver !== "undefined") {
    const headerActions = document.getElementById("header-actions");
    if (headerActions) {
      const ro = new ResizeObserver(updateHeaderOverflow);
      ro.observe(headerActions);
      cleanupFns.push(() => ro.disconnect());
    }
  }

  // ── Initial library render ────────────────────────────────────────────────
  _initUICleanup = () => {
    cleanupFns.forEach((cleanup) => cleanup());
    cleanupFns.length = 0;
    _inGameControlsAc?.abort();
    _inGameControlsAc = null;
    inputRouter.destroy();
  };

  void renderLibrary(library, settings, onLaunchGame, emulator, onApplyPatch);
}

// ── Cinematic Overhaul Helpers ────────────────────────────────────────────────

/**
 * Build the cinematic hero card for the most-recently played game.
 *
 * @param game         Metadata of the game to feature.
 * @param library      Game library instance for blob retrieval and play-tracking.
 * @param settings     App settings; needed for cloud-streaming fallback when the
 *                     local blob is unavailable (virtual / cloud-hosted games).
 * @param onLaunchGame Callback to start the emulator with the resolved file.
 */
type SortMode = "lastPlayed" | "name" | "added" | "system";

let _librarySearchQuery = "";
let _librarySortMode: SortMode = "lastPlayed";
let _librarySystemFilter = "";
let _libraryShowFavorites = false;
let _libraryLastLayout: Settings["libraryLayout"] = "grid";
let _librarySearchDebounce: ReturnType<typeof setTimeout> | null = null;

function _syncLibraryControlState(): void {
  const searchEl = document.getElementById("library-search") as HTMLInputElement | null;
  const sortEl = document.getElementById("library-sort") as HTMLSelectElement | null;
  const clearBtn = document.getElementById("library-search-clear") as HTMLButtonElement | null;

  if (searchEl) searchEl.value = _librarySearchQuery;
  if (sortEl) sortEl.value = _librarySortMode;
  if (clearBtn) clearBtn.hidden = _librarySearchQuery.length === 0;

  const favBtn = document.getElementById("library-fav-filter") as HTMLButtonElement | null;
  if (favBtn) {
    favBtn.classList.toggle("active", _libraryShowFavorites);
    favBtn.setAttribute("aria-pressed", String(_libraryShowFavorites));
  }

  const layoutContainer = document.getElementById("library-layouts");
  if (layoutContainer) {
    const currentLayout = _libraryLastLayout;
    layoutContainer.querySelectorAll(".layout-btn").forEach(btn => {
      const layout = btn.getAttribute("data-layout");
      btn.setAttribute("aria-checked", String(layout === currentLayout));
      btn.classList.toggle("active", layout === currentLayout);
    });
  }

  const fetchCoversBtn = document.getElementById("library-fetch-covers") as HTMLButtonElement | null;
  if (fetchCoversBtn && !_bulkCoverArtController) {
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    fetchCoversBtn.disabled = offline;
    fetchCoversBtn.title = offline
      ? "Requires an internet connection"
      : "Match games against online cover databases (Settings → Connections)";
    fetchCoversBtn.setAttribute(
      "aria-label",
      offline
        ? "Fetch missing cover art — unavailable while offline"
        : "Fetch missing cover art from online",
    );
  }
}

function _scheduleLibraryRender(
  library: GameLibrary,
  settings: Settings,
  onLaunchGame: (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef?: PSPEmulator,
  onApplyPatch?: (gameId: string, patchFile: File) => Promise<void>,
  debounceMs = 0
): void {
  if (_librarySearchDebounce !== null) {
    clearTimeout(_librarySearchDebounce);
    _librarySearchDebounce = null;
  }

  const doRender = () => {
    _librarySearchDebounce = null;
    void renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
  };

  if (debounceMs > 0) {
    _librarySearchDebounce = setTimeout(doRender, debounceMs);
    return;
  }

  doRender();
}

function _resetLibraryFilters(
  library: GameLibrary,
  settings: Settings,
  onLaunchGame: (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef?: PSPEmulator,
  onApplyPatch?: (gameId: string, patchFile: File) => Promise<void>
): void {
  _librarySearchQuery = "";
  _librarySystemFilter = "";
  _librarySortMode = "lastPlayed";
  _libraryShowFavorites = false;
  _syncLibraryControlState();
  _scheduleLibraryRender(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
}

// Tracks an in-flight bulk fetch so repeated clicks cancel instead of stacking.
let _bulkCoverArtController: AbortController | null = null;

function _setFetchCoversButtonLabel(button: HTMLButtonElement | undefined, label: string): void {
  if (!button) return;
  const labelEl = button.querySelector<HTMLElement>(".library-controls__fetch-label");
  if (labelEl) {
    labelEl.textContent = label;
  } else {
    button.textContent = label;
  }
}

/**
 * Bulk "Fetch covers" action: iterates over games missing cover art, runs
 * the provider with limited concurrency, and auto-applies candidates whose
 * confidence score meets AUTO_APPLY_CONFIDENCE_THRESHOLD. Lower-confidence
 * matches are skipped so the user can still resolve them manually.
 *
 * Clicking the toolbar button while a run is in progress cancels it.
 */
async function _runBulkCoverArtFetch(
  library: GameLibrary,
  settings: Settings,
  onLaunchGame: (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef?: PSPEmulator,
  onApplyPatch?: (gameId: string, patchFile: File) => Promise<void>,
  button?: HTMLButtonElement,
): Promise<void> {
  const restoreFetchCoversButton = (): void => {
    if (!button) return;
    _setFetchCoversButtonLabel(button, "Fetch covers");
    button.setAttribute("aria-label", "Fetch missing cover art from online");
    button.title = "Match games against online cover databases (Settings → Connections)";
    button.removeAttribute("aria-busy");
    button.classList.remove("library-controls__fetch-covers--busy");
    button.disabled = false;
  };

  // Toggle-cancel semantics: a second click aborts the in-flight batch.
  if (_bulkCoverArtController) {
    _bulkCoverArtController.abort();
    _bulkCoverArtController = null;
    restoreFetchCoversButton();
    return;
  }

  if (typeof navigator !== "undefined" && !navigator.onLine) {
    showInfoToast("You're offline — connect to the internet to fetch covers.", "warning");
    return;
  }

  const all = await library.getAllGamesMetadata();
  const missing = listGamesMissingCoverArt(all);
  if (missing.length === 0) {
    showInfoToast("All games already have cover art.", "info");
    return;
  }

  const controller = new AbortController();
  _bulkCoverArtController = controller;
  if (button) {
    _setFetchCoversButtonLabel(button, `0 of ${missing.length}`);
    button.setAttribute(
      "aria-label",
      `Fetching covers, 0 of ${missing.length} complete — activate to cancel`,
    );
    button.title = "Fetching covers — click again to cancel";
    button.setAttribute("aria-busy", "true");
    button.classList.add("library-controls__fetch-covers--busy");
    button.disabled = false;
  }

  let gamesCompleted = 0;

  const provider = getCoverArtProvider();
  const CONCURRENCY = 4;
  let applied = 0;
  let skipped = 0;
  let cursor = 0;

  showInfoToast(`Fetching covers for ${missing.length} games…`, "info");

  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const i = cursor++;
      if (i >= missing.length) return;
      const game = missing[i]!;
      let hashes: { md5?: string } | undefined;
      const store = getApiKeyStore();
      if (store.getState("screenscraper").enabled) {
        try {
          const blob = await library.getGameBlob(game.id);
          if (blob) {
            const { calculateMD5 } = await import("./crypto.js");
            const md5 = await calculateMD5(blob);
            hashes = { md5 };
          }
        } catch { /* ignore hash errors in bulk */ }
      }

      try {
        const candidates = await provider.search(game.name, game.systemId, {
          limit: 5,
          signal: controller.signal,
          hashes,
          fileName: game.fileName,
        });
        if (controller.signal.aborted) return;
        const result = await fetchFirstValidCoverArtCandidate(candidates, {
          signal: controller.signal,
          minScore: AUTO_APPLY_CONFIDENCE_THRESHOLD,
          maxAttempts: 4,
        });
        if (!result) {
          skipped++;
          continue;
        }
        if (controller.signal.aborted) return;
        await library.setCoverArt(game.id, result.blob);
        applied++;
      } catch {
        if (controller.signal.aborted) return;
        skipped++;
      } finally {
        gamesCompleted++;
        if (button) {
          _setFetchCoversButtonLabel(button, `${gamesCompleted} of ${missing.length}`);
          button.setAttribute(
            "aria-label",
            `Fetching covers, ${gamesCompleted} of ${missing.length} complete — activate to cancel`,
          );
        }
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, () => worker()));
  } finally {
    _bulkCoverArtController = null;
    restoreFetchCoversButton();
  }

  if (controller.signal.aborted) {
    showInfoToast(`Cover fetch cancelled — ${applied} applied so far.`, "warning");
  } else if (applied === 0) {
    showInfoToast(`No high-confidence matches found (${skipped} skipped).`, "info");
  } else {
    showInfoToast(
      `Fetched ${applied} cover${applied === 1 ? "" : "s"}${skipped > 0 ? ` — ${skipped} needs manual review` : ""}.`,
      "success",
    );
  }

  // Re-render so freshly-fetched covers appear in the grid.
  void renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
}

interface ExtendedWindow extends Window {
  requestIdleCallback(callback: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void, options?: { timeout: number }): number;
}

export async function renderLibrary(
  library:       GameLibrary,
  settings:      Settings,
  onLaunchGame:  (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef?:  PSPEmulator,
  onApplyPatch?: (gameId: string, patchFile: File) => Promise<void>
): Promise<void> {
  const grid         = document.getElementById("library-grid");
  const countEl      = document.getElementById("library-count");
  const dropZoneEl   = document.getElementById("drop-zone");
  const libSection   = document.getElementById("library-section");
  if (!grid || !countEl || !dropZoneEl || !libSection) return;

  // Show skeleton cards if the grid is empty while we load (avoids blank flash)
  if (grid.children.length === 0) {
    const skeletonFrag = document.createDocumentFragment();
    for (let i = 0; i < 8; i++) {
      const skel = make("div", { class: "game-card game-card--skeleton", "aria-hidden": "true" });
      const iconPlaceholder = make("div", { class: "game-card__icon" });
      const info = make("div", { class: "game-card__info" });
      info.append(
        make("span", { class: "skeleton-line skeleton-line--wide" }),
        make("span", { class: "skeleton-line skeleton-line--mid" }),
        make("span", { class: "skeleton-line skeleton-line--short" }),
      );
      skel.append(iconPlaceholder, info);
      skeletonFrag.appendChild(skel);
    }
    grid.appendChild(skeletonFrag);
  }

  let allGames: GameMetadata[];
  try {
    allGames = await library.getAllGamesMetadata();
  } catch {
    allGames = [];
  }

  // If the previously selected system no longer exists in the current
  // dataset (for example after deleting or reassigning games), clear the
  // stale filter so the library never gets stuck in an empty dead-end state.
  if (_librarySystemFilter) {
    const presentSystemIds = new Set(allGames.map(g => g.systemId));
    if (!presentSystemIds.has(_librarySystemFilter)) {
      _librarySystemFilter = "";
    }
  }

  // Wire up search + sort + filter controls (idempotent)
  _wireLibraryControls(allGames, library, settings, onLaunchGame, emulatorRef, onApplyPatch);

  // Wire up keyboard + gamepad navigation (idempotent)
  startLibraryGamepadNavigation();

  // Build system filter chips
  _renderSystemFilterChips(allGames, library, settings, onLaunchGame, emulatorRef, onApplyPatch);

  // Apply filters and sort
  const displayed = _applyLibraryFilters(allGames);

  const onboardingEl = document.getElementById("onboarding");
  updateLibraryLandingState({
    totalGames: allGames.length,
    shownGames: displayed.length,
    countEl,
    librarySectionEl: libSection,
    dropZoneEl,
    onboardingEl,
  });
  _renderLibraryOverview(allGames, displayed);

  if (emulatorRef && allGames.length > 0) {
    const systemIds = new Set(allGames.map(g => g.systemId));
    for (const sid of systemIds) { emulatorRef.prefetchCore(sid); }
  }

  const gridImgs = grid.querySelectorAll<HTMLImageElement>('img[src^="blob:"]');
  for (const img of gridImgs) URL.revokeObjectURL(img.src);
  grid.innerHTML = "";
  invalidateLibraryGamepadCardCache();

  // Destroy any previous virtual grid before we rebuild the DOM
  if (_virtualGrid) {
    _virtualGrid.destroy();
    _virtualGrid = null;
  }

  // ── Highlights panel (favorites + recent sessions) ─────────────────────────
  // Only shown when the library is in its "clean" state (no active search,
  // system filter, or favorites-only filter) so it does not compete with the
  // user's focused browsing actions.
  const highlightsEl = document.getElementById("library-highlights");
  if (highlightsEl) {
    const showHighlights =
      !_librarySearchQuery && !_librarySystemFilter && !_libraryShowFavorites;

    if (showHighlights && allGames.length > 0) {
      const favorites       = allGames.filter(g => g.isFavorite);
      let recentSessions: import("./sessionTracker.js").PlaySession[] = [];
      try {
        recentSessions = await sessionTracker.getRecentSessions(HIGHLIGHTS_MAX_SESSIONS);
      } catch {
        // IDB may be unavailable in some test/SSR environments; degrade gracefully
      }

      const panel = buildHighlightsPanel({
        favorites,
        recentSessions,
        allGames,
        getSystemIcon:      systemIcon,
        getSystemName:      (id) => getSystemById(id)?.shortName ?? id.toUpperCase(),
        formatRelativeTime,
        formatPlayTime,
        onPlayFavorite: (game) => { void (async () => {
          showLoadingOverlay();
          setLoadingMessage(`Starting ${game.name}…`);
          setLoadingSubtitle("Getting ready to play");
          try {
            let blob = await library.getGameBlob(game.id);
            if (!blob && game.cloudId) {
              setLoadingMessage("Streaming from cloud…");
              setLoadingSubtitle(`Downloading ${game.name} from ${game.cloudId} (Pull & Play)`);
              blob = await fetchFromCloud(game, settings, library);
            }
            if (!blob) {
              hideLoadingOverlay();
              showError(`"${game.name}" could not be found in your library. Try adding it again.`);
              return;
            }
            await library.markPlayed(game.id);
            await onLaunchGame(toLaunchFile(blob, game.fileName), game.systemId, game.id);
          } catch (err) {
            hideLoadingOverlay();
            showError(`Failed to start game: ${err instanceof Error ? err.message : String(err)}`);
          }
        })(); },
        onPlaySession: (game, _session) => { void (async () => {
          if (!game) return;
          showLoadingOverlay();
          setLoadingMessage(`Starting ${game.name}…`);
          setLoadingSubtitle("Getting ready to play");
          try {
            let blob = await library.getGameBlob(game.id);
            if (!blob && game.cloudId) {
              setLoadingMessage("Streaming from cloud…");
              setLoadingSubtitle(`Downloading ${game.name} from ${game.cloudId} (Pull & Play)`);
              blob = await fetchFromCloud(game, settings, library);
            }
            if (!blob) {
              hideLoadingOverlay();
              showError(`"${game.name}" could not be found in your library. Try adding it again.`);
              return;
            }
            await library.markPlayed(game.id);
            await onLaunchGame(toLaunchFile(blob, game.fileName), game.systemId, game.id);
          } catch (err) {
            hideLoadingOverlay();
            showError(`Failed to start game: ${err instanceof Error ? err.message : String(err)}`);
          }
        })(); },
      });

      highlightsEl.innerHTML = "";
      if (panel) highlightsEl.appendChild(panel);
    } else {
      highlightsEl.innerHTML = "";
    }
  }
  // ── End highlights panel ───────────────────────────────────────────────────

  const layout = settings.libraryLayout;
  _libraryLastLayout = layout;
  _syncLibraryControlState();

  grid.className = `library-grid library-grid--${layout}`;

  if (displayed.length === 0 && allGames.length > 0) {
    const activeSystem = _librarySystemFilter ? getSystemById(_librarySystemFilter)?.shortName ?? _librarySystemFilter.toUpperCase() : "";
    const empty = buildFilteredLibraryEmptyState({
      searchQuery: _librarySearchQuery,
      activeSystemLabel: activeSystem,
      onReset: () => {
        _resetLibraryFilters(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
      },
    });
    grid.appendChild(empty);
    return;
  }

  // ── Jump Back In (recently played strip) ──────────────────────────────────
  // Only shown in the default "clean" browse state (no search / filter / sort
  // overrides) so it doesn't interfere with focused browsing actions.
  const showJumpBackIn =
    !_librarySearchQuery &&
    !_librarySystemFilter &&
    !_libraryShowFavorites &&
    _librarySortMode === "lastPlayed" &&
    displayed.length >= 2;

  if (showJumpBackIn) {
    const recent = displayed.slice(0, 6);
    grid.appendChild(buildLibraryRowSection({
      title: "Jump Back In",
      systemId: null,
      games: recent,
      library,
      settings,
      onLaunchGame,
      emulatorRef,
      onApplyPatch,
      systemIcon,
      buildGameCard,
    }));
  }
  // ── End Jump Back In ───────────────────────────────────────────────────────

  // Favorites grouping if enabled
  const hasFavorites = displayed.some(g => g.isFavorite);
  if (settings.libraryGrouped && (hasFavorites || [...new Set(displayed.map(g => g.systemId))].length > 1)) {
    let pool = [...displayed];
    
    if (hasFavorites) {
      const favorites = pool.filter(g => g.isFavorite);
      grid.appendChild(buildLibraryRowSection({
        title: "Favorites",
        systemId: null,
        games: favorites,
        library,
        settings,
        onLaunchGame,
        emulatorRef,
        onApplyPatch,
        isScroll: false,
        systemIcon,
        buildGameCard,
      }));
      pool = pool.filter(g => !g.isFavorite);
    }

    const systemIds = [...new Set(pool.map(g => g.systemId))].sort();
    systemIds.forEach((sid) => {
      const sysGames = pool.filter(g => g.systemId === sid);
      if (sysGames.length > 0) {
        const sys = getSystemById(sid);
        grid.appendChild(buildLibraryRowSection({
          title: sys?.name ?? sid.toUpperCase(),
          systemId: sid,
          games: sysGames,
          library,
          settings,
          onLaunchGame,
          emulatorRef,
          onApplyPatch,
          isScroll: false,
          systemIcon,
          buildGameCard,
        }));
      }
    });
    return;
  }

  // Standard Grid Rendering
  grid.classList.remove("library-section__rows");

  // ── Virtual grid for large libraries ──────────────────────────────────────
  // When the displayed set exceeds VIRTUAL_THRESHOLD items, activate the
  // windowed virtual grid so only cards near the viewport are in the DOM.
  // Smaller sets still use incremental chunked rendering (simpler, no overhead).
  if (displayed.length > VIRTUAL_THRESHOLD) {
    const landingEl = document.getElementById("landing");
    if (landingEl) {
      _virtualGrid = new VirtualGrid<GameMetadata>({
        container: grid,
        scrollEl:  landingEl,
        items:     displayed,
        buildItem: (game, index) => {
          const card = buildGameCard(game, library, settings, onLaunchGame, emulatorRef, onApplyPatch);
          if (index < 20) {
            card.style.setProperty("--card-i", String(index));
            card.classList.add("game-card--entering");
          }
          return card;
        },
      });
    }
    return;
  }

  // ── Incremental rendering for small libraries ──────────────────────────────
  // Incremental rendering for large grids (Phase 5 Optimization)
  const CHUNK_SIZE = 24;
  const initial = displayed.slice(0, CHUNK_SIZE);
  const remaining = displayed.slice(CHUNK_SIZE);

  const renderChunk = (chunk: GameMetadata[], startIdx: number) => {
    const fragment = document.createDocumentFragment();
    chunk.forEach((game, index) => {
      const globalIdx = startIdx + index;
      const card = buildGameCard(game, library, settings, onLaunchGame, emulatorRef, onApplyPatch);
      // Stagger entrance animation
      if (globalIdx < 20) {
        card.style.setProperty("--card-i", String(globalIdx));
        card.classList.add("game-card--entering");
      }
      fragment.appendChild(card);
    });
    grid.appendChild(fragment);
  };

  // Render first chunk immediately
  renderChunk(initial, 0);

  // If more games exist, schedule them in chunks
  if (remaining.length > 0) {
    let offset = CHUNK_SIZE;
    const processNext = () => {
      // Stop if the grid has been cleared or replaced (e.g. user searched/filtered)
      if (document.getElementById("library-grid") !== grid) return;
      
      const nextBatch = remaining.slice(offset - CHUNK_SIZE, offset - CHUNK_SIZE + CHUNK_SIZE);
      if (nextBatch.length === 0) return;

      renderChunk(nextBatch, offset);
      offset += CHUNK_SIZE;
      
      if (offset - CHUNK_SIZE < remaining.length) {
        if ("requestIdleCallback" in window) {
          (window as unknown as ExtendedWindow).requestIdleCallback(processNext, { timeout: 100 });
        } else {
          setTimeout(processNext, FRAME_TIME_MS);
        }
      }
    };
    
    if ("requestIdleCallback" in window) {
      (window as unknown as ExtendedWindow).requestIdleCallback(processNext, { timeout: 100 });
    } else {
      setTimeout(processNext, STEP_FRAME_MS);
    }
  }
}

function _applyLibraryFilters(games: GameMetadata[]): GameMetadata[] {
  let result = games;

  if (_librarySystemFilter) {
    result = result.filter(g => g.systemId === _librarySystemFilter);
  }

  if (_librarySearchQuery) {
    const q = _librarySearchQuery.toLowerCase();
    result = result.filter(g => g.name.toLowerCase().includes(q) || (getSystemById(g.systemId)?.name ?? "").toLowerCase().includes(q) || g.systemId.toLowerCase().includes(q));
  }

  if (_libraryShowFavorites) {
    result = result.filter(g => g.isFavorite);
  }

  switch (_librarySortMode) {
    case "name":
      result = [...result].sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "added":
      result = [...result].sort((a, b) => b.addedAt - a.addedAt);
      break;
    case "system":
      result = [...result].sort((a, b) => a.systemId.localeCompare(b.systemId) || a.name.localeCompare(b.name));
      break;
    case "lastPlayed":
    default:
      result = [...result].sort((a, b) => (b.lastPlayedAt ?? b.addedAt) - (a.lastPlayedAt ?? a.addedAt));
      break;
  }

  return result;
}

function _renderLibraryOverview(allGames: GameMetadata[], displayed: GameMetadata[]): void {
  const overview = document.getElementById("library-overview");
  if (!overview) return;

  if (allGames.length === 0) {
    overview.innerHTML = "";
    return;
  }

  const systemCount = new Set(allGames.map(g => g.systemId)).size;
  const favoriteCount = allGames.filter(g => g.isFavorite).length;
  const missingArtCount = allGames.filter(g => !g.hasCoverArt && !g.thumbnailUrl).length;
  const recentCount = allGames.filter(g => g.lastPlayedAt && Date.now() - g.lastPlayedAt < 14 * 24 * 60 * 60 * 1000).length;
  const hasActiveFilters = displayed.length !== allGames.length || _libraryShowFavorites || !!_librarySearchQuery || !!_librarySystemFilter;

  const item = (label: string, value: string, hint: string, tone = "") => {
    const node = make("div", { class: `library-overview__item${tone ? ` library-overview__item--${tone}` : ""}` });
    node.append(
      make("span", { class: "library-overview__value" }, value),
      make("span", { class: "library-overview__label" }, label),
      make("span", { class: "library-overview__hint" }, hint),
    );
    return node;
  };

  overview.innerHTML = "";
  overview.append(
    item("Systems", String(systemCount), systemCount === 1 ? "one console" : "platform spread"),
    item("Favorites", String(favoriteCount), favoriteCount > 0 ? "quick shelf" : "mark go-to games", favoriteCount > 0 ? "favorite" : ""),
    item("Cover Art", missingArtCount === 0 ? "Full" : `${missingArtCount} missing`, missingArtCount === 0 ? "all set" : "ready to fetch", missingArtCount > 0 ? "warn" : "good"),
    item("Recent", String(recentCount), "played in 14 days"),
  );

  if (hasActiveFilters) {
    const scoped = make("div", { class: "library-overview__scope", role: "status" });
    scoped.append(
      make("span", { class: "library-overview__scope-count" }, String(displayed.length)),
      make("span", {}, "shown with current filters"),
    );
    overview.appendChild(scoped);
  }
}

let _libraryControlsWired = false;

// Persists the last non-zero volume across buildInGameControls rebuilds (e.g.
// game resume) so mute/unmute restores the correct level after a re-render.
function _wireLibraryControls(
  _allGames: GameMetadata[],
  library: GameLibrary,
  settings: Settings,
  onLaunchGame: (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef?: PSPEmulator,
  onApplyPatch?: (gameId: string, patchFile: File) => Promise<void>,
  onSettingsChange?: (patch: Partial<Settings>) => void
): void {
  if (_libraryControlsWired) return;
  const cloudOnboardingBtn = document.getElementById("btn-cloud-onboarding");
  if (cloudOnboardingBtn) {
    cloudOnboardingBtn.addEventListener("click", () => {
      _openSettingsFn?.("cloud");
    });
  }
  const onboardingHelpBtn = document.getElementById("btn-open-help-onboarding");
  if (onboardingHelpBtn) {
    onboardingHelpBtn.addEventListener("click", () => {
      _openSettingsFn?.("help");
    });
  }

  _libraryControlsWired = true;

  const searchEl = document.getElementById("library-search") as HTMLInputElement | null;
  const sortEl   = document.getElementById("library-sort") as HTMLSelectElement | null;
  const clearBtn = document.getElementById("library-search-clear") as HTMLButtonElement | null;
  const resetBtn = document.getElementById("library-controls-reset") as HTMLButtonElement | null;

  _syncLibraryControlState();

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      _resetLibraryFilters(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    });
  }

  const fetchCoversBtn = document.getElementById("library-fetch-covers") as HTMLButtonElement | null;
  if (fetchCoversBtn) {
    fetchCoversBtn.addEventListener("click", () => {
      void _runBulkCoverArtFetch(library, settings, onLaunchGame, emulatorRef, onApplyPatch, fetchCoversBtn);
    });
  }

  if (searchEl) {
    searchEl.addEventListener("input", () => {
      _librarySearchQuery = searchEl.value;
      _syncLibraryControlState();
      _scheduleLibraryRender(library, settings, onLaunchGame, emulatorRef, onApplyPatch, 120);
    });
    searchEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        void focusFirstLibraryCard();
        return;
      }
      if (event.key !== "Escape" || _librarySearchQuery.length === 0) return;
      event.preventDefault();
      searchEl.value = "";
      _librarySearchQuery = "";
      _syncLibraryControlState();
      _scheduleLibraryRender(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    });
  }

  if (sortEl) {
    sortEl.addEventListener("change", () => {
      _librarySortMode = sortEl.value as SortMode;
      _syncLibraryControlState();
      _scheduleLibraryRender(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    });
  }

  if (clearBtn && searchEl) {
    clearBtn.addEventListener("click", () => {
      searchEl.value = "";
      _librarySearchQuery = "";
      _syncLibraryControlState();
      searchEl.focus();
      _scheduleLibraryRender(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    });
  }

  const favFilterBtn = document.getElementById("library-fav-filter");
  if (favFilterBtn) {
    favFilterBtn.addEventListener("click", () => {
      _libraryShowFavorites = !_libraryShowFavorites;
      _syncLibraryControlState();
      _scheduleLibraryRender(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    });
  }

  const layoutBtns = document.querySelectorAll(".layout-btn");
  layoutBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const layout = btn.getAttribute("data-layout") as Settings["libraryLayout"];
      if (layout) {
        onSettingsChange?.({ libraryLayout: layout });
        _scheduleLibraryRender(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
      }
    });
  });
}

function _renderSystemFilterChips(
  games: GameMetadata[],
  library: GameLibrary,
  settings: Settings,
  onLaunchGame: (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef?: PSPEmulator,
  onApplyPatch?: (gameId: string, patchFile: File) => Promise<void>
): void {
  const filterEl = document.getElementById("system-filter");
  if (!filterEl || games.length === 0) {
    if (filterEl) {
      filterEl.innerHTML = "";
      filterEl.closest(".landing-sidebar")?.classList.add("landing-sidebar--empty");
    }
    return;
  }

  const systemIds = [...new Set(games.map(g => g.systemId))].sort();
  if (systemIds.length < 2) {
    filterEl.innerHTML = "";
    filterEl.closest(".landing-sidebar")?.classList.add("landing-sidebar--empty");
    return;
  }

  filterEl.innerHTML = "";
  filterEl.closest(".landing-sidebar")?.classList.remove("landing-sidebar--empty");
  
  const createChip = (id: string, label: string, icon: string) => {
    const chipLabel =
      id === ""
        ? "Show all systems"
        : `Filter by ${label}`;
    const chip = make("button", {
      class: `sys-filter-chip${_librarySystemFilter === id ? " active" : ""}`,
      "aria-pressed": _librarySystemFilter === id ? "true" : "false",
      "aria-label": chipLabel,
    });
    
    const iconEl = make("span", { class: "sys-filter-chip__icon" });
    if (icon.includes("/assets/")) {
      iconEl.appendChild(make("img", { src: icon, alt: "" }));
    } else if (isSvgMarkup(icon)) {
      iconEl.innerHTML = icon;
    } else {
      iconEl.textContent = icon;
    }
    
    const labelEl = make("span", { class: "sys-filter-chip__label" }, label);
    chip.append(iconEl, labelEl);
    
    chip.addEventListener("click", () => {
      _librarySystemFilter = _librarySystemFilter === id ? "" : id;
      _scheduleLibraryRender(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    });
    return chip;
  };

  filterEl.appendChild(createChip("", "All Games", ICON_GRID_ALL_SVG));

  for (const sysId of systemIds) {
    const sys = getSystemById(sysId);
    filterEl.appendChild(createChip(sysId, sys?.shortName ?? sysId, systemIcon(sysId)));
  }
}
function buildGameCard(
  game:          GameMetadata,
  library:       GameLibrary,
  settings:      Settings,
  onLaunchGame:  (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef?:  PSPEmulator,
  onApplyPatch?: (gameId: string, patchFile: File) => Promise<void>
): HTMLElement {
  return buildGameCardImpl(game, library, settings, {
    onLaunchGame,
    onRenderLibrary: () => { void renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch); },
    onFetchFromCloud: fetchFromCloud,
    onOpenApiKeySettings: () => { _openSettingsFn?.("apikeys"); },
    emulatorRef,
    onApplyPatch,
    libraryShowFavorites: _libraryShowFavorites,
  });
}

const FRAME_TIME_MS = 16;
const STEP_FRAME_MS = 32;

// ── Custom confirm dialog ─────────────────────────────────────────────────────

/**
 * Returns true when `overlay` is the most recently appended `.confirm-overlay`
 * in the document.  Used by all modal Escape handlers so only the *topmost*
 * dialog closes when the user presses Escape — an outer gallery does not
 * collapse while an inner confirm dialog is still open.
 */
function showConfirmDialog(
  message: string,
  opts: { title?: string; confirmLabel?: string; isDanger?: boolean } = {}
): Promise<boolean> {
  return showConfirmDialogImpl(message, opts);
}

function _focusLibrarySearch(): boolean {
  const searchEl = document.getElementById("library-search") as HTMLInputElement | null;
  const landing = document.getElementById("landing");
  if (!searchEl || !landing || landing.classList.contains("hidden")) return false;
  searchEl.focus();
  searchEl.select();
  return true;
}

export async function resolveSystemAndAdd(
  file:          File,
  library:       GameLibrary,
  settings:      Settings,
  onLaunchGame:  (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef?:  PSPEmulator,
  onApplyPatch?: (gameId: string, patchFile: File) => Promise<void>,
  preferredSystemId?: string,
): Promise<void> {
  return resolveSystemAndAddImpl(file, library, settings, onLaunchGame, emulatorRef, onApplyPatch,
    () => { void renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch); },
    fetchFromCloud,
    preferredSystemId,
  );
}

// ── Header controls ───────────────────────────────────────────────────────────

export function buildLandingControls(
  settings:         Settings,
  deviceCaps:       DeviceCapabilities,
  library:          GameLibrary,
  biosLibrary:      BiosLibrary,
  onSettingsChange: (patch: Partial<Settings>) => void,
  emulatorRef?:     PSPEmulator,
  onLaunchGame?:    (file: File, systemId: string, gameId?: string) => Promise<void>,
  onResumeGame?:    () => void,
  saveLibrary?:     SaveStateLibrary,
  getNetplayManagerOrInstance?: (() => Promise<import("./multiplayer.js").NetplayManager>) | import("./multiplayer.js").NetplayManager,
  onOpenPlayTogetherSettings?: () => void,
): void {
  // Accept either a factory function or a pre-existing instance (e.g. from tests).
  if (typeof getNetplayManagerOrInstance !== "function" && getNetplayManagerOrInstance != null) {
    registerNetplayInstance(getNetplayManagerOrInstance);
  }
  const getNetplayManager: (() => Promise<import("./multiplayer.js").NetplayManager>) | undefined =
    typeof getNetplayManagerOrInstance === "function"
      ? getNetplayManagerOrInstance
      : getNetplayManagerOrInstance != null
        ? () => Promise.resolve(getNetplayManagerOrInstance)
        : undefined;

  const container = el("#header-actions");
  container.innerHTML = "";

  if (onResumeGame) {
    const btnResume = make("button", { class: "btn btn--primary", title: "Return to the paused game" }, "▶ Resume");
    btnResume.addEventListener("click", onResumeGame);
    container.appendChild(btnResume);
  }

  if (deviceCaps.isLowSpec || deviceCaps.isChromOS) {
    const label = deviceCaps.isChromOS ? "Chromebook" : "Low-spec";
    const tip   = deviceCaps.isChromOS ? "Chromebook detected — Performance mode recommended" : "Performance mode recommended for this device";
    container.appendChild(make("span", { class: "perf-chip perf-chip--warn", title: tip }, label));
  }

  const btnSettings = make("button", { class: "btn", title: "Settings (F9)", "aria-label": "Open settings" });
  btnSettings.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg> Settings <kbd class="kbd--inline">F9</kbd>`;

  btnSettings.addEventListener("click", () => {
    openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulatorRef, onLaunchGame, saveLibrary, getNetplayManager);
  });

  const btnHelp = make("button", {
    class: "btn",
    title: "Getting started guide and keyboard shortcuts",
    "aria-label": "Open help and getting started guide",
  });
  btnHelp.textContent = "Help";
  btnHelp.addEventListener("click", () => {
    openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulatorRef, onLaunchGame, saveLibrary, getNetplayManager, "help");
  });

  const btnMultiplayer = make("button", {
    class: "btn btn--highlight",
    title: "Open Play Together — Host or join a game with friends",
    "aria-label": "Open Play Together",
  }) as HTMLButtonElement;
  btnMultiplayer.innerHTML = `<svg class="btn__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 12h10M12 7v10" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="7" cy="12" r="4" stroke="currentColor" stroke-width="1.9"/><circle cx="17" cy="12" r="4" stroke="currentColor" stroke-width="1.9"/></svg> Play Together`;
  btnMultiplayer.addEventListener("click", () => {
    const openWith = (nm: import("./multiplayer.js").NetplayManager) => {
      openEasyNetplayModalImpl({
        netplayManager: nm,
        currentGameName:  null,
        currentGameId:    null,
        currentSystemId:  emulatorRef?.currentSystem?.id ?? null,
        onOpenPlayTogetherSettings,
      });
    };
    const nmNow = peekNetplayManager();
    if (nmNow) {
      openWith(nmNow);
    } else if (getNetplayManager) {
      void getNetplayManager().then(openWith).catch(err => console.warn("Failed to get netplay manager:", err));
    }
  });

  container.appendChild(btnSettings);
  container.appendChild(btnHelp);
  container.appendChild(btnMultiplayer);
  updateHeaderOverflow();
}

let _inGameControlsAc: AbortController | null = null;

function _isInGameSession(emulator: PSPEmulator): boolean {
  return emulator.state === "running" || emulator.state === "paused";
}

function quickSaveFailureMessage(
  emulator: PSPEmulator,
  getCurrentGameId?: () => string | null,
): string {
  if (!_isInGameSession(emulator)) {
    return "Quick save is not ready yet. Wait for the game to finish starting, then try again.";
  }
  if (!getCurrentGameId?.()) {
    return "Quick save needs a library game context. Return to the library and launch the saved game again.";
  }
  return "Quick save could not capture state data yet. Wait a moment, then try again.";
}

/** Minimal in-game overlay: hamburger button that expands to show controls. */
function buildInGameControls(
  emulator:           PSPEmulator,
  settings:           Settings,
  _onSettingsChange:  (patch: Partial<Settings>) => void,
  onReturnToLibrary:  () => void,
  _saveLibrary?:      SaveStateLibrary,
  saveService?:      SaveGameService,
  getCurrentGameId?:  () => string | null,
  getCurrentGameName?: () => string | null,
  _getCurrentSystemId?: () => string | null,
  _onOpenSettings?:    (tab?: SettingsTab) => void,
  _getNetplayManager?: () => Promise<import("./multiplayer.js").NetplayManager>,
  _onOpenPlayTogetherSettings?: () => void,
  _onOpenPlayTogetherLobby?: () => void,
  _getCurrentCoreOptions?: () => Record<string, string>,
  _onUpdateCoreOption?: (key: string, value: string) => void,
): void {
  const headerContainer = el("#header-actions");
  headerContainer.innerHTML = "";
  const overlayContainer = document.getElementById("in-game-overlay");
  if (overlayContainer) {
    overlayContainer.innerHTML = "";
    overlayContainer.hidden = false;
    overlayContainer.setAttribute("aria-hidden", "false");
  }
  const currentGameName = getCurrentGameName?.()?.trim() || settings.lastGameName?.trim() || "Unknown";

  if (_inGameControlsAc) {
    _inGameControlsAc.abort();
  }
  _inGameControlsAc = new AbortController();
  const signal = _inGameControlsAc.signal;

  const buildNowPlayingChip = () => {
    const chip = make("div", {
      class: "now-playing-chip header-priority-chip",
      role: "status",
      "aria-live": "polite",
      "aria-label": `Now playing ${currentGameName}`,
      title: currentGameName,
    });
    chip.textContent = `Now playing \u00b7 ${currentGameName}`;
    return chip;
  };

  const buildLibraryButton = (className: string) => {
    const btnLibrary = make("button", {
      class: className,
      type: "button",
      title: "Back to Library (Esc)",
      "aria-label": "Back to Library",
    });
    btnLibrary.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg> Library`;
    btnLibrary.addEventListener("click", () => onReturnToLibrary(), { signal });
    return btnLibrary;
  };

  headerContainer.append(buildNowPlayingChip(), buildLibraryButton("btn btn--gradient header-priority-primary"));

  if (overlayContainer) {
    let isExpanded = false;

    const hamburgerBtn = make("button", {
      class: "in-game-overlay__hamburger",
      type: "button",
      title: "Open game menu",
      "aria-label": "Open game menu",
      "aria-expanded": "false",
    });
    hamburgerBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;

    const expandedPanel = make("div", {
      class: "in-game-overlay__panel",
      role: "menu",
      "aria-label": "In-game controls",
      hidden: "",
    });

    const chip = make("div", { class: "in-game-overlay__panel-chip" });
    chip.textContent = `Now playing \u00b7 ${currentGameName}`;

    const actions = make("div", { class: "in-game-overlay__panel-actions", role: "group", "aria-label": "In-game quick actions" });
    if (_onOpenSettings) {
      const btnSettings = make("button", {
        class: "btn btn--ghost in-game-overlay__btn",
        type: "button",
        title: "Open Settings (F9)",
        "aria-label": "Open Settings",
        role: "menuitem",
      }, "Settings");
      btnSettings.addEventListener("click", () => _onOpenSettings("performance"), { signal });
      actions.append(btnSettings);
    }
    const btnRestart = make("button", {
      class: "btn btn--ghost in-game-overlay__btn",
      type: "button",
      title: "Restart the current game",
      "aria-label": "Restart Game",
      role: "menuitem",
    }, "Restart");
    btnRestart.addEventListener("click", () => {
      try { emulator.reset(); }
      catch (err) { console.warn("In-game restart failed:", err); }
    }, { signal });
    actions.append(btnRestart);

    if (saveService) {
      const btnQuickSave = make("button", {
        class: "btn btn--ghost in-game-overlay__btn",
        type: "button",
        title: "Save state to Slot 1 (F5)",
        "aria-label": "Quick Save",
        role: "menuitem",
      }, "Quick Save");
      btnQuickSave.addEventListener("click", () => {
        void saveService.saveSlot(1)
          .then((entry) => {
            if (entry) showInfoToast("Saved to Slot 1");
            else showError(quickSaveFailureMessage(emulator, getCurrentGameId));
          })
          .catch((err) => showError(`Quick save failed: ${err instanceof Error ? err.message : String(err)}`));
      }, { signal });
      actions.append(btnQuickSave);

      const btnQuickLoad = make("button", {
        class: "btn btn--ghost in-game-overlay__btn",
        type: "button",
        title: "Load state from Slot 1 (F7)",
        "aria-label": "Quick Load",
        role: "menuitem",
      }, "Quick Load");
      btnQuickLoad.addEventListener("click", () => {
        void saveService.loadSlot(1)
          .then((ok) => {
            if (ok) showInfoToast("Loaded Slot 1");
            else showError("Nothing saved in Slot 1 yet, or the emulator is still starting.");
          })
          .catch((err) => showError(`Quick load failed: ${err instanceof Error ? err.message : String(err)}`));
      }, { signal });
      actions.append(btnQuickLoad);

      const btnSyncCloud = make("button", {
        class: "btn btn--ghost in-game-overlay__btn",
        type: "button",
        title: "Run save sync now",
        "aria-label": "Sync Saves",
        role: "menuitem",
      }, "Sync Saves");
      btnSyncCloud.addEventListener("click", async () => {
        try {
          const synced = await saveService.syncGameMetadata();
          if (synced) {
            showInfoToast("Save sync completed successfully");
          } else if (!getCurrentGameId?.()) {
            showError("Save sync needs an active library game. Return to the library and launch the saved game again.");
          } else {
            showError("Save sync is not connected. Turn it on in Settings \u2192 Save Sync.");
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          showError(`Save sync failed: ${msg}`);
        }
      }, { signal });
      actions.append(btnSyncCloud);
    }

    actions.append(buildLibraryButton("btn btn--gradient in-game-overlay__btn"));
    const libBtn = actions.lastElementChild as HTMLElement;
    if (libBtn) libBtn.setAttribute("role", "menuitem");

    const closeBtn = make("button", {
      class: "in-game-overlay__close",
      type: "button",
      title: "Close menu",
      "aria-label": "Close menu",
    });
    closeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

    expandedPanel.append(chip, actions, closeBtn);
    overlayContainer.append(hamburgerBtn, expandedPanel);

    const togglePanel = () => {
      isExpanded = !isExpanded;
      expandedPanel.hidden = !isExpanded;
      hamburgerBtn.setAttribute("aria-expanded", String(isExpanded));
      overlayContainer.classList.toggle("in-game-overlay--expanded", isExpanded);
      if (isExpanded) {
        const firstBtn = expandedPanel.querySelector(".in-game-overlay__btn, .in-game-overlay__close") as HTMLElement | null;
        afterNextPaint(() => firstBtn?.focus());
      } else {
        hamburgerBtn.focus();
      }
    };

    hamburgerBtn.addEventListener("click", togglePanel, { signal });
    closeBtn.addEventListener("click", togglePanel, { signal });

    document.addEventListener("click", (e) => {
      if (!isExpanded) return;
      const target = e.target as HTMLElement;
      if (!expandedPanel.contains(target) && !hamburgerBtn.contains(target)) {
        togglePanel();
      }
    }, { signal });
  }

  document.addEventListener(LEGACY_EVENTS.returnToLibrary, () => {
    if (overlayContainer) {
      overlayContainer.hidden = true;
      overlayContainer.setAttribute("aria-hidden", "true");
      overlayContainer.innerHTML = "";
    }
    _inGameControlsAc?.abort();
    _inGameControlsAc = null;
  }, { once: true, signal });
}

// ── Auto-save restore prompt ──────────────────────────────────────────────────

export async function promptAutoSaveRestore(saveLibrary: SaveStateLibrary, gameId: string): Promise<boolean> {
  const hasAuto = await saveLibrary.hasAutoSave(gameId);
  if (!hasAuto) return false;
  return showConfirmDialog(
    "A crash-recovery save was found from your last session. Would you like to restore it?",
    { title: "Restore Auto-Save?", confirmLabel: "Restore" }
  );
}



// ── Tier downgrade prompt ─────────────────────────────────────────────────────

export async function showTierDowngradePrompt(
  averageFPS:  number,
  currentTier: import("./performance.js").PerformanceTier,
  targetTier:  import("./performance.js").PerformanceTier
): Promise<boolean> {
  const tierNames: Record<string, string> = { ultra: "Ultra", high: "High", medium: "Medium", low: "Low" };
  const message =
    `The game is running at an average of ${averageFPS} FPS on the ` +
    `${tierNames[currentTier] ?? currentTier} quality tier.\n\n` +
    `Switching to the ${tierNames[targetTier] ?? targetTier} tier will reduce rendering ` +
    `quality but should provide a smoother experience on this device. ` +
    `This preference will be remembered for this game.\n\n` +
    `Tip: turn on \"Dynamic resolution\" in Settings → Performance so supported 3D systems ` +
    `can scale internal resolution automatically before you change tiers.`;
  return showConfirmDialog(message, {
    title: "Low Frame Rate Detected",
    confirmLabel: `Switch to ${tierNames[targetTier] ?? targetTier} Tier`,
    isDanger: false,
  });
}

// ── FPS overlay / perf suggestion — extracted to src/ui/widgets/fpsOverlay.ts ──

// ── Header overflow indicator ─────────────────────────────────────────────────

function updateHeaderOverflow(): void {
  const actions = document.getElementById("header-actions");
  if (!actions) return;
  requestAnimationFrame(() => {
    actions.classList.toggle("overflows", actions.scrollWidth > actions.clientWidth);
  });
}

// ── State-driven DOM updates ──────────────────────────────────────────────────

function updateStatusDot(state: EmulatorState): void {
  const dot   = document.getElementById("status-dot");
  const label = document.getElementById("status-state");
  if (!dot || !label) return;
  const labels: Record<EmulatorState, string> = {
    idle: "Ready",
    loading: "Loading…",
    running: "Playing",
    paused: "Paused",
    error: "Something went wrong"
  };
  dot.className     = `status-dot ${state}`;
  label.textContent = labels[state];
  if (state === "loading") showLoadingOverlay();

  // Show/hide the "Playing: …" items in footer
  const isActive = state === "running" || state === "paused";
  const sysItem  = document.getElementById("status-system-item");
  const sysLabel = document.getElementById("status-system-label");
  const tierItem = document.getElementById("status-tier-item");
  if (sysItem)  sysItem.classList.toggle("status-item--hidden", !isActive);
  if (sysLabel) sysLabel.classList.toggle("status-item--hidden", !isActive);
  if (tierItem) tierItem.classList.toggle("status-item--hidden", !isActive);

  if (state === "idle" || state === "error") { setStatusGame("—"); setStatusSystem("—"); setStatusTier(null); }
}


const setLoadingProgress = setLoadingProgressImpl;

async function fetchFromCloud(game: GameMetadata, settings: Settings, libraryForCache?: GameLibrary): Promise<Blob> {
  const conn = settings.cloudLibraries.find(c => c.id === game.cloudId);
  if (!conn) throw new Error("Cloud connection not found. Reconnect your library in Settings.");
  const provider = createProvider(conn);
  if (!provider) throw new Error("Cloud provider could not be initialized.");
  
  const url = await provider.getDownloadUrl(game.remotePath!);
  const headers: Record<string, string> = {};
  
  // Specific auth handling for providers that don't return pre-signed URLs
  if (conn.provider === "gdrive") {
    const config = parseCloudLibraryConnectionConfig(conn.config);
    if (config?.accessToken) headers["Authorization"] = `Bearer ${config.accessToken}`;
  } else if (conn.provider === "webdav") {
    const config = parseCloudLibraryConnectionConfig(conn.config);
    if (!config) throw new Error("Cloud provider could not be initialized.");
    const credentials = `${config.username}:${config.password}`;
    const utf8Bytes = new TextEncoder().encode(credentials);
    let binary = "";
    for (let i = 0; i < utf8Bytes.length; i++) {
      binary += String.fromCharCode(utf8Bytes[i]!);
    }
    headers["Authorization"] = "Basic " + btoa(binary);
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
     if (response.status === 401 || response.status === 403) {
       throw new Error("Cloud authentication failed. Please reconnect your account.");
     }
     throw new Error(`Cloud download failed: ${response.statusText} (${response.status})`);
  }
  
  // Stream with progress tracking
  const contentLength = response.headers.get('content-length');
  const total = contentLength ? parseInt(contentLength, 10) : 0;
  let loaded = 0;

  const reader = response.body?.getReader();
  if (!reader) {
    const blob = await response.blob();
    await cacheCloudGameBlob(game, blob, libraryForCache);
    return blob;
  }

  const chunks: BlobPart[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = new Uint8Array(value.byteLength);
    chunk.set(value);
    chunks.push(chunk);
    loaded += value.length;
    if (total > 0) {
      setLoadingProgress((loaded / total) * 100);
    }
  }

  const blob = new Blob(chunks);
  await cacheCloudGameBlob(game, blob, libraryForCache);
  return blob;
}

async function cacheCloudGameBlob(
  game: GameMetadata,
  blob: Blob,
  libraryForCache?: GameLibrary,
): Promise<void> {
  if (!libraryForCache || !game.cloudId) return;
  setLoadingSubtitle("Saving a browser copy for faster future launches...");
  try {
    await libraryForCache.updateGameFile(game.id, toLaunchFile(blob, game.fileName));
  } catch (error) {
    showInfoToast(
      `Downloaded "${game.name}", but could not keep a browser copy: ${error instanceof Error ? error.message : String(error)}`,
      "warning",
    );
  }
}


// ── Visibility helpers ────────────────────────────────────────────────────────

function hideLanding(): void    { el("#landing").classList.add("hidden"); }
function showLanding(): void    { el("#landing").classList.remove("hidden"); }
export const showLoadingOverlay = showLoadingOverlayImpl;
export const hideLoadingOverlay = hideLoadingOverlayImpl;
function showEjsContainer(): void  {
  document.getElementById(EMULATOR_JS_CONTAINER_ID)?.classList.add("visible");
}
function hideEjsContainer(): void  {
  document.getElementById(EMULATOR_JS_CONTAINER_ID)?.classList.remove("visible");
}

function transitionToGame(): void {
  document.body.classList.add("is-playing");
  stopLibraryGamepadNavigation();
  hideLanding();
  closeSettingsPanel();
  requestAnimationFrame(() => showEjsContainer());
}

export function transitionToLibrary(): void {
  document.body.classList.remove("is-playing");
  syncEmulatorViewportLayout(document.getElementById(EMULATOR_JS_CONTAINER_ID), null);
  hideEjsContainer();
  requestAnimationFrame(() => {
    showLanding();
    restartLibraryGamepadNavigation();
  });
}
function afterNextPaint(callback: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}
export const setLoadingMessage = setLoadingMessageImpl;
export const setLoadingSubtitle = setLoadingSubtitleImpl;
function setStatusGame(name: string): void    { const e = document.getElementById("status-game");    if (e) e.textContent = name; }
function setStatusSystem(name: string): void  { const e = document.getElementById("status-system");  if (e) e.textContent = name; }
function setStatusTier(tier: PerformanceTier | null): void { const e = document.getElementById("status-tier"); if (e) e.textContent = tier ? formatTierLabel(tier) : "—"; }

export const showError = showErrorImpl;
export const hideError = hideErrorImpl;
export const showInfoToast = showInfoToastImpl;

// ── Test helpers ──────────────────────────────────────────────────────────────
