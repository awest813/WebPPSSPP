/**
 * MultiplayerHome.ts — The landing dashboard for all LANemu rooms.
 */

import { createElement as make } from "../../ui/dom.js";
import { getLanemuService } from "../lanemu/LanemuSingleton.js";
import type { LanemuStatus } from "../lanemu/LanemuStatus.js";

export function buildMultiplayerHome(container: HTMLElement): void {
  const service = getLanemuService();
  
  const renderHome = () => {
    container.innerHTML = "";
    
    const header = make("div", { class: "multiplayer-dashboard-header" });
    header.appendChild(make("h2", { class: "dashboard-title" }, "RetroOasis LAN Rooms"));
    header.appendChild(make("p", { class: "dashboard-subtitle" }, "Play Ad Hoc and LAN games with friends over a virtual network."));
    
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

    const updateStatus = (status: LanemuStatus) => {
      const dot = statusBar.querySelector("#lanemu-dot") as HTMLElement;
      const text = statusBar.querySelector("#lanemu-status-text") as HTMLElement;
      const ipWrap = statusBar.querySelector("#lanemu-ip-display") as HTMLElement;
      const ipVal = statusBar.querySelector("#lanemu-ip-val") as HTMLElement;

      if (status.running) {
        dot.className = "status-dot status-dot--active";
        text.textContent = "LANemu: Online";
        if (status.virtualIp) {
          ipWrap.style.display = "block";
          ipVal.textContent = status.virtualIp;
        } else {
          ipWrap.style.display = "none";
        }
      } else {
        dot.className = "status-dot status-dot--inactive";
        text.textContent = "LANemu: Offline";
        ipWrap.style.display = "none";
      }
    };

    // Initial status
    void service.getStatus().then(updateStatus);
    
    // Subscribe to changes
    service.onStatusChange(updateStatus);
    // Note: We don't have a clean way to unsub here since container is just an element,
    // but in this specific UI pattern it's usually fine as the modal will be destroyed.

    const grid = make("div", { class: "multiplayer-grid" });

    // 1. Create Room Card
    const createCard = make("div", { class: "multiplayer-card multiplayer-card--primary", role: "button", tabindex: "0", "aria-label": "Host a LAN Room" });
    createCard.innerHTML = `
      <div class="multiplayer-card__icon" aria-hidden="true">🏠</div>
      <div class="multiplayer-card__content">
        <h3>Host a LAN Room</h3>
        <p>Create a virtual room and share the invite with friends.</p>
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
      <div class="multiplayer-card__icon" aria-hidden="true">🔗</div>
      <div class="multiplayer-card__content">
        <h3>Join a Room</h3>
        <p>Import an invite file from your friend to join their network.</p>
      </div>
    `;
    const onJoinClick = () => {
      void import("./MultiplayerLaunchPanel.js").then(({ buildMultiplayerLaunchPanel }) => {
        buildMultiplayerLaunchPanel(container, { mode: "join", onBack: renderHome });
      });
    };
    joinCard.addEventListener("click", onJoinClick);
    joinCard.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onJoinClick(); } });

    // 3. Settings / Wizard Card
    const setupCard = make("div", { class: "multiplayer-card multiplayer-card--outline", role: "button", tabindex: "0", "aria-label": "Setup Wizard" });
    setupCard.innerHTML = `
      <div class="multiplayer-card__icon" aria-hidden="true">⚙️</div>
      <div class="multiplayer-card__content">
        <h3>Setup Wizard</h3>
        <p>Configure Java and LANemu.jar for first-time use.</p>
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
