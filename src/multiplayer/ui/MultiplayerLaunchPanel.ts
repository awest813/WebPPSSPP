/**
 * MultiplayerLaunchPanel.ts — Premium host/join flow.
 * PlayStation/Switch-quality with step-by-step visual instructions,
 * animated IP display, and inline status feedback.
 */

import { createElement as make } from "../../ui/dom.js";
import { getLanemuService } from "../lanemu/LanemuSingleton.js";
import { store } from "../../store/index.js";

export function buildMultiplayerLaunchPanel(container: HTMLElement, opts: { mode: "host" | "join", onBack: () => void }): void {
  const service = getLanemuService();
  const session = store.get("session");
  const gameName = session.gameName || "Unknown Game";
  const systemId = session.systemId || "";
  
  container.innerHTML = "";

  const panel = make("div", { class: "launch-panel" });
  
  // ── Header ──
  const header = make("div", { class: "modal-header" });
  const btnBack = make("button", { class: "btn btn--ghost", style: "margin-right: 10px", "aria-label": "Go back" }, "←");
  btnBack.addEventListener("click", opts.onBack);
  const titleText = opts.mode === "host" ? "Host a LAN Room" : "Join a LAN Room";
  header.append(btnBack, make("h3", { class: "modal-title" }, titleText));
  panel.appendChild(header);

  // ── Game context banner ──
  const gameBanner = make("div", { class: "launch-panel__game-banner" });
  gameBanner.innerHTML = `
    <div class="launch-panel__game-icon" aria-hidden="true">🎮</div>
    <div class="launch-panel__game-info">
      <div class="launch-panel__game-label">Session</div>
      <div class="launch-panel__game-name">${gameName}</div>
      ${systemId ? `<div class="launch-panel__game-label" style="margin-top: 4px; text-transform: uppercase; letter-spacing: 0.1em;">${systemId}</div>` : ""}
    </div>
  `;
  panel.appendChild(gameBanner);

  // ── Virtual IP display ──
  const ipDisplay = make("div", { class: "launch-panel__ip-display" });
  ipDisplay.innerHTML = `
    <div class="launch-panel__ip-label">Your Virtual IP</div>
    <div class="launch-panel__ip-value launch-panel__ip-value--offline" id="launch-ip-value">Detecting…</div>
  `;
  panel.appendChild(ipDisplay);

  const ipValue = ipDisplay.querySelector("#launch-ip-value") as HTMLElement;

  // ── Step-by-step instructions ──
  const instructions = make("div", { class: "launch-instructions" });
  
  if (opts.mode === "host") {
    instructions.innerHTML = `
      <h4>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        How to Host
      </h4>
      <div class="launch-steps">
        <div class="launch-step">
          <span class="launch-step__number">1</span>
          <span class="launch-step__text">Enable <strong>WLAN/Ad Hoc</strong> in your emulator's network settings.</span>
        </div>
        <div class="launch-step">
          <span class="launch-step__number">2</span>
          <span class="launch-step__text">Start the in-game lobby from the game's multiplayer menu.</span>
        </div>
        <div class="launch-step">
          <span class="launch-step__number">3</span>
          <span class="launch-step__text">Share your Virtual IP with your friend so they can connect.</span>
        </div>
      </div>
    `;
  } else {
    instructions.innerHTML = `
      <h4>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        How to Join
      </h4>
      <div class="launch-steps">
        <div class="launch-step">
          <span class="launch-step__number">1</span>
          <span class="launch-step__text">Select the <strong>.dat access file</strong> your friend sent you below.</span>
        </div>
        <div class="launch-step">
          <span class="launch-step__number">2</span>
          <span class="launch-step__text">Enter your friend's IP in the emulator's <strong>Pro Ad Hoc Server</strong> setting.</span>
        </div>
        <div class="launch-step">
          <span class="launch-step__number">3</span>
          <span class="launch-step__text">Enable WLAN/Ad Hoc and join the in-game lobby.</span>
        </div>
      </div>
    `;
  }
  panel.appendChild(instructions);

  // ── Inline status feedback (declared early for use in access file handler) ──
  const launchStatus = make("p", { class: "launch-status", "aria-live": "polite" });

  // ── Access file selector (join mode only) ──
  let accessFilePath: string | undefined;
  if (opts.mode === "join") {
    const accessWrap = make("div", { class: "access-file-wrap", id: "access-file-wrap" });
    accessWrap.innerHTML = `
      <div class="access-file-wrap__label">Import access file (.dat) from your friend</div>
      <div style="display: flex; align-items: center; gap: 12px;">
        <button class="btn btn--primary" id="access-file-btn">📂 Select Access File</button>
        <span class="access-file-wrap__status" id="access-file-status" style="color: var(--c-text-dim);">No file selected</span>
      </div>
    `;
    const accessInput = make("input", { type: "file", accept: ".dat", style: "display:none" }) as HTMLInputElement;
    accessWrap.appendChild(accessInput);
    panel.appendChild(accessWrap);

    const accessBtn = accessWrap.querySelector("#access-file-btn") as HTMLButtonElement;
    const accessStatus = accessWrap.querySelector("#access-file-status") as HTMLElement;
    
    accessBtn.addEventListener("click", () => accessInput.click());
    accessInput.addEventListener("change", () => {
      const file = accessInput.files?.[0];
      if (file) {
        accessFilePath = file.name;
        accessStatus.textContent = file.name;
        accessStatus.className = "launch-panel__status--success";
        accessWrap.classList.add("access-file-wrap--selected");
        launchStatus.textContent = "";
      }
    });
  }

  // ── Action buttons ──
  const actions = make("div", { class: "launch-actions" });
  const btnTest = make("button", { class: "btn btn--ghost" }, "Test Connection");
  const btnStart = make("button", { class: "btn btn--primary" }, opts.mode === "host" ? "Start LANemu" : "Join Room");
  actions.append(btnTest, btnStart);
  panel.appendChild(actions);

  panel.appendChild(launchStatus);

  container.appendChild(panel);

  // ── Initial status check ──
  void service.getStatus().then(status => {
    if (status.virtualIp) {
      ipValue.textContent = status.virtualIp;
      ipValue.classList.remove("launch-panel__ip-value--offline");
    } else {
      ipValue.textContent = "Offline";
    }

    if (status.running) {
      btnStart.textContent = opts.mode === "host" ? "Stop LANemu" : "Leave Room";
      btnStart.classList.replace("btn--primary", "btn--danger");
    }
  });

  // ── Start/Stop handler ──
  btnStart.addEventListener("click", async () => {
    const status = await service.getStatus();
    if (status.running) {
      await service.stop();
      btnStart.textContent = opts.mode === "host" ? "Start LANemu" : "Join Room";
      btnStart.classList.replace("btn--danger", "btn--primary");
      launchStatus.textContent = "LANemu stopped.";
      launchStatus.className = "launch-panel__status--dim";
      ipValue.textContent = "Offline";
      ipValue.classList.add("launch-panel__ip-value--offline");
    } else {
      if (opts.mode === "join" && !accessFilePath) {
        launchStatus.textContent = "Please select an access file (.dat) to join a room.";
        launchStatus.className = "launch-panel__status--warn";
        return;
      }
      launchStatus.textContent = "Starting LANemu…";
      launchStatus.className = "launch-panel__status--dim";
      btnStart.disabled = true;
      try {
        await service.start({ 
          playerName: store.get("settings").netplayUsername || "RetroOasisPlayer",
          accessFilePath: accessFilePath 
        });
        const newStatus = await service.getStatus();
        if (newStatus.virtualIp) {
          ipValue.textContent = newStatus.virtualIp;
          ipValue.classList.remove("launch-panel__ip-value--offline");
        }
        btnStart.textContent = opts.mode === "host" ? "Stop LANemu" : "Leave Room";
        btnStart.classList.replace("btn--primary", "btn--danger");
        launchStatus.textContent = "";
      } catch (err) {
        launchStatus.textContent = err instanceof Error ? err.message : String(err);
        launchStatus.className = "launch-panel__status--error";
      } finally {
        btnStart.disabled = false;
      }
    }
  });

  // ── Test Connection handler ──
  btnTest.addEventListener("click", () => {
    void import("./ConnectionDoctorPanel.js").then(({ buildConnectionDoctorPanel }) => {
      buildConnectionDoctorPanel(container, { roomId: "current-room", onBack: () => buildMultiplayerLaunchPanel(container, opts) });
    });
  });
}
