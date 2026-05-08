/**
 * MultiplayerHome.ts — Premium LAN Rooms dashboard.
 * PlayStation/Switch-quality visual design with animated status,
 * connection quality visualization, and contextual game info.
 */

import { createElement as make } from "../../ui/dom.js";
import { getLanemuService } from "../lanemu/LanemuSingleton.js";
import type { LanemuStatus } from "../lanemu/LanemuStatus.js";
import { store } from "../../store/index.js";

export function buildMultiplayerHome(container: HTMLElement): void {
  const service = getLanemuService();
  
  const renderHome = () => {
    container.innerHTML = "";
    
    // ── Header with gradient title ──
    const header = make("div", { class: "multiplayer-dashboard-header" });
    header.appendChild(make("h2", { class: "dashboard-title" }, "RetroOasis LAN Rooms"));
    header.appendChild(make("p", { class: "dashboard-subtitle" }, "Play Ad Hoc and LAN games with friends over a virtual network."));
    
    // ── Status bar with animated dot and IP ──
    const statusBar = make("div", { class: "multiplayer-status-bar", "aria-live": "polite" });
    statusBar.innerHTML = `
      <div class="status-indicator">
        <span class="status-dot status-dot--inactive" id="lanemu-dot" aria-hidden="true"></span>
        <span id="lanemu-status-text">LANemu: Checking…</span>
      </div>
      <div class="status-ip" id="lanemu-ip-display" style="display:none">
        IP: <strong id="lanemu-ip-val">—</strong>
      </div>
    `;
    header.appendChild(statusBar);
    container.appendChild(header);

    // ── Status update handler ──
    const updateStatus = (status: LanemuStatus) => {
      const dot = statusBar.querySelector("#lanemu-dot") as HTMLElement;
      const text = statusBar.querySelector("#lanemu-status-text") as HTMLElement;
      const ipWrap = statusBar.querySelector("#lanemu-ip-display") as HTMLElement;
      const ipVal = statusBar.querySelector("#lanemu-ip-val") as HTMLElement;

      if (status.running) {
        dot.className = "status-dot status-dot--active";
        text.textContent = "LANemu: Online";
        if (status.virtualIp) {
          ipWrap.className = "status-ip status-ip--visible";
          ipVal.textContent = status.virtualIp;
        } else {
          ipWrap.className = "status-ip status-ip--hidden";
        }
      } else {
        dot.className = "status-dot status-dot--inactive";
        text.textContent = "LANemu: Offline";
        ipWrap.className = "status-ip status-ip--hidden";
      }
    };

    void service.getStatus().then(updateStatus);
    service.onStatusChange(updateStatus);

    // ── Game context banner ──
    const session = store.get("session");
    const gameName = session.gameName || null;
    const systemId = session.systemId || null;

    if (gameName) {
      const gameBanner = make("div", { class: "launch-panel__game-banner", style: "margin-bottom: 32px;" });
      gameBanner.innerHTML = `
        <div class="launch-panel__game-icon" aria-hidden="true">🎮</div>
        <div class="launch-panel__game-info">
          <div class="launch-panel__game-label">Currently Playing</div>
          <div class="launch-panel__game-name">${gameName}</div>
          ${systemId ? `<div class="launch-panel__game-label" style="margin-top: 4px; text-transform: none; letter-spacing: normal;">${systemId.toUpperCase()}</div>` : ""}
        </div>
      `;
      container.appendChild(gameBanner);
    }

    // ── Card grid ──
    const grid = make("div", { class: "multiplayer-grid" });

    // 1. Host Room Card (primary)
    const createCard = make("div", { class: "multiplayer-card multiplayer-card--primary", role: "button", tabindex: "0", "aria-label": "Host a LAN Room" });
    createCard.innerHTML = `
      <div class="multiplayer-card__icon" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      </div>
      <div class="multiplayer-card__content">
        <h3>Host a LAN Room</h3>
        <p>Create a virtual room and share the invite with friends. Your device becomes the network hub.</p>
      </div>
    `;
    const onHostClick = () => {
      void import("./MultiplayerLaunchPanel.js").then(({ buildMultiplayerLaunchPanel }) => {
        buildMultiplayerLaunchPanel(container, { mode: "host", onBack: renderHome });
      });
    };
    createCard.addEventListener("click", onHostClick);
    createCard.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onHostClick(); } });

    // 2. Join Room Card
    const joinCard = make("div", { class: "multiplayer-card", role: "button", tabindex: "0", "aria-label": "Join a Room" });
    joinCard.innerHTML = `
      <div class="multiplayer-card__icon" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
      </div>
      <div class="multiplayer-card__content">
        <h3>Join a Room</h3>
        <p>Import an access file from your friend to connect to their virtual network.</p>
      </div>
    `;
    const onJoinClick = () => {
      void import("./MultiplayerLaunchPanel.js").then(({ buildMultiplayerLaunchPanel }) => {
        buildMultiplayerLaunchPanel(container, { mode: "join", onBack: renderHome });
      });
    };
    joinCard.addEventListener("click", onJoinClick);
    joinCard.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onJoinClick(); } });

    // 3. Setup Wizard Card (outline style)
    const setupCard = make("div", { class: "multiplayer-card multiplayer-card--outline", role: "button", tabindex: "0", "aria-label": "Setup Wizard" });
    setupCard.innerHTML = `
      <div class="multiplayer-card__icon" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </div>
      <div class="multiplayer-card__content">
        <h3>Setup Wizard</h3>
        <p>Configure Java and LANemu for first-time use. Quick 2-step process.</p>
      </div>
    `;
    const onSetupClick = () => {
      void import("./LanemuSetupWizard.js").then(({ buildLanemuSetupWizard }) => {
        buildLanemuSetupWizard(container, { onBack: renderHome });
      });
    };
    setupCard.addEventListener("click", onSetupClick);
    setupCard.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSetupClick(); } });

    grid.append(createCard, joinCard, setupCard);
    container.appendChild(grid);
  };

  renderHome();
}
