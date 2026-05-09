import { EasyNetplayManager } from "../netplay/EasyNetplayManager.js";
import type { EasyNetplayRoom } from "../netplay/netplayTypes.js";
import { createElement as make } from "./dom.js";

let easyNetplayManager: EasyNetplayManager | null = null;

export function getEasyNetplayManager(serverUrl?: string): EasyNetplayManager {
  if (!easyNetplayManager) {
    easyNetplayManager = new EasyNetplayManager(serverUrl);
  } else if (serverUrl !== undefined) {
    easyNetplayManager.setServerUrl(serverUrl);
  }
  return easyNetplayManager;
}

export function renderEasyDiagnosticEntry(
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

export function renderRoomCard(
  container: HTMLElement,
  room: EasyNetplayRoom,
  opts: {
    easyMgr?: EasyNetplayManager;
    isHost?: boolean;
    showLeaveBtn?: boolean;
    showToast(message: string): void;
  },
): void {
  const isHost = opts.isHost ?? true;
  
  if (isHost) {
    const pulseWrap = make("div", { class: "enp-waiting-pulse" });
    const circle = make("div", { class: "enp-pulse-circle" });
    circle.innerHTML = `<img src="${resolveAssetUrl("assets/retro_oasis_logo_1777161669657.png")}" width="60" />`;
    
    const codeLabel = make("p", { class: "enp-help" }, "Share this code with your friend:");
    const codeLarge = make("div", { class: "enp-invite-code-large", title: "Click to copy" }, room.code);
    codeLarge.addEventListener("click", () => {
      void navigator.clipboard?.writeText(room.code);
      opts.showToast("Invite code copied!");
    });

    const infoText = make("p", { class: "enp-room-card__game" }, `Hosting ${room.gameName || "Game"}`);
    const waitingText = make("p", { class: "enp-active-room__waiting" }, "⏳ Waiting for another player…");

    pulseWrap.append(circle, codeLabel, codeLarge, infoText, waitingText);

    if (opts.showLeaveBtn && opts.easyMgr) {
      const btnLeave = make("button", { class: "btn btn--danger enp-leave-btn", style: "margin-top: 20px" }, "Close Room") as HTMLButtonElement;
      btnLeave.addEventListener("click", async () => {
        await opts.easyMgr!.leaveRoom();
        container.innerHTML = "";
      });
      pulseWrap.appendChild(btnLeave);
    }
    container.appendChild(pulseWrap);
    return;
  }

  const connectedWrap = make("div", { class: "enp-connected-card" });
  
  const header = make("div", { class: "enp-connected-card__header" });
  header.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="enp-connected-icon"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
  header.appendChild(make("h3", { class: "enp-connected-card__title" }, "Connected!"));
  
  const infoText = make("p", { class: "enp-room-card__game" }, `Playing ${room.gameName || "Game"}`);
  const hostText = make("p", { class: "enp-room-card__host" }, `Host: ${room.hostName || "Anonymous"}`);
  
  connectedWrap.append(header, infoText, hostText);

  if (opts.showLeaveBtn && opts.easyMgr) {
    const btnLeave = make("button", { class: "btn btn--danger enp-leave-btn", style: "margin-top: 20px" }, "Disconnect") as HTMLButtonElement;
    btnLeave.addEventListener("click", async () => {
      await opts.easyMgr!.leaveRoom();
      container.innerHTML = "";
    });
    connectedWrap.appendChild(btnLeave);
  }
  
  container.appendChild(connectedWrap);
}

function resolveAssetUrl(path: string): string {
  // Simple helper to match ui.ts asset resolution
  return path;
}
