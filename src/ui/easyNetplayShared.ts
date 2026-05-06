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

  // joining state is handled by sharedGetEasyNetplayManager listRooms.
}

function resolveAssetUrl(path: string): string {
  // Simple helper to match ui.ts asset resolution
  return path;
}
