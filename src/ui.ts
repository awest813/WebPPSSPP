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
} from "./saves.js";
import type { Settings } from "./main.js";
import type { TouchControlsOverlay } from "./touchControls.js";
import type { NetplayManager } from "./multiplayer.js";
import { DEFAULT_ICE_SERVERS } from "./multiplayer.js";

// ── PWA install callbacks (set once from initUI) ───────────────────────────────
let _canInstallPWA: (() => boolean) | undefined;
let _onInstallPWA:  (() => Promise<boolean>) | undefined;

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

export function buildDOM(app: HTMLElement): void {
  // Reset module-level state that is tied to DOM nodes created below
  _libraryControlsWired = false;

  const acceptList = ALL_EXTENSIONS.map(e => `.${e}`).join(",");

  app.innerHTML = `
    <!-- ── Header ── -->
    <header class="app-header">
      <div class="app-header__brand">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2" y="6" width="20" height="12" rx="2"/>
          <circle cx="8"  cy="12" r="1.5"/>
          <circle cx="16" cy="12" r="1.5"/>
          <line x1="12" y1="9"  x2="12" y2="15"/>
          <line x1="9"  y1="12" x2="15" y2="12"/>
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
              <span class="library-count" id="library-count"></span>
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
          <div class="drop-zone__icon" aria-hidden="true">+</div>
          <p class="drop-zone__label">Drop a game file to add it</p>
          <p class="drop-zone__sub">or <span class="drop-zone__browse">browse files</span></p>
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
      </div>

      <!-- Loading overlay -->
      <div id="loading-overlay" role="status" aria-live="polite">
        <div class="loading-spinner" aria-hidden="true"></div>
        <p id="loading-message">Initialising…</p>
      </div>

      <!-- Error banner -->
      <div id="error-banner" role="alert" aria-live="assertive">
        <span id="error-message"></span>
        <button class="error-close" id="error-close" title="Dismiss" aria-label="Dismiss error">✕</button>
      </div>

      <!-- System picker modal -->
      <div id="system-picker" role="dialog" aria-modal="true" aria-label="Choose System" hidden>
        <div class="modal-backdrop" id="system-picker-backdrop"></div>
        <div class="modal-box">
          <div class="modal-header">
            <h3 class="modal-title">Choose System</h3>
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
      <div id="settings-panel" role="dialog" aria-modal="true" aria-label="Settings" hidden>
        <div class="modal-backdrop" id="settings-backdrop"></div>
        <div class="modal-box settings-modal-box">
          <div class="modal-header">
            <h3 class="modal-title">Settings</h3>
            <button class="modal-close" id="settings-close" aria-label="Close settings">✕</button>
          </div>
          <div id="settings-content">
            <!-- Populated by buildSettingsContent() -->
          </div>
        </div>
      </div>

    </main>

    <!-- ── Footer ── -->
    <footer class="app-footer">
      <div class="status-item">
        <div class="status-dot idle" id="status-dot"></div>
        <span class="status-item__label">State:</span>
        <span class="status-item__value" id="status-state">Idle</span>
      </div>
      <div class="status-item hide-mobile">
        <span class="status-item__label">System:</span>
        <span class="status-item__value" id="status-system">—</span>
      </div>
      <div class="status-item hide-mobile">
        <span class="status-item__label">Game:</span>
        <span class="status-item__value" id="status-game">—</span>
      </div>
      <div class="status-item hide-mobile">
        <span class="status-item__label">Tier:</span>
        <span class="status-item__value" id="status-tier">—</span>
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
  const { emulator, library, biosLibrary, saveLibrary, netplayManager, settings, deviceCaps,
          onLaunchGame, onSettingsChange, onReturnToLibrary,
          onApplyPatch, onFileChosen,
          getCurrentGameId, getCurrentGameName, getCurrentSystemId,
          getTouchOverlay, canInstallPWA, onInstallPWA } = opts;

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

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void onFileChosen(file);
    fileInput.value = "";
  });

  dropZone.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    fileInput.click();
  });

  document.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!dragOverActive) {
      dragOverActive = true;
      dropZone.classList.add("drag-over");
    }
  });
  document.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth += 1;
    if (!dragOverActive) {
      dragOverActive = true;
      dropZone.classList.add("drag-over");
    }
  });
  document.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth > 0) return;
    clearDragOver();
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    clearDragOver();
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    if (emulator.state === "running") {
      showError("Return to the library first (Esc or ← Library) before loading a new game.");
      return;
    }
    void onFileChosen(file);
  });
  window.addEventListener("blur", clearDragOver);

  // ── Error banner ──────────────────────────────────────────────────────────
  el("#error-close").addEventListener("click", hideError);

  // ── FPS overlay wiring ────────────────────────────────────────────────────
  emulator.setFPSMonitorEnabled(settings.showFPS);
  emulator.onFPSUpdate = (snapshot) => { updateFPSOverlay(snapshot, emulator); };

  // ── Emulator lifecycle → DOM ──────────────────────────────────────────────
  emulator.onStateChange = (state) => updateStatusDot(state);
  emulator.onProgress    = (msg)   => setLoadingMessage(msg);
  emulator.onError       = (msg)   => { hideLoadingOverlay(); showError(msg); };
  emulator.onGameStart = () => {
    hideLoadingOverlay();
    showEjsContainer();
    hideLanding();
    resetPerfSuggestion();
    const sys  = emulator.currentSystem;
    const name = settings.lastGameName ?? "Unknown";
    setStatusSystem(sys ? sys.shortName : "—");
    setStatusGame(name);
    setStatusTier(emulator.activeTier);
    document.title = `${name} — RetroVault`;
    buildInGameControls(
      emulator, settings, onSettingsChange, onReturnToLibrary,
      saveLibrary, getCurrentGameId, getCurrentGameName, getCurrentSystemId,
      getTouchOverlay
    );
    showFPSOverlay(settings.showFPS, emulator, settings.showAudioVis);
    if (settings.touchControls) {
      const overlay = getTouchOverlay?.();
      if (overlay) requestAnimationFrame(() => overlay.show());
    }
    document.dispatchEvent(new CustomEvent("retrovault:gameStarted"));
  };

  document.addEventListener("retrovault:resumeGame", () => {
    showEjsContainer();
    hideLanding();
    const sys  = emulator.currentSystem;
    const name = settings.lastGameName ?? "Unknown";
    document.title = `${name} — RetroVault`;
    setStatusSystem(sys ? sys.shortName : "—");
    setStatusGame(name);
    buildInGameControls(
      emulator, settings, onSettingsChange, onReturnToLibrary,
      saveLibrary, getCurrentGameId, getCurrentGameName, getCurrentSystemId,
      getTouchOverlay
    );
    showFPSOverlay(settings.showFPS, emulator, settings.showAudioVis);
    if (settings.touchControls) {
      const overlay = getTouchOverlay?.();
      if (overlay) requestAnimationFrame(() => overlay.show());
    }
  });

  // Ensure overlay work is paused while browsing the library.
  document.addEventListener("retrovault:returnToLibrary", () => {
    showFPSOverlay(false);
  });

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  document.addEventListener("keydown", (e) => {
    if (emulator.state !== "running") return;
    switch (e.key) {
      case "F5":  e.preventDefault(); void quickSaveWithPersist(emulator, saveLibrary, getCurrentGameId, getCurrentGameName, getCurrentSystemId, 1); break;
      case "F7":  e.preventDefault(); emulator.quickLoad(1);   break;
      case "F1":  e.preventDefault(); emulator.reset();        break;
      case "Escape": onReturnToLibrary();                       break;
    }
  });

  // ── Landing header controls ───────────────────────────────────────────────
  buildLandingControls(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, undefined, saveLibrary, netplayManager);

  if (typeof ResizeObserver !== "undefined") {
    const headerActions = document.getElementById("header-actions");
    if (headerActions) {
      new ResizeObserver(updateHeaderOverflow).observe(headerActions);
    }
  }

  // ── Initial library render ────────────────────────────────────────────────
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

  if (emulatorRef && allGames.length > 0) {
    const systemIds = new Set(allGames.map(g => g.systemId));
    for (const sid of systemIds) { emulatorRef.prefetchCore(sid); }
  }

  grid.innerHTML = "";

  if (displayed.length === 0 && allGames.length > 0) {
    const empty = make("div", { class: "library-empty" });
    empty.innerHTML = `<p>No games match "<em>${_escHtml(_librarySearchQuery)}</em>"</p>`;
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

  const card = make("div", { class: "game-card", role: "button", tabindex: "0", "aria-label": `Play ${game.name}` });
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

  const patchInput = make("input", {
    type: "file",
    accept: ".ips,.bps,.ups",
    "aria-label": `Apply patch to ${game.name}`,
    style: "display:none",
  }) as HTMLInputElement;

  const btnPatch = make("button", {
    class: "game-card__patch",
    title: "Apply IPS/BPS/UPS patch",
    "aria-label": `Apply patch to ${game.name}`,
  }, "⊕");

  btnPatch.addEventListener("click", (e) => { e.stopPropagation(); patchInput.click(); });
  patchInput.addEventListener("change", async () => {
    const patchFile = patchInput.files?.[0];
    if (!patchFile || !onApplyPatch) return;
    patchInput.value = "";
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

  card.append(icon, info, patchInput, btnPatch, btnChangeSystem, btnRemove, playOverlay);

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
    setLoadingMessage(`Loading ${game.name}…`);
    try {
      const blob = await library.getGameBlob(game.id);
      if (!blob) { hideLoadingOverlay(); showError(`Game "${game.name}" not found in library.`); return; }
      const file = toLaunchFile(blob, game.fileName);
      await library.markPlayed(game.id);
      await onLaunchGame(file, game.systemId, game.id);
    } catch (err) {
      hideLoadingOverlay();
      showError(`Failed to load game: ${err instanceof Error ? err.message : String(err)}`);
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
      document.removeEventListener("keydown", onKey);
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), 200);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(false); } };
    btnCancel.addEventListener("click",  () => close(false));
    btnConfirm.addEventListener("click", () => close(true));
    overlay.addEventListener("click",    (e) => { if (e.target === overlay) close(false); });
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => { overlay.classList.add("confirm-overlay--visible"); btnConfirm.focus(); });
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
    for (const sys of candidates) {
      const btn   = make("button", { class: "system-pick-btn" });
      const badge = make("span", { class: "sys-badge" }, sys.shortName);
      badge.style.background = sys.color;
      btn.append(badge, document.createTextNode(sys.name));
      btn.addEventListener("click", () => close(sys));
      list.appendChild(btn);
    }
    panel.hidden = false;

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

export async function resolveSystemAndAdd(
  file:          File,
  library:       GameLibrary,
  settings:      Settings,
  onLaunchGame:  (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef?:  PSPEmulator,
  onApplyPatch?: (gameId: string, patchFile: File) => Promise<void>
): Promise<void> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (PATCH_EXT_SET.has(ext)) {
    await handlePatchFileDrop(file, library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    return;
  }

  let resolvedFile = file;

  // ZIP is extraction-capable. 7z is treated as a native package and routed
  // through normal system detection (MAME 2003+) rather than being blocked.
  if (ext === "zip") {
    const { extractFromZip } = await import("./archive.js");
    showLoadingOverlay();
    setLoadingMessage("Extracting archive…");
    try {
      const extracted = await extractFromZip(file);
      if (extracted) {
        resolvedFile = new File([extracted.blob], extracted.name, { type: extracted.blob.type });
        setLoadingMessage("Archive extracted. Adding to library…");
      } else {
        // No extractable ROM entry found. Fall back to native package handling
        // (e.g. arcade/MAME zip sets) via the normal detectSystem flow below.
        hideLoadingOverlay();
      }
    } catch {
      // Extraction is best-effort. If parsing/decompression fails, continue
      // with the original zip as a native package candidate.
      hideLoadingOverlay();
    }
  }

  const detected = detectSystem(resolvedFile.name);
  let system: SystemInfo | null = null;

  if (detected === null) {
    hideLoadingOverlay();
    showError(`Unrecognised file type: "${resolvedFile.name}".\nSupported extensions: ${ALL_EXTENSIONS.map(e => `.${e}`).join("  ·  ")}`);
    return;
  } else if (Array.isArray(detected)) {
    hideLoadingOverlay();
    system = await pickSystem(resolvedFile.name, detected);
    if (!system) return;
  } else {
    // Single system detected — do not hide the overlay here.
    // If a ZIP was just extracted the overlay is still showing; leaving it
    // visible avoids a flicker (hide → immediate show) on the happy path.
    system = detected;
  }

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
      setLoadingMessage(`Loading ${existing.name}…`);
      try {
        const existingFile = toLaunchFile(existing.blob, existing.fileName);
        await library.markPlayed(existing.id);
        await onLaunchGame(existingFile, existing.systemId, existing.id);
      } catch (err) {
        hideLoadingOverlay();
        showError(`Could not load game: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
  } catch { /* fall through */ }

  showLoadingOverlay();
  setLoadingMessage("Adding game to library…");

  try {
    const entry = await library.addGame(resolvedFile, system.id);
    settings.lastGameName = entry.name;
    void renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
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
    for (const game of games) {
      const sys   = getSystemById(game.systemId);
      const btn   = make("button", { class: "game-picker-btn" });
      const badge = make("span", { class: "sys-badge" }, sys?.shortName ?? game.systemId);
      badge.style.background = sys?.color ?? "#555";
      btn.append(badge, document.createTextNode(" " + game.name));
      btn.addEventListener("click", () => close(game));
      list.appendChild(btn);
    }
    box.appendChild(list);

    const cancelBtn = make("button", { class: "btn" }, "Cancel");
    cancelBtn.addEventListener("click", () => close(null));
    box.appendChild(cancelBtn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = (result: GameMetadata | null) => {
      document.removeEventListener("keydown", onKey);
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), 200);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(null); } };
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
    document.addEventListener("keydown", onKey);
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
  for (const fn of discFileNames) {
    try {
      const entry = await library.findByFileName(fn, system.id);
      if (entry) storedDiscs.set(fn, { id: entry.id, blob: entry.blob });
    } catch { /* ignore */ }
  }

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
    // Revoke the disc blob URLs when the user returns to the library. The emulator
    // core keeps its own reference via the loaded game URL, so revoking here is
    // safe once the game has started — the emulator holds the data, not the URL.
    const revokeOnReturn = () => { blobUrls.forEach(u => URL.revokeObjectURL(u)); };
    document.addEventListener("retrovault:returnToLibrary", revokeOnReturn, { once: true });
  } catch (err) {
    hideLoadingOverlay();
    showError(`Multi-disc launch failed: ${err instanceof Error ? err.message : String(err)}`);
    // Revoke immediately; also remove the once-listener so it cannot fire later
    // on a different game's returnToLibrary event.
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

  const btnSettings = make("button", { class: "btn", title: "Settings", "aria-label": "Open settings" });
  btnSettings.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg> Settings`;

  btnSettings.addEventListener("click", () => {
    openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulatorRef, onLaunchGame, saveLibrary, netplayManager);
  });

  container.appendChild(btnSettings);
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
  getTouchOverlay?:   (() => TouchControlsOverlay | null) | undefined
): void {
  const container = el("#header-actions");
  container.innerHTML = "";

  // ← Library
  const btnLibrary = make("button", { class: "btn", title: "Back to library (Esc)" }, "← Library");
  btnLibrary.addEventListener("click", onReturnToLibrary);

  // Saves group (Save / Load / Gallery combined)
  const savesGroup = make("div", { class: "btn-group" });

  const btnSave = make("button", { class: "btn btn-group__btn", title: "Quick Save slot 1 (F5)" });
  btnSave.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save`;
  btnSave.addEventListener("click", async () => {
    await quickSaveWithPersist(emulator, saveLibrary, getCurrentGameId, getCurrentGameName, getCurrentSystemId, 1);
    showInfoToast("Saved to Slot 1");
  });

  const btnLoad = make("button", { class: "btn btn-group__btn", title: "Quick Load slot 1 (F7)" });
  btnLoad.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Load`;
  btnLoad.addEventListener("click", () => emulator.quickLoad(1));

  const btnSavesGallery = make("button", {
    class: "btn btn-group__btn btn-group__btn--icon",
    title: "Save state gallery",
    "aria-label": "Open save state gallery",
  });
  btnSavesGallery.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`;
  btnSavesGallery.addEventListener("click", () => {
    if (saveLibrary && getCurrentGameId?.() && getCurrentGameName?.() && getCurrentSystemId?.()) {
      void openSaveGallery(emulator, saveLibrary, getCurrentGameId()!, getCurrentGameName()!, getCurrentSystemId()!);
    }
  });

  savesGroup.append(btnSave, btnLoad, btnSavesGallery);

  // Reset
  const btnReset = make("button", { class: "btn btn--danger", title: "Reset game (F1)" });
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
  }, "FPS");
  btnFPS.addEventListener("click", () => {
    settings.showFPS = !settings.showFPS;
    onSettingsChange({ showFPS: settings.showFPS });
    btnFPS.className = settings.showFPS ? "btn btn--active" : "btn";
    btnFPS.setAttribute("aria-pressed", String(settings.showFPS));
    showFPSOverlay(settings.showFPS, emulator, settings.showAudioVis);
    emulator.setFPSMonitorEnabled(settings.showFPS);
  });

  // Touch controls edit button
  const overlay = getTouchOverlay?.();
  let btnTouch: HTMLButtonElement | null = null;
  if (overlay) {
    btnTouch = make("button", { class: "btn", title: "Edit touch control layout" }, "🎮 Edit") as HTMLButtonElement;
    let editMode = false;
    btnTouch.addEventListener("click", () => {
      editMode = !editMode;
      overlay.setEditing(editMode);
      btnTouch!.className    = editMode ? "btn btn--active" : "btn";
      btnTouch!.textContent  = editMode ? "✓ Done" : "🎮 Edit";
    });
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
  volSlider.addEventListener("input", () => {
    const v = Number(volSlider.value);
    if (v > 0) _preMuteVolume = v;
    emulator.setVolume(v);
    onSettingsChange({ volume: v });
    volBtn.textContent = volIcon(v);
  });
  volWrap.append(volBtn, volSlider);

  const controls: (HTMLElement | null)[] = [btnLibrary, savesGroup, btnReset, btnFPS, btnTouch, volWrap];
  for (const ctrl of controls) {
    if (ctrl) container.appendChild(ctrl);
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

// ── Save gallery dialog ───────────────────────────────────────────────────────

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
  galleryTitle.appendChild(make("h3", { class: "confirm-title" }, "Save States"));
  galleryTitle.appendChild(make("p",  { class: "save-gallery-game" }, gameName));
  galleryHeader.appendChild(galleryTitle);

  // Export all button
  const btnExportAll = make("button", { class: "btn", title: "Export all save states" });
  btnExportAll.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export All`;
  btnExportAll.addEventListener("click", async () => {
    const exports = await saveLibrary.exportAllForGame(gameId);
    if (exports.length === 0) { showInfoToast("No save data to export."); return; }
    for (const exp of exports) { downloadBlob(exp.blob, exp.fileName); }
    showInfoToast(`Exported ${exports.length} save state${exports.length !== 1 ? "s" : ""}.`);
  });
  galleryHeader.appendChild(btnExportAll);
  box.appendChild(galleryHeader);

  // Slots container
  const slotsContainer = make("div", { class: "save-gallery-grid" });
  box.appendChild(slotsContainer);

  // Footer
  const footer    = make("div", { class: "confirm-footer" });
  const btnClose  = make("button", { class: "btn" }, "Close");
  const shortcutHint = make("span", { class: "save-gallery-hint" }, "F5 Save · F7 Load");
  footer.append(shortcutHint, btnClose);
  box.appendChild(footer);

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const close = () => {
    document.removeEventListener("keydown", onKey);
    overlay.classList.remove("confirm-overlay--visible");
    setTimeout(() => overlay.remove(), 200);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  btnClose.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);
  requestAnimationFrame(() => overlay.classList.add("confirm-overlay--visible"));

  await renderSaveSlots(slotsContainer, emulator, saveLibrary, gameId, gameName, systemId);
}

async function renderSaveSlots(
  container:   HTMLElement,
  emulator:    PSPEmulator,
  saveLibrary: SaveStateLibrary,
  gameId:      string,
  gameName:    string,
  systemId:    string
): Promise<void> {
  container.innerHTML = "";

  const states = await saveLibrary.getStatesForGame(gameId);
  const stateMap = new Map(states.map(s => [s.slot, s]));

  // Auto-save slot first, then slots 1–MAX_SAVE_SLOTS
  const slots = [AUTO_SAVE_SLOT, ...Array.from({ length: MAX_SAVE_SLOTS }, (_, i) => i + 1)];

  for (const slot of slots) {
    const state  = stateMap.get(slot);
    const isAuto = slot === AUTO_SAVE_SLOT;
    const card   = await buildSaveSlotCard(
      slot, state, isAuto, container, emulator, saveLibrary, gameId, gameName, systemId
    );
    container.appendChild(card);
  }
}

async function buildSaveSlotCard(
  slot:        number,
  state:       SaveStateEntry | undefined,
  isAuto:      boolean,
  container:   HTMLElement,
  emulator:    PSPEmulator,
  saveLibrary: SaveStateLibrary,
  gameId:      string,
  gameName:    string,
  systemId:    string
): Promise<HTMLElement> {
  const card = make("div", { class: `save-slot-card${state ? " save-slot-card--occupied" : ""}` });

  // Thumbnail area
  const thumb = make("div", { class: "save-slot-card__thumb" });
  if (state?.thumbnail) {
    const img = make("img", { class: "save-slot-card__img", alt: `Slot ${slot} screenshot` }) as HTMLImageElement;
    const url = URL.createObjectURL(state.thumbnail);
    img.src = url;
    img.onload  = () => URL.revokeObjectURL(url);
    img.onerror = () => URL.revokeObjectURL(url);
    thumb.appendChild(img);
  } else {
    const empty = make("div", { class: "save-slot-card__empty" });
    empty.innerHTML = isAuto
      ? `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg><span>Empty</span>`
      : `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg><span>Empty</span>`;
    thumb.appendChild(empty);
  }
  card.appendChild(thumb);

  // Info area
  const info = make("div", { class: "save-slot-card__info" });

  // Slot header (label + edit for manual slots)
  const slotHeader = make("div", { class: "save-slot-card__header" });
  const currentLabel = state?.label || defaultSlotLabel(slot);

  const labelEl = make("span", { class: "save-slot-card__label" }, currentLabel);
  slotHeader.appendChild(labelEl);

  if (!isAuto) {
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
      // Re-render just this card
      const newCard = await buildSaveSlotCard(slot, state ? { ...state, label: newLabel || defaultSlotLabel(slot) } : undefined, isAuto, container, emulator, saveLibrary, gameId, gameName, systemId);
      card.replaceWith(newCard);
    });
    slotHeader.appendChild(btnEdit);
  } else {
    const autoBadge = make("span", { class: "save-slot-card__auto-badge" }, "Auto");
    slotHeader.appendChild(autoBadge);
  }

  info.appendChild(slotHeader);

  if (state) {
    info.appendChild(make("span", { class: "save-slot-card__time" }, formatRelativeTime(state.timestamp)));
  } else {
    info.appendChild(make("span", { class: "save-slot-card__time save-slot-card__time--empty" }, "Empty"));
  }

  // Actions
  const actions = make("div", { class: "save-slot-card__actions" });

  if (!isAuto) {
    const btnSave = make("button", { class: "btn btn--primary save-slot-card__btn", title: `Save to this slot` });
    btnSave.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save`;
    btnSave.addEventListener("click", async () => {
      emulator.quickSave(slot);
      await persistSaveMetadata(emulator, saveLibrary, gameId, gameName, systemId, slot);
      await renderSaveSlots(container, emulator, saveLibrary, gameId, gameName, systemId);
      showInfoToast(`Saved to ${currentLabel}`);
    });
    actions.appendChild(btnSave);
  }

  if (state) {
    const btnLoad = make("button", { class: "btn save-slot-card__btn", title: "Load this save" });
    btnLoad.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Load`;
    btnLoad.addEventListener("click", () => {
      if (state.stateData) {
        state.stateData.arrayBuffer().then(buf => {
          const written = emulator.writeStateData(slot, new Uint8Array(buf));
          if (written) emulator.quickLoad(slot);
          else showError("Could not restore save state — the emulator filesystem is not ready.");
        }).catch(() => emulator.quickLoad(slot));
      } else {
        emulator.quickLoad(slot);
      }
    });
    actions.appendChild(btnLoad);

    if (state.stateData) {
      const btnExport = make("button", { class: "btn save-slot-card__btn", title: "Export .state file", "aria-label": "Export save state" });
      btnExport.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
      btnExport.addEventListener("click", async () => {
        const exported = await saveLibrary.exportState(gameId, slot);
        if (exported) downloadBlob(exported.blob, exported.fileName);
      });
      actions.appendChild(btnExport);
    }

    if (!isAuto) {
      const btnDel = make("button", { class: "btn btn--danger save-slot-card__btn", title: "Delete save" });
      btnDel.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
      btnDel.addEventListener("click", async () => {
        const confirmed = await showConfirmDialog(
          `Delete the save in "${currentLabel}"?`,
          { title: "Delete Save", confirmLabel: "Delete", isDanger: true }
        );
        if (confirmed) {
          await saveLibrary.deleteState(gameId, slot);
          await renderSaveSlots(container, emulator, saveLibrary, gameId, gameName, systemId);
        }
      });
      actions.appendChild(btnDel);
    }
  }

  if (!isAuto) {
    const importInput = make("input", {
      type: "file", accept: ".state,.sav", style: "display:none",
      "aria-label": `Import state to slot ${slot}`,
    }) as HTMLInputElement;

    const btnImport = make("button", { class: "btn save-slot-card__btn", title: "Import .state file" });
    btnImport.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
    btnImport.addEventListener("click", () => importInput.click());
    importInput.addEventListener("change", async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      importInput.value = "";
      try {
        await saveLibrary.importState(gameId, gameName, systemId, slot, file);
        const buf = await file.arrayBuffer();
        emulator.writeStateData(slot, new Uint8Array(buf));
        await renderSaveSlots(container, emulator, saveLibrary, gameId, gameName, systemId);
        showInfoToast(`Imported save to ${currentLabel}`);
      } catch (err) {
        showError(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    actions.append(importInput, btnImport);
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
      document.removeEventListener("keydown", onKey);
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), 200);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
      if (e.key === "Enter")  { e.preventDefault(); close(input.value); }
    };
    btnCancel.addEventListener("click",  () => close(null));
    btnConfirm.addEventListener("click", () => close(input.value));
    overlay.addEventListener("click",    (e) => { if (e.target === overlay) close(null); });
    document.addEventListener("keydown", onKey);
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

let _settingsPanelEscHandler: ((e: KeyboardEvent) => void) | null = null;

export function openSettingsPanel(
  settings:         Settings,
  deviceCaps:       DeviceCapabilities,
  library:          GameLibrary,
  biosLibrary:      BiosLibrary,
  onSettingsChange: (patch: Partial<Settings>) => void,
  emulatorRef?:     import("./emulator.js").PSPEmulator,
  onLaunchGame?:    (file: File, systemId: string, gameId?: string) => Promise<void>,
  saveLibrary?:     SaveStateLibrary,
  netplayManager?:  import("./multiplayer.js").NetplayManager
): void {
  const panel   = document.getElementById("settings-panel")!;
  const content = document.getElementById("settings-content")!;
  const previousFocus = document.activeElement as HTMLElement | null;

  buildSettingsContent(content, settings, deviceCaps, library, biosLibrary, onSettingsChange, emulatorRef, onLaunchGame, saveLibrary, netplayManager);
  panel.hidden = false;

  const close = () => {
    panel.hidden = true;
    if (_settingsPanelEscHandler) {
      document.removeEventListener("keydown", _settingsPanelEscHandler);
      _settingsPanelEscHandler = null;
    }
    previousFocus?.focus();
  };

  // Remove any previously registered Escape handler before attaching a new one.
  if (_settingsPanelEscHandler) {
    document.removeEventListener("keydown", _settingsPanelEscHandler);
  }
  _settingsPanelEscHandler = (e: KeyboardEvent) => { if (e.key !== "Escape") return; close(); };

  document.getElementById("settings-close")!.onclick   = close;
  document.getElementById("settings-backdrop")!.onclick = close;
  document.addEventListener("keydown", _settingsPanelEscHandler);
}

type SettingsTab = "performance" | "display" | "library" | "bios" | "multiplayer" | "debug";

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
  netplayManager?:  import("./multiplayer.js").NetplayManager
): void {
  container.innerHTML = "";

  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: "performance",  label: "Performance" },
    { id: "display",      label: "Display" },
    { id: "library",      label: "Library" },
    { id: "bios",         label: "BIOS" },
    { id: "multiplayer",  label: "Multiplayer" },
    { id: "debug",        label: "Debug" },
  ];

  let activeTab: SettingsTab = "performance";

  // Tab bar
  const tabBar = make("div", { class: "settings-tabs", role: "tablist" });
  // Tab panels container
  const panelsEl = make("div", { class: "settings-panels" });

  const tabBtns: HTMLButtonElement[] = [];
  const panels: HTMLElement[] = [];

  const switchTab = (id: SettingsTab) => {
    activeTab = id;
    tabBtns.forEach((btn, i) => {
      const isActive = tabs[i].id === id;
      btn.setAttribute("aria-selected", String(isActive));
      btn.classList.toggle("settings-tab--active", isActive);
    });
    panels.forEach((panel, i) => {
      panel.hidden = tabs[i].id !== id;
    });
  };

  for (const tab of tabs) {
    const btn = make("button", {
      id: `tab-${tab.id}`,
      class: "settings-tab",
      role: "tab",
      "aria-selected": tab.id === activeTab ? "true" : "false",
      "aria-controls": `tab-panel-${tab.id}`,
    }, tab.label) as HTMLButtonElement;
    btn.addEventListener("click", () => switchTab(tab.id));
    tabBar.appendChild(btn);
    tabBtns.push(btn);

    const panel = make("div", {
      id: `tab-panel-${tab.id}`,
      class: "settings-panel-content",
      role: "tabpanel",
      "aria-labelledby": `tab-${tab.id}`,
    });
    if (tab.id !== activeTab) panel.hidden = true;
    panels.push(panel);
    panelsEl.appendChild(panel);
  }

  container.appendChild(tabBar);
  container.appendChild(panelsEl);

  // Fill tabs
  buildPerfTab(panels[0], settings, deviceCaps, onSettingsChange, emulatorRef);
  buildDisplayTab(panels[1], settings, deviceCaps, onSettingsChange, emulatorRef);
  buildLibraryTab(panels[2], settings, library, saveLibrary, onSettingsChange, onLaunchGame, emulatorRef);
  buildBiosTab(panels[3], biosLibrary);
  buildMultiplayerTab(panels[4], settings, onSettingsChange, netplayManager);
  buildDebugTab(panels[5], deviceCaps, emulatorRef);
}

// ── Performance tab ───────────────────────────────────────────────────────────

function buildPerfTab(
  container:        HTMLElement,
  settings:         Settings,
  deviceCaps:       DeviceCapabilities,
  onSettingsChange: (patch: Partial<Settings>) => void,
  emulatorRef?:     import("./emulator.js").PSPEmulator
): void {
  // Performance mode
  const perfSection = make("div", { class: "settings-section" });
  perfSection.appendChild(make("h4", { class: "settings-section__title" }, "Performance Mode"));
  perfSection.appendChild(make("p", { class: "settings-help" },
    "Controls rendering resolution, frameskip, and GPU settings for demanding systems (PSP, DS, N64, and similar 3D cores)."
  ));

  const modes: Array<{ value: PerformanceMode; label: string; desc: string }> = [
    { value: "auto",        label: "Auto (recommended)", desc: `Detected tier: ${formatTierLabel(deviceCaps.tier)} → ${deviceCaps.isLowSpec || deviceCaps.tier === "medium" ? "Performance" : "Quality"} mode` },
    { value: "performance", label: "Performance",        desc: "1× resolution, auto frameskip, lazy texture caching — best for low-spec devices" },
    { value: "quality",     label: "Quality",            desc: "Higher resolution, texture upscaling, no frameskip" },
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
  deviceSection.appendChild(make("h4", { class: "settings-section__title" }, "Device Info"));

  const capText = formatCapabilitiesSummary(deviceCaps);
  deviceSection.appendChild(make("p", { class: "device-info" }, capText));

  const tierClass = deviceCaps.tier === "low" ? "tier-badge tier-badge--warn" : deviceCaps.tier === "medium" ? "tier-badge tier-badge--mid" : "tier-badge tier-badge--ok";
  deviceSection.appendChild(make("span", { class: tierClass }, `${formatTierLabel(deviceCaps.tier)} tier (GPU score: ${deviceCaps.gpuBenchmarkScore}/100)`));

  const gpuDetails = make("div", { class: "device-info-details" });
  gpuDetails.appendChild(make("p", { class: "device-info" }, `Max texture size: ${deviceCaps.gpuCaps.maxTextureSize}px`));
  if (deviceCaps.gpuCaps.anisotropicFiltering) {
    gpuDetails.appendChild(make("p", { class: "device-info" }, `Anisotropic filtering: ${deviceCaps.gpuCaps.maxAnisotropy}×`));
  }
  gpuDetails.appendChild(make("p", { class: "device-info" }, `Float textures: ${deviceCaps.gpuCaps.floatTextures ? "Yes" : "No"}`));
  gpuDetails.appendChild(make("p", { class: "device-info" }, `Instanced arrays: ${deviceCaps.gpuCaps.instancedArrays ? "Yes" : "No"}`));
  deviceSection.appendChild(gpuDetails);
  deviceSection.appendChild(make("p", { class: "device-info" }, `WebGL 2: ${deviceCaps.gpuCaps.webgl2 ? "✓ Available" : "✗ Not available"}`));
  deviceSection.appendChild(make("p", { class: "device-info" }, `SharedArrayBuffer: ${typeof SharedArrayBuffer !== "undefined" ? "✓ Available (PSP supported)" : "✗ Not available"}`));

  const adapterInfo = emulatorRef?.webgpuAdapterInfo;
  const webgpuStatusText = deviceCaps.webgpuAvailable
    ? adapterInfo?.device ? `✓ Available — ${adapterInfo.device}${adapterInfo.isFallbackAdapter ? " (software fallback)" : ""}` : adapterInfo?.vendor ? `✓ Available — ${adapterInfo.vendor}` : "✓ Available"
    : "✗ Not available (Chrome 113+ required)";
  deviceSection.appendChild(make("p", { class: "device-info" }, `WebGPU: ${webgpuStatusText}`));
  deviceSection.appendChild(make("p", { class: "device-info" }, `AudioWorklet: ${typeof AudioWorkletNode !== "undefined" ? "✓ Available (low-latency audio active)" : "✗ Not available"}`));

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
  overlaySection.appendChild(make("h4", { class: "settings-section__title" }, "Overlays"));

  overlaySection.appendChild(buildToggleRow(
    "Show FPS overlay",
    "Display real-time framerate and performance tier while playing",
    settings.showFPS,
    (v) => {
      onSettingsChange({ showFPS: v });
      showFPSOverlay(v, emulatorRef, settings.showAudioVis);
      emulatorRef?.setFPSMonitorEnabled(v);
    }
  ));

  overlaySection.appendChild(buildToggleRow(
    "Audio visualiser",
    "Show oscilloscope waveform in the FPS overlay (requires FPS overlay to be enabled)",
    settings.showAudioVis,
    (v) => {
      onSettingsChange({ showAudioVis: v });
      if (settings.showFPS) showFPSOverlay(true, emulatorRef, v);
    }
  ));

  // Mobile & PWA section
  const mobileSection = make("div", { class: "settings-section" });
  mobileSection.appendChild(make("h4", { class: "settings-section__title" }, "Mobile & PWA"));

  const installRow = make("div", { class: "pwa-install-row" });
  const buildInstallBtn = () => {
    installRow.innerHTML = "";
    if (!_canInstallPWA?.()) {
      installRow.appendChild(make("p", { class: "settings-help" },
        "To install RetroVault as an app, open this page in Chrome or Edge on Android, then tap the browser menu → \"Add to Home Screen\"."
      ));
      return;
    }
    const btnInstall = make("button", { class: "btn btn--primary pwa-install-btn" }, "📲 Install RetroVault App");
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
    "Virtual gamepad",
    "Show on-screen touch buttons while a game is running (touch devices only). Tap \"🎮 Edit\" in the game header to rearrange button positions.",
    settings.touchControls,
    (v) => onSettingsChange({ touchControls: v })
  ));

  mobileSection.appendChild(buildToggleRow(
    "Haptic feedback",
    "Vibrate briefly on virtual button presses (Android Chrome only; iOS ignores this)",
    settings.hapticFeedback,
    (v) => onSettingsChange({ hapticFeedback: v })
  ));

  mobileSection.appendChild(buildToggleRow(
    "Lock to landscape",
    "Automatically rotate to landscape orientation when a game starts (Android Chrome; iOS Safari does not support orientation locking)",
    settings.orientationLock,
    (v) => onSettingsChange({ orientationLock: v })
  ));

  container.append(overlaySection, mobileSection);

  // WebGPU section — appended last so Overlays and Mobile always appear first
  if (deviceCaps.webgpuAvailable) {
    const gpuSection = make("div", { class: "settings-section" });
    gpuSection.appendChild(make("h4", { class: "settings-section__title" }, "GPU Post-Processing"));
    gpuSection.appendChild(make("p", { class: "settings-help" },
      "Apply real-time GPU post-processing to the emulator output via WebGPU compute shaders."
    ));

    gpuSection.appendChild(buildToggleRow(
      "Use WebGPU (experimental)",
      "Pre-initialises the WebGPU adapter and enables post-processing filters. Falls back silently to WebGL when unsupported.",
      settings.useWebGPU,
      (v) => onSettingsChange({ useWebGPU: v })
    ));

    type FxOption = { value: string; label: string; desc: string };
    const fxOptions: FxOption[] = [
      { value: "none",    label: "Off",     desc: "No post-processing — raw emulator output" },
      { value: "crt",     label: "CRT",     desc: "Scanlines, barrel distortion, phosphor glow, and vignette" },
      { value: "sharpen", label: "Sharpen", desc: "Edge-aware sharpening — crisper pixels for upscaled output" },
      { value: "lcd",     label: "LCD",     desc: "RGB sub-pixel shadow-mask simulating a handheld LCD screen" },
      { value: "bloom",   label: "Bloom",   desc: "Additive glow on bright areas — cinematic light bleed effect" },
      { value: "fxaa",    label: "FXAA",    desc: "Fast approximate anti-aliasing — smooths 3D geometry edges" },
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
  libSection.appendChild(make("h4", { class: "settings-section__title" }, "ROM Library"));

  const statsEl = make("p", { class: "device-info" }, "Calculating…");
  libSection.appendChild(statsEl);
  Promise.all([library.count(), library.totalSize()]).then(([count, total]) => {
    statsEl.textContent = `${count} game${count !== 1 ? "s" : ""} · ${formatBytes(total)} stored locally`;
  }).catch(() => { statsEl.textContent = "Could not load library stats."; });

  const btnClear = make("button", { class: "btn btn--danger settings-clear-btn" }, "Clear Library");
  btnClear.addEventListener("click", async () => {
    const confirmed = await showConfirmDialog(
      "This will delete all stored ROM data and cannot be undone.",
      { title: "Clear Library?", confirmLabel: "Clear All", isDanger: true }
    );
    if (!confirmed) return;
    await library.clearAll();
    document.getElementById("settings-panel")!.hidden = true;
    document.title = "RetroVault";
    if (onLaunchGame) void renderLibrary(library, settings, onLaunchGame, emulatorRef);
  });
  libSection.appendChild(btnClear);
  container.appendChild(libSection);

  // Save states
  if (saveLibrary) {
    const saveSection = make("div", { class: "settings-section" });
    saveSection.appendChild(make("h4", { class: "settings-section__title" }, "Save States"));

    const saveStatsEl = make("p", { class: "device-info" }, "Calculating…");
    saveSection.appendChild(saveStatsEl);
    saveLibrary.count().then((count) => {
      saveStatsEl.textContent = `${count} save state${count !== 1 ? "s" : ""} stored locally`;
    }).catch(() => { saveStatsEl.textContent = "Could not load save stats."; });

    saveSection.appendChild(buildToggleRow(
      "Auto-save on tab close",
      "Automatically save progress when the tab is hidden or closed, preventing loss from accidental closure",
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
  biosSection.appendChild(make("h4", { class: "settings-section__title" }, "BIOS Files"));
  biosSection.appendChild(make("p", { class: "settings-help" },
    "Some systems (Saturn, Dreamcast, PS1) require BIOS files to run games. Upload your legally obtained BIOS files below."
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
      const label         = make("span", { class: "bios-label" }, req.displayName);
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
          await biosLibrary.addBios(file, sysId);
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

      row.append(statusDot, uploadInput, label, requiredBadge, desc, uploadBtn);
      sysBlock.appendChild(row);
    }
    biosGrid.appendChild(sysBlock);
  }

  container.appendChild(biosSection);
}

// ── Multiplayer tab ───────────────────────────────────────────────────────────

function buildMultiplayerTab(
  container:        HTMLElement,
  settings:         Settings,
  onSettingsChange: (patch: Partial<Settings>) => void,
  netplayManager?:  import("./multiplayer.js").NetplayManager
): void {
  // Intro section
  const introSection = make("div", { class: "settings-section" });
  introSection.appendChild(make("h4", { class: "settings-section__title" }, "Netplay (Experimental)"));
  introSection.appendChild(make("p", { class: "settings-help" },
    "Enables the built-in EmulatorJS Netplay feature. When active, a Netplay button appears " +
    "in the emulator toolbar, letting you create or join rooms with other players for the same game. " +
    "Requires a compatible netplay signalling server."
  ));

  // Enable toggle
  introSection.appendChild(buildToggleRow(
    "Enable Netplay",
    "Show the Netplay button in the emulator toolbar. Requires a server URL below.",
    settings.netplayEnabled,
    (v) => {
      onSettingsChange({ netplayEnabled: v });
      netplayManager?.setEnabled(v);
      serverSection.hidden = !v;
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
    type:        "text",
    id:          "netplay-server-url",
    class:       "settings-input",
    placeholder: "wss://netplay.example.com",
    value:       settings.netplayServerUrl,
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
  });
  urlRow.append(urlLabel, urlInput);
  serverSection.appendChild(urlRow);

  // ICE / STUN section
  const iceSection = make("div", { class: "settings-section" });
  iceSection.appendChild(make("h4", { class: "settings-section__title" }, "ICE / STUN Servers"));
  iceSection.appendChild(make("p", { class: "settings-help" },
    "Google STUN servers are used by default for WebRTC hole-punching. " +
    "For networks with strict symmetric NAT, add a TURN server (e.g. turn:turn.example.com:3478)."
  ));

  // Mutable local copy — kept in sync with NetplayManager on every change
  let iceServers: RTCIceServer[] = [...(netplayManager?.iceServers ?? DEFAULT_ICE_SERVERS)];

  // List of current entries, rebuilt on every mutation
  const iceList = make("div", { class: "netplay-ice-list" });
  const renderIceList = () => {
    iceList.innerHTML = "";
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
      iceList.appendChild(row);
    }
  };
  renderIceList();
  iceSection.appendChild(iceList);

  // Add-server row
  const addRow = make("div", { class: "settings-input-row" });
  const addInput = make("input", {
    type:        "text",
    class:       "settings-input",
    placeholder: "stun:stun.example.com:3478",
    "aria-label": "New ICE server URL",
  }) as HTMLInputElement;
  const addBtn = make("button", { class: "btn btn--primary" }, "Add") as HTMLButtonElement;
  addBtn.addEventListener("click", () => {
    const url = addInput.value.trim();
    if (!url) return;
    if (!/^(stun|turn|turns):/i.test(url)) {
      addInput.setCustomValidity("URL must start with stun:, turn:, or turns:");
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
  iceSection.appendChild(addRow);

  // Reset-to-defaults button
  const resetBtn = make("button", { class: "btn settings-clear-btn" }, "Reset to defaults") as HTMLButtonElement;
  resetBtn.addEventListener("click", () => {
    netplayManager?.resetIceServers();
    iceServers = [...DEFAULT_ICE_SERVERS];
    renderIceList();
  });
  iceSection.appendChild(resetBtn);

  serverSection.appendChild(iceSection);

  container.append(serverSection);
}

// ── Debug tab ─────────────────────────────────────────────────────────────────

function buildDebugTab(
  container:  HTMLElement,
  deviceCaps: DeviceCapabilities,
  emulatorRef?: import("./emulator.js").PSPEmulator
): void {
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
      `Low-Spec: ${deviceCaps.isLowSpec}`,
      `ChromeOS: ${deviceCaps.isChromOS}`,
      `WebGL2: ${deviceCaps.gpuCaps.webgl2}`,
      `WebGPU: ${deviceCaps.webgpuAvailable}`,
      `Max Texture: ${deviceCaps.gpuCaps.maxTextureSize}px`,
      `Anisotropic: ${deviceCaps.gpuCaps.anisotropicFiltering} (max ${deviceCaps.gpuCaps.maxAnisotropy}×)`,
      `Float Textures: ${deviceCaps.gpuCaps.floatTextures}`,
      `Instanced Arrays: ${deviceCaps.gpuCaps.instancedArrays}`,
      ``,
      `[Emulator]`,
      `State: ${emulatorRef?.state ?? "unknown"}`,
      `System: ${emulatorRef?.currentSystem?.id ?? "—"}`,
      `Tier: ${emulatorRef?.activeTier ?? "—"}`,
    ];
    if (adapterLabel) {
      lines.push(`WebGPU Adapter: ${adapterLabel}`);
    }

    navigator.clipboard.writeText(lines.join("\n")).then(() => {
      showInfoToast("Debug info copied to clipboard.");
    }).catch(() => {
      showError("Could not copy to clipboard.");
    });
  });
  actionsSection.appendChild(btnCopy);

  container.append(envSection, stateSection, actionsSection);
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
      document.removeEventListener("keydown", onKey);
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), 200);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(null); } };
    btnCancel.addEventListener("click",  () => close(null));
    btnConfirm.addEventListener("click", () => close(fileMap));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
    document.addEventListener("keydown", onKey);
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
      const magnitude = this._buffer[i * step] / 255;
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

  const toast = make("div", { id: "perf-suggestion", class: "perf-suggestion", role: "status" });
  toast.innerHTML =
    `<span class="perf-suggestion__msg">Low FPS detected — try <strong>Performance mode</strong> in Settings for a smoother experience.</span>` +
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
  const labels: Record<EmulatorState, string> = { idle: "Idle", loading: "Loading", running: "Running", paused: "Paused", error: "Error" };
  dot.className     = `status-dot ${state}`;
  label.textContent = labels[state];
  if (state === "loading") showLoadingOverlay();
  if (state === "idle" || state === "error") { setStatusGame("—"); setStatusSystem("—"); setStatusTier(null); }
}

// ── Visibility helpers ────────────────────────────────────────────────────────

export function hideLanding(): void    { el("#landing").classList.add("hidden"); }
export function showLanding(): void    { el("#landing").classList.remove("hidden"); }
export function showLoadingOverlay(): void { document.getElementById("loading-overlay")?.classList.add("visible"); }
export function hideLoadingOverlay(): void { document.getElementById("loading-overlay")?.classList.remove("visible"); }
export function showEjsContainer(): void  { document.getElementById("ejs-container")?.classList.add("visible"); }
export function hideEjsContainer(): void  { document.getElementById("ejs-container")?.classList.remove("visible"); }
export function setLoadingMessage(msg: string): void { const e = document.getElementById("loading-message"); if (e) e.textContent = msg; }
export function setStatusGame(name: string): void    { const e = document.getElementById("status-game");    if (e) e.textContent = name; }
export function setStatusSystem(name: string): void  { const e = document.getElementById("status-system");  if (e) e.textContent = name; }
function setStatusTier(tier: PerformanceTier | null): void { const e = document.getElementById("status-tier"); if (e) e.textContent = tier ? formatTierLabel(tier) : "—"; }

let _errorDismissTimer: ReturnType<typeof setTimeout> | null = null;

export function showError(msg: string): void {
  const banner = document.getElementById("error-banner");
  const msgEl  = document.getElementById("error-message");
  if (!banner || !msgEl) return;
  msgEl.textContent = "";
  // Render newlines as <br> so multi-paragraph error messages display correctly
  const lines = msg.split("\n");
  lines.forEach((line, i) => {
    if (i > 0) msgEl.appendChild(document.createElement("br"));
    msgEl.appendChild(document.createTextNode(line));
  });
  banner.classList.add("visible");
  if (_errorDismissTimer !== null) clearTimeout(_errorDismissTimer);
  _errorDismissTimer = setTimeout(() => { hideError(); _errorDismissTimer = null; }, 8000);
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
  toast.textContent = msg;

  const closeBtn = document.createElement("button");
  closeBtn.className = "error-close";
  closeBtn.textContent = "✕";
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.addEventListener("click", () => { toast.classList.remove("visible"); setTimeout(() => toast.remove(), 200); });
  toast.appendChild(closeBtn);
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add("visible"));
  setTimeout(() => { toast.classList.remove("visible"); setTimeout(() => toast.remove(), 200); }, 5000);
}
