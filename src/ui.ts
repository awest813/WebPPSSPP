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
import type { Settings } from "./main.js";

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
  emulator:         PSPEmulator;
  library:          GameLibrary;
  settings:         Settings;
  deviceCaps:       DeviceCapabilities;
  onLaunchGame:     (file: File, systemId: string) => Promise<void>;
  onSettingsChange: (patch: Partial<Settings>) => void;
  onReturnToLibrary: () => void;
}

/** Wire all DOM events, emulator callbacks, and render the initial library. */
export function initUI(opts: UIOptions): void {
  const { emulator, library, settings, deviceCaps,
          onLaunchGame, onSettingsChange, onReturnToLibrary } = opts;

  // ── File drop / pick ──────────────────────────────────────────────────────
  const fileInput = el<HTMLInputElement>("#file-input");
  const dropZone  = el("#drop-zone");
  let dragDepth = 0;

  const handleFileChosen = (file: File) => {
    resolveSystemAndAdd(file, library, settings, onLaunchGame);
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
    buildInGameControls(emulator, settings, onSettingsChange, onReturnToLibrary);
    showFPSOverlay(settings.showFPS);
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
    buildInGameControls(emulator, settings, onSettingsChange, onReturnToLibrary);
    showFPSOverlay(settings.showFPS);
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

  // ── Landing header controls ───────────────────────────────────────────────
  buildLandingControls(settings, deviceCaps, library, onSettingsChange, emulator);

  // ── Initial library render ────────────────────────────────────────────────
  renderLibrary(library, settings, onLaunchGame, emulator);
}

// ── Library rendering ─────────────────────────────────────────────────────────

export async function renderLibrary(
  library:      GameLibrary,
  settings:     Settings,
  onLaunchGame: (file: File, systemId: string) => Promise<void>,
  emulatorRef?: PSPEmulator
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
    fragment.appendChild(buildGameCard(game, library, settings, onLaunchGame, emulatorRef));
  }
  grid.appendChild(fragment);
}

function buildGameCard(
  game:         GameMetadata,
  library:      GameLibrary,
  settings:     Settings,
  onLaunchGame: (file: File, systemId: string) => Promise<void>,
  emulatorRef?: PSPEmulator
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
    if (!confirm(`Remove "${game.name}" from your library?\n\nThe file will not be deleted from your device.`)) return;
    await library.removeGame(game.id);
    renderLibrary(library, settings, onLaunchGame, emulatorRef);
  });

  const playOverlay = make("div", { class: "game-card__play-overlay", "aria-hidden": "true" });
  const playBtn     = make("div", { class: "game-card__play-btn" }, "▶");
  playOverlay.appendChild(playBtn);

  card.append(icon, info, btnRemove, playOverlay);

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

  // Launch using blob-direct path — avoids the expensive new File([blob]) copy
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

      const entry = await library.getGame(game.id);
      if (!entry) {
        hideLoadingOverlay();
        showError(`Game "${game.name}" not found in library.`);
        return;
      }

      const file = new File([blob], entry.fileName, { type: blob.type });
      await library.markPlayed(game.id);
      await onLaunchGame(file, entry.systemId);
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
    psp:       "🎮",
    nes:       "🕹",
    snes:      "🕹",
    gba:       "🎯",
    gbc:       "🟢",
    gb:        "⬜",
    nds:       "📱",
    n64:       "🎮",
    psx:       "🔵",
    segaMD:    "⚡",
    segaGG:    "🔶",
    segaMS:    "📺",
    atari2600: "👾",
    arcade:    "🕹",
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

async function resolveSystemAndAdd(
  file:         File,
  library:      GameLibrary,
  settings:     Settings,
  onLaunchGame: (file: File, systemId: string) => Promise<void>
): Promise<void> {
  const detected = detectSystem(file.name);

  let system: SystemInfo | null = null;

  if (detected === null) {
    showError(
      `Unrecognised file type: "${file.name}".\n` +
      `Supported extensions: ${ALL_EXTENSIONS.map(e => `.${e}`).join("  ·  ")}`
    );
    return;
  } else if (Array.isArray(detected)) {
    system = await pickSystem(file.name, detected);
    if (!system) return; // user cancelled
  } else {
    system = detected;
  }

  // Duplicate detection — offer to play the existing library entry instead
  try {
    const existing = await library.findByFileName(file.name, system.id);
    if (existing) {
      const playExisting = confirm(
        `"${existing.name}" is already in your library.\n\nPlay the existing copy?`
      );
      if (!playExisting) return;

      showLoadingOverlay();
      setLoadingMessage(`Loading ${existing.name}…`);
      try {
        const entry = await library.getGame(existing.id);
        if (!entry) throw new Error("Library entry not found.");
        const existingFile = new File([entry.blob], entry.fileName, { type: entry.blob.type });
        await library.markPlayed(existing.id);
        await onLaunchGame(existingFile, entry.systemId);
      } catch (err) {
        hideLoadingOverlay();
        showError(`Could not load game: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
  } catch {
    // If duplicate check fails, fall through and add normally
  }

  showLoadingOverlay();
  setLoadingMessage("Adding game to library…");

  try {
    const entry = await library.addGame(file, system.id);
    settings.lastGameName = entry.name;
    // Re-render library in the background — we'll show it when the game ends
    renderLibrary(library, settings, onLaunchGame);
    await onLaunchGame(file, system.id);
  } catch (err) {
    hideLoadingOverlay();
    showError(`Could not add game: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Header controls ───────────────────────────────────────────────────────────

function buildLandingControls(
  settings:         Settings,
  deviceCaps:       DeviceCapabilities,
  library:          GameLibrary,
  onSettingsChange: (patch: Partial<Settings>) => void,
  emulatorRef?:     PSPEmulator
): void {
  const container = el("#header-actions");
  container.innerHTML = "";

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
    openSettingsPanel(settings, deviceCaps, library, onSettingsChange, emulatorRef);
  });

  // Low-spec / Chromebook indicator
  if (deviceCaps.isLowSpec || deviceCaps.isChromOS) {
    const label = deviceCaps.isChromOS ? "⚡ Chromebook" : "⚡ Low-spec";
    const tip   = deviceCaps.isChromOS
      ? "Chromebook detected — Performance mode recommended"
      : "Performance mode recommended for this device";
    const chip = make("span", { class: "perf-chip perf-chip--warn", title: tip }, label);
    container.appendChild(chip);
  }

  container.appendChild(btnSettings);
}

function buildInGameControls(
  emulator:          PSPEmulator,
  settings:          Settings,
  onSettingsChange:  (patch: Partial<Settings>) => void,
  onReturnToLibrary: () => void
): void {
  const container = el("#header-actions");
  container.innerHTML = "";

  const btnLibrary = make("button", { class: "btn", title: "Back to library (Esc)" }, "← Library");
  btnLibrary.addEventListener("click", onReturnToLibrary);

  const btnSave = make("button", { class: "btn", title: "Quick Save (F5)" }, "💾 Save");
  btnSave.addEventListener("click", () => emulator.quickSave(1));

  const btnLoad = make("button", { class: "btn", title: "Quick Load (F7)" }, "📂 Load");
  btnLoad.addEventListener("click", () => emulator.quickLoad(1));

  const btnReset = make("button", { class: "btn btn--danger", title: "Reset game (F1)" }, "↺ Reset");
  btnReset.addEventListener("click", () => {
    if (confirm("Reset the game? Unsaved progress will be lost.")) emulator.reset();
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
    showFPSOverlay(settings.showFPS);
    // Enable/disable FPS callbacks to save CPU on low-spec devices when hidden
    emulator.setFPSMonitorEnabled(settings.showFPS);
  });

  // Volume control — icon acts as a mute toggle; slider sets precise level
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
  container.append(btnLibrary, btnSave, btnLoad, btnReset, btnFPS, volWrap);
}

// ── Settings panel ────────────────────────────────────────────────────────────

export function openSettingsPanel(
  settings:         Settings,
  deviceCaps:       DeviceCapabilities,
  library:          GameLibrary,
  onSettingsChange: (patch: Partial<Settings>) => void,
  emulatorRef?:     import("./emulator.js").PSPEmulator
): void {
  const panel   = document.getElementById("settings-panel")!;
  const content = document.getElementById("settings-content")!;
  const previousFocus = document.activeElement as HTMLElement | null;

  buildSettingsContent(content, settings, deviceCaps, library, onSettingsChange, emulatorRef);
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
  onSettingsChange: (patch: Partial<Settings>) => void,
  emulatorRef?:     import("./emulator.js").PSPEmulator
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

  // ── FPS Overlay toggle ────────────────────────────────────────────────────
  const fpsRow = make("label", { class: "radio-row" });
  const fpsCheck = make("input", { type: "checkbox" }) as HTMLInputElement;
  fpsCheck.checked = settings.showFPS;
  fpsCheck.addEventListener("change", () => {
    onSettingsChange({ showFPS: fpsCheck.checked });
    showFPSOverlay(fpsCheck.checked);
    emulatorRef?.setFPSMonitorEnabled(fpsCheck.checked);
  });
  const fpsTxt = make("span", { class: "radio-row__text" });
  fpsTxt.append(
    make("span", { class: "radio-row__label" }, "Show FPS overlay"),
    make("span", { class: "radio-row__desc"  }, "Display real-time framerate and performance tier while playing")
  );
  fpsRow.append(fpsCheck, fpsTxt);
  perfSection.appendChild(fpsRow);

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

  // ── Library Stats ─────────────────────────────────────────────────────────
  const libSection = make("div", { class: "settings-section" });
  libSection.appendChild(make("h4", { class: "settings-section__title" }, "Library Storage"));

  const statsEl = make("p", { class: "device-info" }, "Calculating…");
  libSection.appendChild(statsEl);

  Promise.all([library.count(), library.totalSize()]).then(([count, total]) => {
    statsEl.textContent = `${count} game${count !== 1 ? "s" : ""} · ${formatBytes(total)} stored locally`;
  }).catch(() => { statsEl.textContent = "Could not load library stats."; });

  const btnClear = make("button", { class: "btn btn--danger", style: "margin-top:10px" }, "Clear Library");
  btnClear.addEventListener("click", async () => {
    if (!confirm("Remove all games from your library?\n\nThis will delete all stored ROM data. This cannot be undone.")) return;
    await library.clearAll();
    document.getElementById("settings-panel")!.hidden = true;
    document.title = "RetroVault";
    // Re-render
    const onLaunchGame = window.__onLaunchGame;
    if (onLaunchGame) renderLibrary(library, settings, onLaunchGame);
  });
  libSection.appendChild(btnClear);

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

  container.append(perfSection, deviceSection, libSection, sysSection);
}

// ── FPS overlay ───────────────────────────────────────────────────────────────

function showFPSOverlay(show: boolean): void {
  const overlay = document.getElementById("fps-overlay");
  if (overlay) overlay.hidden = !show;
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
