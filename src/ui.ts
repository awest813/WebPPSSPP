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
 * Keyboard shortcuts (global, while emulator is running):
 *   F5  → Quick Save slot 1
 *   F7  → Quick Load slot 1
 *   F1  → Reset (confirmation dialog — same as toolbar)
 *   Esc → Return to library
 *
 * All shortcut handlers use the capture phase and stopPropagation() so the
 * intercepted keys never reach the EmulatorJS key-input handler, while all
 * regular game-control keys (arrows, letters, etc.) pass through untouched.
 *
 * Global keyboard shortcuts (always active):
 *   F9  → Open Settings → Debug tab
 *   F3  → Toggle developer debug overlay (FPS, frame time, memory, draw calls)
 */

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
  getSystemFeatureSummary,
  type SystemInfo,
} from "./systems.js";
import {
  GameLibrary,
  formatBytes,
  formatRelativeTime,
  type GameMetadata,
} from "./library.js";
import { parseCloudLibraryConnectionConfig } from "./cloudLibrary.js";
import {
  type DeviceCapabilities,
  type PerformanceMode,
  type PerformanceTier,
  formatCapabilitiesSummary,
  formatTierLabel,
  isLikelyIOS,
  isLikelyAndroid,
  UIDirtyFlags,
  UIDirtyTracker,
  clearCapabilitiesCache,
} from "./performance.js";
import {
  type PostProcessEffect,
} from "./webgpuPostProcess.js";
import {
  BiosLibrary,
  BIOS_REQUIREMENTS,
} from "./bios.js";
import {
  SaveStateLibrary,
} from "./saves.js";
import type { Settings } from "./main.js";
import type { TouchControlsOverlay } from "./touchControls.js";
import { isTouchDevice, isPortrait } from "./touchControls.js";
import type { NetplayManager } from "./multiplayer.js";
import {
  DEFAULT_ICE_SERVERS,
  validateIceServerUrl as standaloneValidateIceServerUrl,
  NETPLAY_SUPPORTED_SYSTEM_IDS,
  SYSTEM_LINK_CAPABILITIES,
  roomDisplayNameForKey,
} from "./multiplayerUtils.js";
import { getNetplayManager, peekNetplayManager, registerNetplayInstance } from "./netplaySingleton.js";
import { resolveNetplayRoomKey } from "./multiplayer.js"; // Stay in lazy chunk for now
import { EasyNetplayManager } from "./netplay/EasyNetplayManager.js";
import type { EasyNetplayRoom } from "./netplay/netplayTypes.js";
import { normaliseInviteCode, INVITE_CODE_LEN } from "./netplay/signalingClient.js";
import { checkSystemSupport } from "./netplay/compatibility.js";
import { getCloudSaveManager } from "./cloudSaveSingleton.js";
import {
  WebDAVProvider,
  GoogleDriveProvider,
  DropboxProvider,
  pCloudProvider,
  BlompProvider,
  BoxProvider,
} from "./cloudSave.js";
// Cloud library types moved to lazy functions to satisfy strict TSC
import { createProvider } from "./cloudLibrary.js";
import type { CloudLibraryConnection } from "./main.js";
import { createUuid } from "./uuid.js";
import { SaveGameService } from "./saveService.js";
import type { ArchiveExtractProgress, ArchiveFormat } from "./archive.js";
import { queryRequired as el, createElement as make } from "./ui/dom.js";
import {
  showConfirmDialog as showConfirmDialogImpl,
  pickSystem as pickSystemImpl,
  showGamePickerDialog as showGamePickerDialogImpl,
  showArchiveEntryPickerDialog as showArchiveEntryPickerDialogImpl,
  showMultiDiscPicker as showMultiDiscPickerImpl,
  isTopmostOverlay,
} from "./ui/modals.js";
import { createDebugConsoleController } from "./ui/debugConsole.js";
import { ArchiveSelectionStore } from "./archiveStore.js";

const APP_BASE_URL = import.meta.env.BASE_URL;
const resolveAssetUrl = (path: string): string => {
  const base = APP_BASE_URL === "/" ? "" : APP_BASE_URL;
  return `${base}${path}`;
};

// ── PWA install callbacks (set once from initUI) ───────────────────────────────
let _canInstallPWA: (() => boolean) | undefined;
let _onInstallPWA:  (() => Promise<boolean>) | undefined;

// ── Settings opener callback (set once from initUI, used by showError action buttons) ──
let _openSettingsFn: ((tab?: string) => void) | null = null;

let _initUICleanup: (() => void) | null = null;
export const TOUCH_CONTROLS_CHANGED_EVENT = "retrovault:touchControlsChanged";

let _libGpCachedCards: HTMLElement[] | null = null;
let _devOverlayEls: Record<string, HTMLElement | null> | null = null;
let _fpsOverlayEls: Record<string, HTMLElement | null> | null = null;
let _settingsPanelEscHandler: ((e: KeyboardEvent) => void) | null = null;
let _settingsPanelFocusTrap: ((e: KeyboardEvent) => void) | null = null;
let _settingsPanelSearchShortcutHandler: ((e: KeyboardEvent) => void) | null = null;
let _settingsTabBarRo: ResizeObserver | null = null;

// ── DOM helpers ───────────────────────────────────────────────────────────────

// ── Debug Console State & Logic ──────────────────────────────────────────────
const _debugConsole = createDebugConsoleController({ onToggleDevOverlay: () => toggleDevOverlay() });

function toggleDebugConsole(emulator?: PSPEmulator): void {
  _debugConsole.toggle(emulator);
}

function updateDebugConsoleLog(emulator: PSPEmulator): void {
  _debugConsole.update(emulator);
}

// ── Build DOM ─────────────────────────────────────────────────────────────────

/** Mini controller SVG icon (reused in header brand and footer) */
const _CTRL_SVG_MINI = `<svg width="12" height="12" viewBox="0 0 28 28" fill="none"
     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
     aria-hidden="true" style="color:var(--c-accent);opacity:0.6;flex-shrink:0">
  <rect x="2" y="7" width="24" height="14" rx="7"/>
  <rect x="7" y="12.5" width="5" height="3" rx="1" fill="currentColor" stroke="none" opacity="0.7"/>
  <rect x="8.5" y="11" width="2" height="6" rx="1" fill="currentColor" stroke="none" opacity="0.7"/>
  <circle cx="20" cy="12.5" r="1.1" fill="currentColor" stroke="none"/>
  <circle cx="22.5" cy="14" r="1.1" fill="currentColor" stroke="none"/>
  <circle cx="20" cy="15.5" r="1.1" fill="currentColor" stroke="none"/>
  <circle cx="17.5" cy="14" r="1.1" fill="currentColor" stroke="none"/>
</svg>`;

const _LOGO_FALLBACK_SVG = `<svg class="brand-logo" width="36" height="36" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="RetroVault" role="img"><rect x="2" y="7" width="24" height="14" rx="7"/><rect x="7" y="12.5" width="5" height="3" rx="1" fill="currentColor" stroke="none"/><rect x="8.5" y="11" width="2" height="6" rx="1" fill="currentColor" stroke="none"/><circle cx="20" cy="12.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="22.5" cy="14" r="1.1" fill="currentColor" stroke="none"/><circle cx="20" cy="15.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="17.5" cy="14" r="1.1" fill="currentColor" stroke="none"/></svg>`;

export function buildDOM(app: HTMLElement): void {
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

  app.innerHTML = `
    <!-- Skip navigation link for keyboard users -->
    <a class="skip-link" href="#landing">Skip to content</a>

    <!-- ── Header ── -->
    <header class="app-header">
      <div class="app-header__brand">
        <img src="${resolveAssetUrl("assets/logo_premium.png")}" alt="RetroVault" class="brand-logo" width="36" height="36" decoding="async" fetchpriority="high" draggable="false" />
        <span class="brand-long">RetroVault</span>
        <span class="brand-short" aria-hidden="true">RV</span>
      </div>

      <div class="app-header__actions" id="header-actions">
        <!-- Populated by buildLandingControls() / buildInGameControls() -->
      </div>
    </header>

    <!-- ── Main content area ── -->
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
            <div class="library-controls" aria-label="Library controls">
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
                        type="button" aria-label="Clear search" hidden>✕</button>
              </div>
              <div class="library-layout-toggle" id="library-layouts" role="radiogroup" aria-label="Layout">
                <button class="btn btn--ghost btn--icon layout-btn" data-layout="grid" title="Grid view" role="radio" aria-checked="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                </button>
                <button class="btn btn--ghost btn--icon layout-btn" data-layout="list" title="List view" role="radio" aria-checked="false">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                </button>
              </div>
              <button class="btn btn--ghost btn--icon library-fav-filter" id="library-fav-filter" title="Show favorites only" aria-pressed="false">
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
            </div>
          </div>
          <div class="system-filter" id="system-filter">
            <!-- System filter chips — populated by renderLibrary() -->
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
          <p class="drop-zone__label">${touchUI ? "Tap to add a game" : "Drop a game file here to start playing"}</p>
          <p class="drop-zone__sub" id="drop-zone-subtitle">${touchUI ? "Choose a ROM, archive, or disc image from your device" : 'or <span class="drop-zone__browse">browse your device</span>'}</p>
          <div class="drop-zone__actions">
            <button class="btn btn--primary btn--sm drop-zone__cta" id="btn-add-game-onboarding" type="button">Choose Files</button>
          </div>
          <p class="drop-zone__formats" id="drop-zone-formats" title="Supported file formats">${formatHint}</p>
        </div>

        <!-- Onboarding — only visible when library is empty -->
        <div class="onboarding" id="onboarding" role="region" aria-labelledby="onboarding-title" aria-hidden="true">
          <div class="welcome-hero">
            <p class="welcome-hero__eyebrow">First run</p>
            <h2 class="welcome-hero__title" id="onboarding-title">Add a game to begin</h2>
            <p class="welcome-hero__tagline">Drop a ROM, archive, or disc image here, or use Choose Files. RetroVault will detect the system and launch it.</p>
          </div>

          <div class="onboarding__grid">
            <div class="onboarding__card onboarding__card--main">
              <h3>What to do next</h3>
              <p>Choose one file and RetroVault handles detection, startup, and save management locally.</p>
              <div class="welcome-steps">
                <div class="welcome-step">1. Choose a game file</div>
                <div class="welcome-step">2. System detection runs automatically</div>
                <div class="welcome-step">3. Play and save locally</div>
              </div>
            </div>
          </div>

          <div class="onboarding__quick-actions" aria-label="Quick start actions">
            <button class="btn btn--primary" id="btn-add-game-secondary" type="button">Choose Files</button>
            <button class="btn btn--ghost" id="btn-open-help-onboarding" type="button">View Guide</button>
          </div>

          <div class="onboarding__features">
            <div class="onboarding__feature">
              <span class="onboarding__feature-icon" aria-hidden="true">⚡</span>
              <span><strong>Automatic setup</strong><br>No extra wizard. Pick a file and keep going.</span>
            </div>
            <div class="onboarding__feature">
              <span class="onboarding__feature-icon" aria-hidden="true">🎮</span>
              <span><strong>Inputs ready</strong><br>Keyboard, touch, USB gamepad, and Bluetooth are supported.</span>
            </div>
            <div class="onboarding__feature">
              <span class="onboarding__feature-icon" aria-hidden="true">🔒</span>
              <span><strong>Local saves</strong><br>Your library and saves stay on this device unless you enable cloud features.</span>
            </div>
          </div>
        </div>

        <p class="landing__legal">
          Bring your own legally obtained ROM files. This app does not provide ROMs or BIOS files.
          <a href="https://emulatorjs.org" target="_blank" rel="noopener">Powered by EmulatorJS</a>
        </p>
      </section>

      <!-- EmulatorJS mount point (hidden until a game launches) -->
      <div id="ejs-container">
        <div id="ejs-player"></div>
        <!-- Premium In-Game Performance Overlay -->
        <div id="fps-overlay" class="fps-overlay" hidden aria-label="Performance overlay">
          <div class="fps-current">
            <span id="fps-current-val" class="fps-val">--</span>
            <span class="fps-label">FPS</span>
          </div>
          <div class="fps-separator"></div>
          <span id="fps-avg" class="fps-detail">avg --</span>
          <span id="fps-tier" class="fps-detail"></span>
          <span id="fps-dropped" class="fps-detail fps-warn" hidden>0 dropped</span>
          <canvas id="fps-visualiser" class="fps-visualiser" width="60" height="18" hidden aria-hidden="true"></canvas>
        </div>
        <!-- High-Fidelity Developer Dashboard (F3) -->
        <div id="dev-overlay" class="dev-overlay" hidden aria-label="System diagnostic dashboard" aria-live="off">
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
        <span class="error-icon" aria-hidden="true">⚠️</span>
        <span id="error-message"></span>
        <button class="error-close" id="error-close" title="Dismiss" aria-label="Dismiss error">✕</button>
      </div>

      <!-- System picker modal -->
      <div id="system-picker" role="dialog" aria-modal="true" aria-labelledby="system-picker-title" hidden>
        <div class="modal-backdrop" id="system-picker-backdrop"></div>
        <div class="modal-box">
          <div class="modal-header">
            <h3 class="modal-title" id="system-picker-title">Choose System</h3>
            <button class="modal-close" id="system-picker-close" aria-label="Cancel">✕</button>
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
            <button class="modal-close" id="settings-close" aria-label="Close settings">✕</button>
          </div>
          <div id="settings-content">
            <!-- Populated by buildSettingsContent() -->
          </div>
        </div>
      </div>

      <!-- Debug console (toggled with Shift+F3 or Debug button) -->
      <div id="debug-console" class="debug-console" hidden aria-label="Debug console" role="dialog">
        <div class="debug-console__header" id="debug-console-handle">
          <div class="debug-console__title">🔧 Debug Console</div>
          <div class="debug-console__actions">
            <button class="debug-console__btn" id="debug-console-clear" title="Clear log">Clear</button>
            <button class="debug-console__btn" id="debug-console-close" aria-label="Close">✕</button>
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
        <span aria-hidden="true">📱</span>Rotate for best experience
      </div>

    </main>

    <!-- ── Footer ── -->
    <footer class="app-footer">
      <div class="status-item">
        <div class="status-dot idle" id="status-dot"></div>
        <span class="status-item__value" id="status-state">Ready</span>
      </div>
      <div class="status-item hide-mobile" id="status-system-item" style="display:none">
        <span class="status-item__label">Playing:</span>
        <span class="status-item__value" id="status-game">—</span>
      </div>
      <div class="status-item hide-mobile" id="status-system-label" style="display:none">
        <span class="status-item__value" id="status-system" style="opacity:0.55;font-size:0.72rem">—</span>
      </div>
      <div class="status-item hide-mobile" id="status-tier-item" style="display:none">
        <span class="status-item__value" id="status-tier">—</span>
      </div>
      <div class="status-item hide-mobile" style="margin-left:auto;gap:6px">
        ${_CTRL_SVG_MINI}
        <span class="status-item__value" style="opacity:0.4;font-size:0.7rem;font-weight:700;letter-spacing:0.01em">RetroVault</span>
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
  getTouchOverlay?:    () => TouchControlsOverlay | null;
  getNetplayManager?:  () => Promise<import("./multiplayer.js").NetplayManager>;
  /** Pre-existing NetplayManager instance — registers it as the singleton when provided (useful for tests). */
  netplayManager?:    import("./multiplayer.js").NetplayManager;
  canInstallPWA?:     () => boolean;
  onInstallPWA?:      () => Promise<boolean>;
}

export const RESTART_REQUIRED_EVENT = "retrovault:restart-required";

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

  const { emulator, library, biosLibrary, saveLibrary, settings, deviceCaps,
          onLaunchGame, onSettingsChange, onReturnToLibrary,
          onApplyPatch, onFileChosen,
          getCurrentGameId, getCurrentGameName, getCurrentSystemId,
          getTouchOverlay, canInstallPWA, onInstallPWA } = opts;

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

  const cleanupFns: Array<() => void> = [];
  const bindEvent = (
    target: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): void => {
    target.addEventListener(type, handler, options);
    cleanupFns.push(() => target.removeEventListener(type, handler, options));
  };

  _canInstallPWA = canInstallPWA;
  _onInstallPWA  = onInstallPWA;
  _openSettingsFn = (tab?: string) =>
    openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, getNetplayManager, tab as SettingsTab | undefined);

  /** Close the Multiplayer modal (if open) and jump to Play Together settings. */
  const openPlayTogetherSettings = () => {
    document.dispatchEvent(new CustomEvent("retrovault:closeEasyNetplay"));
    openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, getNetplayManager, "multiplayer");
  };

  // ── File drop / pick ──────────────────────────────────────────────────────
  const fileInput = el<HTMLInputElement>("#file-input");
  const dropZone  = el("#drop-zone");
  let dragDepth = 0;
  let dragOverActive = false;
  const openFilePicker = () => fileInput.click();
  const clearDragOver = () => {
    dragDepth = 0;
    if (!dragOverActive) return;
    dragOverActive = false;
    dropZone.classList.remove("drag-over");
  };

  const onFileInputChange = () => {
    const file = fileInput.files?.[0];
    if (file) void onFileChosen(file);
    fileInput.value = "";
  };
  bindEvent(fileInput, "change", onFileInputChange);

  const onDropZoneKeydown = (event: Event) => {
    const e = event as KeyboardEvent;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openFilePicker();
  };
  bindEvent(dropZone, "keydown", onDropZoneKeydown);
  bindEvent(dropZone, "click", () => openFilePicker());

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
      showError("Return to the library first (Esc or ← Library) before loading a new game.");
      return;
    }
    void onFileChosen(file);
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
    bindEvent(mobileFab, "click", () => fileInput.click());
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
    updateFPSOverlay(snapshot, emulator);
    updateDevOverlay(snapshot, emulator);
    updateDebugConsoleLog(emulator);
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
    document.title = `${name} — RetroVault`;
    const openSettingsWith = (tab?: SettingsTab) =>
      openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, getNetplayManager, tab);
    buildInGameControls(
      emulator, settings, onSettingsChange, onReturnToLibrary,
      saveLibrary, saveService, getCurrentGameId, getCurrentGameName, getCurrentSystemId,
      getTouchOverlay, openSettingsWith, getNetplayManager, openPlayTogetherSettings
    );
    showFPSOverlay(settings.showFPS, emulator, settings.showAudioVis);
    if (settings.touchControls) {
      const overlay = getTouchOverlay?.();
      if (overlay) overlay.show();
    }
    afterNextPaint(() => {
      hideLoadingOverlay();
      requestAnimationFrame(() => {
        // Hide FAB and show rotate-hint when appropriate
        mobileFab?.classList.add("mobile-fab--hidden");
        updateRotateHint();
        resetPerfSuggestion();
        document.dispatchEvent(new CustomEvent("retrovault:gameStarted"));
      });
    });
  };

  const onResumeGameEvent = () => {
    transitionToGame();
    const sys  = emulator.currentSystem;
    const name = settings.lastGameName ?? "Unknown";
    document.title = `${name} — RetroVault`;
    setStatusSystem(sys ? sys.shortName : "—");
    setStatusGame(name);
    const openSettingsWithResume = (tab?: SettingsTab) =>
      openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, getNetplayManager, tab);
    buildInGameControls(
      emulator, settings, onSettingsChange, onReturnToLibrary,
      saveLibrary, saveService, getCurrentGameId, getCurrentGameName, getCurrentSystemId,
      getTouchOverlay, openSettingsWithResume, getNetplayManager, openPlayTogetherSettings
    );
    showFPSOverlay(settings.showFPS, emulator, settings.showAudioVis);
    if (settings.touchControls) {
      const overlay = getTouchOverlay?.();
      if (overlay) overlay.show();
    }
    afterNextPaint(() => {
      requestAnimationFrame(() => {
        // Hide FAB and show rotate-hint when appropriate
        mobileFab?.classList.add("mobile-fab--hidden");
        updateRotateHint();
      });
    });
  };
  bindEvent(document, "retrovault:resumeGame", onResumeGameEvent);

  const rebuildInGameControls = () => {
    if (emulator.state !== "running" && emulator.state !== "paused") return;
    const openSettingsWith = (tab?: SettingsTab) =>
      openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, getNetplayManager, tab);
    buildInGameControls(
      emulator, settings, onSettingsChange, onReturnToLibrary,
      saveLibrary, saveService, getCurrentGameId, getCurrentGameName, getCurrentSystemId,
      getTouchOverlay, openSettingsWith, getNetplayManager, openPlayTogetherSettings
    );
  };
  bindEvent(document, TOUCH_CONTROLS_CHANGED_EVENT, rebuildInGameControls);

  // Ensure overlay work is paused while browsing the library.
  const onReturnToLibraryEvent = () => {
    showFPSOverlay(false);
    // Reveal the FAB and hide the rotate hint when back on the library page.
    mobileFab?.classList.remove("mobile-fab--hidden");
    updateRotateHint();
  };
  bindEvent(document, "retrovault:returnToLibrary", onReturnToLibraryEvent);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  // Register in the capture phase (third argument `true`) so our shortcuts
  // are processed before the EmulatorJS keydown handler (which listens on the
  // player element). Calling stopPropagation() here prevents F5/F7/F1/F9/Esc
  // from ever reaching EmulatorJS while all other keys (game controls) pass
  // through normally and are handled by EmulatorJS as expected.
  const onGlobalShortcutKeydown = (event: Event) => {
    const e = event as KeyboardEvent;
    if (
      ((e.key === "/" && !e.shiftKey) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) &&
      !_isEditableTarget(e.target) &&
      !document.querySelector(".confirm-overlay, .easy-netplay-overlay, #settings-panel:not([hidden]), #system-picker:not([hidden])")
    ) {
      if (_focusLibrarySearch()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    // F9 opens the Debug tab from anywhere (landing or in-game)
    if (e.key === "F9") {
      e.preventDefault();
      e.stopPropagation();
      openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, getNetplayManager, "debug");
      return;
    }
    // F3 toggles the developer debug overlay from anywhere
    if (e.key === "F3") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        toggleDebugConsole(emulator);
      } else {
        toggleDevOverlay();
      }
      return;
    }
    if (emulator.state !== "running") return;
    switch (e.key) {
      case "F5":
        e.preventDefault();
        e.stopPropagation();
        void saveService.saveSlot(1).then((entry) => {
          if (entry) showInfoToast("Saved to Slot 1");
          else showError("Quick save failed — add this game to your library or wait for the core to finish starting.");
        });
        break;
      case "F7":
        e.preventDefault();
        e.stopPropagation();
        void saveService.loadSlot(1).then((ok) => {
          if (ok) showInfoToast("Loaded Slot 1");
          else showError("Nothing saved in Slot 1 yet, or the emulator is still starting.");
        });
        break;
      case "F8":
        e.preventDefault();
        e.stopPropagation();
        void saveService.findNextSlot().then((slot) => {
          void saveService.saveSlot(slot).then((entry) => {
            if (entry) showInfoToast(`Saved to Slot ${slot}`);
            else showError("Save failed — wait for the core to finish starting.");
          });
        });
        break;
      case "F1":
        e.preventDefault();
        e.stopPropagation();
        void (async () => {
          const confirmed = await showConfirmDialog(
            "Unsaved progress will be lost.",
            { title: "Reset Game?", confirmLabel: "Reset", isDanger: true }
          );
          if (confirmed) emulator.reset();
        })();
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        // When a modal overlay is open, let its own capture-phase handler close it
        // rather than returning to the library (which would close the whole game).
        if (!document.querySelector(".confirm-overlay")) {
          onReturnToLibrary();
        }
        break;
    }
  };
  bindEvent(document, "keydown", onGlobalShortcutKeydown, { capture: true });

  // ── Landing header controls ───────────────────────────────────────────────
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
    // Abort any stale in-game controls AbortController so that window/document
    // keydown handlers registered by buildInGameControls are cleaned up too.
    _inGameControlsAc?.abort();
    _inGameControlsAc = null;
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
function buildLibraryHero(
  game: GameMetadata,
  library: GameLibrary,
  settings: Settings,
  onLaunchGame: (file: File, systemId: string, gameId?: string) => Promise<void>
): HTMLElement {
  const hero = make("div", { class: "library-hero" });
  const system = getSystemById(game.systemId);
  
  const bg = make("div", { class: "library-hero__bg" });
  bg.style.background = `radial-gradient(circle at 20% 30%, ${system?.color ?? "#8b5cf6"}44 0%, transparent 70%), 
                         linear-gradient(135deg, var(--c-surface) 0%, var(--c-bg) 100%)`;
  
  const content = make("div", { class: "library-hero__content" });
  
  const tag = make("div", { class: "library-hero__tag" }, "Continue Playing");
  const title = make("h2", { class: "library-hero__title" }, game.name);
  
  const meta = make("div", { class: "library-hero__meta" });
  const sysName = system?.shortName ?? game.systemId.toUpperCase();
  const iconOutput = systemIcon(game.systemId);
  const iconHtml = iconOutput.includes("/assets/") ? `<img src="${iconOutput}" alt="" class="hero-sys-icon" />` : iconOutput;
  meta.innerHTML = `<span>${iconHtml} ${sysName}</span> <span>🕒 ${game.lastPlayedAt ? `Played ${formatRelativeTime(game.lastPlayedAt)}` : "Never played"}</span>`;
  
  const actions = make("div", { class: "library-hero__actions" });
  const playBtn = make("button", { class: "btn--hero" });
  playBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Play Now`;
  playBtn.addEventListener("click", async () => {
    showLoadingOverlay();
    setLoadingMessage(`Starting ${game.name}…`);
    setLoadingSubtitle("Getting ready to play");
    try {
      let blob = await library.getGameBlob(game.id);
      if (!blob && game.cloudId) {
        setLoadingMessage("Streaming from cloud…");
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
  });
  
  actions.appendChild(playBtn);
  content.append(tag, title, meta, actions);
  hero.append(bg, content);
  
  return hero;
}

function buildLibraryRow(
  title: string,
  systemId: string | null,
  games: GameMetadata[],
  library: GameLibrary,
  settings: Settings,
  onLaunchGame: (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef?: PSPEmulator,
  onApplyPatch?: (gameId: string, patchFile: File) => Promise<void>,
  isScroll = true
): HTMLElement {
  const row = make("div", { class: "library-row" });
  
  const header = make("div", { class: "library-row__header" });
  if (systemId) {
    const iconOutput = systemIcon(systemId);
    const icon = make("span", { class: "library-row__icon-span" });
    if (iconOutput.includes("/assets/")) {
      icon.innerHTML = `<img src="${iconOutput}" alt="" class="row-sys-icon" />`;
    } else {
      icon.textContent = iconOutput;
    }
    const sys = getSystemById(systemId);
    if (sys) icon.style.color = sys.color;
    header.appendChild(icon);
  }
  header.appendChild(make("h3", { class: "library-row__title" }, title));
  
  const container = make("div", { class: isScroll ? "library-row__scroll" : "library-row__grid" });
  games.forEach(game => {
    const card = buildGameCard(game, library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    container.appendChild(card);
  });
  
  row.append(header, container);
  return row;
}

// ── Library rendering ─────────────────────────────────────────────────────────

type SortMode = "lastPlayed" | "name" | "added" | "system";

let _librarySearchQuery = "";
let _librarySortMode: SortMode = "lastPlayed";
let _librarySystemFilter = "";
let _libraryShowFavorites = false;
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
    const currentLayout = (layoutContainer as any)._lastLayout || "grid";
    layoutContainer.querySelectorAll(".layout-btn").forEach(btn => {
      const layout = btn.getAttribute("data-layout");
      btn.setAttribute("aria-checked", String(layout === currentLayout));
      btn.classList.toggle("active", layout === currentLayout);
    });
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

  countEl.textContent = allGames.length > 0
    ? `${allGames.length} game${allGames.length !== 1 ? "s" : ""}${displayed.length !== allGames.length ? ` · ${displayed.length} shown` : ""}`
    : "";

  libSection.classList.toggle("hidden-section", allGames.length === 0);
  dropZoneEl.classList.toggle("drop-zone--prominent", allGames.length === 0);
  dropZoneEl.classList.toggle("drop-zone--compact", allGames.length > 0);

  // Show/hide onboarding section
  const onboardingEl = document.getElementById("onboarding");
  const showOnboarding = allGames.length === 0;
  if (onboardingEl) {
    onboardingEl.classList.toggle("hidden-section", !showOnboarding);
    onboardingEl.setAttribute("aria-hidden", String(!showOnboarding));
  }

  if (emulatorRef && allGames.length > 0) {
    const systemIds = new Set(allGames.map(g => g.systemId));
    for (const sid of systemIds) { emulatorRef.prefetchCore(sid); }
  }

  grid.innerHTML = "";
  _libGpCachedCards = null;

  const layout = settings.libraryLayout;
  (document.getElementById("library-layouts") as any)._lastLayout = layout;
  _syncLibraryControlState();

  grid.className = `library-grid library-grid--${layout}`;

  const isCinematicMode = settings.libraryGrouped && !_librarySearchQuery && !_librarySystemFilter && !_libraryShowFavorites && _librarySortMode === "lastPlayed" && displayed.length >= 5;

  if (displayed.length === 0 && allGames.length > 0) {
    const empty = make("div", { class: "library-empty", role: "status", "aria-live": "polite" });
    const hasSearch = _librarySearchQuery.trim().length > 0;
    const activeSystem = _librarySystemFilter ? getSystemById(_librarySystemFilter)?.shortName ?? _librarySystemFilter.toUpperCase() : "";
    let message = "No games match your current filters.";
    if (hasSearch && activeSystem) {
      message = `No ${_escHtml(activeSystem)} games match "<em>${_escHtml(_librarySearchQuery)}</em>".`;
    } else if (hasSearch) {
      message = `No games match "<em>${_escHtml(_librarySearchQuery)}</em>".`;
    } else if (activeSystem) {
      message = `No games available for <em>${_escHtml(activeSystem)}</em>.`;
    }
    empty.innerHTML = `<p>${message} Try a broader search, choose another system, or clear filters to see every game again.</p>`;
    const resetBtn = make("button", { class: "btn library-empty__reset", type: "button" }, "Reset filters");
    resetBtn.addEventListener("click", () => {
      _resetLibraryFilters(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    });
    empty.appendChild(resetBtn);
    grid.appendChild(empty);
    return;
  }

  if (isCinematicMode && displayed.length > 0) {
    grid.classList.add("library-section__rows");
    
    // 1. Hero (Last Played)
    const lastPlayed = displayed[0]!;
    const hero = buildLibraryHero(lastPlayed, library, settings, onLaunchGame);
    hero.style.setProperty("--row-i", "0");
    hero.classList.add("library-hero--entering");
    grid.appendChild(hero);
    
    // 2. Continue Playing Row (Recent 2-6 excluding hero)
    const recent = displayed.slice(1, 7);
    if (recent.length > 0) {
      grid.appendChild(buildLibraryRow("Jump Back In", null, recent, library, settings, onLaunchGame, emulatorRef, onApplyPatch));
    }
    
    // 3. System Groups
    const systemIds = [...new Set(displayed.map(g => g.systemId))].sort();
    systemIds.forEach((sid, idx) => {
      const sysGames = displayed.filter(g => g.systemId === sid);
      if (sysGames.length > 0) {
        const sys = getSystemById(sid);
        const row = buildLibraryRow(sys?.name ?? sid.toUpperCase(), sid, sysGames, library, settings, onLaunchGame, emulatorRef, onApplyPatch);
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
      grid.appendChild(buildLibraryRow("Favorites", null, favorites, library, settings, onLaunchGame, emulatorRef, onApplyPatch, false));
      pool = pool.filter(g => !g.isFavorite);
    }

    const systemIds = [...new Set(pool.map(g => g.systemId))].sort();
    systemIds.forEach((sid) => {
      const sysGames = pool.filter(g => g.systemId === sid);
      if (sysGames.length > 0) {
        const sys = getSystemById(sid);
        grid.appendChild(buildLibraryRow(sys?.name ?? sid.toUpperCase(), sid, sysGames, library, settings, onLaunchGame, emulatorRef, onApplyPatch, false));
      }
    });
    return;
  }

  // Standard Grid Rendering
  grid.classList.remove("library-section__rows");
  
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
          setTimeout(processNext, 16);
        }
      }
    };
    
    if ("requestIdleCallback" in window) {
      (window as unknown as ExtendedWindow).requestIdleCallback(processNext, { timeout: 100 });
    } else {
      setTimeout(processNext, 32);
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

let _libraryControlsWired = false;

// ── Library keyboard / gamepad navigation ─────────────────────────────────────
let _libraryNavWired = false;
let _libraryGamepadRafId: number | null = null;
// Tracks per-axis/button state for gamepad repeat logic
let _libGpPrevAxes: number[] = [];
let _libGpPrevBtns: boolean[] = [];
let _libGpRepeatTimer = 0;
const _LIB_NAV_INITIAL_DELAY = 400; // ms before held-direction auto-repeat starts
const _LIB_NAV_REPEAT_RATE   = 150; // ms between repeats once held

/** Gamepad list matching EmulatorJS GamepadHandler (standard + legacy WebKit). */
function _getNavigatorGamepads(): (Gamepad | null)[] {
  if (typeof navigator.getGamepads === "function") {
    return [...navigator.getGamepads()];
  }
  if (typeof navigator.webkitGetGamepads === "function") {
    return [...navigator.webkitGetGamepads()];
  }
  return [];
}

/** Move focus among library game cards using arrow keys or gamepad. */
function _wireLibraryNavigation(): void {
  if (_libraryNavWired) return;
  _libraryNavWired = true;

  const grid = document.getElementById("library-grid");
  if (!grid) return;

  // ── Arrow key navigation on the grid container ────────────────────────────
  grid.addEventListener("keydown", (e: KeyboardEvent) => {
    const key = e.key;
    if (key !== "ArrowLeft" && key !== "ArrowRight" &&
        key !== "ArrowUp"   && key !== "ArrowDown"  &&
        key !== "Home"       && key !== "End") return;

    const cards = Array.from(grid.querySelectorAll<HTMLElement>(".game-card"));
    if (!cards.length) return;

    const focused = document.activeElement as HTMLElement | null;
    const idx = focused ? cards.indexOf(focused) : -1;
    if (idx === -1) return;

    e.preventDefault();

    let nextIdx = idx;
    if (key === "ArrowLeft") {
      nextIdx = Math.max(0, idx - 1);
    } else if (key === "ArrowRight") {
      nextIdx = Math.min(cards.length - 1, idx + 1);
    } else if (key === "Home") {
      nextIdx = 0;
    } else if (key === "End") {
      nextIdx = cards.length - 1;
    } else {
      // ArrowUp / ArrowDown — find closest card in the row above/below
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
      _safeScrollIntoView(cards[nextIdx]!, { block: "nearest", behavior: "smooth" });
    }
  });

  // ── Gamepad polling loop ──────────────────────────────────────────────────
  // Runs continuously but only acts when the landing page is visible.
  function _libGamepadTick(): void {
    _libraryGamepadRafId = requestAnimationFrame(_libGamepadTick);

    // Only navigate when the library landing is visible (not while a game runs)
    const landingEl = document.getElementById("landing");
    if (!landingEl || landingEl.classList.contains("hidden")) return;

    // Skip if a modal / overlay is open
    if (document.querySelector(".confirm-overlay")) return;

    const gp = _getNavigatorGamepads().find((g): g is Gamepad => g != null);
    if (!gp) return;

    const now = performance.now();

    // Read directional inputs (D-pad buttons 12–15 and left analogue stick)
    const rawUp    = (gp.buttons[12]?.pressed ?? false) || (gp.axes[1] ?? 0) < -0.5;
    const rawDown  = (gp.buttons[13]?.pressed ?? false) || (gp.axes[1] ?? 0) >  0.5;
    const rawLeft  = (gp.buttons[14]?.pressed ?? false) || (gp.axes[0] ?? 0) < -0.5;
    const rawRight = (gp.buttons[15]?.pressed ?? false) || (gp.axes[0] ?? 0) >  0.5;

    // Button 0 = Cross/A (launch), Button 1 = Circle/B (deselect)
    const btnA = gp.buttons[0]?.pressed ?? false;
    const btnB = gp.buttons[1]?.pressed ?? false;

    const prevBtnA = _libGpPrevBtns[0] ?? false;
    const prevBtnB = _libGpPrevBtns[1] ?? false;

    // Rising-edge detection for action buttons
    const pressedA = btnA && !prevBtnA;
    const pressedB = btnB && !prevBtnB;

    _libGpPrevBtns[0] = btnA;
    _libGpPrevBtns[1] = btnB;

    const anyDir = rawUp || rawDown || rawLeft || rawRight;

    // Determine whether this frame triggers a navigation step (rising edge or repeat)
    let doMove = false;
    if (anyDir) {
      if (_libGpPrevAxes[0] !== 1) {
        // First frame the direction was pressed → move immediately
        doMove = true;
        _libGpRepeatTimer = now + _LIB_NAV_INITIAL_DELAY;
      } else if (now >= _libGpRepeatTimer) {
        // Held long enough → auto-repeat
        doMove = true;
        _libGpRepeatTimer = now + _LIB_NAV_REPEAT_RATE;
      }
    }
    _libGpPrevAxes[0] = anyDir ? 1 : 0;

    const needCards = pressedA || pressedB || doMove;
    if (!needCards) return;

    if (!_libGpCachedCards) {
      _libGpCachedCards = Array.from(grid!.querySelectorAll<HTMLElement>(".game-card"));
    }
    const cards = _libGpCachedCards;

    if (pressedA && cards.length) {
      const focused = document.activeElement as HTMLElement | null;
      const idx = focused ? cards.indexOf(focused) : -1;
      if (idx !== -1) { cards[idx]!.click(); return; }
      // No card focused — focus & launch first card
      cards[0]!.focus();
      cards[0]!.click();
      return;
    }

    if (pressedB) {
      // Deselect / return focus to the search input
      const searchEl = document.getElementById("library-search") as HTMLInputElement | null;
      if (searchEl) searchEl.focus();
      return;
    }

    if (!doMove || !cards.length) return;

    const focused = document.activeElement as HTMLElement | null;
    const idx = focused ? cards.indexOf(focused) : -1;

    if (idx === -1) {
      // Nothing focused yet — focus the first card
      cards[0]!.focus();
      _safeScrollIntoView(cards[0]!, { block: "nearest", behavior: "smooth" });
      return;
    }

    let nextIdx = idx;
    if (rawLeft) {
      nextIdx = Math.max(0, idx - 1);
    } else if (rawRight) {
      nextIdx = Math.min(cards.length - 1, idx + 1);
    } else {
      // Up / Down — same column-detection logic as keyboard
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
      _safeScrollIntoView(cards[nextIdx]!, { block: "nearest", behavior: "smooth" });
    }
  }

  _libraryGamepadRafId = requestAnimationFrame(_libGamepadTick);
}

// Persists the last non-zero volume across buildInGameControls rebuilds (e.g.
// game resume) so mute/unmute restores the correct level after a re-render.
function _wireLibraryControls(
  _allGames: GameMetadata[],
  library: GameLibrary,
  settings: Settings,
  onLaunchGame: (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef?: PSPEmulator,
  onApplyPatch?: (gameId: string, patchFile: File) => Promise<void>
): void {
  if (_libraryControlsWired) return;
  const cloudOnboardingBtn = document.getElementById("btn-cloud-onboarding");
  if (cloudOnboardingBtn) {
    cloudOnboardingBtn.addEventListener("click", () => {
      _openSettingsFn?.("cloud");
    });
  }
  const addGameOnboardingBtn = document.getElementById("btn-add-game-onboarding");
  if (addGameOnboardingBtn) {
    addGameOnboardingBtn.addEventListener("click", () => {
      (document.getElementById("file-input") as HTMLInputElement | null)?.click();
    });
  }
  const addGameSecondaryBtn = document.getElementById("btn-add-game-secondary");
  if (addGameSecondaryBtn) {
    addGameSecondaryBtn.addEventListener("click", () => {
      (document.getElementById("file-input") as HTMLInputElement | null)?.click();
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

  if (searchEl) {
    searchEl.addEventListener("input", () => {
      _librarySearchQuery = searchEl.value;
      _syncLibraryControlState();
      _scheduleLibraryRender(library, settings, onLaunchGame, emulatorRef, onApplyPatch, 120);
    });
    searchEl.addEventListener("keydown", (event: KeyboardEvent) => {
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
        onSettingsChange({ libraryLayout: layout });
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
  const allChip = make("button", {
    class: `sys-filter-chip${_librarySystemFilter === "" ? " active" : ""}`,
    "aria-pressed": _librarySystemFilter === "" ? "true" : "false",
  }, "All");
  allChip.addEventListener("click", () => {
    _librarySystemFilter = "";
    _scheduleLibraryRender(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
  });
  filterEl.appendChild(allChip);

  for (const sysId of systemIds) {
    const sys  = getSystemById(sysId);
    const chip = make("button", {
      class: `sys-filter-chip${_librarySystemFilter === sysId ? " active" : ""}`,
      "aria-pressed": _librarySystemFilter === sysId ? "true" : "false",
    }, sys?.shortName ?? sysId);
    if (sys) chip.style.setProperty("--chip-color", sys.color);
    chip.addEventListener("click", () => {
      _librarySystemFilter = _librarySystemFilter === sysId ? "" : sysId;
      _scheduleLibraryRender(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    });
    filterEl.appendChild(chip);
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

  // A game is considered "new" for 24 hours after it is added to the library.
  const NEW_THRESHOLD_MS = 24 * 60 * 60 * 1000;
  const isNew = Date.now() - game.addedAt < NEW_THRESHOLD_MS;

  const ariaLabel = isNew
    ? `New game: Play ${game.name} (${system?.shortName ?? game.systemId})`
    : `Play ${game.name} (${system?.shortName ?? game.systemId})`;
  const card = make("div", { class: "game-card", role: "button", tabindex: "0", "aria-label": ariaLabel });
  if (isNew) card.classList.add("game-card--new");
  card.style.setProperty("--sys-color", system?.color ?? "#555");

  const icon = make("div", { class: "game-card__icon" });
  icon.setAttribute("aria-hidden", "true");
  icon.style.background = `linear-gradient(135deg, ${system?.color ?? "#555"}33, ${system?.color ?? "#555"}11)`;

  const iconOutput = systemIcon(game.systemId);
  if (iconOutput.includes("/assets/")) {
    icon.innerHTML = `<img src="${iconOutput}" alt="" class="sys-icon-img" />`;
  } else {
    icon.textContent = iconOutput;
  }

  if (game.cloudId) {
    const cloudBadge = make("div", { class: "game-card__cloud-badge", title: "Cloud Stream" }, "☁");
    icon.appendChild(cloudBadge);
  }

  if (isNew) {
    const newBadge = make("div", { class: "game-card__new-badge", "aria-hidden": "true" }, "NEW");
    icon.appendChild(newBadge);
  }

  const info = make("div", { class: "game-card__info" });
  const name = make("div", { class: "game-card__name" }, game.name);
  const meta = make("div", { class: "game-card__meta" });
  const badge = make("span", { class: "sys-badge" }, system?.shortName ?? game.systemId);
  badge.style.background = system?.color ?? "#555";
  const size = make("span", { class: "game-card__size" }, formatBytes(game.size));
  meta.append(badge, size);
  if (system?.experimental) {
    meta.append(make("span", { class: "sys-badge sys-badge--experimental", title: system.stabilityNotice ?? "Experimental support" }, "EXP"));
  }

  const featureRow = buildSystemFeatureRow(system, { includeExperimental: false, max: 3, includeOnline: true });
  const played = make("div", { class: "game-card__played" },
    game.lastPlayedAt
      ? `Played ${formatRelativeTime(game.lastPlayedAt)}`
      : `Added ${formatRelativeTime(game.addedAt)}`
  );
  if (!game.lastPlayedAt && isNew) played.classList.add("game-card__played--fresh");

  info.append(name, meta);
  if (featureRow) info.append(featureRow);
  info.append(played);

  const btnRemove = make("button", {
    class: "game-card__remove",
    title: "Remove from library",
    "aria-label": `Remove ${game.name}`,
  }, "✕");
  btnRemove.addEventListener("click", async (e) => {
    e.stopPropagation();
    const confirmed = await showConfirmDialog(
      `"${game.name}" will be removed from your library. The file will not be deleted from your device.`,
      { title: "Remove Game", confirmLabel: "Remove", isDanger: true }
    );
    if (!confirmed) return;
    await library.removeGame(game.id);
    showInfoToast(`"${game.name}" removed from library.`, "info");
    void renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
  });

  const btnFav = make("button", {
    class: `game-card__fav${game.isFavorite ? " active" : ""}`,
    title: game.isFavorite ? "Remove from favorites" : "Add to favorites",
    "aria-label": game.isFavorite ? `Remove ${game.name} from favorites` : `Add ${game.name} to favorites`,
  }, "★");
  btnFav.addEventListener("click", async (e) => {
    e.stopPropagation();
    const next = !game.isFavorite;
    await library.setFavorite(game.id, next);
    game.isFavorite = next;
    btnFav.classList.toggle("active", next);
    btnFav.title = next ? "Remove from favorites" : "Add to favorites";
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
    }, "⊕") as HTMLButtonElement;

    btnPatch.addEventListener("click", (e) => { e.stopPropagation(); patchInput!.click(); });
    patchInput.addEventListener("change", async () => {
      const patchFile = patchInput!.files?.[0];
      if (!patchFile) return;
      patchInput!.value = "";
      try {
        showLoadingOverlay();
        setLoadingMessage(`Applying patch to ${game.name}…`);
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
  }, "⟳");

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
  const playBtn     = make("div", { class: "game-card__play-btn" }, "▶");
  playOverlay.appendChild(playBtn);

  card.append(icon, info);
  if (patchInput && btnPatch) card.append(patchInput, btnPatch);
  card.append(btnChangeSystem, btnFav, btnRemove, playOverlay);

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
    setLoadingMessage(`Starting ${game.name}…`);
    setLoadingSubtitle("Getting ready to play");
    try {
      let blob = await library.getGameBlob(game.id);
      if (!blob && game.cloudId) {
        setLoadingMessage("Streaming from cloud…");
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

  card.addEventListener("click", launch);
  card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void launch(); } });

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
  if (includeOnline && NETPLAY_SUPPORTED_SYSTEM_IDS.includes(system.id as typeof NETPLAY_SUPPORTED_SYSTEM_IDS[number])) {
    pills.push({
      label: "Online",
      title: `${system.name} supports RetroVault online play.`,
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

  const icons: Record<string, string> = {
    psp: "🎮", nes: "🕹", snes: "🕹", gba: "🎯", gbc: "🟢", gb: "⬜",
    nds: "📱", n64: "🎮", psx: "🔵", segaMD: "⚡", segaGG: "🔶",
    segaMS: "📺", atari2600: "👾", arcade: "🕹", segaSaturn: "💫",
    segaDC: "🌀", mame2003: "🕹", atari7800: "👾", lynx: "📟", ngp: "🔴",
  };
  return icons[systemId] ?? "🎮";
}


function _escHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return c;
    }
  });
}

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const OVERLAY_FADE_DELAY_MS = 200;
const PERF_SUGGESTION_FADE_DELAY_MS = 300;
const TOAST_REMOVE_DELAY_MS = 400;

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


// ── System picker modal ───────────────────────────────────────────────────────

function pickSystem(fileName: string, candidates: SystemInfo[], subtitleText?: string): Promise<SystemInfo | null> {
  return pickSystemImpl(fileName, candidates, subtitleText);
}

// ── Resolve system then add to library and launch ─────────────────────────────

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

function fileExt(fileName: string): string {
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx >= fileName.length - 1) return "";
  return fileName.substring(dotIdx + 1).toLowerCase();
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
  if (settings.verboseLogging) console.info(`[RetroVault] ${message}`);
}

function logImportWarn(
  emulatorRef: PSPEmulator | undefined,
  settings: Settings,
  message: string,
): void {
  emulatorRef?.logDiagnostic("error", `Import: ${message}`);
  if (settings.verboseLogging) console.warn(`[RetroVault] ${message}`);
}

// ── Import retry helpers ───────────────────────────────────────────────────────

/** Maximum automatic retry attempts for transient import errors. */
const IMPORT_MAX_ATTEMPTS = 3;
/** Base delay (ms) between auto-retry attempts; multiplied by attempt index for backoff. */
const IMPORT_RETRY_BASE_DELAY_MS = 300;

/**
 * Returns true when the error is likely transient and worth retrying automatically.
 * Quota / storage exhaustion errors are excluded — those require user action.
 */
export function isTransientImportError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  // Quota exceeded is permanent until the user frees space — do not auto-retry.
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
  /** Called before each retry (attempt ≥ 2). Receives the 1-based attempt index and last error. */
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
    `Received file "${file.name}" (${(file.size / 1024 / 1024).toFixed(1)} MB)`,
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
    setLoadingMessage(`Opening ${archiveFormat.toUpperCase()} archive…`);
    setLoadingSubtitle("Extracting game files — this may take a moment");
    logImport(
      emulatorRef,
      settings,
      `Starting ${archiveFormat.toUpperCase()} extraction`,
    );

    try {
      // Mobile file pickers (ext === "") strip extensions, so the file was
      // detected purely by magic bytes.  For that path we call extractFromZip
      // directly — it has no progress API but the extraction is lightweight.
      // Named-extension ZIPs go through extractFromArchive to get progress
      // callbacks and multi-candidate support.
      const extracted = archiveFormat === "zip" && ext === ""
        ? await archiveModule.extractFromZip(file).then(r => r ? { ...r, format: "zip" as const } : null)
        : await archiveModule.extractFromArchive(file, {
            onProgress: (progress) => {
              setLoadingMessage(formatArchiveProgressMessage(progress));
              if (progress.percent != null) setLoadingProgress(progress.percent);
            },
          });

      if (extracted) {
        const extractedCandidates = extracted.candidates ?? [];
        if (extractedCandidates.length > 1) {
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
          setLoadingMessage("File selected — detecting game system…");
          setLoadingSubtitle("");
          logImport(
            emulatorRef,
            settings,
            `Archive entry selected: "${picked.name}" (${formatBytes(picked.size)})`,
          );
        } else {
          resolvedFile = new File([extracted.blob!], extracted.name, { type: extracted.blob!.type });
        }
        setLoadingMessage("Detecting game system…");
        setLoadingSubtitle("");
        logImport(
          emulatorRef,
          settings,
          `${extracted.format.toUpperCase()} extraction succeeded: "${resolvedFile.name}" ` +
          `(${(resolvedFile.size / 1024 / 1024).toFixed(1)} MB)`,
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
    // Keep going — this may still be a native package for arcade cores.
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
        `See Settings → ❓ Help for the full list of supported formats.`
      );
      return;
    }
  } else if (Array.isArray(detected)) {
    hideLoadingOverlay();
    system = await pickSystem(resolvedFile.name, detected);
    if (!system) return;
  } else {
    // Single system detected — do not hide the overlay here.
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
      setLoadingMessage(`Starting ${existing.name}…`);
      setLoadingSubtitle("Getting ready to play");
      try {
        let blob = existing.blob;
        if (!blob && existing.cloudId) {
          setLoadingSubtitle(`Downloading from ${existing.cloudId}…`);
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
  setLoadingMessage("Saving game to library…");
  setLoadingSubtitle("This only takes a moment the first time");

  try {
    const entry = await withRetry(
      () => library.addGame(resolvedFile, system.id),
      {
        isRetryable: isTransientImportError,
        onRetry: (attempt, _err) => {
          setLoadingMessage(`Saving game to library… (retry ${attempt})`);
          logImportWarn(
            emulatorRef,
            settings,
            `library.addGame failed on attempt ${attempt}; retrying…`,
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
    setLoadingMessage(`Starting ${entry.name}…`);
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
    setLoadingMessage(`Applying patch to ${chosen.name}…`);
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
    setLoadingMessage("Storing disc images…");
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
    setLoadingMessage("Preparing multi-disc game…");
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
    // safe once the game has started — the emulator holds the data, not the URL.
    const revokeOnReturn = () => { blobUrls.forEach(u => URL.revokeObjectURL(u)); };
    document.addEventListener("retrovault:returnToLibrary", revokeOnReturn, { once: true });
  } catch (err) {
    hideLoadingOverlay();
    showError(`Multi-disc launch failed: ${err instanceof Error ? err.message : String(err)}`);
    // Revoke immediately on thrown launch errors.
    blobUrls.forEach(u => URL.revokeObjectURL(u));
  }
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
    const label = deviceCaps.isChromOS ? "⚡ Chromebook" : "⚡ Low-spec";
    const tip   = deviceCaps.isChromOS ? "Chromebook detected — Performance mode recommended" : "Performance mode recommended for this device";
    container.appendChild(make("span", { class: "perf-chip perf-chip--warn", title: tip }, label));
  }

  const btnSettings = make("button", { class: "btn", title: "Settings (F9)", "aria-label": "Open settings" });
  btnSettings.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg> Settings <kbd style="font-size:0.7em;opacity:0.5;margin-left:2px">F9</kbd>`;

  btnSettings.addEventListener("click", () => {
    openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulatorRef, onLaunchGame, saveLibrary, getNetplayManager);
  });

  const btnHelp = make("button", {
    class: "btn",
    title: "Getting started guide and keyboard shortcuts",
    "aria-label": "Open help and getting started guide",
  });
  btnHelp.textContent = "❓ Help";
  btnHelp.addEventListener("click", () => {
    openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulatorRef, onLaunchGame, saveLibrary, getNetplayManager, "about");
  });

  const btnMultiplayer = make("button", {
    class: "btn btn--highlight",
    title: "Open Play Together — Host or join a game with friends",
    "aria-label": "Open Play Together",
  }) as HTMLButtonElement;
  btnMultiplayer.innerHTML = `<img src="${resolveAssetUrl("assets/netplay_icon_premium_1775434064140.png")}" width="18" height="18" style="vertical-align:middle;margin-right:6px" /> Play Together`;
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
      void getNetplayManager().then(openWith);
    }
  });

  container.appendChild(btnSettings);
  container.appendChild(btnHelp);
  container.appendChild(btnMultiplayer);
  updateHeaderOverflow();
}

let _inGameControlsAc: AbortController | null = null;

function buildInGameControls(
  emulator:           PSPEmulator,
  settings:           Settings,
  onSettingsChange:   (patch: Partial<Settings>) => void,
  onReturnToLibrary:  () => void,
  saveLibrary?:       SaveStateLibrary,
  saveService?:       SaveGameService,
  getCurrentGameId?:  () => string | null,
  getCurrentGameName?: () => string | null,
  getCurrentSystemId?: () => string | null,
  getTouchOverlay?:   (() => TouchControlsOverlay | null) | undefined,
  onOpenSettings?:    (tab?: SettingsTab) => void,
  getNetplayManager?: () => Promise<import("./multiplayer.js").NetplayManager>,
  onOpenPlayTogetherSettings?: () => void,
): void {
  const container = el("#header-actions");
  container.innerHTML = "";
  const currentGameName = getCurrentGameName?.()?.trim() || settings.lastGameName?.trim() || "Unknown";
  const currentSystemId = getCurrentSystemId?.() ?? null;
  const currentSystemInfo = currentSystemId ? getSystemById(currentSystemId) : null;
  const touchControlsEnabled = currentSystemId
    ? (settings.touchControlsBySystem[currentSystemId] ?? (currentSystemInfo?.touchControlMode === "builtin" ? false : settings.touchControls))
    : settings.touchControls;

  const nowPlayingChip = make("div", {
    class: "now-playing-chip header-priority-chip",
    role: "status",
    "aria-live": "polite",
    "aria-label": `Now playing ${currentGameName}`,
  });
  nowPlayingChip.textContent = `Now playing · ${currentGameName}`;
  container.append(nowPlayingChip);

  if (_inGameControlsAc) {
    _inGameControlsAc.abort();
  }
  _inGameControlsAc = new AbortController();
  const signal = _inGameControlsAc.signal;

  // ── Quick Save button ──────────────────────────────────────────────────────
  if (saveService) {
    const btnSave = make("button", {
      class: "btn header-priority-optional",
      title: "Quick save (F5)",
      "aria-label": "Quick save to slot 1",
    }) as HTMLButtonElement;
    btnSave.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`;
    btnSave.addEventListener("click", () => {
      void saveService.saveSlot(1).then((entry) => {
        if (entry) showInfoToast("Saved to Slot 1");
        else showError("Quick save failed — add this game to your library or wait for the core to finish starting.");
      });
    }, { signal });
    container.append(btnSave);
  }

  // ── Quick Load button ──────────────────────────────────────────────────────
  if (saveService) {
    const btnLoad = make("button", {
      class: "btn header-priority-optional",
      title: "Quick load (F7)",
      "aria-label": "Quick load from slot 1",
    }) as HTMLButtonElement;
    btnLoad.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 15v4c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>`;
    btnLoad.addEventListener("click", () => {
      void saveService.loadSlot(1).then((ok) => {
        if (ok) showInfoToast("Loaded Slot 1");
        else showError("Nothing saved in Slot 1 yet, or the emulator is still starting.");
      });
    }, { signal });
    container.append(btnLoad);
  }

  // ── Save Gallery button ────────────────────────────────────────────────────
  const btnGallery = make("button", {
    class: "btn header-priority-secondary",
    title: "Save slots",
    "aria-label": "Open save state gallery",
  }) as HTMLButtonElement;
  btnGallery.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`;
  btnGallery.addEventListener("click", () => {
    if (!getCurrentGameId?.()) {
      showInfoToast("Add this game to your library to use save states.", "info");
      return;
    }
    void showInGameMenu({
      emulator, settings, onSettingsChange, onReturnToLibrary,
      saveLibrary, saveService, getCurrentGameId, getCurrentGameName,
      getCurrentSystemId, getTouchOverlay, onOpenSettings,
      getNetplayManager, onOpenPlayTogetherSettings,
    });
  }, { signal });
  container.append(btnGallery);

  // ── Netplay button ─────────────────────────────────────────────────────────
  if (onOpenSettings || getNetplayManager) {
    const currentSys = getCurrentSystemId?.() ?? null;
    const nm = peekNetplayManager();
    const isSupported = currentSys != null && NETPLAY_SUPPORTED_SYSTEM_IDS.includes(
      currentSys as typeof NETPLAY_SUPPORTED_SYSTEM_IDS[number]
    );
    const isActive = (nm?.isActive === true) || (settings.netplayEnabled && settings.netplayServerUrl.trim().length > 0);
    const btnNetplay = make("button", {
      class: isActive ? "btn btn--active header-priority-secondary" : "btn header-priority-secondary",
      title: isSupported ? "Online multiplayer" : "Multiplayer not available for this system",
      "aria-label": "Open Play Together",
    }) as HTMLButtonElement;
    btnNetplay.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> Online`;
    // Enable button whenever multiplayer is supported for this system
    btnNetplay.disabled = !isSupported;
    btnNetplay.addEventListener("click", () => {
      if (getNetplayManager) {
        void getNetplayManager().then(nm => {
          openEasyNetplayModal({
            netplayManager: nm,
            currentGameName:  getCurrentGameName?.() ?? null,
            currentGameId:    getCurrentGameId?.() ?? null,
            currentSystemId:  getCurrentSystemId?.() ?? null,
            onOpenPlayTogetherSettings,
          });
        });
      }
    }, { signal });
    container.append(btnNetplay);
  }

  // ── Touch controls edit/reset buttons (touch devices only) ───────────────────
  if (isTouchDevice()) {
    const btnEditTouch = make("button", {
      class: "btn header-priority-optional",
      title: "Edit touch control layout",
      "aria-label": "Edit touch control layout",
    }) as HTMLButtonElement;
    btnEditTouch.textContent = "🎮 Edit";
    btnEditTouch.disabled = !touchControlsEnabled;
    btnEditTouch.addEventListener("click", () => {
      const overlay = getTouchOverlay?.();
      if (overlay) {
        overlay.setEditing(true);
        btnResetTouch.style.display = "";
      }
    }, { signal });

    const btnResetTouch = make("button", {
      class: "btn header-priority-optional",
      title: "Reset touch control layout to defaults",
      "aria-label": "Reset touch control layout",
    }) as HTMLButtonElement;
    btnResetTouch.textContent = "Reset Layout";
    btnResetTouch.style.display = "none";
    btnResetTouch.addEventListener("click", () => {
      const overlay = getTouchOverlay?.();
      if (overlay) overlay.resetToDefaults();
    }, { signal });

    container.append(btnEditTouch, btnResetTouch);
  }

  // ── Reset button ─────────────────────────────────────────────────────────────
  const btnReset = make("button", {
    class: "btn btn--warn header-priority-secondary",
    title: "Reset emulator (F1)",
    "aria-label": "Reset emulator",
  }) as HTMLButtonElement;
  btnReset.textContent = "↺ Reset";
  btnReset.addEventListener("click", async () => {
    const confirmed = await showConfirmDialog(
      "This will restart the game from the beginning. Unsaved progress will be lost.",
      { title: "Reset Game?", confirmLabel: "Reset", isDanger: true },
    );
    if (confirmed) emulator.reset();
  }, { signal });
  container.append(btnReset);

  // ── Menu button ─────────────────────────────────────────────────────────────
  const btnMenu = make("button", {
    class: "btn btn--gradient header-priority-primary",
    title: "Open Menu (Esc)",
    "aria-label": "Open Menu",
    "data-tooltip": "Open Menu (Esc)",
  });
  btnMenu.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg> Menu`;
  btnMenu.addEventListener("click", () => {
    void showInGameMenu({
      emulator, settings, onSettingsChange, onReturnToLibrary,
      saveLibrary, saveService, getCurrentGameId, getCurrentGameName,
      getCurrentSystemId, getTouchOverlay, onOpenSettings,
      getNetplayManager, onOpenPlayTogetherSettings
    });
  }, { signal });

  container.append(btnMenu);

  // Global Esc listener for quick menu access
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && emulator.state === "running") {
      e.preventDefault();
      void showInGameMenu({
        emulator, settings, onSettingsChange, onReturnToLibrary,
        saveLibrary, saveService, getCurrentGameId, getCurrentGameName,
        getCurrentSystemId, getTouchOverlay, onOpenSettings,
        getNetplayManager, onOpenPlayTogetherSettings
      });
    }
  };
  window.addEventListener("keydown", onKeyDown, { signal });

  // Clean up listener when returning to library
  document.addEventListener("retrovault:returnToLibrary", () => {
    _inGameControlsAc?.abort();
    _inGameControlsAc = null;
  }, { once: true, signal });
}

/**
 * Premium glassmorphic in-game overlay menu.
 */
async function showInGameMenu(ctx: {
  emulator: PSPEmulator;
  settings: Settings;
  onSettingsChange: (patch: Partial<Settings>) => void;
  onReturnToLibrary: () => void;
  saveLibrary?: SaveStateLibrary;
  saveService?: SaveGameService;
  getCurrentGameId?: () => string | null;
  getCurrentGameName?: () => string | null;
  getCurrentSystemId?: () => string | null;
  getTouchOverlay?: () => TouchControlsOverlay | null;
  onOpenSettings?: (tab?: SettingsTab) => void;
  getNetplayManager?: () => Promise<import("./multiplayer.js").NetplayManager>;
  onOpenPlayTogetherSettings?: () => void;
  getCurrentCoreOptions?: () => Record<string, string>;
  onUpdateCoreOption?: (key: string, value: string) => void;
}): Promise<void> {
  if (ctx.emulator.state === "running") ctx.emulator.pause?.();

  const ac = new AbortController();
  const signal = ac.signal;

  const overlay = make("div", { class: "ingame-menu-overlay", role: "dialog", "aria-modal": "true", "aria-label": "In-Game Menu" });
  document.body.appendChild(overlay);

  // Transition in
  requestAnimationFrame(() => overlay.classList.add("ingame-menu-overlay--visible"));

  const gameId = ctx.getCurrentGameId?.() ?? "";
  const gameName = ctx.getCurrentGameName?.() ?? "Unknown Game";
  const systemId = ctx.getCurrentSystemId?.() ?? "unknown";
  const systemInfo = getSystemById(systemId);
  const systemDisplayName = systemInfo?.shortName ?? systemId.toUpperCase();

  const closeMenu = () => {
    overlay.classList.remove("ingame-menu-overlay--visible");
    setTimeout(() => {
      overlay.remove();
      ac.abort();
      if (ctx.emulator.state === "paused") ctx.emulator.resume();
    }, 400);
  };

  const menu = make("div", { class: "ingame-menu" });
  overlay.appendChild(menu);

  // Sidebar
  const sidebar = make("div", { class: "ingame-menu__sidebar" });
  sidebar.innerHTML = `<div class="ingame-menu__sidebar-title">Vault Menu</div>`;
  menu.appendChild(sidebar);

  const content = make("div", { class: "ingame-menu__content" });
  menu.appendChild(content);

  const renderContent = async (type: "saves" | "settings" | "multiplayer") => {
    content.innerHTML = "";
    
    // Update sidebar active state
    sidebar.querySelectorAll(".ingame-menu__sidebar-btn").forEach(b => b.classList.remove("ingame-menu__sidebar-btn--active"));
    const activeBtn = sidebar.querySelector(`[data-tab="${type}"]`);
    if (activeBtn) activeBtn.classList.add("ingame-menu__sidebar-btn--active");

    const header = make("div", { class: "ingame-menu__header" });
    header.innerHTML = `
      <div class="ingame-menu__header-main">
        ${systemInfo?.iconUrl ? `<img src="${systemInfo.iconUrl}" class="ingame-menu__system-icon" alt="" />` : ""}
        <div class="ingame-menu__header-text">
          <h2 class="ingame-menu__game-name">${_escHtml(gameName)}</h2>
          <span class="ingame-menu__system-tag">${systemDisplayName}</span>
        </div>
      </div>
    `;
    content.appendChild(header);

    const body = make("div", { class: "ingame-menu__body" });
    content.appendChild(body);

    if (type === "saves") {
      // Cloud save bar
      body.appendChild(buildCloudSaveBar());

      const statesResult = ctx.saveLibrary ? await ctx.saveLibrary.getStatesForGame(gameId) : [];
      const states = Array.isArray(statesResult) ? statesResult : [];
      const slots = Array.from({ length: 8 }, (_, i) => i + 1);

      const slotCountEl = make("span", { class: "ingame-menu__saves-count" }, `${states.length}/8 used`);
      header.querySelector(".ingame-menu__header-main")?.appendChild(slotCountEl);

      const grid = make("div", { class: "ingame-menu__saves-grid" });
      body.appendChild(grid);

      for (const slotIdx of slots) {
        const entry = states.find(s => s.slot === slotIdx);
        const card = make("div", { class: `ingame-menu__save-card ${entry ? "has-data" : "is-empty"}`, title: entry ? "" : "Empty Slot" });
        
        let thumbHtml = `<div class="ingame-menu__save-thumb-placeholder"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7"/><polyline points="16 5 21 5 21 10"/><line x1="12" y1="12" x2="21" y2="3"/></svg></div>`;
        if (entry?.thumbnail) {
          const url = URL.createObjectURL(entry.thumbnail);
          thumbHtml = `<img src="${url}" class="ingame-menu__save-thumb" alt="Slot ${slotIdx}" />`;
          // Cleanup on abort
          signal.addEventListener("abort", () => URL.revokeObjectURL(url), { once: true });
        }

        card.innerHTML = `
          <div class="ingame-menu__save-visual">
            ${thumbHtml}
            <div class="ingame-menu__save-badge">Slot ${slotIdx}</div>
            <span class="ingame-menu__save-busy" aria-hidden="true"></span>
          </div>
          <div class="ingame-menu__save-details">
            <div class="ingame-menu__save-label">${entry ? _escHtml(entry.label) : "Empty Slot"}</div>
            <div class="ingame-menu__save-time">${entry ? formatRelativeTime(entry.timestamp) : "No data saved"}</div>
          </div>
          <div class="ingame-menu__save-overlay">
            <button class="ingame-menu__save-action-btn btn-save" title="Save to this slot">Save</button>
            ${entry ? `<button class="ingame-menu__save-action-btn btn-load" title="Restore this save state">Load</button><button class="ingame-menu__save-action-btn btn-rename" title="Rename this slot" aria-label="Rename Slot ${slotIdx}"></button><button class="ingame-menu__save-action-btn btn-delete" title="Delete this save" aria-label="Delete Slot ${slotIdx}"></button>` : ""}
          </div>
        `;

        const busyEl = card.querySelector(".ingame-menu__save-busy") as HTMLElement | null;
        
        card.querySelector(".btn-save")?.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (ctx.saveService) {
            busyEl?.classList.add("active");
            try {
              const result = await ctx.saveService.saveSlot(slotIdx);
              if (result) {
                showInfoToast(`Saved to Slot ${slotIdx}`, "success");
                void renderContent("saves");
              } else {
                showError("Save failed — the emulator may still be starting up, or the game state is unavailable. Please try again.");
              }
            } finally {
              busyEl?.classList.remove("active");
            }
          }
        }, { signal });

        card.querySelector(".btn-load")?.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (ctx.saveService) {
            busyEl?.classList.add("active");
            try {
              const ok = await ctx.saveService.loadSlot(slotIdx);
              if (ok) {
                showInfoToast(`Loaded Slot ${slotIdx}`, "success");
                closeMenu();
              }
            } finally {
              busyEl?.classList.remove("active");
            }
          }
        }, { signal });

        card.querySelector(".btn-delete")?.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (!ctx.saveService) return;
          const confirmed = await showConfirmDialog(
            `Permanently delete Slot ${slotIdx}${entry?.label ? ` \"${entry.label}\"` : ""}? This cannot be undone.`,
            { title: "Delete Save?", confirmLabel: "Delete", isDanger: true }
          );
          if (!confirmed) return;
          const ok = await ctx.saveService.deleteSlot(slotIdx);
          if (ok) {
            showInfoToast(`Deleted Slot ${slotIdx}`, "info");
            void renderContent("saves");
          }
        }, { signal });

        card.querySelector(".btn-rename")?.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (!ctx.saveService || !entry || !ctx.saveLibrary) return;
          const labelEl = card.querySelector(".ingame-menu__save-label") as HTMLElement | null;
          if (!labelEl) return;

          const currentLabel = entry.label;
          const input = document.createElement("input");
          input.type = "text";
          input.value = currentLabel;
          input.className = "ingame-menu__save-rename-input";
          input.setAttribute("aria-label", `New name for Slot ${slotIdx}`);
          input.maxLength = 40;

          labelEl.replaceWith(input);
          input.focus();
          input.select();

          const finish = async () => {
            const newLabel = input.value.trim();
            await ctx.saveLibrary!.updateStateLabel(gameId, slotIdx, newLabel);
            void renderContent("saves");
          };

          input.addEventListener("blur", finish, { once: true, signal });
          input.addEventListener("keydown", (ke) => {
            if (ke.key === "Enter") { ke.preventDefault(); input.blur(); }
            if (ke.key === "Escape") { ke.preventDefault(); input.value = currentLabel; input.blur(); }
          }, { signal });
        }, { signal });

        grid.appendChild(card);
      }
    } 
    else if (type === "settings") {
      const grid = make("div", { class: "ingame-menu__settings-grid" });
      body.appendChild(grid);

      // Volume
      const volRow = make("div", { class: "ingame-menu__setting-item" });
      volRow.innerHTML = `
        <div class="ingame-menu__setting-info">
          <div class="ingame-menu__setting-name">Master Volume</div>
        </div>
        <div class="ingame-menu__setting-control">
          <input type="range" class="ingame-menu__range" min="0" max="1" step="0.05" value="${ctx.settings.volume}" />
          <span class="ingame-menu__range-val">${Math.round(ctx.settings.volume * 100)}%</span>
        </div>
      `;
      const volInp = volRow.querySelector("input") as HTMLInputElement;
      const volVal = volRow.querySelector(".ingame-menu__range-val")!;
      volInp.addEventListener("input", () => {
        const v = parseFloat(volInp.value);
        volVal.textContent = `${Math.round(v * 100)}%`;
        ctx.onSettingsChange({ volume: v });
        ctx.emulator.setVolume(v);
      }, { signal });
      grid.appendChild(volRow);

      // FPS Toggle
      const fpsRow = make("div", { class: "ingame-menu__setting-item" });
      fpsRow.innerHTML = `
        <div class="ingame-menu__setting-info">
          <div class="ingame-menu__setting-name">Show FPS Counter</div>
        </div>
        <div class="ingame-menu__setting-control">
          <button class="ingame-menu__toggle ${ctx.settings.showFPS ? "on" : "off"}">${ctx.settings.showFPS ? "Enabled" : "Disabled"}</button>
        </div>
      `;
      const fpsBtn = fpsRow.querySelector("button")!;
      fpsBtn.addEventListener("click", () => {
        const v = !ctx.settings.showFPS;
        ctx.onSettingsChange({ showFPS: v });
        ctx.emulator.setFPSMonitorEnabled(v);
        showFPSOverlay(v, ctx.emulator, ctx.settings.showAudioVis);
        fpsBtn.className = `ingame-menu__toggle ${v ? "on" : "off"}`;
        fpsBtn.textContent = v ? "Enabled" : "Disabled";
      }, { signal });
      grid.appendChild(fpsRow);

      // Performance Mode
      const perfRow = make("div", { class: "ingame-menu__setting-item" });
      perfRow.innerHTML = `
        <div class="ingame-menu__setting-info">
          <div class="ingame-menu__setting-name">Performance Profile</div>
        </div>
        <div class="ingame-menu__setting-control">
          <select class="ingame-menu__select">
            <option value="auto" ${ctx.settings.performanceMode === "auto" ? "selected" : ""}>Adaptive (Auto)</option>
            <option value="quality" ${ctx.settings.performanceMode === "quality" ? "selected" : ""}>Quality</option>
            <option value="performance" ${ctx.settings.performanceMode === "performance" ? "selected" : ""}>Performance (Fast)</option>
          </select>
        </div>
      `;
      const perfSel = perfRow.querySelector("select") as HTMLSelectElement;
      perfSel.addEventListener("change", () => {
        ctx.onSettingsChange({ performanceMode: perfSel.value as PerformanceMode });
        showInfoToast(`Performance profile: ${perfSel.options[perfSel.selectedIndex]?.text ?? perfSel.value}`);
      }, { signal });
      grid.appendChild(perfRow);

      // Post Process Filter
      const fxRow = make("div", { class: "ingame-menu__setting-item" });
      fxRow.innerHTML = `
        <div class="ingame-menu__setting-info">
          <div class="ingame-menu__setting-name">Visual Filter</div>
        </div>
        <div class="ingame-menu__setting-control">
          <select class="ingame-menu__select">
            <option value="none" ${ctx.settings.postProcessEffect === "none" ? "selected" : ""}>None (Raw)</option>
            <option value="crt" ${ctx.settings.postProcessEffect === "crt" ? "selected" : ""}>CRT Simulation</option>
            <option value="lcd" ${ctx.settings.postProcessEffect === "lcd" ? "selected" : ""}>Handheld LCD</option>
            <option value="sharpen" ${ctx.settings.postProcessEffect === "sharpen" ? "selected" : ""}>Adaptive Sharpen</option>
            <option value="fxaa" ${ctx.settings.postProcessEffect === "fxaa" ? "selected" : ""}>Anti-Aliasing (FXAA)</option>
            <option value="retro" ${ctx.settings.postProcessEffect === "retro" ? "selected" : ""}>Retro Pixel-Art</option>
          </select>
        </div>
      `;
      const fxSel = fxRow.querySelector("select") as HTMLSelectElement;
      fxSel.addEventListener("change", () => {
        const effect = fxSel.value as PostProcessEffect;
        ctx.onSettingsChange({ postProcessEffect: effect });
        ctx.emulator.setPostProcessEffect(effect);
        const text = fxSel.options[fxSel.selectedIndex]?.text ?? effect;
        showInfoToast(`Filter: ${text}`);
      }, { signal });
      grid.appendChild(fxRow);

      // --- 3D Core Internal Resolution ---
      const systemInfo = getSystemById(systemId);
      if (systemInfo?.is3D) {
        const resolutionConfig: Record<string, { key: string, options: { label: string, value: string }[] }> = {
          psp: {
            key: "ppsspp_internal_resolution",
            options: [
              { label: "1x (PSP Native)", value: "1" },
              { label: "2x (720p)", value: "2" },
              { label: "3x (1080p)", value: "3" },
              { label: "4x (2K)", value: "4" },
              { label: "5x (4K)", value: "5" },
            ]
          },
          n64: {
            key: "mupen64plus-resolution-factor",
            options: [
              { label: "1x (Native)", value: "1" },
              { label: "2x (High)", value: "2" },
              { label: "4x (Ultra)", value: "4" },
            ]
          },
          psx: {
            key: "beetle_psx_hw_internal_resolution",
            options: [
              { label: "1x (Native)", value: "1x(native)" },
              { label: "2x (HD)", value: "2x" },
              { label: "4x (FHD)", value: "4x" },
              { label: "8x (4K)", value: "8x" },
            ]
          },
          nds: {
            key: "desmume_internal_resolution",
            options: [
              { label: "256x192 (Native)", value: "256x192" },
              { label: "512x384 (2x)", value: "512x384" },
              { label: "1024x768 (4x)", value: "1024x768" },
            ]
          }
        };

        const config = resolutionConfig[systemId];
        if (config) {
          const currentOptions = ctx.getCurrentCoreOptions?.() ?? {};
          const currentVal = currentOptions[config.key] || config.options[0]?.value;

          const resRow = make("div", { class: "ingame-menu__setting-item" });
          resRow.innerHTML = `
            <div class="ingame-menu__setting-info">
              <div class="ingame-menu__setting-name">Internal Resolution</div>
              <div class="ingame-menu__setting-desc">Higher values increase clarity but require more GPU power.</div>
            </div>
            <div class="ingame-menu__setting-control">
              <select class="ingame-menu__select">
                ${config.options.map(opt => `<option value="${opt.value}" ${currentVal === opt.value ? "selected" : ""}>${opt.label}</option>`).join("")}
              </select>
            </div>
          `;
          const resSel = resRow.querySelector("select") as HTMLSelectElement;
          resSel.addEventListener("change", () => {
            const nextVal = resSel.value;
            ctx.onUpdateCoreOption?.(config.key, nextVal);
            showInfoToast("Resolution updated. Restart game to apply.", "warning");
            
            // Add a restart button if it doesn't exist yet
            if (!content.querySelector(".btn-restart-core")) {
              const restartBtn = make("button", { class: "ingame-menu__btn ingame-menu__btn--block btn-restart-core" }, "Restart Game to Apply Changes");
              restartBtn.addEventListener("click", () => {
                closeMenu();
                // Signal main.ts to restart emulator with new window.EJS_Settings
                document.dispatchEvent(new CustomEvent(RESTART_REQUIRED_EVENT));
              }, { signal });
              body.appendChild(restartBtn);
            }
          }, { signal });
          grid.appendChild(resRow);
        }
      }

      // Open advanced settings
      const advBtn = make("button", { class: "ingame-menu__btn ingame-menu__btn--block ingame-menu__btn--spaced" }, "Open Advanced UI Settings");
      advBtn.addEventListener("click", () => {
        closeMenu();
        ctx.onOpenSettings?.("display");
      }, { signal });
      body.appendChild(advBtn);
    }
    else if (type === "multiplayer") {
      const nmPromise = ctx.getNetplayManager?.();
      if (!nmPromise) {
        body.innerHTML = `<div class="ingame-menu__empty-state">Netplay is not available in the current environment or for this core.</div>`;
        return;
      }

      const nm = await nmPromise;
      const isConfigured = nm.isActive;

      const container = make("div", { class: "ingame-menu__multiplayer" });
      body.appendChild(container);

      if (!isConfigured) {
        container.innerHTML = `
          <div class="ingame-menu__empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3;margin-bottom:16px"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            <p>Play Together is currently disabled or unconfigured.</p>
            <button class="ingame-menu__btn" style="margin-top:16px">Go to Play Together Settings</button>
          </div>
        `;
        container.querySelector("button")?.addEventListener("click", () => {
          closeMenu();
          ctx.onOpenSettings?.("multiplayer");
        }, { signal });
      } else {
        const stats = make("div", { class: "ingame-menu__netplay-status" });
        const roomKey = nm.roomKeyFor(gameId, systemId);
        
        stats.innerHTML = `
          <div class="ingame-menu__stat-card">
            <div class="ingame-menu__stat-val">${roomDisplayNameForKey(roomKey)}</div>
            <div class="ingame-menu__stat-label">Service Namespace</div>
          </div>
          <div class="ingame-menu__stat-card">
            <div class="ingame-menu__stat-val">${nm.enabled ? "Enabled" : "Disabled"}</div>
            <div class="ingame-menu__stat-label">Discovery Status</div>
          </div>
        `;
        container.appendChild(stats);

        const actions = make("div", { class: "ingame-menu__multiplayer-actions" });
        actions.innerHTML = `
          <button class="ingame-menu__btn ingame-menu__btn--primary">Manage Play Together Room</button>
          <p class="settings-help ingame-menu__multiplayer-help">Use the game's built-in multiplayer interface to join a specific room, or the RetroVault Play Together lobby for automatic matchmaking. Play Together is separate from in-game Wi-Fi or WFC features built into the ROM.</p>
        `;
        actions.querySelector("button")?.addEventListener("click", () => {
          closeMenu();
          ctx.onOpenPlayTogetherSettings?.();
        }, { signal });
        container.appendChild(actions);
      }
    }
  };

  const addSideBtn = (label: string, icon: string, tab: string, isDanger = false) => {
    const btn = make("button", { 
      class: isDanger ? "ingame-menu__sidebar-btn ingame-menu__sidebar-btn--danger" : "ingame-menu__sidebar-btn",
      "data-tab": tab
    });
    btn.innerHTML = `${icon} <span>${label}</span>`;
    btn.addEventListener("click", () => {
      if (tab === "resume") closeMenu();
      else if (tab === "library") {
        closeMenu();
        ctx.onReturnToLibrary();
      } else if (tab === "reset") {
        void showConfirmDialog("Unsaved progress will be lost.", { title: "Reset Game?", confirmLabel: "Reset", isDanger: true }).then(conf => {
          if (conf) {
            ctx.emulator.reset();
            closeMenu();
          }
        });
      } else {
        void renderContent(tab as "saves" | "settings" | "multiplayer");
      }
    }, { signal: ac.signal });
    sidebar.appendChild(btn);
  };

  addSideBtn("Resume", `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`, "resume");
  addSideBtn("Saves & Gallery", `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`, "saves");
  addSideBtn("Play Together", `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`, "multiplayer");
  addSideBtn("Quick Settings", `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`, "settings");
  addSideBtn("Restart Game", `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/></svg>`, "reset", true);
  addSideBtn("Home Console", `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`, "library");

  void renderContent("saves");

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeMenu();
  }, { signal });

  // Escape to close
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  }, { signal, once: true });

  overlay.addEventListener("keydown", (e: KeyboardEvent) => trapFocus(overlay, e), { signal });
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



// ── Settings panel ────────────────────────────────────────────────────────────

type SettingsTab = "performance" | "display" | "library" | "cloud" | "bios" | "multiplayer" | "debug" | "about";

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
  // peekNetplayManager() returns it — enabling synchronous calls in tab builders.
  if (typeof getNetplayManagerOrInstance !== "function" && getNetplayManagerOrInstance != null) {
    registerNetplayInstance(getNetplayManagerOrInstance);
  }
  const getNetplayManager: (() => Promise<import("./multiplayer.js").NetplayManager>) | undefined =
    typeof getNetplayManagerOrInstance === "function"
      ? getNetplayManagerOrInstance
      : getNetplayManagerOrInstance != null
        ? () => Promise.resolve(getNetplayManagerOrInstance)
        : undefined;

  buildSettingsContent(content, settings, deviceCaps, library, biosLibrary, onSettingsChange, emulatorRef, onLaunchGame, saveLibrary, getNetplayManager, initialTab);
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
  container.innerHTML = "";

  const settingsShell = make("div", { class: "settings-shell" });
  const quickBar = make("div", { class: "settings-quickbar" });
  const perfModeLabel = settings.performanceMode === "performance" ? "Performance"
    : settings.performanceMode === "quality" ? "Quality"
    : "Auto";
  const tierFriendlyMap: Record<string, string> = { low: "entry-level", medium: "mid-range", high: "high-end" };
  const tierFriendly = tierFriendlyMap[deviceCaps.tier] ?? "unknown";
  const quickInfo = make("p", { class: "settings-quickbar__summary" },
    `Graphics: ${perfModeLabel} · ${tierFriendly} device${deviceCaps.isLowSpec ? " · optimised mode active" : ""}`
  );
  const searchInput = make("input", {
    class: "settings-search-input",
    type: "search",
    placeholder: "Search settings…",
    "aria-label": "Search settings",
  }) as HTMLInputElement;
  const searchStatus = make("p", { class: "settings-search-status", "aria-live": "polite" });
  quickBar.append(quickInfo, searchInput, searchStatus);
  const activeTabLabel = make("p", { class: "settings-active-tab-label", "aria-live": "polite" });
  quickBar.append(activeTabLabel);

  const tabs: Array<{ id: SettingsTab; icon: string; label: string; ariaLabel: string }> = [
    { id: "performance",  icon: "⚡", label: "Performance",   ariaLabel: "Performance" },
    { id: "display",      icon: "🖥", label: "Display",        ariaLabel: "Display" },
    { id: "library",      icon: "📚", label: "My Games",       ariaLabel: "My Games" },
    { id: "cloud",        icon: "☁️", label: "Cloud Storage",  ariaLabel: "Cloud Storage" },
    { id: "bios",         icon: "💾", label: "System Files",   ariaLabel: "System Files" },
    { id: "multiplayer",  icon: "🌐", label: "Play Together",  ariaLabel: "Play Together" },
    { id: "debug",        icon: "🔧", label: "Advanced",       ariaLabel: "Advanced" },
    { id: "about",        icon: "❓", label: "Help",            ariaLabel: "Help" },
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
    const iconEl = make("span", { class: "settings-sidebar__icon", "aria-hidden": "true" }, tab.icon);
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
  buildPerfTab(panels[0]!, settings, deviceCaps, onSettingsChange, emulatorRef);
  buildDisplayTab(panels[1]!, settings, deviceCaps, onSettingsChange, emulatorRef);
  buildLibraryTab(panels[2]!, settings, library, saveLibrary, onSettingsChange, onLaunchGame, emulatorRef);
  buildCloudTab(panels[3]!, settings, library, onSettingsChange);
  buildBiosTab(panels[4]!, biosLibrary);
  buildMultiplayerTab(panels[5]!, settings, onSettingsChange, getNetplayManager, settings.lastGameName, emulatorRef?.currentSystem?.id);
  buildDebugTab(panels[6]!, settings, onSettingsChange, deviceCaps, emulatorRef, getNetplayManager, biosLibrary);
  buildAboutTab(panels[7]!);

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
        }, `${tabs[i]!.label}${firstMatchLabel ? ` · ${firstMatchLabel}` : ""}`) as HTMLButtonElement;
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

// ── Performance tab ───────────────────────────────────────────────────────────

/** Format a WebGPU availability status string for the technical details panel. */
function formatWebGPUStatus(
  available: boolean,
  adapterInfo?: { device?: string; vendor?: string; isFallbackAdapter?: boolean } | null
): string {
  if (!available) return "✗ Not available (Chrome 113+ required)";
  if (adapterInfo?.device) {
    const suffix = adapterInfo.isFallbackAdapter ? " (software fallback)" : "";
    return `✓ ${adapterInfo.device}${suffix}`;
  }
  if (adapterInfo?.vendor) return `✓ ${adapterInfo.vendor}`;
  return "✓ Available";
}

function buildPerfTab(
  container:        HTMLElement,
  settings:         Settings,
  deviceCaps:       DeviceCapabilities,
  onSettingsChange: (patch: Partial<Settings>) => void,
  emulatorRef?:     import("./emulator.js").PSPEmulator
): void {
  const activeSystem = emulatorRef?.currentSystem ?? null;
  const activeTier = emulatorRef?.activeTier ?? null;
  if (activeSystem) {
    const coreSection = make("div", { class: "settings-section" });
    coreSection.appendChild(make("h4", { class: "settings-section__title" }, "Current Core"));

        const heading = make("div", { class: "settings-core-heading" });
    if (activeSystem.iconUrl) {
      heading.appendChild(make("img", { src: activeSystem.iconUrl, class: "settings-core-heading__icon", alt: "" }));
    }
    const headerText = make("div", { class: "settings-core-heading__text" });
    headerText.appendChild(make("strong", { class: "settings-core-heading__title" }, activeSystem.name));

    const coreMeta = make("div", { class: "settings-core-heading__meta" },
      `Core: ${activeSystem.coreId ?? activeSystem.id} · ` +
      (activeTier ? `Hardware: ${formatTierLabel(activeTier)}` : "Hardware: Auto")
    );
    headerText.appendChild(coreMeta);
    heading.appendChild(headerText);
    coreSection.appendChild(heading);

    const profileBits = [
      activeTier ? `${formatTierLabel(activeTier)} tier` : null,
      settings.performanceMode === "auto" ? "Auto graphics mode" : `${settings.performanceMode === "performance" ? "Performance" : "Quality"} graphics mode`,
      activeSystem.is3D ? "3D visuals tuned for heavier rendering" : "Lightweight core profile",
    ].filter((bit): bit is string => Boolean(bit));
    coreSection.appendChild(make("p", { class: "settings-help" }, profileBits.join(" • ")));

    const featureRow = buildSystemFeatureRow(activeSystem, {
      includeExperimental: true,
      includeOnline: true,
      className: "system-feature-row system-feature-row--settings",
    });
    if (featureRow) coreSection.appendChild(featureRow);
    container.appendChild(coreSection);
  }

  // Performance mode
  const perfSection = make("div", { class: "settings-section" });
  perfSection.appendChild(make("h4", { class: "settings-section__title" }, "Graphics Mode"));
  perfSection.appendChild(make("p", { class: "settings-help" },
    "Controls how detailed the graphics look and how smoothly games run. " +
    "If games feel slow or choppy, try Performance mode. Changes apply when you start or restart a game."
  ));

  const autoModeActive = deviceCaps.isLowSpec || deviceCaps.tier === "medium" ? "Performance" : "Quality";
  const modes: Array<{ value: PerformanceMode; label: string; desc: string }> = [
    { value: "auto",        label: "Auto  (Recommended)", desc: `Let RetroVault choose — right now using ${autoModeActive} mode for your device` },
    { value: "performance", label: "Performance — smoother gameplay",  desc: "Lower-resolution but faster. Great for older devices or when games feel sluggish." },
    { value: "quality",     label: "Quality — sharper visuals",        desc: "Higher-resolution graphics for powerful devices. May slow down on older hardware." },
  ];

  for (const m of modes) {
    const row   = make("label", { class: "radio-row" });
    const radio = make("input", { type: "radio", name: "perf-mode", value: m.value }) as HTMLInputElement;
    if (settings.performanceMode === m.value) radio.checked = true;
    radio.addEventListener("change", () => { if (radio.checked) onSettingsChange({ performanceMode: m.value }); });
    const txt = make("span", { class: "radio-row__text" });
    txt.append(make("span", { class: "radio-row__label" }, m.label), make("span", { class: "radio-row__desc" }, m.desc));
    row.append(radio, txt);
    perfSection.appendChild(row);
  }

  // Device info
  const deviceSection = make("div", { class: "settings-section" });
  deviceSection.appendChild(make("h4", { class: "settings-section__title" }, "Your Device"));
  deviceSection.appendChild(make("p", { class: "settings-help" },
    "RetroVault automatically picks the best settings for your device."
  ));

  const capText = formatCapabilitiesSummary(deviceCaps);
  deviceSection.appendChild(make("p", { class: "device-info" }, capText));

  const tierClass = deviceCaps.tier === "low" ? "tier-badge tier-badge--warn" : deviceCaps.tier === "medium" ? "tier-badge tier-badge--mid" : "tier-badge tier-badge--ok";
  const tierLabel = deviceCaps.tier === "low"
    ? "Entry-level graphics"
    : deviceCaps.tier === "medium"
    ? "Mid-range graphics"
    : "High-performance graphics";
  deviceSection.appendChild(make("span", { class: tierClass }, tierLabel));

  // Technical GPU details behind a disclosure
  const gpuDisclosure = make("details", { class: "settings-details" }) as HTMLDetailsElement;
  gpuDisclosure.appendChild(make("summary", {}, "Technical details"));

  const gpuDetails = make("div", { class: "settings-details__content" });
  const adapterInfo = emulatorRef?.webgpuAdapterInfo;
  const webgpuStatusText = formatWebGPUStatus(deviceCaps.webgpuAvailable, adapterInfo);
  gpuDetails.appendChild(make("p", { class: "device-info" }, `GPU score: ${deviceCaps.gpuBenchmarkScore}/100`));
  gpuDetails.appendChild(make("p", { class: "device-info" }, `Max texture size: ${deviceCaps.gpuCaps.maxTextureSize}px · VRAM: ~${deviceCaps.estimatedVRAMMB} MB`));
  if (deviceCaps.gpuCaps.anisotropicFiltering) {
    gpuDetails.appendChild(make("p", { class: "device-info" }, `Anisotropic filtering: ${deviceCaps.gpuCaps.maxAnisotropy}×`));
  }
  gpuDetails.appendChild(make("p", { class: "device-info" }, `WebGL 2: ${deviceCaps.gpuCaps.webgl2 ? "✓" : "✗"} · WebGPU: ${webgpuStatusText}`));
  gpuDetails.appendChild(make("p", { class: "device-info" }, `SharedArrayBuffer: ${typeof SharedArrayBuffer !== "undefined" ? "✓ (PSP supported)" : "✗"} · AudioWorklet: ${typeof AudioWorkletNode !== "undefined" ? "✓" : "✗"}`));
  gpuDisclosure.appendChild(gpuDetails);
  deviceSection.appendChild(gpuDisclosure);
  container.append(perfSection, deviceSection);

  // UI Mode (Lite vs Quality)
  const uiSection = make("div", { class: "settings-section" });
  uiSection.appendChild(make("h4", { class: "settings-section__title" }, "UI Visual Fidelity"));
  uiSection.appendChild(make("p", { class: "settings-help" },
    "Adjusts the library and menu visual effects. 'Lite' mode disables blurs, heavy animations, and complex gradients " +
    "to ensure the interface feels snappy on all devices."
  ));

  const uiModes: Array<{ value: Settings["uiMode"]; label: string; desc: string }> = [
    { value: "auto",    label: "Auto (Recommended)",    desc: "Adapts based on device and data saver settings" },
    { value: "quality", label: "Quality — full effects", desc: "Best visuals with blurs, animations, and high-res gradients." },
    { value: "lite",    label: "Lite — max speed",      desc: "Minimal visuals. Disables blurs and animations for speed." },
  ];

  for (const m of uiModes) {
    const row   = make("label", { class: "radio-row" });
    const radio = make("input", { type: "radio", name: "ui-mode", value: m.value }) as HTMLInputElement;
    if (settings.uiMode === m.value) radio.checked = true;
    radio.addEventListener("change", () => { if (radio.checked) onSettingsChange({ uiMode: m.value }); });
    const txt = make("span", { class: "radio-row__text" });
    txt.append(make("span", { class: "radio-row__label" }, m.label), make("span", { class: "radio-row__desc" }, m.desc));
    row.append(radio, txt);
    uiSection.appendChild(row);
  }
  container.appendChild(uiSection);
}

// ── Display tab ───────────────────────────────────────────────────────────────

function buildDisplayTab(
  container:        HTMLElement,
  settings:         Settings,
  deviceCaps:       DeviceCapabilities,
  onSettingsChange: (patch: Partial<Settings>) => void,
  emulatorRef?:     import("./emulator.js").PSPEmulator
): void {
  // FPS & Audio section
  const overlaySection = make("div", { class: "settings-section" });
  overlaySection.appendChild(make("h4", { class: "settings-section__title" }, "In-Game Overlays"));

  overlaySection.appendChild(buildToggleRow(
    "Show FPS counter",
    "Shows a small frame-rate display while a game is running — useful for checking performance",
    settings.showFPS,
    (v) => {
      onSettingsChange({ showFPS: v });
      showFPSOverlay(v, emulatorRef, settings.showAudioVis);
      emulatorRef?.setFPSMonitorEnabled(v);
    }
  ));

  overlaySection.appendChild(buildToggleRow(
    "Audio waveform",
    "Shows a small oscilloscope waveform alongside the FPS counter (FPS counter must be enabled)",
    settings.showAudioVis,
    (v) => {
      onSettingsChange({ showAudioVis: v });
      if (settings.showFPS) showFPSOverlay(true, emulatorRef, v);
    }
  ));

  // Audio Enhancement section
  const audioSection = make("div", { class: "settings-section" });
  audioSection.appendChild(make("h4", { class: "settings-section__title" }, "Audio Enhancement"));
  audioSection.appendChild(make("p", { class: "settings-help" },
    "Apply an audio filter to reduce harshness or rumble in emulated audio output."
  ));

  const filterTypeRow = make("div", { class: "settings-control-row" });
  const filterTypeLabel = make("span", { class: "settings-control-label" }, "Filter type:");
  const filterTypeSel = make("select", {
    class: "settings-select settings-control-field settings-control-field--compact",
    "aria-label": "Audio filter type",
  }) as HTMLSelectElement;
  const filterTypeOptions: Array<[string, string]> = [
    ["none",     "None (off)"],
    ["lowpass",  "Low-pass (reduce crunch)"],
    ["highpass", "High-pass (reduce rumble)"],
  ];
  for (const [val, lbl] of filterTypeOptions) {
    const o = make("option", { value: val }, lbl) as HTMLOptionElement;
    if (settings.audioFilterType === val) o.selected = true;
    filterTypeSel.appendChild(o);
  }
  filterTypeSel.addEventListener("change", () => {
    onSettingsChange({ audioFilterType: filterTypeSel.value as Settings["audioFilterType"] });
    cutoffRow.hidden = filterTypeSel.value === "none";
  });
  filterTypeRow.append(filterTypeLabel, filterTypeSel);
  audioSection.appendChild(filterTypeRow);

  const cutoffRow = make("div", { class: "settings-control-row" });
  cutoffRow.hidden = settings.audioFilterType === "none";
  const cutoffLabel = make("span", { class: "settings-control-label" }, "Cutoff frequency:");
  const cutoffInp = make("input", {
    type: "range", min: "1000", max: "18000", step: "500",
    value: String(settings.audioFilterCutoff),
    class: "settings-control-field",
    "aria-label": "Audio filter cutoff frequency",
  }) as HTMLInputElement;
  const cutoffVal = make("span", { class: "settings-control-value" }, `${settings.audioFilterCutoff} Hz`);
  cutoffInp.addEventListener("input", () => {
    const hz = parseInt(cutoffInp.value, 10);
    cutoffVal.textContent = `${hz} Hz`;
  });
  cutoffInp.addEventListener("change", () => {
    const hz = parseInt(cutoffInp.value, 10);
    onSettingsChange({ audioFilterCutoff: hz });
  });
  cutoffRow.append(cutoffLabel, cutoffInp, cutoffVal);
  audioSection.appendChild(cutoffRow);

  // Mobile & PWA section
  const mobileSection = make("div", { class: "settings-section" });
  mobileSection.appendChild(make("h4", { class: "settings-section__title" }, "Mobile & Touch"));
  const activeSystem = emulatorRef?.currentSystem ?? null;
  const activeSystemTouchControlsEnabled = activeSystem
    ? (settings.touchControlsBySystem[activeSystem.id] ?? (activeSystem.touchControlMode === "builtin" ? false : settings.touchControls))
    : settings.touchControls;
  const touchControlsHelp = activeSystem?.touchControlMode === "builtin"
    ? "This system has built-in touch controls, so RetroVault keeps its overlay off by default. Turn this on if you want RetroVault's buttons too, then use 🎮 Edit to reposition them."
    : "RetroVault shows its on-screen buttons on touch devices when they help. Turn this off to hide them, or turn it on for systems that need an overlay you can reposition with 🎮 Edit.";

  const installRow = make("div", { class: "pwa-install-row" });
  const buildInstallBtn = () => {
    installRow.innerHTML = "";
    if (!_canInstallPWA?.()) {
      installRow.appendChild(make("p", { class: "settings-help" },
        "Install RetroVault as an app on your phone: open in Chrome or Edge on Android, then tap the browser menu → \"Add to Home Screen\"."
      ));
      return;
    }
    const btnInstall = make("button", { class: "btn btn--primary pwa-install-btn" });
    const emojiSpan = make("span", { "aria-hidden": "true" }, "📲");
    const labelSpan = document.createTextNode(" Install as App");
    btnInstall.append(emojiSpan, labelSpan);
    btnInstall.addEventListener("click", async () => {
      if (!_onInstallPWA) return;
      const installed = await _onInstallPWA();
      if (installed) { btnInstall.textContent = "✓ Installing…"; btnInstall.setAttribute("disabled", "true"); }
    });
    installRow.appendChild(btnInstall);
  };
  buildInstallBtn();
  document.addEventListener("retrovault:installPromptReady", () => buildInstallBtn(), { once: true });
  mobileSection.appendChild(installRow);

  mobileSection.appendChild(buildToggleRow(
    "On-screen buttons",
    touchControlsHelp,
    activeSystemTouchControlsEnabled,
    (v) => onSettingsChange({ touchControls: v })
  ));

  // Button opacity slider
  const opacityRow = make("div", { class: "settings-control-row" });
  const opacityLabel = make("span", { class: "settings-control-label settings-control-label--wide" }, "Button opacity:");
  const opacityInp = make("input", {
    type: "range", min: "0.1", max: "1", step: "0.05",
    value: String(settings.touchOpacity ?? 0.85),
    class: "settings-control-field",
    "aria-label": "Touch button opacity",
  }) as HTMLInputElement;
  const opacityVal = make("span", { class: "settings-control-value settings-control-value--short" },
    `${Math.round((settings.touchOpacity ?? 0.85) * 100)}%`);
  opacityInp.addEventListener("input", () => {
    const v = parseFloat(opacityInp.value);
    opacityVal.textContent = `${Math.round(v * 100)}%`;
    onSettingsChange({ touchOpacity: v });
  });
  opacityRow.append(opacityLabel, opacityInp, opacityVal);
  mobileSection.appendChild(opacityRow);

  // Button scale slider
  const scaleRow = make("div", { class: "settings-control-row" });
  const scaleLabel = make("span", { class: "settings-control-label settings-control-label--wide" }, "Button size:");
  const scaleInp = make("input", {
    type: "range", min: "0.5", max: "2", step: "0.1",
    value: String(settings.touchButtonScale ?? 1.0),
    class: "settings-control-field",
    "aria-label": "Touch button scale",
  }) as HTMLInputElement;
  const scaleVal = make("span", { class: "settings-control-value settings-control-value--short" },
    `${Math.round((settings.touchButtonScale ?? 1.0) * 100)}%`);
  scaleInp.addEventListener("input", () => {
    const v = parseFloat(scaleInp.value);
    scaleVal.textContent = `${Math.round(v * 100)}%`;
    onSettingsChange({ touchButtonScale: v });
  });
  scaleRow.append(scaleLabel, scaleInp, scaleVal);
  mobileSection.appendChild(scaleRow);

  mobileSection.appendChild(buildToggleRow(
    "Vibration feedback",
    "Vibrate briefly when pressing on-screen buttons (works on Android Chrome; not supported on iOS)",
    settings.hapticFeedback,
    (v) => onSettingsChange({ hapticFeedback: v })
  ));

  mobileSection.appendChild(buildToggleRow(
    "Auto-rotate to landscape",
    "Automatically switches to landscape orientation when a game starts (Android Chrome; not supported on iOS Safari)",
    settings.orientationLock,
    (v) => onSettingsChange({ orientationLock: v })
  ));

  container.append(overlaySection, audioSection, mobileSection);

  // WebGPU section — appended last so Overlays and Mobile always appear first
  if (deviceCaps.webgpuAvailable) {
    const gpuSection = make("div", { class: "settings-section" });
    gpuSection.appendChild(make("h4", { class: "settings-section__title" }, "Visual Effects"));
    gpuSection.appendChild(make("p", { class: "settings-help" },
      "Apply extra visual effects to your games using your GPU. These are purely cosmetic — they don't affect gameplay."
    ));

    gpuSection.appendChild(buildToggleRow(
      "Enable GPU effects",
      "Unlock the visual effect options below (experimental — requires a modern GPU)",
      settings.useWebGPU,
      (v) => onSettingsChange({ useWebGPU: v })
    ));

    type FxOption = { value: string; label: string; desc: string };
    const fxOptions: FxOption[] = [
      { value: "none",       label: "No effect",        desc: "Clean output — exactly as the game renders it" },
      { value: "fsr",        label: "FSR 1.0",          desc: "Edge-adaptive upsampling + sharpening — AMD FidelityFX inspired" },
      { value: "taa",        label: "TAA",              desc: "Temporal anti-aliasing — blends frames to reduce shimmer on 3D geometry" },
      { value: "crt",        label: "CRT screen",       desc: "Scanlines and glow — like playing on a real CRT TV" },
      { value: "sharpen",    label: "Sharper image",    desc: "Crisper pixels — great for upscaled handheld games" },
      { value: "lcd",        label: "LCD handheld",     desc: "Sub-pixel grid — simulates a handheld LCD screen" },
      { value: "bloom",      label: "Soft glow",        desc: "Gentle glow on bright areas — warm, cinematic feel" },
      { value: "fxaa",       label: "Smooth edges",     desc: "Reduces jagged edges on 3D game geometry" },
      { value: "grain",      label: "Film grain",       desc: "Cinematic noise overlay — adds texture to flat backgrounds" },
      { value: "retro",      label: "Retro pixel art",  desc: "Limited palette with ordered dithering — classic console look" },
      { value: "colorgrade", label: "Color grading",    desc: "Adjust contrast, saturation, and brightness for a custom look" },
    ];
    for (const opt of fxOptions) {
      const row   = make("label", { class: "radio-row" });
      const radio = make("input", { type: "radio", name: "postfx-mode", value: opt.value }) as HTMLInputElement;
      if (settings.postProcessEffect === opt.value) radio.checked = true;
      radio.disabled = !settings.useWebGPU;
      radio.addEventListener("change", () => {
        if (radio.checked) onSettingsChange({ postProcessEffect: opt.value as import("./webgpuPostProcess.js").PostProcessEffect });
      });
      const txt = make("span", { class: "radio-row__text" });
      txt.append(make("span", { class: "radio-row__label" }, opt.label), make("span", { class: "radio-row__desc" }, opt.desc));
      row.append(radio, txt);
      gpuSection.appendChild(row);
    }

    container.appendChild(gpuSection);
  }
}

// ── Library tab ───────────────────────────────────────────────────────────────

function buildLibraryTab(
  container:        HTMLElement,
  settings:         Settings,
  library:          GameLibrary,
  saveLibrary:      SaveStateLibrary | undefined,
  onSettingsChange: (patch: Partial<Settings>) => void,
  onLaunchGame?:    (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef?:     import("./emulator.js").PSPEmulator
): void {
  // Library stats
  const libSection = make("div", { class: "settings-section" });
  libSection.appendChild(make("h4", { class: "settings-section__title" }, "My Game Library"));

  const statsEl = make("p", { class: "device-info" }, "Calculating…");
  libSection.appendChild(statsEl);
  Promise.all([library.count(), library.totalSize()]).then(([count, total]) => {
    statsEl.textContent = count === 0
      ? "No games added yet — drop a ROM file to get started!"
      : `${count} game${count !== 1 ? "s" : ""} · ${formatBytes(total)} stored in your browser`;
  }).catch(() => { statsEl.textContent = "Could not load library stats."; });

  const btnClear = make("button", { class: "btn btn--danger settings-clear-btn" }, "Remove All Games");
  btnClear.addEventListener("click", async () => {
    const confirmed = await showConfirmDialog(
      "This will remove all games from your library. Your save states will not be deleted.",
      { title: "Remove All Games?", confirmLabel: "Remove All", isDanger: true }
    );
    if (!confirmed) return;
    await library.clearAll();
    // Close the settings panel through the close button so the Escape key
    // handler is removed and focus is properly restored to the caller.
    (document.getElementById("settings-close") as HTMLButtonElement | null)?.click();
    document.title = "RetroVault";
    if (onLaunchGame) void renderLibrary(library, settings, onLaunchGame, emulatorRef);
  });
  libSection.appendChild(btnClear);
  container.appendChild(libSection);

  // Organization
  const orgSection = make("div", { class: "settings-section" });
  orgSection.appendChild(make("h4", { class: "settings-section__title" }, "Organization"));

  orgSection.appendChild(buildToggleRow(
    "Group by system",
    "Enable this to group games by their system (PSP, NES, etc.) or favorites when browsing your library.",
    settings.libraryGrouped,
    (v) => onSettingsChange({ libraryGrouped: v })
  ));
  container.appendChild(orgSection);

  // Save states
  if (saveLibrary) {
    const saveSection = make("div", { class: "settings-section" });
    saveSection.appendChild(make("h4", { class: "settings-section__title" }, "Saved Progress"));

    const saveStatsEl = make("p", { class: "device-info" }, "Calculating…");
    saveSection.appendChild(saveStatsEl);
    saveLibrary.count().then((count) => {
      saveStatsEl.textContent = count === 0
        ? "No save states yet — use Save State in-game to snapshot your progress"
        : `${count} save state${count !== 1 ? "s" : ""} stored in your browser`;
    }).catch(() => { saveStatsEl.textContent = "Could not load save stats."; });

    saveSection.appendChild(buildToggleRow(
      "Auto-save when leaving",
      "Automatically save your progress when you close the tab or switch away — so you never lose unsaved work",
      settings.autoSaveEnabled,
      (v) => onSettingsChange({ autoSaveEnabled: v })
    ));

    const migrateSection = make("div", { class: "settings-subsection" });
    migrateSection.appendChild(make("p", { class: "settings-help" },
      "If you renamed a ROM file, use this tool to move its saves to the new library entry."
    ));

    const btnMigrate = make("button", { class: "btn" }, "Migrate Saves…");
    btnMigrate.addEventListener("click", async () => {
      let games: GameMetadata[];
      try { games = await library.getAllGamesMetadata(); } catch { games = []; }
      if (games.length < 2) { showError("You need at least two games in your library to migrate saves."); return; }

      const source = await showGamePickerDialog("Select Source Game", "Choose the game whose saves you want to move:", games);
      if (!source) return;
      const targets = games.filter(g => g.id !== source.id);
      const target = await showGamePickerDialog("Select Target Game", "Choose the game to receive the saves:", targets);
      if (!target) return;

      try {
        const count = await saveLibrary.migrateSaves(source.id, target.id, target.name);
        showInfoToast(count > 0
          ? `Migrated ${count} save state${count !== 1 ? "s" : ""} from "${source.name}" to "${target.name}".`
          : `No saves found for "${source.name}".`
        );
      } catch (err) {
        showError(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    migrateSection.appendChild(btnMigrate);
    saveSection.appendChild(migrateSection);

    const btnClearSaves = make("button", { class: "btn btn--danger settings-clear-btn" }, "Clear All Saves");
    btnClearSaves.addEventListener("click", async () => {
      const confirmed = await showConfirmDialog(
        "This will delete all save states and cannot be undone.",
        { title: "Clear All Saves?", confirmLabel: "Clear All", isDanger: true }
      );
      if (!confirmed) return;
      await saveLibrary.clearAll();
      saveStatsEl.textContent = "0 save states stored locally";
    });
    saveSection.appendChild(btnClearSaves);
    container.appendChild(saveSection);
  }

  // Supported systems
  const sysSection = make("div", { class: "settings-section" });
  sysSection.appendChild(make("h4", { class: "settings-section__title" }, "Supported Systems"));
  const sysList = make("div", { class: "sys-list" });
  for (const sys of SYSTEMS) {
    const chip = make("span", { class: "sys-chip" }, sys.shortName);
    chip.style.background = sys.color;
    chip.title = [sys.name, ...getSystemFeatureSummary(sys)].join(" • ");
    sysList.appendChild(chip);
  }
  sysSection.appendChild(sysList);
  container.appendChild(sysSection);
}

// ── BIOS tab ──────────────────────────────────────────────────────────────────

function buildBiosTab(container: HTMLElement, biosLibrary: BiosLibrary): void {
  const biosSection = make("div", { class: "settings-section" });
  biosSection.appendChild(make("h4", { class: "settings-section__title" }, "System Startup Files"));
  biosSection.appendChild(make("p", { class: "settings-help" },
    "Some older consoles need a startup file to run games. " +
    "If a game won't start, you may need to add one here. " +
    "You can extract these files from a physical console you own — RetroVault cannot provide them."
  ));

  const biosGrid = make("div", { class: "bios-grid" });
  biosSection.appendChild(biosGrid);

  for (const sysId of Object.keys(BIOS_REQUIREMENTS)) {
    const sysInfo = SYSTEMS.find(s => s.id === sysId);
    if (!sysInfo) continue;
    const reqs = BIOS_REQUIREMENTS[sysId]!;

    const sysBlock  = make("div", { class: "bios-system" });
    const sysHeader = make("div", { class: "bios-system__header" });
    const sysBadge  = make("span", { class: "sys-badge" }, sysInfo.shortName);
    sysBadge.style.background = sysInfo.color;
    sysHeader.append(sysBadge, document.createTextNode(" " + sysInfo.name));
    sysBlock.appendChild(sysHeader);

    for (const req of reqs) {
      const row           = make("div", { class: "bios-row" });
      const statusDot     = make("span", { class: "bios-dot bios-dot--unknown" });
      // Label wrapper: display name on one line, required filename on the next
      const labelWrap     = make("span", { class: "bios-label" });
      labelWrap.appendChild(document.createTextNode(req.displayName));
      labelWrap.appendChild(make("code", { class: "bios-filename", title: `Required filename: ${req.fileName}`, "aria-label": `Required filename: ${req.fileName}` }, req.fileName));
      const desc          = make("span", { class: "bios-desc" }, req.description);
      const requiredBadge = req.required
        ? make("span", { class: "bios-required" }, "Required")
        : make("span", { class: "bios-optional" }, "Optional");

      const uploadInput = make("input", {
        type: "file", accept: ".bin,.img,.rom",
        "aria-label": `Upload ${req.displayName}`, style: "display:none",
      }) as HTMLInputElement;

      const uploadBtn = make("button", { class: "btn bios-upload-btn" }, "Upload");
      uploadBtn.addEventListener("click", () => uploadInput.click());
      uploadInput.addEventListener("change", async () => {
        const file = uploadInput.files?.[0];
        if (!file) return;
        uploadInput.value = "";
        try {
          // Rename the file to the canonical filename so the emulator
          // always finds it regardless of the user's local file name.
          const canonical = new File([file], req.fileName, { type: file.type });
          await biosLibrary.addBios(canonical, sysId);
          statusDot.className = "bios-dot bios-dot--ok";
          uploadBtn.textContent = "Replace";
        } catch (err) {
          showError(`BIOS upload failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

      biosLibrary.findBios(sysId, req.fileName).then(found => {
        if (found) { statusDot.className = "bios-dot bios-dot--ok"; uploadBtn.textContent = "Replace"; }
        else if (req.required) { statusDot.className = "bios-dot bios-dot--missing"; }
      }).catch(() => {});

      row.append(statusDot, uploadInput, labelWrap, requiredBadge, desc, uploadBtn);
      sysBlock.appendChild(row);
    }
    biosGrid.appendChild(sysBlock);
  }

  container.appendChild(biosSection);
}

// ── Easy Netplay modal ────────────────────────────────────────────────────────

/**
 * Module-level EasyNetplayManager singleton.
 * Created lazily so it doesn't interfere with test environments.
 */
let _easyNetplayManager: EasyNetplayManager | null = null;

function getEasyNetplayManager(serverUrl?: string): EasyNetplayManager {
  if (!_easyNetplayManager) {
    _easyNetplayManager = new EasyNetplayManager(serverUrl);
  } else if (serverUrl !== undefined) {
    _easyNetplayManager.setServerUrl(serverUrl);
  }
  return _easyNetplayManager;
}

/**
 * Open the Easy Netplay modal.
 *
 * Shows a three-tab interface: Host / Join / Browse.
 * The modal is self-contained and destroys itself when closed.
 */
export function openEasyNetplayModal(opts: {
  netplayManager?: NetplayManager;
  currentGameName?: string | null;
  currentGameId?:   string | null;
  currentSystemId?: string | null;
  /** Opens Settings on the Play Together tab (closes this modal first). */
  onOpenPlayTogetherSettings?: () => void;
}): void {
  const { netplayManager, currentGameName, currentGameId, currentSystemId, onOpenPlayTogetherSettings } = opts;
  const serverUrl = netplayManager?.serverUrl ?? "";
  const username  = netplayManager?.username  ?? "";
  const netplayEnabled = netplayManager?.enabled ?? false;

  const easyMgr = getEasyNetplayManager(serverUrl);
  const panelCleanups: Array<() => void> = [];

  // ── Overlay / container ──────────────────────────────────────────────────
  const overlay = make("div", { class: "confirm-overlay easy-netplay-overlay" });
  const dialog  = make("div", {
    class:      "confirm-box easy-netplay-dialog",
    role:       "dialog",
    "aria-modal": "true",
    "aria-label": "Play Together lobby",
  });

  // ── Header ───────────────────────────────────────────────────────────────
  const header = make("div", { class: "enp-header" });
  header.innerHTML = `<img src="${resolveAssetUrl("assets/netplay_icon_premium_1775434064140.png")}" width="22" height="22" style="margin-right:10px" />`;
  header.appendChild(make("span", { class: "enp-title" }, "Play Together Lobby"));
  const btnCopyDiagnostics = make("button", {
    class: "enp-copy-diag",
    "aria-label": "Copy multiplayer diagnostics",
    title: "Copy connection diagnostics",
  }, "📋 Logs") as HTMLButtonElement;
  btnCopyDiagnostics.addEventListener("click", () => {
    const entries = easyMgr.diagnostics.entries;
    if (entries.length === 0) {
      showInfoToast("No diagnostics yet.");
      return;
    }
    const titleLine = `RetroVault Multiplayer Diagnostics (${new Date().toISOString()})`;
    const body = entries.map((entry) => {
      const ts = new Date(entry.timestamp).toISOString();
      const detail = entry.detail ? ` — ${entry.detail}` : "";
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
  }, "✕") as HTMLButtonElement;
  header.appendChild(btnClose);
  dialog.appendChild(header);

  // ── First-time / setup strip (server or enable missing) ──────────────────
  const needsServerUrl = serverUrl.trim().length === 0;
  const needsEnable = !netplayEnabled;
  if (needsServerUrl || needsEnable) {
    const setupStrip = make("div", { class: "enp-setup-strip", role: "region", "aria-label": "Online play setup" });
    const setupTitle = make("p", { class: "enp-setup-strip__title" }, "Set up multiplayer (one minute)");
    const setupSteps = make("ol", { class: "enp-setup-strip__steps" });
    const step1 = needsEnable
      ? "Open Settings → Play Together and turn on Online play."
      : "Online play is on — add your server URL in Settings → Play Together.";
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
    dialog.appendChild(setupStrip);
  }

  // ── Current game badge ───────────────────────────────────────────────────
  if (currentGameName) {
    const gameBadge = make("div", { class: "enp-game-badge" });
    gameBadge.appendChild(make("span", { class: "enp-game-badge__label" }, "Playing:"));
    gameBadge.appendChild(make("span", { class: "enp-game-badge__name" }, currentGameName));
    const sysSupport = currentSystemId ? checkSystemSupport(currentSystemId) : null;
    if (sysSupport && !sysSupport.compatible) {
      gameBadge.appendChild(make("span", {
        class: "enp-compat-warn",
        title: sysSupport.errors[0] ?? "",
      }, "⚠ No multiplayer support"));
    }
    dialog.appendChild(gameBadge);
  }

  // ── Tab bar ──────────────────────────────────────────────────────────────
  const tabs: Array<{ id: string; label: string }> = [
    { id: "host",    label: "🎮 Host"    },
    { id: "join",    label: "🔗 Join"    },
    { id: "browse",  label: "📋 Browse"  },
    { id: "watch",   label: "👁 Watch"   },
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

  // ── Host panel ───────────────────────────────────────────────────────────
  panelCleanups.push(_buildHostPanel(panels[0]!, {
    easyMgr, username, currentGameId, currentGameName, currentSystemId, serverUrl,
    onRoomCreated: () => {/* panel updates itself via onEvent */},
  }));

  // ── Join panel ───────────────────────────────────────────────────────────
  // Capture refs so the Browse panel can pre-fill and quick-join without
  // forcing extra taps.
  let _fillJoinCode: ((code: string) => void) | null = null;
  let _quickJoinCode: ((code: string) => void) | null = null;
  panelCleanups.push(_buildJoinPanel(panels[1]!, {
    easyMgr, username, currentGameId, currentGameName, currentSystemId, serverUrl,
    onCodeSetterReady: (setter) => { _fillJoinCode = setter; },
    onJoinActionReady: (joinNow) => { _quickJoinCode = joinNow; },
  }));

  // ── Browse panel ─────────────────────────────────────────────────────────
  // Watch-tab pre-fill refs
  let _fillWatchCode: ((code: string) => void) | null = null;
  let _quickWatchCode: ((code: string) => void) | null = null;
  panelCleanups.push(_buildBrowsePanel(panels[2]!, {
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

  // ── Watch panel ───────────────────────────────────────────────────────────
  panelCleanups.push(_buildWatchPanel(panels[3]!, {
    easyMgr, username: username || "Anonymous", serverUrl,
    onCodeSetterReady: (setter) => { _fillWatchCode = setter; },
    onWatchActionReady: (watchNow) => { _quickWatchCode = watchNow; },
  }));

  // ── Append + animate ─────────────────────────────────────────────────────
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("retrovault:closeEasyNetplay", onCloseNetplayEvent);
    document.removeEventListener("keydown", onKey, { capture: true });
    panelCleanups.forEach((fn) => {
      try { fn(); } catch { /* ignore cleanup errors */ }
    });
    easyMgr.cancelPendingOperations();
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
  document.addEventListener("retrovault:closeEasyNetplay", onCloseNetplayEvent);

  btnClose.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey, { capture: true });
  requestAnimationFrame(() => {
    overlay.classList.add("confirm-overlay--visible");
    tabBtns[0]?.focus();
  });
}

// ── Easy Netplay — Host panel ─────────────────────────────────────────────────

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
      label: "Same Wi‑Fi / LAN",
      desc: "Lowest latency when everyone is nearby. You still need the same server URL so this device can register the room (paste it in Play Together settings).",
    },
    { value: "private", label: "Private (invite code)", desc: "Only people with the code can join — best for playing with a specific friend." },
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
      "⚠ No server URL configured. Local-only rooms cannot be discovered by others. Add a server in Settings → Play Together."
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
      document.dispatchEvent(new CustomEvent("retrovault:closeEasyNetplay"));
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
    btnCreate.textContent = "Creating room…";
    statusArea.hidden = false;
    statusArea.innerHTML = "";
    statusArea.appendChild(make("p", { class: "enp-diag enp-diag--info" }, "Connecting…"));

    // Subscribe to events once
    activeUnsub?.();
    activeUnsub = easyMgr.onEvent(ev => {
      if (ev.type === "diagnostic") {
        const item = _renderEasyDiagnosticEntry(ev.diagnostic.level, ev.diagnostic.message, ev.diagnostic.detail);
        // Clear "Connecting…" placeholder on first real message
        if (statusArea.children.length === 1 && statusArea.children[0]!.textContent === "Connecting…") {
          statusArea.innerHTML = "";
        }
        statusArea.appendChild(item);
      }
      if (ev.type === "room_created") {
        activeUnsub?.();
        activeUnsub = null;
        const room = ev.room;
        statusArea.innerHTML = "";
        _renderRoomCard(statusArea, room, { showLeaveBtn: true, easyMgr, isHost: true });
        btnCreate.textContent = "Hosting ✓";
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

// ── Easy Netplay — Join panel ─────────────────────────────────────────────────

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
    placeholder:  "ABC123…",
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
  codeField.appendChild(codeInput);
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
      "⚠ No server URL configured. Joining by code requires a server. Add one in Settings → Play Together."
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
    btnJoin.textContent = "Joining…";
    statusArea.hidden  = false;
    statusArea.innerHTML = "";
    statusArea.appendChild(make("p", { class: "enp-diag enp-diag--info" }, "Connecting…"));

    activeUnsub?.();
    activeUnsub = easyMgr.onEvent(ev => {
      if (ev.type === "diagnostic") {
        if (statusArea.children.length === 1 && statusArea.children[0]!.textContent === "Connecting…") {
          statusArea.innerHTML = "";
        }
        statusArea.appendChild(_renderEasyDiagnosticEntry(ev.diagnostic.level, ev.diagnostic.message, ev.diagnostic.detail));
      }
      if (ev.type === "room_joined") {
        activeUnsub?.();
        activeUnsub = null;
        const room = ev.room;
        statusArea.innerHTML = "";
        _renderRoomCard(statusArea, room, { showLeaveBtn: true, easyMgr, isHost: false });
        btnJoin.textContent = "Joined ✓";
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

// ── Easy Netplay — Browse panel ───────────────────────────────────────────────

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
      "⚠ No server URL configured. Add one in Settings → Play Together to browse online rooms."
    ));
  }

  // Local / All filter toggle
  const filterWrap = make("div", { class: "enp-filter-row" });
  const filterBtns: HTMLButtonElement[] = [];
  const filters = [
    { id: "nearby", label: "📶 Nearby" },
    { id: "all",    label: "🌐 All Rooms" },
  ];
  if (gameRoomKey) {
    filters.splice(1, 0, { id: "this_game", label: "🎯 This Game" });
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
        : "No open rooms right now — be the first to create one!";
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
            ? "🔒 Private"
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
        const pingCls = ping <= 80 ? "good" : ping <= 200 ? "warn" : "bad";
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
            showInfoToast(`Code: ${room.code} — switch to the Join tab to connect`);
          }
        });
        card.appendChild(btnJoinRoom);
      }

      // Spectate button — shown on all open rooms regardless of fullness.
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
            showInfoToast(`Code: ${room.code} — open Watch tab or switch to Join tab`);
          }
        });
        card.appendChild(btnWatch);
      }

      frag.appendChild(card);
    }
    listEl.appendChild(frag);
  };

  // ── Auto-refresh countdown ──────────────────────────────────────────────────
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

  // Refresh function — skips network call when no server is configured.
  const doRefresh = async () => {
    if (!serverUrl) {
      renderRooms([]);
      return;
    }
    if (loadAbort) loadAbort.abort();
    loadAbort = new AbortController();
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing…";
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

// ── Easy Netplay — Watch (Spectator) panel ────────────────────────────────────

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
    placeholder:   "ABC123…",
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
      "⚠ No server URL configured. Spectating requires a server. Add one in Settings → Play Together."
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
    btnWatch.textContent = "Connecting…";
    statusArea.hidden   = false;
    statusArea.innerHTML = "";
    statusArea.appendChild(make("p", { class: "enp-diag enp-diag--info" }, "Connecting…"));

    activeUnsub?.();
    activeUnsub = easyMgr.onEvent(ev => {
      if (ev.type === "diagnostic") {
        if (statusArea.children.length === 1 && statusArea.children[0]!.textContent === "Connecting…") {
          statusArea.innerHTML = "";
        }
        statusArea.appendChild(_renderEasyDiagnosticEntry(ev.diagnostic.level, ev.diagnostic.message, ev.diagnostic.detail));
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
        info.appendChild(make("span", { class: "enp-active-room__name" }, `${room.isLocal ? "📶 Local" : "🌐 Online"} · ${room.playerCount}/${room.maxPlayers} players`));
        if (room.gameName) {
          info.appendChild(make("span", { class: "enp-active-room__detail" }, `Game: ${room.gameName}`));
        }
        if (spectatorCount > 0) {
          info.appendChild(make("span", { class: "enp-active-room__detail" }, `👁 ${spectatorCount} spectator${spectatorCount !== 1 ? "s" : ""}`));
        }
        card.appendChild(info);
        card.appendChild(make("p", { class: "enp-active-room__waiting" }, "👁 Spectating — watching the game…"));
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
        btnWatch.textContent = "Watching ✓";
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

function _renderEasyDiagnosticEntry(
  level: "info" | "warning" | "error",
  message: string,
  detail?: string,
): HTMLElement {
  const cls = `enp-diag enp-diag--${level === "error" ? "error" : level === "warning" ? "warn" : "info"}`;
  if (!detail) return make("p", { class: cls }, message);

  const wrap = make("div", { class: "enp-diag-wrap" });
  wrap.appendChild(make("p", { class: cls }, message));
  const info = make("details", { class: "enp-diag-detail" }) as HTMLDetailsElement;
  info.appendChild(make("summary", {}, "Technical details"));
  info.appendChild(make("pre", { class: "enp-diag-detail__text" }, detail));
  wrap.appendChild(info);
  return wrap;
}

// ── Easy Netplay — Room card ──────────────────────────────────────────────────

function _renderRoomCard(
  container: HTMLElement,
  room: EasyNetplayRoom,
  opts: { showLeaveBtn?: boolean; easyMgr?: EasyNetplayManager; isHost?: boolean }
): void {
  const card = make("div", { class: "enp-active-room" });

  // Invite code — prominent display (shown on host side so the code can be shared;
  // on the join side the user already has the code, but keep it visible for reference)
  const codeWrap = make("div", { class: "enp-active-room__code-wrap" });
  codeWrap.appendChild(make("span", { class: "enp-active-room__code-label" }, "Invite Code"));
  const codeEl = make("span", {
    class: "enp-active-room__code",
    title: "Click to copy",
  }, room.code);
  codeEl.addEventListener("click", () => {
    void navigator.clipboard?.writeText(room.code).then(() => {
      showInfoToast("Invite code copied!");
    }).catch(() => {
      showInfoToast(`Code: ${room.code}`);
    });
  });
  codeWrap.appendChild(codeEl);
  const copyBtn = make("button", {
    class:       "btn enp-copy-btn",
    "aria-label": "Copy invite code",
  }, "📋 Copy") as HTMLButtonElement;
  copyBtn.addEventListener("click", () => {
    void navigator.clipboard?.writeText(room.code).then(() => {
      showInfoToast("Invite code copied!");
    }).catch(() => {
      showInfoToast(`Code: ${room.code}`);
    });
  });
  codeWrap.appendChild(copyBtn);
  card.appendChild(codeWrap);

  // Room info
  const info = make("div", { class: "enp-active-room__info" });
  info.appendChild(make("span", { class: "enp-active-room__name" }, room.name));
  info.appendChild(make("span", { class: "enp-active-room__detail" },
    `${room.isLocal ? "📶 Local Network" : "🌐 Online"} · ${room.playerCount}/${room.maxPlayers} players`
  ));
  if (room.gameName) {
    info.appendChild(make("span", { class: "enp-active-room__detail" }, `Game: ${room.gameName}`));
  }
  card.appendChild(info);

  // Status line — differs for host vs. joiner.
  // All current call sites pass isHost explicitly; default to true so future
  // callers that omit it see the host-side "waiting" message.
  const isHost = opts.isHost ?? true;
  card.appendChild(make("p", {
    class: "enp-active-room__waiting",
  }, isHost ? "⏳ Waiting for Player 2…" : "✓ Joined room — waiting for the host to start…"));

  // Leave button
  if (opts.showLeaveBtn && opts.easyMgr) {
    const easyMgr = opts.easyMgr;
    const btnLeave = make("button", { class: "btn btn--danger enp-leave-btn" }, "Leave Room") as HTMLButtonElement;
    btnLeave.addEventListener("click", async () => {
      await easyMgr.leaveRoom();
      container.innerHTML = "";
      container.appendChild(make("p", { class: "enp-diag enp-diag--info" }, "You left the room."));
    });
    card.appendChild(btnLeave);
  }

  container.appendChild(card);
}

// ── Cloud save bar ────────────────────────────────────────────────────────────

// ── Cloud provider metadata ───────────────────────────────────────────────────

interface CloudProviderMeta {
  id:    string;
  label: string;
  icon:  string;
}

/** Providers supported for cloud *save* backup. */
const CLOUD_SAVE_PROVIDERS: CloudProviderMeta[] = [
  { id: "gdrive",  label: "Google Drive", icon: "🗂️" },
  { id: "dropbox", label: "Dropbox",      icon: "📦" },
  { id: "webdav",  label: "WebDAV",       icon: "🔗" },
  { id: "pcloud",  label: "pCloud",       icon: "🌐" },
  { id: "blomp",   label: "Blomp",        icon: "💧" },
  { id: "box",     label: "Box",          icon: "📫" },
];

/** Providers supported for cloud *library* sources (adds OneDrive). */
const CLOUD_LIBRARY_PROVIDERS: CloudProviderMeta[] = [
  { id: "gdrive",   label: "Google Drive", icon: "🗂️" },
  { id: "dropbox",  label: "Dropbox",      icon: "📦" },
  { id: "onedrive", label: "OneDrive",     icon: "☁️" },
  { id: "webdav",   label: "WebDAV",       icon: "🔗" },
  { id: "pcloud",   label: "pCloud",       icon: "🌐" },
  { id: "blomp",    label: "Blomp",        icon: "💧" },
  { id: "box",      label: "Box",          icon: "📫" },
];

/** Combined lookup table for display name resolution (dedupes gdrive, dropbox etc.). */
const ALL_CLOUD_PROVIDERS: CloudProviderMeta[] = [
  { id: "gdrive",   label: "Google Drive", icon: "🗂️" },
  { id: "dropbox",  label: "Dropbox",      icon: "📦" },
  { id: "onedrive", label: "OneDrive",     icon: "☁️" },
  { id: "webdav",   label: "WebDAV",       icon: "🔗" },
  { id: "pcloud",   label: "pCloud",       icon: "🌐" },
  { id: "blomp",    label: "Blomp",        icon: "💧" },
  { id: "box",      label: "Box",          icon: "📫" },
];

function getCloudProviderLabel(id: string): string {
  return ALL_CLOUD_PROVIDERS.find(p => p.id === id)?.label ?? id;
}


/**
 * Build the cloud-save bar shown at the top of the save-state gallery.
 * Renders current connection status, a Connect/Disconnect button,
 * and last-sync information.  Opens a provider selection dialog on "Connect".
 */
function buildCloudSaveBar(): HTMLElement {
  const cloudManager = getCloudSaveManager();
  const bar = make("div", { class: "cloud-bar" });

  const statusSection = make("div", { class: "cloud-bar__status" });
  const statusBody    = make("div", { class: "cloud-bar__status-body" });

  const statusText = make("span", {
    class: "cloud-bar__status-text",
    role: "status",
    "aria-live": "polite",
  });
  const lastSync   = make("span", {
    class: "cloud-bar__last-sync",
    "aria-live": "polite",
  });

  const actions = make("div", { class: "cloud-bar__actions" });

  const isConnected = cloudManager.isConnected();

  // Status text
  if (isConnected) {
    statusText.textContent = `${cloudManager.activeProvider.displayName} backup`;
    statusText.classList.add("cloud-bar__status-text--ok");
  } else {
    statusText.textContent = "Not connected";
  }

  // Last-sync hint or timestamp
  if (!isConnected) {
    lastSync.textContent = "Connect to sync saves across devices";
    lastSync.classList.add("cloud-bar__last-sync--hint");
  } else {
    const lastSyncAt = cloudManager.lastSyncAt;
    lastSync.textContent = lastSyncAt
      ? `Last sync: ${formatRelativeTime(lastSyncAt)}`
      : "Local saves will be mirrored here after your next save.";
  }

  statusBody.append(statusText, lastSync);
  statusSection.appendChild(statusBody);

  // Connect / Disconnect button
  if (isConnected) {
    const disconnectBtn = make("button", { class: "btn btn--sm" }, "Disconnect") as HTMLButtonElement;
    disconnectBtn.addEventListener("click", () => {
      cloudManager.disconnect();
      bar.replaceWith(buildCloudSaveBar());
    });
    actions.appendChild(disconnectBtn);
  } else {
    const connectBtn = make("button", { class: "btn btn--sm btn--primary" }, "☁ Connect") as HTMLButtonElement;
    connectBtn.addEventListener("click", () => {
      void showCloudConnectDialog().then(configured => {
        if (configured) bar.replaceWith(buildCloudSaveBar());
      });
    });
    actions.appendChild(connectBtn);
  }

  bar.append(statusSection, actions);
  return bar;
}

/**
 * Two-step cloud save backup wizard.
 *
 * Step 1 — pick a provider from a visual grid.
 * Step 2 — enter credentials appropriate for that provider.
 *
 * On success, saves credentials via CloudSaveManager helpers and calls
 * cloudManager.connect(provider).  Returns true when connected.
 */
function showCloudConnectDialog(): Promise<boolean> {
  const cloudManager = getCloudSaveManager();

  return new Promise((resolve) => {
    const overlay = make("div", { class: "confirm-overlay" });
    const box = make("div", {
      class: "confirm-box cloud-wizard-box",
      role:  "dialog",
      "aria-modal": "true",
      "aria-label": "Cloud Connection",
    });

    const close = (result: boolean) => {
      document.removeEventListener("keydown", onKeydown, { capture: true });
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), OVERLAY_FADE_DELAY_MS);
      resolve(result);
    };

    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
    };
    document.addEventListener("keydown", onKeydown, { capture: true });
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });

    // ── Step 1: Provider picker ───────────────────────────────────────────────

    const renderStep1 = () => {
      box.innerHTML = "";
      box.appendChild(make("h3", { class: "confirm-box__title" }, "Connect Cloud Save Backup"));
      box.appendChild(make("p", { class: "confirm-box__body" },
        "Choose a cloud provider to mirror save states across devices. Your local saves stay on this device; cloud backup keeps them in sync."
      ));

      const providerRow = make("div", { class: "settings-input-row" });
      const providerSel = make("select", { id: "csd-provider", class: "settings-input" }) as HTMLSelectElement;
      for (const p of CLOUD_SAVE_PROVIDERS) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = `${p.icon} ${p.label}`;
        providerSel.appendChild(opt);
      }
      providerRow.append(make("label", { class: "settings-input-label", for: "csd-provider" }, "Provider"), providerSel);
      box.appendChild(providerRow);

      const actions = make("div", { class: "confirm-box__actions" });
      const cancelBtn = make("button", { class: "btn" }, "Cancel") as HTMLButtonElement;
      const nextBtn   = make("button", { class: "btn btn--primary" }, "Next →") as HTMLButtonElement;
      cancelBtn.addEventListener("click", () => close(false));
      nextBtn.addEventListener("click", () => renderStep2(providerSel.value));
      actions.append(cancelBtn, nextBtn);
      box.appendChild(actions);
    };

    // ── Step 2: Credential form ───────────────────────────────────────────────

    const renderStep2 = (providerId: string) => {
      box.innerHTML = "";
      const meta = CLOUD_SAVE_PROVIDERS.find(p => p.id === providerId)!;
      box.appendChild(make("h3", { class: "confirm-box__title" }, `Connect ${meta.label}`));

      const form = make("div", { class: "cloud-wizard-form" });

      type CredResult = { ok: false; error: string } | { ok: true; data: Record<string, string> };
      let getCredentials: () => CredResult = () => ({ ok: true, data: {} });

      if (providerId === "webdav") {
        const urlRow  = make("div", { class: "settings-input-row" });
        const urlInp  = make("input", { type: "url",  id: "csd-url",  class: "settings-input", placeholder: "https://dav.example.com/saves", autocomplete: "off" }) as HTMLInputElement;
        urlRow.append(make("label", { class: "settings-input-label", for: "csd-url" }, "Server URL"), urlInp);

        const userRow = make("div", { class: "settings-input-row" });
        const userInp = make("input", { type: "text", id: "csd-user", class: "settings-input", placeholder: "Username", autocomplete: "username" }) as HTMLInputElement;
        userRow.append(make("label", { class: "settings-input-label", for: "csd-user" }, "Username"), userInp);

        const passRow = make("div", { class: "settings-input-row" });
        const passInp = make("input", { type: "password", id: "csd-pass", class: "settings-input", placeholder: "Password", autocomplete: "current-password" }) as HTMLInputElement;
        passRow.append(make("label", { class: "settings-input-label", for: "csd-pass" }, "Password"), passInp);

        form.append(urlRow, userRow, passRow);
        getCredentials = () => {
          const url  = urlInp.value.trim();
          const user = userInp.value.trim();
          const pass = passInp.value;
          if (!url)  return { ok: false, error: "Server URL is required." };
          if (!user) return { ok: false, error: "Username is required." };
          return { ok: true, data: { url, user, pass } };
        };

      } else if (providerId === "pcloud") {
        const tokenRow = make("div", { class: "settings-input-row" });
        const tokenInp = make("input", { type: "text", id: "csd-token", class: "settings-input", placeholder: "pCloud access token", autocomplete: "off" }) as HTMLInputElement;
        tokenRow.append(make("label", { class: "settings-input-label", for: "csd-token" }, "Access Token"), tokenInp);

        const regionRow = make("div", { class: "settings-input-row" });
        const regionSel = make("select", { id: "csd-region", class: "settings-input" }) as HTMLSelectElement;
        regionSel.appendChild(Object.assign(document.createElement("option"), { value: "us", textContent: "US" }));
        regionSel.appendChild(Object.assign(document.createElement("option"), { value: "eu", textContent: "EU" }));
        regionRow.append(make("label", { class: "settings-input-label", for: "csd-region" }, "Region"), regionSel);

        form.append(tokenRow, regionRow);
        getCredentials = () => {
          const token  = tokenInp.value.trim();
          if (!token) return { ok: false, error: "Access token is required." };
          return { ok: true, data: { token, region: regionSel.value } };
        };

      } else if (providerId === "blomp") {
        const userRow = make("div", { class: "settings-input-row" });
        const userInp = make("input", { type: "text", id: "csd-user", class: "settings-input", placeholder: "Blomp username", autocomplete: "username" }) as HTMLInputElement;
        userRow.append(make("label", { class: "settings-input-label", for: "csd-user" }, "Username"), userInp);

        const passRow = make("div", { class: "settings-input-row" });
        const passInp = make("input", { type: "password", id: "csd-pass", class: "settings-input", placeholder: "Password", autocomplete: "current-password" }) as HTMLInputElement;
        passRow.append(make("label", { class: "settings-input-label", for: "csd-pass" }, "Password"), passInp);

        const containerRow = make("div", { class: "settings-input-row" });
        const containerInp = make("input", { type: "text", id: "csd-container", class: "settings-input", placeholder: "retrovault", autocomplete: "off" }) as HTMLInputElement;
        containerRow.append(make("label", { class: "settings-input-label", for: "csd-container" }, "Container (optional)"), containerInp);

        form.append(userRow, passRow, containerRow);
        getCredentials = () => {
          const user      = userInp.value.trim();
          const pass      = passInp.value;
          const container = containerInp.value.trim() || "retrovault";
          if (!user) return { ok: false, error: "Username is required." };
          return { ok: true, data: { user, pass, container } };
        };

      } else if (providerId === "box") {
        const tokenRow = make("div", { class: "settings-input-row" });
        const tokenInp = make("input", { type: "text", id: "csd-token", class: "settings-input", placeholder: "Box OAuth access token", autocomplete: "off" }) as HTMLInputElement;
        tokenRow.append(make("label", { class: "settings-input-label", for: "csd-token" }, "Access Token"), tokenInp);

        const folderRow = make("div", { class: "settings-input-row" });
        const folderInp = make("input", { type: "text", id: "csd-folder", class: "settings-input", placeholder: "0 (root)", autocomplete: "off" }) as HTMLInputElement;
        folderRow.append(make("label", { class: "settings-input-label", for: "csd-folder" }, "Root Folder ID (optional)"), folderInp);

        form.append(tokenRow, folderRow);
        getCredentials = () => {
          const token    = tokenInp.value.trim();
          const folderId = folderInp.value.trim() || "0";
          if (!token) return { ok: false, error: "Access token is required." };
          return { ok: true, data: { token, folderId } };
        };

      } else {
        // gdrive, dropbox — just need an OAuth access token
        const tokenRow = make("div", { class: "settings-input-row" });
        const tokenInp = make("input", { type: "text", id: "csd-token", class: "settings-input", placeholder: `${meta.label} access token`, autocomplete: "off" }) as HTMLInputElement;
        tokenRow.append(make("label", { class: "settings-input-label", for: "csd-token" }, "Access Token"), tokenInp);
        form.appendChild(tokenRow);
        getCredentials = () => {
          const token = tokenInp.value.trim();
          if (!token) return { ok: false, error: "Access token is required." };
          return { ok: true, data: { token } };
        };
      }

      box.appendChild(form);

      const errorMsg = make("p", { class: "cloud-wizard-error", "aria-live": "assertive" });
      errorMsg.hidden = true;
      box.appendChild(errorMsg);

      const actions = make("div", { class: "confirm-box__actions" });
      const backBtn    = make("button", { class: "btn" }, "← Back") as HTMLButtonElement;
      const connectBtn = make("button", { class: "btn btn--primary" }, "Connect") as HTMLButtonElement;
      actions.append(backBtn, connectBtn);
      box.appendChild(actions);

      backBtn.addEventListener("click", () => renderStep1());

      connectBtn.addEventListener("click", async () => {
        const creds = getCredentials();
        if (!creds.ok) {
          errorMsg.textContent = creds.error;
          errorMsg.hidden = false;
          return;
        }
        errorMsg.hidden = true;
        connectBtn.disabled = true;
        connectBtn.textContent = "Connecting…";

        try {
          let provider;
          const d = creds.data;
          if (providerId === "webdav") {
            cloudManager.saveWebDAVConfig(d["url"]!, d["user"]!, d["pass"]!);
            provider = new WebDAVProvider(d["url"]!, d["user"]!, d["pass"]!);
          } else if (providerId === "gdrive") {
            cloudManager.saveGDriveConfig(d["token"]!);
            provider = new GoogleDriveProvider(d["token"]!);
          } else if (providerId === "dropbox") {
            cloudManager.saveDropboxConfig(d["token"]!);
            provider = new DropboxProvider(d["token"]!);
          } else if (providerId === "pcloud") {
            cloudManager.savePCloudConfig(d["token"]!, d["region"] as "us" | "eu");
            provider = new pCloudProvider(d["token"]!, d["region"] as "us" | "eu");
          } else if (providerId === "blomp") {
            cloudManager.saveBlompConfig(d["user"]!, d["pass"]!, d["container"]!);
            provider = new BlompProvider(d["user"]!, d["pass"]!, d["container"]!);
          } else if (providerId === "box") {
            cloudManager.saveBoxConfig(d["token"]!, d["folderId"]!);
            provider = new BoxProvider(d["token"]!, d["folderId"]!);
          } else {
            throw new Error("Unknown provider.");
          }
          await cloudManager.connect(provider);
          close(true);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "Connection failed.";
          errorMsg.textContent = msg;
          errorMsg.hidden = false;
          connectBtn.disabled = false;
          connectBtn.textContent = "Connect";
        }
      });
    };

    // Kick off step 1
    renderStep1();

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("confirm-overlay--visible"));
  });
}

// ── Multiplayer tab ───────────────────────────────────────────────────────────

function buildMultiplayerTab(
  container:        HTMLElement,
  settings:         Settings,
  onSettingsChange: (patch: Partial<Settings>) => void,
  getNetplayManager?: () => Promise<import("./multiplayer.js").NetplayManager>,
  currentGameName?: string | null,
  currentSystemId?: string | null,
): void {
  // Use peek for immediate status checks to avoid eager loading the manager
  peekNetplayManager();
  let currentEnabled = settings.netplayEnabled;
  let currentServerUrl = settings.netplayServerUrl.trim();

  const validateServerUrl = (url: string): string | null => {
    const netplayManager = peekNetplayManager();
    if (netplayManager) return netplayManager.validateServerUrl(url);
    const trimmed = url.trim();
    if (trimmed.length === 0) return null;
    if (!/^wss?:\/\//i.test(trimmed)) {
      return "Server URL must start with ws:// or wss://";
    }
    try {
      new URL(trimmed);
    } catch {
      return "Server URL is not a valid URL";
    }
    return null;
  };

  const validateUsername = (name: string): string | null => {
    const netplayManager = peekNetplayManager();
    if (netplayManager) return netplayManager.validateUsername(name);
    return name.trim().length > 32 ? "Display name must be 32 characters or fewer" : null;
  };

  const getNetplayStatus = (): {
    enabled: boolean;
    hasUrl: boolean;
    ready: boolean;
  } => {
    const enabled = currentEnabled;
    const hasUrl = currentServerUrl.length > 0;
    const ready = enabled && hasUrl && !validateServerUrl(currentServerUrl);
    return { enabled, hasUrl, ready };
  };

  // Sync-first helper: calls a method on the manager synchronously if already loaded,
  // otherwise falls back to the async factory. This keeps tests synchronous.
  const callNm = (fn: (m: import("./multiplayer.js").NetplayManager) => void): void => {
    const nm = peekNetplayManager();
    if (nm) { fn(nm); }
    else if (getNetplayManager) { void getNetplayManager().then(fn); }
  };

  // Intro section
  const introSection = make("div", { class: "settings-section" });
  introSection.appendChild(make("h4", { class: "settings-section__title" }, "Online play with friends"));
  introSection.appendChild(make("p", { class: "settings-help" },
    "RetroVault Play Together lets you play the same game with someone else over the internet. Turn on Online play below, paste the WebSocket URL from whoever runs your server, " +
    "then use Multiplayer on the home screen or Online in the game toolbar to host or join."
  ));

  // Status badge — shows whether netplay is ready to use
  const statusBadge = make("span", { class: "netplay-status-pill netplay-status-pill--inactive" });
  const updateStatusBadge = () => {
    const { enabled, hasUrl, ready } = getNetplayStatus();
    statusBadge.textContent = ready
      ? "Ready to play online"
      : enabled && !hasUrl
        ? "Add a server URL"
        : !enabled && hasUrl
          ? "Turn on Online play"
          : "Not set up yet";
    statusBadge.className = ready
      ? "netplay-status-pill netplay-status-pill--active"
      : "netplay-status-pill netplay-status-pill--inactive";
  };
  updateStatusBadge();
  introSection.appendChild(statusBadge);

  // Enable toggle
  introSection.appendChild(buildToggleRow(
    "Online play",
    "Shows Play Together on the home screen and Online in the game toolbar. In-game Wi-Fi or WFC features inside a ROM are separate from this setting.",
    settings.netplayEnabled,
    (v) => {
      currentEnabled = v;
      onSettingsChange({ netplayEnabled: v });
      callNm(m => m.setEnabled(v));
      serverSection.hidden = !v;
      updateStatusBadge();
    }
  ));

  container.appendChild(introSection);

  // Server URL section — hidden when netplay is disabled
  const serverSection = make("div", { class: "settings-section" });
  serverSection.hidden = !settings.netplayEnabled;
  serverSection.appendChild(make("h4", { class: "settings-section__title" }, "Server address"));
  serverSection.appendChild(make("p", { class: "settings-help" },
    "Paste the full WebSocket URL for your Play Together server (for example wss://games.example.com:443/netplay). " +
    "Include the port if your host gave you one (e.g. :3000). Everyone in the session must use the exact same address."
  ));

  const urlRow   = make("div", { class: "settings-input-row" });
  const urlLabel = make("label", { class: "settings-input-label", for: "netplay-server-url" }, "WebSocket URL (wss:// or ws://)");
  const urlInput = make("input", {
    type:         "text",
    id:           "netplay-server-url",
    name:         "netplayServerUrl",
    class:        "settings-input",
    placeholder:  "wss://netplay.example.com/room…",
    value:        settings.netplayServerUrl,
    autocomplete: "off",
    autocorrect:  "off",
    autocapitalize: "none",
    spellcheck:   "false",
  }) as HTMLInputElement;
  urlInput.addEventListener("input", () => urlInput.setCustomValidity(""));
  urlInput.addEventListener("change", () => {
    const url = urlInput.value.trim();
    const err = validateServerUrl(url);
    if (err) {
      urlInput.setCustomValidity(err);
      urlInput.reportValidity();
      return;
    }
    urlInput.setCustomValidity("");
    currentServerUrl = url;
    const patch: Partial<Settings> = { netplayServerUrl: url };
    if (!currentEnabled) {
      currentEnabled = true;
      patch.netplayEnabled = true;
      callNm(m => m.setEnabled(true));
      serverSection.hidden = false;
      const toggleInput = introSection.querySelector<HTMLInputElement>(".toggle-row input[type=checkbox]");
      if (toggleInput) toggleInput.checked = true;
    }
    onSettingsChange(patch);
    callNm(m => m.setServerUrl(url));
    updateStatusBadge();
  });
  urlInput.addEventListener("input", () => urlInput.setCustomValidity(""));
  urlRow.append(urlLabel, urlInput);
  serverSection.appendChild(urlRow);

  // Username / display name row
  const unameRow   = make("div", { class: "settings-input-row" });
  const unameLabel = make("label", { class: "settings-input-label", for: "netplay-username" }, "Display Name");
  const unameInput = make("input", {
    type:         "text",
    id:           "netplay-username",
    name:         "netplayUsername",
    class:        "settings-input",
    placeholder:  "Display name (optional)…",
    value:        settings.netplayUsername,
    autocomplete: "nickname",
    autocorrect:  "off",
    autocapitalize: "words",
    spellcheck:   "false",
    maxlength:    "32",
  }) as HTMLInputElement;
  unameInput.addEventListener("input", () => unameInput.setCustomValidity(""));
  unameInput.addEventListener("change", () => {
    const name = unameInput.value.trim();
    const err = validateUsername(name);
    if (err) {
      unameInput.setCustomValidity(err);
      unameInput.reportValidity();
      return;
    }
    unameInput.setCustomValidity("");
    onSettingsChange({ netplayUsername: name });
    callNm(m => m.setUsername(name));
  });
  unameRow.append(unameLabel, unameInput);
  serverSection.appendChild(unameRow);
  serverSection.appendChild(make("p", { class: "settings-help" },
    "Optional name shown to other players in the netplay lobby. Leave blank to appear as anonymous."
  ));

  // ICE / STUN section — collapsed by default as an Advanced disclosure
  const iceDetails = make("details", { class: "netplay-advanced" }) as HTMLDetailsElement;
  const iceSummary = make("summary", {}, "Advanced: Connection Servers (STUN / ICE)");
  iceDetails.appendChild(iceSummary);

  const iceContent = make("div", { class: "netplay-advanced-content" });
  iceContent.appendChild(make("p", { class: "settings-help" },
    "Google STUN servers are used by default for WebRTC hole-punching. " +
    "For networks with strict symmetric NAT, add a TURN server (e.g. turn:turn.example.com:3478)."
  ));

  // Mutable local copy — kept in sync with NetplayManager on every change
  let iceServers: RTCIceServer[] = [...(peekNetplayManager()?.iceServers ?? DEFAULT_ICE_SERVERS)];

  // List of current entries, rebuilt on every mutation
  const iceList = make("div", { class: "netplay-ice-list" });
  const renderIceList = () => {
    iceList.innerHTML = "";
    if (iceServers.length === 0) {
      iceList.appendChild(make("p", { class: "netplay-ice-empty" },
        "No ICE servers configured — peer connections may fail."
      ));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const srv of iceServers) {
      const urls   = Array.isArray(srv.urls) ? srv.urls : [srv.urls];
      const urlStr = urls.join(", ");
      const row = make("div", { class: "netplay-ice-row" });
      row.appendChild(make("span", { class: "netplay-ice-url" }, urlStr));
      const removeBtn = make("button", {
        class: "btn netplay-ice-remove",
        "aria-label": `Remove ${urlStr}`,
      }, "✕") as HTMLButtonElement;
      removeBtn.addEventListener("click", () => {
        const idx = iceServers.indexOf(srv);
        if (idx !== -1) iceServers.splice(idx, 1);
        callNm(m => m.setIceServers([...iceServers]));
        renderIceList();
      });
      row.appendChild(removeBtn);
      fragment.appendChild(row);
    }
    iceList.appendChild(fragment);
  };
  renderIceList();
  iceContent.appendChild(iceList);

  // Add-server row
  const addRow = make("div", { class: "settings-input-row" });
  const addInput = make("input", {
    type:         "text",
    id:           "netplay-ice-add",
    name:         "iceServerUrl",
    class:        "settings-input",
    placeholder:  "stun:stun.example.com:3478…",
    "aria-label": "New ICE server URL",
    autocomplete: "off",
    autocorrect:  "off",
    autocapitalize: "none",
    spellcheck:   "false",
  }) as HTMLInputElement;
  const addBtn = make("button", { class: "btn btn--primary" }, "Add") as HTMLButtonElement;
  addBtn.addEventListener("click", () => {
    const url = addInput.value.trim();
    if (!url) return;
    const netplayManager = peekNetplayManager();
    const err = netplayManager
      ? netplayManager.validateIceServerUrl(url)
      : standaloneValidateIceServerUrl(url);
    if (err) {
      addInput.setCustomValidity(err);
      addInput.reportValidity();
      return;
    }
    addInput.setCustomValidity("");
    iceServers.push({ urls: url });
    callNm(m => m.setIceServers([...iceServers]));
    addInput.value = "";
    renderIceList();
  });
  addInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addBtn.click();
  });
  addInput.addEventListener("input", () => addInput.setCustomValidity(""));
  addRow.append(addInput, addBtn);
  iceContent.appendChild(addRow);

  // Reset-to-defaults button
  const resetBtn = make("button", { class: "btn settings-clear-btn" }, "Reset to defaults") as HTMLButtonElement;
  resetBtn.addEventListener("click", () => {
    callNm(m => m.resetIceServers());
    iceServers = [...DEFAULT_ICE_SERVERS];
    renderIceList();
  });
  iceContent.appendChild(resetBtn);

  iceDetails.appendChild(iceContent);
  serverSection.appendChild(iceDetails);

  container.append(serverSection);

  // Lobby browser section — visible only when netplay is active
  const lobbySection = make("div", { class: "settings-section netplay-lobby" });
  lobbySection.hidden = !getNetplayStatus().ready;
  lobbySection.appendChild(make("h4", { class: "settings-section__title" }, "Room Browser"));

  // Show game-scope hint — if a game is running, name it; otherwise give
  // a generic prompt so the user knows rooms are per-game.
  const lobbyScopeHint = currentGameName
    ? `Showing rooms for: ${currentGameName}`
    : "Open a game and come back here to see rooms for that title.";
  lobbySection.appendChild(make("p", { class: "settings-help" }, lobbyScopeHint));

  const lobbyRoomList = make("div", { class: "netplay-lobby-list" });
  let lobbyAbort: AbortController | null = null;
  let lobbyAutoRefreshTimer: ReturnType<typeof setInterval> | null = null;
  const lobbyLastRefreshed = make("p", { class: "netplay-lobby-timestamp" });

  // Tracks the room currently selected in the lobby list
  let selectedLobbyRoom: import("./multiplayer.js").NetplayLobbyRoom | null = null;
  // Reference to the Join button — set later, updated by syncJoinBtn()
  let joinBtnRef: HTMLButtonElement | null = null;
  const syncJoinBtn = () => {
    if (!joinBtnRef) return;
    joinBtnRef.disabled = !selectedLobbyRoom;
    joinBtnRef.title = selectedLobbyRoom
      ? `Join "${selectedLobbyRoom.name || "selected room"}"`
      : "Select a room above to join";
  };

  const renderLobbyRooms = (rooms: import("./multiplayer.js").NetplayLobbyRoom[]) => {
    lobbyRoomList.innerHTML = "";
    selectedLobbyRoom = null;
    syncJoinBtn();
    if (rooms.length === 0) {
      lobbyRoomList.appendChild(make("p", { class: "netplay-lobby-empty" },
        "No open rooms right now — be the first to create one!"
      ));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const room of rooms) {
      const row = make("div", { class: "netplay-lobby-row" });

      // Room name with lock icon for password-protected rooms
      const nameEl = make("span", { class: "netplay-lobby-name" },
        room.name ?? `Room ${room.id}`
      );
      if (room.hasPassword) {
        nameEl.appendChild(document.createTextNode(" 🔒"));
      }

      // Status chip: Full > Locked > Open
      const isFull = room.players !== undefined && room.maxPlayers !== undefined
        && room.players >= room.maxPlayers;
      const statusVariant = isFull ? "full" : room.hasPassword ? "locked" : "open";
      const statusLabel   = isFull ? "Full" : room.hasPassword ? "Password" : "Open";
      const statusChip = make("span", {
        class: `netplay-room-status netplay-room-status--${statusVariant}`,
      }, statusLabel);

      // Host
      const hostEl = room.host
        ? make("span", { class: "netplay-lobby-host" }, room.host)
        : null;

      // Player count — compact "2/4" format
      const playersEl = (room.players !== undefined)
        ? make("span", { class: "netplay-lobby-players" },
            room.maxPlayers !== undefined
              ? `${room.players}/${room.maxPlayers}`
              : `${room.players}`
          )
        : null;

      // Latency with color severity: ≤80 ms green, ≤200 ms yellow, >200 ms red
      let latencyEl: HTMLElement | null = null;
      if (room.latencyMs !== undefined) {
        const ms = Math.round(room.latencyMs);
        const latencyVariant = ms <= 80 ? "good" : ms <= 200 ? "warn" : "bad";
        latencyEl = make("span", {
          class: `netplay-lobby-latency netplay-lobby-latency--${latencyVariant}`,
          title: "Round-trip latency",
        }, `${ms} ms`);
      }

      row.appendChild(nameEl);
      row.appendChild(statusChip);
      if (hostEl)    row.appendChild(hostEl);
      if (playersEl) row.appendChild(playersEl);
      if (latencyEl) row.appendChild(latencyEl);

      // Click-to-select: highlight the row and enable the Join button
      row.addEventListener("click", () => {
        lobbyRoomList.querySelectorAll<HTMLElement>(".netplay-lobby-row--selected")
          .forEach(el => el.classList.remove("netplay-lobby-row--selected"));
        row.classList.add("netplay-lobby-row--selected");
        selectedLobbyRoom = room;
        syncJoinBtn();
      });

      fragment.appendChild(row);
    }
    lobbyRoomList.appendChild(fragment);
  };
  renderLobbyRooms([]);
  lobbySection.appendChild(lobbyRoomList);

  const lobbyFooter = make("div", { class: "netplay-lobby-footer" });
  const refreshBtn = make("button", {
    class: "btn btn--primary netplay-lobby-refresh",
    "aria-label": "Refresh room list",
  }) as HTMLButtonElement;
  refreshBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.49-4.5"/></svg> Refresh`;

  const doLobbyRefresh = async () => {
    const netplayManager = peekNetplayManager();
    if (!netplayManager) return;
    // If the lobby section has been removed from the DOM (e.g. settings panel was
    // rebuilt) or is inside a hidden ancestor (e.g. settings panel was closed),
    // clear the stale interval and bail out so we don't mutate detached/hidden
    // elements or keep making unnecessary network requests.
    if (!lobbySection.isConnected || !!lobbySection.closest("[hidden]")) {
      if (lobbyAutoRefreshTimer) {
        clearInterval(lobbyAutoRefreshTimer);
        lobbyAutoRefreshTimer = null;
      }
      if (lobbyAbort) {
        lobbyAbort.abort();
        lobbyAbort = null;
      }
      return;
    }
    if (lobbyAbort) lobbyAbort.abort();
    lobbyAbort = new AbortController();
    refreshBtn.disabled = true;
    refreshBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.49-4.5"/></svg> Refreshing…`;
    lobbyLastRefreshed.textContent = "";

    // Show skeleton rows while loading
    lobbyRoomList.innerHTML = "";
    const skelFrag = document.createDocumentFragment();
    for (let i = 0; i < 3; i++) {
      const skel = make("div", { class: "netplay-lobby-skeleton" });
      skel.appendChild(make("div", { class: "netplay-lobby-skeleton__bar netplay-lobby-skeleton__bar--grow" }));
      skel.appendChild(make("div", { class: "netplay-lobby-skeleton__bar netplay-lobby-skeleton__bar--medium" }));
      skel.appendChild(make("div", { class: "netplay-lobby-skeleton__bar netplay-lobby-skeleton__bar--short" }));
      skelFrag.appendChild(skel);
    }
    lobbyRoomList.appendChild(skelFrag);

    try {
      const rooms = await netplayManager.fetchLobbyRooms(lobbyAbort.signal);
      renderLobbyRooms(rooms);
      const now = new Date();
      lobbyLastRefreshed.textContent =
        `Updated ${now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
    } catch (err) {
      // AbortError means the user clicked Refresh again — not a real failure.
      if (err instanceof Error && err.name === "AbortError") return;
      console.warn("[RetroVault] Lobby fetch failed:", err);
      lobbyRoomList.innerHTML = "";
      lobbyRoomList.appendChild(make("p", { class: "netplay-lobby-error" },
        "Couldn't reach the server. Check your connection and server URL, then try again."
      ));
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.49-4.5"/></svg> Refresh`;
    }
  };

  refreshBtn.addEventListener("click", doLobbyRefresh);

  const autoNote = make("p", { class: "netplay-auto-note" }, "auto-refreshes every 30 s");
  lobbyFooter.append(refreshBtn, lobbyLastRefreshed, autoNote);
  lobbySection.appendChild(lobbyFooter);

  // Keep the lobby section visibility in sync with enable/server-URL changes.
  // When the section transitions from hidden → visible, trigger an auto-refresh
  // so the user immediately sees current rooms without a manual click.
  const syncLobbyVisibility = () => {
    const wasHidden = lobbySection.hidden;
    const netplayManager = peekNetplayManager();
    const nowActive = netplayManager?.isActive ?? false;
    lobbySection.hidden = !nowActive;
    if (wasHidden && nowActive) {
      void doLobbyRefresh();
      // Start 30-second auto-refresh interval
      if (lobbyAutoRefreshTimer) clearInterval(lobbyAutoRefreshTimer);
      lobbyAutoRefreshTimer = setInterval(() => { void doLobbyRefresh(); }, 30_000);
    } else if (!nowActive && lobbyAutoRefreshTimer) {
      clearInterval(lobbyAutoRefreshTimer);
      lobbyAutoRefreshTimer = null;
    }
  };
  introSection.addEventListener("change", syncLobbyVisibility);
  urlInput.addEventListener("change", syncLobbyVisibility);

  container.append(lobbySection);

  // === Supported systems section ============================================
  const supportedSysSection = make("div", { class: "settings-section" });
  supportedSysSection.appendChild(make("h4", { class: "settings-section__title" }, "Supported Systems"));
  supportedSysSection.appendChild(make("p", { class: "settings-help" },
    "RetroVault Play Together is available for the systems below. Other systems still run in the app, but online multiplayer is not yet supported there."
  ));
  const supportedSysList = make("div", { class: "netplay-sys-list" });
  for (const sysId of NETPLAY_SUPPORTED_SYSTEM_IDS) {
    const sysInfo = getSystemById(sysId);
    const chip = make("span", { class: "sys-chip" }, sysInfo?.shortName ?? sysId.toUpperCase());
    if (sysInfo) chip.title = sysInfo.name;
    supportedSysList.appendChild(chip);
  }
  supportedSysSection.appendChild(supportedSysList);
  container.appendChild(supportedSysSection);

  // === Current game compatibility section ====================================
  if (currentGameName && currentSystemId) {
    const gameCompatSection = make("div", { class: "settings-section" });
    gameCompatSection.appendChild(make("h4", { class: "settings-section__title" }, "Current Game"));

    const isNetplaySystem = (NETPLAY_SUPPORTED_SYSTEM_IDS as readonly string[]).includes(currentSystemId);
    const isLinkCapable   = SYSTEM_LINK_CAPABILITIES[currentSystemId] === true;

    if (!isNetplaySystem || !isLinkCapable) {
      const sysName = getSystemById(currentSystemId)?.name ?? currentSystemId.toUpperCase();
      gameCompatSection.appendChild(make("p", { class: "settings-help" },
        `This system (${sysName}) does not currently support netplay in this app. RetroVault Play Together isn't available for it yet.`
      ));
    } else {
      const roomKey     = resolveNetplayRoomKey(currentGameName, currentSystemId);
      const displayName = roomDisplayNameForKey(roomKey);
      const hasCompatRoom = displayName !== roomKey;

      const gameRow = make("div", { class: "netplay-game-info-row" });
      gameRow.appendChild(make("span", { class: "netplay-game-name" }, currentGameName));
      if (hasCompatRoom) {
        gameRow.appendChild(make("span", { class: "netplay-compat-badge" }, displayName));
      }
      gameCompatSection.appendChild(gameRow);
      gameCompatSection.appendChild(make("p", { class: "settings-help" },
        hasCompatRoom
          ? "This game can share rooms with compatible versions. Players on paired versions will appear in the same lobby."
          : "This game uses a unique room key. Only players with the same ROM will appear in the same lobby."
      ));
    }
    container.appendChild(gameCompatSection);
  }

  // === Room actions section ==================================================
  const roomSection = make("div", { class: "settings-section" });
  roomSection.appendChild(make("h4", { class: "settings-section__title" }, "Room Actions"));

  if (!getNetplayStatus().ready) {
    roomSection.appendChild(make("p", { class: "settings-help" },
      "Server URL is required — enable Online play and add a server URL above to start playing with others."
    ));
  } else {
    const hasGame = !!currentGameName;
    roomSection.appendChild(make("p", { class: "settings-help" },
      hasGame
        ? `Use the Online button in the toolbar while playing ${currentGameName} to create or join a room. RetroVault Play Together uses a separate lobby from in-game Wi-Fi features.`
        : "Open a game, then use the Online button in the toolbar to create or join a room. RetroVault Play Together uses a separate lobby from in-game Wi-Fi features."
    ));
    const actionRow = make("div", { class: "netplay-room-actions" });
    const createBtn = make("button", {
      class: "btn btn--primary netplay-create-room",
      title: "Start a game and use the Online button to create a Play Together room",
    }) as HTMLButtonElement;
    createBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Create Room`;
    const joinBtn = make("button", {
      class: "btn netplay-join-room",
      title: "Select a room above to join",
      disabled: "",
    }) as HTMLButtonElement;
    joinBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg> Join Room`;
    // Wire the join button to the selection tracker in the lobby browser
    joinBtnRef = joinBtn;
    syncJoinBtn();
    createBtn.addEventListener("click", () => {
      showInfoToast(
        hasGame
          ? `Use the Online button in the toolbar to create a room for ${currentGameName}.`
          : "Start a game first, then use the Online button in the toolbar to create a room."
      );
    });
    joinBtn.addEventListener("click", () => {
      const room = selectedLobbyRoom;
      showInfoToast(
        room
          ? `Start "${currentGameName || "the game"}" — the app will connect you to "${room.name ?? "the selected room"}".`
          : "Select a room in the Room Browser above, then start the same game to join it."
      );
    });
    actionRow.append(createBtn, joinBtn);
    roomSection.appendChild(actionRow);
  }
  container.appendChild(roomSection);
}

function buildDebugTab(
  container:        HTMLElement,
  settings:         Settings,
  onSettingsChange: (patch: Partial<Settings>) => void,
  deviceCaps:       DeviceCapabilities,
  emulatorRef?:     import("./emulator.js").PSPEmulator,
  getNetplayManager?: () => Promise<import("./multiplayer.js").NetplayManager>,
  biosLibrary?:     BiosLibrary
): void {
  // Settings section
  const settingsSection = make("div", { class: "settings-section" });
  settingsSection.appendChild(make("h4", { class: "settings-section__title" }, "Advanced Settings"));
  settingsSection.appendChild(make("p", { class: "settings-help" },
    "These settings are for troubleshooting. You don't normally need to change them."
  ));

  settingsSection.appendChild(buildToggleRow(
    "Detailed logging",
    "Write extra diagnostic information to the browser console — helpful when reporting issues",
    settings.verboseLogging,
    (v) => onSettingsChange({ verboseLogging: v })
  ));

  // Environment section
  const envSection = make("div", { class: "settings-section" });
  envSection.appendChild(make("h4", { class: "settings-section__title" }, "Environment"));

  const isIsolated = "crossOriginIsolated" in self ? self.crossOriginIsolated : false;
  const hasSAB     = typeof SharedArrayBuffer !== "undefined";
  const hasWasm    = typeof WebAssembly !== "undefined";

  envSection.appendChild(make("p", { class: "device-info" },
    `Cross-Origin Isolated: ${isIsolated ? "✓ Yes (PSP supported)" : "✗ No — PSP games will fail (reload after coi-serviceworker.js)"}`
  ));
  envSection.appendChild(make("p", { class: "device-info" },
    `SharedArrayBuffer: ${hasSAB ? "✓ Available" : "✗ Not available"}`
  ));
  envSection.appendChild(make("p", { class: "device-info" },
    `WebAssembly: ${hasWasm ? "✓ Available" : "✗ Not available"}`
  ));

  if (getNetplayManager) {
    const netplayStatus = make("p", { class: "device-info" }, "Checking Play Together status…");
    envSection.appendChild(netplayStatus);
    getNetplayManager().then(nm => {
      // NetplayManager doesn't have isConnected/isEnabled, it has enabled and isActive
      netplayStatus.textContent = nm.isActive
        ? "Play Together: Active and configured"
        : nm.enabled
        ? "Play Together: Enabled but server missing"
        : "Play Together: Disabled";
    }).catch(() => {
      netplayStatus.textContent = "Play Together: Error loading manager";
    });
  }
  envSection.appendChild(make("p", { class: "device-info" },
    `User Agent: ${navigator.userAgent}`
  ));

  // GPU & VRAM section
  const gpuSection = make("div", { class: "settings-section" });
  gpuSection.appendChild(make("h4", { class: "settings-section__title" }, "GPU & Memory"));
  gpuSection.appendChild(make("p", { class: "device-info" },
    `GPU: ${deviceCaps.gpuCaps.renderer}`
  ));
  gpuSection.appendChild(make("p", { class: "device-info" },
    `Estimated VRAM: ${deviceCaps.estimatedVRAMMB} MB`
  ));
  gpuSection.appendChild(make("p", { class: "device-info" },
    `Max Texture Size: ${deviceCaps.gpuCaps.maxTextureSize}px`
  ));
  gpuSection.appendChild(make("p", { class: "device-info" },
    `Compressed Textures: ${deviceCaps.gpuCaps.compressedTextures ? "✓" : "✗"} ` +
    `(ETC2: ${deviceCaps.gpuCaps.etc2Textures ? "✓" : "✗"}, ASTC: ${deviceCaps.gpuCaps.astcTextures ? "✓" : "✗"})`
  ));
  gpuSection.appendChild(make("p", { class: "device-info" },
    `MRT Attachments: ${deviceCaps.gpuCaps.maxColorAttachments} | Multi-Draw: ${deviceCaps.gpuCaps.multiDraw ? "✓" : "✗"}`
  ));

  // PS1 status section — shows BIOS file availability and core info
  const ps1Section = make("div", { class: "settings-section" });
  ps1Section.appendChild(make("h4", { class: "settings-section__title" }, "PS1 Status"));
  ps1Section.appendChild(make("p", { class: "settings-help" },
    "PlayStation 1 uses the Beetle PSX HW core (mednafen_psx_hw). A BIOS file is " +
    "optional but improves game compatibility. Upload BIOS files in the BIOS tab."
  ));

  const psxBiosReqs = BIOS_REQUIREMENTS["psx"] ?? [];
  // Snapshot map populated by async checks — used by the "Copy Debug Info" button
  const psxBiosSnapshot = new Map<string, boolean | null>();
  for (const req of psxBiosReqs) psxBiosSnapshot.set(req.fileName, null);

  for (const req of psxBiosReqs) {
    const row = make("p", { class: "device-info" });
    row.textContent = `${req.displayName}: checking…`;
    ps1Section.appendChild(row);

    if (biosLibrary) {
      biosLibrary.findBios("psx", req.fileName).then(found => {
        psxBiosSnapshot.set(req.fileName, found !== null);
        row.textContent = `${req.displayName}: ${found ? "✓ Uploaded" : "✗ Not found"}`;
      }).catch(() => {
        psxBiosSnapshot.set(req.fileName, null);
        row.textContent = `${req.displayName}: — (could not check)`;
      });
    } else {
      psxBiosSnapshot.set(req.fileName, null);
      row.textContent = `${req.displayName}: — (BIOS library unavailable)`;
    }
  }

  // NDS status section — shows BIOS file availability and active DeSmuME settings
  const ndsSection = make("div", { class: "settings-section" });
  ndsSection.appendChild(make("h4", { class: "settings-section__title" }, "NDS Status"));
  ndsSection.appendChild(make("p", { class: "settings-help" },
    "Nintendo DS uses the DeSmuME 2015 core. BIOS files are optional — DeSmuME falls back to a " +
    "built-in HLE BIOS when they are absent — but some games require the real files. " +
    "Upload BIOS files in the BIOS tab."
  ));

  const ndsBiosReqs = BIOS_REQUIREMENTS["nds"] ?? [];
  // Snapshot map populated by async checks — used by the "Copy Debug Info" button
  const ndsBiosSnapshot = new Map<string, boolean | null>();
  for (const req of ndsBiosReqs) ndsBiosSnapshot.set(req.fileName, null);

  for (const req of ndsBiosReqs) {
    const row = make("p", { class: "device-info" });
    row.textContent = `${req.displayName}: checking…`;
    ndsSection.appendChild(row);

    if (biosLibrary) {
      biosLibrary.findBios("nds", req.fileName).then(found => {
        ndsBiosSnapshot.set(req.fileName, found !== null);
        row.textContent = `${req.displayName}: ${found ? "✓ Uploaded" : "✗ Not found (optional)"}`;
      }).catch(() => {
        ndsBiosSnapshot.set(req.fileName, null);
        row.textContent = `${req.displayName}: — (could not check)`;
      });
    } else {
      ndsBiosSnapshot.set(req.fileName, null);
      row.textContent = `${req.displayName}: — (BIOS library unavailable)`;
    }
  }

  // Show active DeSmuME performance settings when an NDS game is running
  const activeSystem = emulatorRef?.currentSystem;
  const activeCoreSettingsForNds = emulatorRef?.activeCoreSettings;
  if (activeSystem?.id === "nds" && activeCoreSettingsForNds) {
    const dsCpuMode    = activeCoreSettingsForNds["desmume_cpu_mode"]             ?? "—";
    const dsFrameskip  = activeCoreSettingsForNds["desmume_frameskip"]            ?? "—";
    const dsResolution = activeCoreSettingsForNds["desmume_internal_resolution"]  ?? "—";
    const dsOpenGL     = activeCoreSettingsForNds["desmume_opengl_mode"]          ?? "—";
    const dsTiming     = activeCoreSettingsForNds["desmume_advanced_timing"]      ?? "—";
    const dsColorDepth = activeCoreSettingsForNds["desmume_color_depth"]          ?? "—";
    const dsPointer    = activeCoreSettingsForNds["desmume_pointer_type"]         ?? "—";
    const dsMicMode    = activeCoreSettingsForNds["desmume_mic_mode"]             ?? "—";
    ndsSection.appendChild(make("p", { class: "device-info" },
      `Active DeSmuME settings (tier: ${emulatorRef?.activeTier ?? "—"})`
    ));
    ndsSection.appendChild(make("p", { class: "device-info" },
      `CPU mode: ${dsCpuMode} | Frameskip: ${dsFrameskip} | Resolution: ${dsResolution}`
    ));
    ndsSection.appendChild(make("p", { class: "device-info" },
      `OpenGL: ${dsOpenGL} | Advanced timing: ${dsTiming} | Color depth: ${dsColorDepth}`
    ));
    ndsSection.appendChild(make("p", { class: "device-info" },
      `Touchscreen mode: ${dsPointer} | Mic mode: ${dsMicMode}`
    ));
  }

  // Emulator state section
  const stateSection = make("div", { class: "settings-section" });
  stateSection.appendChild(make("h4", { class: "settings-section__title" }, "Emulator State"));

  stateSection.appendChild(make("p", { class: "device-info" },
    `State: ${emulatorRef?.state ?? "unknown"}`
  ));
  stateSection.appendChild(make("p", { class: "device-info" },
    `Active System: ${emulatorRef?.currentSystem?.name ?? "—"} (id: ${emulatorRef?.currentSystem?.id ?? "—"})`
  ));
  stateSection.appendChild(make("p", { class: "device-info" },
    `Active Tier: ${emulatorRef?.activeTier ?? "—"}`
  ));
  const adapterInfo = emulatorRef?.webgpuAdapterInfo;
  const adapterLabel = (adapterInfo?.vendor || adapterInfo?.device)
    ? `${adapterInfo.device || adapterInfo.vendor}${adapterInfo.isFallbackAdapter ? " (software)" : ""}`
    : null;
  if (adapterLabel) {
    stateSection.appendChild(make("p", { class: "device-info" },
      `WebGPU Adapter: ${adapterLabel}`
    ));
  }

  // Active core settings section (PSP / RetroArch options applied at launch)
  const activeCoreSettings = emulatorRef?.activeCoreSettings;
  if (activeCoreSettings && Object.keys(activeCoreSettings).length > 0) {
    const coreSettingsSection = make("div", { class: "settings-section" });
    coreSettingsSection.appendChild(make("h4", { class: "settings-section__title" }, "Active Core Settings"));
    coreSettingsSection.appendChild(make("p", { class: "settings-help" },
      "RetroArch / PPSSPP core options that were passed to the emulator at launch."
    ));
    const list = make("ul", { class: "core-settings-list" });
    for (const [key, value] of Object.entries(activeCoreSettings)) {
      const item = make("li", { class: "core-settings-item" });
      item.appendChild(make("span", { class: "core-settings-key" }, key));
      item.appendChild(make("span", { class: "core-settings-value" }, String(value)));
      list.appendChild(item);
    }
    coreSettingsSection.appendChild(list);
    stateSection.appendChild(coreSettingsSection);
  }

  // Startup profiler section (Phase 9)
  const profSummary = emulatorRef?.startupProfiler?.summary();
  if (profSummary && profSummary.records.length > 0) {
    const profSection = make("div", { class: "settings-section" });
    profSection.appendChild(make("h4", { class: "settings-section__title" }, "Last Launch Profile"));
    profSection.appendChild(make("p", { class: "settings-help" },
      "Time spent in each phase of the most recent game launch."
    ));
    const profList = make("ul", { class: "core-settings-list" });
    for (const r of profSummary.records) {
      const item = make("li", { class: "core-settings-item" });
      const isSlowest = r === profSummary.slowest;
      item.appendChild(make("span", { class: "core-settings-key" }, `${isSlowest ? "⚡ " : ""}${r.phase}`));
      item.appendChild(make("span", { class: "core-settings-value" }, `${r.durationMs.toFixed(0)} ms`));
      profList.appendChild(item);
    }
    const totalItem = make("li", { class: "core-settings-item" });
    totalItem.appendChild(make("span", { class: "core-settings-key" }, "total"));
    totalItem.appendChild(make("span", { class: "core-settings-value" }, `${profSummary.totalMs.toFixed(0)} ms`));
    profList.appendChild(totalItem);
    profSection.appendChild(profList);
    stateSection.appendChild(profSection);
  }

  // Diagnostic event timeline section
  const timelineSection = make("div", { class: "settings-section" });
  timelineSection.appendChild(make("h4", { class: "settings-section__title" }, "Diagnostic Timeline"));
  timelineSection.appendChild(make("p", { class: "settings-help" },
    "Recent performance and system events logged during emulator operation."
  ));

  const diagnosticEvents = emulatorRef?.diagnosticLog ?? [];
  if (diagnosticEvents.length === 0) {
    timelineSection.appendChild(make("p", { class: "device-info" },
      "No diagnostic events recorded yet. Events appear after launching a game."
    ));
  } else {
    const eventList = make("ul", { class: "core-settings-list" });
    // Display only the most recent events to keep the panel responsive
    const MAX_DISPLAYED_DIAGNOSTIC_EVENTS = 20;
    const recentEvents = diagnosticEvents.slice(-MAX_DISPLAYED_DIAGNOSTIC_EVENTS).reverse();
    for (const evt of recentEvents) {
      const item = make("li", { class: "core-settings-item" });
      const time = new Date(evt.timestamp).toLocaleTimeString();
      const badge = evt.category === "error" ? "🔴"
        : evt.category === "performance" ? "⚡"
        : evt.category === "audio" ? "🔊"
        : evt.category === "render" ? "🖥"
        : "ℹ️";
      item.appendChild(make("span", { class: "core-settings-key" }, `${badge} ${time}`));
      item.appendChild(make("span", { class: "core-settings-value" }, evt.message));
      eventList.appendChild(item);
    }
    timelineSection.appendChild(eventList);
  }

  // Actions section
  const actionsSection = make("div", { class: "settings-section" });
  actionsSection.appendChild(make("h4", { class: "settings-section__title" }, "Actions"));
  actionsSection.appendChild(make("p", { class: "settings-help" },
    "Copy a snapshot of diagnostics to the clipboard for bug reports."
  ));

  const btnCopy = make("button", { class: "btn" }, "Copy Debug Info");
  btnCopy.addEventListener("click", () => {
    const lines = [
      `RetroVault Debug Info — ${new Date().toISOString()}`,
      ``,
      `[Environment]`,
      `Cross-Origin Isolated: ${isIsolated}`,
      `SharedArrayBuffer: ${hasSAB}`,
      `WebAssembly: ${hasWasm}`,
      `User Agent: ${navigator.userAgent}`,
      ``,
      `[Device]`,
      `Tier: ${deviceCaps.tier}`,
      `GPU Score: ${deviceCaps.gpuBenchmarkScore}/100`,
      `Estimated VRAM: ${deviceCaps.estimatedVRAMMB} MB`,
      `Low-Spec: ${deviceCaps.isLowSpec}`,
      `ChromeOS: ${deviceCaps.isChromOS}`,
      `WebGL2: ${deviceCaps.gpuCaps.webgl2}`,
      `WebGPU: ${deviceCaps.webgpuAvailable}`,
      `Max Texture: ${deviceCaps.gpuCaps.maxTextureSize}px`,
      `Anisotropic: ${deviceCaps.gpuCaps.anisotropicFiltering} (max ${deviceCaps.gpuCaps.maxAnisotropy}×)`,
      `Float Textures: ${deviceCaps.gpuCaps.floatTextures}`,
      `Instanced Arrays: ${deviceCaps.gpuCaps.instancedArrays}`,
      `ETC2 Textures: ${deviceCaps.gpuCaps.etc2Textures}`,
      `ASTC Textures: ${deviceCaps.gpuCaps.astcTextures}`,
      `Compressed Textures: ${deviceCaps.gpuCaps.compressedTextures}`,
      `MRT Attachments: ${deviceCaps.gpuCaps.maxColorAttachments}`,
      `Multi-Draw: ${deviceCaps.gpuCaps.multiDraw}`,
      ``,
      `[Emulator]`,
      `State: ${emulatorRef?.state ?? "unknown"}`,
      `System: ${emulatorRef?.currentSystem?.id ?? "—"}`,
      `Tier: ${emulatorRef?.activeTier ?? "—"}`,
      `Thermal Pressure: ${emulatorRef?.thermalPressureState ?? "unknown"}`,
    ];
    if (adapterLabel) {
      lines.push(`WebGPU Adapter: ${adapterLabel}`);
    }
    const snapshotSettings = emulatorRef?.activeCoreSettings;
    if (snapshotSettings && Object.keys(snapshotSettings).length > 0) {
      lines.push(``, `[Core Settings]`);
      for (const [key, value] of Object.entries(snapshotSettings)) {
        lines.push(`${key}: ${String(value)}`);
      }
    }
    // Include startup profiler summary
    const profSummary = emulatorRef?.startupProfiler?.summary();
    if (profSummary && profSummary.records.length > 0) {
      lines.push(``, `[Startup Profile]`);
      for (const r of profSummary.records) {
        lines.push(`${r.phase}: ${r.durationMs.toFixed(0)} ms`);
      }
      lines.push(`total: ${profSummary.totalMs.toFixed(0)} ms`);
    }
    // Include PS1 BIOS status (populated asynchronously when the tab opened)
    if (psxBiosReqs.length > 0) {
      lines.push(``, `[PS1 BIOS]`);
      for (const req of psxBiosReqs) {
        const status = psxBiosSnapshot.get(req.fileName);
        lines.push(`${req.fileName}: ${status === true ? "present" : status === false ? "missing" : "unknown"}`);
      }
    }
    // Include NDS BIOS status (populated asynchronously when the tab opened)
    if (ndsBiosReqs.length > 0) {
      lines.push(``, `[NDS BIOS]`);
      for (const req of ndsBiosReqs) {
        const status = ndsBiosSnapshot.get(req.fileName);
        lines.push(`${req.fileName}: ${status === true ? "present" : status === false ? "missing (optional)" : "unknown"}`);
      }
    }
    lines.push(
      ``,
      `[Netplay]`,
      `Enabled: ${peekNetplayManager()?.enabled ?? false}`,
      `Active: ${peekNetplayManager()?.isActive ?? false}`,
      `Server: ${peekNetplayManager()?.serverUrl || "—"}`,
      `ICE Servers: ${peekNetplayManager()?.iceServers?.length ?? 0}`,
      ...(peekNetplayManager()?.iceServers ?? []).map((s) =>
        `  ${Array.isArray(s.urls) ? s.urls.join(", ") : s.urls}`
      ),
    );

    // Include diagnostic event log
    const diagEvents = emulatorRef?.diagnosticLog ?? [];
    if (diagEvents.length > 0) {
      lines.push(``, `[Diagnostic Timeline (last ${Math.min(50, diagEvents.length)} events)]`);
      const recentDiag = diagEvents.slice(-50);
      for (const evt of recentDiag) {
        const t = new Date(evt.timestamp).toLocaleTimeString();
        lines.push(`[${t}] [${evt.category}] ${evt.message}`);
      }
    }

    navigator.clipboard.writeText(lines.join("\n")).then(() => {
      showInfoToast("Debug info copied to clipboard.");
    }).catch(() => {
      showError("Could not copy to clipboard.");
    });
  });
  actionsSection.appendChild(btnCopy);

  // Clear device capability cache — forces full re-detection on next page load
  const btnClearCaps = make("button", { class: "btn btn--secondary" }, "Clear Capability Cache");
  btnClearCaps.title = "Force re-detection of GPU tier and device capabilities on next reload.";
  btnClearCaps.addEventListener("click", () => {
    clearCapabilitiesCache();
    showInfoToast("Capability cache cleared. Reload the page to re-detect device capabilities.");
  });
  actionsSection.appendChild(btnClearCaps);

  // Thermal pressure section (Phase 9)
  const thermalSection = make("div", { class: "settings-section" });
  thermalSection.appendChild(make("h4", { class: "settings-section__title" }, "Thermal & Pressure"));
  thermalSection.appendChild(make("p", { class: "settings-help" },
    "Compute Pressure API — monitors CPU thermal load to proactively prevent OS-forced throttling. " +
    "Requires Chrome 125+ (or a compatible browser)."
  ));
  const thermalState = emulatorRef?.thermalPressureState ?? "unknown";
  const thermalLabel = thermalState === "nominal"  ? "✅ Nominal — device is cool"
    : thermalState === "fair"     ? "🟡 Fair — minor thermal load"
    : thermalState === "serious"  ? "🟠 Serious — sustained high thermal load"
    : thermalState === "critical" ? "🔴 Critical — OS throttling is active"
    : "⚪ Unknown — Compute Pressure API unavailable";
  thermalSection.appendChild(make("p", { class: "device-info" },
    `Thermal Pressure: ${thermalLabel}`
  ));
  if (thermalState === "unknown") {
    thermalSection.appendChild(make("p", { class: "device-info" },
      "Compute Pressure API is not available in this browser."
    ));
  }

  container.append(settingsSection, envSection, gpuSection, ps1Section, ndsSection, stateSection, timelineSection, thermalSection, actionsSection);
}

// ── About tab ─────────────────────────────────────────────────────────────────

function buildAboutTab(container: HTMLElement): void {
  // Quick start section
  const quickStartSection = make("div", { class: "settings-section" });
  quickStartSection.appendChild(make("h4", { class: "settings-section__title" }, "How to Get Started"));
  const steps = [
    "Drop a game file onto the page, or click the upload area to browse for one.",
    "If asked, choose which system to use — this happens with some common file formats.",
    "Your game launches automatically — enjoy!",
    "Save your progress with F5, load it back with F7, and press Esc to return to your game library. Saves stay local first, and cloud backup can mirror them if you connect it later.",
  ];
  const stepList = make("ol", { class: "help-steps" });
  for (const step of steps) {
    stepList.appendChild(make("li", { class: "help-step" }, step));
  }
  quickStartSection.appendChild(stepList);

  // Keyboard shortcuts
  const shortcutsSection = make("div", { class: "settings-section" });
  shortcutsSection.appendChild(make("h4", { class: "settings-section__title" }, "Keyboard Shortcuts"));

  const shortcuts: Array<[string, string]> = [
    ["F5", "Save progress (quick save)"],
    ["F7", "Load saved progress (quick load)"],
    ["F1", "Reset game"],
    ["F9", "Open Settings (Advanced tab)"],
    ["Esc", "Return to game library"],
    ["F3", "Toggle on-screen debug overlay"],
  ];

  const shortcutList = make("div", { class: "device-info-details" });
  for (const [key, desc] of shortcuts) {
    const row = make("div", { class: "shortcut-row" });
    const kbdEl = make("kbd", { class: "shortcut-key" }, key);
    row.append(kbdEl, make("span", { class: "shortcut-desc device-info" }, desc));
    shortcutList.appendChild(row);
  }
  shortcutsSection.appendChild(shortcutList);

  // Play with friends (online)
  const mpSection = make("div", { class: "settings-section" });
  mpSection.appendChild(make("h4", { class: "settings-section__title" }, "Play with friends online"));
  const mpSteps = [
    "Open ⚙ Settings → Play Together. Turn on Online play and paste the WebSocket URL (wss://…) from whoever runs your server — everyone must use the same URL.",
    "Launch the same game as your friend (same title and system when possible).",
    "Click Play Together on the home screen, or Online in the game toolbar. Host creates a room and shares the invite code; Join pastes the code from your friend.",
    "If something fails, open Play Together and use 📋 Logs to copy connection details for troubleshooting.",
  ];
  const mpList = make("ol", { class: "help-steps" });
  for (const step of mpSteps) {
    mpList.appendChild(make("li", { class: "help-step" }, step));
  }
  mpSection.appendChild(mpList);
  mpSection.appendChild(make("p", { class: "settings-help" },
    "In-game Wi-Fi or Nintendo WFC features inside a ROM are not the same as RetroVault Play Together — use Host / Join here for link-style multiplayer."
  ));

  // Troubleshooting section
  const troubleSection = make("div", { class: "settings-section" });
  troubleSection.appendChild(make("h4", { class: "settings-section__title" }, "Troubleshooting"));

  const troubles: Array<[string, string]> = [
    ["Game won't load", "Check that the file is a valid ROM. ZIP files are automatically extracted — if it still fails, try unzipping the file manually first."],
    ["PSP game won't start", "PSP games need a special browser feature. Try refreshing the page once — this sets things up automatically."],
    ["No sound", "Make sure the browser tab isn't muted. Some games take a few seconds to start audio."],
    ["Game is slow or choppy", "Open ⚡ Settings → Performance and switch to Performance mode. Closing other browser tabs can also help."],
    ["Saves aren't working", "Your saves live in your browser on this device. If you connect cloud backup, it mirrors those saves instead of replacing them. Clearing browser data will erase the local copy, so export saves first if you want a backup."],
    ["Controls not responding", "Click on the game screen first to make sure it has focus. Gamepads should be connected before launching a game."],
    ["Stuck on loading screen", "Try refreshing the page. If the issue persists, the game file may be corrupted or an unsupported format."],
    ["Can't connect to a friend online", "Confirm Settings → Play Together has the same server URL for both of you, Online play is on, and you are playing the same game. Try 📋 Logs in the Play Together window; strict networks may need a TURN server under Advanced."],
  ];

  for (const [problem, solution] of troubles) {
    const item = make("div", { class: "trouble-item" });
    item.appendChild(make("p", { class: "trouble-item__q" }, `❓ ${problem}`));
    item.appendChild(make("p", { class: "trouble-item__a" }, solution));
    troubleSection.appendChild(item);
  }

  // About section
  const aboutSection = make("div", { class: "settings-section" });
  aboutSection.appendChild(make("h4", { class: "settings-section__title" }, "About RetroVault"));
  aboutSection.appendChild(make("p", { class: "settings-help" },
    "RetroVault lets you play retro games from classic systems — PSP, N64, PS1, NDS, GBA, SNES, NES, Genesis and more — " +
    "right in your browser. No installs, no account, nothing to sign up for."
  ));
  aboutSection.appendChild(make("p", { class: "settings-help" },
    "Your local game library and saves stay on this device by default. If you connect cloud storage, cloud saves mirror progress and cloud library sources add remote games beside your local ROMs. RetroVault does not upload anything until you connect a provider."
  ));

  const links = make("div", { class: "help-links" });
  const ejsLink = make("a", {
    href: "https://emulatorjs.org",
    target: "_blank",
    rel: "noopener",
    class: "btn help-link-btn",
  }, "Powered by EmulatorJS");
  links.appendChild(ejsLink);
  aboutSection.appendChild(links);

  container.append(quickStartSection, shortcutsSection, mpSection, troubleSection, aboutSection);
}

// ── Toggle row builder ────────────────────────────────────────────────────────

function buildToggleRow(label: string, desc: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const row = make("label", { class: "toggle-row" });

  const left = make("span", { class: "toggle-row__text" });
  left.append(make("span", { class: "radio-row__label" }, label), make("span", { class: "radio-row__desc" }, desc));

  const toggle = make("span", { class: "toggle-switch" });
  const input  = make("input", { type: "checkbox" }) as HTMLInputElement;
  input.checked = checked;
  const knob = make("span", { class: "toggle-switch__knob" });
  toggle.classList.toggle("is-checked", checked);
  toggle.append(input, knob);

  input.addEventListener("change", () => {
    toggle.classList.toggle("is-checked", input.checked);
    onChange(input.checked);
  });
  row.append(left, toggle);
  return row;
}

// ── Multi-disc helpers ────────────────────────────────────────────────────────

export function parseM3U(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"))
    .map(line => line.split(/[/\\]/).pop() ?? line);
}

export function showMultiDiscPicker(discFileNames: string[]): Promise<Map<string, File> | null> {
  return showMultiDiscPickerImpl(discFileNames);
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
    `This preference will be remembered for this game.`;
  return showConfirmDialog(message, {
    title: "Low Frame Rate Detected",
    confirmLabel: `Switch to ${tierNames[targetTier] ?? targetTier} Tier`,
    isDanger: false,
  });
}

// ── Audio Visualiser ──────────────────────────────────────────────────────────

class AudioVisualiser {
  private _analyser: AnalyserNode | null = null;
  private _ownedAnalyser = false; // true when we created the analyser (must disconnect on stop)
  private _rafId: number | null = null;
  private _canvas: HTMLCanvasElement | null = null;
  private _2d: CanvasRenderingContext2D | null = null;
  private _buffer: Uint8Array<ArrayBuffer> | null = null;
  private _lastDrawTime = 0;
  private readonly _TARGET_INTERVAL = 1000 / 30;

  start(emulatorRef?: import("./emulator.js").PSPEmulator): boolean {
    if (this._rafId !== null) {
      if (this._canvas) this._canvas.hidden = false;
      return this._analyser !== null;
    }

    this._canvas = document.getElementById("fps-visualiser") as HTMLCanvasElement | null;
    if (!this._canvas) return false;
    this._2d = this._canvas.getContext("2d");
    if (!this._2d) return false;

    // Prefer the emulator's pre-wired analyser (post-gain, already connected)
    const emulatorAnalyser = emulatorRef?.getAnalyserNode() ?? null;
    if (emulatorAnalyser) {
      this._analyser = emulatorAnalyser;
      this._ownedAnalyser = false;
    } else {
      // Fall back: create our own analyser connected to AL sources
      const ejsCtx = (window as Window & { EJS_emulator?: { Module?: { AL?: { currentCtx?: { audioCtx?: AudioContext; sources?: Record<string, { gain: GainNode }> } } } } })
        .EJS_emulator?.Module?.AL?.currentCtx;
      const ctx = ejsCtx?.audioCtx ?? emulatorRef?.getAudioContext() ?? null;
      if (ctx && ejsCtx?.sources) {
        try {
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.75;
          const gainNodes = Object.values(ejsCtx.sources).map(s => s.gain);
          gainNodes.forEach(g => g.connect(analyser));
          analyser.connect(ctx.destination);
          this._analyser = analyser;
          this._ownedAnalyser = true;
        } catch { /* connection failed */ }
      }
    }

    this._canvas.hidden = false;
    if (this._analyser) {
      this._buffer = new Uint8Array(this._analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
      this._loop();
    } else {
      this._drawNoSignal();
    }
    return this._analyser !== null;
  }

  stop(): void {
    if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    if (this._ownedAnalyser) {
      try { this._analyser?.disconnect(); } catch { /* ignore */ }
    }
    this._analyser = null;
    this._ownedAnalyser = false;
    this._buffer = null;
    if (this._canvas) this._canvas.hidden = true;
  }

  private _loop(): void {
    this._rafId = requestAnimationFrame((now) => {
      // Guard against a rAF callback that fires after stop() was called.
      if (this._rafId === null) return;
      if (now - this._lastDrawTime >= this._TARGET_INTERVAL) { this._lastDrawTime = now; this._draw(); }
      this._loop();
    });
  }

  private _draw(): void {
    if (!this._2d || !this._canvas || !this._analyser || !this._buffer) return;
    // Use frequency-domain data for bar display (more informative than waveform)
    this._analyser.getByteFrequencyData(this._buffer);
    const { width, height } = this._canvas;
    const ctx = this._2d;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(0, 0, width, height);

    const barCount = this._buffer.length;
    // Clamp to at least 1px per bar; when canvas is narrow, render fewer bars
    const barWidth = width / barCount;
    const step = barWidth >= 1 ? 1 : Math.ceil(1 / barWidth);
    const drawCount = Math.floor(barCount / step);
    const drawBarWidth = width / drawCount;
    for (let i = 0; i < drawCount; i++) {
      const magnitude = this._buffer[i * step]! / 255;
      const barHeight = magnitude * height;
      // Colour shifts from green (quiet) → yellow → red (loud)
      const hue = Math.round(120 - magnitude * 120);
      ctx.fillStyle = `hsl(${hue},80%,50%)`;
      ctx.fillRect(i * drawBarWidth, height - barHeight, Math.max(1, drawBarWidth - 1), barHeight);
    }
  }

  private _drawNoSignal(): void {
    if (!this._2d || !this._canvas) return;
    const { width, height } = this._canvas;
    this._2d.fillStyle = "rgba(0,0,0,0.5)";
    this._2d.fillRect(0, 0, width, height);
    this._2d.fillStyle = "#666";
    this._2d.font = "9px monospace";
    this._2d.textAlign = "center";
    this._2d.fillText("no signal", width / 2, height / 2 + 3);
  }
}

const _audioVisualiser = new AudioVisualiser();
function startAudioVisualiser(emulatorRef?: PSPEmulator): void { _audioVisualiser.start(emulatorRef); }
function stopAudioVisualiser(): void { _audioVisualiser.stop(); }

// ── Developer debug overlay ───────────────────────────────────────────────────

/** Module-level dirty tracker wired to the dev overlay and FPS overlay. */
export const _uiDirtyTracker = new UIDirtyTracker();

/** Whether the developer overlay (F3) is currently visible. */
let _devOverlayVisible = false;

/** Number of samples in the dev overlay frame-time graph ring buffer. */
const DEV_FRAME_GRAPH_SAMPLES = 60;
/** Frame time at 60 fps target (ms). */
const DEV_FT_60FPS = 16;
/** Frame time at 30 fps target (ms). */
const DEV_FT_30FPS = 33;
/** Maximum frame time represented on the graph y-axis (ms). */
const DEV_FT_GRAPH_MAX = 50;

/**
 * Frametime ring buffer for the mini graph drawn inside the dev overlay.
 * Pre-allocated to avoid per-frame GC pressure.
 */
const _devFrameGraph = new Float64Array(DEV_FRAME_GRAPH_SAMPLES);
let   _devFrameGraphHead = 0;

/** Toggle the developer debug overlay (bound to F3). */
export function toggleDevOverlay(): void {
  _devOverlayVisible = !_devOverlayVisible;
  const el = document.getElementById("dev-overlay");
  if (el) el.hidden = !_devOverlayVisible;
  if (_devOverlayVisible) _uiDirtyTracker.mark(UIDirtyFlags.DEV_OVERLAY);
}

/** Return whether the developer debug overlay is currently shown. */
export function isDevOverlayVisible(): boolean {
  return _devOverlayVisible;
}

/**
 * Update the developer debug overlay with the latest FPS snapshot and
 * emulator state.  Only performs DOM work when the overlay is visible and
 * the DEV_OVERLAY dirty flag is set, avoiding redundant mutations.
 */
function updateDevOverlay(snapshot: FPSSnapshot, emulator: PSPEmulator): void {
  if (!_devOverlayVisible) return;

  // Push the current frame time into the ring buffer for the mini graph.
  const frameTimeMs = snapshot.current > 0 ? Math.round(1000 / snapshot.current) : 0;
  _devFrameGraph[_devFrameGraphHead] = frameTimeMs;
  _devFrameGraphHead = (_devFrameGraphHead + 1) % DEV_FRAME_GRAPH_SAMPLES;

  // Mark dirty so the render block below runs exactly once per tick.
  _uiDirtyTracker.mark(UIDirtyFlags.DEV_OVERLAY);

  if (!_uiDirtyTracker.consume(UIDirtyFlags.DEV_OVERLAY)) return;

  // ── Scalar Metrics ────────────────────────────────────────────────────────
  const els = _getDevOverlayEls();

  if (els.ft) els.ft.textContent = `${frameTimeMs}ms`;
  if (els.fps) els.fps.textContent = `${snapshot.current} FPS`;
  if (els.p95) els.p95.textContent = `${snapshot.p95FrameTimeMs}ms`;

  if (els.mem) {
    const perf = performance as Performance & { memory?: { usedJSHeapSize?: number } };
    const used = perf.memory?.usedJSHeapSize;
    els.mem.textContent = used ? `${Math.round(used / (1024 * 1024))}MB` : "n/a";
  }

  if (els.state) {
    els.state.textContent = emulator.state;
  }

  // ── Frame-time mini graph ─────────────────────────────────────────────────
  const canvas = els.canvas as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Reference lines at DEV_FT_60FPS ms (60 fps) and DEV_FT_30FPS ms (30 fps)
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  const ref60y = h - Math.min((DEV_FT_60FPS / DEV_FT_GRAPH_MAX) * h, h);
  const ref30y = h - Math.min((DEV_FT_30FPS / DEV_FT_GRAPH_MAX) * h, h);
  ctx.beginPath(); ctx.moveTo(0, ref60y); ctx.lineTo(w, ref60y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, ref30y); ctx.lineTo(w, ref30y); ctx.stroke();

  const barW = w / DEV_FRAME_GRAPH_SAMPLES;
  const count = DEV_FRAME_GRAPH_SAMPLES;
  for (let i = 0; i < count; i++) {
    // Read from ring buffer in chronological order
    const idx = (_devFrameGraphHead + i) % count;
    const ms  = _devFrameGraph[idx]!;
    if (ms === 0) continue;
    const barH = Math.min((ms / DEV_FT_GRAPH_MAX) * h, h);
    const hue  = ms <= DEV_FT_60FPS ? 120 : ms <= DEV_FT_30FPS ? 60 : 0;
    ctx.fillStyle = `hsl(${hue},80%,50%)`;
    ctx.fillRect(i * barW, h - barH, Math.max(1, barW - 1), barH);
  }
}

// ── FPS overlay ───────────────────────────────────────────────────────────────

function showFPSOverlay(show: boolean, emulatorRef?: PSPEmulator, showAudioVis?: boolean): void {
  const overlay = document.getElementById("fps-overlay");
  if (overlay) overlay.hidden = !show;
  if (show && showAudioVis) startAudioVisualiser(emulatorRef); else stopAudioVisualiser();
}

let _lowFPSCount = 0;
let _perfSuggestionShown = false;
const LOW_FPS_THRESHOLD = 25;
const LOW_FPS_TRIGGER   = 6;

function _getDevOverlayEls(): Record<string, HTMLElement | null> {
  if (!_devOverlayEls) {
    _devOverlayEls = {
      ft: document.getElementById("dev-frame-time"),
      fps: document.getElementById("dev-fps"),
      p95: document.getElementById("dev-p95"),
      mem: document.getElementById("dev-memory"),
      state: document.getElementById("dev-state"),
      canvas: document.getElementById("dev-framegraph"),
    };
  }
  return _devOverlayEls;
}

function updateFPSOverlay(snapshot: FPSSnapshot, emulator: PSPEmulator): void {
  if (!_fpsOverlayEls) {
    _fpsOverlayEls = {
      val: document.getElementById("fps-current-val"),
      avg: document.getElementById("fps-avg"),
      tier: document.getElementById("fps-tier"),
      dropped: document.getElementById("fps-dropped"),
    };
  }
  const { val: valEl, avg: avgEl, tier: tierEl, dropped: droppedEl } = _fpsOverlayEls;

  if (valEl) {
    valEl.textContent = `${snapshot.current}`;
    valEl.className = `fps-val ${snapshot.current >= 50 ? "fps-good" : snapshot.current >= 30 ? "fps-ok" : "fps-bad"}`;
  }
  if (avgEl) avgEl.textContent = `avg ${snapshot.average}`;
  if (tierEl && emulator.activeTier) tierEl.textContent = formatTierLabel(emulator.activeTier);
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
    `<span class="perf-suggestion__msg">Game running slowly? Try <strong>Performance mode</strong> in ⚡ Settings for a smoother experience.${mobileTip}</span>` +
    `<button class="perf-suggestion__close" aria-label="Dismiss">✕</button>`;
  document.body.appendChild(toast);

  const dismiss = () => { toast.classList.add("perf-suggestion--hiding"); setTimeout(() => toast.remove(), PERF_SUGGESTION_FADE_DELAY_MS); };
  toast.querySelector(".perf-suggestion__close")?.addEventListener("click", dismiss);
  setTimeout(dismiss, 10_000);
  requestAnimationFrame(() => toast.classList.add("perf-suggestion--visible"));
}

export function resetPerfSuggestion(): void {
  _lowFPSCount = 0;
  _perfSuggestionShown = false;
  document.getElementById("perf-suggestion")?.remove();
}

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
  if (sysItem)  sysItem.style.display  = isActive ? "" : "none";
  if (sysLabel) sysLabel.style.display = isActive ? "" : "none";
  if (tierItem) tierItem.style.display = isActive ? "" : "none";

  if (state === "idle" || state === "error") { setStatusGame("—"); setStatusSystem("—"); setStatusTier(null); }
}


/** Set the current progress percent (0-100) shown on the loading overlay. Pass null to hide. */
export function setLoadingProgress(percent: number | null): void {
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

/**
 * Dialog wizard for adding a new cloud library source.
 *
 * Step 1 — pick a provider from the visual grid.
 * Step 2 — enter a connection name and the credentials for that provider.
 *
 * On success, appends the new CloudLibraryConnection to settings and calls
 * onSettingsChange so the tab re-renders.
 */
function showAddCloudLibraryDialog(
  settings:         Settings,
  onSettingsChange: (patch: Partial<Settings>) => void,
  rebuildTab:       () => void,
): Promise<void> {
  return new Promise((resolve) => {
    const overlay = make("div", { class: "confirm-overlay" });
    const box = make("div", {
      class: "confirm-box cloud-wizard-box",
      role:  "dialog",
      "aria-modal": "true",
      "aria-label": "Add Cloud Library Source",
    });

    const close = () => {
      document.removeEventListener("keydown", onKeydown, { capture: true });
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), OVERLAY_FADE_DELAY_MS);
      resolve();
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    };
    document.addEventListener("keydown", onKeydown, { capture: true });
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    // ── Step 1: Provider picker ───────────────────────────────────────────────

    const renderStep1 = () => {
      box.innerHTML = "";
      box.appendChild(make("h3", { class: "confirm-box__title" }, "Add Cloud Library Source"));
      box.appendChild(make("p", { class: "confirm-box__body" },
        "Choose a cloud provider. Remote games will appear in your library alongside local files."
      ));

      const grid = make("div", { class: "cloud-provider-grid" });
      for (const p of CLOUD_LIBRARY_PROVIDERS) {
        const card = make("button", {
          class: "cloud-provider-card",
          type:  "button",
          "aria-label": p.label,
        }) as HTMLButtonElement;
        card.appendChild(make("span", { class: "cloud-provider-card__icon" }, p.icon));
        card.appendChild(make("span", { class: "cloud-provider-card__label" }, p.label));
        card.addEventListener("click", () => renderStep2(p.id));
        grid.appendChild(card);
      }
      box.appendChild(grid);

      const actions = make("div", { class: "confirm-box__actions" });
      const cancelBtn = make("button", { class: "btn" }, "Cancel") as HTMLButtonElement;
      cancelBtn.addEventListener("click", close);
      actions.appendChild(cancelBtn);
      box.appendChild(actions);
    };

    // ── Step 2: Credential form ───────────────────────────────────────────────

    const renderStep2 = (providerId: string) => {
      box.innerHTML = "";
      const meta = CLOUD_LIBRARY_PROVIDERS.find(p => p.id === providerId)!;
      box.appendChild(make("h3", { class: "confirm-box__title" }, `${meta.icon} ${meta.label} Library`));

      const form = make("div", { class: "cloud-wizard-form" });

      // Connection name
      const nameRow = make("div", { class: "settings-input-row" });
      const nameInp = make("input", {
        type:        "text",
        id:          "cld-name",
        class:       "settings-input",
        placeholder: `My ${meta.label}`,
        autocomplete: "off",
      }) as HTMLInputElement;
      nameRow.append(make("label", { class: "settings-input-label", for: "cld-name" }, "Connection name"), nameInp);
      form.appendChild(nameRow);

      type LibCredResult = { ok: false; error: string } | { ok: true; config: CloudLibraryConnection["config"] };
      let getCredentials: () => LibCredResult = () => ({
        ok: true,
        config: "{}",
      });

      if (providerId === "webdav") {
        const urlRow  = make("div", { class: "settings-input-row" });
        const urlInp  = make("input", { type: "url",      id: "cld-url",  class: "settings-input", placeholder: "https://dav.example.com/roms", autocomplete: "off" }) as HTMLInputElement;
        urlRow.append(make("label", { class: "settings-input-label", for: "cld-url" }, "Server URL"), urlInp);

        const userRow = make("div", { class: "settings-input-row" });
        const userInp = make("input", { type: "text",     id: "cld-user", class: "settings-input", placeholder: "Username", autocomplete: "username" }) as HTMLInputElement;
        userRow.append(make("label", { class: "settings-input-label", for: "cld-user" }, "Username"), userInp);

        const passRow = make("div", { class: "settings-input-row" });
        const passInp = make("input", { type: "password", id: "cld-pass", class: "settings-input", placeholder: "Password", autocomplete: "current-password" }) as HTMLInputElement;
        passRow.append(make("label", { class: "settings-input-label", for: "cld-pass" }, "Password"), passInp);

        form.append(urlRow, userRow, passRow);
        getCredentials = () => {
          const url  = urlInp.value.trim();
          const user = userInp.value.trim();
          const pass = passInp.value;
          if (!url)  return { ok: false, error: "Server URL is required.", config: "{}" };
          if (!user) return { ok: false, error: "Username is required.", config: "{}" };
          return { ok: true, config: JSON.stringify({ url, username: user, password: pass }) };
        };

      } else if (providerId === "pcloud") {
        const tokenRow = make("div", { class: "settings-input-row" });
        const tokenInp = make("input", { type: "text", id: "cld-token", class: "settings-input", placeholder: "pCloud access token", autocomplete: "off" }) as HTMLInputElement;
        tokenRow.append(make("label", { class: "settings-input-label", for: "cld-token" }, "Access Token"), tokenInp);

        const regionRow = make("div", { class: "settings-input-row" });
        const regionSel = make("select", { id: "cld-region", class: "settings-input" }) as HTMLSelectElement;
        regionSel.appendChild(Object.assign(document.createElement("option"), { value: "us", textContent: "US" }));
        regionSel.appendChild(Object.assign(document.createElement("option"), { value: "eu", textContent: "EU" }));
        regionRow.append(make("label", { class: "settings-input-label", for: "cld-region" }, "Region"), regionSel);

        form.append(tokenRow, regionRow);
        getCredentials = () => {
          const token  = tokenInp.value.trim();
          if (!token) return { ok: false, error: "Access token is required.", config: "{}" };
          return { ok: true, config: JSON.stringify({ accessToken: token, region: regionSel.value }) };
        };

      } else if (providerId === "blomp") {
        const userRow = make("div", { class: "settings-input-row" });
        const userInp = make("input", { type: "text",     id: "cld-user",      class: "settings-input", placeholder: "Blomp username", autocomplete: "username" }) as HTMLInputElement;
        userRow.append(make("label", { class: "settings-input-label", for: "cld-user" }, "Username"), userInp);

        const passRow = make("div", { class: "settings-input-row" });
        const passInp = make("input", { type: "password", id: "cld-pass",      class: "settings-input", placeholder: "Password", autocomplete: "current-password" }) as HTMLInputElement;
        passRow.append(make("label", { class: "settings-input-label", for: "cld-pass" }, "Password"), passInp);

        const containerRow = make("div", { class: "settings-input-row" });
        const containerInp = make("input", { type: "text", id: "cld-container", class: "settings-input", placeholder: "retrovault", autocomplete: "off" }) as HTMLInputElement;
        containerRow.append(make("label", { class: "settings-input-label", for: "cld-container" }, "Container (optional)"), containerInp);

        form.append(userRow, passRow, containerRow);
        getCredentials = () => {
          const user = userInp.value.trim();
          if (!user) return { ok: false, error: "Username is required.", config: "{}" };
          const container = containerInp.value.trim() || "retrovault";
          return { ok: true, config: JSON.stringify({ username: user, password: passInp.value, container }) };
        };

      } else if (providerId === "onedrive") {
        const tokenRow = make("div", { class: "settings-input-row" });
        const tokenInp = make("input", { type: "text", id: "cld-token",  class: "settings-input", placeholder: "OneDrive access token", autocomplete: "off" }) as HTMLInputElement;
        tokenRow.append(make("label", { class: "settings-input-label", for: "cld-token" }, "Access Token"), tokenInp);

        const rootRow = make("div", { class: "settings-input-row" });
        const rootInp = make("input", { type: "text", id: "cld-rootid", class: "settings-input", placeholder: "root (optional)", autocomplete: "off" }) as HTMLInputElement;
        rootRow.append(make("label", { class: "settings-input-label", for: "cld-rootid" }, "Root Folder ID (optional)"), rootInp);

        form.append(tokenRow, rootRow);
        getCredentials = () => {
          const token = tokenInp.value.trim();
          if (!token) return { ok: false, error: "Access token is required.", config: "{}" };
          return { ok: true, config: JSON.stringify({ accessToken: token, rootId: rootInp.value.trim() || undefined }) };
        };

      } else if (providerId === "box") {
        const tokenRow = make("div", { class: "settings-input-row" });
        const tokenInp = make("input", { type: "text", id: "cld-token",  class: "settings-input", placeholder: "Box OAuth access token", autocomplete: "off" }) as HTMLInputElement;
        tokenRow.append(make("label", { class: "settings-input-label", for: "cld-token" }, "Access Token"), tokenInp);

        const folderRow = make("div", { class: "settings-input-row" });
        const folderInp = make("input", { type: "text", id: "cld-folder", class: "settings-input", placeholder: "0 (root)", autocomplete: "off" }) as HTMLInputElement;
        folderRow.append(make("label", { class: "settings-input-label", for: "cld-folder" }, "Root Folder ID (optional)"), folderInp);

        form.append(tokenRow, folderRow);
        getCredentials = () => {
          const token = tokenInp.value.trim();
          if (!token) return { ok: false, error: "Access token is required.", config: "{}" };
          return { ok: true, config: JSON.stringify({ accessToken: token, rootFolderId: folderInp.value.trim() || "0" }) };
        };

      } else {
        // gdrive, dropbox
        const tokenRow = make("div", { class: "settings-input-row" });
        const tokenInp = make("input", { type: "text", id: "cld-token", class: "settings-input", placeholder: `${meta.label} access token`, autocomplete: "off" }) as HTMLInputElement;
        tokenRow.append(make("label", { class: "settings-input-label", for: "cld-token" }, "Access Token"), tokenInp);
        form.appendChild(tokenRow);
        getCredentials = () => {
          const token = tokenInp.value.trim();
          if (!token) return { ok: false, error: "Access token is required.", config: "{}" };
          return { ok: true, config: JSON.stringify({ accessToken: token }) };
        };
      }

      box.appendChild(form);

      const errorMsg = make("p", { class: "cloud-wizard-error", "aria-live": "assertive" });
      errorMsg.hidden = true;
      box.appendChild(errorMsg);

      const actions = make("div", { class: "confirm-box__actions" });
      const backBtn  = make("button", { class: "btn" }, "← Back") as HTMLButtonElement;
      const saveBtn  = make("button", { class: "btn btn--primary" }, "Add Source") as HTMLButtonElement;
      actions.append(backBtn, saveBtn);
      box.appendChild(actions);

      backBtn.addEventListener("click", () => renderStep1());

      saveBtn.addEventListener("click", () => {
        const creds = getCredentials();
        if (!creds.ok) {
          errorMsg.textContent = creds.error;
          errorMsg.hidden = false;
          return;
        }
        errorMsg.hidden = true;

        const connName = nameInp.value.trim() || meta.label;
        const newConn: CloudLibraryConnection = {
          id:       createUuid(),
          provider: providerId as CloudLibraryConnection["provider"],
          name:     connName,
          enabled:  true,
          config:   creds.config,
        };

        onSettingsChange({ cloudLibraries: [...settings.cloudLibraries, newConn] });
        rebuildTab();
        close();
      });
    };

    // Kick off step 1
    renderStep1();

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("confirm-overlay--visible"));
  });
}


function buildCloudTab(
  container:        HTMLElement,
  settings:         Settings,
  library:          GameLibrary,
  onSettingsChange: (patch: Partial<Settings>) => void,
): void {
  container.innerHTML = "";
  const section = make("div", { class: "settings-section" });
  section.appendChild(make("h4", { class: "settings-section__title" }, "Cloud Storage"));
  section.appendChild(make("p", { class: "settings-section__desc" }, "RetroVault uses cloud storage in two independent ways: cloud saves mirror progress, and cloud library sources add remote games beside your local ROMs."));

  const overview = make("div", { class: "cloud-storage-overview" });

  const saveCard = make("div", { class: "cloud-storage-card" });
  saveCard.innerHTML = `
    <div class="cloud-storage-card__eyebrow">Cloud saves</div>
    <h5 class="cloud-storage-card__title">Mirror progress, keep local ownership</h5>
    <p class="cloud-storage-card__body">Save states stay in your browser first. When cloud backup is connected, RetroVault mirrors those local saves to the provider you chose.</p>
  `;

  const libraryCard = make("div", { class: "cloud-storage-card" });
  libraryCard.innerHTML = `
    <div class="cloud-storage-card__eyebrow">Cloud library</div>
    <h5 class="cloud-storage-card__title">Add remote games next to local ROMs</h5>
    <p class="cloud-storage-card__body">Remote games are indexed as their own entries, so they can sit alongside files stored on this device without replacing them.</p>
  `;

  overview.append(saveCard, libraryCard);
  section.appendChild(overview);

  // ── Cloud save backup section ───────────────────────────────────────────────

  const cloudManager = getCloudSaveManager();
  const saveSection = make("div", { class: "cloud-library-section" });
  saveSection.appendChild(make("h5", { class: "cloud-library-section__title" }, "Cloud Save Backup"));

  const buildSaveStatus = () => {
    const statusRow = make("div", { class: "cloud-save-status-row" });

    if (cloudManager.isConnected()) {
      const provLabel = getCloudProviderLabel(cloudManager.providerId);
      const statusDot = make("span", { class: "cloud-connection-item__status status--online" }, "● Connected");
      const provName  = make("span", { class: "cloud-save-status__provider" }, `${provLabel} backup active`);
      const lastSync  = cloudManager.lastSyncAt
        ? make("span", { class: "cloud-save-status__lastsync" }, `Last sync: ${formatRelativeTime(cloudManager.lastSyncAt)}`)
        : make("span", { class: "cloud-save-status__lastsync" }, "Saves will be mirrored after your next game save.");
      const disconnectBtn = make("button", { class: "btn btn--sm", type: "button" }, "Disconnect") as HTMLButtonElement;
      disconnectBtn.addEventListener("click", () => {
        cloudManager.disconnect();
        saveSection.innerHTML = "";
        saveSection.appendChild(make("h5", { class: "cloud-library-section__title" }, "Cloud Save Backup"));
        saveSection.appendChild(buildSaveStatus());
      });
      statusRow.append(statusDot, provName, lastSync, disconnectBtn);
    } else {
      const hint = make("p", { class: "settings-help" },
        "Save states live in your browser. Connect a cloud provider to keep them backed up and accessible on other devices."
      );
      const connectBtn = make("button", { class: "btn btn--primary", type: "button" }, "☁ Connect Cloud Backup") as HTMLButtonElement;
      connectBtn.addEventListener("click", () => {
        void showCloudConnectDialog().then(connected => {
          if (connected) {
            saveSection.innerHTML = "";
            saveSection.appendChild(make("h5", { class: "cloud-library-section__title" }, "Cloud Save Backup"));
            saveSection.appendChild(buildSaveStatus());
          }
        });
      });
      statusRow.append(hint, connectBtn);
    }

    return statusRow;
  };

  saveSection.appendChild(buildSaveStatus());
  section.appendChild(saveSection);

  // ── Cloud library sources section ──────────────────────────────────────────

  const rebuildTab = () => buildCloudTab(container, settings, library, onSettingsChange);

  const list = make("div", { class: "cloud-connection-list" });

  const librarySection = make("div", { class: "cloud-library-section" });
  librarySection.appendChild(make("h5", { class: "cloud-library-section__title" }, "Cloud Library Sources"));
  librarySection.appendChild(make("p", { class: "settings-help" }, "Connect a provider below to stream or import remote games into your local library view."));

  if (settings.cloudLibraries.length === 0) {
    const empty = make("div", { class: "cloud-connection-empty" });
    empty.innerHTML = `<p>No cloud library sources connected yet.</p><p>Your local library still works normally. Add a cloud source to browse remote games alongside it.</p>`;
    list.appendChild(empty);
  } else {
    settings.cloudLibraries.forEach((conn) => {
      const item   = make("div", { class: "cloud-connection-item" });
      const info   = make("div", { class: "cloud-connection-item__info" });
      info.appendChild(make("strong", {}, conn.name));
      info.appendChild(make("span", {}, getCloudProviderLabel(conn.provider)));

      const statusDot = make("span", { class: "cloud-connection-item__status" }, "● Checking…");
      info.appendChild(statusDot);

      // Async availability check — update badge once resolved
      const provider = createProvider(conn);
      if (provider) {
        provider.isAvailable().then(ok => {
          statusDot.textContent = ok ? "● Ready" : "● Unavailable";
          statusDot.className   = `cloud-connection-item__status ${ok ? "status--online" : "status--offline"}`;
        }).catch(() => {
          statusDot.textContent = "● Unavailable";
          statusDot.className   = "cloud-connection-item__status status--offline";
        });
      } else {
        statusDot.textContent = "● Config error";
        statusDot.className   = "cloud-connection-item__status status--offline";
      }

      const actions = make("div", { class: "cloud-connection-item__actions" });

      const syncBtn = make("button", { class: "btn btn--sm", type: "button" }, "↻ Sync");
      syncBtn.addEventListener("click", () => syncCloudLibrary(conn, library, onSettingsChange));

      const removeBtn = make("button", { class: "btn btn--sm btn--danger", type: "button" }, "Remove");
      removeBtn.addEventListener("click", () => {
        const filtered = settings.cloudLibraries.filter(c => c.id !== conn.id);
        onSettingsChange({ cloudLibraries: filtered });
        rebuildTab();
      });

      actions.append(syncBtn, removeBtn);
      item.append(info, actions);
      list.appendChild(item);
    });
  }

  const addBtn = make("button", { class: "btn btn--primary cloud-connection-add", type: "button" }, "+ Connect New Source");
  addBtn.addEventListener("click", () => {
    void showAddCloudLibraryDialog(settings, onSettingsChange, rebuildTab);
  });

  librarySection.append(list, addBtn);
  section.append(librarySection);
  container.appendChild(section);
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

async function syncCloudLibrary(
  conn: CloudLibraryConnection,
  library: GameLibrary,
  onSettingsChange: (patch: Partial<Settings>) => void
): Promise<void> {
  const provider = createProvider(conn);
  if (!provider) {
    showError("Invalid cloud provider configuration.");
    return;
  }

  showLoadingOverlay();
  setLoadingMessage(`Syncing ${conn.name}…`);
  try {
    if (!(await provider.isAvailable())) {
      throw new Error("Cloud provider is not reachable. Check your connection or credentials.");
    }
    
    setLoadingSubtitle("Scanning for game files…");
    const files = await provider.listFiles();
    const romFiles = files.filter(f => !f.isDirectory && detectSystem(f.name));
    
    setLoadingSubtitle(`Found ${romFiles.length} games. Integrating into library…`);
    
    for (const f of romFiles) {
      const res = detectSystem(f.name);
      if (res) {
         const sys = Array.isArray(res) ? res[0] : res;
         if (!sys) continue;
         const systemId = sys.id;
         // Cloud entries are keyed by remote source + remote path so they can
         // live beside local ROMs without being treated as duplicates.
         await library.upsertVirtualGame(
           f.name.replace(/\.[^.]+$/, ""),
           f.name,
           systemId,
           f.size,
           conn.id,
           f.path,
           f.thumbnailUrl
         );
      }
    }
    
    showInfoToast(`Synced ${romFiles.length} cloud games from ${conn.name}.`, "success");
    onSettingsChange({});
    // We don't need to call onSettingsChange unless we want to trigger a re-render of something specific,
    // but the library grid will re-render automatically if we invalidate/trigger it.
    // renderLibrary will be called by the next refresh cycle or we can force it.
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to sync cloud library.";
    showError(message);
  } finally {
    hideLoadingOverlay();
  }
}

// ── Visibility helpers ────────────────────────────────────────────────────────

export function hideLanding(): void    { el("#landing").classList.add("hidden"); }
export function showLanding(): void    { el("#landing").classList.remove("hidden"); }
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
export function showEjsContainer(): void  { document.getElementById("ejs-container")?.classList.add("visible"); }
export function hideEjsContainer(): void  { document.getElementById("ejs-container")?.classList.remove("visible"); }

export function transitionToGame(): void {
  hideLanding();
  requestAnimationFrame(() => showEjsContainer());
}

export function transitionToLibrary(): void {
  hideEjsContainer();
  requestAnimationFrame(() => showLanding());
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
export function setStatusGame(name: string): void    { const e = document.getElementById("status-game");    if (e) e.textContent = name; }
export function setStatusSystem(name: string): void  { const e = document.getElementById("status-system");  if (e) e.textContent = name; }
function setStatusTier(tier: PerformanceTier | null): void { const e = document.getElementById("status-tier"); if (e) e.textContent = tier ? formatTierLabel(tier) : "—"; }

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
    return "Not enough storage space to save this game. Try clearing some old games or saves in Settings → My Games.";
  }
  if (m.includes("network") || m.includes("fetch") || m.includes("failed to load")) {
    return "Couldn't load a required file. Check your internet connection and try again.";
  }
  if ((m.includes("dreamcast") || m.includes("flycast")) && (m.includes("experimental") || m.includes("stabil"))) {
    return "Dreamcast support is experimental right now. Some games may boot slowly, show glitches, or crash.\n\nIf it fails, try another title, lower the load on your device, and make sure both Dreamcast BIOS files are installed.";
  }
  if (m.includes("bios") || m.includes("startup file")) {
    return "This game needs a startup file (BIOS). Go to Settings → System Files to add one.";
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

  // Icon varies by type
  const iconMap: Record<string, string> = { success: "✓", info: "ℹ", warning: "⚠", error: "✕" };
  const icon = document.createElement("span");
  icon.className = "info-toast__icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = (iconMap[type] ?? iconMap.success) as string;

  const text = document.createElement("span");
  text.textContent = msg;

  const closeBtn = document.createElement("button");
  closeBtn.className = "error-close";
  closeBtn.textContent = "✕";
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

// ── Test helpers ──────────────────────────────────────────────────────────────
