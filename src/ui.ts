/**
 * ui.ts — Build and wire the full application UI
 *
 * Views:
 *   landing    — game library grid + "Add Game" drop zone (shown on startup)
 *   emulator   — EmulatorJS fills the screen (shown while a game runs)
 *
 * Panels (overlays over the current view):
 *   settings   — performance mode, device info, library stats
 *   systemPicker — shown when a file extension maps to multiple systems
 *   loading    — spinner during emulator boot
 *   error      — dismissible error banner
 *
 * FPS overlay:
 *   Shown in-game when settings.showFPS is true. Displays current / average
 *   FPS, performance tier, and dropped-frame count.
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
  saveStateKey,
  createThumbnail,
  downloadBlob,
} from "./saves.js";
import type { Settings } from "./main.js";
import type { TouchControlsOverlay } from "./touchControls.js";

// ── PWA install callbacks (set once from initUI) ───────────────────────────────
// Stored at module level to avoid threading through many function signatures.
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

/** Render the full page shell into `#app`. Called once on startup. */
export function buildDOM(app: HTMLElement): void {
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
          <div class="library-header">
            <h2 class="library-title">My Library</h2>
            <span class="library-count" id="library-count"></span>
          </div>
          <div class="library-grid" id="library-grid">
            <!-- Cards populated by renderLibrary() -->
          </div>
        </div>

        <!-- Drop zone (always active for drag-and-drop) -->
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
  settings:          Settings;
  deviceCaps:        DeviceCapabilities;
  onLaunchGame:      (file: File, systemId: string, gameId?: string) => Promise<void>;
  onSettingsChange:  (patch: Partial<Settings>) => void;
  onReturnToLibrary: () => void;
  onApplyPatch:      (gameId: string, patchFile: File) => Promise<void>;
  onFileChosen:      (file: File) => Promise<void>;
  /** Current game tracking — needed for save gallery access */
  getCurrentGameId:   () => string | null;
  getCurrentGameName: () => string | null;
  getCurrentSystemId: () => string | null;
  /** Access the active touch controls overlay (may be null). */
  getTouchOverlay?:   () => TouchControlsOverlay | null;
  /** Returns true when the PWA install prompt is available. */
  canInstallPWA?:     () => boolean;
  /** Trigger the browser's "Add to Home Screen" dialog. */
  onInstallPWA?:      () => Promise<boolean>;
}

/** Wire all DOM events, emulator callbacks, and render the initial library. */
export function initUI(opts: UIOptions): void {
  const { emulator, library, biosLibrary, saveLibrary, settings, deviceCaps,
          onLaunchGame, onSettingsChange, onReturnToLibrary,
          onApplyPatch, onFileChosen,
          getCurrentGameId, getCurrentGameName, getCurrentSystemId,
          getTouchOverlay, canInstallPWA, onInstallPWA } = opts;

  // Register PWA install callbacks for use in the settings panel
  _canInstallPWA = canInstallPWA;
  _onInstallPWA  = onInstallPWA;

  // ── File drop / pick ──────────────────────────────────────────────────────
  const fileInput = el<HTMLInputElement>("#file-input");
  const dropZone  = el("#drop-zone");
  let dragDepth = 0;

  const handleFileChosen = (file: File) => {
    onFileChosen(file);
  };

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) handleFileChosen(file);
    fileInput.value = ""; // reset so the same file can be re-picked
  });

  // Keyboard accessibility for the drop zone shell.
  dropZone.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    fileInput.click();
  });

  // Global drag-and-drop (whole page)
  document.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });
  document.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth += 1;
    dropZone.classList.add("drag-over");
  });
  document.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth > 0) return;
    dropZone.classList.remove("drag-over");
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropZone.classList.remove("drag-over");
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    if (emulator.state === "running") {
      showError("Return to the library first (Esc or ← Library) before loading a new game.");
      return;
    }
    handleFileChosen(file);
  });

  // ── Error banner ──────────────────────────────────────────────────────────
  el("#error-close").addEventListener("click", hideError);

  // ── FPS overlay wiring ────────────────────────────────────────────────────
  // Only enable FPS callbacks when the overlay is visible — reduces rAF work
  // on low-spec devices (Chromebooks) when the user isn't watching the overlay.
  emulator.setFPSMonitorEnabled(settings.showFPS);
  emulator.onFPSUpdate = (snapshot) => {
    updateFPSOverlay(snapshot, emulator);
  };

  // ── Emulator lifecycle → DOM ──────────────────────────────────────────────
  emulator.onStateChange = (state) => updateStatusDot(state);
  emulator.onProgress    = (msg)   => setLoadingMessage(msg);
  emulator.onError       = (msg)   => {
    hideLoadingOverlay();
    showError(msg);
  };
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
    // Show touch controls overlay after DOM settles
    if (settings.touchControls) {
      const overlay = getTouchOverlay?.();
      if (overlay) requestAnimationFrame(() => overlay.show());
    }
    document.dispatchEvent(new CustomEvent("retrovault:gameStarted"));
  };

  // ── Resume game (triggered by "▶ Resume" button via retrovault:resumeGame) ─
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

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  document.addEventListener("keydown", (e) => {
    if (emulator.state !== "running") return;
    switch (e.key) {
      case "F5":  e.preventDefault(); emulator.quickSave(1);   break;
      case "F7":  e.preventDefault(); emulator.quickLoad(1);   break;
      case "F1":  e.preventDefault(); emulator.reset();        break;
      case "Escape": onReturnToLibrary();                       break;
    }
  });

  // ── Patch file drop on game cards (delegate) ─────────────────────────────
  // Handled via #library-grid data-game-id and the patcher flow in main.ts

  // ── Landing header controls ───────────────────────────────────────────────
  buildLandingControls(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulator, onLaunchGame, undefined, saveLibrary);

  // ── Keep overflow indicator current on resize ─────────────────────────────
  if (typeof ResizeObserver !== "undefined") {
    const headerActions = document.getElementById("header-actions");
    if (headerActions) {
      new ResizeObserver(updateHeaderOverflow).observe(headerActions);
    }
  }

  // ── Initial library render ────────────────────────────────────────────────
  renderLibrary(library, settings, onLaunchGame, emulator, onApplyPatch);
}

// ── Library rendering ─────────────────────────────────────────────────────────

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

  let games: GameMetadata[];
  try {
    games = await library.getAllGamesMetadata();
  } catch {
    games = [];
  }

  countEl.textContent = games.length > 0 ? `${games.length} game${games.length !== 1 ? "s" : ""}` : "";

  libSection.classList.toggle("hidden-section", games.length === 0);
  dropZoneEl.classList.toggle("drop-zone--prominent", games.length === 0);
  dropZoneEl.classList.toggle("drop-zone--compact", games.length > 0);

  // Eagerly prefetch cores for 3D systems the user has games for.
  // This starts downloading the large WASM cores (~10–30 MB) in the
  // background so they're ready when the user clicks "Play".
  if (emulatorRef && games.length > 0) {
    const systemIds = new Set(games.map(g => g.systemId));
    for (const sid of systemIds) {
      emulatorRef.prefetchCore(sid);
    }
  }

  grid.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const game of games) {
    fragment.appendChild(buildGameCard(game, library, settings, onLaunchGame, emulatorRef, onApplyPatch));
  }
  grid.appendChild(fragment);
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
    renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
  });

  // Patch button — hidden input triggered on click
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

  btnPatch.addEventListener("click", (e) => {
    e.stopPropagation();
    patchInput.click();
  });

  patchInput.addEventListener("change", async () => {
    const patchFile = patchInput.files?.[0];
    if (!patchFile || !onApplyPatch) return;
    patchInput.value = "";
    try {
      showLoadingOverlay();
      setLoadingMessage(`Applying patch to ${game.name}…`);
      await onApplyPatch(game.id, patchFile);
      hideLoadingOverlay();
      renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    } catch (err) {
      hideLoadingOverlay();
      showError(`Patch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  const playOverlay = make("div", { class: "game-card__play-overlay", "aria-hidden": "true" });
  const playBtn     = make("div", { class: "game-card__play-btn" }, "▶");
  playOverlay.appendChild(playBtn);

  card.append(icon, info, patchInput, btnPatch, btnRemove, playOverlay);

  // Preload blob on hover/focus for instant launch.
  // Also prefetch the WASM core for this system's emulator.
  let preloadTriggered = false;
  const triggerPreload = () => {
    if (preloadTriggered) return;
    preloadTriggered = true;
    library.preloadGame(game.id);
    if (emulatorRef) {
      emulatorRef.prefetchCore(game.systemId);
    }
  };
  card.addEventListener("mouseenter", triggerPreload);
  card.addEventListener("focusin", triggerPreload);

  // Launch using blob-direct path — avoids the expensive new File([blob]) copy.
  // game.fileName and game.systemId come from GameMetadata so no second IDB read needed.
  const launch = async () => {
    showLoadingOverlay();
    setLoadingMessage(`Loading ${game.name}…`);
    try {
      const blob = await library.getGameBlob(game.id);
      if (!blob) {
        hideLoadingOverlay();
        showError(`Game "${game.name}" not found in library.`);
        return;
      }

      const file = new File([blob], game.fileName, { type: blob.type });
      await library.markPlayed(game.id);
      await onLaunchGame(file, game.systemId, game.id);
    } catch (err) {
      hideLoadingOverlay();
      showError(`Failed to load game: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  card.addEventListener("click", launch);
  card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); launch(); } });

  return card;
}

/** System emoji/icon for game cards. */
function systemIcon(systemId: string): string {
  const icons: Record<string, string> = {
    psp:        "🎮",
    nes:        "🕹",
    snes:       "🕹",
    gba:        "🎯",
    gbc:        "🟢",
    gb:         "⬜",
    nds:        "📱",
    n64:        "🎮",
    psx:        "🔵",
    segaMD:     "⚡",
    segaGG:     "🔶",
    segaMS:     "📺",
    atari2600:  "👾",
    arcade:     "🕹",
    segaSaturn: "💫",
    segaDC:     "🌀",
    mame2003:   "🕹",
    atari7800:  "👾",
    lynx:       "📟",
    ngp:        "🔴",
  };
  return icons[systemId] ?? "🎮";
}

// ── Volume helpers ────────────────────────────────────────────────────────────

/** Return the appropriate speaker emoji for a given volume level. */
function volIcon(volume: number): string {
  if (volume === 0) return "🔇";
  if (volume < 0.5) return "🔉";
  return "🔊";
}

// ── Custom confirm dialog ─────────────────────────────────────────────────────

/**
 * Custom confirm dialog — replaces the browser's native `confirm()`.
 * Returns a Promise that resolves to true (confirmed) or false (cancelled).
 * Unlike native confirm(), this is non-blocking and styled consistently,
 * and works correctly in PWA standalone mode (where confirm() may be suppressed).
 */
function showConfirmDialog(
  message: string,
  opts: { title?: string; confirmLabel?: string; isDanger?: boolean } = {}
): Promise<boolean> {
  const { title, confirmLabel = "Confirm", isDanger = false } = opts;
  return new Promise((resolve) => {
    const overlay = make("div", { class: "confirm-overlay" });
    const box     = make("div", {
      class: "confirm-box",
      role: "dialog",
      "aria-modal": "true",
    });
    if (title) box.setAttribute("aria-label", title);

    if (title) {
      box.appendChild(make("h3", { class: "confirm-title" }, title));
    }
    box.appendChild(make("p", { class: "confirm-body" }, message));

    const footer     = make("div", { class: "confirm-footer" });
    const btnCancel  = make("button", { class: "btn" }, "Cancel");
    const btnConfirm = make("button", {
      class: isDanger ? "btn btn--danger-filled" : "btn btn--primary",
    }, confirmLabel);
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

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
    };

    btnCancel.addEventListener("click",  () => close(false));
    btnConfirm.addEventListener("click", () => close(true));
    overlay.addEventListener("click",    (e) => { if (e.target === overlay) close(false); });
    document.addEventListener("keydown", onKey);

    requestAnimationFrame(() => {
      overlay.classList.add("confirm-overlay--visible");
      btnConfirm.focus();
    });
  });
}

// ── System picker modal ───────────────────────────────────────────────────────

/**
 * Show the system picker when a file extension is ambiguous.
 * Resolves with the chosen system or null if dismissed.
 */
function pickSystem(
  fileName:   string,
  candidates: SystemInfo[]
): Promise<SystemInfo | null> {
  return new Promise((resolve) => {
    const panel    = document.getElementById("system-picker")!;
    const list     = document.getElementById("system-picker-list")!;
    const subtitle = document.getElementById("system-picker-subtitle")!;
    const closeBtn = document.getElementById("system-picker-close")!;
    const backdrop = document.getElementById("system-picker-backdrop")!;

    subtitle.textContent =
      `The file "${fileName}" could belong to several systems. Choose one:`;

    list.innerHTML = "";
    for (const sys of candidates) {
      const btn = make("button", { class: "system-pick-btn" });
      const badge = make("span", { class: "sys-badge" }, sys.shortName);
      badge.style.background = sys.color;
      btn.append(badge, document.createTextNode(sys.name));
      btn.addEventListener("click", () => { close(sys); });
      list.appendChild(btn);
    }

    panel.hidden = false;

    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close(null);
    };

    const close = (result: SystemInfo | null) => {
      document.removeEventListener("keydown", onEsc);
      panel.hidden = true;
      resolve(result);
    };

    const onClose = () => close(null);
    closeBtn.addEventListener("click",   onClose, { once: true });
    backdrop.addEventListener("click",   onClose, { once: true });
    document.addEventListener("keydown", onEsc);
  });
}

// ── Resolve system then add to library and launch ─────────────────────────────

// Patch-file extensions — inlined to avoid importing patcher.ts eagerly
const PATCH_EXT_SET = new Set(["ips", "bps", "ups"]);
// Archive extensions — inlined to avoid importing archive.ts eagerly
const ARCHIVE_EXT_SET = new Set(["zip", "7z"]);

export async function resolveSystemAndAdd(
  file:          File,
  library:       GameLibrary,
  settings:      Settings,
  onLaunchGame:  (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef?:  PSPEmulator,
  onApplyPatch?: (gameId: string, patchFile: File) => Promise<void>
): Promise<void> {
  // ── Patch file detection ─────────────────────────────────────────────────
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (PATCH_EXT_SET.has(ext)) {
    await handlePatchFileDrop(file, library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    return;
  }

  // ── Archive extraction (lazily loaded — not in initial JS bundle) ────────
  let resolvedFile = file;

  if (ARCHIVE_EXT_SET.has(ext)) {
    const { detectArchiveFormat, extractFromZip } = await import("./archive.js");
    const fmt = await detectArchiveFormat(file);
    if (fmt === "zip") {
      showLoadingOverlay();
      setLoadingMessage("Extracting archive…");
      try {
        const extracted = await extractFromZip(file);
        if (!extracted) {
          hideLoadingOverlay();
          showError("Could not find a ROM file inside the ZIP archive.");
          return;
        }
        resolvedFile = new File([extracted.blob], extracted.name, { type: extracted.blob.type });
        setLoadingMessage("Archive extracted. Adding to library…");
      } catch (err) {
        hideLoadingOverlay();
        showError(`Archive extraction failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    } else if (fmt === "7z") {
      showError(
        "7-Zip (.7z) files cannot be extracted automatically.\n" +
        "Please extract the ROM manually and drop the extracted file."
      );
      return;
    }
  }

  const detected = detectSystem(resolvedFile.name);

  let system: SystemInfo | null = null;

  if (detected === null) {
    hideLoadingOverlay();
    showError(
      `Unrecognised file type: "${resolvedFile.name}".\n` +
      `Supported extensions: ${ALL_EXTENSIONS.map(e => `.${e}`).join("  ·  ")}`
    );
    return;
  } else if (Array.isArray(detected)) {
    hideLoadingOverlay();
    system = await pickSystem(resolvedFile.name, detected);
    if (!system) return; // user cancelled
  } else {
    system = detected;
  }

  // ── Multi-disc .m3u handling ─────────────────────────────────────────────
  if (resolvedFile.name.toLowerCase().endsWith(".m3u")) {
    await handleM3UFile(resolvedFile, system, library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    return;
  }

  // ── Duplicate detection ──────────────────────────────────────────────────
  try {
    const existing = await library.findByFileName(resolvedFile.name, system.id);
    if (existing) {
      const playExisting = await showConfirmDialog(
        `"${existing.name}" is already in your library.`,
        { title: "Already in Library", confirmLabel: "Play Existing" }
      );
      if (!playExisting) return;

      showLoadingOverlay();
      setLoadingMessage(`Loading ${existing.name}…`);
      try {
        const existingFile = new File([existing.blob], existing.fileName, { type: existing.blob.type });
        await library.markPlayed(existing.id);
        await onLaunchGame(existingFile, existing.systemId, existing.id);
      } catch (err) {
        hideLoadingOverlay();
        showError(`Could not load game: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
  } catch {
    // duplicate check failed — fall through
  }

  showLoadingOverlay();
  setLoadingMessage("Adding game to library…");

  try {
    const entry = await library.addGame(resolvedFile, system.id);
    settings.lastGameName = entry.name;
    renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    await onLaunchGame(resolvedFile, system.id, entry.id);
  } catch (err) {
    hideLoadingOverlay();
    showError(`Could not add game: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Patch file drop handler ───────────────────────────────────────────────────

async function handlePatchFileDrop(
  patchFile:     File,
  library:       GameLibrary,
  settings:      Settings,
  onLaunchGame:  (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef?:  PSPEmulator,
  onApplyPatch?: (gameId: string, patchFile: File) => Promise<void>
): Promise<void> {
  if (!onApplyPatch) {
    showError("Patch application is not available.");
    return;
  }

  let games: GameMetadata[];
  try {
    games = await library.getAllGamesMetadata();
  } catch {
    games = [];
  }

  if (games.length === 0) {
    showError("Your library is empty. Add a game before applying a patch.");
    return;
  }

  // Build a picker dialog listing library games
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
    renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
  } catch (err) {
    hideLoadingOverlay();
    showError(`Patch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Simple game picker dialog ─────────────────────────────────────────────────

function showGamePickerDialog(
  title:   string,
  message: string,
  games:   GameMetadata[]
): Promise<GameMetadata | null> {
  return new Promise((resolve) => {
    const overlay = make("div", { class: "confirm-overlay" });
    const box     = make("div", {
      class:      "confirm-box",
      role:       "dialog",
      "aria-modal": "true",
      "aria-label": title,
    });

    box.appendChild(make("h3", { class: "confirm-title" }, title));
    box.appendChild(make("p",  { class: "confirm-body"  }, message));

    const list = make("div", { class: "game-picker-list" });
    for (const game of games) {
      const sys = getSystemById(game.systemId);
      const btn = make("button", { class: "game-picker-btn" });
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

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
    };

    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => overlay.classList.add("confirm-overlay--visible"));
  });
}

// ── Multi-disc .m3u handler ───────────────────────────────────────────────────

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
  try {
    m3uText = await m3uFile.text();
  } catch {
    showError("Could not read the .m3u file.");
    return;
  }

  const discFileNames = parseM3U(m3uText);
  if (discFileNames.length === 0) {
    showError("The .m3u file is empty or contains no disc entries.");
    return;
  }

  // Check whether all disc blobs are already stored in the library
  const storedDiscs = new Map<string, { id: string; blob: Blob }>();
  for (const fn of discFileNames) {
    try {
      const entry = await library.findByFileName(fn, system.id);
      if (entry) storedDiscs.set(fn, { id: entry.id, blob: entry.blob });
    } catch { /* ignore */ }
  }

  let discFiles: Map<string, File>;
  const missingDiscs = discFileNames.filter(fn => !storedDiscs.has(fn));

  if (missingDiscs.length > 0) {
    // Ask the user to supply missing disc files
    const userPicked = await showMultiDiscPicker(missingDiscs);
    if (!userPicked) return;

    showLoadingOverlay();
    setLoadingMessage("Storing disc images…");

    // Store each provided disc in the library
    for (const [fn, f] of userPicked) {
      try {
        const entry = await library.addGame(f, system.id);
        storedDiscs.set(fn, { id: entry.id, blob: f });
      } catch { /* ignore */ }
    }

    discFiles = userPicked;
  } else {
    discFiles = new Map();
    for (const [fn, { blob }] of storedDiscs) {
      discFiles.set(fn, new File([blob], fn));
    }
    showLoadingOverlay();
    setLoadingMessage("Preparing multi-disc game…");
  }

  // Build a synthetic .m3u with blob URLs for each disc
  const blobUrls: string[] = [];
  const syntheticLines: string[] = [];
  for (const fn of discFileNames) {
    const discFile = discFiles.get(fn) ?? (storedDiscs.get(fn) ? new File([storedDiscs.get(fn)!.blob], fn) : null);
    if (!discFile) {
      hideLoadingOverlay();
      showError(`Disc file not found: "${fn}"`);
      return;
    }
    const url = URL.createObjectURL(discFile);
    blobUrls.push(url);
    syntheticLines.push(url);
  }

  const syntheticM3U = new Blob([syntheticLines.join("\n")], { type: "text/plain" });
  const syntheticFile = new File([syntheticM3U], m3uFile.name, { type: "text/plain" });

  // Store/update the .m3u itself in the library
  const gameName = m3uFile.name.replace(/\.[^.]+$/, "");
  settings.lastGameName = gameName;

  try {
    const existing = await library.findByFileName(m3uFile.name, system.id);
    if (!existing) {
      await library.addGame(m3uFile, system.id);
      renderLibrary(library, settings, onLaunchGame, emulatorRef, onApplyPatch);
    }
  } catch { /* ignore */ }

  // Launch — blob URLs remain valid for the emulator's disc-swap lifetime.
  // They are revoked on error; on success the page lifetime manages them.
  try {
    await onLaunchGame(syntheticFile, system.id);
  } catch (err) {
    hideLoadingOverlay();
    showError(`Multi-disc launch failed: ${err instanceof Error ? err.message : String(err)}`);
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
  saveLibrary?:     SaveStateLibrary
): void {
  const container = el("#header-actions");
  container.innerHTML = "";

  // Resume button — only present when returning from a paused game
  if (onResumeGame) {
    const btnResume = make("button", { class: "btn btn--primary", title: "Return to the paused game" }, "▶ Resume");
    btnResume.addEventListener("click", onResumeGame);
    container.appendChild(btnResume);
  }

  // Low-spec / Chromebook indicator
  if (deviceCaps.isLowSpec || deviceCaps.isChromOS) {
    const label = deviceCaps.isChromOS ? "⚡ Chromebook" : "⚡ Low-spec";
    const tip   = deviceCaps.isChromOS
      ? "Chromebook detected — Performance mode recommended"
      : "Performance mode recommended for this device";
    const chip = make("span", { class: "perf-chip perf-chip--warn", title: tip }, label);
    container.appendChild(chip);
  }

  const btnSettings = make("button", { class: "btn", title: "Settings", "aria-label": "Open settings" });
  btnSettings.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65
             0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9
             19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0
             0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65
             1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65
             1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0
             1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0
             0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg> Settings`;

  btnSettings.addEventListener("click", () => {
    openSettingsPanel(settings, deviceCaps, library, biosLibrary, onSettingsChange, emulatorRef, onLaunchGame, saveLibrary);
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

  const btnLibrary = make("button", { class: "btn", title: "Back to library (Esc)" }, "← Library");
  btnLibrary.addEventListener("click", onReturnToLibrary);

  const btnSave = make("button", { class: "btn", title: "Quick Save (F5)" }, "💾 Save");
  btnSave.addEventListener("click", async () => {
    emulator.quickSave(1);
    if (saveLibrary && getCurrentGameId?.() && getCurrentGameName?.() && getCurrentSystemId?.()) {
      await persistSaveMetadata(emulator, saveLibrary, getCurrentGameId()!, getCurrentGameName()!, getCurrentSystemId()!, 1);
    }
  });

  const btnLoad = make("button", { class: "btn", title: "Quick Load (F7)" }, "📂 Load");
  btnLoad.addEventListener("click", () => emulator.quickLoad(1));

  // Save gallery button
  const btnSaves = make("button", { class: "btn", title: "Save state gallery" }, "🗂 Saves");
  btnSaves.addEventListener("click", () => {
    if (saveLibrary && getCurrentGameId?.() && getCurrentGameName?.() && getCurrentSystemId?.()) {
      openSaveGallery(
        emulator, saveLibrary,
        getCurrentGameId()!, getCurrentGameName()!, getCurrentSystemId()!
      );
    }
  });

  const btnReset = make("button", { class: "btn btn--danger", title: "Reset game (F1)" }, "↺ Reset");
  btnReset.addEventListener("click", async () => {
    const confirmed = await showConfirmDialog(
      "Unsaved progress will be lost.",
      { title: "Reset Game?", confirmLabel: "Reset", isDanger: true }
    );
    if (confirmed) emulator.reset();
  });

  // FPS toggle button
  const btnFPS = make("button", {
    class: settings.showFPS ? "btn btn--active" : "btn",
    title: "Toggle FPS overlay",
  }, "FPS");
  btnFPS.addEventListener("click", () => {
    settings.showFPS = !settings.showFPS;
    onSettingsChange({ showFPS: settings.showFPS });
    btnFPS.className = settings.showFPS ? "btn btn--active" : "btn";
    showFPSOverlay(settings.showFPS, emulator, settings.showAudioVis);
    emulator.setFPSMonitorEnabled(settings.showFPS);
  });

  // Touch controls edit button (touch devices only)
  const overlay = getTouchOverlay?.();
  let btnTouch: HTMLButtonElement | null = null;
  if (overlay) {
    btnTouch = make("button", {
      class: "btn",
      title: "Edit touch control layout",
    }, "🎮 Edit") as HTMLButtonElement;

    let editMode = false;
    btnTouch.addEventListener("click", () => {
      editMode = !editMode;
      overlay.setEditing(editMode);
      btnTouch!.className = editMode ? "btn btn--active" : "btn";
      btnTouch!.textContent = editMode ? "✓ Done" : "🎮 Edit";
    });
  }

  // Volume control
  let preMuteVolume = settings.volume > 0 ? settings.volume : 0.7;

  const volWrap = make("div", { class: "btn vol-control" });

  const volBtn = make("button", {
    class: "vol-mute-btn",
    title: "Toggle mute",
    "aria-label": "Toggle mute",
  }) as HTMLButtonElement;
  volBtn.textContent = volIcon(settings.volume);

  const volSlider = make("input", {
    type: "range", min: "0", max: "1", step: "0.05",
    value: String(settings.volume),
    "aria-label": "Volume",
  }) as HTMLInputElement;

  volBtn.addEventListener("click", () => {
    const newVol = settings.volume > 0 ? 0 : preMuteVolume;
    if (settings.volume > 0) preMuteVolume = settings.volume;
    emulator.setVolume(newVol);
    volSlider.value = String(newVol);
    onSettingsChange({ volume: newVol });
    volBtn.textContent = volIcon(newVol);
  });

  volSlider.addEventListener("input", () => {
    const v = Number(volSlider.value);
    if (v > 0) preMuteVolume = v;
    emulator.setVolume(v);
    onSettingsChange({ volume: v });
    volBtn.textContent = volIcon(v);
  });

  volWrap.append(volBtn, volSlider);
  const controls: (HTMLElement | null)[] = [
    btnLibrary, btnSave, btnLoad, btnSaves, btnReset, btnFPS,
    btnTouch,
    volWrap,
  ];
  for (const ctrl of controls) {
    if (ctrl) container.appendChild(ctrl);
  }
  updateHeaderOverflow();
}

// ── Save state helpers ────────────────────────────────────────────────────────

/**
 * Persist save state metadata (thumbnail + optional state data) to our
 * IndexedDB after a quickSave completes in EJS.
 */
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
    const stateData  = stateBytes
      ? new Blob([(stateBytes.buffer as ArrayBuffer).slice(stateBytes.byteOffset, stateBytes.byteOffset + stateBytes.byteLength)])
      : null;

    const entry: SaveStateEntry = {
      id:         saveStateKey(gameId, slot),
      gameId,
      gameName,
      systemId,
      slot,
      timestamp:  Date.now(),
      thumbnail,
      stateData,
      isAutoSave: slot === AUTO_SAVE_SLOT,
    };

    await saveLibrary.saveState(entry);
  } catch {
    // Save metadata persistence is best-effort
  }
}

// ── Save gallery dialog ───────────────────────────────────────────────────────

/**
 * Open the save state gallery dialog for the current game.
 * Shows all slots (auto-save + 4 manual) with thumbnails,
 * save/load/export/import controls.
 */
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
    "aria-label": "Save State Gallery",
  });

  box.appendChild(make("h3", { class: "confirm-title" }, "Save States"));
  box.appendChild(make("p", { class: "confirm-body" }, gameName));

  const slotsContainer = make("div", { class: "save-gallery-slots" });
  box.appendChild(slotsContainer);

  const close = () => {
    document.removeEventListener("keydown", onKey);
    overlay.classList.remove("confirm-overlay--visible");
    setTimeout(() => overlay.remove(), 200);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
  };

  const footer = make("div", { class: "confirm-footer" });
  const btnClose = make("button", { class: "btn" }, "Close");
  btnClose.addEventListener("click", close);
  footer.appendChild(btnClose);
  box.appendChild(footer);

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);

  requestAnimationFrame(() => overlay.classList.add("confirm-overlay--visible"));

  await renderSaveSlots(
    slotsContainer, emulator, saveLibrary,
    gameId, gameName, systemId
  );
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

  const slots = [AUTO_SAVE_SLOT, 1, 2, 3, 4];

  for (const slot of slots) {
    const state = stateMap.get(slot);
    const isAuto = slot === AUTO_SAVE_SLOT;
    const slotLabel = isAuto ? "Auto-Save" : `Slot ${slot}`;

    const row = make("div", { class: "save-slot" });

    // Thumbnail
    const thumbEl = make("div", { class: "save-slot__thumb" });
    if (state?.thumbnail) {
      const img = make("img", {
        class: "save-slot__img",
        alt: `${slotLabel} screenshot`,
      }) as HTMLImageElement;
      const url = URL.createObjectURL(state.thumbnail);
      img.src = url;
      img.onload = () => URL.revokeObjectURL(url);
      thumbEl.appendChild(img);
    } else {
      thumbEl.appendChild(make("span", { class: "save-slot__empty" }, isAuto ? "⟳" : "—"));
    }

    // Info
    const infoEl = make("div", { class: "save-slot__info" });
    const labelEl = make("span", { class: "save-slot__label" }, slotLabel);
    infoEl.appendChild(labelEl);

    if (state) {
      const timeStr = formatRelativeTime(state.timestamp);
      infoEl.appendChild(make("span", { class: "save-slot__time" }, timeStr));
    } else {
      infoEl.appendChild(make("span", { class: "save-slot__time" }, "Empty"));
    }

    // Actions
    const actionsEl = make("div", { class: "save-slot__actions" });

    if (!isAuto) {
      // Save to slot
      const btnSave = make("button", { class: "btn save-slot__btn", title: `Save to ${slotLabel}` }, "💾");
      btnSave.addEventListener("click", async () => {
        emulator.quickSave(slot);
        await persistSaveMetadata(emulator, saveLibrary, gameId, gameName, systemId, slot);
        await renderSaveSlots(container, emulator, saveLibrary, gameId, gameName, systemId);
      });
      actionsEl.appendChild(btnSave);
    }

    if (state) {
      // Load from slot
      const btnLoad = make("button", { class: "btn save-slot__btn", title: `Load ${slotLabel}` }, "📂");
      btnLoad.addEventListener("click", () => {
        if (state.stateData) {
          state.stateData.arrayBuffer().then(buf => {
            const written = emulator.writeStateData(slot, new Uint8Array(buf));
            if (written) {
              emulator.quickLoad(slot);
            } else {
              showError("Could not restore save state — the emulator filesystem is not ready.");
            }
          }).catch(() => {
            emulator.quickLoad(slot);
          });
        } else {
          emulator.quickLoad(slot);
        }
      });
      actionsEl.appendChild(btnLoad);

      // Export
      if (state.stateData) {
        const btnExport = make("button", { class: "btn save-slot__btn", title: "Export .state file" }, "⬇");
        btnExport.addEventListener("click", async () => {
          const exported = await saveLibrary.exportState(gameId, slot);
          if (exported) {
            downloadBlob(exported.blob, exported.fileName);
          }
        });
        actionsEl.appendChild(btnExport);
      }

      // Delete
      if (!isAuto) {
        const btnDel = make("button", { class: "btn btn--danger save-slot__btn", title: `Delete ${slotLabel}` }, "✕");
        btnDel.addEventListener("click", async () => {
          const confirmed = await showConfirmDialog(
            `Delete save state in ${slotLabel}?`,
            { title: "Delete Save", confirmLabel: "Delete", isDanger: true }
          );
          if (confirmed) {
            await saveLibrary.deleteState(gameId, slot);
            await renderSaveSlots(container, emulator, saveLibrary, gameId, gameName, systemId);
          }
        });
        actionsEl.appendChild(btnDel);
      }
    }

    // Import (for non-auto slots, regardless of existing state)
    if (!isAuto) {
      const importInput = make("input", {
        type: "file",
        accept: ".state,.sav",
        style: "display:none",
        "aria-label": `Import state to ${slotLabel}`,
      }) as HTMLInputElement;

      const btnImport = make("button", { class: "btn save-slot__btn", title: `Import .state to ${slotLabel}` }, "⬆");
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
        } catch (err) {
          showError(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

      actionsEl.appendChild(importInput);
      actionsEl.appendChild(btnImport);
    }

    row.append(thumbEl, infoEl, actionsEl);
    container.appendChild(row);
  }
}

// ── Auto-save restore prompt ──────────────────────────────────────────────────

/**
 * Check if an auto-save exists for a game and prompt to restore it.
 * Returns true if the user chose to restore.
 */
export async function promptAutoSaveRestore(
  saveLibrary: SaveStateLibrary,
  gameId: string
): Promise<boolean> {
  const hasAuto = await saveLibrary.hasAutoSave(gameId);
  if (!hasAuto) return false;

  return showConfirmDialog(
    "A crash-recovery save was found from your last session. Would you like to restore it?",
    { title: "Restore Auto-Save?", confirmLabel: "Restore" }
  );
}

// ── Settings panel ────────────────────────────────────────────────────────────

export function openSettingsPanel(
  settings:         Settings,
  deviceCaps:       DeviceCapabilities,
  library:          GameLibrary,
  biosLibrary:      BiosLibrary,
  onSettingsChange: (patch: Partial<Settings>) => void,
  emulatorRef?:     import("./emulator.js").PSPEmulator,
  onLaunchGame?:    (file: File, systemId: string, gameId?: string) => Promise<void>,
  saveLibrary?:     SaveStateLibrary
): void {
  const panel   = document.getElementById("settings-panel")!;
  const content = document.getElementById("settings-content")!;
  const previousFocus = document.activeElement as HTMLElement | null;

  buildSettingsContent(content, settings, deviceCaps, library, biosLibrary, onSettingsChange, emulatorRef, onLaunchGame, saveLibrary);
  panel.hidden = false;

  const onEsc = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    close();
  };

  const close = () => {
    panel.hidden = true;
    document.removeEventListener("keydown", onEsc);
    previousFocus?.focus();
  };

  document.getElementById("settings-close")!.onclick = close;
  document.getElementById("settings-backdrop")!.onclick = close;
  document.addEventListener("keydown", onEsc);
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
  saveLibrary?:     SaveStateLibrary
): void {
  container.innerHTML = "";

  // ── Performance Mode ──────────────────────────────────────────────────────
  const perfSection = make("div", { class: "settings-section" });
  perfSection.appendChild(make("h4", { class: "settings-section__title" }, "Performance Mode"));
  perfSection.appendChild(make("p", { class: "settings-help" },
    "Controls rendering resolution, frameskip, and GPU settings for demanding systems (PSP, DS, N64, and similar 3D cores)."
  ));

  const modes: Array<{ value: PerformanceMode; label: string; desc: string }> = [
    { value: "auto",        label: `Auto (recommended)`, desc: `Detected tier: ${formatTierLabel(deviceCaps.tier)} → ${deviceCaps.isLowSpec || deviceCaps.tier === "medium" ? "Performance" : "Quality"} mode` },
    { value: "performance", label: "Performance",        desc: "1× resolution, auto frameskip, lazy texture caching — best for low-spec devices" },
    { value: "quality",     label: "Quality",            desc: "Higher resolution, texture upscaling, no frameskip" },
  ];

  for (const m of modes) {
    const row   = make("label", { class: "radio-row" });
    const radio = make("input", { type: "radio", name: "perf-mode", value: m.value }) as HTMLInputElement;
    if (settings.performanceMode === m.value) radio.checked = true;
    radio.addEventListener("change", () => {
      if (radio.checked) onSettingsChange({ performanceMode: m.value });
    });
    const txt = make("span", { class: "radio-row__text" });
    txt.append(
      make("span", { class: "radio-row__label" }, m.label),
      make("span", { class: "radio-row__desc"  }, m.desc)
    );
    row.append(radio, txt);
    perfSection.appendChild(row);
  }

  // ── Mobile & PWA section ─────────────────────────────────────────────────
  const mobileSection = make("div", { class: "settings-section" });
  mobileSection.appendChild(make("h4", { class: "settings-section__title" }, "Mobile & PWA"));

  // PWA install button (shown when the browser offers an install prompt)
  const installRow = make("div", { class: "pwa-install-row" });
  const buildInstallBtn = () => {
    installRow.innerHTML = "";
    if (!_canInstallPWA?.()) {
      const note = make("p", { class: "settings-help" },
        "To install RetroVault as an app, open this page in Chrome or Edge on Android, " +
        "then tap the browser menu \u2192 \u201cAdd to Home Screen\u201d."
      );
      installRow.appendChild(note);
      return;
    }
    const btnInstall = make("button", { class: "btn btn--primary pwa-install-btn" },
      "📲 Install RetroVault App"
    );
    btnInstall.addEventListener("click", async () => {
      if (!_onInstallPWA) return;
      const installed = await _onInstallPWA();
      if (installed) {
        btnInstall.textContent = "\u2713 Installing\u2026";
        btnInstall.setAttribute("disabled", "true");
      }
    });
    installRow.appendChild(btnInstall);
  };
  buildInstallBtn();
  // Re-render when the install prompt becomes available
  document.addEventListener("retrovault:installPromptReady", () => buildInstallBtn(), { once: true });
  mobileSection.appendChild(installRow);

  // Touch controls toggle
  const touchRow = make("label", { class: "radio-row" });
  const touchCheck = make("input", { type: "checkbox" }) as HTMLInputElement;
  touchCheck.checked = settings.touchControls;
  touchCheck.addEventListener("change", () => {
    onSettingsChange({ touchControls: touchCheck.checked });
  });
  const touchTxt = make("span", { class: "radio-row__text" });
  touchTxt.append(
    make("span", { class: "radio-row__label" }, "Virtual gamepad"),
    make("span", { class: "radio-row__desc" },
      "Show on-screen touch buttons while a game is running (touch devices only). " +
      "Tap \u201c\uD83C\uDFAE Edit\u201d in the game header to rearrange button positions."
    )
  );
  touchRow.append(touchCheck, touchTxt);
  mobileSection.appendChild(touchRow);

  // Haptic feedback toggle
  const hapticRow = make("label", { class: "radio-row" });
  const hapticCheck = make("input", { type: "checkbox" }) as HTMLInputElement;
  hapticCheck.checked = settings.hapticFeedback;
  hapticCheck.addEventListener("change", () => {
    onSettingsChange({ hapticFeedback: hapticCheck.checked });
  });
  const hapticTxt = make("span", { class: "radio-row__text" });
  hapticTxt.append(
    make("span", { class: "radio-row__label" }, "Haptic feedback"),
    make("span", { class: "radio-row__desc" },
      "Vibrate briefly on virtual button presses (Android Chrome only; iOS ignores this)"
    )
  );
  hapticRow.append(hapticCheck, hapticTxt);
  mobileSection.appendChild(hapticRow);

  // Orientation lock toggle
  const orientRow = make("label", { class: "radio-row" });
  const orientCheck = make("input", { type: "checkbox" }) as HTMLInputElement;
  orientCheck.checked = settings.orientationLock;
  orientCheck.addEventListener("change", () => {
    onSettingsChange({ orientationLock: orientCheck.checked });
  });
  const orientTxt = make("span", { class: "radio-row__text" });
  orientTxt.append(
    make("span", { class: "radio-row__label" }, "Lock to landscape"),
    make("span", { class: "radio-row__desc" },
      "Automatically rotate to landscape orientation when a game starts (Android Chrome; " +
      "iOS Safari does not support orientation locking)"
    )
  );
  orientRow.append(orientCheck, orientTxt);
  mobileSection.appendChild(orientRow);

  // ── FPS Overlay toggle ────────────────────────────────────────────────────
  const fpsRow = make("label", { class: "radio-row" });
  const fpsCheck = make("input", { type: "checkbox" }) as HTMLInputElement;
  fpsCheck.checked = settings.showFPS;
  fpsCheck.addEventListener("change", () => {
    onSettingsChange({ showFPS: fpsCheck.checked });
    showFPSOverlay(fpsCheck.checked, emulatorRef, settings.showAudioVis);
    emulatorRef?.setFPSMonitorEnabled(fpsCheck.checked);
  });
  const fpsTxt = make("span", { class: "radio-row__text" });
  fpsTxt.append(
    make("span", { class: "radio-row__label" }, "Show FPS overlay"),
    make("span", { class: "radio-row__desc"  }, "Display real-time framerate and performance tier while playing")
  );
  fpsRow.append(fpsCheck, fpsTxt);
  perfSection.appendChild(fpsRow);

  // ── Audio visualiser toggle ───────────────────────────────────────────────
  const audioVisRow = make("label", { class: "radio-row" });
  const audioVisCheck = make("input", { type: "checkbox" }) as HTMLInputElement;
  audioVisCheck.checked = settings.showAudioVis;
  audioVisCheck.addEventListener("change", () => {
    onSettingsChange({ showAudioVis: audioVisCheck.checked });
    if (settings.showFPS) {
      showFPSOverlay(true, emulatorRef, audioVisCheck.checked);
    }
  });
  const audioVisTxt = make("span", { class: "radio-row__text" });
  audioVisTxt.append(
    make("span", { class: "radio-row__label" }, "Audio visualiser"),
    make("span", { class: "radio-row__desc"  }, "Show oscilloscope waveform in the FPS overlay (requires FPS overlay to be enabled)")
  );
  audioVisRow.append(audioVisCheck, audioVisTxt);
  perfSection.appendChild(audioVisRow);

  // ── Device Info ───────────────────────────────────────────────────────────
  const deviceSection = make("div", { class: "settings-section" });
  deviceSection.appendChild(make("h4", { class: "settings-section__title" }, "Device Info"));

  const capText = formatCapabilitiesSummary(deviceCaps);
  deviceSection.appendChild(make("p", { class: "device-info" }, capText));

  // Tier badge with score
  const tierText = `${formatTierLabel(deviceCaps.tier)} tier (GPU score: ${deviceCaps.gpuBenchmarkScore}/100)`;
  const tierClass = deviceCaps.tier === "low"
    ? "tier-badge tier-badge--warn"
    : deviceCaps.tier === "medium"
      ? "tier-badge tier-badge--mid"
      : "tier-badge tier-badge--ok";
  const tierBadge = make("span", { class: tierClass }, tierText);
  deviceSection.appendChild(tierBadge);

  // GPU capabilities
  const gpuDetails = make("div", { class: "device-info-details" });
  gpuDetails.appendChild(make("p", { class: "device-info" },
    `Max texture size: ${deviceCaps.gpuCaps.maxTextureSize}px`));
  if (deviceCaps.gpuCaps.anisotropicFiltering) {
    gpuDetails.appendChild(make("p", { class: "device-info" },
      `Anisotropic filtering: ${deviceCaps.gpuCaps.maxAnisotropy}×`));
  }
  gpuDetails.appendChild(make("p", { class: "device-info" },
    `Float textures: ${deviceCaps.gpuCaps.floatTextures ? "Yes" : "No"}`));
  gpuDetails.appendChild(make("p", { class: "device-info" },
    `Instanced arrays: ${deviceCaps.gpuCaps.instancedArrays ? "Yes" : "No"}`));
  deviceSection.appendChild(gpuDetails);

  const webglRow = make("p", { class: "device-info" },
    `WebGL 2: ${deviceCaps.gpuCaps.webgl2 ? "✓ Available" : "✗ Not available"}`
  );
  deviceSection.appendChild(webglRow);

  const sabRow = make("p", { class: "device-info" },
    `SharedArrayBuffer: ${typeof SharedArrayBuffer !== "undefined" ? "✓ Available (PSP supported)" : "✗ Not available (PSP requires reload with service worker)"}`
  );
  deviceSection.appendChild(sabRow);

  const adapterInfo = emulatorRef?.webgpuAdapterInfo;
  const webgpuStatusText = deviceCaps.webgpuAvailable
    ? adapterInfo?.device
      ? `✓ Available — ${adapterInfo.device}${adapterInfo.isFallbackAdapter ? " (software fallback)" : ""}`
      : adapterInfo?.vendor
        ? `✓ Available — ${adapterInfo.vendor}`
        : "✓ Available"
    : "✗ Not available (Chrome 113+ required)";
  const webgpuRow = make("p", { class: "device-info" }, `WebGPU: ${webgpuStatusText}`);
  deviceSection.appendChild(webgpuRow);

  const audioWorkletRow = make("p", { class: "device-info" },
    `AudioWorklet: ${typeof AudioWorkletNode !== "undefined" ? "✓ Available (low-latency audio active)" : "✗ Not available"}`
  );
  deviceSection.appendChild(audioWorkletRow);

  // ── WebGPU opt-in toggle (only shown when WebGPU is available) ────────────
  if (deviceCaps.webgpuAvailable) {
    const webgpuRow2 = make("label", { class: "radio-row" });
    const webgpuCheck = make("input", { type: "checkbox" }) as HTMLInputElement;
    webgpuCheck.checked = settings.useWebGPU;
    webgpuCheck.addEventListener("change", () => {
      onSettingsChange({ useWebGPU: webgpuCheck.checked });
    });
    const webgpuTxt = make("span", { class: "radio-row__text" });
    webgpuTxt.append(
      make("span", { class: "radio-row__label" }, "Use WebGPU (experimental)"),
      make("span", { class: "radio-row__desc"  },
        "Pre-initialises the WebGPU adapter and warms the GPU shader compiler on startup. " +
        "Enables WebGPU post-processing filters (CRT, sharpen). " +
        "Falls back silently to WebGL when unsupported. Requires page reload to take effect.")
    );
    webgpuRow2.append(webgpuCheck, webgpuTxt);
    deviceSection.appendChild(webgpuRow2);

    // ── WebGPU post-processing effect picker ─────────────────────────────
    const postFxSection = make("div", { class: "settings-subsection" });
    postFxSection.appendChild(make("h4", { class: "settings-section__title" }, "GPU Post-Processing"));
    postFxSection.appendChild(make("p", { class: "settings-help" },
      "Apply real-time GPU post-processing to the emulator output via WebGPU compute shaders. " +
      "Requires WebGPU to be enabled above."
    ));

    type FxOption = { value: string; label: string; desc: string };
    const fxOptions: FxOption[] = [
      { value: "none",    label: "Off",     desc: "No post-processing — raw emulator output" },
      { value: "crt",     label: "CRT",     desc: "Scanlines, barrel distortion, phosphor glow, and vignette — classic CRT look" },
      { value: "sharpen", label: "Sharpen", desc: "Edge-aware sharpening — crisper pixels for upscaled output" },
    ];

    for (const opt of fxOptions) {
      const row   = make("label", { class: "radio-row" });
      const radio = make("input", { type: "radio", name: "postfx-mode", value: opt.value }) as HTMLInputElement;
      if (settings.postProcessEffect === opt.value) radio.checked = true;
      radio.disabled = !settings.useWebGPU;
      radio.addEventListener("change", () => {
        if (radio.checked) {
          onSettingsChange({ postProcessEffect: opt.value as import("./webgpuPostProcess.js").PostProcessEffect });
        }
      });
      const txt = make("span", { class: "radio-row__text" });
      txt.append(
        make("span", { class: "radio-row__label" }, opt.label),
        make("span", { class: "radio-row__desc"  }, opt.desc),
      );
      row.append(radio, txt);
      postFxSection.appendChild(row);
    }

    deviceSection.appendChild(postFxSection);
  }

  // ── Library Stats ─────────────────────────────────────────────────────────
  const libSection = make("div", { class: "settings-section" });
  libSection.appendChild(make("h4", { class: "settings-section__title" }, "Library Storage"));

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
    if (onLaunchGame) renderLibrary(library, settings, onLaunchGame, emulatorRef);
  });
  // (onApplyPatch not available here; library re-render is enough)
  libSection.appendChild(btnClear);

  // ── Save State Management ───────────────────────────────────────────────────
  if (saveLibrary) {
    const saveSection = make("div", { class: "settings-section" });
    saveSection.appendChild(make("h4", { class: "settings-section__title" }, "Save States"));

    const saveStatsEl = make("p", { class: "device-info" }, "Calculating…");
    saveSection.appendChild(saveStatsEl);

    saveLibrary.count().then((count) => {
      saveStatsEl.textContent = `${count} save state${count !== 1 ? "s" : ""} stored locally`;
    }).catch(() => { saveStatsEl.textContent = "Could not load save stats."; });

    // Auto-save toggle
    const autoSaveRow = make("label", { class: "radio-row" });
    const autoSaveCheck = make("input", { type: "checkbox" }) as HTMLInputElement;
    autoSaveCheck.checked = settings.autoSaveEnabled;
    autoSaveCheck.addEventListener("change", () => {
      onSettingsChange({ autoSaveEnabled: autoSaveCheck.checked });
    });
    const autoSaveTxt = make("span", { class: "radio-row__text" });
    autoSaveTxt.append(
      make("span", { class: "radio-row__label" }, "Auto-save on tab close"),
      make("span", { class: "radio-row__desc" },
        "Automatically save progress when the tab is hidden or closed, preventing loss from accidental closure")
    );
    autoSaveRow.append(autoSaveCheck, autoSaveTxt);
    saveSection.appendChild(autoSaveRow);

    // Save migration tool
    const migrateSection = make("div", { class: "settings-subsection" });
    migrateSection.appendChild(make("p", { class: "settings-help" },
      "If you renamed a ROM file, use this tool to move its saves to the new library entry."
    ));

    const btnMigrate = make("button", { class: "btn" }, "Migrate Saves…");
    btnMigrate.addEventListener("click", async () => {
      let games: GameMetadata[];
      try {
        games = await library.getAllGamesMetadata();
      } catch { games = []; }

      if (games.length < 2) {
        showError("You need at least two games in your library to migrate saves.");
        return;
      }

      const source = await showGamePickerDialog(
        "Select Source Game",
        "Choose the game whose saves you want to move:",
        games
      );
      if (!source) return;

      const targets = games.filter(g => g.id !== source.id);
      const target = await showGamePickerDialog(
        "Select Target Game",
        "Choose the game to receive the saves:",
        targets
      );
      if (!target) return;

      try {
        const count = await saveLibrary.migrateSaves(source.id, target.id, target.name);
        if (count > 0) {
          showInfoToast(`Migrated ${count} save state${count !== 1 ? "s" : ""} from "${source.name}" to "${target.name}".`);
        } else {
          showInfoToast(`No saves found for "${source.name}".`);
        }
      } catch (err) {
        showError(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    migrateSection.appendChild(btnMigrate);
    saveSection.appendChild(migrateSection);

    // Clear saves
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

  // ── BIOS Management ───────────────────────────────────────────────────────
  const biosSection = make("div", { class: "settings-section" });
  biosSection.appendChild(make("h4", { class: "settings-section__title" }, "BIOS Files"));
  biosSection.appendChild(make("p", { class: "settings-help" },
    "Some systems (Saturn, Dreamcast, PS1) require BIOS files to run games. " +
    "Upload your legally obtained BIOS files below."
  ));

  const biosGrid = make("div", { class: "bios-grid" });
  biosSection.appendChild(biosGrid);

  // Which systems have BIOS requirements
  const biosSystemIds = Object.keys(BIOS_REQUIREMENTS);

  for (const sysId of biosSystemIds) {
    const sysInfo = SYSTEMS.find(s => s.id === sysId);
    if (!sysInfo) continue;
    const reqs = BIOS_REQUIREMENTS[sysId]!;

    const sysBlock = make("div", { class: "bios-system" });

    const sysHeader = make("div", { class: "bios-system__header" });
    const sysBadge  = make("span", { class: "sys-badge" }, sysInfo.shortName);
    sysBadge.style.background = sysInfo.color;
    sysHeader.append(sysBadge, document.createTextNode(" " + sysInfo.name));
    sysBlock.appendChild(sysHeader);

    for (const req of reqs) {
      const row        = make("div", { class: "bios-row" });
      const statusDot  = make("span", { class: "bios-dot bios-dot--unknown" });
      const label      = make("span", { class: "bios-label" });
      label.textContent = req.displayName;
      const desc       = make("span", { class: "bios-desc" }, req.description);
      const requiredBadge = req.required
        ? make("span", { class: "bios-required" }, "Required")
        : make("span", { class: "bios-optional" }, "Optional");

      const uploadInput = make("input", {
        type: "file",
        accept: ".bin,.img,.rom",
        "aria-label": `Upload ${req.displayName}`,
        style: "display:none",
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

      // Check current status async
      biosLibrary.findBios(sysId, req.fileName).then(found => {
        if (found) {
          statusDot.className   = "bios-dot bios-dot--ok";
          uploadBtn.textContent = "Replace";
        } else if (req.required) {
          statusDot.className = "bios-dot bios-dot--missing";
        }
      }).catch(() => {});

      row.append(statusDot, uploadInput, label, requiredBadge, desc, uploadBtn);
      sysBlock.appendChild(row);
    }

    biosGrid.appendChild(sysBlock);
  }

  // ── Supported Systems ─────────────────────────────────────────────────────
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

  container.append(perfSection, mobileSection, deviceSection, libSection, biosSection, sysSection);
}

// ── Multi-disc game picker ─────────────────────────────────────────────────────

/**
 * Parse a .m3u playlist file and return the list of disc filenames it references.
 */
export function parseM3U(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"))
    .map(line => line.split(/[/\\]/).pop() ?? line); // basename only
}

/**
 * Show a multi-disc game picker dialog.
 * The user must provide each disc file referenced in the .m3u.
 * Returns a Map of filename → Blob, or null if the user cancels.
 */
export function showMultiDiscPicker(
  discFileNames: string[]
): Promise<Map<string, File> | null> {
  return new Promise((resolve) => {
    const overlay = make("div", { class: "confirm-overlay" });
    const box     = make("div", {
      class: "confirm-box multidisc-box",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Multi-Disc Game Setup",
    });

    box.appendChild(make("h3", { class: "confirm-title" }, "Multi-Disc Game"));
    box.appendChild(make("p", { class: "confirm-body" },
      `This game spans ${discFileNames.length} disc${discFileNames.length !== 1 ? "s" : ""}. ` +
      "Please select each disc image file:"
    ));

    const fileMap = new Map<string, File>();

    for (const fileName of discFileNames) {
      const row      = make("div", { class: "multidisc-row" });
      const status   = make("span", { class: "bios-dot bios-dot--missing" });
      const label    = make("span", { class: "multidisc-label" }, fileName);
      const fileInput2 = make("input", {
        type: "file",
        style: "display:none",
        "aria-label": `Select ${fileName}`,
      }) as HTMLInputElement;
      const btn = make("button", { class: "btn" }, "Select…");

      btn.addEventListener("click", () => fileInput2.click());
      fileInput2.addEventListener("change", () => {
        const f = fileInput2.files?.[0];
        if (!f) return;
        fileMap.set(fileName, f);
        status.className = "bios-dot bios-dot--ok";
        btn.textContent  = f.name;
        checkAllSelected();
      });

      row.append(status, fileInput2, label, btn);
      box.appendChild(row);
    }

    const footer     = make("div", { class: "confirm-footer" });
    const btnCancel  = make("button", { class: "btn" }, "Cancel");
    const btnConfirm = make("button", {
      class: "btn btn--primary",
      disabled: "true",
    }, "Launch Game");

    footer.append(btnCancel, btnConfirm);
    box.appendChild(footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const checkAllSelected = () => {
      const allReady = discFileNames.every(fn => fileMap.has(fn));
      if (allReady) btnConfirm.removeAttribute("disabled");
      else          btnConfirm.setAttribute("disabled", "true");
    };

    const close = (result: Map<string, File> | null) => {
      document.removeEventListener("keydown", onKey);
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), 200);
      resolve(result);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
    };

    btnCancel.addEventListener("click",  () => close(null));
    btnConfirm.addEventListener("click", () => close(fileMap));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
    document.addEventListener("keydown", onKey);

    requestAnimationFrame(() => overlay.classList.add("confirm-overlay--visible"));
  });
}

// ── Tier downgrade prompt ─────────────────────────────────────────────────────

/**
 * Show a dialog asking the user if they want to downgrade to a lower tier.
 * Returns true if the user confirms the downgrade.
 */
export async function showTierDowngradePrompt(
  averageFPS: number,
  currentTier: import("./performance.js").PerformanceTier,
  targetTier:  import("./performance.js").PerformanceTier
): Promise<boolean> {
  const tierNames: Record<string, string> = {
    ultra: "Ultra", high: "High", medium: "Medium", low: "Low",
  };
  const message =
    `The game is running at an average of ${averageFPS} FPS on the ` +
    `${tierNames[currentTier] ?? currentTier} quality tier.\n\n` +
    `Switching to the ${tierNames[targetTier] ?? targetTier} tier will reduce rendering ` +
    `quality but should provide a smoother experience on this device. ` +
    `This preference will be remembered for this game.`;

  return showConfirmDialog(message, {
    title:        "Low Frame Rate Detected",
    confirmLabel: `Switch to ${tierNames[targetTier] ?? targetTier} Tier`,
    isDanger:     false,
  });
}

// ── Audio Visualiser ──────────────────────────────────────────────────────────

/**
 * Oscilloscope/spectrum overlay drawn on the fps-visualiser canvas.
 *
 * Connects an AnalyserNode to the game's OpenAL AudioContext (accessed via
 * EJS_emulator.Module.AL.currentCtx.audioCtx). Falls back to a standalone
 * context if the EJS context is not yet available.
 *
 * The visualiser renders a time-domain waveform (oscilloscope) at ≤30 fps
 * to keep CPU overhead below 0.05 ms/frame even on Chromebooks.
 */
class AudioVisualiser {
  private _ctx: AudioContext | null = null;
  private _analyser: AnalyserNode | null = null;
  private _rafId: number | null = null;
  private _canvas: HTMLCanvasElement | null = null;
  private _2d: CanvasRenderingContext2D | null = null;
  private _buffer: Uint8Array<ArrayBuffer> | null = null;
  private _lastDrawTime = 0;
  private readonly _TARGET_INTERVAL = 1000 / 30; // 30 fps draw cap

  start(emulatorRef?: import("./emulator.js").PSPEmulator): boolean {
    this._canvas = document.getElementById("fps-visualiser") as HTMLCanvasElement | null;
    if (!this._canvas) return false;
    this._2d = this._canvas.getContext("2d");
    if (!this._2d) return false;

    // Try to use the AudioWorklet context from the emulator first,
    // then fall back to EJS's OpenAL context directly.
    const ejsCtx = (window as Window & { EJS_emulator?: { Module?: { AL?: { currentCtx?: { audioCtx?: AudioContext } } } } })
      .EJS_emulator?.Module?.AL?.currentCtx?.audioCtx;

    this._ctx = emulatorRef?.getAudioContext() ?? ejsCtx ?? null;

    if (!this._ctx) {
      // No game audio context available — still show a "no signal" state
      this._drawNoSignal();
      return false;
    }

    this._analyser = this._ctx.createAnalyser();
    this._analyser.fftSize = 256;
    this._analyser.smoothingTimeConstant = 0.75;
    this._buffer = new Uint8Array(this._analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;

    // Try to connect the analyser to the audio graph
    try {
      const alCtx = (window as Window & { EJS_emulator?: { Module?: { AL?: { currentCtx?: { audioCtx?: AudioContext; sources?: Record<string, { gain: GainNode }> } } } } })
        .EJS_emulator?.Module?.AL?.currentCtx;
      if (alCtx?.sources && alCtx.audioCtx === this._ctx) {
        const gainNodes = Object.values(alCtx.sources).map(s => s.gain);
        const merger = this._ctx.createChannelMerger(Math.max(1, gainNodes.length));
        gainNodes.forEach((g, i) => g.connect(merger, 0, Math.min(i, gainNodes.length - 1)));
        merger.connect(this._analyser);
      } else {
        this._ctx.destination.channelCount = Math.min(2, this._ctx.destination.maxChannelCount);
      }
    } catch {
      // Connection failed — analyser will show silence
    }

    this._canvas.hidden = false;
    this._loop();
    return true;
  }

  stop(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    try { this._analyser?.disconnect(); } catch { /* ignore */ }
    this._analyser = null;
    if (this._canvas) this._canvas.hidden = true;
  }

  private _loop(): void {
    this._rafId = requestAnimationFrame((now) => {
      if (now - this._lastDrawTime >= this._TARGET_INTERVAL) {
        this._lastDrawTime = now;
        this._draw();
      }
      this._loop();
    });
  }

  private _draw(): void {
    if (!this._2d || !this._canvas || !this._analyser || !this._buffer) return;

    this._analyser.getByteTimeDomainData(this._buffer);

    const { width, height } = this._canvas;
    const ctx = this._2d;

    ctx.clearRect(0, 0, width, height);

    // Background
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(0, 0, width, height);

    // Waveform
    ctx.beginPath();
    ctx.strokeStyle = "#4caf50";
    ctx.lineWidth = 1.5;

    const sliceWidth = width / this._buffer.length;
    let x = 0;
    for (let i = 0; i < this._buffer.length; i++) {
      const v = this._buffer[i] / 128.0;
      const y = (v * height) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else         ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.stroke();
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

function startAudioVisualiser(emulatorRef?: PSPEmulator): void {
  _audioVisualiser.start(emulatorRef);
}

function stopAudioVisualiser(): void {
  _audioVisualiser.stop();
}

// ── FPS overlay ───────────────────────────────────────────────────────────────

function showFPSOverlay(show: boolean, emulatorRef?: PSPEmulator, showAudioVis?: boolean): void {
  const overlay = document.getElementById("fps-overlay");
  if (overlay) overlay.hidden = !show;

  if (show && showAudioVis) {
    startAudioVisualiser(emulatorRef);
  } else {
    stopAudioVisualiser();
  }
}

// Track consecutive low-FPS updates to trigger a performance suggestion
let _lowFPSCount = 0;
let _perfSuggestionShown = false;
const LOW_FPS_THRESHOLD  = 25;  // FPS below this is considered "struggling"
const LOW_FPS_TRIGGER    = 6;   // consecutive update windows (≈6×10 frames)

function updateFPSOverlay(snapshot: FPSSnapshot, emulator: PSPEmulator): void {
  const currentEl = document.getElementById("fps-current");
  const avgEl     = document.getElementById("fps-avg");
  const tierEl    = document.getElementById("fps-tier");
  const droppedEl = document.getElementById("fps-dropped");

  if (currentEl) {
    currentEl.textContent = `${snapshot.current} FPS`;
    // Colour-code: green ≥50, yellow ≥30, red <30
    currentEl.className = snapshot.current >= 50
      ? "fps-good"
      : snapshot.current >= 30
        ? "fps-ok"
        : "fps-bad";
  }
  if (avgEl) avgEl.textContent = `avg ${snapshot.average}`;
  if (tierEl && emulator.activeTier) {
    tierEl.textContent = formatTierLabel(emulator.activeTier);
  }
  if (droppedEl) {
    if (snapshot.droppedFrames > 0) {
      droppedEl.textContent = `${snapshot.droppedFrames} dropped`;
      droppedEl.hidden = false;
    } else {
      droppedEl.hidden = true;
    }
  }

  // Adaptive performance suggestion: if FPS has been consistently low,
  // and the user hasn't already been notified this session, prompt them
  // to switch to Performance mode via a non-blocking toast.
  if (snapshot.average > 0 && snapshot.average < LOW_FPS_THRESHOLD) {
    _lowFPSCount++;
    if (_lowFPSCount >= LOW_FPS_TRIGGER && !_perfSuggestionShown) {
      _perfSuggestionShown = true;
      showPerfSuggestion();
    }
  } else {
    _lowFPSCount = Math.max(0, _lowFPSCount - 1);
  }
}

/**
 * Show a subtle, non-blocking performance suggestion toast.
 * Auto-dismisses after 10 s. Does not fire again during the same session.
 */
function showPerfSuggestion(): void {
  const existing = document.getElementById("perf-suggestion");
  if (existing) return;

  const toast = make("div", { id: "perf-suggestion", class: "perf-suggestion", role: "status" });
  toast.innerHTML =
    `<span class="perf-suggestion__msg">Low FPS detected — try <strong>Performance mode</strong> in Settings for a smoother experience.</span>` +
    `<button class="perf-suggestion__close" aria-label="Dismiss">✕</button>`;

  document.body.appendChild(toast);

  const dismiss = () => {
    toast.classList.add("perf-suggestion--hiding");
    setTimeout(() => toast.remove(), 300);
  };

  toast.querySelector(".perf-suggestion__close")?.addEventListener("click", dismiss);

  // Auto-dismiss after 10 s
  setTimeout(dismiss, 10_000);

  // Animate in
  requestAnimationFrame(() => toast.classList.add("perf-suggestion--visible"));
}

/** Reset the adaptive FPS counters when a new game launches. */
export function resetPerfSuggestion(): void {
  _lowFPSCount = 0;
  _perfSuggestionShown = false;
  document.getElementById("perf-suggestion")?.remove();
}

// ── Header overflow indicator ─────────────────────────────────────────────────

/**
 * Toggle the `overflows` class on the header actions container.
 * The CSS uses this to apply a right-edge fade gradient that signals
 * to the user that more controls are accessible via horizontal scroll.
 */
function updateHeaderOverflow(): void {
  const actions = document.getElementById("header-actions");
  if (!actions) return;
  // Use rAF so layout is settled before measuring scrollWidth
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
    idle: "Idle", loading: "Loading", running: "Running", paused: "Paused", error: "Error",
  };
  dot.className     = `status-dot ${state}`;
  label.textContent = labels[state];

  if (state === "loading") showLoadingOverlay();

  // Clear game/system metadata when returning to a neutral state
  if (state === "idle" || state === "error") {
    setStatusGame("—");
    setStatusSystem("—");
    setStatusTier(null);
  }
}

// ── Visibility helpers ────────────────────────────────────────────────────────

export function hideLanding(): void      { el("#landing").classList.add("hidden"); }
export function showLanding(): void      { el("#landing").classList.remove("hidden"); }
export function showLoadingOverlay(): void {
  const o = document.getElementById("loading-overlay");
  if (o) { o.classList.add("visible"); }
}
export function hideLoadingOverlay(): void {
  const o = document.getElementById("loading-overlay");
  if (o) { o.classList.remove("visible"); }
}
export function showEjsContainer(): void {
  const c = document.getElementById("ejs-container");
  if (c) c.classList.add("visible");
}
export function hideEjsContainer(): void {
  const c = document.getElementById("ejs-container");
  if (c) c.classList.remove("visible");
}
export function setLoadingMessage(msg: string): void {
  const el2 = document.getElementById("loading-message");
  if (el2) el2.textContent = msg;
}
export function setStatusGame(name: string): void {
  const el2 = document.getElementById("status-game");
  if (el2) el2.textContent = name;
}
export function setStatusSystem(name: string): void {
  const el2 = document.getElementById("status-system");
  if (el2) el2.textContent = name;
}
function setStatusTier(tier: PerformanceTier | null): void {
  const el2 = document.getElementById("status-tier");
  if (el2) el2.textContent = tier ? formatTierLabel(tier) : "—";
}
let _errorDismissTimer: ReturnType<typeof setTimeout> | null = null;

export function showError(msg: string): void {
  const banner = document.getElementById("error-banner");
  const msgEl  = document.getElementById("error-message");
  if (!banner || !msgEl) return;
  msgEl.textContent = msg;
  banner.classList.add("visible");

  // Auto-dismiss after 8 s (cancelled if user manually dismisses or a new error arrives)
  if (_errorDismissTimer !== null) clearTimeout(_errorDismissTimer);
  _errorDismissTimer = setTimeout(() => {
    hideError();
    _errorDismissTimer = null;
  }, 8000);
}
export function hideError(): void {
  if (_errorDismissTimer !== null) {
    clearTimeout(_errorDismissTimer);
    _errorDismissTimer = null;
  }
  document.getElementById("error-banner")?.classList.remove("visible");
}

/**
 * Show a non-blocking info/success toast that auto-dismisses after 5 s.
 * Uses the same positioning as the error banner but with a neutral style.
 */
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
  closeBtn.addEventListener("click", () => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 200);
  });
  toast.appendChild(closeBtn);
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add("visible"));
  setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 200);
  }, 5000);
}
