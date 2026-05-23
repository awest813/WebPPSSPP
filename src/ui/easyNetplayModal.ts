/**
 * easyNetplayModal.ts â€” Play Together modal (Host / Join / LAN / Browse / Watch)
 *
 * Extracted from src/ui.ts as part of the modularisation effort.
 * The modal is a self-contained overlay with its own tab bar, panel builders,
 * and event lifecycle.  It imports only leaf modules (never ui.ts).
 */

import type { NetplayManager } from "../multiplayer.js";
import { resolveNetplayRoomKey } from "../multiplayer.js";
import { EasyNetplayManager } from "../netplay/EasyNetplayManager.js";
import type { EasyNetplayRoom } from "../netplay/netplayTypes.js";
import { normaliseInviteCode, INVITE_CODE_LEN } from "../netplay/signalingClient.js";
import { checkSystemSupport } from "../netplay/compatibility.js";
import { store } from "../store/index.js";
import { ICON_CLOSE_X_SVG } from "../chromeIcons.js";
import { LEGACY_EVENTS } from "../legacy.js";
import { createElement as make } from "./dom.js";
import {
  getEasyNetplayManager as sharedGetEasyNetplayManager,
  renderEasyDiagnosticEntry as sharedRenderEasyDiagnosticEntry,
  renderRoomCard as sharedRenderRoomCard,
} from "./easyNetplayShared.js";
import { isTopmostOverlay } from "./modals.js";
import { showInfoToast } from "./toasts.js";

const APP_NAME = "RetroOasis";

const OVERLAY_FADE_DELAY_MS = 200;
const LATENCY_GOOD_THRESHOLD_MS = 80;
const LATENCY_WARN_THRESHOLD_MS = 200;

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

const _BROWSE_AUTO_REFRESH_MS = 30_000;

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
  onOpenPlayTogetherSettings?: () => void;
  initialJoinCode?: string | null;
}): void {
  const { netplayManager, currentGameName, currentGameId, currentSystemId, onOpenPlayTogetherSettings, initialJoinCode } = opts;
  const serverUrl = netplayManager?.serverUrl ?? "";
  const username  = netplayManager?.username  ?? "";
  const netplayEnabled = netplayManager?.enabled ?? false;

  const easyMgr = sharedGetEasyNetplayManager(serverUrl);
  const panelCleanups: Array<() => void> = [];

  const overlay = make("div", { class: "confirm-overlay easy-netplay-overlay" });
  const dialog  = make("div", {
    class:      "confirm-box easy-netplay-dialog",
    role:       "dialog",
    "aria-modal": "true",
    "aria-label": "Play Together lobby",
  });

  const header = make("div", { class: "enp-header" });
  const brand = make("div", { class: "enp-header-brand" });
  const logoImg = make("span", { class: "enp-header__logo", "aria-hidden": "true" });
  logoImg.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M7 12h10M12 7v10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="7" cy="12" r="4" stroke="currentColor" stroke-width="1.8"/><circle cx="17" cy="12" r="4" stroke="currentColor" stroke-width="1.8"/></svg>`;
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
      const detail = entry.detail ? ` \u2014 ${entry.detail}` : "";
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

  const btnClose = make("button", {
    class:       "enp-close",
    "aria-label": "Close multiplayer",
  }) as HTMLButtonElement;
  btnClose.innerHTML = ICON_CLOSE_X_SVG;
  header.appendChild(btnClose);
  dialog.appendChild(header);
  const preTabs = make("div", { class: "enp-pre-tabs" });
  dialog.appendChild(preTabs);

  const needsServerUrl = serverUrl.trim().length === 0;
  const needsEnable = !netplayEnabled;
  if (needsServerUrl || needsEnable) {
    const setupStrip = make("div", { class: "enp-setup-strip", role: "region", "aria-label": "Online play setup" });
    const setupTitle = make("p", { class: "enp-setup-strip__title" }, "Set up multiplayer (one minute)");
    const setupSteps = make("ol", { class: "enp-setup-strip__steps" });
    const step1 = needsEnable
      ? "Open Settings \u2192 Play Together and turn on Online play."
      : "Online play is on \u2014 add your server URL in Settings \u2192 Play Together.";
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

  panelCleanups.push(_buildHostPanel(panels[0]!, {
    easyMgr, username, currentGameId, currentGameName, currentSystemId, serverUrl,
    onRoomCreated: () => {/* panel updates itself via onEvent */},
  }));

  let _fillJoinCode: ((code: string) => void) | null = null;
  let _quickJoinCode: ((code: string) => void) | null = null;
  panelCleanups.push(_buildJoinPanel(panels[1]!, {
    easyMgr, username, currentGameId, currentGameName, currentSystemId, serverUrl,
    onCodeSetterReady: (setter) => { _fillJoinCode = setter; },
    onJoinActionReady: (joinNow) => { _quickJoinCode = joinNow; },
  }));

  panels[2]!.appendChild(make("p", { class: "enp-panel-desc", role: "status" }, "Loading LAN rooms..."));
  void import("../multiplayer/ui/MultiplayerHome.js")
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
      switchTab("watch");
      _fillWatchCode?.(code);
      _quickWatchCode?.(code);
    },
  }));

  panelCleanups.push(_buildWatchPanel(panels[4]!, {
    easyMgr, username: username || "Anonymous", serverUrl,
    onCodeSetterReady: (setter) => { _fillWatchCode = setter; },
    onWatchActionReady: (watchNow) => { _quickWatchCode = watchNow; },
  }));

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  if (initialJoinCode && initialJoinCode.length > 0) {
    const normalised = normaliseInviteCode(initialJoinCode);
    if (normalised.length > 0) {
      switchTab("join");
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
  store.set("netplay", { active: true });
  requestAnimationFrame(() => {
    overlay.classList.add("confirm-overlay--visible");
    tabBtns[0]?.focus();
  });
}

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

  // â”€â”€ Game context banner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const hasGame = !!(currentGameId || currentGameName);
  const gameBanner = make("div", { class: "enp-host-game-banner" });
  if (hasGame) {
    const gameIcon = `<svg class="enp-host-game-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M12 12h.01"/><path d="M7 10v2M9 10v2" stroke-width="1.8"/></svg>`;
    gameBanner.innerHTML = `${gameIcon}<span class="enp-host-game-title">Hosting: <strong>${currentGameName ?? currentGameId ?? "Unknown Game"}</strong></span>`;
    gameBanner.classList.add("enp-host-game-banner--loaded");
  } else {
    gameBanner.classList.add("enp-host-game-banner--empty");
    gameBanner.innerHTML = `
      <div class="enp-no-game-state">
        <svg class="enp-no-game-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M12 12h.01"/><path d="M7 10v2M9 10v2" stroke-width="1.8"/></svg>
        <p class="enp-no-game-title">No game loaded</p>
        <p class="enp-no-game-sub">Open a game ROM first, then come back to host a session for friends.</p>
      </div>`;
    const pickBtn = make("button", { class: "btn enp-no-game-btn", type: "button" }, "Choose Game File") as HTMLButtonElement;
    pickBtn.addEventListener("click", () => {
      document.dispatchEvent(new CustomEvent(LEGACY_EVENTS.closeEasyNetplay));
      setTimeout(() => {
        const picker = document.getElementById("file-input") as HTMLInputElement | null;
        picker?.click();
      }, 40);
    });
    gameBanner.querySelector(".enp-no-game-state")?.appendChild(pickBtn);
  }
  container.appendChild(gameBanner);

  if (!hasGame) return () => {};

  // â”€â”€ Privacy radio cards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const cardDefs: Array<{ value: string; label: string; desc: string; icon: string }> = [
    {
      value: "local",
      label: "Same Wi-Fi / LAN",
      desc: "Lowest latency. Works without a server â€” everyone must be on the same network.",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.75 8.75A11.73 11.73 0 0 1 12 5c3.9 0 7.37 1.9 9.5 4.75"/><path d="M4.75 11.75A7.73 7.73 0 0 1 12 9c2.87 0 5.39 1.47 6.88 3.69"/><path d="M8 14.5A3.87 3.87 0 0 1 12 13c1.55 0 2.91.85 3.63 2.1"/><circle cx="12" cy="18" r="1"/></svg>`,
    },
    {
      value: "private",
      label: "Private (invite code)",
      desc: "Only players with the 6-character code can join. Best for playing with specific friends.",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
    },
    {
      value: "public",
      label: "Public lobby",
      desc: "Visible in the Browse tab â€” anyone playing the same game can join.",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
    },
  ];

  const radioGroup = make("div", { class: "enp-radio-group", role: "radiogroup", "aria-label": "Room visibility" });
  let selectedPrivacy = "private"; // sensible default
  const cardEls: HTMLElement[] = [];

  for (const def of cardDefs) {
    const card = make("button", {
      type: "button",
      class: "enp-radio-card" + (def.value === selectedPrivacy ? " enp-radio-card--active" : ""),
      role: "radio",
      "aria-checked": def.value === selectedPrivacy ? "true" : "false",
      "data-value": def.value,
    }) as HTMLButtonElement;
    card.innerHTML = `
      <span class="enp-radio-card__icon" aria-hidden="true">${def.icon}</span>
      <span class="enp-radio-card__content">
        <span class="enp-radio-card__label">${def.label}</span>
        <span class="enp-radio-card__desc">${def.desc}</span>
      </span>
      <span class="enp-radio-card__check" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </span>`;
    card.addEventListener("click", () => {
      selectedPrivacy = def.value;
      cardEls.forEach((c) => {
        const active = c.dataset["value"] === selectedPrivacy;
        c.classList.toggle("enp-radio-card--active", active);
        c.setAttribute("aria-checked", String(active));
      });
    });
    radioGroup.appendChild(card);
    cardEls.push(card);
  }
  container.appendChild(radioGroup);

  if (!serverUrl) {
    container.appendChild(make("p", { class: "enp-server-warn" },
      "No server URL configured. Add one in Settings â†’ Play Together to host online or private rooms."
    ));
  }

  const statusArea = make("div", {
    class: "enp-status-area",
    role: "status",
    "aria-live": "polite",
  });
  statusArea.hidden = true;
  container.appendChild(statusArea);

  const btnCreate = make("button", {
    class: "btn btn--primary enp-btn-create",
  }) as HTMLButtonElement;
  btnCreate.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>&ensp;Host Game`;

  let activeUnsub: (() => void) | null = null;

  btnCreate.addEventListener("click", async () => {
    btnCreate.disabled = true;
    btnCreate.textContent = "Creating room\u2026";
    statusArea.hidden = false;
    statusArea.innerHTML = "";
    statusArea.appendChild(make("p", { class: "enp-diag enp-diag--info" }, "Connecting\u2026"));

    activeUnsub?.();
    activeUnsub = easyMgr.onEvent(ev => {
      if (ev.type === "diagnostic") {
        const item = sharedRenderEasyDiagnosticEntry(ev.diagnostic.level, ev.diagnostic.message, ev.diagnostic.detail);
        if (statusArea.children.length === 1 && statusArea.children[0]!.textContent === "Connecting\u2026") {
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
        btnCreate.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>&ensp;Try Again`;
      }
    });

    await easyMgr.hostRoom({
      hostName:    username || "Anonymous",
      gameId:      currentGameId  ?? currentGameName ?? "unknown",
      gameName:    currentGameName ?? currentGameId  ?? "Unknown Game",
      systemId:    currentSystemId ?? "psp",
      privacy:     (selectedPrivacy as import("../netplay/netplayTypes.js").RoomPrivacy),
      maxPlayers:  2,
    });
  });

  container.appendChild(btnCreate);
  return () => {
    activeUnsub?.();
    activeUnsub = null;
  };
}

function _buildJoinPanel(
  container: HTMLElement,
  opts: {
    easyMgr:          EasyNetplayManager;
    username:         string;
    currentGameId?:   string | null;
    currentGameName?: string | null;
    currentSystemId?: string | null;
    serverUrl:        string;
    onCodeSetterReady?: (setter: (code: string) => void) => void;
    onJoinActionReady?: (joinNow: (code: string) => void) => void;
  }
): () => void {
  const { easyMgr, username, serverUrl } = opts;

  container.appendChild(make("p", { class: "enp-panel-desc" },
    "Enter the invite code your friend shared to join their room."
  ));

  // ── Segmented code input (6-box, 2FA-style) ──────────────────────────────
  const segWrap = make("div", { class: "enp-seg-wrap" });
  segWrap.appendChild(make("label", { class: "enp-label", for: "enp-seg-0" }, "Invite code"));
  const segRow  = make("div", { class: "enp-seg-row" });
  const boxes: HTMLInputElement[] = [];

  for (let i = 0; i < INVITE_CODE_LEN; i++) {
    const box = make("input", {
      id:          i === 0 ? "enp-seg-0" : `enp-seg-${i}`,
      type:        "text",
      class:       "enp-seg-box",
      maxlength:   "1",
      inputmode:   "text",
      autocomplete: "off",
      autocapitalize: "characters",
      autocorrect: "off",
      spellcheck:  "false",
      "aria-label": `Invite code character ${i + 1} of ${INVITE_CODE_LEN}`,
    }) as HTMLInputElement;

    box.addEventListener("input", () => {
      const ch = normaliseInviteCode(box.value).slice(-1);
      box.value = ch;
      codeError.hidden = true;
      syncSegBoxes();
      if (ch && i < INVITE_CODE_LEN - 1) boxes[i + 1]!.focus();
    });

    box.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Backspace" && !box.value && i > 0) {
        e.preventDefault();
        boxes[i - 1]!.value = "";
        boxes[i - 1]!.focus();
        syncSegBoxes();
      } else if (e.key === "ArrowLeft" && i > 0) {
        e.preventDefault();
        boxes[i - 1]!.focus();
      } else if (e.key === "ArrowRight" && i < INVITE_CODE_LEN - 1) {
        e.preventDefault();
        boxes[i + 1]!.focus();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const code = getFullCode();
        if (code.length === INVITE_CODE_LEN) void attemptJoin(code);
      }
    });

    box.addEventListener("paste", (e: ClipboardEvent) => {
      e.preventDefault();
      const pasted = normaliseInviteCode(e.clipboardData?.getData("text") ?? "");
      for (let j = 0; j < INVITE_CODE_LEN; j++) boxes[j]!.value = pasted[j] ?? "";
      codeError.hidden = true;
      syncSegBoxes();
      boxes[Math.min(pasted.length, INVITE_CODE_LEN - 1)]!.focus();
    });

    box.addEventListener("focus", () => box.select());
    segRow.appendChild(box);
    boxes.push(box);
  }

  const getFullCode = () => boxes.map(b => b.value).join("");
  const syncSegBoxes = () => {
    const code = getFullCode();
    const full = code.length === INVITE_CODE_LEN;
    btnJoin.disabled = !full;
    segRow.classList.toggle("enp-seg-row--complete", full);
  };

  const btnPaste = make("button", { type: "button", class: "btn enp-btn-paste-code" }, "Paste") as HTMLButtonElement;
  btnPaste.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard?.readText();
      const norm = normaliseInviteCode(text ?? "");
      for (let j = 0; j < INVITE_CODE_LEN; j++) boxes[j]!.value = norm[j] ?? "";
      codeError.hidden = true;
      syncSegBoxes();
      boxes[Math.min(norm.length, INVITE_CODE_LEN - 1)]!.focus();
    } catch {
      boxes[0]!.focus();
      showInfoToast("Clipboard paste is blocked. Type the code here instead.", "warning");
    }
  });

  const segActions = make("div", { class: "enp-seg-actions" });
  segActions.append(segRow, btnPaste);
  segWrap.appendChild(segActions);
  container.appendChild(segWrap);

  opts.onCodeSetterReady?.((code: string) => {
    const norm = normaliseInviteCode(code);
    for (let j = 0; j < INVITE_CODE_LEN; j++) boxes[j]!.value = norm[j] ?? "";
    syncSegBoxes();
    boxes[Math.min(norm.length, INVITE_CODE_LEN - 1)]!.focus();
  });

  const codeError = make("p", {
    class: "enp-diag enp-diag--error",
    role: "alert",
    "aria-live": "assertive",
  });
  codeError.hidden = true;
  container.appendChild(codeError);

  if (!serverUrl) {
    container.appendChild(make("p", { class: "enp-server-warn" },
      "No server URL configured. Joining by code requires a server. Add one in Settings \u2192 Play Together."
    ));
  }

  const statusArea = make("div", {
    class: "enp-status-area",
    role: "status",
    "aria-live": "polite",
  });
  statusArea.hidden = true;
  container.appendChild(statusArea);

  const btnJoin = make("button", {
    class:    "btn btn--primary enp-btn-join",
    disabled: "",
  }) as HTMLButtonElement;
  btnJoin.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>&ensp;Join Room`;

  let activeUnsub: (() => void) | null = null;
  const attemptJoin = async (prefilledCode?: string) => {
    const code = normaliseInviteCode(prefilledCode ?? getFullCode());
    if (prefilledCode) {
      for (let j = 0; j < INVITE_CODE_LEN; j++) boxes[j]!.value = code[j] ?? "";
      syncSegBoxes();
    }
    if (code.length < INVITE_CODE_LEN) {
      codeError.textContent = `Enter the full invite code (${INVITE_CODE_LEN} characters).`;
      codeError.hidden = false;
      return;
    }

    btnJoin.disabled = true;
    btnJoin.textContent = "Joining\u2026";
    statusArea.hidden  = false;
    statusArea.innerHTML = "";
    statusArea.appendChild(make("p", { class: "enp-diag enp-diag--info" }, "Connecting\u2026"));

    activeUnsub?.();
    activeUnsub = easyMgr.onEvent(ev => {
      if (ev.type === "diagnostic") {
        if (statusArea.children.length === 1 && statusArea.children[0]!.textContent === "Connecting\u2026") {
          statusArea.innerHTML = "";
        }
        statusArea.appendChild(sharedRenderEasyDiagnosticEntry(ev.diagnostic.level, ev.diagnostic.message, ev.diagnostic.detail));
      }
      if (ev.type === "room_joined") {
        activeUnsub?.();
        activeUnsub = null;
        statusArea.innerHTML = "";
        sharedRenderRoomCard(statusArea, ev.room, { showLeaveBtn: true, easyMgr, isHost: false, showToast: showInfoToast });
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
        btnJoin.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>&ensp;Try Again`;
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
  opts.onJoinActionReady?.((code: string) => { void attemptJoin(code); });

  container.appendChild(btnJoin);
  return () => {
    activeUnsub?.();
    activeUnsub = null;
  };
}

function _buildBrowsePanel(
  container: HTMLElement,
  opts: {
    easyMgr:          EasyNetplayManager;
    currentGameName?: string | null;
    currentSystemId?: string | null;
    serverUrl?:       string;
    onJoinByCode?:    (code: string) => void;
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

  if (!serverUrl) {
    container.appendChild(make("p", { class: "enp-server-warn" },
      "No server URL configured. Add one in Settings \u2192 Play Together to browse online rooms."
    ));
  }

  const filterWrap = make("div", { class: "enp-filter-row" });
  const filterBtns: HTMLButtonElement[] = [];
  const filters = [
    { id: "nearby", label: "\uD83D\uDCDE Nearby" },
    { id: "all",    label: "\uD83C\uDF10 All Rooms" },
  ];
  if (gameRoomKey) {
    filters.splice(1, 0, { id: "this_game", label: "\uD83C\uDFAF This Game" });
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
        : "No open rooms right now \u2014 be the first to create one!";
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
            showInfoToast(`Code: ${room.code} \u2014 switch to the Join tab to connect`);
          }
        });
        card.appendChild(btnJoinRoom);
      }

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
            showInfoToast(`Code: ${room.code} \u2014 open Watch tab or switch to Join tab`);
          }
        });
        card.appendChild(btnWatch);
      }

      frag.appendChild(card);
    }
    listEl.appendChild(frag);
  };

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
      void doRefresh().then(startAutoRefresh).catch(startAutoRefresh);
    }, _BROWSE_AUTO_REFRESH_MS);
    countdownTimerId = setInterval(() => {
      const secsLeft = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
      if (secsLeft === lastShownSecs) return;
      lastShownSecs = secsLeft;
      countdownEl.textContent = secsLeft > 0 ? `Auto-refresh in ${secsLeft}s` : "";
    }, 1_000);
  };

  const doRefresh = async () => {
    if (!serverUrl) {
      renderRooms([]);
      return;
    }
    if (loadAbort) loadAbort.abort();
    loadAbort = new AbortController();
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing\u2026";
    countdownEl.textContent = "";

    listEl.innerHTML = "";
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

  renderRooms([]);
  void doRefresh().then(startAutoRefresh).catch(startAutoRefresh);
  return () => {
    stopAutoRefresh();
    loadAbort?.abort();
    loadAbort = null;
  };
}

function _buildWatchPanel(
  container: HTMLElement,
  opts: {
    easyMgr:             EasyNetplayManager;
    username:            string;
    serverUrl?:          string;
    onCodeSetterReady?:  (setter: (code: string) => void) => void;
    onWatchActionReady?: (watchNow: (code: string) => void) => void;
  }
): () => void {
  const { easyMgr, serverUrl } = opts;

  container.appendChild(make("p", { class: "enp-panel-desc" },
    "Enter an invite code to watch a game as a spectator. You'll see the session but won't be able to play."
  ));

  const codeField = make("div", { class: "enp-field" });
  codeField.appendChild(make("label", { class: "enp-label", for: "enp-watch-code" }, "Invite code"));
  const codeInput = make("input", {
    type:          "text",
    id:            "enp-watch-code",
    name:          "spectatorInviteCode",
    class:         "enp-code-input",
    placeholder:   "ABC123\u2026",
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

  const codeError = make("p", {
    class: "enp-diag enp-diag--error",
    role: "alert",
    "aria-live": "assertive",
  });
  codeError.hidden = true;
  container.appendChild(codeError);

  if (!serverUrl) {
    container.appendChild(make("p", { class: "enp-server-warn" },
      "No server URL configured. Spectating requires a server. Add one in Settings \u2192 Play Together."
    ));
  }

  const statusArea = make("div", {
    class: "enp-status-area",
    role: "status",
    "aria-live": "polite",
  });
  statusArea.hidden = true;
  container.appendChild(statusArea);

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
    btnWatch.textContent = "Connecting\u2026";
    statusArea.hidden   = false;
    statusArea.innerHTML = "";
    statusArea.appendChild(make("p", { class: "enp-diag enp-diag--info" }, "Connecting\u2026"));

    activeUnsub?.();
    activeUnsub = easyMgr.onEvent(ev => {
      if (ev.type === "diagnostic") {
        if (statusArea.children.length === 1 && statusArea.children[0]!.textContent === "Connecting\u2026") {
          statusArea.innerHTML = "";
        }
        statusArea.appendChild(sharedRenderEasyDiagnosticEntry(ev.diagnostic.level, ev.diagnostic.message, ev.diagnostic.detail));
      }
      if (ev.type === "spectator_joined") {
        activeUnsub?.();
        activeUnsub = null;
        const { room, spectatorCount } = ev.session;
        statusArea.innerHTML = "";
        const card = make("div", { class: "enp-active-room enp-active-room--spectating" });
        const codeWrap = make("div", { class: "enp-active-room__code-wrap" });
        codeWrap.appendChild(make("span", { class: "enp-active-room__code-label" }, "Room"));
        codeWrap.appendChild(make("span", { class: "enp-active-room__code" }, room.name));
        card.appendChild(codeWrap);
        const info = make("div", { class: "enp-active-room__info" });
        info.appendChild(make("span", { class: "enp-active-room__name" }, `${room.isLocal ? "\uD83D\uDCDE Local" : "\uD83C\uDF10 Online"} \u00B7 ${room.playerCount}/${room.maxPlayers} players`));
        if (room.gameName) {
          info.appendChild(make("span", { class: "enp-active-room__detail" }, `Game: ${room.gameName}`));
        }
        if (spectatorCount > 0) {
          info.appendChild(make("span", { class: "enp-active-room__detail" }, `\uD83D\uDC41 ${spectatorCount} spectator${spectatorCount !== 1 ? "s" : ""}`));
        }
        card.appendChild(info);
        card.appendChild(make("p", { class: "enp-active-room__waiting" }, "\uD83D\uDC41 Spectating \u2014 watching the game\u2026"));
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
