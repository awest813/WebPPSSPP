/**
 * ui.ts â€” Build and wire the full application UI
 *
 * Views:
 *   landing    â€” game library grid + "Add Game" drop zone (shown on startup)
 *   emulator   â€” EmulatorJS fills the screen (shown while a game runs)
 *
 * Panels (overlays over the current view):
 *   settings   â€” tabbed: Performance, Display, Library, BIOS
 *   systemPicker â€” shown when a file extension maps to multiple systems
 *   loading    â€” spinner during emulator boot
 *   error      â€” dismissible error banner
 *
 * Keyboard shortcuts (global, while a game session is active â€” running or paused):
 *   F5  â†’ Quick Save slot 1
 *   F7  â†’ Quick Load slot 1
 *   F1  â†’ Reset (confirmation dialog â€” same as toolbar)
 *   Esc â†’ Close in-game menu if open; otherwise open the in-game menu (immersive mode).
 *         Return to the library via the menuâ€™s â€œBack to Libraryâ€ action.
 *
 * All shortcut handlers use the capture phase and stopPropagation() so the
 * intercepted keys never reach the EmulatorJS key-input handler, while all
 * regular game-control keys (arrows, letters, etc.) pass through untouched.
 *
 * Global keyboard shortcuts (always active):
 *   F9  â†’ Open Settings â†’ Debug tab
 *   F3  â†’ Toggle developer debug overlay (FPS, frame time, memory, draw calls)
 */

import { diagWarn } from "./diagnosticLog.js";
import { setNetworkDocumentState, subscribeToNetworkChanges } from "./connectivity.js";
import {
  PSPEmulator,
  type EmulatorState,
  type FPSSnapshot,
} from "./emulator.js";
import {
  SYSTEMS,
  ALL_EXTENSIONS,
  detectSystem,
  getSystemById,
  type SystemInfo,
} from "./systems.js";
import {
  GameLibrary,
  formatBytes,
  formatRelativeTime,
  type GameMetadata,
  clearGameTierProfile,
  clearGameGraphicsProfile,
} from "./library.js";
import { parseCloudLibraryConnectionConfig } from "./cloudLibrary.js";
import {
  type DeviceCapabilities,
  type PerformanceTier,
  formatTierLabel,
  isLikelyIOS,
  isLikelyAndroid,
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
import type { NetplayManager } from "./multiplayer.js";
import {
  isNetplaySupportedSystemId,
} from "./multiplayerUtils.js";
import { getNetplayManager, peekNetplayManager, registerNetplayInstance } from "./netplaySingleton.js";
import { store } from "./store/index.js";
import {
  ICON_ALERT_TRIANGLE_SVG,
  ICON_BATTERY_SVG,
  ICON_CLOSE_X_SVG,
  ICON_GAMEPAD_DECOR_SVG,
  ICON_GRID_ALL_SVG,
  ICON_ROTATE_PHONE_SVG,
  ICON_TROPHY_SVG,
  INFO_TOAST_ICON_HTML,
  ONBOARD_ICON_FAST_SVG,
  ONBOARD_ICON_INPUTS_SVG,
  ONBOARD_ICON_LOCK_SVG,
  isSvgMarkup,
} from "./chromeIcons.js";
import { resolveNetplayRoomKey } from "./multiplayer.js"; // Stay in lazy chunk for now
import { EasyNetplayManager } from "./netplay/EasyNetplayManager.js";
import type { EasyNetplayRoom } from "./netplay/netplayTypes.js";
import { normaliseInviteCode, INVITE_CODE_LEN } from "./netplay/signalingClient.js";
import { checkSystemSupport } from "./netplay/compatibility.js";
import { getCloudSaveManager } from "./cloudSaveSingleton.js";
import { createProvider } from "./cloudLibrary.js";
import { SaveGameService } from "./saveService.js";
import type { ArchiveExtractProgress, ArchiveFormat } from "./archive.js";
import { LEGACY_EVENTS } from "./legacy.js";
import { queryRequired as el, createElement as make } from "./ui/dom.js";
import {
  getEasyNetplayManager as sharedGetEasyNetplayManager,
  renderEasyDiagnosticEntry as sharedRenderEasyDiagnosticEntry,
  renderRoomCard as sharedRenderRoomCard,
} from "./ui/easyNetplayShared.js";
import {
  showConfirmDialog as showConfirmDialogImpl,
  pickSystem as pickSystemImpl,
  showGamePickerDialog as showGamePickerDialogImpl,
  showArchiveEntryPickerDialog as showArchiveEntryPickerDialogImpl,
  showMultiDiscPicker as showMultiDiscPickerImpl,
  showCoverArtPickerDialog as showCoverArtPickerDialogImpl,
  showCoverArtCandidatePicker,
  showGameDetails,
  isTopmostOverlay,
  type CoverArtPickResult,
} from "./ui/modals.js";
import {
  fetchAndValidateCoverArt,
  listGamesMissingCoverArt,
  AUTO_APPLY_CONFIDENCE_THRESHOLD,
  type CoverArtCandidate,
} from "./coverArt.js";
import {
  getApiKeyStore,
  getCoverArtProvider,
  getKeyedProviders,
} from "./ui/coverArtRegistry.js";
import {
  buildFilteredLibraryEmptyState,
  updateLibraryLandingState,
} from "./ui/libraryView.js";
import {
  buildLibraryHero as buildLibraryHeroSection,
  buildLibraryRow as buildLibraryRowSection,
} from "./ui/librarySections.js";
import { createDebugConsoleController } from "./ui/debugConsole.js";
import { ArchiveSelectionStore } from "./archiveStore.js";
import { sessionTracker, formatPlayTime } from "./sessionTracker.js";
import { shaderCache } from "./shaderCache.js";
import {
  toggleDevOverlay,
  updateDevOverlay,
  showFPSOverlay,
  resetDevOverlayCache,
} from "./modules/DevOverlay.js";
import { VirtualGrid, VIRTUAL_THRESHOLD } from "./ui/virtualGrid.js";
import { InputRouter } from "./ui/InputRouter.js";
import { buildHighlightsPanel, MAX_SESSIONS as HIGHLIGHTS_MAX_SESSIONS } from "./ui/highlightsPanel.js";
import { parseRAKey } from "./raCredentials.js";
// Re-export DevOverlay public API so external callers that imported from ui.ts
// continue to work without changes (e.g. ui.test.ts).
export { toggleDevOverlay, isDevOverlayVisible } from "./modules/DevOverlay.js";
import type { RAProgress } from "./types/metadata.js";
import { buildPerfTab } from "./ui/tabs/PerfTab.js";
import { buildDisplayTab } from "./ui/tabs/DisplayTab.js";
import { buildLibraryTab } from "./ui/tabs/LibraryTab.js";
import { buildCloudTab } from "./ui/tabs/CloudTab.js";
import { buildMultiplayerTab } from "./ui/tabs/MultiplayerTab.js";
import { buildDebugTab } from "./ui/tabs/DebugTab.js";

// Cache for RetroAchievements progress to avoid redundant API hits during a session.
const _raProgressCache = new Map<string, { data: RAProgress; ts: number }>();
const RA_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getCachedRAProgress(gameId: string): RAProgress | null {
  const entry = _raProgressCache.get(gameId);
  if (!entry) return null;
  if (Date.now() - entry.ts > RA_CACHE_TTL) {
    _raProgressCache.delete(gameId);
    return null;
  }
  return entry.data;
}

function setCachedRAProgress(gameId: string, data: RAProgress): void {
  _raProgressCache.set(gameId, { data, ts: Date.now() });
}

const APP_BASE_URL = import.meta.env.BASE_URL;
const APP_NAME = "RetroOasis";
const resolveAssetUrl = (path: string): string => {
  const base = APP_BASE_URL === "/" ? "" : APP_BASE_URL;
  return `${base}${path}`;
};

// â”€â”€ Settings opener callback (set once from initUI, used by showError action buttons) â”€â”€
let _openSettingsFn: ((tab?: string) => void) | null = null;

let _initUICleanup: (() => void) | null = null;

let _libGpCachedCards: HTMLElement[] | null = null;
let _virtualGrid: VirtualGrid<GameMetadata> | null = null;
let _fpsOverlayEls: Record<string, HTMLElement | null> | null = null;
let _settingsPanelEscHandler: ((e: KeyboardEvent) => void) | null = null;
let _settingsPanelFocusTrap: ((e: KeyboardEvent) => void) | null = null;
let _settingsPanelSearchShortcutHandler: ((e: KeyboardEvent) => void) | null = null;
let _settingsTabBarRo: ResizeObserver | null = null;
let _settingsContentCleanups: Array<() => void> = [];
let _settingsContentToken = 0;

// â”€â”€ API key store + cover-art provider registry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Registry singletons live in ./ui/coverArtRegistry.ts; see there for the
// rebuild subscription that wires Settings â†’ API Keys tab changes back into
// the composed provider chain.

// â”€â”€ DOM helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Debug Console State & Logic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const _debugConsole = createDebugConsoleController({ onToggleDevOverlay: () => toggleDevOverlay() });

function toggleDebugConsole(emulator?: PSPEmulator): void {
  _debugConsole.toggle(emulator);
}

function updateDebugConsoleLog(emulator: PSPEmulator): void {
  _debugConsole.update(emulator);
}

// â”€â”€ Build DOM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const _LOGO_FALLBACK_SVG = `<svg class="brand-logo" width="44" height="44" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="${APP_NAME}" role="img">
  <rect width="44" height="44" rx="12" fill="#111318" />
  <circle cx="22" cy="22" r="16" fill="#56B6C2" />
  <path d="M11 25C13.5 19.8 17.6 17 22 17C26.4 17 30.5 19.8 33 25C30.5 30.2 26.4 33 22 33C17.6 33 13.5 30.2 11 25Z" fill="#E0A44C" />
  <rect x="14" y="20" width="16" height="8" rx="4" fill="#151922" stroke="#F7F3E8" stroke-width="1.5" />
  <path d="M18 23V25M17 24H19" stroke="#F7F3E8" stroke-width="1.4" stroke-linecap="round" />
  <circle cx="25" cy="24" r="1.1" fill="#56B6C2" />
  <circle cx="28" cy="24" r="1.1" fill="#E0A44C" />
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
  // Stop any running gamepad polling loop and allow re-wiring on the new DOM
  if (_libraryGamepadRafId !== null) {
    cancelAnimationFrame(_libraryGamepadRafId);
    _libraryGamepadRafId = null;
  }
  _libraryNavWired   = false;
  _libGpPrevAxes     = [];
  _libGpPrevBtns     = [];
  _libGpRepeatTimer  = 0;
  document.body.classList.remove("using-gamepad");
  // Reset DevOverlay cached DOM references (nodes will be recreated below)
  resetDevOverlayCache();
  _fpsOverlayEls = null;
  resetPerfSuggestion();

  const archivePickerExts = [
    "zip", "7z", "rar", "tar", "gz", "tgz",
    "bz2", "tbz", "tbz2", "xz", "txz",
    "zst", "lz", "lzma", "cab",
  ];
  const acceptExts = [...new Set([...ALL_EXTENSIONS, ...archivePickerExts])];
  const acceptList = acceptExts.map(e => `.${e}`).join(",");
  // Build a concise format hint: first extension of the first 8 systems + archive note
  const hintExts = SYSTEMS.slice(0, 8).map(s => `.${s.extensions[0]}`).join(" Â· ");
  const formatHint = `${hintExts} + more Â· ZIP auto-extracted Â· 7Z/RAR/TAR/GZ supported`;
  const touchUI = isTouchDevice();
  const pwaMode = isPwaDisplayMode();

  if (touchUI || pwaMode) {
    document.documentElement.classList.add("touch-ui");
  }

  app.innerHTML = `
    <!-- Skip navigation link for keyboard users -->
    <a class="skip-link" href="#landing">Skip to content</a>

    <!-- â”€â”€ Header â”€â”€ -->
    <header class="app-header">
        <div class="app-header__brand" aria-label="${APP_NAME}">
          <img src="${resolveAssetUrl("assets/retrooasis-logo.svg")}" alt="" class="brand-logo" width="44" height="44" decoding="async" fetchpriority="high" draggable="false" aria-hidden="true" />
          <span class="brand-long">${APP_NAME}</span>
        </div>

      <div class="app-header__actions" id="header-actions">
        <!-- Populated by buildLandingControls() / buildInGameControls() -->
      </div>
    </header>

    <!-- â”€â”€ Main content area â”€â”€ -->
    <main class="app-main">

      <!-- Library / landing view -->
      <section id="landing" aria-label="Game Library">

        <!-- Library grid -->
        <div id="library-section">
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
                       type="search" placeholder="Search gamesâ€¦" autocomplete="off"
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
                      title="Match games against online cover databases (Settings â†’ API Keys)">
                Fetch covers
              </button>
            </div>
          </div>
          <div class="library-overview" id="library-overview" aria-label="Library overview">
            <!-- Populated by renderLibrary() -->
          </div>
          <div id="library-highlights" aria-label="Library highlights">
            <!-- Favorites + recent-sessions feed populated by renderLibrary() -->
          </div>
          <div class="system-filter" id="system-filter">
            <!-- System filter chips â€” populated by renderLibrary() -->
          </div>
          <div class="library-grid" id="library-grid">
            <!-- Cards populated by renderLibrary() -->
          </div>
        </div>

        <!-- Drop zone -->
          <div class="drop-zone" id="drop-zone" tabindex="0" role="button" aria-label="Add a game file" aria-describedby="drop-zone-subtitle drop-zone-formats">
          <input type="file"
                 id="file-input"
                 accept="${acceptList}"
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

        <!-- Onboarding â€” only visible when library is empty -->
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
          <img src="${resolveAssetUrl("assets/retrooasis-logo.svg")}" alt="" class="loading-brand__logo" width="72" height="72" decoding="async" draggable="false" />
        </div>
        <div class="loading-spinner" aria-hidden="true"></div>
        <div class="loading-content">
          <p id="loading-message">Loadingâ€¦</p>
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
                 placeholder="Type a command (reset, pause, step, help)â€¦" 
                 spellcheck="false" autocomplete="off" />
        </div>
      </div>

      <!-- Mobile floating action button â€” touch devices only (CSS hides on pointer:fine) -->
      <button class="mobile-fab mobile-fab--hidden" id="mobile-fab"
              aria-label="Add a game" title="Add a game file">ï¼‹</button>

      <!-- Portrait rotation hint â€” visible when playing in portrait orientation -->
      <div class="rotate-hint" id="rotate-hint" aria-live="polite" aria-atomic="true">
        <span class="rotate-hint__icon" aria-hidden="true">${ICON_ROTATE_PHONE_SVG}</span> Rotate for best experience
      </div>

    </main>

    <!-- â”€â”€ Footer â”€â”€ -->
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
        ${!window.crossOriginIsolated ? `<span class="footer-info footer-coi-warning" role="note" aria-label="Cross-origin isolation is not active. PSP and N64 performance may be reduced." title="Cross-origin isolation is not active â€” PSP/N64 performance may be reduced."><span class="footer-coi-warning__icon" aria-hidden="true">${ICON_ALERT_TRIANGLE_SVG}</span> COI</span>` : ""}
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

// â”€â”€ Public init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  /** Pre-existing NetplayManager instance â€” registers it as the singleton when provided (useful for tests). */
  netplayManager?:    import("./multiplayer.js").NetplayManager;
  canInstallPWA?:     () => boolean;
  onInstallPWA?:      () => Promise<boolean>;
}

export const RESTART_REQUIRED_EVENT = LEGACY_EVENTS.restartRequired;

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

  // â”€â”€ Console Clock Loop â”€â”€
  const updateClock = () => {
    const clockEl = document.getElementById("footer-clock");
    if (!clockEl) return;
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };
  updateClock();
  // Align the repeating interval to the next wall-clock minute so the display
  // never lags more than ~1 s behind the actual time.
  const msToNextMinute = 60_000 - (Date.now() % 60_000);
  let clockInterval: ReturnType<typeof setInterval> | null = null;
  const clockAlignTimeout = setTimeout(() => {
    updateClock();
    clockInterval = setInterval(updateClock, 60_000);
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
    () => { clearTimeout(clockAlignTimeout); if (clockInterval !== null) clearInterval(clockInterval); }
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

  // â”€â”€ Gamepad connection toast â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const _onGamepadConnected = (e: Event) => {
    showInfoToast(`Gamepad connected: ${(e as GamepadEvent).gamepad.id}`, "info");
  };
  const _onGamepadDisconnected = (e: Event) => {
    showInfoToast(`Disconnected: ${(e as GamepadEvent).gamepad.id}`, "warning");
  };
  bindEvent(window, "gamepadconnected", _onGamepadConnected);
  bindEvent(window, "gamepaddisconnected", _onGamepadDisconnected);

  // â”€â”€ Live battery indicator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      .catch(() => { /* Battery API unavailable or denied â€” keep element hidden */ });
  }

  // â”€â”€ Chromebook tablet mode listener â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        : "No network â€” online-only features are unavailable";
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

  /** Close the Multiplayer modal (if open) and jump to Play Together settings. */
  const openPlayTogetherSettings = () => {
    document.dispatchEvent(new CustomEvent(LEGACY_EVENTS.closeEasyNetplay));
    openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, getNetplayManager, "multiplayer");
  };

  const openPlayTogetherLobby = (): void => {
    if (!getNetplayManager) return;
    void getNetplayManager().then((nm) => {
      openEasyNetplayModal({
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

  // â”€â”€ File drop / pick â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    const file = fileInput.files?.[0];
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
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    if (emulator.state === "running") {
      showError("Return to the library first (Esc or â† Library) before loading a new game.");
      return;
    }
    void onFileChosen(file);
  };
  bindEvent(document, "dragover", onDragOver);
  bindEvent(document, "dragenter", onDragEnter);
  bindEvent(document, "dragleave", onDragLeave);
  bindEvent(document, "drop", onDrop);
  bindEvent(window, "blur", clearDragOver);

  // â”€â”€ Error banner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bindEvent(el("#error-close"), "click", hideError);

  // â”€â”€ Mobile FAB â€” "Add Game" button (touch devices) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The FAB is visible on the library page; hidden during gameplay.
  // It is rendered in the DOM for all builds and hidden via CSS (pointer: fine).
  const mobileFab = document.getElementById("mobile-fab");
  if (mobileFab) {
    bindEvent(mobileFab, "click", () => openFilePicker());
  }

  // â”€â”€ Portrait rotation hint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ FPS overlay wiring â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ Emulator lifecycle â†’ DOM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    setStatusSystem(sys ? sys.shortName : "â€”");
    setStatusGame(name);
    setStatusTier(emulator.activeTier);
    document.title = `${name} â€” ${APP_NAME}`;
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
    document.title = `${name} â€” ${APP_NAME}`;
    setStatusSystem(sys ? sys.shortName : "â€”");
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

  // â”€â”€ Keyboard shortcuts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Register in the capture phase (third argument `true`) so our shortcuts
  // are processed before the EmulatorJS keydown handler (which listens on the
  // player element). Calling stopPropagation() here prevents F5/F7/F1/F9/Esc
  // from ever reaching EmulatorJS while all other keys (game controls) pass
  // through normally and are handled by EmulatorJS as expected.

  const inputRouter = new InputRouter();
  // Global shortcuts context — always active. Handlers return true when they
  // consume the event so the router stops dispatch.
  inputRouter.register("global", [
    // Ctrl+K / / — focus library search (when no modal/panel is open)
    (e) => {
      if (
        ((e.key === "/" && !e.shiftKey) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) &&
        !_isEditableTarget(e.target) &&
        !document.querySelector(".confirm-overlay, .easy-netplay-overlay, #settings-panel:not([hidden]), #system-picker:not([hidden])")
      ) {
        if (_focusLibrarySearch()) return true;
      }
      return false;
    },
    // F9 — open Debug tab
    (e) => { if (e.key === "F9") { openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, getNetplayManager, "debug"); return true; } return false; },
    // F3 — toggle dev overlay; Shift+F3 toggles debug console
    (e) => { if (e.key === "F3") { if (e.shiftKey) toggleDebugConsole(emulator); else toggleDevOverlay(); return true; } return false; },
    // Escape — dismiss error banner or return to library
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
      if (document.body.classList.contains("is-playing")) { onReturnToLibrary(); return true; }
      return false;
    },
    // F5, F7, F8, F1 — in-game save/load/reset (only when game is active)
    (e) => {
      if (!_isInGameSession(emulator)) return false;
      switch (e.key) {
        case "F5": void saveService.saveSlot(1).then((entry) => { if (entry) showInfoToast("Saved to Slot 1"); else showError("Quick save failed — add this game to your library or wait for the core to finish starting."); }); return true;
        case "F7": void saveService.loadSlot(1).then((ok) => { if (ok) showInfoToast("Loaded Slot 1"); else showError("Nothing saved in Slot 1 yet, or the emulator is still starting."); }); return true;
        case "F8": void saveService.findNextSlot().then((slot) => { void saveService.saveSlot(slot).then((entry) => { if (entry) showInfoToast(`Saved to Slot ${slot}`); else showError("Save failed — wait for the core to finish starting."); }); }); return true;
        case "F1": void (async () => { const confirmed = await showConfirmDialog("Unsaved progress will be lost.", { title: "Reset Game?", confirmLabel: "Reset", isDanger: true }); if (confirmed) emulator.reset(); })(); return true;
      }
      return false;
    },
  ]);

  // ── Landing header controls ─────────────────────────────────────────────
  buildLandingControls(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, undefined, saveLibrary, getNetplayManager, openPlayTogetherSettings);

  if (typeof ResizeObserver !== "undefined") {
    const headerActions = document.getElementById("header-actions");
    if (headerActions) {
      const ro = new ResizeObserver(updateHeaderOverflow);
      ro.observe(headerActions);
      cleanupFns.push(() => ro.disconnect());
    }
  }

  // â”€â”€ Initial library render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  _initUICleanup = () => {
    cleanupFns.forEach((cleanup) => cleanup());
    cleanupFns.length = 0;
    _inGameControlsAc?.abort();
    _inGameControlsAc = null;
    inputRouter.destroy();
  };

  void renderLibrary(library, settings, onLaunchGame, emulator, onApplyPatch);
}

// â”€â”€ Cinematic Overhaul Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
      : "Match games against online cover databases (Settings â†’ API Keys)";
    fetchCoversBtn.setAttribute(
      "aria-label",
      offline
        ? "Fetch missing cover art â€” unavailable while offline"
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
    button.textContent = "Fetch covers";
    button.setAttribute("aria-label", "Fetch missing cover art from online");
    button.title = "Match games against online cover databases (Settings â†’ API Keys)";
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
    showInfoToast("You're offline â€” connect to the internet to fetch covers.", "warning");
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
    button.textContent = `0/${missing.length}`;
    button.setAttribute(
      "aria-label",
      `Fetching covers, 0 of ${missing.length} complete â€” activate to cancel`,
    );
    button.title = "Fetching covers â€” click again to cancel";
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

  showInfoToast(`Fetching covers for ${missing.length} gamesâ€¦`, "info");

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
          limit: 1,
          signal: controller.signal,
          hashes,
        });
        if (controller.signal.aborted) return;
        const best = candidates[0];
        if (!best || best.score < AUTO_APPLY_CONFIDENCE_THRESHOLD) {
          skipped++;
          continue;
        }
        const blob = await fetchAndValidateCoverArt(best.imageUrl, { signal: controller.signal });
        if (controller.signal.aborted) return;
        await library.setCoverArt(game.id, blob);
        applied++;
      } catch {
        if (controller.signal.aborted) return;
        skipped++;
      } finally {
        gamesCompleted++;
        if (button) {
          button.textContent = `${gamesCompleted}/${missing.length}`;
          button.setAttribute(
            "aria-label",
            `Fetching covers, ${gamesCompleted} of ${missing.length} complete â€” activate to cancel`,
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
    showInfoToast(`Cover fetch cancelled â€” ${applied} applied so far.`, "warning");
  } else if (applied === 0) {
    showInfoToast(`No high-confidence matches found (${skipped} skipped).`, "info");
  } else {
    showInfoToast(
      `Fetched ${applied} cover${applied === 1 ? "" : "s"}${skipped > 0 ? ` â€” ${skipped} needs manual review` : ""}.`,
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
  _wireLibraryNavigation();

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
  _libGpCachedCards = null;

  // Destroy any previous virtual grid before we rebuild the DOM
  if (_virtualGrid) {
    _virtualGrid.destroy();
    _virtualGrid = null;
  }

  // â”€â”€ Highlights panel (favorites + recent sessions) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
          setLoadingMessage(`Starting ${game.name}â€¦`);
          setLoadingSubtitle("Getting ready to play");
          try {
            let blob = await library.getGameBlob(game.id);
            if (!blob && game.cloudId) {
              setLoadingMessage("Streaming from cloudâ€¦");
              setLoadingSubtitle(`Downloading ${game.name} from ${game.cloudId} (Pull & Play)`);
              blob = await fetchFromCloud(game, settings);
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
          setLoadingMessage(`Starting ${game.name}â€¦`);
          setLoadingSubtitle("Getting ready to play");
          try {
            let blob = await library.getGameBlob(game.id);
            if (!blob && game.cloudId) {
              setLoadingMessage("Streaming from cloudâ€¦");
              setLoadingSubtitle(`Downloading ${game.name} from ${game.cloudId} (Pull & Play)`);
              blob = await fetchFromCloud(game, settings);
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
  // â”€â”€ End highlights panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const layout = settings.libraryLayout;
  _libraryLastLayout = layout;
  _syncLibraryControlState();

  grid.className = `library-grid library-grid--${layout}`;

  const isCinematicMode = settings.libraryGrouped && !_librarySearchQuery && !_librarySystemFilter && !_libraryShowFavorites && _librarySortMode === "lastPlayed" && displayed.length >= 5;

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

  if (isCinematicMode && displayed.length > 0) {
    grid.classList.add("library-section__rows");
    
    // 1. Hero (Last Played)
    const lastPlayed = displayed[0]!;
    const hero = buildLibraryHeroSection({
      game: lastPlayed,
      library,
      settings,
      onLaunchGame,
      systemIcon,
      escapeHtml: _escHtml,
      fetchFromCloud,
      toLaunchFile,
      showLoadingOverlay,
      setLoadingMessage,
      setLoadingSubtitle,
      hideLoadingOverlay,
      showError,
    });
    hero.style.setProperty("--row-i", "0");
    hero.classList.add("library-hero--entering");
    grid.appendChild(hero);
    
    // 2. Continue Playing Row (Recent 2-6 excluding hero)
    const recent = displayed.slice(1, 7);
    if (recent.length > 0) {
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
    
    // 3. System Groups
    const systemIds = [...new Set(displayed.map(g => g.systemId))].sort();
    systemIds.forEach((sid, idx) => {
      const sysGames = displayed.filter(g => g.systemId === sid);
      if (sysGames.length > 0) {
        const sys = getSystemById(sid);
        const row = buildLibraryRowSection({
          title: sys?.name ?? sid.toUpperCase(),
          systemId: sid,
          games: sysGames,
          library,
          settings,
          onLaunchGame,
          emulatorRef,
          onApplyPatch,
          systemIcon,
          buildGameCard,
        });
        row.style.setProperty("--row-i", String(idx + 1));
        row.classList.add("library-row--entering");
        grid.appendChild(row);
      }
    });
    return;
  }

  // Favorites grouping if enabled and not in cinematic mode
  const hasFavorites = displayed.some(g => g.isFavorite);
  if (settings.libraryGrouped && !isCinematicMode && (hasFavorites || [...new Set(displayed.map(g => g.systemId))].length > 1)) {
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

  // â”€â”€ Virtual grid for large libraries â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ Incremental rendering for small libraries â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Library keyboard / gamepad navigation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _libraryNavWired = false;
let _libraryGamepadRafId: number | null = null;
let _libraryGamepadRestartFn: (() => void) | null = null;
// Tracks per-axis/button state for gamepad repeat logic
let _libGpPrevAxes: number[] = [];
let _libGpPrevBtns: boolean[] = [];
let _libGpRepeatTimer = 0;
const _LIB_NAV_INITIAL_DELAY = 400; // ms before held-direction auto-repeat starts
const _LIB_NAV_REPEAT_RATE   = 150; // ms between repeats once held

/**
 * Reads the live gamepad snapshot (standard Gamepad API + legacy WebKit).
 * Returns only non-null pads that report `connected` â€” avoids ghost entries
 * and matches browser behaviour until the user presses a face button on some platforms.
 */
function _getNavigatorGamepads(): Gamepad[] {
  let raw: readonly (Gamepad | null)[];
  if (typeof navigator.getGamepads === "function") {
    raw = navigator.getGamepads();
  } else if (typeof navigator.webkitGetGamepads === "function") {
    raw = navigator.webkitGetGamepads() as unknown as (Gamepad | null)[];
  } else {
    return [];
  }
  const out: Gamepad[] = [];
  for (let i = 0; i < raw.length; i++) {
    const g = raw[i];
    if (g != null && g.connected) out.push(g);
  }
  return out;
}

/** Treats analogue pressure and `pressed` as a digital down (fixes some Chrome / Linux drivers). */
function _gamepadBtnDown(btn: GamepadButton | undefined): boolean {
  if (!btn) return false;
  if (btn.pressed) return true;
  const v = typeof btn.value === "number" ? btn.value : 0;
  return v > 0.35;
}

/**
 * True while modals/overlays own focus â€” keep library gamepad from fighting them.
 * Cached per-frame: re-evaluates on each call but stores result for the same rAF
 * tick so that multiple consumers (_libGamepadTick + keydown handlers) share one
 * DOM query set.  Flag is invalidated on next requestAnimationFrame.
 */
let _gpNavSuppressedCache = false;
let _gpNavSuppressedFrame = -1;

function _libraryGamepadNavSuppressed(): boolean {
  const now = performance.now();
  if (Math.floor(now / 16) !== _gpNavSuppressedFrame) {
    _gpNavSuppressedFrame = Math.floor(now / 16);
    _gpNavSuppressedCache =
      !!document.getElementById("error-banner")?.classList.contains("visible") ||
      !!document.querySelector(".confirm-overlay") ||
      !!(document.getElementById("settings-panel") && !document.getElementById("settings-panel")!.hidden) ||
      !!document.querySelector("#system-picker:not([hidden])") ||
      !!document.querySelector(".easy-netplay-overlay");
  }
  return _gpNavSuppressedCache;
}

function _invalidateLibraryGamepadCardCache(): void {
  _libGpCachedCards = null;
}

function _queryLibraryGameCards(): HTMLElement[] {
  const grid = document.getElementById("library-grid");
  if (!grid) return [];
  return Array.from(grid.querySelectorAll<HTMLElement>(".game-card"));
}

/** Focus first visible library card (toolbar / search â†’ grid). */
function _focusFirstLibraryCard(): boolean {
  const cards = _queryLibraryGameCards();
  if (!cards.length) return false;
  _invalidateLibraryGamepadCardCache();
  cards[0]!.focus();
  _safeScrollIntoView(cards[0]!, { block: "nearest", behavior: "smooth" });
  return true;
}

function _focusLastLibraryCard(): boolean {
  const cards = _queryLibraryGameCards();
  if (!cards.length) return false;
  const last = cards[cards.length - 1]!;
  _invalidateLibraryGamepadCardCache();
  last.focus();
  _safeScrollIntoView(last, { block: "nearest", behavior: "smooth" });
  return true;
}

/** Move focus among library game cards using arrow keys or gamepad. */
function _wireLibraryNavigation(): void {
  if (_libraryNavWired) return;

  const grid = document.getElementById("library-grid");
  if (!grid) return;

  _libraryNavWired = true;

  // â”€â”€ Arrow key navigation on the grid container â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  grid.addEventListener("keydown", (e: KeyboardEvent) => {
    const key = e.key;
    if (key !== "ArrowLeft" && key !== "ArrowRight" &&
        key !== "ArrowUp"   && key !== "ArrowDown"  &&
        key !== "Home"       && key !== "End"       &&
        key !== "PageUp"     && key !== "PageDown") return;

    const cards = Array.from(grid.querySelectorAll<HTMLElement>(".game-card"));
    if (!cards.length) return;

    const focused = document.activeElement as HTMLElement | null;
    const idx = focused ? cards.indexOf(focused) : -1;
    if (idx === -1) {
      // Enter the grid from the surrounding section without Tab-to-card first.
      if (key === "ArrowDown" || key === "PageDown") {
        e.preventDefault();
        void _focusFirstLibraryCard();
      } else if (key === "ArrowUp" || key === "PageUp") {
        e.preventDefault();
        void _focusLastLibraryCard();
      } else if (key === "Home") {
        e.preventDefault();
        void _focusFirstLibraryCard();
      } else if (key === "End") {
        e.preventDefault();
        void _focusLastLibraryCard();
      }
      return;
    }

    e.preventDefault();

    let nextIdx = idx;
    if (key === "ArrowLeft") {
      nextIdx = Math.max(0, idx - 1);
    } else if (key === "ArrowRight") {
      nextIdx = Math.min(cards.length - 1, idx + 1);
    } else if (key === "Home" || key === "PageUp") {
      nextIdx = 0;
    } else if (key === "End" || key === "PageDown") {
      nextIdx = cards.length - 1;
    } else {
      // ArrowUp / ArrowDown â€” find closest card in the row above/below
      const curRect = cards[idx]!.getBoundingClientRect();
      const curMidX = curRect.left + curRect.width / 2;
      const curTop  = curRect.top;
      let best = -1;
      let bestScore = Infinity;
      for (let i = 0; i < cards.length; i++) {
        if (i === idx) continue;
        const r = cards[i]!.getBoundingClientRect();
        if (key === "ArrowUp"   && r.top >= curTop - 4) continue;
        if (key === "ArrowDown" && r.top <= curTop + 4) continue;
        const dx = Math.abs((r.left + r.width / 2) - curMidX);
        const dy = Math.abs(r.top - curTop);
        // Weight horizontal distance more heavily so same-column cards are preferred
        const score = dx * 3 + dy;
        if (score < bestScore) { bestScore = score; best = i; }
      }
      if (best !== -1) nextIdx = best;
    }

    if (nextIdx !== idx) {
      cards[nextIdx]!.focus();
      _invalidateLibraryGamepadCardCache();
      _safeScrollIntoView(cards[nextIdx]!, { block: "nearest", behavior: "smooth" });
    }
  });

  // Toolbar / overview / filters â†’ press Arrow Down to move focus into the grid
  const librarySection = document.getElementById("library-section");
  if (librarySection) {
    librarySection.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown") return;
      const landingEl = document.getElementById("landing");
    if (!landingEl || landingEl.classList.contains("hidden")) {
      if (_libraryGamepadRafId !== null) {
        cancelAnimationFrame(_libraryGamepadRafId);
        _libraryGamepadRafId = null;
      }
      return;
    }
      if (_libraryGamepadNavSuppressed()) return;
      const t = e.target as HTMLElement;
      if (t.closest(".game-card")) return;
      if (t.id === "library-search") return;
      if (t.id === "library-sort") return;
      if (t.closest("#drop-zone")) return;
      if (!t.closest(".library-toolbar, .system-filter, .library-overview, #library-highlights")) return;
      e.preventDefault();
      void _focusFirstLibraryCard();
    });
  }

  // â”€â”€ Gamepad polling loop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Runs continuously but only acts when the landing page is visible.
  function _libGamepadTick(): void {
    _libraryGamepadRafId = requestAnimationFrame(_libGamepadTick);

    // Only navigate when the library landing is visible (not while a game runs)
    const landingEl = document.getElementById("landing");
    if (!landingEl || landingEl.classList.contains("hidden")) {
      cancelAnimationFrame(_libraryGamepadRafId);
      _libraryGamepadRafId = null;
      return;
    }

    if (_libraryGamepadNavSuppressed()) return;

    const gp = _getNavigatorGamepads()[0];
    if (!gp) {
      document.body.classList.remove("using-gamepad");
      return;
    }

    // Activating gamepad mode for specialized focus visuals
    if (!document.body.classList.contains("using-gamepad")) {
      document.body.classList.add("using-gamepad");
    }

    const now = performance.now();

    const ax = gp.axes[0] ?? 0;
    const ay = gp.axes[1] ?? 0;
    // Certain pads expose the D-pad as extra axes instead of buttons 12â€“15.
    const hatX = gp.axes.length > 6 ? (gp.axes[6] ?? 0) : 0;
    const hatY = gp.axes.length > 7 ? (gp.axes[7] ?? 0) : 0;

    // Directional: standard D-pad (12â€“15), left stick, optional hat axes (6â€“7)
    const rawUp =
      _gamepadBtnDown(gp.buttons[12]) || ay < -0.55 || hatY < -0.55;
    const rawDown =
      _gamepadBtnDown(gp.buttons[13]) || ay > 0.55 || hatY > 0.55;
    const rawLeft =
      _gamepadBtnDown(gp.buttons[14]) || ax < -0.55 || hatX < -0.55;
    const rawRight =
      _gamepadBtnDown(gp.buttons[15]) || ax > 0.55 || hatX > 0.55;

    // Button 0 = Cross/A (launch), Button 1 = Circle/B (deselect)
    // Button 4 = L1 (page up), Button 5 = R1 (page down)
    // Button 9 = Start (settings)
    const btnA = _gamepadBtnDown(gp.buttons[0]);
    const btnB = _gamepadBtnDown(gp.buttons[1]);
    const btnL1 = _gamepadBtnDown(gp.buttons[4]);
    const btnR1 = _gamepadBtnDown(gp.buttons[5]);
    const btnStart = _gamepadBtnDown(gp.buttons[9]);

    const prevBtnA = _libGpPrevBtns[0] ?? false;
    const prevBtnB = _libGpPrevBtns[1] ?? false;
    const prevBtnL1 = _libGpPrevBtns[4] ?? false;
    const prevBtnR1 = _libGpPrevBtns[5] ?? false;
    const prevBtnStart = _libGpPrevBtns[9] ?? false;

    // Rising-edge detection for action buttons
    const pressedA = btnA && !prevBtnA;
    const pressedB = btnB && !prevBtnB;
    const pressedL1 = btnL1 && !prevBtnL1;
    const pressedR1 = btnR1 && !prevBtnR1;
    const pressedStart = btnStart && !prevBtnStart;

    _libGpPrevBtns[0] = btnA;
    _libGpPrevBtns[1] = btnB;
    _libGpPrevBtns[4] = btnL1;
    _libGpPrevBtns[5] = btnR1;
    _libGpPrevBtns[9] = btnStart;

    const anyDir = rawUp || rawDown || rawLeft || rawRight;

    // Determine whether this frame triggers a navigation step (rising edge or repeat)
    let doMove = false;
    if (anyDir) {
      if (_libGpPrevAxes[0] !== 1) {
        // First frame the direction was pressed â†’ move immediately
        doMove = true;
        _libGpRepeatTimer = now + _LIB_NAV_INITIAL_DELAY;
      } else if (now >= _libGpRepeatTimer) {
        // Held long enough â†’ auto-repeat
        doMove = true;
        _libGpRepeatTimer = now + _LIB_NAV_REPEAT_RATE;
      }
    }
    _libGpPrevAxes[0] = anyDir ? 1 : 0;

    const needCards = pressedA || pressedB || pressedL1 || pressedR1 || pressedStart || doMove;
    if (!needCards) return;

    // Virtual grid reuses DOM elements on scroll â€” querySelectorAll returns the same
    // element references, so we can cache them.  The cache is invalidated when
    // setItems rebuilds the pool or buildDOM re-creates the grid.
    let cards: HTMLElement[];
    if (_virtualGrid) {
      if (!_libGpCachedCards) {
        _libGpCachedCards = Array.from(grid!.querySelectorAll<HTMLElement>(".game-card"));
      }
      cards = _libGpCachedCards;
    } else {
      if (!_libGpCachedCards) {
        _libGpCachedCards = Array.from(grid!.querySelectorAll<HTMLElement>(".game-card"));
      }
      cards = _libGpCachedCards;
    }

    if (pressedStart) {
      // Find the settings button and click it
      const settingsBtn = document.getElementById("header-settings-btn");
      settingsBtn?.click();
      return;
    }

    if (pressedA && cards.length) {
      const focused = document.activeElement as HTMLElement | null;
      const idx = focused ? cards.indexOf(focused) : -1;
      if (idx !== -1) { cards[idx]!.click(); return; }
      // No card focused â€” focus & launch first card
      cards[0]!.focus();
      _invalidateLibraryGamepadCardCache();
      cards[0]!.click();
      return;
    }

    if (pressedB) {
      // Deselect / return focus to the search input
      const searchEl = document.getElementById("library-search") as HTMLInputElement | null;
      if (searchEl) searchEl.focus();
      return;
    }

    if ((pressedL1 || pressedR1) && cards.length) {
      const focused = document.activeElement as HTMLElement | null;
      const idx = focused ? cards.indexOf(focused) : -1;
      const jump = 10;
      let nextIdx = idx;
      if (pressedL1) nextIdx = Math.max(0, idx - jump);
      if (pressedR1) nextIdx = Math.min(cards.length - 1, idx + jump);
      if (idx === -1) nextIdx = 0;
      
      if (nextIdx !== idx) {
        cards[nextIdx]!.focus();
        _invalidateLibraryGamepadCardCache();
        _safeScrollIntoView(cards[nextIdx]!, { block: "nearest", behavior: "smooth" });
      }
      return;
    }

    if (!doMove || !cards.length) return;

    const focused = document.activeElement as HTMLElement | null;
    const idx = focused ? cards.indexOf(focused) : -1;

    if (idx === -1) {
      // Nothing focused yet â€” focus the first card
      cards[0]!.focus();
      _invalidateLibraryGamepadCardCache();
      _safeScrollIntoView(cards[0]!, { block: "nearest", behavior: "smooth" });
      return;
    }

    let nextIdx = idx;
    if (rawLeft) {
      nextIdx = Math.max(0, idx - 1);
    } else if (rawRight) {
      nextIdx = Math.min(cards.length - 1, idx + 1);
    } else {
      // Up / Down â€” same column-detection logic as keyboard
      const curRect = cards[idx]!.getBoundingClientRect();
      const curMidX = curRect.left + curRect.width / 2;
      const curTop  = curRect.top;
      let best = -1;
      let bestScore = Infinity;
      for (let i = 0; i < cards.length; i++) {
        if (i === idx) continue;
        const r = cards[i]!.getBoundingClientRect();
        if (rawUp   && r.top >= curTop - 4) continue;
        if (rawDown && r.top <= curTop + 4) continue;
        const dx = Math.abs((r.left + r.width / 2) - curMidX);
        const dy = Math.abs(r.top - curTop);
        const score = dx * 3 + dy;
        if (score < bestScore) { bestScore = score; best = i; }
      }
      if (best !== -1) nextIdx = best;
    }

    if (nextIdx !== idx) {
      cards[nextIdx]!.focus();
      _invalidateLibraryGamepadCardCache();
      _safeScrollIntoView(cards[nextIdx]!, { block: "nearest", behavior: "smooth" });
    }
  }

  _libraryGamepadRafId = requestAnimationFrame(_libGamepadTick);
  _libraryGamepadRestartFn = () => {
    if (_libraryGamepadRafId === null) {
      _libraryGamepadRafId = requestAnimationFrame(_libGamepadTick);
    }
  };
}

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
      _openSettingsFn?.("about");
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
        void _focusFirstLibraryCard();
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
    if (filterEl) filterEl.innerHTML = "";
    return;
  }

  const systemIds = [...new Set(games.map(g => g.systemId))].sort();
  if (systemIds.length < 2) {
    filterEl.innerHTML = "";
    return;
  }

  filterEl.innerHTML = "";
  
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
  const system = getSystemById(game.systemId);
  const sysColor = system?.color ?? "#555";

  // A game is considered "new" for 24 hours after it is added to the library.
  const NEW_THRESHOLD_MS = 24 * 60 * 60 * 1000;
  const isNew = Date.now() - game.addedAt < NEW_THRESHOLD_MS;

  const ariaLabel = isNew
    ? `New game: Play ${game.name} (${system?.shortName ?? game.systemId})`
    : `Play ${game.name} (${system?.shortName ?? game.systemId})`;
  const card = make("div", { class: "game-card", role: "button", tabindex: "0", "aria-label": ariaLabel });
  if (isNew) card.classList.add("game-card--new");
  card.style.setProperty("--sys-color", sysColor);

  const icon = make("div", { class: "game-card__icon" });
  icon.setAttribute("aria-hidden", "true");
  icon.style.setProperty("--sys-gradient", `linear-gradient(135deg, ${sysColor}33, ${sysColor}11)`);

  const cardTop = make("div", { class: "game-card__topline" });
  const cardSystem = make("span", { class: "game-card__system-chip" }, system?.shortName ?? game.systemId.toUpperCase());
  cardSystem.style.setProperty("--sys-color", sysColor);
  const cardStatus = make("span", {
    class: `game-card__status-chip${game.cloudId ? " game-card__status-chip--cloud" : ""}`,
  }, game.cloudId ? "Cloud" : game.lastPlayedAt ? "Played" : "New");
  cardTop.append(cardSystem, cardStatus);
  icon.appendChild(cardTop);

  // System icon (SVG, emoji, or image URL) wrapped in a span so CSS can hide it when cover art is shown
  const sysIconWrap = make("span", { class: "game-card__sys-icon", "aria-hidden": "true" });
  const iconOutput = systemIcon(game.systemId);
  if (iconOutput.includes("/assets/")) {
    const sysImg = make("img", { src: iconOutput, alt: "", class: "sys-icon-img" });
    sysImg.addEventListener("error", () => {
      sysImg.remove();
      sysIconWrap.textContent = system?.shortName ?? game.systemId.toUpperCase();
    }, { once: true });
    sysIconWrap.appendChild(sysImg);
  } else if (isSvgMarkup(iconOutput)) {
    sysIconWrap.innerHTML = iconOutput;
  } else {
    sysIconWrap.textContent = iconOutput;
  }
  icon.appendChild(sysIconWrap);

  if (game.cloudId) {
    const cloudBadge = make("div", { class: "game-card__cloud-badge", title: "Cloud Stream" });
    icon.appendChild(cloudBadge);
  }

  if (isNew) {
    const newBadge = make("div", { class: "game-card__new-badge", "aria-hidden": "true" }, "NEW");
    icon.appendChild(newBadge);
  }

  if (system?.hasAchievements) {
    const achBadge = make("div", { class: "game-card__ach-badge", title: "RetroAchievements Supported" });
    achBadge.innerHTML = ICON_TROPHY_SVG;
    icon.appendChild(achBadge);
  }

  // Fallback "Premium" Placeholder
  const fallback = make("div", { class: "game-card__fallback" });
  fallback.style.setProperty("--sys-color-bright", `${sysColor}dd`);
  const fallbackBadge = make("div", { class: "game-card__fallback-badge" }, system?.shortName ?? "Game");
  const fallbackIcon = make("div", { class: "game-card__fallback-icon" });
  if (iconOutput.includes("/assets/")) {
    const fallbackImg = make("img", { src: iconOutput, alt: "", class: "game-card__fallback-img" });
    fallbackImg.addEventListener("error", () => {
      fallbackImg.remove();
      fallbackIcon.textContent = system?.shortName ?? game.systemId.toUpperCase();
    }, { once: true });
    fallbackIcon.appendChild(fallbackImg);
  } else {
    fallbackIcon.textContent = iconOutput;
  }
  const fallbackName = make("div", { class: "game-card__fallback-name" }, game.name);
  fallback.append(fallbackBadge, fallbackIcon, fallbackName);
  icon.appendChild(fallback);

  // Cover art: local blob takes precedence over remote thumbnailUrl
  let coverArtObjectUrl: string | null = null;
  const coverArtImg = make("img", {
    alt: "",
    class: "game-card__cover-art",
    draggable: "false",
    loading: "lazy",
  }) as HTMLImageElement;

  const restoreFallback = () => {
    icon.classList.remove("game-card__icon--has-art");
    if (coverArtImg.parentNode) coverArtImg.parentNode.removeChild(coverArtImg);
    fallback.classList.remove("game-card__fallback--hidden");
    if (coverArtObjectUrl) {
      URL.revokeObjectURL(coverArtObjectUrl);
      coverArtObjectUrl = null;
    }
  };
  coverArtImg.onerror = restoreFallback;

  const applyCoverArt = (src: string) => {
    coverArtImg.src = src;
    icon.classList.add("game-card__icon--has-art");
    if (!icon.contains(coverArtImg)) {
      icon.appendChild(coverArtImg);
    }
    fallback.classList.add("game-card__fallback--hidden");
  };

  if (game.hasCoverArt) {
    void library.getCoverArt(game.id).then((blob) => {
      if (!blob) return;
      if (!icon.isConnected) return;
      coverArtObjectUrl = URL.createObjectURL(blob);
      applyCoverArt(coverArtObjectUrl);
    });
  } else if (game.thumbnailUrl) {
    applyCoverArt(game.thumbnailUrl);
  }

  const info = make("div", { class: "game-card__info" });
  const name = make("div", { class: "game-card__name" }, game.name);
  const meta = make("div", { class: "game-card__meta" });
  const badge = make("span", { class: "sys-badge" }, system?.shortName ?? game.systemId);
  badge.style.setProperty("--sys-color", sysColor);
  const size = make("span", { class: "game-card__size" }, formatBytes(game.size));
  meta.append(badge, size);
  if (system?.experimental) {
    meta.append(make("span", { class: "sys-badge sys-badge--experimental", title: system.stabilityNotice ?? "Experimental support" }, "EXP"));
  }

  const featureRow = buildSystemFeatureRow(system, { includeExperimental: false, max: 5, includeOnline: true });
  const played = make("div", { class: "game-card__played" },
    game.lastPlayedAt
      ? `Played ${formatRelativeTime(game.lastPlayedAt)}`
      : `Added ${formatRelativeTime(game.addedAt)}`
  );
  if (!game.lastPlayedAt && isNew) played.classList.add("game-card__played--fresh");
  const scanline = make("div", { class: "game-card__scanline" });
  scanline.append(
    make("span", { class: "game-card__scan-title" }, game.name),
    make("span", { class: "game-card__scan-meta" }, `${system?.shortName ?? game.systemId.toUpperCase()} / ${formatBytes(game.size)}`),
  );

  info.append(name, meta);
  if (featureRow) info.append(featureRow);
  info.append(played);

  const btnRemove = make("button", {
    class: "game-card__remove",
    title: "Remove from library",
    "aria-label": `Remove ${game.name}`,
  });
  btnRemove.innerHTML = ICON_CLOSE_X_SVG;
  btnRemove.addEventListener("click", async (e) => {
    e.stopPropagation();
    const confirmed = await showConfirmDialog(
      `"${game.name}" will be removed from your library. The file will not be deleted from your device.`,
      { title: "Remove Game", confirmLabel: "Remove", isDanger: true }
    );
    if (!confirmed) return;
    await library.removeGame(game.id);
    clearGameTierProfile(game.id);
    clearGameGraphicsProfile(game.id);
    void shaderCache.clearForGame(game.id);
    showInfoToast(`"${game.name}" removed from library.`, "info");
    void renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
  });

  const btnFav = make("button", {
    class: `game-card__fav${game.isFavorite ? " active" : ""}`,
    title: game.isFavorite ? "Remove from favorites" : "Add to favorites",
    "aria-label": game.isFavorite ? `Remove ${game.name} from favorites` : `Add ${game.name} to favorites`,
    "aria-pressed": String(game.isFavorite),
  }, "â˜…");
  btnFav.addEventListener("click", async (e) => {
    e.stopPropagation();
    const next = !game.isFavorite;
    await library.setFavorite(game.id, next);
    game.isFavorite = next;
    btnFav.classList.toggle("active", next);
    btnFav.title = next ? "Remove from favorites" : "Add to favorites";
    btnFav.setAttribute("aria-label", next ? `Remove ${game.name} from favorites` : `Add ${game.name} to favorites`);
    btnFav.setAttribute("aria-pressed", String(next));
    if (_libraryShowFavorites || settings.libraryGrouped) {
      void renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    }
  });

  let patchInput: HTMLInputElement | null = null;
  let btnPatch: HTMLButtonElement | null = null;
  if (onApplyPatch) {
    patchInput = make("input", {
      type: "file",
      accept: ".ips,.bps,.ups",
      "aria-label": `Apply patch to ${game.name}`,
      style: "display:none",
    }) as HTMLInputElement;

    btnPatch = make("button", {
      class: "game-card__patch",
      title: "Apply IPS/BPS/UPS patch",
      "aria-label": `Apply patch to ${game.name}`,
    }, "âŠ•") as HTMLButtonElement;

    btnPatch.addEventListener("click", (e) => { e.stopPropagation(); patchInput!.click(); });
    patchInput.addEventListener("change", async () => {
      const patchFile = patchInput!.files?.[0];
      if (!patchFile) return;
      patchInput!.value = "";
      try {
        showLoadingOverlay();
        setLoadingMessage(`Applying patch to ${game.name}â€¦`);
        await onApplyPatch(game.id, patchFile);
        hideLoadingOverlay();
        showInfoToast(`Patch applied to "${game.name}".`, "success");
        void renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
      } catch (err) {
        hideLoadingOverlay();
        showError(`Patch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  const btnChangeSystem = make("button", {
    class: "game-card__change-sys",
    title: "Change system / emulator",
    "aria-label": `Change system for ${game.name}`,
  }, "âŸ³");

  btnChangeSystem.addEventListener("click", async (e) => {
    e.stopPropagation();
    const newSystem = await pickSystem(
      game.name,
      SYSTEMS,
      `Choose the emulator for "${game.name}". Currently assigned to: ${system?.name ?? game.systemId}`
    );
    if (!newSystem || newSystem.id === game.systemId) return;
    try {
      await library.changeSystemId(game.id, newSystem.id);
      void renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    } catch (err) {
      showError(`Could not change system: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  const playOverlay = make("div", { class: "game-card__play-overlay", "aria-hidden": "true" });
  const playBtn     = make("div", { class: "game-card__play-btn" }, "â–¶");
  playOverlay.appendChild(playBtn);


  // â”€â”€ Cover art button â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const btnArt = make("button", {
    class: "game-card__art-btn",
    title: game.hasCoverArt || game.thumbnailUrl ? "Change cover art" : "Set cover art",
    "aria-label": game.hasCoverArt || game.thumbnailUrl
      ? `Change cover art for ${game.name}`
      : `Set cover art for ${game.name}`,
  }, "");

  const handleCoverArtResult = async (result: CoverArtPickResult | null, artBtn: HTMLButtonElement): Promise<void> => {
    if (result === null) return;
    try {
      if (result.type === "remove") {
        const hadOnlyThumbnail = !game.hasCoverArt && !!game.thumbnailUrl;
        await library.setCoverArt(game.id, null);
        if (hadOnlyThumbnail) {
          await library.setThumbnailUrl(game.id, undefined);
          game.thumbnailUrl = undefined;
        }
        icon.classList.remove("game-card__icon--has-art");
        coverArtImg.remove();
        showInfoToast(`Cover art removed for "${game.name}".`, "info");
        game.hasCoverArt = false;
        if (game.thumbnailUrl) {
          applyCoverArt(game.thumbnailUrl);
          artBtn.title = "Change cover art";
          artBtn.setAttribute("aria-label", `Change cover art for ${game.name}`);
        } else {
          artBtn.title = "Set cover art";
          artBtn.setAttribute("aria-label", `Set cover art for ${game.name}`);
        }

      } else if (result.type === "file") {
        await library.setCoverArt(game.id, result.blob);
        if (coverArtObjectUrl) URL.revokeObjectURL(coverArtObjectUrl);
        coverArtObjectUrl = URL.createObjectURL(result.blob);
        if (!icon.contains(coverArtImg)) applyCoverArt(coverArtObjectUrl);
        else coverArtImg.src = coverArtObjectUrl;
        showInfoToast(`Cover art set for "${game.name}".`, "success");
        game.hasCoverArt = true;
        artBtn.title = "Change cover art";
        artBtn.setAttribute("aria-label", `Change cover art for ${game.name}`);

      } else if (result.type === "auto") {
        const provider = getCoverArtProvider();
        let candidates: CoverArtCandidate[] = [];

        artBtn.classList.add("game-card__art-btn--loading");
        artBtn.setAttribute("aria-busy", "true");
        artBtn.disabled = true;

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
          } catch (err) {
            diagWarn(settings.verboseLogging, "Hash calculation for cover art failed:", err);
          }
        }

        try {
          candidates = await provider.search(game.name, game.systemId, {
            limit: 12,
            hashes,
            fileName: game.fileName,
          });
          candidates.sort((a, b) => b.score - a.score);
        } catch (err) {
          showError(`Cover art search failed: ${err instanceof Error ? err.message : String(err)}`);
          return;
        } finally {
          artBtn.classList.remove("game-card__art-btn--loading");
          artBtn.removeAttribute("aria-busy");
          artBtn.disabled = false;
        }
        const pickedUrl = await showCoverArtCandidatePicker(
          game.name,
          candidates.map((c) => ({
            title: c.title,
            imageUrl: c.imageUrl,
            sourceName: c.sourceName,
            score: c.score,
          })),
        );
        if (!pickedUrl) return;

        let fetchedBlob: Blob;
        try {
          fetchedBlob = await fetchAndValidateCoverArt(pickedUrl);
        } catch (fetchErr) {
          showError(
            `Could not download the selected cover: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}. ` +
            "Try again or upload an image file instead.",
          );
          return;
        }
        await library.setCoverArt(game.id, fetchedBlob);
        if (coverArtObjectUrl) URL.revokeObjectURL(coverArtObjectUrl);
        coverArtObjectUrl = URL.createObjectURL(fetchedBlob);
        if (!icon.contains(coverArtImg)) applyCoverArt(coverArtObjectUrl);
        else coverArtImg.src = coverArtObjectUrl;
        showInfoToast(`Cover art set for "${game.name}".`, "success");
        game.hasCoverArt = true;
        artBtn.title = "Change cover art";
        artBtn.setAttribute("aria-label", `Change cover art for ${game.name}`);

      } else if (result.type === "url") {
        let fetchedBlob: Blob;
        try {
          fetchedBlob = await fetchAndValidateCoverArt(result.url);
        } catch (fetchErr) {
          showError(
            `Could not use that URL as cover art: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}. ` +
            "The host must allow hotlinking (CORS). Try downloading the image and uploading it instead.",
          );
          return;
        }
        await library.setCoverArt(game.id, fetchedBlob);
        if (coverArtObjectUrl) URL.revokeObjectURL(coverArtObjectUrl);
        coverArtObjectUrl = URL.createObjectURL(fetchedBlob);
        if (!icon.contains(coverArtImg)) applyCoverArt(coverArtObjectUrl);
        else coverArtImg.src = coverArtObjectUrl;
        showInfoToast(`Cover art set for "${game.name}".`, "success");
        game.hasCoverArt = true;
        artBtn.title = "Change cover art";
        artBtn.setAttribute("aria-label", `Change cover art for ${game.name}`);
      }
    } catch (err) {
      showError(`Cover art update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  btnArt.addEventListener("click", async (e) => {
    e.stopPropagation();
    const result = await showCoverArtPickerDialog(
      game.name,
      !!(game.hasCoverArt || game.thumbnailUrl),
    );
    await handleCoverArtResult(result, btnArt);
  });

  card.append(icon, scanline, info);
  if (patchInput && btnPatch) card.append(patchInput, btnPatch);
  card.append(btnArt, btnChangeSystem, btnFav, btnRemove, playOverlay);

  let preloadTriggered = false;
  const triggerPreload = () => {
    if (preloadTriggered) return;
    preloadTriggered = true;
    library.preloadGame(game.id);
    if (emulatorRef) emulatorRef.prefetchCore(game.systemId);
  };
  card.addEventListener("mouseenter", triggerPreload);
  card.addEventListener("focusin",    triggerPreload);

  const launch = async () => {
    showLoadingOverlay();
    setLoadingMessage(`Starting ${game.name}â€¦`);
    setLoadingSubtitle("Getting ready to play");
    try {
      let blob = await library.getGameBlob(game.id);
      if (!blob && game.cloudId) {
        setLoadingMessage("Streaming from cloudâ€¦");
        setLoadingSubtitle(`Downloading ${game.name} from ${game.cloudId} (Pull & Play)`);
        blob = await fetchFromCloud(game, settings);
        
        // Optional: Cache it locally for next time?
        // Actually let's keep it transient for now as per "streaming" intent.
      }
      if (!blob) {
        hideLoadingOverlay();
        showError(`"${game.name}" could not be found in your library. Try adding it again.`);
        return;
      }
      const file = toLaunchFile(blob, game.fileName);
      await library.markPlayed(game.id);
      await onLaunchGame(file, game.systemId, game.id);
    } catch (err) {
      hideLoadingOverlay();
      showError(`Failed to start game: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  card.addEventListener("click", () => {
    void showGameDetails(game, {
      system: system ?? null,
      formatBytes,
      coverArtSrc: coverArtObjectUrl || game.thumbnailUrl || undefined,
      onLaunch:    () => { void launch(); },
      onRemove:    () => btnRemove.click(),
      onToggleFav: () => btnFav.click(),
      onEditArt:   () => {
        void showCoverArtPickerDialog(game.name, !!coverArtObjectUrl).then(res => handleCoverArtResult(res, btnArt)).catch(err => {
          console.warn("Cover art dialog failed:", err);
        });
      },
      getRAProgress: system?.hasAchievements ? async () => {
        const cached = getCachedRAProgress(game.id);
        if (cached) return cached;

        const store = getApiKeyStore();
        const state = store.getState("retroachievements");
        if (!state.enabled || !state.key) return null;
        
        const { getRAClient } = await import("./achievements.js");
        const { calculateMD5 } = await import("./crypto.js");
        
        const creds = parseRAKey(state.key);
        if (!creds) return null;
        const client = getRAClient(creds.username, creds.apiKey);
        
        const blob = await library.getGameBlob(game.id);
        if (!blob) return null;
        const hash = await calculateMD5(blob);
        
        const raGameId = await client!.getGameIdByHash(hash);
        if (!raGameId) return null;
        
        const data = await client!.getGameInfoAndUserProgress(raGameId);
        if (data) setCachedRAProgress(game.id, data);
        return data;
      } : undefined,
      getSGDBAssets: async () => {
        const store = getApiKeyStore();
        const state = store.getState("steamgriddb");
        if (!state.enabled || !state.key) return null;

        const { SGDBClient } = await import("./steamgriddb.js");
        const client = new SGDBClient(state.key);
        
        try {
          const games = await client.searchGame(game.name);
          if (games.length === 0) return null;
          const sgdbId = games[0]!.id;
          
          const [heroes, logos] = await Promise.all([
            client.getHero(sgdbId),
            client.getLogo(sgdbId)
          ]);
          
          return {
            heroUrl: heroes[0]?.url,
            logoUrl: logos[0]?.url
          };
        } catch (err) {
          console.error("SteamGridDB fetch failed:", err);
          return null;
        }
      },
      getIGDBMetadata: async () => {
        const store = getApiKeyStore();
        const state = store.getState("igdb");
        if (!state.enabled || !state.key) return null;

        const { IGDBClient } = await import("./igdb.js");
        const client = new IGDBClient(state.key);
        
        try {
          const games = await client.searchGame(game.name);
          return games[0] || null;
        } catch (err) {
          console.error("IGDB fetch failed:", err);
          return null;
        }
      }
    });
  });

  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      card.click();
    }
  });

  return card;
}

type SystemFeaturePill = {
  label: string;
  title: string;
  tone?: "accent" | "warn" | "neutral";
};

function getSystemFeaturePills(
  system: SystemInfo | undefined,
  opts: { includeExperimental?: boolean; includeOnline?: boolean; max?: number } = {},
): SystemFeaturePill[] {
  if (!system) return [];

  const { includeExperimental = true, includeOnline = false, max } = opts;
  const pills: SystemFeaturePill[] = [];

  if (includeExperimental && system.experimental) {
    pills.push({
      label: "Experimental",
      title: system.stabilityNotice ?? "Support for this system is still being stabilized.",
      tone: "warn",
    });
  }
  if (system.is3D) {
    pills.push({
      label: "3D core",
      title: `${system.name} uses a heavier 3D rendering core and benefits from tuned graphics settings.`,
      tone: "accent",
    });
  } else {
    pills.push({
      label: "2D core",
      title: `${system.name} uses a lightweight 2D core and is highly performant on all devices.`,
      tone: "neutral",
    });
  }
  if (system.needsBios) {
    pills.push({
      label: "BIOS",
      title: `${system.name} needs system files for the best compatibility.`,
      tone: "neutral",
    });
  }
  if (system.needsWebGL2) {
    pills.push({
      label: "WebGL 2",
      title: `${system.name} needs WebGL 2 support in the browser.`,
      tone: "neutral",
    });
  }
  if (system.needsThreads) {
    pills.push({
      label: "Threaded core",
      title: "Uses additional CPU threads and requires SharedArrayBuffer (cross-origin isolation).",
      tone: "neutral",
    });
  }
  if (system.touchControlMode === "builtin") {
    pills.push({
      label: "Touch UI",
      title: "This system has built-in stylus/touch input in the emulator core.",
      tone: "neutral",
    });
  }
  if (system.hasAchievements) {
    pills.push({
      label: "RetroAchievements",
      title: "Games may unlock RetroAchievements.org rewards when you are logged in.",
      tone: "accent",
    });
  }
  if (includeOnline && isNetplaySupportedSystemId(system.id)) {
    pills.push({
      label: "Play Together",
      title: `${system.name} supports ${APP_NAME} Play Together multiplayer.`,
      tone: "accent",
    });
  }

  return typeof max === "number" ? pills.slice(0, max) : pills;
}

function buildSystemFeatureRow(
  system: SystemInfo | undefined,
  opts: { includeExperimental?: boolean; includeOnline?: boolean; max?: number; className?: string } = {},
): HTMLElement | null {
  const pills = getSystemFeaturePills(system, opts);
  if (pills.length === 0) return null;

  const row = make("div", { class: opts.className ?? "system-feature-row" });
  for (const pill of pills) {
    const cls = ["system-feature-chip"];
    if (pill.tone) cls.push(`system-feature-chip--${pill.tone}`);
    row.appendChild(make("span", { class: cls.join(" "), title: pill.title }, pill.label));
  }
  return row;
}

function systemIcon(systemId: string): string {
  const sys = getSystemById(systemId);
  if (sys?.iconUrl) return sys.iconUrl;
  return ICON_GAMEPAD_DECOR_SVG;
}


function _escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const OVERLAY_FADE_DELAY_MS = 200;
const PERF_SUGGESTION_FADE_DELAY_MS = 300;
const TOAST_REMOVE_DELAY_MS = 400;

// â”€â”€ Performance & Network Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const LATENCY_GOOD_THRESHOLD_MS = 80;
const LATENCY_WARN_THRESHOLD_MS = 200;
const FILE_SIZE_DECIMALS = 1;
const FRAME_TIME_MS = 16;
const STEP_FRAME_MS = 32;
const PERF_SUGGESTION_AUTO_DISMISS_MS = 10_000;

function trapFocus(container: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== "Tab") return;
  const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => !el.closest("[hidden]"));
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (e.shiftKey) {
    if (document.activeElement === first) { e.preventDefault(); last.focus(); }
  } else {
    if (document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}

/** Reuse stored File objects when possible to avoid unnecessary allocations. */
function toLaunchFile(blob: Blob, fileName: string): File {
  if (blob instanceof File && blob.name === fileName) return blob;
  return new File([blob], fileName, { type: blob.type });
}

// â”€â”€ Custom confirm dialog â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Returns true when `overlay` is the most recently appended `.confirm-overlay`
 * in the document.  Used by all modal Escape handlers so only the *topmost*
 * dialog closes when the user presses Escape â€” an outer gallery does not
 * collapse while an inner confirm dialog is still open.
 */
function showConfirmDialog(
  message: string,
  opts: { title?: string; confirmLabel?: string; isDanger?: boolean } = {}
): Promise<boolean> {
  return showConfirmDialogImpl(message, opts);
}

function _isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return target.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function _focusLibrarySearch(): boolean {
  const searchEl = document.getElementById("library-search") as HTMLInputElement | null;
  const landing = document.getElementById("landing");
  if (!searchEl || !landing || landing.classList.contains("hidden")) return false;
  searchEl.focus();
  searchEl.select();
  return true;
}

function _safeScrollIntoView(target: HTMLElement, options: ScrollIntoViewOptions): void {
  try {
    target.scrollIntoView(options);
  } catch {
    target.scrollIntoView();
  }
}


// â”€â”€ System picker modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function pickSystem(fileName: string, candidates: SystemInfo[], subtitleText?: string): Promise<SystemInfo | null> {
  return pickSystemImpl(fileName, candidates, subtitleText);
}

// â”€â”€ Resolve system then add to library and launch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const PATCH_EXT_SET = new Set(["ips", "bps", "ups"]);
const IMPORT_ARCHIVE_EXT_SET = new Set([
  "zip", "7z", "rar", "tar", "gz", "tgz",
  "bz2", "tbz", "tbz2", "xz", "txz",
  "zst", "lz", "lzma", "cab",
]);
const IMPORT_ARCHIVE_FORMAT_BY_EXT: Partial<Record<string, ArchiveFormat>> = {
  zip: "zip",
  "7z": "7z",
  rar: "rar",
  tar: "tar",
  gz: "gzip",
  tgz: "gzip",
  gzip: "gzip",
  bz2: "bzip2",
  tbz: "bzip2",
  tbz2: "bzip2",
  xz: "xz",
  txz: "xz",
};
const EXTRACTABLE_ARCHIVE_FORMATS = new Set<ArchiveFormat>(["zip", "7z", "rar", "tar", "gzip"]);

/** Extensions that are definitively unsupported archive formats (not ROM native packages). */
const UNSUPPORTED_ARCHIVE_EXT_SET = new Set(["zst", "lz", "lzma", "cab"]);
/**
 * Minimum BIN candidate count before treating ZIP/7z contents as a likely
 * native arcade-style package.
 * A threshold of 4 avoids misclassifying small user-created archives while
 * still catching typical multi-chip arcade ROM sets.
 */
const MIN_NATIVE_PACKAGE_BIN_ENTRY_COUNT = 4;
const NATIVE_PACKAGE_BIN_EXT = "bin";
const NATIVE_PACKAGE_ARCHIVE_SUFFIX_RE = /\.(zip|7z)$/i;

function fileExt(fileName: string): string {
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx >= fileName.length - 1) return "";
  return fileName.substring(dotIdx + 1).toLowerCase();
}

/**
 * Returns true when an archive filename already includes a known ROM extension
 * before the final archive suffix (e.g. "game.nes.zip").
 */
function hasKnownRomHintInArchiveName(fileName: string): boolean {
  const stem = fileName.replace(NATIVE_PACKAGE_ARCHIVE_SUFFIX_RE, "");
  const stemExt = fileExt(stem);
  return stemExt !== "" && ALL_EXTENSIONS.includes(stemExt);
}

function inferFileForSystem(original: File, system: SystemInfo): File {
  const currentExt = fileExt(original.name);
  if (system.extensions.includes(currentExt)) return original;

  const baseName = original.name.replace(/\.[^.]+$/, "") || "game";
  const inferredExt = system.extensions[0] ?? "bin";
  return new File([original], `${baseName}.${inferredExt}`, { type: original.type });
}

function formatArchiveProgressMessage(progress: ArchiveExtractProgress): string {
  const pct = typeof progress.percent === "number" ? ` ${progress.percent}%` : "";
  return `${progress.message}${pct}`;
}

function logImport(
  emulatorRef: PSPEmulator | undefined,
  settings: Settings,
  message: string,
): void {
  emulatorRef?.logDiagnostic("system", `Import: ${message}`);
  if (settings.verboseLogging) console.info(`[${APP_NAME}] ${message}`);
}

function logImportWarn(
  emulatorRef: PSPEmulator | undefined,
  settings: Settings,
  message: string,
): void {
  emulatorRef?.logDiagnostic("error", `Import: ${message}`);
  if (settings.verboseLogging) console.warn(`[${APP_NAME}] ${message}`);
}

// â”€â”€ Import retry helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Maximum automatic retry attempts for transient import errors. */
const IMPORT_MAX_ATTEMPTS = 3;
/** Base delay (ms) between auto-retry attempts; multiplied by attempt index for backoff. */
const IMPORT_RETRY_BASE_DELAY_MS = 300;

/**
 * Returns true when the error is likely transient and worth retrying automatically.
 * Quota / storage exhaustion errors are excluded â€” those require user action.
 */
export function isTransientImportError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  // Quota exceeded is permanent until the user frees space â€” do not auto-retry.
  if (msg.includes("quota") || msg.includes("no space") || msg.includes("storage full")) return false;
  // IDB lock / transaction errors, network hiccups, and generic unknown errors are transient.
  return (
    msg.includes("transaction") ||
    msg.includes("database") ||
    msg.includes("network") ||
    msg.includes("fetch") ||
    err.name === "TransactionInactiveError" ||
    err.name === "AbortError" ||
    err.name === "NetworkError" ||
    err.name === "UnknownError"
  );
}

interface RetryOptions {
  /** Total number of attempts (including the first). Defaults to IMPORT_MAX_ATTEMPTS. */
  maxAttempts?: number;
  /** Base delay between attempts in ms. Actual delay scales linearly with attempt index. */
  delayMs?: number;
  /** Called before each retry (attempt â‰¥ 2). Receives the 1-based attempt index and last error. */
  onRetry?: (attempt: number, err: Error) => void;
  /** Predicate deciding whether an error should trigger a retry. Defaults to always retry. */
  isRetryable?: (err: Error) => boolean;
}

/**
 * Runs `operation` up to `maxAttempts` times, pausing between attempts.
 * Re-throws the last error if all attempts fail.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = IMPORT_MAX_ATTEMPTS,
    delayMs     = IMPORT_RETRY_BASE_DELAY_MS,
    onRetry,
    isRetryable = () => true,
  } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) break;
      const e = err instanceof Error ? err : new Error(String(err));
      if (!isRetryable(e)) break;
      onRetry?.(attempt, e);
      await new Promise<void>(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}

export async function resolveSystemAndAdd(
  file:          File,
  library:       GameLibrary,
  settings:      Settings,
  onLaunchGame:  (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef?:  PSPEmulator,
  onApplyPatch?: (gameId: string, patchFile: File) => Promise<void>
): Promise<void> {
  const ext = fileExt(file.name);
  if (PATCH_EXT_SET.has(ext)) {
    await handlePatchFileDrop(file, library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    return;
  }

  let resolvedFile = file;
  let archiveFormat: ArchiveFormat = "unknown";
  let archiveModulePromise: Promise<typeof import("./archive.js")> | null = null;
  const getArchiveModule = (): Promise<typeof import("./archive.js")> => {
    if (!archiveModulePromise) archiveModulePromise = import("./archive.js");
    return archiveModulePromise;
  };

  logImport(
    emulatorRef,
    settings,
    `Received file "${file.name}" (${(file.size / 1024 / 1024).toFixed(FILE_SIZE_DECIMALS)} MB)`,
  );

  // Mobile file pickers may strip/mangle extensions. Sniff archive signatures
  // whenever extension hints are archive-like OR extension is absent.
  const shouldSniffArchive = IMPORT_ARCHIVE_EXT_SET.has(ext) || ext === "";
  if (shouldSniffArchive) {
    const archiveModule = await getArchiveModule();
    archiveFormat = await archiveModule.detectArchiveFormat(file);
    if (archiveFormat === "unknown") {
      archiveFormat = IMPORT_ARCHIVE_FORMAT_BY_EXT[ext] ?? "unknown";
    }
    if (archiveFormat !== "unknown") {
      logImport(
        emulatorRef,
        settings,
        `Archive format detected: ${archiveFormat.toUpperCase()} (from "${file.name}")`,
      );
    }
  }

  if (archiveFormat === "bzip2" || archiveFormat === "xz") {
    showError(
      `${archiveFormat.toUpperCase()} archives are not supported for automatic extraction.\n\n` +
      "Please extract the archive first and then import the ROM file directly."
    );
    logImportWarn(
      emulatorRef,
      settings,
      `${archiveFormat.toUpperCase()} archive requires manual extraction`,
    );
    return;
  }

  // Handle extensions that are definitively unsupported archive formats.
  // These have no magic-byte detection, so archiveFormat stays "unknown",
  // but we can identify them by extension and show a clear error rather
  // than a confusing "Unrecognised file type" message later.
  if (archiveFormat === "unknown" && UNSUPPORTED_ARCHIVE_EXT_SET.has(ext)) {
    const extLabel = ext.toUpperCase();
    showError(
      `${extLabel} archives cannot be extracted automatically in the browser.\n\n` +
      "Please extract the archive manually and import the ROM file directly."
    );
    logImportWarn(
      emulatorRef,
      settings,
      `${extLabel} archive is not supported for automatic extraction`,
    );
    return;
  }

  if (EXTRACTABLE_ARCHIVE_FORMATS.has(archiveFormat)) {
    const archiveModule = await getArchiveModule();
    showLoadingOverlay();
    setLoadingMessage(`Opening ${archiveFormat.toUpperCase()} archiveâ€¦`);
    setLoadingSubtitle("Extracting game files â€” this may take a moment");
    logImport(
      emulatorRef,
      settings,
      `Starting ${archiveFormat.toUpperCase()} extraction`,
    );

    try {
      // Always route through extractFromArchive so magic-detected ZIPs (mobile
      // pickers often strip extensions) get the same progress UI and multi-ROM
      // candidate picker as desktop â€” extractFromArchive delegates to the
      // streaming ZIP path on mobile browsers when appropriate.
      const extracted = await archiveModule.extractFromArchive(file, {
        onProgress: (progress) => {
          setLoadingMessage(formatArchiveProgressMessage(progress));
          if (progress.percent != null) setLoadingProgress(progress.percent);
        },
      });

      if (extracted) {
        const extractedCandidates = extracted.candidates ?? [];
        const shouldPreferNativePackageRouting =
          (archiveFormat === "zip" || archiveFormat === "7z") &&
          !hasKnownRomHintInArchiveName(file.name) &&
          extractedCandidates.length >= MIN_NATIVE_PACKAGE_BIN_ENTRY_COUNT &&
          extractedCandidates.every((candidate) => fileExt(candidate.name) === NATIVE_PACKAGE_BIN_EXT);

        if (shouldPreferNativePackageRouting) {
          resolvedFile = file;
          setLoadingMessage("Detected native package archive â€” using original fileâ€¦");
          setLoadingSubtitle("");
          logImport(
            emulatorRef,
            settings,
            `${archiveFormat.toUpperCase()} appears to be a native package set (${extractedCandidates.length} BIN entries); skipping inner extraction routing`,
          );
        } else if (extractedCandidates.length > 1) {
          const savedPick = ArchiveSelectionStore.get(file.name, file.size);
          const pickedCandidate = savedPick 
            ? extractedCandidates.find(c => c.name === savedPick)
            : null;

          let picked = pickedCandidate;
          if (!picked) {
            hideLoadingOverlay();
            picked = await showArchiveEntryPickerDialog(
              extracted.format,
              extractedCandidates,
            );
            if (picked) {
               ArchiveSelectionStore.set(file.name, file.size, picked.name);
            }
          }

          if (!picked) return;
          resolvedFile = new File([picked.blob!], picked.name, { type: picked.blob!.type });
          showLoadingOverlay();
          setLoadingMessage("File selected â€” detecting game systemâ€¦");
          setLoadingSubtitle("");
          logImport(
            emulatorRef,
            settings,
            `Archive entry selected: "${picked.name}" (${formatBytes(picked.size)})`,
          );
        } else {
          resolvedFile = new File([extracted.blob!], extracted.name, { type: extracted.blob!.type });
        }
        setLoadingMessage("Detecting game systemâ€¦");
        setLoadingSubtitle("");
        logImport(
          emulatorRef,
          settings,
          `${extracted.format.toUpperCase()} extraction succeeded: "${resolvedFile.name}" ` +
          `(${(resolvedFile.size / 1024 / 1024).toFixed(FILE_SIZE_DECIMALS)} MB)`,
        );
      } else {
        hideLoadingOverlay();
        const strictFormats = new Set<ArchiveFormat>(["tar", "gzip"]);
        if (strictFormats.has(archiveFormat)) {
          const pretty = archiveFormat === "gzip" ? "GZIP" : archiveFormat.toUpperCase();
          showError(
            `${pretty} archive does not contain a recognised ROM file.\n\n` +
            "Try extracting the archive manually and import the ROM file directly."
          );
          logImportWarn(
            emulatorRef,
            settings,
            `${pretty} extraction produced no ROM candidate`,
          );
          return;
        }
        // ZIP/7z may be native package formats (e.g. arcade sets), so keep
        // the original archive and continue through normal system detection.
        logImport(
          emulatorRef,
          settings,
          `${archiveFormat.toUpperCase()} extraction found no ROM candidate; falling back to native package routing`,
        );
      }
    } catch (err) {
      hideLoadingOverlay();
      const reason = err instanceof Error ? err.message : String(err);
      const fallbackAllowed = archiveFormat === "zip" || archiveFormat === "7z";
      if (!fallbackAllowed) {
        showError(
          `Could not extract ${archiveFormat.toUpperCase()} archive:\n${reason}\n\n` +
          "Please extract the archive manually and import the ROM file directly."
        );
        logImportWarn(
          emulatorRef,
          settings,
          `${archiveFormat.toUpperCase()} extraction failed: ${reason}`,
        );
        return;
      }
      logImportWarn(
        emulatorRef,
        settings,
        `${archiveFormat.toUpperCase()} extraction failed (${reason}); falling back to native package routing`,
      );
    }
  } else if (IMPORT_ARCHIVE_EXT_SET.has(ext) && archiveFormat === "unknown") {
    // Extension says "archive", but content signature was unrecognised.
    // Keep going â€” this may still be a native package for arcade cores.
    logImportWarn(
      emulatorRef,
      settings,
      `Archive extension ".${ext}" had no recognised signature; attempting native package routing`,
    );
  }

  const detected = detectSystem(resolvedFile.name);
  let system: SystemInfo | null = null;

  if (detected === null) {
    const resolvedExt = fileExt(resolvedFile.name);
    const shouldOfferSystemPicker =
      resolvedExt === "" || (!ALL_EXTENSIONS.includes(resolvedExt) && !IMPORT_ARCHIVE_EXT_SET.has(resolvedExt));

    if (shouldOfferSystemPicker) {
      hideLoadingOverlay();
      logImport(
        emulatorRef,
        settings,
        `System detection failed for "${resolvedFile.name}". Prompting manual system selection.`,
      );
      const picked = await pickSystem(
        resolvedFile.name,
        SYSTEMS,
        `We couldn't detect the console from this file. Choose the system you'd like to use:`
      );
      if (!picked) return;
      system = picked;
      resolvedFile = inferFileForSystem(resolvedFile, picked);
      logImport(
        emulatorRef,
        settings,
        `Manual system selected: ${picked.id}. Inferred filename "${resolvedFile.name}"`,
      );
    } else {
      hideLoadingOverlay();
      showError(
        `"${resolvedFile.name}" isn't a recognised ROM format.\n\n` +
        `Try a common format like .iso, .gba, .sfc, .nes, or .nds.\n` +
        `See Settings â†’ Help for the full list of supported formats.`
      );
      return;
    }
  } else if (Array.isArray(detected)) {
    hideLoadingOverlay();
    system = await pickSystem(resolvedFile.name, detected);
    if (!system) return;
  } else {
    // Single system detected â€” do not hide the overlay here.
    // If an archive was just extracted the overlay may still be showing;
    // keeping it visible avoids hide/show flicker on the happy path.
    system = detected;
  }

  logImport(
    emulatorRef,
    settings,
    `System resolved: ${system.id} (${system.name}) for "${resolvedFile.name}"`,
  );

  if (resolvedFile.name.toLowerCase().endsWith(".m3u")) {
    await handleM3UFile(resolvedFile, system, library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    return;
  }

  try {
    const existing = await library.findByFileName(resolvedFile.name, system.id);
    if (existing) {
      hideLoadingOverlay();
      const playExisting = await showConfirmDialog(
        `"${existing.name}" is already in your library.`,
        { title: "Already in Library", confirmLabel: "Play Existing" }
      );
      if (!playExisting) return;
      showLoadingOverlay();
      setLoadingMessage(`Starting ${existing.name}â€¦`);
      setLoadingSubtitle("Getting ready to play");
      try {
        let blob = existing.blob;
        if (!blob && existing.cloudId) {
          setLoadingSubtitle(`Downloading from ${existing.cloudId}â€¦`);
          blob = await fetchFromCloud(existing, settings);
        }
        if (!blob) {
          hideLoadingOverlay();
          showError(`"${existing.name}" could not be loaded. It may be missing from your library or cloud connection.`);
          return;
        }
        const existingFile = toLaunchFile(blob, existing.fileName);
        await library.markPlayed(existing.id);
        logImport(
          emulatorRef,
          settings,
          `Launching existing library entry: "${existing.name}" (${existing.id})`,
        );
        await onLaunchGame(existingFile, existing.systemId, existing.id);
      } catch (err) {
        hideLoadingOverlay();
        showError(`Could not load game: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
  } catch { /* fall through */ }

  showLoadingOverlay();
  setLoadingMessage("Saving game to libraryâ€¦");
  setLoadingSubtitle("This only takes a moment the first time");

  try {
    const entry = await withRetry(
      () => library.addGame(resolvedFile, system.id),
      {
        isRetryable: isTransientImportError,
        onRetry: (attempt, _err) => {
          setLoadingMessage(`Saving game to libraryâ€¦ (retry ${attempt})`);
          logImportWarn(
            emulatorRef,
            settings,
            `library.addGame failed on attempt ${attempt}; retryingâ€¦`,
          );
        },
      },
    );
    settings.lastGameName = entry.name;
    logImport(
      emulatorRef,
      settings,
      `Game added to library: "${entry.name}" (id: ${entry.id}, system: ${entry.systemId})`,
    );
    void renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    setLoadingMessage(`Starting ${entry.name}â€¦`);
    setLoadingSubtitle("Getting ready to play");
    logImport(
      emulatorRef,
      settings,
      `Launching newly added game "${entry.name}"`,
    );
    await onLaunchGame(resolvedFile, system.id, entry.id);
  } catch (err) {
    hideLoadingOverlay();
    const errMsg = `Could not add game: ${err instanceof Error ? err.message : String(err)}`;
    logImportWarn(emulatorRef, settings, errMsg);
    showError(errMsg, () => {
      void resolveSystemAndAdd(file, library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    });
  }
}

async function handlePatchFileDrop(
  patchFile:     File,
  library:       GameLibrary,
  settings:      Settings,
  onLaunchGame:  (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef?:  PSPEmulator,
  onApplyPatch?: (gameId: string, patchFile: File) => Promise<void>
): Promise<void> {
  if (!onApplyPatch) { showError("Patch application is not available."); return; }

  let games: GameMetadata[];
  try { games = await library.getAllGamesMetadata(); } catch { games = []; }

  if (games.length === 0) { showError("Your library is empty. Add a game before applying a patch."); return; }

  const chosen = await showGamePickerDialog(
    "Apply Patch to Game",
    `Select the game to patch with "${patchFile.name}":`,
    games
  );
  if (!chosen) return;

  try {
    showLoadingOverlay();
    setLoadingMessage(`Applying patch to ${chosen.name}â€¦`);
    await onApplyPatch(chosen.id, patchFile);
    hideLoadingOverlay();
    void renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
  } catch (err) {
    hideLoadingOverlay();
    showError(`Patch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function showGamePickerDialog(title: string, message: string, games: GameMetadata[]): Promise<GameMetadata | null> {
  return showGamePickerDialogImpl(title, message, games);
}

function showArchiveEntryPickerDialog(
  format: ArchiveFormat,
  candidates: Array<{ name: string; blob: Blob; size: number }>
): Promise<{ name: string; blob: Blob; size: number } | null> {
  return showArchiveEntryPickerDialogImpl(format, candidates);
}

function showCoverArtPickerDialog(gameName: string, hasExistingArt: boolean): ReturnType<typeof showCoverArtPickerDialogImpl> {
  return showCoverArtPickerDialogImpl(gameName, hasExistingArt, {
    onOpenApiKeysSettings: () => { _openSettingsFn?.("apikeys"); },
  });
}

async function handleM3UFile(
  m3uFile:       File,
  system:        SystemInfo,
  library:       GameLibrary,
  settings:      Settings,
  onLaunchGame:  (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef?:  PSPEmulator,
  onApplyPatch?: (gameId: string, patchFile: File) => Promise<void>
): Promise<void> {
  let m3uText: string;
  try { m3uText = await m3uFile.text(); } catch { showError("Could not read the .m3u file."); return; }

  const discFileNames = parseM3U(m3uText);
  if (discFileNames.length === 0) { showError("The .m3u file is empty or contains no disc entries."); return; }

  const storedDiscs = new Map<string, { id: string; blob: Blob }>();
  await Promise.all(
    discFileNames.map(async (fn) => {
      try {
        const entry = await library.findByFileName(fn, system.id);
        if (entry && entry.blob) storedDiscs.set(fn, { id: entry.id, blob: entry.blob });
      } catch { /* ignore */ }
    })
  );

  let discFiles: Map<string, Blob>;
  const missingDiscs = discFileNames.filter(fn => !storedDiscs.has(fn));

  if (missingDiscs.length > 0) {
    const userPicked = await showMultiDiscPicker(missingDiscs);
    if (!userPicked) return;
    showLoadingOverlay();
    setLoadingMessage("Storing disc imagesâ€¦");
    for (const [fn, f] of userPicked) {
      try {
        const entry = await library.addGame(f, system.id);
        storedDiscs.set(fn, { id: entry.id, blob: f });
      } catch { /* ignore */ }
    }
    discFiles = userPicked;
  } else {
    discFiles = new Map();
    for (const [fn, { blob }] of storedDiscs) { discFiles.set(fn, blob); }
    showLoadingOverlay();
    setLoadingMessage("Preparing multi-disc gameâ€¦");
  }

  const blobUrls: string[] = [];
  const syntheticLines: string[] = [];
  for (const fn of discFileNames) {
    const discBlob = discFiles.get(fn) ?? storedDiscs.get(fn)?.blob ?? null;
    if (!discBlob) { hideLoadingOverlay(); showError(`Disc file not found: "${fn}"`); return; }
    const url = URL.createObjectURL(discBlob);
    blobUrls.push(url);
    syntheticLines.push(url);
  }

  const syntheticM3U  = new Blob([syntheticLines.join("\n")], { type: "text/plain" });
  const syntheticFile = new File([syntheticM3U], m3uFile.name, { type: "text/plain" });
  const gameName = m3uFile.name.replace(/\.[^.]+$/, "");
  settings.lastGameName = gameName;

  try {
    const existing = await library.findByFileName(m3uFile.name, system.id);
    if (!existing) {
      await library.addGame(m3uFile, system.id);
      void renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    }
  } catch { /* ignore */ }

  try {
    await onLaunchGame(syntheticFile, system.id);
    // launch() reports many failures via emulator state/onError rather than
    // throwing. If launch already failed at this point, revoke immediately.
    if (emulatorRef?.state === "error") {
      blobUrls.forEach(u => URL.revokeObjectURL(u));
      return;
    }
    // Revoke the disc blob URLs when the user returns to the library. The emulator
    // core keeps its own reference via the loaded game URL, so revoking here is
    // safe once the game has started â€” the emulator holds the data, not the URL.
    const revokeOnReturn = () => { blobUrls.forEach(u => URL.revokeObjectURL(u)); };
    document.addEventListener(LEGACY_EVENTS.returnToLibrary, revokeOnReturn, { once: true });
  } catch (err) {
    hideLoadingOverlay();
    showError(`Multi-disc launch failed: ${err instanceof Error ? err.message : String(err)}`);
    // Revoke immediately on thrown launch errors.
    blobUrls.forEach(u => URL.revokeObjectURL(u));
  }
}

// â”€â”€ Header controls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    const btnResume = make("button", { class: "btn btn--primary", title: "Return to the paused game" }, "â–¶ Resume");
    btnResume.addEventListener("click", onResumeGame);
    container.appendChild(btnResume);
  }

  if (deviceCaps.isLowSpec || deviceCaps.isChromOS) {
    const label = deviceCaps.isChromOS ? "Chromebook" : "Low-spec";
    const tip   = deviceCaps.isChromOS ? "Chromebook detected â€” Performance mode recommended" : "Performance mode recommended for this device";
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
    openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulatorRef, onLaunchGame, saveLibrary, getNetplayManager, "about");
  });

  const btnMultiplayer = make("button", {
    class: "btn btn--highlight",
    title: "Open Play Together â€” Host or join a game with friends",
    "aria-label": "Open Play Together",
  }) as HTMLButtonElement;
  btnMultiplayer.innerHTML = `<img src="${resolveAssetUrl("assets/netplay_icon_premium_1775434064140.png")}" width="18" height="18" class="btn__icon" alt="" /> Play Together`;
  btnMultiplayer.addEventListener("click", () => {
    const openWith = (nm: import("./multiplayer.js").NetplayManager) => {
      openEasyNetplayModal({
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

/** Minimal in-game overlay: "Now playing" chip + quick actions. EmulatorJS handles the rest. */
function buildInGameControls(
  _emulator:          PSPEmulator,
  settings:           Settings,
  _onSettingsChange:  (patch: Partial<Settings>) => void,
  onReturnToLibrary:  () => void,
  _saveLibrary?:      SaveStateLibrary,
  _saveService?:      SaveGameService,
  _getCurrentGameId?:  () => string | null,
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
    chip.textContent = `Now playing · ${currentGameName}`;
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
    const actions = make("div", { class: "in-game-overlay__actions", role: "group", "aria-label": "In-game quick actions" });
    if (_onOpenSettings) {
      const btnSettings = make("button", {
        class: "btn btn--ghost in-game-overlay__btn",
        type: "button",
        title: "Open Settings (F9)",
        "aria-label": "Open Settings",
      }, "Settings");
      btnSettings.addEventListener("click", () => _onOpenSettings("performance"), { signal });
      actions.append(btnSettings);
    }
    actions.append(buildLibraryButton("btn btn--gradient in-game-overlay__btn"));
    overlayContainer.append(buildNowPlayingChip(), actions);
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

// â”€â”€ Auto-save restore prompt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function promptAutoSaveRestore(saveLibrary: SaveStateLibrary, gameId: string): Promise<boolean> {
  const hasAuto = await saveLibrary.hasAutoSave(gameId);
  if (!hasAuto) return false;
  return showConfirmDialog(
    "A crash-recovery save was found from your last session. Would you like to restore it?",
    { title: "Restore Auto-Save?", confirmLabel: "Restore" }
  );
}



// â”€â”€ Settings panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type SettingsTab = "performance" | "display" | "library" | "cloud" | "bios" | "multiplayer" | "achievements" | "apikeys" | "debug" | "about";

/** Sidebar nav icons (24Ã—24, stroke) â€” replaces emoji for consistent UI chrome. */
const SETTINGS_SIDEBAR_ICON_SVG: Record<SettingsTab, string> = {
  performance: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  display: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>`,
  library: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`,
  cloud: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`,
  bios: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`,
  multiplayer: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  achievements: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  apikeys: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/><circle cx="7.5" cy="15.5" r="5.5"/><path d="M13 13 6 20"/></svg>`,
  debug: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`,
  about: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
};

function settingsSidebarIconEl(tabId: SettingsTab): HTMLElement {
  const wrap = make("span", { class: "settings-sidebar__icon", "aria-hidden": "true" });
  wrap.innerHTML = SETTINGS_SIDEBAR_ICON_SVG[tabId];
  return wrap;
}

export function openSettingsPanel(
  settings:         Settings,
  deviceCaps:       DeviceCapabilities,
  library:          GameLibrary,
  biosLibrary:      BiosLibrary,
  onSettingsChange: (patch: Partial<Settings>) => void,
  emulatorRef?:     import("./emulator.js").PSPEmulator,
  onLaunchGame?:    (file: File, systemId: string, gameId?: string) => Promise<void>,
  saveLibrary?:     SaveStateLibrary,
  getNetplayManagerOrInstance?: (() => Promise<import("./multiplayer.js").NetplayManager>) | import("./multiplayer.js").NetplayManager,
  initialTab?:      SettingsTab
): void {
  const panel   = document.getElementById("settings-panel")!;
  const content = document.getElementById("settings-content")!;
  const previousFocus = document.activeElement as HTMLElement | null;

  // Normalise: accept either a factory function or a direct NetplayManager instance.
  // When a direct instance is passed, register it as the global singleton so that
  // peekNetplayManager() returns it â€” enabling synchronous calls in tab builders.
  if (typeof getNetplayManagerOrInstance !== "function" && getNetplayManagerOrInstance != null) {
    registerNetplayInstance(getNetplayManagerOrInstance);
  }
  const getNetplayManager: (() => Promise<import("./multiplayer.js").NetplayManager>) | undefined =
    typeof getNetplayManagerOrInstance === "function"
      ? getNetplayManagerOrInstance
      : getNetplayManagerOrInstance != null
        ? () => Promise.resolve(getNetplayManagerOrInstance)
        : undefined;

  try {
    buildSettingsContent(content, settings, deviceCaps, library, biosLibrary, onSettingsChange, emulatorRef, onLaunchGame, saveLibrary, getNetplayManager, initialTab);
  } catch (error) {
    console.error(`[${APP_NAME}] Failed to render settings panel`, error);
    content.innerHTML = "";
    const fallback = make("div", { class: "settings-render-error", role: "alert" });
    fallback.append(
      make("h4", { class: "settings-section__title" }, "Settings could not load"),
      make("p", { class: "settings-help" }, error instanceof Error ? error.message : "An unexpected error stopped the settings panel from rendering."),
    );
    content.appendChild(fallback);
  }
  panel.hidden = false;
  // Move focus into the panel so keyboard users can navigate immediately
  requestAnimationFrame(() => {
    (document.getElementById("settings-close") as HTMLButtonElement | null)?.focus();
  });

  // Focus trap: keep Tab navigation inside the settings panel
  const focusTrapFn = (e: KeyboardEvent) => trapFocus(panel, e);

  const close = () => {
    panel.hidden = true;
    if (_settingsPanelEscHandler) {
      document.removeEventListener("keydown", _settingsPanelEscHandler);
      _settingsPanelEscHandler = null;
    }
    if (_settingsPanelFocusTrap) {
      document.removeEventListener("keydown", _settingsPanelFocusTrap);
      _settingsPanelFocusTrap = null;
    }
    if (_settingsPanelSearchShortcutHandler) {
      document.removeEventListener("keydown", _settingsPanelSearchShortcutHandler, { capture: true });
      _settingsPanelSearchShortcutHandler = null;
    }
    _settingsTabBarRo?.disconnect();
    _settingsTabBarRo = null;
    _settingsContentCleanups.forEach((fn) => {
      try { fn(); } catch { /* ignore stale settings cleanup */ }
    });
    _settingsContentCleanups = [];
    _settingsContentToken += 1;
    previousFocus?.focus();
  };

  // Remove any previously registered handlers before attaching new ones.
  if (_settingsPanelEscHandler) {
    document.removeEventListener("keydown", _settingsPanelEscHandler);
  }
  if (_settingsPanelFocusTrap) {
    document.removeEventListener("keydown", _settingsPanelFocusTrap);
  }
  if (_settingsPanelSearchShortcutHandler) {
    document.removeEventListener("keydown", _settingsPanelSearchShortcutHandler, { capture: true });
  }
  _settingsPanelEscHandler = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (document.querySelector(".confirm-overlay--visible")) return;
    close();
  };
  _settingsPanelFocusTrap  = focusTrapFn;
  _settingsPanelSearchShortcutHandler = (e: KeyboardEvent) => {
    const isSearchShortcut = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k";
    if (!isSearchShortcut || _isEditableTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const searchEl = content.querySelector<HTMLInputElement>(".settings-search-input");
    searchEl?.focus();
    searchEl?.select();
  };

  document.getElementById("settings-close")!.onclick   = close;
  document.getElementById("settings-backdrop")!.onclick = close;
  document.addEventListener("keydown", _settingsPanelEscHandler);
  document.addEventListener("keydown", _settingsPanelFocusTrap);
  document.addEventListener("keydown", _settingsPanelSearchShortcutHandler, { capture: true });
}

let _settingsTabsModule: typeof import("./ui/settingsTabs.js") | null = null;
async function _loadSettingsTabs(): Promise<typeof import("./ui/settingsTabs.js") | null> {
  if (!_settingsTabsModule) {
    try {
      _settingsTabsModule = await import("./ui/settingsTabs.js");
    } catch {
      return null;
    }
  }
  return _settingsTabsModule;
}

function buildSettingsContent(
  container:        HTMLElement,
  settings:         Settings,
  deviceCaps:       DeviceCapabilities,
  library:          GameLibrary,
  biosLibrary:      BiosLibrary,
  onSettingsChange: (patch: Partial<Settings>) => void,
  emulatorRef?:     import("./emulator.js").PSPEmulator,
  onLaunchGame?:    (file: File, systemId: string, gameId?: string) => Promise<void>,
  saveLibrary?:     SaveStateLibrary,
  getNetplayManager?: () => Promise<import("./multiplayer.js").NetplayManager>,
  initialTab?:      SettingsTab
): void {
  _settingsContentCleanups.forEach((fn) => {
    try { fn(); } catch { /* ignore stale settings cleanup */ }
  });
  _settingsContentCleanups = [];
  const settingsContentToken = ++_settingsContentToken;
  container.innerHTML = "";

  const settingsShell = make("div", { class: "settings-shell" });
  const quickBar = make("div", { class: "settings-quickbar" });
  const perfModeLabel = settings.performanceMode === "performance" ? "Performance"
    : settings.performanceMode === "quality" ? "Quality"
    : "Auto";
  const tierFriendlyMap: Record<string, string> = { low: "entry-level", medium: "mid-range", high: "high-end" };
  const tierFriendly = tierFriendlyMap[deviceCaps.tier] ?? "unknown";
  const quickInfo = make("p", { class: "settings-quickbar__summary" },
    `Graphics: ${perfModeLabel} Â· ${tierFriendly} device${deviceCaps.isLowSpec ? " Â· optimised mode active" : ""}`
  );
  const searchInput = make("input", {
    class: "settings-search-input",
    type: "search",
    placeholder: "Search settingsâ€¦",
    "aria-label": "Search settings",
  }) as HTMLInputElement;
  const searchStatus = make("p", { class: "settings-search-status", "aria-live": "polite" });
  quickBar.append(quickInfo, searchInput, searchStatus);
  const activeTabLabel = make("p", { class: "settings-active-tab-label", "aria-live": "polite" });
  quickBar.append(activeTabLabel);

  const tabs: Array<{ id: SettingsTab; label: string; ariaLabel: string }> = [
    { id: "performance",  label: "Performance",   ariaLabel: "Performance" },
    { id: "display",      label: "Display",        ariaLabel: "Display" },
    { id: "library",      label: "My Games",       ariaLabel: "My Games" },
    { id: "cloud",        label: "Cloud Storage",  ariaLabel: "Cloud Storage" },
    { id: "bios",         label: "System Files",   ariaLabel: "System Files" },
    { id: "multiplayer",  label: "Play Together",  ariaLabel: "Play Together" },
    { id: "achievements", label: "Achievements",   ariaLabel: "Achievements" },
    { id: "apikeys",      label: "API Keys",       ariaLabel: "API Keys" },
    { id: "debug",        label: "Advanced",       ariaLabel: "Advanced" },
    { id: "about",        label: "Help",            ariaLabel: "Help" },
  ];
  const tabIndexById = new Map<SettingsTab, number>(tabs.map((t, i) => [t.id, i]));

  const requestedTab = initialTab ?? "performance";
  let activeTab: SettingsTab = tabIndexById.has(requestedTab) ? requestedTab : "performance";

  // Sidebar nav (replaces horizontal tab bar)
  const tabBar = make("div", {
    class: "settings-sidebar",
    role: "tablist",
    "aria-label": "Settings sections",
  });
  // Content body wrapper
  const bodyEl = make("div", { class: "settings-body" });
  // Tab panels container
  const panelsEl = make("div", { class: "settings-panels" });
  const jumpBar = make("div", { class: "settings-jumpbar", hidden: "true", "aria-label": "Search results" });
  const clearSearchBtn = make("button", {
    class: "btn btn--ghost settings-search-clear",
    type: "button",
    hidden: "true",
    "aria-label": "Clear settings search",
  }, "Clear search") as HTMLButtonElement;
  quickBar.append(clearSearchBtn, jumpBar);

  const tabBtns: HTMLButtonElement[] = [];
  const panels: HTMLElement[] = [];

  const switchTab = (id: SettingsTab) => {
    if (!tabIndexById.has(id)) return;
    activeTab = id;
    const activeIndex = tabIndexById.get(id) ?? -1;
    tabBtns.forEach((btn, i) => {
      const isActive = tabs[i]!.id === id;
      btn.setAttribute("aria-selected", String(isActive));
      btn.setAttribute("tabindex", isActive ? "0" : "-1");
      btn.classList.toggle("settings-tab--active", isActive);
    });
    panels.forEach((panel, i) => {
      const isActive = tabs[i]!.id === id;
      panel.hidden = !isActive;
      panel.setAttribute("aria-hidden", String(!isActive));
    });
    const activeBtn = activeIndex >= 0 ? tabBtns[activeIndex] : null;
    activeTabLabel.textContent = activeIndex >= 0 ? `Viewing: ${tabs[activeIndex]!.label}` : "";
    if (activeBtn) {
      const scrollIntoViewFn = (activeBtn as HTMLElement & { scrollIntoView?: unknown }).scrollIntoView;
      if (typeof scrollIntoViewFn === "function") {
        scrollIntoViewFn.call(activeBtn, { block: "nearest", inline: "nearest" });
      }
    }
  };

  tabs.forEach((tab, i) => {
    const iconEl = settingsSidebarIconEl(tab.id);
    const labelEl = make("span", { class: "settings-sidebar__label" }, tab.label);
    const btn = make("button", {
      id: `tab-${tab.id}`,
      class: "settings-sidebar__item",
      type: "button",
      role: "tab",
      "aria-selected": tab.id === activeTab ? "true" : "false",
      tabindex: tab.id === activeTab ? "0" : "-1",
      "aria-controls": `tab-panel-${tab.id}`,
      "aria-label": tab.ariaLabel,
    }) as HTMLButtonElement;
    btn.append(iconEl, labelEl);
    btn.addEventListener("click", () => switchTab(tab.id));
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
        e.preventDefault();
        const nextIndex =
          e.key === "Home" ? 0 :
          e.key === "End" ? tabs.length - 1 :
          (e.key === "ArrowRight" || e.key === "ArrowDown") ? (i + 1) % tabs.length :
          (i - 1 + tabs.length) % tabs.length;
        const target = tabBtns[nextIndex]!;
        switchTab(tabs[nextIndex]!.id);
        target.focus();
        return;
      }
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        switchTab(tab.id);
      }
    });
    tabBar.appendChild(btn);
    tabBtns.push(btn);

    const panel = make("div", {
      id: `tab-panel-${tab.id}`,
      class: "settings-panel-content",
      role: "tabpanel",
      "aria-hidden": tab.id === activeTab ? "false" : "true",
      "aria-labelledby": `tab-${tab.id}`,
    });
    if (tab.id !== activeTab) panel.hidden = true;
    panels.push(panel);
    panelsEl.appendChild(panel);
  });

  bodyEl.appendChild(panelsEl);
  settingsShell.append(tabBar, bodyEl);
  container.append(quickBar, settingsShell);

  // Detect sidebar overflow (used on mobile when sidebar collapses to horizontal)
  const updateTabBarOverflow = () => {
    requestAnimationFrame(() => {
      tabBar.classList.toggle("overflows", tabBar.scrollWidth > tabBar.clientWidth);
    });
  };
  updateTabBarOverflow();
  if (typeof ResizeObserver !== "undefined") {
    _settingsTabBarRo?.disconnect();
    _settingsTabBarRo = new ResizeObserver(updateTabBarOverflow);
    _settingsTabBarRo.observe(tabBar);
  }

  // Ensure tab button classes and panel visibility match the active tab
  switchTab(activeTab);

  // Fill tabs
  buildPerfTab(panels[0]!, settings, deviceCaps, onSettingsChange, emulatorRef, APP_NAME);
  buildDisplayTab(panels[1]!, settings, deviceCaps, onSettingsChange, emulatorRef, APP_NAME);
  buildLibraryTab(panels[2]!, settings, library, saveLibrary, onSettingsChange, onLaunchGame, emulatorRef, APP_NAME);
  buildCloudTab(panels[3]!, settings, library, onSettingsChange, APP_NAME);
  buildMultiplayerTab(panels[5]!, settings, onSettingsChange, getNetplayManager, settings.lastGameName, emulatorRef?.currentSystem?.id, APP_NAME);
  buildDebugTab(panels[8]!, settings, onSettingsChange, deviceCaps, emulatorRef, getNetplayManager, biosLibrary);
  panels[9]!.appendChild(make("p", { class: "settings-help", role: "status" }, "Loading help..."));

  try {
    void _loadSettingsTabs().then((st) => {
      if (!st) return;
      if (settingsContentToken !== _settingsContentToken) return;
      st.buildBiosTab(panels[4]!, biosLibrary, { appName: APP_NAME, onError: showError });
      st.buildAchievementsTab(panels[6]!, getApiKeyStore(), {
        appName: APP_NAME,
        onError: showError,
      });
      const apiKeysCleanup = st.buildApiKeysTab(panels[7]!, getApiKeyStore(), {
        appName: APP_NAME,
        getTester: (id: string) => getKeyedProviders().get(id) ?? null,
        onError: showError,
      });
      _settingsContentCleanups.push(apiKeysCleanup);
      panels[9]!.textContent = "";
      st.buildAboutTab(panels[9]!, APP_NAME);
    }).catch(() => {
      // Dynamic import failed (e.g. test environment) â€” tabs will render without lazy content.
    });
  } catch {
    // _loadSettingsTabs is unavailable (test environment) â€” skip lazy tab loading.
  }

  const applySearchFilter = () => {
    const query = searchInput.value.trim().toLowerCase();
    let matchedSections = 0;
    jumpBar.innerHTML = "";
    jumpBar.hidden = true;
    clearSearchBtn.hidden = query.length === 0;

    for (let i = 0; i < panels.length; i++) {
      const panel = panels[i]!;
      const sections = Array.from(panel.querySelectorAll<HTMLElement>(".settings-section"));
      let panelMatched = false;
      let firstMatchLabel = "";

      for (const section of sections) {
        const indexedEls = Array.from(section.querySelectorAll<HTMLElement>(
          ".settings-section__title, .radio-row__label, .radio-row__desc, .settings-help, .toggle-row__text, label, button, summary"
        ));
        const haystack = indexedEls.map((el) => el.textContent ?? "").join(" ").toLowerCase();
        const match = query.length === 0 || haystack.includes(query);
        section.hidden = !match;
        if (match) {
          panelMatched = true;
          matchedSections += 1;
          if (!firstMatchLabel) {
            firstMatchLabel = section.querySelector<HTMLElement>(".settings-section__title")?.textContent?.trim() ?? "Section";
          }
        }
      }

      tabBtns[i]!.classList.toggle("settings-tab--match", panelMatched && query.length > 0);
      if (query.length > 0 && panelMatched) {
        const jumpBtn = make("button", {
          class: "settings-jumpbar__btn",
          type: "button",
          "aria-label": `Jump to ${tabs[i]!.label} settings`,
        }, `${tabs[i]!.label}${firstMatchLabel ? ` Â· ${firstMatchLabel}` : ""}`) as HTMLButtonElement;
        jumpBtn.addEventListener("click", () => {
          switchTab(tabs[i]!.id);
          requestAnimationFrame(() => {
            const firstVisibleSection = panel.querySelector<HTMLElement>(".settings-section:not([hidden])");
            if (firstVisibleSection) _safeScrollIntoView(firstVisibleSection, { block: "start", behavior: "smooth" });
            const firstFocusable = firstVisibleSection?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
            firstFocusable?.focus();
          });
        });
        jumpBar.appendChild(jumpBtn);
      }
    }

    if (query.length === 0) {
      searchStatus.textContent = "";
      return;
    }
    jumpBar.hidden = matchedSections === 0;
    searchStatus.textContent = matchedSections > 0
      ? `${matchedSections} matching section${matchedSections === 1 ? "" : "s"}`
      : "No matching settings";
  };
  searchInput.addEventListener("input", applySearchFilter);
  clearSearchBtn.addEventListener("click", () => {
    searchInput.value = "";
    applySearchFilter();
    searchInput.focus();
  });
}


// â”€â”€ BIOS tab â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const OPEN_SOURCE_NETPLAY_SERVER_OPTIONS = [
  {
    name: "EmuLAN",
    fit: "Fast same-network rooms",
    command: "npx emulan",
    href: "https://github.com/nickcoutsos/emulan",
  },
  {
    name: "EmulatorJS netplay-server",
    fit: "Private online or LAN lobby",
    command: "git clone https://github.com/EmulatorJS/netplay-server",
    href: "https://github.com/EmulatorJS/netplay-server",
  },
] as const;

function buildNetplayReadinessStrip(opts: {
  hasGame: boolean;
  serverReady: boolean;
  supportedSystem: boolean;
  onHost: () => void;
  onJoin: () => void;
  onBrowse: () => void;
}): HTMLElement {
  const strip = make("div", { class: "enp-readiness", role: "region", "aria-label": "Play Together readiness" });
  const items = make("div", { class: "enp-readiness__items" });
  items.append(
    makeReadinessItem("Game", opts.hasGame ? "Loaded" : "Needed", opts.hasGame),
    makeReadinessItem("System", opts.supportedSystem ? "Supported" : "Unsupported", opts.supportedSystem),
    makeReadinessItem("Server", opts.serverReady ? "Ready" : "Set up", opts.serverReady),
  );

  const actions = make("div", { class: "enp-readiness__actions" });
  const hostBtn = make("button", { type: "button", class: "btn btn--primary enp-ready-action" }, "Host") as HTMLButtonElement;
  hostBtn.addEventListener("click", opts.onHost);
  const joinBtn = make("button", { type: "button", class: "btn enp-ready-action" }, "Join code") as HTMLButtonElement;
  joinBtn.addEventListener("click", opts.onJoin);
  const browseBtn = make("button", { type: "button", class: "btn enp-ready-action" }, "Browse") as HTMLButtonElement;
  browseBtn.addEventListener("click", opts.onBrowse);
  actions.append(hostBtn, joinBtn, browseBtn);

  strip.append(items, actions);
  return strip;
}

function makeReadinessItem(label: string, value: string, ready: boolean): HTMLElement {
  const item = make("div", { class: ready ? "enp-readiness__item enp-readiness__item--ready" : "enp-readiness__item" });
  item.append(
    make("span", { class: "enp-readiness__label" }, label),
    make("span", { class: "enp-readiness__value" }, value),
  );
  return item;
}

function buildOpenSourceNetplayPanel(): HTMLElement {
  const details = make("details", { class: "enp-open-source" }) as HTMLDetailsElement;
  details.appendChild(make("summary", { class: "enp-open-source__summary" }, "Open-source server options"));
  const body = make("div", { class: "enp-open-source__body" });
  for (const option of OPEN_SOURCE_NETPLAY_SERVER_OPTIONS) {
    const row = make("div", { class: "enp-open-source__row" });
    const copy = make("div", { class: "enp-open-source__copy" });
    const link = make("a", {
      class: "enp-open-source__name",
      href: option.href,
      target: "_blank",
      rel: "noreferrer",
    }, option.name);
    copy.append(
      link,
      make("span", { class: "enp-open-source__fit" }, option.fit),
      make("code", { class: "enp-open-source__cmd" }, option.command),
    );
    const btnCopy = make("button", { type: "button", class: "btn enp-open-source__btn" }, "Copy") as HTMLButtonElement;
    btnCopy.addEventListener("click", () => {
      void navigator.clipboard?.writeText(option.command).then(() => {
        showInfoToast("Server command copied.");
      }).catch(() => {
        showInfoToast("Couldn't copy the command. Please allow clipboard access.", "warning");
      });
    });
    row.append(copy, btnCopy);
    body.appendChild(row);
  }
  details.appendChild(body);
  return details;
}

export function openEasyNetplayModal(opts: {
  netplayManager?: NetplayManager;
  currentGameName?: string | null;
  currentGameId?:   string | null;
  currentSystemId?: string | null;
  /** Opens Settings on the Play Together tab (closes this modal first). */
  onOpenPlayTogetherSettings?: () => void;
  /**
   * Invite code to pre-fill into the Join tab (e.g. from a `?join=<code>`
   * deep-link captured at startup).  When present, the modal activates the
   * Join tab and populates the code field so the user lands one tap away
   * from joining.
   */
  initialJoinCode?: string | null;
}): void {
  const { netplayManager, currentGameName, currentGameId, currentSystemId, onOpenPlayTogetherSettings, initialJoinCode } = opts;
  const serverUrl = netplayManager?.serverUrl ?? "";
  const username  = netplayManager?.username  ?? "";
  const netplayEnabled = netplayManager?.enabled ?? false;

  const easyMgr = sharedGetEasyNetplayManager(serverUrl);
  const panelCleanups: Array<() => void> = [];

  // â”€â”€ Overlay / container â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const overlay = make("div", { class: "confirm-overlay easy-netplay-overlay" });
  const dialog  = make("div", {
    class:      "confirm-box easy-netplay-dialog",
    role:       "dialog",
    "aria-modal": "true",
    "aria-label": "Play Together lobby",
  });

  // â”€â”€ Header â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const header = make("div", { class: "enp-header" });
  const brand = make("div", { class: "enp-header-brand" });
  const logoImg = make("img", {
    class:       "enp-header__logo",
    src:         resolveAssetUrl("assets/netplay_icon_premium_1775434064140.png"),
    width:       "24",
    height:      "24",
    alt:         "",
    "aria-hidden": "true",
    decoding:    "async",
  }) as HTMLImageElement;
  const titleStack = make("div", { class: "enp-header-titles" });
  titleStack.append(
    make("span", { class: "enp-title" }, "Play Together"),
    make("span", { class: "enp-header__subtitle" }, "Host, paste join codes, use LANemu, browse rooms, or spectate"),
  );
  brand.append(logoImg, titleStack);
  header.appendChild(brand);
  const btnCopyDiagnostics = make("button", {
    class: "enp-copy-diag",
    "aria-label": "Copy multiplayer diagnostics",
    title: "Copy connection diagnostics",
  }, "Logs") as HTMLButtonElement;
  btnCopyDiagnostics.addEventListener("click", () => {
    const entries = easyMgr.diagnostics.entries;
    if (entries.length === 0) {
      showInfoToast("No diagnostics yet.");
      return;
    }
    const titleLine = `${APP_NAME} Multiplayer Diagnostics (${new Date().toISOString()})`;
    const body = entries.map((entry) => {
      const ts = new Date(entry.timestamp).toISOString();
      const detail = entry.detail ? ` â€” ${entry.detail}` : "";
      return `[${ts}] [${entry.level.toUpperCase()}] ${entry.message}${detail}`;
    }).join("\n");
    const text = `${titleLine}\n${body}`;
    void navigator.clipboard?.writeText(text).then(() => {
      showInfoToast("Diagnostics copied.");
    }).catch(() => {
      showInfoToast("Couldn't copy logs. Please allow clipboard access.");
    });
  });
  header.appendChild(btnCopyDiagnostics);

  // Close button
  const btnClose = make("button", {
    class:       "enp-close",
    "aria-label": "Close multiplayer",
  }) as HTMLButtonElement;
  btnClose.innerHTML = ICON_CLOSE_X_SVG;
  header.appendChild(btnClose);
  dialog.appendChild(header);
  const preTabs = make("div", { class: "enp-pre-tabs" });
  dialog.appendChild(preTabs);

  // â”€â”€ First-time / setup strip (server or enable missing) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const needsServerUrl = serverUrl.trim().length === 0;
  const needsEnable = !netplayEnabled;
  if (needsServerUrl || needsEnable) {
    const setupStrip = make("div", { class: "enp-setup-strip", role: "region", "aria-label": "Online play setup" });
    const setupTitle = make("p", { class: "enp-setup-strip__title" }, "Set up multiplayer (one minute)");
    const setupSteps = make("ol", { class: "enp-setup-strip__steps" });
    const step1 = needsEnable
      ? "Open Settings â†’ Play Together and turn on Online play."
      : "Online play is on â€” add your server URL in Settings â†’ Play Together.";
    const step2 = "Paste the WebSocket address your host gave you (starts with wss:// or ws://).";
    const step3 = "Come back here, host or join, and use the same game as your friend.";
    setupSteps.append(
      make("li", {}, step1),
      make("li", {}, step2),
      make("li", {}, step3),
    );
    setupStrip.append(setupTitle, setupSteps);
    if (onOpenPlayTogetherSettings) {
      const btnSetup = make("button", {
        type: "button",
        class: "btn btn--primary enp-setup-strip__btn",
      }, "Open Play Together settings") as HTMLButtonElement;
      btnSetup.addEventListener("click", () => {
        onOpenPlayTogetherSettings();
      });
      setupStrip.appendChild(btnSetup);
    }
    setupStrip.appendChild(buildOpenSourceNetplayPanel());
    preTabs.appendChild(setupStrip);
  }

  // â”€â”€ Current game badge â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const hasGame = !!(currentGameId || currentGameName);
  const topLevelSystemSupport = currentSystemId ? checkSystemSupport(currentSystemId) : null;
  if (currentGameName) {
    const gameBadge = make("div", { class: "enp-game-badge" });
    gameBadge.appendChild(make("span", { class: "enp-game-badge__label" }, "Playing:"));
    gameBadge.appendChild(make("span", { class: "enp-game-badge__name" }, currentGameName));
    const sysSupport = currentSystemId ? checkSystemSupport(currentSystemId) : null;
    if (sysSupport && !sysSupport.compatible) {
      gameBadge.appendChild(make("span", {
        class: "enp-compat-warn",
        title: sysSupport.errors[0] ?? "",
      }, "No multiplayer support"));
    }
    preTabs.appendChild(gameBadge);
  }

  // â”€â”€ Tab bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const tabs: Array<{ id: string; label: string }> = [
    { id: "host",    label: "Host"        },
    { id: "join",    label: "Join code"   },
    { id: "lanemu",  label: "LAN / Wi-Fi" },
    { id: "browse",  label: "Browse"      },
    { id: "watch",   label: "Spectate"    },
  ];
  const tabBar     = make("div", { class: "enp-tabs",  role: "tablist" });
  const panelWrap  = make("div", { class: "enp-panels" });
  let activeTabId  = "host";

  const tabBtns: HTMLButtonElement[] = [];
  const panels:  HTMLElement[]       = [];

  const switchTab = (id: string) => {
    activeTabId = id;
    tabBtns.forEach((b, i) => {
      const isActive = tabs[i]!.id === id;
      b.setAttribute("aria-selected", String(isActive));
      b.classList.toggle("enp-tab--active", isActive);
    });
    panels.forEach((p, i) => {
      p.hidden = tabs[i]!.id !== id;
    });
  };

  preTabs.prepend(buildNetplayReadinessStrip({
    hasGame,
    serverReady: !needsServerUrl && !needsEnable,
    supportedSystem: !topLevelSystemSupport || topLevelSystemSupport.compatible,
    onHost: () => switchTab("host"),
    onJoin: () => switchTab("join"),
    onBrowse: () => switchTab(serverUrl ? "browse" : "host"),
  }));

  for (const tab of tabs) {
    const btn = make("button", {
      class: "enp-tab",
      role:  "tab",
      "aria-selected": tab.id === activeTabId ? "true" : "false",
    }, tab.label) as HTMLButtonElement;
    btn.addEventListener("click", () => switchTab(tab.id));
    tabBar.appendChild(btn);
    tabBtns.push(btn);

    const panel = make("div", { class: "enp-panel", role: "tabpanel" });
    panel.hidden = tab.id !== activeTabId;
    panelWrap.appendChild(panel);
    panels.push(panel);
  }

  dialog.appendChild(tabBar);
  dialog.appendChild(panelWrap);

  // â”€â”€ Host panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  panelCleanups.push(_buildHostPanel(panels[0]!, {
    easyMgr, username, currentGameId, currentGameName, currentSystemId, serverUrl,
    onRoomCreated: () => {/* panel updates itself via onEvent */},
  }));

  // â”€â”€ Join panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Capture refs so the Browse panel can pre-fill and quick-join without
  // forcing extra taps.
  let _fillJoinCode: ((code: string) => void) | null = null;
  let _quickJoinCode: ((code: string) => void) | null = null;
  panelCleanups.push(_buildJoinPanel(panels[1]!, {
    easyMgr, username, currentGameId, currentGameName, currentSystemId, serverUrl,
    onCodeSetterReady: (setter) => { _fillJoinCode = setter; },
    onJoinActionReady: (joinNow) => { _quickJoinCode = joinNow; },
  }));

  // â”€â”€ LANemu panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  panels[2]!.appendChild(make("p", { class: "enp-panel-desc", role: "status" }, "Loading LAN rooms..."));
  void import("./multiplayer/ui/MultiplayerHome.js")
    .then(({ buildMultiplayerHome }) => {
      const cleanup = buildMultiplayerHome(panels[2]!);
      if (closed) {
        cleanup();
      } else {
        panelCleanups.push(cleanup);
      }
    })
    .catch(() => {
      panels[2]!.textContent = "";
      panels[2]!.appendChild(make("p", { class: "enp-server-warn", role: "alert" },
        "LAN rooms could not load. Close this panel and try again."
      ));
    });

  // â”€â”€ Browse panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Watch-tab pre-fill refs
  let _fillWatchCode: ((code: string) => void) | null = null;
  let _quickWatchCode: ((code: string) => void) | null = null;
  panelCleanups.push(_buildBrowsePanel(panels[3]!, {
    easyMgr, currentGameName, currentSystemId, serverUrl,
    onJoinByCode: (code) => {
      switchTab("join");
      _fillJoinCode?.(code);
      _quickJoinCode?.(code);
    },
    onWatchByCode: (code) => {
      // _fillWatchCode pre-fills the code input and enables the button.
      // _quickWatchCode immediately triggers the watch attempt for one-tap flow.
      switchTab("watch");
      _fillWatchCode?.(code);
      _quickWatchCode?.(code);
    },
  }));

  // â”€â”€ Watch panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  panelCleanups.push(_buildWatchPanel(panels[4]!, {
    easyMgr, username: username || "Anonymous", serverUrl,
    onCodeSetterReady: (setter) => { _fillWatchCode = setter; },
    onWatchActionReady: (watchNow) => { _quickWatchCode = watchNow; },
  }));

  // â”€â”€ Append + animate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Deep-link / share-link pre-fill: when a `?join=<code>` was captured at
  // startup (or otherwise forwarded), pre-activate the Join tab and seed
  // the invite-code field so the user lands one tap away from connecting.
  if (initialJoinCode && initialJoinCode.length > 0) {
    const normalised = normaliseInviteCode(initialJoinCode);
    if (normalised.length > 0) {
      switchTab("join");
      // Re-read through a local so TS doesn't narrow _fillJoinCode to null
      // (callback assignment inside _buildJoinPanel is not visible to flow
      // analysis here).
      const fill = _fillJoinCode as ((code: string) => void) | null;
      fill?.(normalised);
    }
  }

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener(LEGACY_EVENTS.closeEasyNetplay, onCloseNetplayEvent);
    document.removeEventListener("keydown", onKey, { capture: true });
    panelCleanups.forEach((fn) => {
      try { fn(); } catch { /* ignore cleanup errors */ }
    });
    easyMgr.cancelPendingOperations();
    // Mark the netplay slice inactive so subscribers know the modal is gone.
    store.set("netplay", { active: false, roomKey: null, peerCount: 0 });
    overlay.classList.remove("confirm-overlay--visible");
    setTimeout(() => overlay.remove(), OVERLAY_FADE_DELAY_MS);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && isTopmostOverlay(overlay)) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const onCloseNetplayEvent = () => { if (!closed) close(); };
  document.addEventListener(LEGACY_EVENTS.closeEasyNetplay, onCloseNetplayEvent);

  btnClose.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey, { capture: true });
  // Mark the netplay slice active so subscribers can show an "in-lobby" indicator.
  store.set("netplay", { active: true });
  requestAnimationFrame(() => {
    overlay.classList.add("confirm-overlay--visible");
    tabBtns[0]?.focus();
  });
}

// â”€â”€ Easy Netplay â€” Host panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _buildHostPanel(
  container: HTMLElement,
  opts: {
    easyMgr:         EasyNetplayManager;
    username:        string;
    currentGameId?:  string | null;
    currentGameName?: string | null;
    currentSystemId?: string | null;
    serverUrl:       string;
    onRoomCreated?:  () => void;
  }
): () => void {
  const { easyMgr, username, currentGameId, currentGameName, currentSystemId, serverUrl } = opts;

  container.appendChild(make("p", { class: "enp-panel-desc" },
    "Host a room so friends can join your game."
  ));

  // Room type selector
  const typeWrap = make("div", { class: "enp-field" });
  typeWrap.appendChild(make("label", { class: "enp-label", for: "enp-room-type" }, "Room type"));
  const typeSelect = make("select", {
    id:    "enp-room-type",
    class: "enp-select",
    name:  "roomType",
  }) as HTMLSelectElement;
  const typeOptions: Array<{ value: string; label: string; desc: string }> = [
    {
      value: "local",
      label: "Same Wiâ€‘Fi / LAN",
      desc: "Lowest latency when everyone is nearby. You still need the same server URL so this device can register the room (paste it in Play Together settings).",
    },
    { value: "private", label: "Private (invite code)", desc: "Only people with the code can join â€” best for playing with a specific friend." },
    { value: "public",  label: "Public lobby",        desc: "Shows in Browse so anyone on the same game can join." },
  ];
  for (const opt of typeOptions) {
    typeSelect.appendChild(make("option", { value: opt.value }, opt.label));
  }
  typeWrap.appendChild(typeSelect);

  // Dynamic description beneath the selector
  const typeDesc = make("p", { class: "enp-help" }, typeOptions[0]!.desc);
  typeSelect.addEventListener("change", () => {
    const found = typeOptions.find(o => o.value === typeSelect.value);
    typeDesc.textContent = found?.desc ?? "";
  });
  typeWrap.appendChild(typeDesc);
  container.appendChild(typeWrap);

  // No-server warning
  if (!serverUrl) {
    const warn = make("p", { class: "enp-server-warn" },
      "No server URL configured. Local-only rooms cannot be discovered by others. Add a server in Settings â†’ Play Together."
    );
    container.appendChild(warn);
  }

  // Status area (shows after Create is clicked)
  const statusArea = make("div", {
    class: "enp-status-area",
    role: "status",
    "aria-live": "polite",
  });
  statusArea.hidden = true;
  container.appendChild(statusArea);

  // Create button
  const btnCreate = make("button", {
    class: "btn btn--primary enp-btn-create",
  }) as HTMLButtonElement;
  btnCreate.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Host Game`;

  const hasGame = !!(currentGameId || currentGameName);
  if (!hasGame) {
    btnCreate.disabled = true;
    btnCreate.title    = "Open a game first, then come back to host";
    container.appendChild(make("p", { class: "enp-help enp-help--warn" },
      "Open a game first, then click Play Together to host."
    ));
    const pickGameBtn = make("button", { class: "btn enp-btn-secondary" }, "Choose Game File") as HTMLButtonElement;
    pickGameBtn.addEventListener("click", () => {
      document.dispatchEvent(new CustomEvent(LEGACY_EVENTS.closeEasyNetplay));
      setTimeout(() => {
        const picker = document.getElementById("file-input") as HTMLInputElement | null;
        picker?.click();
      }, 40);
    });
    container.appendChild(pickGameBtn);
  }

  let activeUnsub: (() => void) | null = null;

  btnCreate.addEventListener("click", async () => {
    btnCreate.disabled = true;
    btnCreate.textContent = "Creating roomâ€¦";
    statusArea.hidden = false;
    statusArea.innerHTML = "";
    statusArea.appendChild(make("p", { class: "enp-diag enp-diag--info" }, "Connectingâ€¦"));

    // Subscribe to events once
    activeUnsub?.();
    activeUnsub = easyMgr.onEvent(ev => {
      if (ev.type === "diagnostic") {
        const item = sharedRenderEasyDiagnosticEntry(ev.diagnostic.level, ev.diagnostic.message, ev.diagnostic.detail);
        // Clear "Connectingâ€¦" placeholder on first real message
        if (statusArea.children.length === 1 && statusArea.children[0]!.textContent === "Connectingâ€¦") {
          statusArea.innerHTML = "";
        }
        statusArea.appendChild(item);
      }
      if (ev.type === "room_created") {
        activeUnsub?.();
        activeUnsub = null;
        const room = ev.room;
        statusArea.innerHTML = "";
        sharedRenderRoomCard(statusArea, room, { showLeaveBtn: true, easyMgr, isHost: true, showToast: showInfoToast });
        btnCreate.textContent = "Hosting";
        btnCreate.disabled    = true;
      }
      if (ev.type === "error") {
        activeUnsub?.();
        activeUnsub = null;
        statusArea.innerHTML = "";
        statusArea.appendChild(make("p", { class: "enp-diag enp-diag--error" }, ev.message));
        btnCreate.disabled = false;
        btnCreate.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Try Again`;
      }
    });

    await easyMgr.hostRoom({
      hostName:    username || "Anonymous",
      gameId:      currentGameId  ?? currentGameName ?? "unknown",
      gameName:    currentGameName ?? currentGameId  ?? "Unknown Game",
      systemId:    currentSystemId ?? "psp",
      privacy:     (typeSelect.value as import("./netplay/netplayTypes.js").RoomPrivacy),
      maxPlayers:  2,
    });
  });

  container.appendChild(btnCreate);
  return () => {
    activeUnsub?.();
    activeUnsub = null;
  };
}

// â”€â”€ Easy Netplay â€” Join panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _buildJoinPanel(
  container: HTMLElement,
  opts: {
    easyMgr:          EasyNetplayManager;
    username:         string;
    currentGameId?:   string | null;
    currentGameName?: string | null;
    currentSystemId?: string | null;
    serverUrl:        string;
    /** Called once the code-input setter is ready; lets the Browse panel pre-fill it. */
    onCodeSetterReady?: (setter: (code: string) => void) => void;
    /** Called once join action is ready; enables one-tap join from Browse. */
    onJoinActionReady?: (joinNow: (code: string) => void) => void;
  }
): () => void {
  const { easyMgr, username, serverUrl } = opts;

  container.appendChild(make("p", { class: "enp-panel-desc" },
    "Enter the invite code your friend shared to join their room."
  ));

  // Code input
  const codeField = make("div", { class: "enp-field" });
  codeField.appendChild(make("label", { class: "enp-label", for: "enp-join-code" }, "Invite code"));
  const codeInput = make("input", {
    type:         "text",
    id:           "enp-join-code",
    name:         "inviteCode",
    class:        "enp-code-input",
    placeholder:  "ABC123â€¦",
    maxlength:    String(INVITE_CODE_LEN),
    autocomplete: "off",
    autocapitalize: "characters",
    autocorrect:  "off",
    spellcheck:   "false",
    inputmode:    "text",
  }) as HTMLInputElement;

  // Auto-format, uppercase, and sync button state whenever the value changes.
  // Extracted into a named function so the Browse-panel pre-fill setter can
  // call the same logic directly without dispatching a synthetic DOM event.
  const syncCodeInput = () => {
    const norm = normaliseInviteCode(codeInput.value);
    if (norm !== codeInput.value) codeInput.value = norm;
    codeError.hidden = true;
    btnJoin.disabled = norm.length < INVITE_CODE_LEN;
  };
  codeInput.addEventListener("input", syncCodeInput);
  const codeRow = make("div", { class: "enp-code-row" });
  const btnPasteCode = make("button", {
    type: "button",
    class: "btn enp-btn-paste-code",
  }, "Paste") as HTMLButtonElement;
  btnPasteCode.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard?.readText();
      if (!text) {
        codeInput.focus();
        return;
      }
      codeInput.value = text;
      syncCodeInput();
      codeInput.focus();
    } catch {
      codeInput.focus();
      showInfoToast("Clipboard paste is blocked. Type the code here instead.", "warning");
    }
  });
  codeRow.append(codeInput, btnPasteCode);
  codeField.appendChild(codeRow);
  container.appendChild(codeField);

  // Expose a setter so other panels (e.g. Browse) can pre-fill the code and
  // immediately enable the Join button without dispatching a synthetic event.
  opts.onCodeSetterReady?.((code: string) => {
    codeInput.value = normaliseInviteCode(code);
    syncCodeInput();
    codeInput.focus();
  });

  // Error display
  const codeError = make("p", {
    class: "enp-diag enp-diag--error",
    role: "alert",
    "aria-live": "assertive",
  });
  codeError.hidden = true;
  container.appendChild(codeError);

  // No-server warning
  if (!serverUrl) {
    container.appendChild(make("p", { class: "enp-server-warn" },
      "No server URL configured. Joining by code requires a server. Add one in Settings â†’ Play Together."
    ));
  }

  // Status area
  const statusArea = make("div", {
    class: "enp-status-area",
    role: "status",
    "aria-live": "polite",
  });
  statusArea.hidden = true;
  container.appendChild(statusArea);

  // Join button
  const btnJoin = make("button", {
    class:    "btn btn--primary enp-btn-join",
    disabled: "",
  }) as HTMLButtonElement;
  btnJoin.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg> Join Room`;

  let activeUnsub: (() => void) | null = null;
  const attemptJoin = async (prefilledCode?: string) => {
    const code = normaliseInviteCode(prefilledCode ?? codeInput.value);
    codeInput.value = code;
    syncCodeInput();
    if (code.length < INVITE_CODE_LEN) {
      codeError.textContent = `Enter the full invite code (${INVITE_CODE_LEN} characters).`;
      codeError.hidden = false;
      return;
    }

    btnJoin.disabled = true;
    btnJoin.textContent = "Joiningâ€¦";
    statusArea.hidden  = false;
    statusArea.innerHTML = "";
    statusArea.appendChild(make("p", { class: "enp-diag enp-diag--info" }, "Connectingâ€¦"));

    activeUnsub?.();
    activeUnsub = easyMgr.onEvent(ev => {
      if (ev.type === "diagnostic") {
        if (statusArea.children.length === 1 && statusArea.children[0]!.textContent === "Connectingâ€¦") {
          statusArea.innerHTML = "";
        }
        statusArea.appendChild(sharedRenderEasyDiagnosticEntry(ev.diagnostic.level, ev.diagnostic.message, ev.diagnostic.detail));
      }
      if (ev.type === "room_joined") {
        activeUnsub?.();
        activeUnsub = null;
        const room = ev.room;
        statusArea.innerHTML = "";
        sharedRenderRoomCard(statusArea, room, { showLeaveBtn: true, easyMgr, isHost: false, showToast: showInfoToast });
        btnJoin.textContent = "Joined";
        btnJoin.disabled    = true;
      }
      if (ev.type === "error") {
        activeUnsub?.();
        activeUnsub = null;
        statusArea.innerHTML = "";
        codeError.textContent = ev.message;
        codeError.hidden = false;
        statusArea.hidden = true;
        btnJoin.disabled = false;
        btnJoin.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg> Try Again`;
      }
    });

    await easyMgr.joinRoom({
        code,
        playerName:    username || "Anonymous",
        localGameId:   opts.currentGameId   ?? undefined,
        localSystemId: opts.currentSystemId ?? undefined,
      });
  };
  btnJoin.addEventListener("click", () => { void attemptJoin(); });
  opts.onJoinActionReady?.((code) => { void attemptJoin(code); });

  container.appendChild(btnJoin);
  return () => {
    activeUnsub?.();
    activeUnsub = null;
  };
}

// â”€â”€ Easy Netplay â€” Browse panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Interval (ms) between automatic room list refreshes in the Browse panel. */
const _BROWSE_AUTO_REFRESH_MS = 30_000;

function _buildBrowsePanel(
  container: HTMLElement,
  opts: {
    easyMgr:          EasyNetplayManager;
    currentGameName?: string | null;
    currentSystemId?: string | null;
    serverUrl?:       string;
    /** Called when the user clicks "Join" on a room card; receives the invite code. */
    onJoinByCode?:    (code: string) => void;
    /** Called when the user clicks "Watch" on a room card; receives the invite code. */
    onWatchByCode?:   (code: string) => void;
  }
): () => void {
  const { easyMgr, currentGameName, serverUrl, currentSystemId } = opts;
  const gameRoomKey = currentGameName && currentSystemId
    ? resolveNetplayRoomKey(currentGameName, currentSystemId)
    : null;

  container.appendChild(make("p", { class: "enp-panel-desc" },
    currentGameName
      ? `Open rooms for: ${currentGameName}`
      : "Browse available rooms. Open a game to filter by title."
  ));

  // When no server is configured, show a helpful message instead of loading skeletons.
  if (!serverUrl) {
    container.appendChild(make("p", { class: "enp-server-warn" },
      "No server URL configured. Add one in Settings â†’ Play Together to browse online rooms."
    ));
  }

  // Local / All filter toggle
  const filterWrap = make("div", { class: "enp-filter-row" });
  const filterBtns: HTMLButtonElement[] = [];
  const filters = [
    { id: "nearby", label: "ðŸ“¶ Nearby" },
    { id: "all",    label: "ðŸŒ All Rooms" },
  ];
  if (gameRoomKey) {
    filters.splice(1, 0, { id: "this_game", label: "ðŸŽ¯ This Game" });
  }
  let activeFilter = "nearby";

  const applyFilter = (id: string, rooms: EasyNetplayRoom[]) => {
    activeFilter = id;
    filterBtns.forEach((b, i) => {
      b.classList.toggle("enp-filter-btn--active", filters[i]!.id === id);
    });
    if (id === "nearby") {
      renderRooms(rooms.filter(r => r.isLocal));
    } else if (id === "this_game") {
      if (!gameRoomKey) {
        renderRooms(rooms);
        return;
      }
      renderRooms(rooms.filter((room) => {
        const roomKey = resolveNetplayRoomKey(room.gameName || room.gameId, room.systemId);
        return roomKey === gameRoomKey;
      }));
    } else {
      renderRooms(rooms);
    }
  };

  for (const filter of filters) {
    const btn = make("button", {
      class: filter.id === activeFilter ? "btn enp-filter-btn enp-filter-btn--active" : "btn enp-filter-btn",
    }, filter.label) as HTMLButtonElement;
    btn.addEventListener("click", () => applyFilter(filter.id, latestRooms));
    filterWrap.appendChild(btn);
    filterBtns.push(btn);
  }
  container.appendChild(filterWrap);

  // Room list container
  const listEl = make("div", { class: "enp-room-list" });
  container.appendChild(listEl);

  let latestRooms: EasyNetplayRoom[] = [];
  let loadAbort: AbortController | null = null;

  const renderRooms = (rooms: EasyNetplayRoom[]) => {
    listEl.innerHTML = "";
    const orderedRooms = [...rooms].sort((a, b) => {
      const aFull = a.playerCount >= a.maxPlayers;
      const bFull = b.playerCount >= b.maxPlayers;
      if (aFull !== bFull) return aFull ? 1 : -1;
      if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
      const aLatency = a.latencyMs ?? Number.POSITIVE_INFINITY;
      const bLatency = b.latencyMs ?? Number.POSITIVE_INFINITY;
      if (aLatency !== bLatency) return aLatency - bLatency;
      return b.createdAt - a.createdAt;
    });
    if (orderedRooms.length === 0) {
      const emptyMsg = activeFilter === "nearby"
        ? "No nearby rooms found. Try \"All Rooms\" or host one yourself."
        : activeFilter === "this_game"
          ? "No compatible rooms for this game yet. Host one to get started."
        : "No open rooms right now â€” be the first to create one!";
      listEl.appendChild(make("p", { class: "enp-room-empty" }, emptyMsg));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const room of orderedRooms) {
      const card = make("div", { class: "enp-room-card" });

      const cardTop = make("div", { class: "enp-room-card__top" });
      cardTop.appendChild(make("span", { class: "enp-room-card__name" }, room.name));
      if (room.isLocal) {
        cardTop.appendChild(make("span", { class: "enp-room-card__badge enp-room-card__badge--local" }, "Nearby"));
      }
      const incompatibleSystem = Boolean(currentSystemId && room.systemId && room.systemId !== currentSystemId);
      const isFull = room.playerCount >= room.maxPlayers;
      const statusLabel = incompatibleSystem
        ? "Wrong System"
        : isFull
          ? "Full"
          : room.hasPassword
            ? "Private"
            : "Open";
      const statusCls = incompatibleSystem
        ? "enp-room-card__badge--incompat"
        : isFull
          ? "enp-room-card__badge--full"
          : room.hasPassword
            ? "enp-room-card__badge--locked"
            : "enp-room-card__badge--open";
      cardTop.appendChild(make("span", { class: `enp-room-card__badge ${statusCls}` }, statusLabel));
      card.appendChild(cardTop);

      const cardMeta = make("div", { class: "enp-room-card__meta" });
      cardMeta.appendChild(make("span", { class: "enp-room-card__game" }, room.gameName || room.gameId));
      cardMeta.appendChild(make("span", { class: "enp-room-card__host" }, `Host: ${room.hostName}`));
      cardMeta.appendChild(make("span", { class: "enp-room-card__players" }, `${room.playerCount}/${room.maxPlayers} players`));
      if (room.latencyMs !== undefined) {
        const ping = Math.round(room.latencyMs);
        const pingCls = ping <= LATENCY_GOOD_THRESHOLD_MS ? "good" : ping <= LATENCY_WARN_THRESHOLD_MS ? "warn" : "bad";
        cardMeta.appendChild(make("span", { class: `enp-room-card__ping enp-room-card__ping--${pingCls}` }, `${ping} ms`));
      }
      card.appendChild(cardMeta);

      if (!isFull && !incompatibleSystem) {
        const btnJoinRoom = make("button", {
          class: "btn btn--primary enp-room-join-btn",
        }) as HTMLButtonElement;
        btnJoinRoom.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg> Quick Join`;
        btnJoinRoom.addEventListener("click", () => {
          if (opts.onJoinByCode) {
            opts.onJoinByCode(room.code);
          } else {
            showInfoToast(`Code: ${room.code} â€” switch to the Join tab to connect`);
          }
        });
        card.appendChild(btnJoinRoom);
      }

      // Spectate button â€” shown on all open rooms regardless of fullness.
      if (!incompatibleSystem) {
        const btnWatch = make("button", {
          class: "btn enp-room-watch-btn",
          title: "Watch this game as a spectator",
        }) as HTMLButtonElement;
        btnWatch.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Watch`;
        btnWatch.addEventListener("click", () => {
          if (opts.onWatchByCode) {
            opts.onWatchByCode(room.code);
          } else {
            showInfoToast(`Code: ${room.code} â€” open Watch tab or switch to Join tab`);
          }
        });
        card.appendChild(btnWatch);
      }

      frag.appendChild(card);
    }
    listEl.appendChild(frag);
  };

  // â”€â”€ Auto-refresh countdown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Polls every _BROWSE_AUTO_REFRESH_MS ms and shows a live countdown so
  // users know the list is staying fresh without manual intervention.

  let autoRefreshTimerId: ReturnType<typeof setTimeout> | null = null;
  let countdownTimerId:   ReturnType<typeof setInterval> | null = null;
  let nextRefreshAt = 0;
  let lastShownSecs = -1;

  const stopAutoRefresh = () => {
    if (autoRefreshTimerId !== null) { clearTimeout(autoRefreshTimerId);  autoRefreshTimerId  = null; }
    if (countdownTimerId   !== null) { clearInterval(countdownTimerId);   countdownTimerId    = null; }
  };

  const startAutoRefresh = () => {
    stopAutoRefresh();
    if (!serverUrl) return;
    nextRefreshAt = Date.now() + _BROWSE_AUTO_REFRESH_MS;
    lastShownSecs = -1;
    autoRefreshTimerId = setTimeout(() => {
      // Restart cycle after refresh, whether it succeeds or fails.
      void doRefresh().then(startAutoRefresh).catch(startAutoRefresh);
    }, _BROWSE_AUTO_REFRESH_MS);
    countdownTimerId = setInterval(() => {
      const secsLeft = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
      if (secsLeft === lastShownSecs) return; // skip DOM write when unchanged
      lastShownSecs = secsLeft;
      countdownEl.textContent = secsLeft > 0 ? `Auto-refresh in ${secsLeft}s` : "";
    }, 1_000);
  };

  // Refresh function â€” skips network call when no server is configured.
  const doRefresh = async () => {
    if (!serverUrl) {
      renderRooms([]);
      return;
    }
    if (loadAbort) loadAbort.abort();
    loadAbort = new AbortController();
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshingâ€¦";
    countdownEl.textContent = "";

    listEl.innerHTML = "";
    // Skeleton placeholder
    for (let i = 0; i < 2; i++) {
      const skel = make("div", { class: "enp-room-skeleton" });
      listEl.appendChild(skel);
    }

    try {
      const rooms = await easyMgr.listRooms(loadAbort.signal);
      latestRooms = rooms;
      applyFilter(activeFilter, rooms);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      listEl.innerHTML = "";
      listEl.appendChild(make("p", { class: "enp-room-error" },
        "Couldn't reach the server. Check your connection and server URL."
      ));
    } finally {
      refreshBtn.disabled  = false;
      refreshBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.49-4.5"/></svg> Refresh`;
    }
  };

  // Footer with Refresh button and auto-refresh countdown
  const footer = make("div", { class: "enp-browse-footer" });
  const refreshBtn = make("button", { class: "btn enp-refresh-btn" }) as HTMLButtonElement;
  refreshBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.49-4.5"/></svg> Refresh`;
  refreshBtn.addEventListener("click", () => {
    stopAutoRefresh();
    void doRefresh().then(startAutoRefresh).catch(startAutoRefresh);
  });
  footer.appendChild(refreshBtn);
  const countdownEl = make("span", { class: "enp-refresh-countdown" });
  footer.appendChild(countdownEl);
  container.appendChild(footer);

  // Auto-load on panel reveal and start auto-refresh cycle.
  renderRooms([]);
  void doRefresh().then(startAutoRefresh).catch(startAutoRefresh);
  return () => {
    stopAutoRefresh();
    loadAbort?.abort();
    loadAbort = null;
  };
}

// â”€â”€ Easy Netplay â€” Watch (Spectator) panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _buildWatchPanel(
  container: HTMLElement,
  opts: {
    easyMgr:             EasyNetplayManager;
    username:            string;
    serverUrl?:          string;
    /** Called once the code-input setter is ready; lets the Browse panel pre-fill it. */
    onCodeSetterReady?:  (setter: (code: string) => void) => void;
    /** Called once watch action is ready; enables one-tap watch from Browse. */
    onWatchActionReady?: (watchNow: (code: string) => void) => void;
  }
): () => void {
  const { easyMgr, serverUrl } = opts;

  container.appendChild(make("p", { class: "enp-panel-desc" },
    "Enter an invite code to watch a game as a spectator. You'll see the session but won't be able to play."
  ));

  // Code input
  const codeField = make("div", { class: "enp-field" });
  codeField.appendChild(make("label", { class: "enp-label", for: "enp-watch-code" }, "Invite code"));
  const codeInput = make("input", {
    type:          "text",
    id:            "enp-watch-code",
    name:          "spectatorInviteCode",
    class:         "enp-code-input",
    placeholder:   "ABC123â€¦",
    maxlength:     String(INVITE_CODE_LEN),
    autocomplete:  "off",
    autocapitalize: "characters",
    autocorrect:   "off",
    spellcheck:    "false",
    inputmode:     "text",
  }) as HTMLInputElement;

  const syncCodeInput = () => {
    const norm = normaliseInviteCode(codeInput.value);
    if (norm !== codeInput.value) codeInput.value = norm;
    codeError.hidden = true;
    btnWatch.disabled = norm.length < 4;
  };
  codeInput.addEventListener("input", syncCodeInput);
  codeField.appendChild(codeInput);
  container.appendChild(codeField);

  opts.onCodeSetterReady?.((code: string) => {
    codeInput.value = normaliseInviteCode(code);
    syncCodeInput();
    codeInput.focus();
  });

  // Error display
  const codeError = make("p", {
    class: "enp-diag enp-diag--error",
    role: "alert",
    "aria-live": "assertive",
  });
  codeError.hidden = true;
  container.appendChild(codeError);

  // No-server warning
  if (!serverUrl) {
    container.appendChild(make("p", { class: "enp-server-warn" },
      "No server URL configured. Spectating requires a server. Add one in Settings â†’ Play Together."
    ));
  }

  // Status area
  const statusArea = make("div", {
    class: "enp-status-area",
    role: "status",
    "aria-live": "polite",
  });
  statusArea.hidden = true;
  container.appendChild(statusArea);

  // Watch button
  const btnWatch = make("button", {
    class:    "btn btn--secondary enp-btn-watch",
    disabled: "",
  }) as HTMLButtonElement;
  btnWatch.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Watch Game`;

  let activeUnsub: (() => void) | null = null;
  const attemptWatch = async (prefilledCode?: string) => {
    const code = normaliseInviteCode(prefilledCode ?? codeInput.value);
    codeInput.value = code;
    syncCodeInput();
    if (code.length < INVITE_CODE_LEN) {
      codeError.textContent = `Enter the full invite code (${INVITE_CODE_LEN} characters).`;
      codeError.hidden = false;
      return;
    }

    btnWatch.disabled = true;
    btnWatch.textContent = "Connectingâ€¦";
    statusArea.hidden   = false;
    statusArea.innerHTML = "";
    statusArea.appendChild(make("p", { class: "enp-diag enp-diag--info" }, "Connectingâ€¦"));

    activeUnsub?.();
    activeUnsub = easyMgr.onEvent(ev => {
      if (ev.type === "diagnostic") {
        if (statusArea.children.length === 1 && statusArea.children[0]!.textContent === "Connectingâ€¦") {
          statusArea.innerHTML = "";
        }
        statusArea.appendChild(sharedRenderEasyDiagnosticEntry(ev.diagnostic.level, ev.diagnostic.message, ev.diagnostic.detail));
      }
      if (ev.type === "spectator_joined") {
        activeUnsub?.();
        activeUnsub = null;
        const { room, spectatorCount } = ev.session;
        statusArea.innerHTML = "";
        // Spectator room card
        const card = make("div", { class: "enp-active-room enp-active-room--spectating" });
        const codeWrap = make("div", { class: "enp-active-room__code-wrap" });
        codeWrap.appendChild(make("span", { class: "enp-active-room__code-label" }, "Room"));
        codeWrap.appendChild(make("span", { class: "enp-active-room__code" }, room.name));
        card.appendChild(codeWrap);
        const info = make("div", { class: "enp-active-room__info" });
        info.appendChild(make("span", { class: "enp-active-room__name" }, `${room.isLocal ? "ðŸ“¶ Local" : "ðŸŒ Online"} Â· ${room.playerCount}/${room.maxPlayers} players`));
        if (room.gameName) {
          info.appendChild(make("span", { class: "enp-active-room__detail" }, `Game: ${room.gameName}`));
        }
        if (spectatorCount > 0) {
          info.appendChild(make("span", { class: "enp-active-room__detail" }, `ðŸ‘ ${spectatorCount} spectator${spectatorCount !== 1 ? "s" : ""}`));
        }
        card.appendChild(info);
        card.appendChild(make("p", { class: "enp-active-room__waiting" }, "ðŸ‘ Spectating â€” watching the gameâ€¦"));
        const btnLeave = make("button", { class: "btn btn--danger enp-leave-btn" }, "Stop Watching") as HTMLButtonElement;
        btnLeave.addEventListener("click", async () => {
          await easyMgr.leaveRoom();
          statusArea.innerHTML = "";
          statusArea.appendChild(make("p", { class: "enp-diag enp-diag--info" }, "You stopped watching."));
          btnWatch.disabled    = false;
          btnWatch.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Watch Game`;
        });
        card.appendChild(btnLeave);
        statusArea.appendChild(card);
        btnWatch.textContent = "Watching";
        btnWatch.disabled    = true;
      }
      if (ev.type === "error") {
        activeUnsub?.();
        activeUnsub = null;
        statusArea.innerHTML = "";
        codeError.textContent = ev.message;
        codeError.hidden  = false;
        statusArea.hidden = true;
        btnWatch.disabled = false;
        btnWatch.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Try Again`;
      }
    });

    await easyMgr.watchRoom({ code });
  };
  btnWatch.addEventListener("click", () => { void attemptWatch(); });
  opts.onWatchActionReady?.((code) => { void attemptWatch(code); });

  container.appendChild(btnWatch);
  return () => {
    activeUnsub?.();
    activeUnsub = null;
  };
}

// â”€â”€ About tab â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// â”€â”€ Multi-disc helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function parseM3U(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"))
    .map(line => line.split(/[/\\]/).pop() ?? line);
}

function showMultiDiscPicker(discFileNames: string[]): Promise<Map<string, File> | null> {
  return showMultiDiscPickerImpl(discFileNames);
}

// â”€â”€ Tier downgrade prompt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    `Tip: turn on \"Dynamic resolution\" in Settings â†’ Performance so supported 3D systems ` +
    `can scale internal resolution automatically before you change tiers.`;
  return showConfirmDialog(message, {
    title: "Low Frame Rate Detected",
    confirmLabel: `Switch to ${tierNames[targetTier] ?? targetTier} Tier`,
    isDanger: false,
  });
}

// â”€â”€ Audio Visualiser, Dev Overlay, FPS overlay toggle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Extracted to src/modules/DevOverlay.ts.
// Functions toggleDevOverlay, isDevOverlayVisible, updateDevOverlay,
// showFPSOverlay, startAudioVisualiser, stopAudioVisualiser, _uiDirtyTracker
// are imported from that module at the top of this file.

let _lowFPSCount = 0;
let _perfSuggestionShown = false;
let _perfSuggestionAutoDismissTimer: ReturnType<typeof setTimeout> | null = null;
const LOW_FPS_THRESHOLD = 25;
const LOW_FPS_TRIGGER   = 6;

function updateFPSOverlay(snapshot: FPSSnapshot, emulator: PSPEmulator): void {
  if (!_fpsOverlayEls) {
    _fpsOverlayEls = {
      val: document.getElementById("fps-current-val"),
      avg: document.getElementById("fps-avg"),
      tier: document.getElementById("fps-tier"),
      drs: document.getElementById("fps-drs"),
      dropped: document.getElementById("fps-dropped"),
    };
  }
  const { val: valEl, avg: avgEl, tier: tierEl, drs: drsEl, dropped: droppedEl } = _fpsOverlayEls;

  if (valEl) {
    valEl.textContent = `${snapshot.current}`;
    valEl.className = `fps-val ${snapshot.current >= 50 ? "fps-good" : snapshot.current >= 30 ? "fps-ok" : "fps-bad"}`;
  }
  if (avgEl) avgEl.textContent = `avg ${snapshot.average}`;
  if (tierEl) {
    tierEl.textContent =
      emulator.activeTier !== null ? formatTierLabel(emulator.activeTier) : "";
  }
  if (drsEl) {
    const drsHint = emulator.drsOverlayHint;
    if (drsHint) {
      drsEl.textContent = drsHint;
      drsEl.hidden = false;
    } else {
      drsEl.textContent = "";
      drsEl.hidden = true;
    }
  }
  if (droppedEl) {
    if (snapshot.droppedFrames > 0) { 
      droppedEl.textContent = `${snapshot.droppedFrames} dropped`; 
      droppedEl.hidden = false; 
    } else { 
      droppedEl.hidden = true; 
    }
  }

  if (snapshot.average > 0 && snapshot.average < LOW_FPS_THRESHOLD) {
    _lowFPSCount++;
    if (_lowFPSCount >= LOW_FPS_TRIGGER && !_perfSuggestionShown) { _perfSuggestionShown = true; showPerfSuggestion(); }
  } else {
    _lowFPSCount = Math.max(0, _lowFPSCount - 1);
  }
}

function showPerfSuggestion(): void {
  const existing = document.getElementById("perf-suggestion");
  if (existing) return;

  const isMobile = isLikelyIOS() || isLikelyAndroid();
  const mobileTip = isMobile ? " Closing background apps may also help on mobile." : "";

  const toast = make("div", { id: "perf-suggestion", class: "perf-suggestion", role: "status" });
  toast.innerHTML =
    `<span class="perf-suggestion__msg">Game running slowly? Try <strong>Performance mode</strong> or turn on <strong>Dynamic resolution</strong> under Settings â†’ Performance.${mobileTip}</span>` +
    `<button class="perf-suggestion__close" aria-label="Dismiss">${ICON_CLOSE_X_SVG}</button>`;
  document.body.appendChild(toast);

  _perfSuggestionAutoDismissTimer = setTimeout(() => { _perfSuggestionAutoDismissTimer = null; dismiss(); }, PERF_SUGGESTION_AUTO_DISMISS_MS);
  const dismiss = () => {
    if (_perfSuggestionAutoDismissTimer !== null) { clearTimeout(_perfSuggestionAutoDismissTimer); _perfSuggestionAutoDismissTimer = null; }
    toast.classList.add("perf-suggestion--hiding"); setTimeout(() => toast.remove(), PERF_SUGGESTION_FADE_DELAY_MS);
  };
  toast.querySelector(".perf-suggestion__close")?.addEventListener("click", dismiss);
  requestAnimationFrame(() => toast.classList.add("perf-suggestion--visible"));
}

function resetPerfSuggestion(): void {
  _lowFPSCount = 0;
  _perfSuggestionShown = false;
  if (_perfSuggestionAutoDismissTimer !== null) { clearTimeout(_perfSuggestionAutoDismissTimer); _perfSuggestionAutoDismissTimer = null; }
  document.getElementById("perf-suggestion")?.remove();
}

// â”€â”€ Header overflow indicator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function updateHeaderOverflow(): void {
  const actions = document.getElementById("header-actions");
  if (!actions) return;
  requestAnimationFrame(() => {
    actions.classList.toggle("overflows", actions.scrollWidth > actions.clientWidth);
  });
}

// â”€â”€ State-driven DOM updates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function updateStatusDot(state: EmulatorState): void {
  const dot   = document.getElementById("status-dot");
  const label = document.getElementById("status-state");
  if (!dot || !label) return;
  const labels: Record<EmulatorState, string> = {
    idle: "Ready",
    loading: "Loadingâ€¦",
    running: "Playing",
    paused: "Paused",
    error: "Something went wrong"
  };
  dot.className     = `status-dot ${state}`;
  label.textContent = labels[state];
  if (state === "loading") showLoadingOverlay();

  // Show/hide the "Playing: â€¦" items in footer
  const isActive = state === "running" || state === "paused";
  const sysItem  = document.getElementById("status-system-item");
  const sysLabel = document.getElementById("status-system-label");
  const tierItem = document.getElementById("status-tier-item");
  if (sysItem)  sysItem.classList.toggle("status-item--hidden", !isActive);
  if (sysLabel) sysLabel.classList.toggle("status-item--hidden", !isActive);
  if (tierItem) tierItem.classList.toggle("status-item--hidden", !isActive);

  if (state === "idle" || state === "error") { setStatusGame("â€”"); setStatusSystem("â€”"); setStatusTier(null); }
}


/** Set the current progress percent (0-100) shown on the loading overlay. Pass null to hide. */
function setLoadingProgress(percent: number | null): void {
  const container = document.getElementById("loading-progress-container");
  const bar       = document.getElementById("loading-progress-bar");
  if (!container || !bar) return;
  if (percent === null) {
    container.hidden = true;
  } else {
    container.hidden = false;
    bar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  }
}

async function fetchFromCloud(game: GameMetadata, settings: Settings): Promise<Blob> {
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
  if (!reader) return await response.blob();

  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (total > 0) {
      setLoadingProgress((loaded / total) * 100);
    }
  }

  return new Blob(chunks);
}


// â”€â”€ Visibility helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function hideLanding(): void    { el("#landing").classList.add("hidden"); }
function showLanding(): void    { el("#landing").classList.remove("hidden"); }
export function showLoadingOverlay(): void {
  const overlay = document.getElementById("loading-overlay");
  overlay?.classList.add("visible");
  overlay?.setAttribute("aria-hidden", "false");
}
export function hideLoadingOverlay(): void {
  const overlay = document.getElementById("loading-overlay");
  overlay?.classList.remove("visible");
  overlay?.setAttribute("aria-hidden", "true");
  setLoadingProgress(null);
  const sub = document.getElementById("loading-subtitle");
  if (sub) {
    sub.textContent = "";
    sub.setAttribute("hidden", "true");
  }
}
function showEjsContainer(): void  {
  document.getElementById(EMULATOR_JS_CONTAINER_ID)?.classList.add("visible");
}
function hideEjsContainer(): void  {
  document.getElementById(EMULATOR_JS_CONTAINER_ID)?.classList.remove("visible");
}

function transitionToGame(): void {
  document.body.classList.add("is-playing");
  if (_libraryGamepadRafId !== null) {
    cancelAnimationFrame(_libraryGamepadRafId);
    _libraryGamepadRafId = null;
  }
  hideLanding();
  // Ensure the settings panel is hidden so its text does not leak into
  // the in-game status header or overlay.
  const settingsPanel = document.getElementById("settings-panel");
  if (settingsPanel && !settingsPanel.hidden) {
    settingsPanel.hidden = true;
    if (_settingsPanelEscHandler) {
      document.removeEventListener("keydown", _settingsPanelEscHandler);
      _settingsPanelEscHandler = null;
    }
    if (_settingsPanelFocusTrap) {
      document.removeEventListener("keydown", _settingsPanelFocusTrap);
      _settingsPanelFocusTrap = null;
    }
    if (_settingsPanelSearchShortcutHandler) {
      document.removeEventListener("keydown", _settingsPanelSearchShortcutHandler, { capture: true });
      _settingsPanelSearchShortcutHandler = null;
    }
    _settingsTabBarRo?.disconnect();
    _settingsTabBarRo = null;
    _settingsContentCleanups.forEach((fn) => {
      try { fn(); } catch { /* ignore stale settings cleanup */ }
    });
    _settingsContentCleanups = [];
    _settingsContentToken += 1;
  }
  requestAnimationFrame(() => showEjsContainer());
}

export function transitionToLibrary(): void {
  document.body.classList.remove("is-playing");
  syncEmulatorViewportLayout(document.getElementById(EMULATOR_JS_CONTAINER_ID), null);
  hideEjsContainer();
  requestAnimationFrame(() => {
    showLanding();
    _libraryGamepadRestartFn?.();
  });
}
function afterNextPaint(callback: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}
export function setLoadingMessage(msg: string): void { const e = document.getElementById("loading-message"); if (e) e.textContent = msg; }
/** Set a secondary hint shown under the loading message. Pass empty string to hide. */
export function setLoadingSubtitle(msg: string): void {
  const e = document.getElementById("loading-subtitle");
  if (!e) return;
  e.textContent = msg;
  if (msg.trim()) e.removeAttribute("hidden");
  else e.setAttribute("hidden", "true");
}
function setStatusGame(name: string): void    { const e = document.getElementById("status-game");    if (e) e.textContent = name; }
function setStatusSystem(name: string): void  { const e = document.getElementById("status-system");  if (e) e.textContent = name; }
function setStatusTier(tier: PerformanceTier | null): void { const e = document.getElementById("status-tier"); if (e) e.textContent = tier ? formatTierLabel(tier) : "â€”"; }

let _errorDismissTimer: ReturnType<typeof setTimeout> | null = null;
const ERROR_DISMISS_TIMEOUT_MS = 12_000;
let _toastDismissTimer: ReturnType<typeof setTimeout> | null = null;
const TOAST_DISMISS_TIMEOUT_MS = 5_000;

function _clearErrorDismissTimer(): void {
  if (_errorDismissTimer !== null) {
    clearTimeout(_errorDismissTimer);
    _errorDismissTimer = null;
  }
}

function _scheduleErrorDismiss(): void {
  _clearErrorDismissTimer();
  _errorDismissTimer = setTimeout(() => {
    hideError();
    _errorDismissTimer = null;
  }, ERROR_DISMISS_TIMEOUT_MS);
}

function _clearToastDismissTimer(): void {
  if (_toastDismissTimer !== null) {
    clearTimeout(_toastDismissTimer);
    _toastDismissTimer = null;
  }
}

/** Map common technical error patterns to more player-friendly messages. */
function friendlyErrorMessage(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("sharedarraybuffer") || m.includes("cross-origin isolated")) {
    return "PSP games need a special browser feature (SharedArrayBuffer) that isn't available here.\n\nTry opening the page from the correct URL, or use a browser that supports HTTPS.";
  }
  if (m.includes("webassembly") || m.includes("wasm")) {
    return "Your browser doesn't support WebAssembly, which is required to run games.\n\nTry Chrome 90+, Firefox 90+, or Safari 15+.";
  }
  if (m.includes("not found in library") || m.includes("game file not found")) {
    return "Game file not found. The file may have been deleted from this browser.\n\nTry adding the game again from your device.";
  }
  if (m.includes("quota") || m.includes("storage") || m.includes("no space")) {
    return "Not enough storage space to save this game. Try clearing some old games or saves in Settings â†’ My Games.";
  }
  if (m.includes("network") || m.includes("fetch") || m.includes("failed to load")) {
    return "Couldn't load a required file. Check your internet connection and try again.";
  }
  if ((m.includes("dreamcast") || m.includes("flycast")) && (m.includes("experimental") || m.includes("stabil"))) {
    return "Dreamcast support is experimental right now. Some games may boot slowly, show glitches, or crash.\n\nIf it fails, try another title, lower the load on your device, and make sure both Dreamcast BIOS files are installed.";
  }
  if (m.includes("bios") || m.includes("startup file")) {
    return "This game needs a startup file (BIOS). Go to Settings â†’ System Files to add one.";
  }
  return msg; // Return original if no friendly mapping found
}

export function showError(msg: string, onRetry?: () => void): void {
  const banner = document.getElementById("error-banner");
  const msgEl  = document.getElementById("error-message");
  if (!banner || !msgEl) return;
  msgEl.textContent = "";

  const displayMsg = friendlyErrorMessage(msg);

  // Render newlines as <br> so multi-paragraph error messages display correctly
  const lines = displayMsg.split("\n");
  lines.forEach((line, i) => {
    if (i > 0) msgEl.appendChild(document.createElement("br"));
    msgEl.appendChild(document.createTextNode(line));
  });

  // For BIOS errors, add a quick-action button that opens the System Files tab directly
  const isBiosError = msg.toLowerCase().includes("bios") || msg.toLowerCase().includes("startup file");
  if (isBiosError && _openSettingsFn) {
    const actionBtn = document.createElement("button");
    actionBtn.className = "error-action-btn";
    actionBtn.textContent = "Open System Files";
    actionBtn.addEventListener("click", () => {
      hideError();
      _openSettingsFn!("bios");
    });
    msgEl.appendChild(document.createElement("br"));
    msgEl.appendChild(actionBtn);
  }

  // Add a Retry button when the caller provides a retry callback
  if (onRetry) {
    const retryBtn = document.createElement("button");
    retryBtn.className = "error-action-btn error-retry-btn";
    retryBtn.textContent = "Retry";
    retryBtn.addEventListener("click", () => {
      hideError();
      onRetry();
    });
    msgEl.appendChild(document.createElement("br"));
    msgEl.appendChild(retryBtn);
  }

  banner.classList.add("visible");
  const firstAction =
    msgEl.querySelector<HTMLButtonElement>(".error-action-btn") ??
    document.getElementById("error-close") as HTMLButtonElement | null;
  requestAnimationFrame(() => {
    (firstAction ?? banner).focus();
  });

  const pauseDismiss = () => _clearErrorDismissTimer();
  const resumeDismiss = () => {
    const active = document.activeElement;
    if (active instanceof Node && banner.contains(active)) return;
    _scheduleErrorDismiss();
  };

  banner.onmouseenter = pauseDismiss;
  banner.onmouseleave = resumeDismiss;
  (banner as HTMLElement & { onfocusin: ((this: GlobalEventHandlers, ev: FocusEvent) => unknown) | null }).onfocusin = pauseDismiss;
  (banner as HTMLElement & { onfocusout: ((this: GlobalEventHandlers, ev: FocusEvent) => unknown) | null }).onfocusout = () => setTimeout(resumeDismiss, 0);
  banner.onkeydown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    hideError();
  };

  _scheduleErrorDismiss();
}

export function hideError(): void {
  _clearErrorDismissTimer();
  const banner = document.getElementById("error-banner");
  if (!banner) return;
  banner.classList.remove("visible");
  banner.onmouseenter = null;
  banner.onmouseleave = null;
  (banner as HTMLElement & { onfocusin: ((this: GlobalEventHandlers, ev: FocusEvent) => unknown) | null }).onfocusin = null;
  (banner as HTMLElement & { onfocusout: ((this: GlobalEventHandlers, ev: FocusEvent) => unknown) | null }).onfocusout = null;
  banner.onkeydown = null;
}

export function showInfoToast(msg: string, type: "success" | "info" | "warning" | "error" = "success"): void {
  const existing = document.getElementById("info-toast");
  if (existing) existing.remove();
  _clearToastDismissTimer();

  const toast = document.createElement("div");
  toast.id = "info-toast";
  toast.className = `info-toast info-toast--${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.setAttribute("aria-live", type === "error" ? "assertive" : "polite");
  toast.setAttribute("aria-atomic", "true");

  const icon = document.createElement("span");
  icon.className = "info-toast__icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = INFO_TOAST_ICON_HTML[type] ?? INFO_TOAST_ICON_HTML.success;

  const text = document.createElement("span");
  text.className = "info-toast__msg";
  text.textContent = msg;

  const closeBtn = document.createElement("button");
  closeBtn.className = "error-close";
  closeBtn.innerHTML = ICON_CLOSE_X_SVG;
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.addEventListener("click", () => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), TOAST_REMOVE_DELAY_MS);
    _clearToastDismissTimer();
  });

  toast.append(icon, text, closeBtn);
  document.body.appendChild(toast);

  // Trigger entrance
  requestAnimationFrame(() => toast.classList.add("visible"));

  const dismissToast = () => {
    if (toast.parentElement) {
      toast.classList.remove("visible");
      setTimeout(() => toast.remove(), TOAST_REMOVE_DELAY_MS);
    }
    _clearToastDismissTimer();
  };
  const scheduleToastDismiss = () => {
    _clearToastDismissTimer();
    _toastDismissTimer = setTimeout(dismissToast, TOAST_DISMISS_TIMEOUT_MS);
  };
  const pauseToastDismiss = () => _clearToastDismissTimer();
  const resumeToastDismiss = () => {
    const active = document.activeElement;
    if (active instanceof Node && toast.contains(active)) return;
    scheduleToastDismiss();
  };

  toast.addEventListener("mouseenter", pauseToastDismiss);
  toast.addEventListener("mouseleave", resumeToastDismiss);
  toast.addEventListener("focusin", pauseToastDismiss as EventListener);
  toast.addEventListener("focusout", (() => setTimeout(resumeToastDismiss, 0)) as EventListener);

  scheduleToastDismiss();
}

// â”€â”€ Test helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
