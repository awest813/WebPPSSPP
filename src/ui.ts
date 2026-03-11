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
 *   F1  → Reset
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
  type SystemInfo,
} from "./systems.js";
import {
  GameLibrary,
  formatBytes,
  formatRelativeTime,
  type GameMetadata,
} from "./library.js";
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
} from "./performance.js";
import {
  BiosLibrary,
  BIOS_REQUIREMENTS,
} from "./bios.js";
import {
  SaveStateLibrary,
  type SaveStateEntry,
  AUTO_SAVE_SLOT,
  MAX_SAVE_SLOTS,
  saveStateKey,
  defaultSlotLabel,
  createThumbnail,
  stateBytesToBlob,
  downloadBlob,
  verifySaveChecksum,
} from "./saves.js";
import type { Settings } from "./main.js";
import type { TouchControlsOverlay } from "./touchControls.js";
import { isTouchDevice, isPortrait } from "./touchControls.js";
import type { NetplayManager } from "./multiplayer.js";
import {
  DEFAULT_ICE_SERVERS,
  validateIceServerUrl as standaloneValidateIceServerUrl,
  resolveNetplayRoomKey,
  roomDisplayNameForKey,
  NETPLAY_SUPPORTED_SYSTEM_IDS,
  SYSTEM_LINK_CAPABILITIES,
} from "./multiplayer.js";
import { EasyNetplayManager } from "./netplay/EasyNetplayManager.js";
import type { EasyNetplayRoom } from "./netplay/netplayTypes.js";
import { normaliseInviteCode } from "./netplay/signalingClient.js";
import { checkSystemSupport } from "./netplay/compatibility.js";
import { CloudSaveManager, WebDAVProvider, GoogleDriveProvider, DropboxProvider, pCloudProvider, type ConflictResolution, type SyncConflict, type SyncBadge } from "./cloudSave.js";
import { SaveGameService, type SaveOperationStatus } from "./saveService.js";
import type { ArchiveExtractProgress, ArchiveFormat } from "./archive.js";

// ── PWA install callbacks (set once from initUI) ───────────────────────────────
let _canInstallPWA: (() => boolean) | undefined;
let _onInstallPWA:  (() => Promise<boolean>) | undefined;

// ── Cloud save manager (module-level singleton) ────────────────────────────────
let _cloudManager: CloudSaveManager | null = null;
let _initUICleanup: (() => void) | null = null;
export const TOUCH_CONTROLS_CHANGED_EVENT = "retrovault:touchControlsChanged";

function getCloudManager(): CloudSaveManager {
  if (!_cloudManager) _cloudManager = new CloudSaveManager();
  return _cloudManager;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function el<T extends HTMLElement = HTMLElement>(sel: string): T {
  const node = document.querySelector<T>(sel);
  if (!node) throw new Error(`UI: element not found: "${sel}"`);
  return node;
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (string | Node)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
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
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none"
             stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <!-- Controller body -->
          <rect x="2" y="7" width="24" height="14" rx="7"/>
          <!-- D-pad left group -->
          <rect x="7" y="12.5" width="5" height="3" rx="1" fill="currentColor" stroke="none" opacity="0.7"/>
          <rect x="8.5" y="11" width="2" height="6" rx="1" fill="currentColor" stroke="none" opacity="0.7"/>
          <!-- ABXY buttons -->
          <circle cx="20" cy="12.5" r="1.2" fill="currentColor" stroke="none"/>
          <circle cx="22.5" cy="14" r="1.2" fill="currentColor" stroke="none"/>
          <circle cx="20" cy="15.5" r="1.2" fill="currentColor" stroke="none"/>
          <circle cx="17.5" cy="14" r="1.2" fill="currentColor" stroke="none"/>
          <!-- Center buttons -->
          <circle cx="13" cy="14" r="1" fill="currentColor" stroke="none" opacity="0.5"/>
          <circle cx="15" cy="14" r="1" fill="currentColor" stroke="none" opacity="0.5"/>
        </svg>
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
            <div class="library-controls">
              <div class="library-search-wrap">
                <svg class="library-search-icon" width="14" height="14" viewBox="0 0 24 24"
                     fill="none" stroke="currentColor" stroke-width="2.5"
                     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input class="library-search" id="library-search"
                       type="search" placeholder="Search games…" autocomplete="off"
                       aria-label="Search games" />
              </div>
              <select class="library-sort" id="library-sort" aria-label="Sort games">
                <option value="lastPlayed">Last Played</option>
                <option value="name">Name</option>
                <option value="added">Date Added</option>
                <option value="system">System</option>
              </select>
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
        <div class="drop-zone" id="drop-zone" tabindex="0" role="button" aria-label="Add a game file">
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
          <p class="drop-zone__label">${touchUI ? "Tap to choose a game and start playing" : "Drop a game file here to start playing"}</p>
          <p class="drop-zone__sub">${touchUI ? "Browse your device to select a ROM file" : 'or <span class="drop-zone__browse">browse your device</span>'}</p>
          <p class="drop-zone__formats" title="Supported file formats">${formatHint}</p>
        </div>

        <!-- Onboarding — only visible when library is empty -->
        <div class="onboarding" id="onboarding">
          <div class="welcome-hero">
            <h2 class="welcome-hero__title">Play retro games in your browser</h2>
            <p class="welcome-hero__tagline">PSP · N64 · PS1 · GBA · SNES · NES and 20+ more systems — no installs, no account, nothing to sign up for</p>
            <div class="welcome-steps">
              <div class="welcome-step">
                <span class="welcome-step__num" aria-hidden="true">1</span>
                <span class="welcome-step__text">Drop or choose a game file above</span>
              </div>
              <div class="welcome-step">
                <span class="welcome-step__num" aria-hidden="true">2</span>
                <span class="welcome-step__text">Pick a system if needed</span>
              </div>
              <div class="welcome-step">
                <span class="welcome-step__num" aria-hidden="true">3</span>
                <span class="welcome-step__text">Start playing! 🎉</span>
              </div>
            </div>
          </div>
          <div class="onboarding__features">
            <div class="onboarding__feature">
              <span class="onboarding__feature-icon" aria-hidden="true">💾</span>
              <span><strong>Save anytime</strong><br>Snapshot your progress and pick up later</span>
            </div>
            <div class="onboarding__feature">
              <span class="onboarding__feature-icon" aria-hidden="true">🎮</span>
              <span><strong>Any controller</strong><br>Touch screen, keyboard, USB or Bluetooth pad</span>
            </div>
            <div class="onboarding__feature">
              <span class="onboarding__feature-icon" aria-hidden="true">⚡</span>
              <span><strong>Auto-tuned</strong><br>Detects your device and picks the best settings</span>
            </div>
            <div class="onboarding__feature">
              <span class="onboarding__feature-icon" aria-hidden="true">🔒</span>
              <span><strong>Private &amp; offline</strong><br>Your games stay in your browser, never uploaded</span>
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
        <!-- FPS overlay (positioned over the game canvas) -->
        <div id="fps-overlay" class="fps-overlay" hidden>
          <span id="fps-current">-- FPS</span>
          <span id="fps-avg" class="fps-detail">avg --</span>
          <span id="fps-tier" class="fps-detail"></span>
          <span id="fps-dropped" class="fps-detail fps-warn" hidden>0 dropped</span>
          <canvas id="fps-visualiser" class="fps-visualiser" width="120" height="32" hidden aria-hidden="true"></canvas>
        </div>
        <!-- Developer debug overlay (toggle with F3) -->
        <div id="dev-overlay" class="dev-overlay" hidden aria-label="Developer debug overlay" aria-live="off">
          <div class="dev-overlay__title">🔧 Dev Overlay <kbd>F3</kbd></div>
          <div class="dev-overlay__grid">
            <span class="dev-overlay__label">FPS</span><span id="dev-fps" class="dev-overlay__value">--</span>
            <span class="dev-overlay__label">Frame</span><span id="dev-frame-time" class="dev-overlay__value">-- ms</span>
            <span class="dev-overlay__label">P95</span><span id="dev-p95" class="dev-overlay__value">-- ms</span>
            <span class="dev-overlay__label">Dropped</span><span id="dev-dropped" class="dev-overlay__value">0</span>
            <span class="dev-overlay__label">Memory</span><span id="dev-memory" class="dev-overlay__value">-- MB</span>
            <span class="dev-overlay__label">State</span><span id="dev-state" class="dev-overlay__value">idle</span>
          </div>
          <canvas id="dev-framegraph" class="dev-overlay__graph" width="180" height="40" aria-hidden="true"></canvas>
        </div>
      </div>

      <!-- Loading overlay -->
      <div id="loading-overlay" role="status" aria-live="polite">
        <div class="loading-spinner" aria-hidden="true"></div>
        <p id="loading-message">Loading…</p>
        <p id="loading-subtitle"></p>
      </div>

      <!-- Error banner -->
      <div id="error-banner" role="alert" aria-live="assertive">
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
        <span class="status-item__value" style="opacity:0.45;font-size:0.7rem">RetroVault v1.0</span>
      </div>
    </footer>
  `;
}

// ── Public init ───────────────────────────────────────────────────────────────

export interface UIOptions {
  emulator:          PSPEmulator;
  library:           GameLibrary;
  biosLibrary:       BiosLibrary;
  saveLibrary:       SaveStateLibrary;
  netplayManager?:   NetplayManager;
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
  getTouchOverlay?:   () => TouchControlsOverlay | null;
  canInstallPWA?:     () => boolean;
  onInstallPWA?:      () => Promise<boolean>;
}

export function initUI(opts: UIOptions): void {
  // Re-initialisation safety: remove previously registered listeners so
  // repeated initUI() calls (tests/hot-reload) don't accumulate handlers.
  _initUICleanup?.();
  _initUICleanup = null;

  const { emulator, library, biosLibrary, saveLibrary, netplayManager, settings, deviceCaps,
          onLaunchGame, onSettingsChange, onReturnToLibrary,
          onApplyPatch, onFileChosen,
          getCurrentGameId, getCurrentGameName, getCurrentSystemId,
          getTouchOverlay, canInstallPWA, onInstallPWA } = opts;

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

  // ── File drop / pick ──────────────────────────────────────────────────────
  const fileInput = el<HTMLInputElement>("#file-input");
  const dropZone  = el("#drop-zone");
  let dragDepth = 0;
  let dragOverActive = false;
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
    fileInput.click();
  };
  bindEvent(dropZone, "keydown", onDropZoneKeydown);

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
    const playing  = emulator.state === "running";
    const portrait = isPortrait();
    rotateHintEl.classList.toggle("rotate-hint--visible", playing && portrait);
  };
  bindEvent(window, "orientationchange", updateRotateHint);
  bindEvent(window, "resize", updateRotateHint);

  // ── FPS overlay wiring ────────────────────────────────────────────────────
  emulator.setFPSMonitorEnabled(settings.showFPS);
  emulator.onFPSUpdate = (snapshot) => {
    updateFPSOverlay(snapshot, emulator);
    updateDevOverlay(snapshot, emulator);
  };

  // ── Emulator lifecycle → DOM ──────────────────────────────────────────────
  emulator.onStateChange = (state) => {
    updateStatusDot(state);
    updateRotateHint();
  };
  emulator.onProgress    = (msg)   => setLoadingMessage(msg);
  emulator.onError       = (msg)   => { hideLoadingOverlay(); showError(msg); };
  emulator.onGameStart = () => {
    hideLoadingOverlay();
    showEjsContainer();
    hideLanding();
    // Hide FAB and show rotate-hint when appropriate
    mobileFab?.classList.add("mobile-fab--hidden");
    updateRotateHint();
    resetPerfSuggestion();
    const sys  = emulator.currentSystem;
    const name = settings.lastGameName ?? "Unknown";
    setStatusSystem(sys ? sys.shortName : "—");
    setStatusGame(name);
    setStatusTier(emulator.activeTier);
    document.title = `${name} — RetroVault`;
    const openSettingsWith = (tab?: SettingsTab) =>
      openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, netplayManager, tab);
    buildInGameControls(
      emulator, settings, onSettingsChange, onReturnToLibrary,
      saveLibrary, getCurrentGameId, getCurrentGameName, getCurrentSystemId,
      getTouchOverlay, openSettingsWith, netplayManager
    );
    showFPSOverlay(settings.showFPS, emulator, settings.showAudioVis);
    if (settings.touchControls) {
      const overlay = getTouchOverlay?.();
      if (overlay) requestAnimationFrame(() => overlay.show());
    }
    document.dispatchEvent(new CustomEvent("retrovault:gameStarted"));
  };

  const onResumeGameEvent = () => {
    showEjsContainer();
    hideLanding();
    // Hide FAB and show rotate-hint when appropriate
    mobileFab?.classList.add("mobile-fab--hidden");
    updateRotateHint();
    const sys  = emulator.currentSystem;
    const name = settings.lastGameName ?? "Unknown";
    document.title = `${name} — RetroVault`;
    setStatusSystem(sys ? sys.shortName : "—");
    setStatusGame(name);
    const openSettingsWithResume = (tab?: SettingsTab) =>
      openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, netplayManager, tab);
    buildInGameControls(
      emulator, settings, onSettingsChange, onReturnToLibrary,
      saveLibrary, getCurrentGameId, getCurrentGameName, getCurrentSystemId,
      getTouchOverlay, openSettingsWithResume, netplayManager
    );
    showFPSOverlay(settings.showFPS, emulator, settings.showAudioVis);
    if (settings.touchControls) {
      const overlay = getTouchOverlay?.();
      if (overlay) requestAnimationFrame(() => overlay.show());
    }
  };
  bindEvent(document, "retrovault:resumeGame", onResumeGameEvent);

  const rebuildInGameControls = () => {
    if (emulator.state !== "running" && emulator.state !== "paused") return;
    const openSettingsWith = (tab?: SettingsTab) =>
      openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, netplayManager, tab);
    buildInGameControls(
      emulator, settings, onSettingsChange, onReturnToLibrary,
      saveLibrary, getCurrentGameId, getCurrentGameName, getCurrentSystemId,
      getTouchOverlay, openSettingsWith, netplayManager
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
    // F9 opens the Debug tab from anywhere (landing or in-game)
    if (e.key === "F9") {
      e.preventDefault();
      e.stopPropagation();
      openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, saveLibrary, netplayManager, "debug");
      return;
    }
    // F3 toggles the developer debug overlay from anywhere
    if (e.key === "F3") {
      e.preventDefault();
      e.stopPropagation();
      toggleDevOverlay();
      return;
    }
    if (emulator.state !== "running") return;
    switch (e.key) {
      case "F5":
        e.preventDefault();
        e.stopPropagation();
        void quickSaveWithPersist(emulator, saveLibrary, getCurrentGameId, getCurrentGameName, getCurrentSystemId, 1)
          .then(() => showInfoToast("Saved to Slot 1"))
          .catch(() => showError("Quick save failed."));
        break;
      case "F7":
        e.preventDefault();
        e.stopPropagation();
        emulator.quickLoad(1);
        showInfoToast("Loaded Slot 1");
        break;
      case "F1":
        e.preventDefault();
        e.stopPropagation();
        emulator.reset();
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
  buildLandingControls(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, undefined, saveLibrary, netplayManager);

  if (typeof ResizeObserver !== "undefined") {
    const headerActions = document.getElementById("header-actions");
    if (headerActions) {
      new ResizeObserver(updateHeaderOverflow).observe(headerActions);
    }
  }

  // ── Initial library render ────────────────────────────────────────────────
  _initUICleanup = () => {
    cleanupFns.forEach((cleanup) => cleanup());
    cleanupFns.length = 0;
  };

  void renderLibrary(library, settings, onLaunchGame, emulator, onApplyPatch);
}

// ── Library rendering ─────────────────────────────────────────────────────────

type SortMode = "lastPlayed" | "name" | "added" | "system";

let _librarySearchQuery = "";
let _librarySortMode: SortMode = "lastPlayed";
let _librarySystemFilter = "";
let _librarySearchDebounce: ReturnType<typeof setTimeout> | null = null;

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
  if (onboardingEl) onboardingEl.classList.toggle("hidden-section", allGames.length > 0);

  if (emulatorRef && allGames.length > 0) {
    const systemIds = new Set(allGames.map(g => g.systemId));
    for (const sid of systemIds) { emulatorRef.prefetchCore(sid); }
  }

  grid.innerHTML = "";

  if (displayed.length === 0 && allGames.length > 0) {
    const empty = make("div", { class: "library-empty" });
    empty.innerHTML = `<p>No games match "<em>${_escHtml(_librarySearchQuery)}</em>" — try a different search</p>`;
    grid.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const game of displayed) {
    fragment.appendChild(buildGameCard(game, library, settings, onLaunchGame, emulatorRef, onApplyPatch));
  }
  grid.appendChild(fragment);
}

function _applyLibraryFilters(games: GameMetadata[]): GameMetadata[] {
  let result = games;

  if (_librarySystemFilter) {
    result = result.filter(g => g.systemId === _librarySystemFilter);
  }

  if (_librarySearchQuery) {
    const q = _librarySearchQuery.toLowerCase();
    result = result.filter(g => g.name.toLowerCase().includes(q) || g.systemId.toLowerCase().includes(q));
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

// Persists the last non-zero volume across buildInGameControls rebuilds (e.g.
// game resume) so mute/unmute restores the correct level after a re-render.
let _preMuteVolume = 0.7;
function _wireLibraryControls(
  _allGames: GameMetadata[],
  library: GameLibrary,
  settings: Settings,
  onLaunchGame: (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef?: PSPEmulator,
  onApplyPatch?: (gameId: string, patchFile: File) => Promise<void>
): void {
  if (_libraryControlsWired) return;
  _libraryControlsWired = true;

  const searchEl = document.getElementById("library-search") as HTMLInputElement | null;
  const sortEl   = document.getElementById("library-sort") as HTMLSelectElement | null;

  if (searchEl) {
    searchEl.value = _librarySearchQuery;
    searchEl.addEventListener("input", () => {
      _librarySearchQuery = searchEl.value;
      if (_librarySearchDebounce !== null) clearTimeout(_librarySearchDebounce);
      _librarySearchDebounce = setTimeout(() => {
        _librarySearchDebounce = null;
        void renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
      }, 120);
    });
  }

  if (sortEl) {
    sortEl.value = _librarySortMode;
    sortEl.addEventListener("change", () => {
      _librarySortMode = sortEl.value as SortMode;
      void renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    });
  }
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
    void renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
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
      void renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
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

  const card = make("div", { class: "game-card", role: "button", tabindex: "0", "aria-label": `Play ${game.name} (${system?.shortName ?? game.systemId})` });
  card.style.setProperty("--sys-color", system?.color ?? "#555");

  const icon = make("div", { class: "game-card__icon" });
  icon.setAttribute("aria-hidden", "true");
  icon.style.background = `linear-gradient(135deg, ${system?.color ?? "#555"}33, ${system?.color ?? "#555"}11)`;
  icon.textContent = systemIcon(game.systemId);

  const info = make("div", { class: "game-card__info" });
  const name = make("div", { class: "game-card__name" }, game.name);
  const meta = make("div", { class: "game-card__meta" });
  const badge = make("span", { class: "sys-badge" }, system?.shortName ?? game.systemId);
  badge.style.background = system?.color ?? "#555";
  const size = make("span", { class: "game-card__size" }, formatBytes(game.size));
  meta.append(badge, size);

  const played = make("div", { class: "game-card__played" },
    game.lastPlayedAt
      ? `Played ${formatRelativeTime(game.lastPlayedAt)}`
      : `Added ${formatRelativeTime(game.addedAt)}`
  );

  info.append(name, meta, played);

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
    void renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
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
  card.append(btnChangeSystem, btnRemove, playOverlay);

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
      const blob = await library.getGameBlob(game.id);
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

function systemIcon(systemId: string): string {
  const icons: Record<string, string> = {
    psp: "🎮", nes: "🕹", snes: "🕹", gba: "🎯", gbc: "🟢", gb: "⬜",
    nds: "📱", n64: "🎮", psx: "🔵", segaMD: "⚡", segaGG: "🔶",
    segaMS: "📺", atari2600: "👾", arcade: "🕹", segaSaturn: "💫",
    segaDC: "🌀", mame2003: "🕹", atari7800: "👾", lynx: "📟", ngp: "🔴",
  };
  return icons[systemId] ?? "🎮";
}

function volIcon(volume: number): string {
  if (volume === 0) return "🔇";
  if (volume < 0.5) return "🔉";
  return "🔊";
}

function _escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
function _isTopmostOverlay(overlay: HTMLElement): boolean {
  const all = document.querySelectorAll<HTMLElement>(".confirm-overlay");
  return all.length > 0 && all[all.length - 1] === overlay;
}

function showConfirmDialog(
  message: string,
  opts: { title?: string; confirmLabel?: string; isDanger?: boolean } = {}
): Promise<boolean> {
  const { title, confirmLabel = "Confirm", isDanger = false } = opts;
  return new Promise((resolve) => {
    const overlay = make("div", { class: "confirm-overlay" });
    const box = make("div", { class: "confirm-box", role: "dialog", "aria-modal": "true" });
    if (title) box.setAttribute("aria-label", title);
    if (title) box.appendChild(make("h3", { class: "confirm-title" }, title));
    box.appendChild(make("p", { class: "confirm-body" }, message));

    const footer    = make("div", { class: "confirm-footer" });
    const btnCancel = make("button", { class: "btn" }, "Cancel");
    const btnConfirm = make("button", { class: isDanger ? "btn btn--danger-filled" : "btn btn--primary" }, confirmLabel);
    footer.append(btnCancel, btnConfirm);
    box.appendChild(footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = (result: boolean) => {
      document.removeEventListener("keydown", onKey, { capture: true });
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), 200);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && _isTopmostOverlay(overlay)) {
        e.preventDefault();
        e.stopPropagation();
        close(false);
      }
    };
    btnCancel.addEventListener("click",  () => close(false));
    btnConfirm.addEventListener("click", () => close(true));
    overlay.addEventListener("click",    (e) => { if (e.target === overlay) close(false); });
    document.addEventListener("keydown", onKey, { capture: true });
    requestAnimationFrame(() => { overlay.classList.add("confirm-overlay--visible"); btnConfirm.focus(); });
  });
}

// ── Conflict-resolution modal ─────────────────────────────────────────────────

/**
 * Show a modal dialog for explicit cloud-save conflict resolution.
 * Returns the user's chosen ConflictResolution strategy for this slot.
 */
function showConflictResolutionDialog(
  conflict: SyncConflict,
): Promise<ConflictResolution> {
  return new Promise((resolve) => {
    const overlay = make("div", { class: "confirm-overlay" });
    const box = make("div", {
      class: "confirm-box conflict-resolution-box",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Resolve save conflict",
    });

    box.appendChild(make("h3", { class: "confirm-title" }, "Save Conflict Detected"));

    const localDate  = new Date(conflict.local.timestamp).toLocaleString();
    const remoteDate = new Date(conflict.remote.timestamp).toLocaleString();
    const body = make("div", { class: "conflict-body" });
    body.appendChild(make("p", {}, `Slot ${conflict.slot} has different saves locally and in the cloud.`));

    const table = make("div", { class: "conflict-compare" });
    table.appendChild(make("div", { class: "conflict-side" },
      `📁 Local: ${localDate}`));
    table.appendChild(make("div", { class: "conflict-side" },
      `☁ Cloud: ${remoteDate}`));
    body.appendChild(table);
    box.appendChild(body);

    const footer = make("div", { class: "confirm-footer conflict-footer" });
    const btnLocal  = make("button", { class: "btn" }, "Keep Local");
    const btnRemote = make("button", { class: "btn" }, "Keep Cloud");
    const btnNewest = make("button", { class: "btn btn--primary" }, "Keep Newest");

    const close = (result: ConflictResolution) => {
      document.removeEventListener("keydown", onKey, { capture: true });
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), 200);
      resolve(result);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && _isTopmostOverlay(overlay)) { e.preventDefault(); e.stopPropagation(); close("newest"); }
    };

    btnLocal.addEventListener("click",  () => close("local"));
    btnRemote.addEventListener("click", () => close("remote"));
    btnNewest.addEventListener("click", () => close("newest"));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close("newest"); });
    document.addEventListener("keydown", onKey, { capture: true });

    footer.append(btnLocal, btnRemote, btnNewest);
    box.appendChild(footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => { overlay.classList.add("confirm-overlay--visible"); btnNewest.focus(); });
  });
}

// ── Import checksum validation dialog ─────────────────────────────────────────

/**
 * Show a recovery dialog when an imported save file fails checksum validation.
 * Returns "keep" to keep the imported data, "reimport" to let the user try
 * again, or "discard" to throw away the corrupted import.
 */
function showChecksumFailureDialog(): Promise<"keep" | "reimport" | "discard"> {
  return new Promise((resolve) => {
    const overlay = make("div", { class: "confirm-overlay" });
    const box = make("div", {
      class: "confirm-box",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Checksum mismatch",
    });

    box.appendChild(make("h3", { class: "confirm-title" }, "Possible Corrupt Import"));
    box.appendChild(make("p", { class: "confirm-body" },
      "The imported save file's checksum does not match its contents. " +
      "This may indicate a corrupted or modified file."));

    const footer = make("div", { class: "confirm-footer" });
    const btnKeep     = make("button", { class: "btn" }, "Keep Anyway");
    const btnReimport = make("button", { class: "btn btn--primary" }, "Re-Import");
    const btnDiscard  = make("button", { class: "btn btn--danger-filled" }, "Discard");

    const close = (result: "keep" | "reimport" | "discard") => {
      document.removeEventListener("keydown", onKey, { capture: true });
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), 200);
      resolve(result);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && _isTopmostOverlay(overlay)) { e.preventDefault(); e.stopPropagation(); close("discard"); }
    };

    btnKeep.addEventListener("click",     () => close("keep"));
    btnReimport.addEventListener("click", () => close("reimport"));
    btnDiscard.addEventListener("click",  () => close("discard"));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close("discard"); });
    document.addEventListener("keydown", onKey, { capture: true });

    footer.append(btnKeep, btnReimport, btnDiscard);
    box.appendChild(footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => { overlay.classList.add("confirm-overlay--visible"); btnReimport.focus(); });
  });
}

// ── System picker modal ───────────────────────────────────────────────────────

function pickSystem(fileName: string, candidates: SystemInfo[], subtitleText?: string): Promise<SystemInfo | null> {
  return new Promise((resolve) => {
    const panel    = document.getElementById("system-picker")!;
    const list     = document.getElementById("system-picker-list")!;
    const subtitle = document.getElementById("system-picker-subtitle")!;
    const closeBtn = document.getElementById("system-picker-close")!;
    const backdrop = document.getElementById("system-picker-backdrop")!;

    subtitle.textContent = subtitleText ?? `The file "${fileName}" could belong to several systems. Choose one:`;
    list.innerHTML = "";
    const fragment = document.createDocumentFragment();
    for (const sys of candidates) {
      const btn   = make("button", { class: "system-pick-btn" });
      const badge = make("span", { class: "sys-badge" }, sys.shortName);
      badge.style.background = sys.color;
      btn.append(badge, document.createTextNode(sys.name));
      btn.addEventListener("click", () => close(sys));
      fragment.appendChild(btn);
    }
    list.appendChild(fragment);
    panel.hidden = false;
    // Move focus into the modal
    requestAnimationFrame(() => closeBtn.focus());

    let closed = false;
    const onCloseClick = () => close(null);
    const onBackdropClick = () => close(null);

    const close = (result: SystemInfo | null) => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onEsc);
      closeBtn.removeEventListener("click", onCloseClick);
      backdrop.removeEventListener("click", onBackdropClick);
      panel.hidden = true;
      resolve(result);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key !== "Escape") return; close(null); };
    closeBtn.addEventListener("click", onCloseClick);
    backdrop.addEventListener("click", onBackdropClick);
    document.addEventListener("keydown", onEsc);
  });
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
            },
          });

      if (extracted) {
        const extractedCandidates = extracted.candidates ?? [];
        if (extractedCandidates.length > 1) {
          hideLoadingOverlay();
          const picked = await showArchiveEntryPickerDialog(
            extracted.format,
            extractedCandidates,
          );
          if (!picked) return;
          resolvedFile = new File([picked.blob], picked.name, { type: picked.blob.type });
          showLoadingOverlay();
          setLoadingMessage("File selected — detecting game system…");
          setLoadingSubtitle("");
          logImport(
            emulatorRef,
            settings,
            `Archive entry selected: "${picked.name}" (${formatBytes(picked.size)})`,
          );
        } else {
          resolvedFile = new File([extracted.blob], extracted.name, { type: extracted.blob.type });
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
      const picked = await pickSystem(resolvedFile.name, SYSTEMS);
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
        `Unrecognised file type: "${resolvedFile.name}".\n` +
        `Supported extensions: ${ALL_EXTENSIONS.map(e => `.${e}`).join("  ·  ")}`
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
        const existingFile = toLaunchFile(existing.blob, existing.fileName);
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
    const entry = await library.addGame(resolvedFile, system.id);
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
    showError(`Could not add game: ${err instanceof Error ? err.message : String(err)}`);
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
  return new Promise((resolve) => {
    const overlay = make("div", { class: "confirm-overlay" });
    const box = make("div", { class: "confirm-box", role: "dialog", "aria-modal": "true", "aria-label": title });

    box.appendChild(make("h3", { class: "confirm-title" }, title));
    box.appendChild(make("p", { class: "confirm-body" }, message));

    const list = make("div", { class: "game-picker-list" });
    const fragment = document.createDocumentFragment();
    for (const game of games) {
      const sys   = getSystemById(game.systemId);
      const btn   = make("button", { class: "game-picker-btn" });
      const badge = make("span", { class: "sys-badge" }, sys?.shortName ?? game.systemId);
      badge.style.background = sys?.color ?? "#555";
      btn.append(badge, document.createTextNode(" " + game.name));
      btn.addEventListener("click", () => close(game));
      fragment.appendChild(btn);
    }
    list.appendChild(fragment);
    box.appendChild(list);

    const cancelBtn = make("button", { class: "btn" }, "Cancel");
    cancelBtn.addEventListener("click", () => close(null));
    box.appendChild(cancelBtn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = (result: GameMetadata | null) => {
      document.removeEventListener("keydown", onKey, { capture: true });
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), 200);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && _isTopmostOverlay(overlay)) { e.preventDefault(); e.stopPropagation(); close(null); }
    };
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
    document.addEventListener("keydown", onKey, { capture: true });
    requestAnimationFrame(() => overlay.classList.add("confirm-overlay--visible"));
  });
}

function showArchiveEntryPickerDialog(
  format: ArchiveFormat,
  candidates: Array<{ name: string; blob: Blob; size: number }>
): Promise<{ name: string; blob: Blob; size: number } | null> {
  return new Promise((resolve) => {
    const overlay = make("div", { class: "confirm-overlay" });
    const box = make(
      "div",
      { class: "confirm-box archive-picker-box", role: "dialog", "aria-modal": "true", "aria-label": "Choose archive entry" }
    );

    const pretty = format === "gzip" ? "GZIP" : format.toUpperCase();
    box.appendChild(make("h3", { class: "confirm-title" }, "Choose File from Archive"));
    box.appendChild(make(
      "p",
      { class: "confirm-body" },
      `${pretty} archive contains multiple game files. Choose which one to import:`
    ));

    const list = make("div", { class: "game-picker-list" });
    const fragment = document.createDocumentFragment();
    for (const candidate of candidates) {
      const btn = make("button", { class: "game-picker-btn" });
      const badge = make("span", { class: "sys-badge" }, formatBytes(candidate.size));
      badge.style.background = "var(--c-accent)";
      btn.append(
        badge,
        document.createTextNode(" " + candidate.name),
      );
      btn.addEventListener("click", () => close(candidate));
      fragment.appendChild(btn);
    }
    list.appendChild(fragment);
    box.appendChild(list);

    const footer = make("div", { class: "confirm-footer" });
    const btnCancel = make("button", { class: "btn" }, "Cancel");
    footer.appendChild(btnCancel);
    box.appendChild(footer);

    let closed = false;
    const close = (picked: { name: string; blob: Blob; size: number } | null) => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onEsc, { capture: true });
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), 180);
      resolve(picked);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && _isTopmostOverlay(overlay)) { e.preventDefault(); e.stopPropagation(); close(null); }
    };
    btnCancel.addEventListener("click", () => close(null));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
    document.addEventListener("keydown", onEsc, { capture: true });

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("confirm-overlay--visible"));
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
        if (entry) storedDiscs.set(fn, { id: entry.id, blob: entry.blob });
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
  netplayManager?:  import("./multiplayer.js").NetplayManager
): void {
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
    openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulatorRef, onLaunchGame, saveLibrary, netplayManager);
  });

  const btnMultiplayer = make("button", {
    class: "btn",
    title: "Open Multiplayer — Host or join a game with friends",
    "aria-label": "Open multiplayer",
  }) as HTMLButtonElement;
  btnMultiplayer.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> Multiplayer`;
  btnMultiplayer.addEventListener("click", () => {
    openEasyNetplayModal({
      netplayManager,
      currentGameName:  null,
      currentGameId:    null,
      currentSystemId:  emulatorRef?.currentSystem?.id ?? null,
    });
  });

  container.appendChild(btnSettings);
  container.appendChild(btnMultiplayer);
  updateHeaderOverflow();
}

function buildInGameControls(
  emulator:           PSPEmulator,
  settings:           Settings,
  onSettingsChange:   (patch: Partial<Settings>) => void,
  onReturnToLibrary:  () => void,
  saveLibrary?:       SaveStateLibrary,
  getCurrentGameId?:  () => string | null,
  getCurrentGameName?: () => string | null,
  getCurrentSystemId?: () => string | null,
  getTouchOverlay?:   (() => TouchControlsOverlay | null) | undefined,
  onOpenSettings?:    (tab?: SettingsTab) => void,
  netplayManager?:    import("./multiplayer.js").NetplayManager,
): void {
  const container = el("#header-actions");
  container.innerHTML = "";

  // ← Library
  const btnLibrary = make("button", {
    class: "btn",
    title: "Return to library (Esc)",
    "data-tooltip": "Return to library (Esc)",
  });
  btnLibrary.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg> Library`;
  btnLibrary.addEventListener("click", onReturnToLibrary);

  // Saves group (Save / Load / Gallery combined)
  const savesGroup = make("div", { class: "btn-group" });

  const btnSave = make("button", {
    class: "btn btn-group__btn",
    title: "Quick Save to slot 1 (F5)",
    "data-tooltip": "Quick Save — Slot 1 (F5)",
  });
  btnSave.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save`;
  btnSave.addEventListener("click", async () => {
    try {
      await quickSaveWithPersist(emulator, saveLibrary, getCurrentGameId, getCurrentGameName, getCurrentSystemId, 1);
      showInfoToast("Saved to Slot 1");
    } catch {
      showError("Quick save failed.");
    }
  });

  const btnLoad = make("button", {
    class: "btn btn-group__btn",
    title: "Quick Load from slot 1 (F7)",
    "data-tooltip": "Quick Load — Slot 1 (F7)",
  });
  btnLoad.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Load`;
  btnLoad.addEventListener("click", () => { emulator.quickLoad(1); showInfoToast("Loaded Slot 1"); });

  const btnSavesGallery = make("button", {
    class: "btn btn-group__btn btn-group__btn--icon",
    title: "Save state gallery",
    "aria-label": "Open save state gallery",
    "data-tooltip": "All Save Slots",
  });
  btnSavesGallery.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`;
  btnSavesGallery.addEventListener("click", () => {
    if (saveLibrary && getCurrentGameId?.() && getCurrentGameName?.() && getCurrentSystemId?.()) {
      void openSaveGallery(emulator, saveLibrary, getCurrentGameId()!, getCurrentGameName()!, getCurrentSystemId()!);
    }
  });

  savesGroup.append(btnSave, btnLoad, btnSavesGallery);

  // Reset
  const btnReset = make("button", {
    class: "btn btn--danger",
    title: "Reset game (F1)",
    "data-tooltip": "Reset game (F1)",
  });
  btnReset.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/></svg> Reset`;
  btnReset.addEventListener("click", async () => {
    const confirmed = await showConfirmDialog(
      "Unsaved progress will be lost.",
      { title: "Reset Game?", confirmLabel: "Reset", isDanger: true }
    );
    if (confirmed) emulator.reset();
  });

  // FPS toggle
  const btnFPS = make("button", {
    class: settings.showFPS ? "btn btn--active" : "btn",
    title: "Toggle FPS overlay",
    "aria-pressed": settings.showFPS ? "true" : "false",
    "data-tooltip": "FPS Overlay",
  }, "FPS");
  btnFPS.addEventListener("click", () => {
    settings.showFPS = !settings.showFPS;
    onSettingsChange({ showFPS: settings.showFPS });
    btnFPS.className = settings.showFPS ? "btn btn--active" : "btn";
    btnFPS.setAttribute("aria-pressed", String(settings.showFPS));
    showFPSOverlay(settings.showFPS, emulator, settings.showAudioVis);
    emulator.setFPSMonitorEnabled(settings.showFPS);
  });

  // Touch controls — quick toggle + edit/reset buttons (touch devices only)
  let btnTouchToggle: HTMLButtonElement | null = null;
  let btnTouch: HTMLButtonElement | null = null;
  let btnTouchReset: HTMLButtonElement | null = null;

  if (isTouchDevice()) {
    const getOverlay = (): TouchControlsOverlay | null => getTouchOverlay?.() ?? null;
    const syncTouchButtons = (): void => {
      const overlay   = getOverlay();
      const canEdit   = settings.touchControls && !!overlay;
      const isEditing = !!overlay?.editing;

      if (btnTouchToggle) {
        btnTouchToggle.className = settings.touchControls ? "btn btn--active" : "btn";
        btnTouchToggle.setAttribute("aria-pressed", String(settings.touchControls));
        btnTouchToggle.title = settings.touchControls
          ? "Hide on-screen touch controls"
          : "Show on-screen touch controls";
        btnTouchToggle.setAttribute("data-tooltip", settings.touchControls ? "Hide Touch Controls" : "Show Touch Controls");
      }

      if (btnTouch) {
        btnTouch.disabled = !canEdit;
        btnTouch.className = isEditing ? "btn btn--active" : "btn";
        btnTouch.textContent = isEditing ? "✓ Done" : "🎮 Edit";
        btnTouch.title = canEdit
          ? (isEditing ? "Finish editing touch control layout" : "Edit touch control layout")
          : "Enable touch controls to edit the on-screen layout";
        btnTouch.setAttribute("data-tooltip", canEdit ? "Edit Touch Layout" : "Enable Touch Controls First");
        btnTouch.setAttribute("aria-pressed", String(isEditing));
      }

      if (btnTouchReset) {
        btnTouchReset.disabled = !canEdit;
        btnTouchReset.style.display = isEditing ? "" : "none";
      }
    };

    // 🕹 quick show/hide toggle — visible even when the overlay doesn't exist yet
    // (e.g. the user disabled touch controls in settings then re-enabled mid-game)
    btnTouchToggle = make("button", {
      class: settings.touchControls ? "btn btn--active" : "btn",
      title: settings.touchControls ? "Hide on-screen touch controls" : "Show on-screen touch controls",
      "aria-label": "Toggle on-screen touch controls",
      "aria-pressed": settings.touchControls ? "true" : "false",
      "data-tooltip": settings.touchControls ? "Hide Touch Controls" : "Show Touch Controls",
    }, "🕹") as HTMLButtonElement;
    btnTouchToggle.addEventListener("click", () => {
      onSettingsChange({ touchControls: !settings.touchControls });
      syncTouchButtons();
    });

    // 🎮 Edit — enter drag-to-reposition mode
    btnTouch = make("button", {
      class: "btn",
      title: "Enable touch controls to edit the on-screen layout",
      "aria-label": "Edit touch control layout",
      "data-tooltip": "Enable Touch Controls First",
    }, "🎮 Edit") as HTMLButtonElement;

    // ↺ Reset — visible only while editing; resets to defaults for this orientation
    btnTouchReset = make("button", {
      class: "btn",
      title: "Reset touch layout to defaults",
      "aria-label": "Reset touch control layout",
      "data-tooltip": "Reset Touch Layout",
      style: "display:none",
    }, "↺ Reset") as HTMLButtonElement;

    btnTouch.addEventListener("click", () => {
      const overlay = getOverlay();
      if (!settings.touchControls || !overlay) {
        syncTouchButtons();
        return;
      }
      overlay.setEditing(!overlay.editing);
      syncTouchButtons();
    });

    btnTouchReset.addEventListener("click", async () => {
      const overlay = getOverlay();
      if (!overlay) {
        syncTouchButtons();
        return;
      }
      const orientationLabel = isPortrait() ? "portrait" : "landscape";
      const confirmed = await showConfirmDialog(
        `Button positions will be reset to their defaults for ${orientationLabel} orientation.`,
        { title: "Reset Layout?", confirmLabel: "Reset" }
      );
      if (!confirmed) return;
      overlay.resetToDefaults();
      // Exit edit mode after reset so the user can play straight away
      overlay.setEditing(false);
      syncTouchButtons();
    });

    syncTouchButtons();
  }

  // Volume control
  _preMuteVolume = settings.volume > 0 ? settings.volume : _preMuteVolume;
  const volWrap  = make("div", { class: "btn vol-control" });
  const volBtn   = make("button", { class: "vol-mute-btn", title: "Toggle mute", "aria-label": "Toggle mute" }) as HTMLButtonElement;
  volBtn.textContent = volIcon(settings.volume);
  const volSlider = make("input", {
    type: "range", min: "0", max: "1", step: "0.05",
    value: String(settings.volume), "aria-label": "Volume",
  }) as HTMLInputElement;

  volBtn.addEventListener("click", () => {
    const newVol = settings.volume > 0 ? 0 : _preMuteVolume;
    if (settings.volume > 0) _preMuteVolume = settings.volume;
    emulator.setVolume(newVol);
    volSlider.value = String(newVol);
    onSettingsChange({ volume: newVol });
    volBtn.textContent = volIcon(newVol);
  });

  // Persist the volume setting at most once per 150 ms while dragging the
  // slider to avoid synchronous localStorage writes on every animation frame.
  let volDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  volSlider.addEventListener("input", () => {
    const v = Number(volSlider.value);
    if (v > 0) _preMuteVolume = v;
    emulator.setVolume(v);        // real-time audio update — no debounce
    volBtn.textContent = volIcon(v);
    if (volDebounceTimer !== null) clearTimeout(volDebounceTimer);
    volDebounceTimer = setTimeout(() => {
      volDebounceTimer = null;
      onSettingsChange({ volume: v });
    }, 150);
  });
  volSlider.addEventListener("change", () => {
    // Flush any pending debounced save when the drag ends (pointerup / blur).
    if (volDebounceTimer !== null) {
      clearTimeout(volDebounceTimer);
      volDebounceTimer = null;
    }
    onSettingsChange({ volume: Number(volSlider.value) });
  });
  volWrap.append(volBtn, volSlider);

  // Netplay button — always visible in-game when onOpenSettings is wired
  let btnNetplay: HTMLButtonElement | null = null;
  if (onOpenSettings) {
    const systemId = getCurrentSystemId?.() ?? "";
    const isNetplaySystem = (NETPLAY_SUPPORTED_SYSTEM_IDS as readonly string[]).includes(systemId);
    const isLinkCapable   = !systemId || SYSTEM_LINK_CAPABILITIES[systemId] === true;
    const isSupported     = isNetplaySystem && isLinkCapable;
    const isActive        = netplayManager?.isActive ?? false;

    let netplayTitle: string;
    if (systemId && !isSupported) {
      const sysName = getSystemById(systemId)?.shortName ?? systemId.toUpperCase();
      netplayTitle = `Netplay is not supported for this system (${sysName})`;
    } else if (!isActive) {
      netplayTitle = "Open Multiplayer Settings to configure netplay";
    } else {
      netplayTitle = "Open Multiplayer Settings";
    }

    btnNetplay = make("button", {
      class: (isSupported && isActive) ? "btn btn--active" : "btn",
      title: netplayTitle,
      "aria-label": "Open multiplayer settings",
      "data-tooltip": "Multiplayer",
    }) as HTMLButtonElement;
    btnNetplay.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> Netplay`;

    if (systemId && !isSupported) {
      btnNetplay.disabled = true;
    }

    btnNetplay.addEventListener("click", () => {
      openEasyNetplayModal({
        netplayManager,
        currentGameName:  getCurrentGameName?.() ?? null,
        currentGameId:    getCurrentGameId?.()   ?? null,
        currentSystemId:  getCurrentSystemId?.() ?? null,
      });
    });
  }

  const controls: (HTMLElement | null)[] = [btnLibrary, savesGroup, btnReset, btnFPS, btnTouchToggle, btnTouch, btnTouchReset, btnNetplay, volWrap];
  for (const ctrl of controls) {
    if (ctrl) container.appendChild(ctrl);
  }

  // "Now Playing" chip — appended last so it sits at the far right with auto margin
  const gameName = getCurrentGameName?.();
  if (gameName) {
    const chip = make("span", {
      class: "now-playing-chip",
      title: gameName,
      "aria-label": `Now playing: ${gameName}`,
      style: "margin-left: auto",
    }, gameName);
    container.appendChild(chip);
  }

  updateHeaderOverflow();
}

// ── Quick save with persistence helper ────────────────────────────────────────

async function quickSaveWithPersist(
  emulator:          PSPEmulator,
  saveLibrary?:      SaveStateLibrary,
  getCurrentGameId?: () => string | null,
  getCurrentGameName?: () => string | null,
  getCurrentSystemId?: () => string | null,
  slot = 1
): Promise<void> {
  emulator.quickSave(slot);
  if (saveLibrary && getCurrentGameId?.() && getCurrentGameName?.() && getCurrentSystemId?.()) {
    await persistSaveMetadata(emulator, saveLibrary, getCurrentGameId()!, getCurrentGameName()!, getCurrentSystemId()!, slot);
  }
}

// ── Save state helpers ────────────────────────────────────────────────────────

async function persistSaveMetadata(
  emulator:    PSPEmulator,
  saveLibrary: SaveStateLibrary,
  gameId:      string,
  gameName:    string,
  systemId:    string,
  slot:        number
): Promise<void> {
  try {
    const screenshot = await emulator.captureScreenshot();
    const thumbnail  = screenshot ? await createThumbnail(screenshot) : null;
    const stateBytes = emulator.readStateData(slot);
    const stateData  = stateBytesToBlob(stateBytes);

    // Preserve the user-defined label if one exists
    const existingState = await saveLibrary.getState(gameId, slot);
    const label = existingState?.label || defaultSlotLabel(slot);

    const entry: SaveStateEntry = {
      id: saveStateKey(gameId, slot), gameId, gameName, systemId,
      slot, label, timestamp: Date.now(), thumbnail, stateData,
      isAutoSave: slot === AUTO_SAVE_SLOT,
    };
    await saveLibrary.saveState(entry);
  } catch {
    // best-effort
  }
}

// ── Cloud save bar ────────────────────────────────────────────────────────────

/**
 * Build the cloud-save bar that sits between the gallery header and slot grid.
 * The bar renders the connection status and provides Connect / Disconnect /
 * Sync Now buttons.  It self-updates when cloudManager.onStatusChange fires.
 */
function buildCloudBar(
  cloudManager: CloudSaveManager,
  gameId:       string,
  saveLibrary:  SaveStateLibrary,
): { bar: HTMLElement; teardown: () => void } {
  const bar = make("div", { class: "cloud-bar", role: "region", "aria-label": "Cloud sync" });

  const statusWrap = make("span", { class: "cloud-bar__status" });
  const dot        = make("span", { class: "cloud-status-dot" });
  const statusBody = make("span", { class: "cloud-bar__status-body" });
  const statusText = make("span", { class: "cloud-bar__status-text" });
  const lastSyncEl = make("span", { class: "cloud-bar__last-sync" });
  statusBody.append(statusText, lastSyncEl);
  statusWrap.append(dot, statusBody);

  const actions = make("div", { class: "cloud-bar__actions" });

  // ── Sync history panel ──────────────────────────────────────────────────────
  const historyPanel = make("div", { class: "sync-history-panel", "aria-label": "Sync history" });
  const historyToggle = make("button", {
    class: "btn sync-history-toggle",
    title: "Toggle sync history",
    "aria-expanded": "false",
  }, "📋 History");
  const historyList = make("ul", { class: "sync-history-list" });
  historyPanel.append(historyToggle, historyList);
  historyToggle.addEventListener("click", () => {
    const expanded = historyPanel.classList.toggle("sync-history-panel--open");
    historyToggle.setAttribute("aria-expanded", String(expanded));
  });

  bar.append(statusWrap, actions, historyPanel);

  // Wire the interactive conflict-resolution modal into the manager.
  cloudManager.onConflict = (conflict: SyncConflict) => showConflictResolutionDialog(conflict);

  // Tracks whether a sync is currently in progress so render() can reflect it.
  let isSyncing = false;

  const render = () => {
    if (isSyncing) {
      dot.className  = "cloud-status-dot cloud-status-dot--syncing";
      statusText.className = "cloud-bar__status-text cloud-bar__status-text--syncing";
      statusText.textContent = "Syncing…";
      statusText.title = "";
      lastSyncEl.textContent = "";
      return;
    }

    const connected = cloudManager.isConnected();
    dot.className = `cloud-status-dot ${connected ? "cloud-status-dot--on" : "cloud-status-dot--off"}`;

    if (connected) {
      statusText.className = "cloud-bar__status-text cloud-bar__status-text--ok";
      statusText.textContent = `Connected to ${cloudManager.activeProvider.displayName}`;
      statusText.title = "";
      lastSyncEl.className = "cloud-bar__last-sync";
      if (cloudManager.lastSyncAt) {
        const rel = formatRelativeTime(cloudManager.lastSyncAt);
        lastSyncEl.textContent = `Last sync: ${rel}`;
        lastSyncEl.title = new Date(cloudManager.lastSyncAt).toLocaleString();
      } else {
        lastSyncEl.textContent = "Not yet synced";
        lastSyncEl.title = "";
      }
    } else if (cloudManager.lastError) {
      statusText.className = "cloud-bar__status-text cloud-bar__status-text--error";
      statusText.textContent = "Connection error";
      statusText.title = cloudManager.lastError;
      lastSyncEl.className = "cloud-bar__last-sync";
      lastSyncEl.textContent = "";
    } else {
      statusText.className = "cloud-bar__status-text";
      statusText.textContent = "Not connected";
      statusText.title = "";
      lastSyncEl.className = "cloud-bar__last-sync cloud-bar__last-sync--hint";
      lastSyncEl.textContent = "Connect to sync saves across devices";
    }

    actions.innerHTML = "";

    // Render sync history entries
    historyList.innerHTML = "";
    for (const entry of cloudManager.syncHistory) {
      const li = make("li", { class: `sync-history-entry${entry.ok ? "" : " sync-history-entry--error"}` });
      const time = make("span", { class: "sync-history-time" }, new Date(entry.timestamp).toLocaleTimeString());
      const msg  = make("span", { class: "sync-history-msg" }, entry.action);
      li.append(time, msg);
      historyList.appendChild(li);
    }
    if (cloudManager.syncHistory.length === 0) {
      historyList.appendChild(make("li", { class: "sync-history-entry sync-history-entry--empty" }, "No sync activity yet"));
    }

    if (connected) {
      // Auto-sync toggle
      const autoLabel = make("label", {
        class: "cloud-bar__auto-label",
        title: "Automatically sync saves to cloud after saving",
        "data-tooltip": "Auto-sync after every save",
      });
      const autoCheck = make("input", { type: "checkbox", class: "cloud-bar__auto-check" }) as HTMLInputElement;
      autoCheck.checked = cloudManager.autoSyncEnabled;
      autoCheck.addEventListener("change", () => {
        cloudManager.setAutoSync(autoCheck.checked);
      });
      autoLabel.append(autoCheck, document.createTextNode(" Auto"));
      actions.appendChild(autoLabel);

      // Sync Now button
      const btnSync = make("button", {
        class: "btn",
        title: "Sync all save slots for this game with the cloud",
        "data-tooltip": "Upload & download saves now",
      }, "☁ Sync Now");
      btnSync.addEventListener("click", async () => {
        btnSync.disabled = true;
        isSyncing = true;
        render();
        try {
          const result = await cloudManager.syncGame(gameId, saveLibrary);
          const parts: string[] = [];
          if (result.pushed > 0) parts.push(`↑ ${result.pushed} pushed`);
          if (result.pulled > 0) parts.push(`↓ ${result.pulled} pulled`);
          if (result.errors > 0) parts.push(`${result.errors} error(s)`);
          showInfoToast(parts.length > 0 ? `☁ ${parts.join(" · ")}` : "☁ Cloud sync complete — no changes.");
        } catch (err) {
          showError(`Cloud sync failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          isSyncing = false;
          btnSync.disabled = false;
          render();
        }
      });
      actions.appendChild(btnSync);

      // Configure button
      const btnCfg = make("button", {
        class: "btn",
        title: "Edit cloud connection settings",
        "aria-label": "Cloud settings",
        "data-tooltip": "Change provider or settings",
      });
      btnCfg.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
      btnCfg.addEventListener("click", () => openCloudConnectDialog(cloudManager, render));
      actions.appendChild(btnCfg);

      // Disconnect button
      const btnDisc = make("button", {
        class: "btn btn--danger",
        title: "Disconnect from cloud",
        "data-tooltip": "Remove cloud connection",
      }, "Disconnect");
      btnDisc.addEventListener("click", () => {
        cloudManager.disconnect();
        showInfoToast("Disconnected from cloud.");
      });
      actions.appendChild(btnDisc);
    } else {
      // Connect button — tooltip guides new users to Google Drive
      const btnConn = make("button", {
        class: "btn btn--primary",
        title: "Connect to a cloud save provider",
        "data-tooltip": "Free with Google Drive — keeps saves safe across devices",
      }, "☁ Connect");
      btnConn.addEventListener("click", () => openCloudConnectDialog(cloudManager, render));
      actions.appendChild(btnConn);
    }
  };

  // Register this bar's render function with the manager and return a teardown
  // callback so callers can unsubscribe when the gallery closes.
  const removeStatusListener = cloudManager.addStatusListener(render);
  cloudManager.onStatusChange = render;

  render();
  return { bar, teardown: removeStatusListener };
}

/**
 * Show a modal dialog that lets the user configure and connect to a cloud
 * save provider (WebDAV, Google Drive, or Dropbox).
 * On successful connect, calls `onConnected()` so the cloud bar refreshes.
 */
function openCloudConnectDialog(cloudManager: CloudSaveManager, onConnected: () => void): void {
  const overlay = make("div", { class: "confirm-overlay" });
  const box = make("div", {
    class: "confirm-box cloud-connect-box",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": "Cloud Connection",
  });

  box.appendChild(make("h3", { class: "confirm-title" }, "☁ Cloud Connection"));

  // ── Provider selector ───────────────────────────────────────────────────────
  const providerWrap = make("div", { class: "cloud-dialog-field" });
  const providerLbl  = make("label", { class: "cloud-dialog-label" }, "Provider");
  const providerSel  = make("select", { class: "confirm-input" }) as HTMLSelectElement;
  [
    ["gdrive",  "Google Drive"],
    ["webdav",  "WebDAV (self-hosted)"],
    ["dropbox", "Dropbox"],
    ["pcloud",  "pCloud"],
  ].forEach(([v, t]) => {
    const opt = make("option", { value: v! }, t!);
    if (cloudManager.providerId !== "null" && cloudManager.providerId === v) {
      opt.setAttribute("selected", "");
    }
    providerSel.appendChild(opt);
  });
  providerWrap.append(providerLbl, providerSel);
  box.appendChild(providerWrap);

  // Description paragraph (updated when provider changes)
  const descEl = make("p", { class: "confirm-body" }, "");
  box.appendChild(descEl);

  // ── WebDAV fields ────────────────────────────────────────────────────────────
  const webdavSection = make("div", { class: "cloud-dialog-section" });
  const savedDav      = cloudManager.loadWebDAVConfig();

  const makeDavField = (labelText: string, type: string, placeholder: string, autocomplete: string, value = ""): HTMLInputElement => {
    const wrap = make("div", { class: "cloud-dialog-field" });
    const lbl  = make("label", { class: "cloud-dialog-label" }, labelText);
    const inp  = make("input", { class: "confirm-input", type, placeholder, value, autocomplete }) as HTMLInputElement;
    wrap.append(lbl, inp);
    webdavSection.appendChild(wrap);
    return inp;
  };

  const urlInp  = makeDavField("WebDAV URL", "url",      "https://dav.example.com/retrovault", "url",              savedDav?.url ?? "");
  const userInp = makeDavField("Username",   "text",     "user",                                "username",         savedDav?.username ?? "");
  const passInp = makeDavField("Password / Token", "password", "••••••••",                      "current-password", savedDav?.password ?? "");
  box.appendChild(webdavSection);

  // ── Google Drive fields ──────────────────────────────────────────────────────
  const gdriveSection = make("div", { class: "cloud-dialog-section" });
  const savedGDrive   = cloudManager.loadGDriveConfig();

  const gdriveTokenWrap = make("div", { class: "cloud-dialog-field" });
  const gdriveTokenLbl  = make("label", { class: "cloud-dialog-label" }, "OAuth Access Token");
  const gdriveTokenInp  = make("input", {
    class:        "confirm-input",
    type:         "password",
    placeholder:  "ya29.…",
    autocomplete: "off",
    value:        savedGDrive?.accessToken ?? "",
  }) as HTMLInputElement;
  gdriveTokenWrap.append(gdriveTokenLbl, gdriveTokenInp);
  gdriveSection.appendChild(gdriveTokenWrap);
  {
    const step1 = make("p", { class: "cloud-dialog-hint" },
      "Step 1: Visit developers.google.com/oauthplayground, authorize the drive.appdata scope, and copy the access token.");
    const step2 = make("p", { class: "cloud-dialog-hint" },
      "Step 2: Paste the token above. Saves are stored in a private app folder — invisible in regular Google Drive.");
    gdriveSection.append(step1, step2);
  }
  box.appendChild(gdriveSection);

  // ── Dropbox fields ───────────────────────────────────────────────────────────
  const dropboxSection = make("div", { class: "cloud-dialog-section" });
  const savedDropbox   = cloudManager.loadDropboxConfig();

  const dropboxTokenWrap = make("div", { class: "cloud-dialog-field" });
  const dropboxTokenLbl  = make("label", { class: "cloud-dialog-label" }, "OAuth Access Token");
  const dropboxTokenInp  = make("input", {
    class:        "confirm-input",
    type:         "password",
    placeholder:  "sl.…",
    autocomplete: "off",
    value:        savedDropbox?.accessToken ?? "",
  }) as HTMLInputElement;
  dropboxTokenWrap.append(dropboxTokenLbl, dropboxTokenInp);
  dropboxSection.appendChild(dropboxTokenWrap);
  dropboxSection.appendChild(make("p", { class: "cloud-dialog-hint" },
    "Generate a long-lived token in the Dropbox App Console (scopes: files.content.read, files.content.write) and paste it here."));
  box.appendChild(dropboxSection);

  // ── pCloud fields ────────────────────────────────────────────────────────────
  const pcloudSection = make("div", { class: "cloud-dialog-section" });
  const savedPCloud   = cloudManager.loadPCloudConfig();

  const pcloudTokenWrap = make("div", { class: "cloud-dialog-field" });
  const pcloudTokenLbl  = make("label", { class: "cloud-dialog-label" }, "OAuth Access Token");
  const pcloudTokenInp  = make("input", {
    class:        "confirm-input",
    type:         "password",
    placeholder:  "pCloud access token…",
    autocomplete: "off",
    value:        savedPCloud?.accessToken ?? "",
  }) as HTMLInputElement;
  pcloudTokenWrap.append(pcloudTokenLbl, pcloudTokenInp);
  pcloudSection.appendChild(pcloudTokenWrap);

  const pcloudRegionWrap = make("div", { class: "cloud-dialog-field" });
  const pcloudRegionLbl  = make("label", { class: "cloud-dialog-label" }, "Region");
  const pcloudRegionSel  = make("select", { class: "confirm-input" }) as HTMLSelectElement;
  [["us", "US (api.pcloud.com)"], ["eu", "EU (eapi.pcloud.com)"]].forEach(([v, t]) => {
    const opt = make("option", { value: v! }, t!);
    if ((savedPCloud?.region ?? "us") === v) opt.setAttribute("selected", "");
    pcloudRegionSel.appendChild(opt);
  });
  pcloudRegionWrap.append(pcloudRegionLbl, pcloudRegionSel);
  pcloudSection.appendChild(pcloudRegionWrap);
  pcloudSection.appendChild(make("p", { class: "cloud-dialog-hint" },
    "Generate an access token via the pCloud OAuth 2.0 flow and paste it here. Choose EU region if your pCloud account is registered in Europe."));
  box.appendChild(pcloudSection);

  // ── Conflict resolution (shared across all providers) ────────────────────────
  const cfgWrap = make("div", { class: "cloud-dialog-field" });
  const cfgLbl  = make("label", { class: "cloud-dialog-label" }, "Conflict resolution");
  const cfgSel  = make("select", { class: "confirm-input" }) as HTMLSelectElement;
  [["newest", "Keep newest (default)"], ["local", "Always keep local"], ["remote", "Always keep remote"]].forEach(([v, t]) => {
    const opt = make("option", { value: v! }, t!);
    if (cloudManager.conflictResolution === v) opt.setAttribute("selected", "");
    cfgSel.appendChild(opt);
  });
  cfgWrap.append(cfgLbl, cfgSel);
  box.appendChild(cfgWrap);

  // ── Status line ──────────────────────────────────────────────────────────────
  const statusEl = make("p", { class: "cloud-dialog-status" }, "");
  box.appendChild(statusEl);

  const footer   = make("div", { class: "confirm-footer" });
  const btnCancel  = make("button", { class: "btn" }, "Cancel");
  const btnTest    = make("button", { class: "btn" }, "Test Connection");
  const btnConnect = make("button", { class: "btn btn--primary" }, "Connect");
  footer.append(btnCancel, btnTest, btnConnect);
  box.appendChild(footer);

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // ── Show/hide sections based on provider selection ───────────────────────────
  const updateVisibility = () => {
    const v = providerSel.value;
    webdavSection.style.display  = v === "webdav"  ? "" : "none";
    gdriveSection.style.display  = v === "gdrive"  ? "" : "none";
    dropboxSection.style.display = v === "dropbox" ? "" : "none";
    pcloudSection.style.display  = v === "pcloud"  ? "" : "none";
    statusEl.textContent = "";

    if (v === "webdav") {
      descEl.textContent = "Connect to a WebDAV server. The server must allow CORS requests from this origin.";
    } else if (v === "gdrive") {
      descEl.textContent = "Saves are stored in the hidden appDataFolder on your Google Drive (not visible in regular Drive).";
    } else if (v === "pcloud") {
      descEl.textContent = "Saves are stored in /RetroVault inside your pCloud account. Choose the region that matches your account.";
    } else {
      descEl.textContent = "Saves are stored in /retrovault inside your Dropbox app folder.";
    }
  };

  providerSel.addEventListener("change", updateVisibility);
  updateVisibility();

  // ── Close handler ────────────────────────────────────────────────────────────
  const close = () => {
    document.removeEventListener("keydown", onEsc, { capture: true });
    overlay.classList.remove("confirm-overlay--visible");
    setTimeout(() => overlay.remove(), 200);
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape" && _isTopmostOverlay(overlay)) { e.preventDefault(); e.stopPropagation(); close(); }
  };

  btnCancel.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  // Register in capture phase so this fires even when the global in-game Escape handler runs.
  document.addEventListener("keydown", onEsc, { capture: true });


  btnTest.addEventListener("click", async () => {
    statusEl.textContent = "Testing connection…";
    btnTest.setAttribute("disabled", "true");
    try {
      const selectedProvider = providerSel.value;
      let candidate;
      if (selectedProvider === "webdav") {
        candidate = new WebDAVProvider(urlInp.value.trim(), userInp.value.trim(), passInp.value);
      } else if (selectedProvider === "gdrive") {
        candidate = new GoogleDriveProvider(gdriveTokenInp.value.trim());
      } else if (selectedProvider === "pcloud") {
        candidate = new pCloudProvider(pcloudTokenInp.value.trim(), pcloudRegionSel.value as "us" | "eu");
      } else {
        candidate = new DropboxProvider(dropboxTokenInp.value.trim());
      }
      const ok = await candidate.isAvailable();
      statusEl.textContent = ok ? "Connection test succeeded. You can connect now." : "Could not reach provider. Check token/network/CORS.";
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      btnTest.removeAttribute("disabled");
    }
  });
  // ── Connect handler ──────────────────────────────────────────────────────────
  btnConnect.addEventListener("click", async () => {
    statusEl.textContent = "";
    btnConnect.disabled  = true;
    btnConnect.textContent = "Connecting…";

    const resetBtn = (msg: string) => {
      statusEl.textContent   = msg;
      btnConnect.disabled    = false;
      btnConnect.textContent = "Connect";
    };

    try {
      cloudManager.setConflictResolution(cfgSel.value as import("./cloudSave.js").ConflictResolution);

      const selectedProvider = providerSel.value;
      let provider;

      if (selectedProvider === "webdav") {
        const url  = urlInp.value.trim();
        const user = userInp.value.trim();
        const pass = passInp.value;
        if (!url) { resetBtn("Please enter a WebDAV URL."); return; }
        provider = new WebDAVProvider(url, user, pass);
        await cloudManager.connect(provider);
        cloudManager.saveWebDAVConfig(url, user, pass);
        close();
        onConnected();
        showInfoToast(`Connected to WebDAV: ${url}`);
      } else if (selectedProvider === "gdrive") {
        const token = gdriveTokenInp.value.trim();
        if (!token) { resetBtn("Please enter a Google Drive access token."); return; }
        provider = new GoogleDriveProvider(token);
        await cloudManager.connect(provider);
        cloudManager.saveGDriveConfig(token);
        close();
        onConnected();
        showInfoToast("Connected to Google Drive.");
      } else if (selectedProvider === "pcloud") {
        const token  = pcloudTokenInp.value.trim();
        const region = pcloudRegionSel.value as "us" | "eu";
        if (!token) { resetBtn("Please enter a pCloud access token."); return; }
        provider = new pCloudProvider(token, region);
        await cloudManager.connect(provider);
        cloudManager.savePCloudConfig(token, region);
        close();
        onConnected();
        showInfoToast("Connected to pCloud.");
      } else {
        const token = dropboxTokenInp.value.trim();
        if (!token) { resetBtn("Please enter a Dropbox access token."); return; }
        provider = new DropboxProvider(token);
        await cloudManager.connect(provider);
        cloudManager.saveDropboxConfig(token);
        close();
        onConnected();
        showInfoToast("Connected to Dropbox.");
      }
    } catch (err) {
      resetBtn(err instanceof Error ? err.message : String(err));
    }
  });

  requestAnimationFrame(() => overlay.classList.add("confirm-overlay--visible"));
  // Focus the first visible input (Google Drive is first when no previous provider)
  setTimeout(() => {
    if (providerSel.value === "gdrive") gdriveTokenInp.focus();
    else if (providerSel.value === "webdav") urlInp.focus();
    else if (providerSel.value === "pcloud") pcloudTokenInp.focus();
    else dropboxTokenInp.focus();
  }, 50);
}

// ── Save gallery dialog ───────────────────────────────────────────────────────

type SaveGalleryMode = "save" | "load";

async function openSaveGallery(
  emulator:    PSPEmulator,
  saveLibrary: SaveStateLibrary,
  gameId:      string,
  gameName:    string,
  systemId:    string
): Promise<void> {
  const overlay = make("div", { class: "confirm-overlay" });
  const box = make("div", {
    class: "confirm-box save-gallery-box",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": "Save States",
  });

  // Header
  const galleryHeader = make("div", { class: "save-gallery-header" });
  const galleryTitle  = make("div", { class: "save-gallery-title-wrap" });
  const titleRow = make("div", { class: "save-gallery-title-row" });
  titleRow.appendChild(make("h3", { class: "confirm-title" }, "Save States"));
  const slotCountBadge = make("span", { class: "save-gallery-slot-count" }, "");
  titleRow.appendChild(slotCountBadge);
  galleryTitle.appendChild(titleRow);
  galleryTitle.appendChild(make("p",  { class: "save-gallery-game" }, gameName));
  galleryHeader.appendChild(galleryTitle);

  // Export all button
  const btnExportAll = make("button", { class: "btn", title: "Export all save states as .state files" });
  btnExportAll.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Export All`;
  btnExportAll.addEventListener("click", async () => {
    const exports = await saveLibrary.exportAllForGame(gameId);
    if (exports.length === 0) { showInfoToast("No save data to export."); return; }
    for (const exp of exports) { downloadBlob(exp.blob, exp.fileName); }
    showInfoToast(`Exported ${exports.length} save state${exports.length !== 1 ? "s" : ""}.`);
  });
  galleryHeader.appendChild(btnExportAll);
  box.appendChild(galleryHeader);

  // ── Mode tabs (Save / Load) ────────────────────────────────────────────────
  let currentMode: SaveGalleryMode = "save";

  const tabsRow = make("div", { class: "save-gallery-tabs", role: "tablist", "aria-label": "Gallery mode" });

  const tabSave = make("button", {
    class: "save-gallery-tab save-gallery-tab--save save-gallery-tab--active",
    role: "tab",
    "aria-selected": "true",
  });
  tabSave.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save`;

  const tabLoad = make("button", {
    class: "save-gallery-tab save-gallery-tab--load",
    role: "tab",
    "aria-selected": "false",
  });
  tabLoad.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Load`;

  tabsRow.append(tabSave, tabLoad);
  box.appendChild(tabsRow);

  let teardownCloudStatus: (() => void) | null = null;

  // Cloud bar (below the tabs, above the grid)
  const cloudBar = buildCloudBar(getCloudManager(), gameId, saveLibrary);
  box.appendChild(cloudBar.bar);
  teardownCloudStatus = cloudBar.teardown;

  const saveService = new SaveGameService({
    saveLibrary,
    cloudManager: getCloudManager(),
    emulator,
    getCurrentGameContext: () => ({ gameId, gameName, systemId }),
  });

  const statusBanner = make("div", { class: "save-gallery-status", role: "status", "aria-live": "polite" }, "");
  box.appendChild(statusBanner);

  const statusToClass = (status: SaveOperationStatus): string => `save-gallery-status--${status}`;
  saveService.onStatus((event) => {
    statusBanner.className = `save-gallery-status ${statusToClass(event.status)}`;
    statusBanner.textContent = event.message ?? event.status.replaceAll("-", " ");
  });

  // Slots container
  const slotsContainer = make("div", { class: "save-gallery-grid", "data-mode": "save" });
  box.appendChild(slotsContainer);

  // ── Tab switching ──────────────────────────────────────────────────────────
  const switchMode = async (mode: SaveGalleryMode) => {
    currentMode = mode;
    slotsContainer.dataset.mode = mode;
    tabSave.classList.toggle("save-gallery-tab--active", mode === "save");
    tabLoad.classList.toggle("save-gallery-tab--active", mode === "load");
    tabSave.setAttribute("aria-selected", String(mode === "save"));
    tabLoad.setAttribute("aria-selected", String(mode === "load"));
    await renderSaveSlots(slotsContainer, emulator, saveLibrary, saveService, gameId, gameName, systemId, currentMode, slotCountBadge, close);
  };

  tabSave.addEventListener("click", () => switchMode("save"));
  tabLoad.addEventListener("click", () => switchMode("load"));

  // Footer
  const footer    = make("div", { class: "confirm-footer" });
  const btnClose  = make("button", { class: "btn", title: "Close (Esc)" }, "Close");
  const shortcutHint = make("span", { class: "save-gallery-hint" },
    isTouchDevice() ? "Tap a slot to save or load" : "F5 Quick Save · F7 Quick Load · ←→↑↓ Navigate"
  );
  footer.append(shortcutHint, btnClose);
  box.appendChild(footer);

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const close = () => {
    document.removeEventListener("keydown", onKey, { capture: true });
    teardownCloudStatus?.();
    teardownCloudStatus = null;
    overlay.classList.remove("confirm-overlay--visible");
    setTimeout(() => overlay.remove(), 200);
  };

  // ── Keyboard navigation ────────────────────────────────────────────────────
  const onKey = (e: KeyboardEvent) => {
    if (!_isTopmostOverlay(overlay)) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }

    const cards = Array.from(slotsContainer.querySelectorAll<HTMLElement>(".save-slot-card:not([aria-disabled='true'])"));
    const focused = document.activeElement;
    const focusedCard = (focused as HTMLElement)?.closest?.(".save-slot-card") as HTMLElement | null;

    const colCount = Math.round(slotsContainer.getBoundingClientRect().width /
      (cards[0]?.getBoundingClientRect().width || 1));

    if (["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key) && focusedCard) {
      e.preventDefault(); e.stopPropagation();
      const idx = cards.indexOf(focusedCard);
      let next = -1;
      if (e.key === "ArrowRight") next = idx + 1;
      else if (e.key === "ArrowLeft") next = idx - 1;
      else if (e.key === "ArrowDown") next = idx + colCount;
      else if (e.key === "ArrowUp") next = idx - colCount;
      if (next >= 0 && next < cards.length) {
        const primaryBtn = cards[next]!.querySelector<HTMLElement>(".save-slot-card__btn-primary");
        (primaryBtn ?? cards[next]!).focus();
      }
    }
  };

  btnClose.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  // Register in capture phase so Esc works even when the emulator is running
  document.addEventListener("keydown", onKey, { capture: true });
  requestAnimationFrame(() => overlay.classList.add("confirm-overlay--visible"));

  await renderSaveSlots(slotsContainer, emulator, saveLibrary, saveService, gameId, gameName, systemId, currentMode, slotCountBadge, close);
}

async function renderSaveSlots(
  container:        HTMLElement,
  emulator:         PSPEmulator,
  saveLibrary:      SaveStateLibrary,
  saveService:      SaveGameService,
  gameId:           string,
  gameName:         string,
  systemId:         string,
  mode:             SaveGalleryMode,
  slotCountBadge?:  HTMLElement,
  onCloseGallery?:  () => void
): Promise<void> {
  container.innerHTML = "";

  const states = await saveLibrary.getStatesForGame(gameId);
  const stateMap = new Map(states.map(s => [s.slot, s]));

  // Update the used-slots counter in the gallery header if provided
  if (slotCountBadge) {
    const usedManual = states.filter(s => s.slot !== AUTO_SAVE_SLOT).length;
    slotCountBadge.textContent = `${usedManual} / ${MAX_SAVE_SLOTS} slots used`;
  }

  // Auto-save section label (spans full grid width)
  const autoLabel = make("div", { class: "save-gallery-section-label" }, "Auto-Save");
  container.appendChild(autoLabel);

  // Auto-save slot
  const autoState = stateMap.get(AUTO_SAVE_SLOT);
  const autoCard  = await buildSaveSlotCard(
    AUTO_SAVE_SLOT, autoState, true, container, emulator, saveLibrary, saveService, gameId, gameName, systemId, mode, onCloseGallery
  );
  container.appendChild(autoCard);

  // Manual saves section label
  const manualLabel = make("div", { class: "save-gallery-section-label" }, "Manual Saves");
  container.appendChild(manualLabel);

  // Slots 1–MAX_SAVE_SLOTS
  const manualSlots = Array.from({ length: MAX_SAVE_SLOTS }, (_, i) => i + 1);
  const cards = await Promise.all(
    manualSlots.map((slot) => {
      const state = stateMap.get(slot);
      return buildSaveSlotCard(
        slot, state, false, container, emulator, saveLibrary, saveService, gameId, gameName, systemId, mode, onCloseGallery
      );
    })
  );
  for (const card of cards) {
    container.appendChild(card);
  }
}

async function buildSaveSlotCard(
  slot:             number,
  state:            SaveStateEntry | undefined,
  isAuto:           boolean,
  container:        HTMLElement,
  emulator:         PSPEmulator,
  saveLibrary:      SaveStateLibrary,
  saveService:      SaveGameService,
  gameId:           string,
  gameName:         string,
  systemId:         string,
  mode:             SaveGalleryMode,
  onCloseGallery?:  () => void
): Promise<HTMLElement> {
  const isQuickSave = !isAuto && slot === 1;
  let cardClass = "save-slot-card";
  if (state)        cardClass += " save-slot-card--occupied";
  if (isQuickSave)  cardClass += " save-slot-card--quick-save";
  // In load mode, mark empty non-auto slots so CSS can re-enable import
  if (!state && !isAuto) cardClass += " save-slot-card--has-import";

  const card = make("div", { class: cardClass });

  // Thumbnail area
  const thumb = make("div", { class: "save-slot-card__thumb" });

  // Slot number badge overlaid on the thumbnail
  const slotBadgeText = isAuto ? "Auto" : isQuickSave ? "Slot 1 · Quick" : `Slot ${slot}`;
  const slotBadge = make("span", { class: "save-slot-card__slot-badge" }, slotBadgeText);
  thumb.appendChild(slotBadge);

  if (state?.thumbnail) {
    const img = make("img", { class: "save-slot-card__img", alt: `Slot ${slot} screenshot` }) as HTMLImageElement;
    const url = URL.createObjectURL(state.thumbnail);
    img.src = url;
    img.onload  = () => URL.revokeObjectURL(url);
    img.onerror = () => URL.revokeObjectURL(url);
    thumb.appendChild(img);
  } else {
    const empty = make("div", { class: "save-slot-card__empty" });
    if (mode === "save" && !isAuto) {
      // Save mode: show a "+" invite
      empty.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg><span>Save Here</span>`;
    } else if (isAuto) {
      empty.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg><span>Empty</span>`;
    } else {
      empty.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg><span>Empty</span>`;
    }
    thumb.appendChild(empty);
  }

  // Thumbnail hover overlay — shown on occupied slots; label depends on mode
  let thumbPlayBtn: HTMLButtonElement | null = null;
  if (state) {
    const thumbOverlay = make("div", { class: "save-slot-card__thumb-overlay", "aria-hidden": "true" });
    const thumbPlay = make("button", {
      class: "save-slot-card__thumb-play",
      title: mode === "save" ? "Overwrite this save state" : "Load this save state",
      tabindex: "-1",
    }) as HTMLButtonElement;
    if (mode === "save") {
      thumbPlay.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save`;
    } else {
      thumbPlay.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Load`;
    }
    thumbOverlay.appendChild(thumbPlay);
    thumb.appendChild(thumbOverlay);
    thumbPlayBtn = thumbPlay;
  }

  card.appendChild(thumb);

  // Info area
  const info = make("div", { class: "save-slot-card__info" });

  // Slot header (label + rename for manual slots)
  const slotHeader = make("div", { class: "save-slot-card__header" });
  const currentLabel = state?.label || defaultSlotLabel(slot);

  const labelEl = make("span", { class: "save-slot-card__label" }, currentLabel);
  slotHeader.appendChild(labelEl);

  if (!isAuto) {
    if (isQuickSave) {
      const qBadge = make("span", { class: "save-slot-card__quick-badge" }, "F5·F7");
      slotHeader.appendChild(qBadge);
    }
    const btnEdit = make("button", {
      class: "save-slot-card__edit-btn",
      title: "Rename this slot",
      "aria-label": "Rename slot",
    });
    btnEdit.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    btnEdit.addEventListener("click", async () => {
      const newLabel = await showInputDialog("Rename Slot", "Enter a name for this save slot:", currentLabel);
      if (newLabel === null) return;
      await saveLibrary.updateStateLabel(gameId, slot, newLabel);
      const newCard = await buildSaveSlotCard(slot, state ? { ...state, label: newLabel || defaultSlotLabel(slot) } : undefined, isAuto, container, emulator, saveLibrary, saveService, gameId, gameName, systemId, mode, onCloseGallery);
      card.replaceWith(newCard);
    });
    slotHeader.appendChild(btnEdit);
  } else {
    const autoBadge = make("span", { class: "save-slot-card__auto-badge" }, "Auto");
    slotHeader.appendChild(autoBadge);
  }

  info.appendChild(slotHeader);

  if (state) {
    const exactDate = new Date(state.timestamp).toLocaleString();
    info.appendChild(make("span", { class: "save-slot-card__time", title: exactDate }, formatRelativeTime(state.timestamp)));
  } else {
    info.appendChild(make("span", { class: "save-slot-card__time save-slot-card__time--empty" }, "Empty"));
  }

  // Sync badge — shows cloud sync status for this slot
  const cloudMgr = getCloudManager();
  if (cloudMgr.isConnected()) {
    const badge: SyncBadge = cloudMgr.getSlotBadge(gameId, slot);
    const badgeLabels: Record<SyncBadge, string> = {
      "local-only": "Local only",
      "syncing":    "Syncing…",
      "synced":     "Synced",
      "error":      "Sync error",
    };
    const badgeEl = make("span", {
      class: `sync-badge sync-badge--${badge}`,
      title: badgeLabels[badge],
    }, badgeLabels[badge]);
    info.appendChild(badgeEl);
  }

  // Helper: re-render all slots
  const rerender = () => {
    const badge = container.closest<HTMLElement>(".save-gallery-box")
      ?.querySelector<HTMLElement>(".save-gallery-slot-count") ?? undefined;
    return renderSaveSlots(container, emulator, saveLibrary, saveService, gameId, gameName, systemId, mode, badge, onCloseGallery);
  };

  // Helper: show per-card busy spinner
  const setBusy = (on: boolean) => {
    if (on) {
      if (!card.querySelector(".save-slot-card__busy")) {
        const busy = make("div", { class: "save-slot-card__busy", "aria-hidden": "true" });
        busy.appendChild(make("div", { class: "save-slot-card__busy-spinner" }));
        card.appendChild(busy);
      }
    } else {
      card.querySelector(".save-slot-card__busy")?.remove();
    }
  };

  // Shared load action
  const doLoad = async () => {
    setBusy(true);
    const loaded = await saveService.loadSlot(slot);
    setBusy(false);
    if (loaded) {
      onCloseGallery?.();
      showInfoToast(`Loaded ${currentLabel}`);
    } else {
      showError("Could not restore this save state.");
    }
  };

  // Shared save action
  const doSave = async () => {
    setBusy(true);
    const saved = await saveService.saveSlot(slot);
    setBusy(false);
    await rerender();
    if (saved) showInfoToast(`Saved to ${currentLabel}`);
    else showError("Save failed — emulator is still warming up.");
  };

  // Wire thumbnail overlay button
  if (thumbPlayBtn) {
    thumbPlayBtn.addEventListener("click", mode === "save" ? doSave : doLoad);
  }

  // ── Actions row ────────────────────────────────────────────────────────────
  const actions = make("div", { class: "save-slot-card__actions" });

  if (mode === "save") {
    // ── Save mode ────────────────────────────────────────────────
    if (!isAuto) {
      const btnSave = make("button", {
        class: "btn btn--primary save-slot-card__btn save-slot-card__btn-primary",
        title: `Save current game to ${currentLabel}`,
      });
      btnSave.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save Here`;
      btnSave.addEventListener("click", async () => {
        if (btnSave.disabled) return;
        btnSave.disabled = true;
        try { await doSave(); } finally { btnSave.disabled = false; }
      });
      actions.appendChild(btnSave);

      // Secondary: Load (if occupied), Export, Delete
      if (state) {
        const secondary = make("div", { class: "save-slot-card__secondary" });

        const btnLoad = make("button", {
          class: "btn save-slot-card__btn save-slot-card__icon-btn",
          title: "Load this save state",
          "aria-label": "Load",
        });
        btnLoad.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
        btnLoad.addEventListener("click", doLoad);
        secondary.appendChild(btnLoad);

        if (state.stateData) {
          const btnExport = make("button", {
            class: "btn save-slot-card__btn save-slot-card__icon-btn",
            title: "Export save as .state file",
            "aria-label": "Export",
          });
          btnExport.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
          btnExport.addEventListener("click", async () => {
            const exported = await saveLibrary.exportState(gameId, slot);
            if (exported) downloadBlob(exported.blob, exported.fileName);
          });
          secondary.appendChild(btnExport);
        }

        const btnDel = make("button", {
          class: "btn btn--danger save-slot-card__btn save-slot-card__icon-btn",
          title: "Delete this save state",
          "aria-label": "Delete",
        });
        btnDel.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
        btnDel.addEventListener("click", async () => {
          const confirmed = await showConfirmDialog(
            `Delete the save in "${currentLabel}"?`,
            { title: "Delete Save", confirmLabel: "Delete", isDanger: true }
          );
          if (confirmed) {
            await saveLibrary.deleteState(gameId, slot);
            await rerender();
          }
        });
        secondary.appendChild(btnDel);
        actions.appendChild(secondary);
      }
    } else if (state) {
      // Auto slot in save mode: just show Load
      const btnLoad = make("button", { class: "btn save-slot-card__btn save-slot-card__btn-primary", title: "Load auto-save" });
      btnLoad.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Load`;
      btnLoad.addEventListener("click", doLoad);
      actions.appendChild(btnLoad);
    }
  } else {
    // ── Load mode ────────────────────────────────────────────────
    if (state) {
      const btnLoad = make("button", {
        class: "btn btn--primary save-slot-card__btn save-slot-card__btn-primary",
        title: "Load this save state",
      });
      btnLoad.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Load`;
      btnLoad.addEventListener("click", doLoad);
      actions.appendChild(btnLoad);

      // Secondary: Export, Delete (no Save in load mode)
      const secondary = make("div", { class: "save-slot-card__secondary" });

      if (state.stateData) {
        const btnExport = make("button", {
          class: "btn save-slot-card__btn save-slot-card__icon-btn",
          title: "Export save as .state file",
          "aria-label": "Export",
        });
        btnExport.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
        btnExport.addEventListener("click", async () => {
          const exported = await saveLibrary.exportState(gameId, slot);
          if (exported) downloadBlob(exported.blob, exported.fileName);
        });
        secondary.appendChild(btnExport);
      }

      if (!isAuto) {
        const btnDel = make("button", {
          class: "btn btn--danger save-slot-card__btn save-slot-card__icon-btn",
          title: "Delete this save state",
          "aria-label": "Delete",
        });
        btnDel.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
        btnDel.addEventListener("click", async () => {
          const confirmed = await showConfirmDialog(
            `Delete the save in "${currentLabel}"?`,
            { title: "Delete Save", confirmLabel: "Delete", isDanger: true }
          );
          if (confirmed) {
            await saveLibrary.deleteState(gameId, slot);
            await rerender();
          }
        });
        secondary.appendChild(btnDel);
      }

      if (secondary.hasChildNodes()) actions.appendChild(secondary);
    }
  }

  // Import button — available on all non-auto slots in both modes
  if (!isAuto) {
    const importInput = make("input", {
      type: "file", accept: ".state,.sav", style: "display:none",
      "aria-label": `Import state file to slot ${slot}`,
    }) as HTMLInputElement;

    const btnImport = make("button", {
      class: "btn save-slot-card__btn save-slot-card__icon-btn",
      title: "Import a .state file into this slot",
      "aria-label": "Import",
    });
    btnImport.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><polyline points="12 11 12 17"/><polyline points="9 14 12 17 15 14"/></svg>`;
    btnImport.addEventListener("click", () => importInput.click());
    importInput.addEventListener("change", async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      importInput.value = "";
      try {
        await saveLibrary.importState(gameId, gameName, systemId, slot, file);

        const imported = await saveLibrary.getState(gameId, slot);
        if (imported) {
          const checksumOk = await verifySaveChecksum(imported);
          if (!checksumOk) {
            const choice = await showChecksumFailureDialog();
            if (choice === "discard") {
              await saveLibrary.deleteState(gameId, slot);
              await rerender();
              showInfoToast("Discarded corrupt import.");
              return;
            }
            if (choice === "reimport") {
              await saveLibrary.deleteState(gameId, slot);
              await rerender();
              showInfoToast("Import discarded — please try again with a valid file.");
              return;
            }
          }
        }

        const buf = await file.arrayBuffer();
        const written = emulator.writeStateData(slot, new Uint8Array(buf));
        await rerender();
        if (written) {
          showInfoToast(`Imported save to ${currentLabel}`);
        } else {
          showInfoToast(`Imported save to ${currentLabel} — load the game to apply it.`);
        }
      } catch (err) {
        showError(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // Find secondary group or add to main actions
    const secondary = actions.querySelector(".save-slot-card__secondary");
    if (secondary) {
      secondary.appendChild(importInput);
      secondary.appendChild(btnImport);
    } else {
      actions.append(importInput, btnImport);
    }
  }

  card.append(info, actions);
  return card;
}

// ── Input dialog ──────────────────────────────────────────────────────────────

function showInputDialog(title: string, message: string, defaultValue = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = make("div", { class: "confirm-overlay" });
    const box = make("div", { class: "confirm-box", role: "dialog", "aria-modal": "true", "aria-label": title });
    box.appendChild(make("h3", { class: "confirm-title" }, title));
    box.appendChild(make("p",  { class: "confirm-body" }, message));

    const input = make("input", {
      type: "text",
      class: "confirm-input",
      value: defaultValue,
      maxlength: "32",
      "aria-label": message,
    }) as HTMLInputElement;
    box.appendChild(input);

    const footer     = make("div", { class: "confirm-footer" });
    const btnCancel  = make("button", { class: "btn" }, "Cancel");
    const btnConfirm = make("button", { class: "btn btn--primary" }, "Save");
    footer.append(btnCancel, btnConfirm);
    box.appendChild(footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = (result: string | null) => {
      document.removeEventListener("keydown", onKey, { capture: true });
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), 200);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!_isTopmostOverlay(overlay)) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); }
      if (e.key === "Enter")  { e.preventDefault(); e.stopPropagation(); close(input.value); }
    };
    btnCancel.addEventListener("click",  () => close(null));
    btnConfirm.addEventListener("click", () => close(input.value));
    overlay.addEventListener("click",    (e) => { if (e.target === overlay) close(null); });
    document.addEventListener("keydown", onKey, { capture: true });
    requestAnimationFrame(() => {
      overlay.classList.add("confirm-overlay--visible");
      input.focus();
      input.select();
    });
  });
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

type SettingsTab = "performance" | "display" | "library" | "bios" | "multiplayer" | "debug" | "about";

let _settingsPanelEscHandler: ((e: KeyboardEvent) => void) | null = null;
let _settingsPanelFocusTrap: ((e: KeyboardEvent) => void) | null = null;

export function openSettingsPanel(
  settings:         Settings,
  deviceCaps:       DeviceCapabilities,
  library:          GameLibrary,
  biosLibrary:      BiosLibrary,
  onSettingsChange: (patch: Partial<Settings>) => void,
  emulatorRef?:     import("./emulator.js").PSPEmulator,
  onLaunchGame?:    (file: File, systemId: string, gameId?: string) => Promise<void>,
  saveLibrary?:     SaveStateLibrary,
  netplayManager?:  import("./multiplayer.js").NetplayManager,
  initialTab?:      SettingsTab
): void {
  const panel   = document.getElementById("settings-panel")!;
  const content = document.getElementById("settings-content")!;
  const previousFocus = document.activeElement as HTMLElement | null;

  buildSettingsContent(content, settings, deviceCaps, library, biosLibrary, onSettingsChange, emulatorRef, onLaunchGame, saveLibrary, netplayManager, initialTab);
  panel.hidden = false;
  // Move focus into the panel so keyboard users can navigate immediately
  requestAnimationFrame(() => {
    (document.getElementById("settings-close") as HTMLButtonElement | null)?.focus();
  });

  // Focus trap: keep Tab navigation inside the settings panel
  const focusTrapFn = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter(el => !el.closest("[hidden]"));
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last  = focusable[focusable.length - 1]!;
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
    }
  };

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
    previousFocus?.focus();
  };

  // Remove any previously registered handlers before attaching new ones.
  if (_settingsPanelEscHandler) {
    document.removeEventListener("keydown", _settingsPanelEscHandler);
  }
  if (_settingsPanelFocusTrap) {
    document.removeEventListener("keydown", _settingsPanelFocusTrap);
  }
  _settingsPanelEscHandler = (e: KeyboardEvent) => { if (e.key !== "Escape") return; close(); };
  _settingsPanelFocusTrap  = focusTrapFn;

  document.getElementById("settings-close")!.onclick   = close;
  document.getElementById("settings-backdrop")!.onclick = close;
  document.addEventListener("keydown", _settingsPanelEscHandler);
  document.addEventListener("keydown", _settingsPanelFocusTrap);
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
  netplayManager?:  import("./multiplayer.js").NetplayManager,
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

  const tabs: Array<{ id: SettingsTab; label: string; ariaLabel: string }> = [
    { id: "performance",  label: "⚡ Performance",   ariaLabel: "Performance" },
    { id: "display",      label: "🖥 Display",        ariaLabel: "Display" },
    { id: "library",      label: "📚 My Games",       ariaLabel: "My Games" },
    { id: "bios",         label: "💾 System Files",   ariaLabel: "System Files" },
    { id: "multiplayer",  label: "🌐 Play Together",  ariaLabel: "Play Together" },
    { id: "debug",        label: "🔧 Advanced",       ariaLabel: "Advanced" },
    { id: "about",        label: "❓ Help",            ariaLabel: "Help" },
  ];
  const tabIndexById = new Map<SettingsTab, number>(tabs.map((t, i) => [t.id, i]));

  const requestedTab = initialTab ?? "performance";
  let activeTab: SettingsTab = tabIndexById.has(requestedTab) ? requestedTab : "performance";

  // Tab bar
  const tabBar = make("div", { class: "settings-tabs", role: "tablist" });
  // Tab panels container
  const panelsEl = make("div", { class: "settings-panels" });

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
    if (activeBtn) {
      const scrollIntoViewFn = (activeBtn as HTMLElement & { scrollIntoView?: unknown }).scrollIntoView;
      if (typeof scrollIntoViewFn === "function") {
        scrollIntoViewFn.call(activeBtn, { block: "nearest", inline: "nearest" });
      }
    }
  };

  tabs.forEach((tab, i) => {
    const btn = make("button", {
      id: `tab-${tab.id}`,
      class: "settings-tab",
      type: "button",
      role: "tab",
      "aria-selected": tab.id === activeTab ? "true" : "false",
      tabindex: tab.id === activeTab ? "0" : "-1",
      "aria-controls": `tab-panel-${tab.id}`,
      "aria-label": tab.ariaLabel,
    }, tab.label) as HTMLButtonElement;
    btn.addEventListener("click", () => switchTab(tab.id));
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "Home" || e.key === "End") {
        e.preventDefault();
        const nextIndex =
          e.key === "Home" ? 0 :
          e.key === "End" ? tabs.length - 1 :
          e.key === "ArrowRight" ? (i + 1) % tabs.length :
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

  settingsShell.append(tabBar, panelsEl);
  container.append(quickBar, settingsShell);

  // Detect tab bar overflow and apply fade mask via .overflows class
  const updateTabBarOverflow = () => {
    requestAnimationFrame(() => {
      tabBar.classList.toggle("overflows", tabBar.scrollWidth > tabBar.clientWidth);
    });
  };
  updateTabBarOverflow();
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(updateTabBarOverflow).observe(tabBar);
  }

  // Ensure tab button classes and panel visibility match the active tab
  switchTab(activeTab);

  // Fill tabs
  buildPerfTab(panels[0]!, settings, deviceCaps, onSettingsChange, emulatorRef);
  buildDisplayTab(panels[1]!, settings, deviceCaps, onSettingsChange, emulatorRef);
  buildLibraryTab(panels[2]!, settings, library, saveLibrary, onSettingsChange, onLaunchGame, emulatorRef);
  buildBiosTab(panels[3]!, biosLibrary);
  buildMultiplayerTab(panels[4]!, settings, onSettingsChange, netplayManager, settings.lastGameName, emulatorRef?.currentSystem?.id);
  buildDebugTab(panels[5]!, settings, onSettingsChange, deviceCaps, emulatorRef, netplayManager, biosLibrary);
  buildAboutTab(panels[6]!);

  const applySearchFilter = () => {
    const query = searchInput.value.trim().toLowerCase();
    let matchedSections = 0;

    for (let i = 0; i < panels.length; i++) {
      const panel = panels[i]!;
      const sections = Array.from(panel.querySelectorAll<HTMLElement>(".settings-section"));
      let panelMatched = false;

      for (const section of sections) {
        const haystack = (section.textContent ?? "").toLowerCase();
        const match = query.length === 0 || haystack.includes(query);
        section.hidden = !match;
        if (match) {
          panelMatched = true;
          matchedSections += 1;
        }
      }

      tabBtns[i]!.classList.toggle("settings-tab--match", panelMatched && query.length > 0);
    }

    if (query.length === 0) {
      searchStatus.textContent = "";
      return;
    }
    searchStatus.textContent = matchedSections > 0
      ? `${matchedSections} matching section${matchedSections === 1 ? "" : "s"}`
      : "No matching settings";
  };

  searchInput.addEventListener("input", applySearchFilter);
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

  // Mobile & PWA section
  const mobileSection = make("div", { class: "settings-section" });
  mobileSection.appendChild(make("h4", { class: "settings-section__title" }, "Mobile & Touch"));

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
    "Show touch controls while playing — tap the \"🎮 Edit\" button in the game toolbar to reposition buttons",
    settings.touchControls,
    (v) => onSettingsChange({ touchControls: v })
  ));

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

  container.append(overlaySection, mobileSection);

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
      { value: "none",    label: "No effect",        desc: "Clean output — exactly as the game renders it" },
      { value: "crt",     label: "CRT screen",       desc: "Scanlines and glow — like playing on a real CRT TV" },
      { value: "sharpen", label: "Sharper image",    desc: "Crisper pixels — great for upscaled handheld games" },
      { value: "lcd",     label: "LCD handheld",     desc: "Sub-pixel grid — simulates a handheld LCD screen" },
      { value: "bloom",   label: "Soft glow",        desc: "Gentle glow on bright areas — warm, cinematic feel" },
      { value: "fxaa",    label: "Smooth edges",     desc: "Reduces jagged edges on 3D game geometry" },
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
    chip.title = sys.name;
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
}): void {
  const { netplayManager, currentGameName, currentGameId, currentSystemId } = opts;
  const serverUrl = netplayManager?.serverUrl ?? "";
  const username  = netplayManager?.username  ?? "";

  const easyMgr = getEasyNetplayManager(serverUrl);
  const panelCleanups: Array<() => void> = [];

  // ── Overlay / container ──────────────────────────────────────────────────
  const overlay = make("div", { class: "confirm-overlay easy-netplay-overlay" });
  const dialog  = make("div", {
    class:      "confirm-box easy-netplay-dialog",
    role:       "dialog",
    "aria-modal": "true",
    "aria-label": "Multiplayer",
  });

  // ── Header ───────────────────────────────────────────────────────────────
  const header = make("div", { class: "enp-header" });
  header.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
  header.appendChild(make("span", { class: "enp-title" }, "Multiplayer"));
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
    { id: "host",   label: "🎮 Host"   },
    { id: "join",   label: "🔗 Join"   },
    { id: "browse", label: "📋 Browse" },
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
  panelCleanups.push(_buildBrowsePanel(panels[2]!, {
    easyMgr, currentGameName, currentSystemId, serverUrl,
    onJoinByCode: (code) => {
      switchTab("join");
      _fillJoinCode?.(code);
      _quickJoinCode?.(code);
    },
  }));

  // ── Append + animate ─────────────────────────────────────────────────────
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, { capture: true });
    panelCleanups.forEach((fn) => {
      try { fn(); } catch { /* ignore cleanup errors */ }
    });
    easyMgr.cancelPendingOperations();
    overlay.classList.remove("confirm-overlay--visible");
    setTimeout(() => overlay.remove(), 200);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && _isTopmostOverlay(overlay)) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

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
  }) as HTMLSelectElement;
  const typeOptions: Array<{ value: string; label: string; desc: string }> = [
    { value: "local",   label: "Local Network",  desc: "Friends on the same Wi-Fi" },
    { value: "private", label: "Private Room",    desc: "Share a code to invite" },
    { value: "public",  label: "Public Room",     desc: "Anyone can browse and join" },
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
  const statusArea = make("div", { class: "enp-status-area" });
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
      "Open a game first, then click Multiplayer to host."
    ));
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
    class:        "enp-code-input",
    placeholder:  "AB12CD",
    maxlength:    "10",
    autocomplete: "off",
    autocapitalize: "characters",
    spellcheck:   "false",
  }) as HTMLInputElement;

  // Auto-format, uppercase, and sync button state whenever the value changes.
  // Extracted into a named function so the Browse-panel pre-fill setter can
  // call the same logic directly without dispatching a synthetic DOM event.
  const syncCodeInput = () => {
    const norm = normaliseInviteCode(codeInput.value);
    if (norm !== codeInput.value) codeInput.value = norm;
    codeError.hidden = true;
    btnJoin.disabled = norm.length < 4;
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
  const codeError = make("p", { class: "enp-diag enp-diag--error" });
  codeError.hidden = true;
  container.appendChild(codeError);

  // No-server warning
  if (!serverUrl) {
    container.appendChild(make("p", { class: "enp-server-warn" },
      "⚠ No server URL configured. Joining by code requires a server. Add one in Settings → Play Together."
    ));
  }

  // Status area
  const statusArea = make("div", { class: "enp-status-area" });
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
    if (code.length < 4) {
      codeError.textContent = "Please enter a valid invite code (at least 4 characters).";
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

function _buildBrowsePanel(
  container: HTMLElement,
  opts: {
    easyMgr:          EasyNetplayManager;
    currentGameName?: string | null;
    currentSystemId?: string | null;
    serverUrl?:       string;
    /** Called when the user clicks "Join" on a room card; receives the invite code. */
    onJoinByCode?:    (code: string) => void;
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

      frag.appendChild(card);
    }
    listEl.appendChild(frag);
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

  // Footer with Refresh button
  const footer = make("div", { class: "enp-browse-footer" });
  const refreshBtn = make("button", { class: "btn enp-refresh-btn" }) as HTMLButtonElement;
  refreshBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.49-4.5"/></svg> Refresh`;
  refreshBtn.addEventListener("click", doRefresh);
  footer.appendChild(refreshBtn);
  container.appendChild(footer);

  // Auto-load on panel reveal
  renderRooms([]);
  void doRefresh();
  return () => {
    loadAbort?.abort();
    loadAbort = null;
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

// ── Multiplayer tab ───────────────────────────────────────────────────────────

function buildMultiplayerTab(
  container:        HTMLElement,
  settings:         Settings,
  onSettingsChange: (patch: Partial<Settings>) => void,
  netplayManager?:  import("./multiplayer.js").NetplayManager,
  currentGameName?: string | null,
  currentSystemId?: string | null,
): void {
  // Intro section
  const introSection = make("div", { class: "settings-section" });
  introSection.appendChild(make("h4", { class: "settings-section__title" }, "Online Multiplayer"));
  introSection.appendChild(make("p", { class: "settings-help" },
    "Play with friends online. Enable this and add a server URL to get started — " +
    "then open a game and use the Netplay button in the toolbar to create or join a room."
  ));

  // Status badge — shows whether netplay is ready to use
  const statusBadge = make("span", { class: "netplay-status-pill netplay-status-pill--inactive" });
  const updateStatusBadge = () => {
    const active = netplayManager?.isActive ?? false;
    statusBadge.textContent = active ? "Ready" : "Not configured";
    statusBadge.className = active
      ? "netplay-status-pill netplay-status-pill--active"
      : "netplay-status-pill netplay-status-pill--inactive";
  };
  updateStatusBadge();
  introSection.appendChild(statusBadge);

  // Enable toggle
  introSection.appendChild(buildToggleRow(
    "Enable Netplay",
    "Show the Netplay button in the emulator toolbar. Requires a server URL below.",
    settings.netplayEnabled,
    (v) => {
      onSettingsChange({ netplayEnabled: v });
      netplayManager?.setEnabled(v);
      serverSection.hidden = !v;
      updateStatusBadge();
    }
  ));

  container.appendChild(introSection);

  // Server URL section — hidden when netplay is disabled
  const serverSection = make("div", { class: "settings-section" });
  serverSection.hidden = !settings.netplayEnabled;
  serverSection.appendChild(make("h4", { class: "settings-section__title" }, "Netplay Server"));
  serverSection.appendChild(make("p", { class: "settings-help" },
    "WebSocket URL of the netplay signalling server (e.g. wss://netplay.example.com). " +
    "The server handles room creation, room listing, and WebRTC signalling. " +
    "Leave blank to disable netplay even when toggled on."
  ));

  const urlRow   = make("div", { class: "settings-input-row" });
  const urlLabel = make("label", { class: "settings-input-label", for: "netplay-server-url" }, "Server URL");
  const urlInput = make("input", {
    type:         "text",
    id:           "netplay-server-url",
    class:        "settings-input",
    placeholder:  "wss://netplay.example.com",
    value:        settings.netplayServerUrl,
    autocomplete: "off",
    spellcheck:   "false",
  }) as HTMLInputElement;
  urlInput.addEventListener("input", () => urlInput.setCustomValidity(""));
  urlInput.addEventListener("change", () => {
    const url = urlInput.value.trim();
    const err = netplayManager?.validateServerUrl(url) ?? null;
    if (err) {
      urlInput.setCustomValidity(err);
      urlInput.reportValidity();
      return;
    }
    urlInput.setCustomValidity("");
    onSettingsChange({ netplayServerUrl: url });
    netplayManager?.setServerUrl(url);
    updateStatusBadge();
  });
  urlRow.append(urlLabel, urlInput);
  serverSection.appendChild(urlRow);

  // Username / display name row
  const unameRow   = make("div", { class: "settings-input-row" });
  const unameLabel = make("label", { class: "settings-input-label", for: "netplay-username" }, "Display Name");
  const unameInput = make("input", {
    type:         "text",
    id:           "netplay-username",
    class:        "settings-input",
    placeholder:  "Anonymous",
    value:        settings.netplayUsername,
    autocomplete: "off",
    spellcheck:   "false",
    maxlength:    "32",
  }) as HTMLInputElement;
  unameInput.addEventListener("input", () => unameInput.setCustomValidity(""));
  unameInput.addEventListener("change", () => {
    const name = unameInput.value.trim();
    const err = netplayManager?.validateUsername(name) ?? null;
    if (err) {
      unameInput.setCustomValidity(err);
      unameInput.reportValidity();
      return;
    }
    unameInput.setCustomValidity("");
    onSettingsChange({ netplayUsername: name });
    netplayManager?.setUsername(name);
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
  let iceServers: RTCIceServer[] = [...(netplayManager?.iceServers ?? DEFAULT_ICE_SERVERS)];

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
        netplayManager?.setIceServers([...iceServers]);
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
    class:        "settings-input",
    placeholder:  "stun:stun.example.com:3478",
    "aria-label": "New ICE server URL",
    autocomplete: "off",
    spellcheck:   "false",
  }) as HTMLInputElement;
  const addBtn = make("button", { class: "btn btn--primary" }, "Add") as HTMLButtonElement;
  addBtn.addEventListener("click", () => {
    const url = addInput.value.trim();
    if (!url) return;
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
    netplayManager?.setIceServers([...iceServers]);
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
    netplayManager?.resetIceServers();
    iceServers = [...DEFAULT_ICE_SERVERS];
    renderIceList();
  });
  iceContent.appendChild(resetBtn);

  iceDetails.appendChild(iceContent);
  serverSection.appendChild(iceDetails);

  container.append(serverSection);

  // Lobby browser section — visible only when netplay is active
  const lobbySection = make("div", { class: "settings-section netplay-lobby" });
  lobbySection.hidden = !(netplayManager?.isActive ?? false);
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
      skel.appendChild(make("div", { class: "netplay-lobby-skeleton__bar", style: "flex:1" }));
      skel.appendChild(make("div", { class: "netplay-lobby-skeleton__bar", style: "width:44px" }));
      skel.appendChild(make("div", { class: "netplay-lobby-skeleton__bar", style: "width:36px" }));
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
    "Netplay is available for the following systems. Other systems load fine but online play is not yet supported."
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
        `This system (${sysName}) does not currently support netplay in this app.`
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

  if (!(netplayManager?.isActive)) {
    roomSection.appendChild(make("p", { class: "settings-help" },
      "Server URL is required — enable Online Play and add a server URL above to start playing with others."
    ));
  } else {
    const hasGame = !!currentGameName;
    roomSection.appendChild(make("p", { class: "settings-help" },
      hasGame
        ? `Open the Netplay button in the toolbar while playing ${currentGameName} to create or join a room.`
        : "Open a game, then use the Netplay button in the toolbar to create or join a room."
    ));
    const actionRow = make("div", { class: "netplay-room-actions" });
    const createBtn = make("button", {
      class: "btn btn--primary netplay-create-room",
      title: "Start a game and use the Netplay button to create a room",
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
          ? `Use the Netplay button in the toolbar to create a room for ${currentGameName}.`
          : "Start a game first, then use the Netplay button in the toolbar to create a room."
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
  netplayManager?:  import("./multiplayer.js").NetplayManager,
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
    ndsSection.appendChild(make("p", { class: "device-info" },
      `Active DeSmuME settings (tier: ${emulatorRef?.activeTier ?? "—"})`
    ));
    ndsSection.appendChild(make("p", { class: "device-info" },
      `CPU mode: ${dsCpuMode} | Frameskip: ${dsFrameskip} | Resolution: ${dsResolution}`
    ));
    ndsSection.appendChild(make("p", { class: "device-info" },
      `OpenGL: ${dsOpenGL} | Advanced timing: ${dsTiming} | Color depth: ${dsColorDepth}`
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
      `Enabled: ${netplayManager?.enabled ?? false}`,
      `Active: ${netplayManager?.isActive ?? false}`,
      `Server: ${netplayManager?.serverUrl || "—"}`,
      `ICE Servers: ${netplayManager?.iceServers.length ?? 0}`,
      ...(netplayManager?.iceServers ?? []).map(s =>
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

  container.append(settingsSection, envSection, gpuSection, ps1Section, ndsSection, stateSection, timelineSection, actionsSection);
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
    "Save your progress with F5, load it back with F7, and press Esc to return to your game library.",
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
    ["F9", "Open Settings"],
    ["Esc", "Return to game library"],
    ["F3", "Developer debug info"],
  ];

  const shortcutList = make("div", { class: "device-info-details" });
  for (const [key, desc] of shortcuts) {
    const row = make("div", { class: "shortcut-row" });
    const kbdEl = make("kbd", { class: "shortcut-key" }, key);
    row.append(kbdEl, make("span", { class: "shortcut-desc device-info" }, desc));
    shortcutList.appendChild(row);
  }
  shortcutsSection.appendChild(shortcutList);

  // Troubleshooting section
  const troubleSection = make("div", { class: "settings-section" });
  troubleSection.appendChild(make("h4", { class: "settings-section__title" }, "Troubleshooting"));

  const troubles: Array<[string, string]> = [
    ["Game won't load", "Check that the file is a valid ROM. ZIP files are automatically extracted — if it still fails, try unzipping the file manually first."],
    ["PSP game won't start", "PSP games need a special browser feature. Try refreshing the page once — this sets things up automatically."],
    ["No sound", "Make sure the browser tab isn't muted. Some games take a few seconds to start audio."],
    ["Game is slow or choppy", "Open ⚡ Settings → Performance and switch to Performance mode. Closing other browser tabs can also help."],
    ["Saves aren't working", "Your saves are stored in your browser. Clearing browser data will erase them — export saves as a backup before doing that."],
    ["Controls not responding", "Click on the game screen first to make sure it has focus. Gamepads should be connected before launching a game."],
    ["Stuck on loading screen", "Try refreshing the page. If the issue persists, the game file may be corrupted or an unsupported format."],
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
    "RetroVault lets you play retro games from 20+ classic systems — PSP, N64, PS1, NDS, GBA, SNES, NES and more — " +
    "right in your browser. No installs, no account, nothing to sign up for."
  ));
  aboutSection.appendChild(make("p", { class: "settings-help" },
    "Your game files and saves are stored privately in your browser. RetroVault never uploads anything."
  ));

  const links = make("div", { style: "display:flex;gap:8px;flex-wrap:wrap" });
  const ejsLink = make("a", {
    href: "https://emulatorjs.org",
    target: "_blank",
    rel: "noopener",
    class: "btn",
    style: "text-decoration:none",
  }, "Powered by EmulatorJS");
  links.appendChild(ejsLink);
  aboutSection.appendChild(links);

  container.append(quickStartSection, shortcutsSection, troubleSection, aboutSection);
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
  toggle.append(input, knob);

  input.addEventListener("change", () => onChange(input.checked));
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
  return new Promise((resolve) => {
    const overlay = make("div", { class: "confirm-overlay" });
    const box = make("div", { class: "confirm-box multidisc-box", role: "dialog", "aria-modal": "true", "aria-label": "Multi-Disc Game Setup" });

    box.appendChild(make("h3", { class: "confirm-title" }, "Multi-Disc Game"));
    box.appendChild(make("p", { class: "confirm-body" },
      `This game spans ${discFileNames.length} disc${discFileNames.length !== 1 ? "s" : ""}. Please select each disc image file:`
    ));

    const fileMap = new Map<string, File>();

    for (const fileName of discFileNames) {
      const row        = make("div", { class: "multidisc-row" });
      const status     = make("span", { class: "bios-dot bios-dot--missing" });
      const label2     = make("span", { class: "multidisc-label" }, fileName);
      const fileInput2 = make("input", { type: "file", style: "display:none", "aria-label": `Select ${fileName}` }) as HTMLInputElement;
      const btn        = make("button", { class: "btn" }, "Select…");

      btn.addEventListener("click", () => fileInput2.click());
      fileInput2.addEventListener("change", () => {
        const f = fileInput2.files?.[0];
        if (!f) return;
        fileMap.set(fileName, f);
        status.className = "bios-dot bios-dot--ok";
        btn.textContent  = f.name;
        checkAllSelected();
      });
      row.append(status, fileInput2, label2, btn);
      box.appendChild(row);
    }

    const footer     = make("div", { class: "confirm-footer" });
    const btnCancel  = make("button", { class: "btn" }, "Cancel");
    const btnConfirm = make("button", { class: "btn btn--primary", disabled: "true" }, "Launch Game");
    footer.append(btnCancel, btnConfirm);
    box.appendChild(footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const checkAllSelected = () => {
      const allReady = discFileNames.every(fn => fileMap.has(fn));
      if (allReady) btnConfirm.removeAttribute("disabled"); else btnConfirm.setAttribute("disabled", "true");
    };

    const close = (result: Map<string, File> | null) => {
      document.removeEventListener("keydown", onKey, { capture: true });
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), 200);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && _isTopmostOverlay(overlay)) { e.preventDefault(); e.stopPropagation(); close(null); }
    };
    btnCancel.addEventListener("click",  () => close(null));
    btnConfirm.addEventListener("click", () => close(fileMap));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
    document.addEventListener("keydown", onKey, { capture: true });
    requestAnimationFrame(() => overlay.classList.add("confirm-overlay--visible"));
  });
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

  // ── Scalar metrics ────────────────────────────────────────────────────────
  const fpsEl    = document.getElementById("dev-fps");
  const frameEl  = document.getElementById("dev-frame-time");
  const p95El    = document.getElementById("dev-p95");
  const dropEl   = document.getElementById("dev-dropped");
  const memEl    = document.getElementById("dev-memory");
  const stateEl  = document.getElementById("dev-state");

  if (fpsEl)   fpsEl.textContent   = `${snapshot.current}`;
  if (frameEl) frameEl.textContent = `${frameTimeMs} ms`;
  if (p95El)   p95El.textContent   = `${snapshot.p95FrameTimeMs} ms`;
  if (dropEl)  dropEl.textContent  = `${snapshot.droppedFrames}`;

  if (memEl) {
    const perf = performance as Performance & { memory?: { usedJSHeapSize?: number } };
    const used = perf.memory?.usedJSHeapSize;
    memEl.textContent = used ? `${Math.round(used / (1024 * 1024))} MB` : "n/a";
  }

  if (stateEl) {
    stateEl.textContent = emulator.state;
    stateEl.className = `dev-overlay__value dev-overlay__state--${emulator.state}`;
  }

  // ── Frame-time mini graph ─────────────────────────────────────────────────
  const canvas = document.getElementById("dev-framegraph") as HTMLCanvasElement | null;
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

function updateFPSOverlay(snapshot: FPSSnapshot, emulator: PSPEmulator): void {
  const currentEl = document.getElementById("fps-current");
  const avgEl     = document.getElementById("fps-avg");
  const tierEl    = document.getElementById("fps-tier");
  const droppedEl = document.getElementById("fps-dropped");

  if (currentEl) {
    currentEl.textContent = `${snapshot.current} FPS`;
    currentEl.className = snapshot.current >= 50 ? "fps-good" : snapshot.current >= 30 ? "fps-ok" : "fps-bad";
  }
  if (avgEl) avgEl.textContent = `avg ${snapshot.average}`;
  if (tierEl && emulator.activeTier) tierEl.textContent = formatTierLabel(emulator.activeTier);
  if (droppedEl) {
    if (snapshot.droppedFrames > 0) { droppedEl.textContent = `${snapshot.droppedFrames} dropped`; droppedEl.hidden = false; }
    else { droppedEl.hidden = true; }
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

  const dismiss = () => { toast.classList.add("perf-suggestion--hiding"); setTimeout(() => toast.remove(), 300); };
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

// ── Visibility helpers ────────────────────────────────────────────────────────

export function hideLanding(): void    { el("#landing").classList.add("hidden"); }
export function showLanding(): void    { el("#landing").classList.remove("hidden"); }
export function showLoadingOverlay(): void { document.getElementById("loading-overlay")?.classList.add("visible"); }
export function hideLoadingOverlay(): void {
  document.getElementById("loading-overlay")?.classList.remove("visible");
  // Clear subtitle when hiding
  const sub = document.getElementById("loading-subtitle");
  if (sub) sub.textContent = "";
}
export function showEjsContainer(): void  { document.getElementById("ejs-container")?.classList.add("visible"); }
export function hideEjsContainer(): void  { document.getElementById("ejs-container")?.classList.remove("visible"); }
export function setLoadingMessage(msg: string): void { const e = document.getElementById("loading-message"); if (e) e.textContent = msg; }
/** Set a secondary hint shown under the loading message. Pass empty string to hide. */
export function setLoadingSubtitle(msg: string): void { const e = document.getElementById("loading-subtitle"); if (e) e.textContent = msg; }
export function setStatusGame(name: string): void    { const e = document.getElementById("status-game");    if (e) e.textContent = name; }
export function setStatusSystem(name: string): void  { const e = document.getElementById("status-system");  if (e) e.textContent = name; }
function setStatusTier(tier: PerformanceTier | null): void { const e = document.getElementById("status-tier"); if (e) e.textContent = tier ? formatTierLabel(tier) : "—"; }

let _errorDismissTimer: ReturnType<typeof setTimeout> | null = null;
const ERROR_DISMISS_TIMEOUT_MS = 12_000;

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
  if (m.includes("bios") || m.includes("startup file")) {
    return "This game needs a startup file (BIOS). Go to Settings → System Files to add one.";
  }
  return msg; // Return original if no friendly mapping found
}

export function showError(msg: string): void {
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
  banner.classList.add("visible");
  if (_errorDismissTimer !== null) clearTimeout(_errorDismissTimer);
  _errorDismissTimer = setTimeout(() => { hideError(); _errorDismissTimer = null; }, ERROR_DISMISS_TIMEOUT_MS);
}

export function hideError(): void {
  if (_errorDismissTimer !== null) { clearTimeout(_errorDismissTimer); _errorDismissTimer = null; }
  document.getElementById("error-banner")?.classList.remove("visible");
}

export function showInfoToast(msg: string): void {
  const existing = document.getElementById("info-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "info-toast";
  toast.className = "info-toast";
  toast.setAttribute("role", "status");

  // Checkmark icon
  const icon = document.createElement("span");
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "✓";
  icon.style.cssText = "color:var(--c-accent);font-size:1rem;font-weight:800;flex-shrink:0";

  const text = document.createElement("span");
  text.textContent = msg;

  const closeBtn = document.createElement("button");
  closeBtn.className = "error-close";
  closeBtn.textContent = "✕";
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.addEventListener("click", () => { toast.classList.remove("visible"); setTimeout(() => toast.remove(), 200); });

  toast.append(icon, text, closeBtn);
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add("visible"));
  setTimeout(() => { toast.classList.remove("visible"); setTimeout(() => toast.remove(), 200); }, 5000);
}
