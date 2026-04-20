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
  const card = make("div", { class: "enp-active-room" });

  const codeWrap = make("div", { class: "enp-active-room__code-wrap" });
  codeWrap.appendChild(make("span", { class: "enp-active-room__code-label" }, "Invite Code"));
  const copyCode = async () => {
    try {
      await navigator.clipboard?.writeText(room.code);
      opts.showToast("Invite code copied!");
    } catch {
      opts.showToast(`Code: ${room.code}`);
    }
  };
  const codeEl = make("span", { class: "enp-active-room__code", title: "Click to copy" }, room.code);
  codeEl.addEventListener("click", () => { void copyCode(); });
  codeWrap.appendChild(codeEl);
  const copyBtn = make("button", { class: "btn enp-copy-btn", "aria-label": "Copy invite code" }, "📋 Copy") as HTMLButtonElement;
  copyBtn.addEventListener("click", () => { void copyCode(); });
  codeWrap.appendChild(copyBtn);
  card.appendChild(codeWrap);

  const info = make("div", { class: "enp-active-room__info" });
  info.appendChild(make("span", { class: "enp-active-room__name" }, room.name));
  info.appendChild(make("span", { class: "enp-active-room__detail" }, `${room.isLocal ? "📶 Local Network" : "🌐 Online"} · ${room.playerCount}/${room.maxPlayers} players`));
  if (room.gameName) info.appendChild(make("span", { class: "enp-active-room__detail" }, `Game: ${room.gameName}`));
  card.appendChild(info);

  const isHost = opts.isHost ?? true;
  card.appendChild(make("p", { class: "enp-active-room__waiting" }, isHost ? "⏳ Waiting for another player…" : "✓ Joined room — waiting for the host to start…"));

  if (opts.showLeaveBtn && opts.easyMgr) {
    const btnLeave = make("button", { class: "btn btn--danger enp-leave-btn" }, "Leave Room") as HTMLButtonElement;
    btnLeave.addEventListener("click", async () => {
      await opts.easyMgr!.leaveRoom();
      container.innerHTML = "";
      container.appendChild(make("p", { class: "enp-diag enp-diag--info" }, "You left the room."));
    });
    card.appendChild(btnLeave);
  }

  container.appendChild(card);
}
