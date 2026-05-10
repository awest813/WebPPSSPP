import {
  isNetplaySupportedSystemId,
  NETPLAY_PLATFORM_GROUPS,
  NETPLAY_SYSTEM_HINTS,
  roomDisplayNameForKey,
  SYSTEM_LINK_CAPABILITIES,
} from "../multiplayerUtils.js";
import { getSystemById } from "../systems.js";
import { resolveNetplayRoomKey } from "../multiplayer.js";
import { createElement as make } from "./dom.js";

export function buildSupportedSystemsSection(appName: string): HTMLElement {
  const section = make("div", { class: "settings-section" });
  section.appendChild(make("h4", { class: "settings-section__title" }, "Supported consoles"));
  section.appendChild(make("p", { class: "settings-help" },
    `${appName} Play Together works on the EmulatorJS netplay-capable cores below. Matching ROM dumps and similar core settings keep sessions stable — especially for Pokemon-style trades.`,
  ));

  const groups = make("div", { class: "netplay-sys-groups" });
  for (const group of NETPLAY_PLATFORM_GROUPS) {
    const box = make("section", { class: "netplay-sys-group", "aria-label": group.title });
    box.appendChild(make("h5", { class: "netplay-sys-group__title" }, group.title));
    const grid = make("div", { class: "netplay-sys-group__grid" });
    for (const sysId of group.ids) {
      const meta = getSystemById(sysId);
      const hint = NETPLAY_SYSTEM_HINTS[sysId];
      const card = make("div", { class: "netplay-sys-card" });
      const badge = make("span", {
        class: "netplay-sys-card__badge sys-chip",
        title: meta?.name ?? sysId,
      }, meta?.shortName ?? sysId);
      if (meta?.color) badge.style.setProperty("--sys-color", meta.color);
      card.appendChild(badge);
      if (hint) {
        card.appendChild(make("p", { class: "netplay-sys-card__hint" }, hint));
      }
      grid.appendChild(card);
    }
    box.appendChild(grid);
    groups.appendChild(box);
  }
  section.appendChild(groups);
  return section;
}

export function buildCurrentGameCompatibilitySection(opts: {
  appName: string;
  currentGameName?: string | null;
  currentSystemId?: string | null;
}): HTMLElement | null {
  const { appName, currentGameName, currentSystemId } = opts;
  if (!currentGameName || !currentSystemId) return null;

  const section = make("div", { class: "settings-section" });
  section.appendChild(make("h4", { class: "settings-section__title" }, "This session"));

  const isNetplaySystem = isNetplaySupportedSystemId(currentSystemId);
  const isLinkCapable = SYSTEM_LINK_CAPABILITIES[currentSystemId] === true;

  if (!isNetplaySystem || !isLinkCapable) {
    const sysName = getSystemById(currentSystemId)?.name ?? currentSystemId;
    section.appendChild(make("p", { class: "settings-help" },
      `${currentGameName} is running on ${sysName}, which is not enabled for Play Together in ${appName} yet. Library and saves still work locally.`,
    ));
    section.appendChild(make("p", { class: "settings-help netplay-session-note" },
      "PlayStation (PSX) and some other cores use different networking stacks — watch release notes for new platforms.",
    ));
    return section;
  }

  const roomKey = resolveNetplayRoomKey(currentGameName, currentSystemId);
  const displayName = roomDisplayNameForKey(roomKey);
  const hasCompatRoom = displayName !== roomKey;

  const gameRow = make("div", { class: "netplay-game-info-row" });
  gameRow.appendChild(make("span", { class: "netplay-game-name" }, currentGameName));
  const sysMeta = getSystemById(currentSystemId);
  gameRow.appendChild(make("span", {
    class: "netplay-sys-pill sys-chip",
    title: sysMeta?.name ?? currentSystemId,
  }, sysMeta?.shortName ?? currentSystemId));
  if (hasCompatRoom) {
    gameRow.appendChild(make("span", { class: "netplay-compat-badge" }, displayName));
  }
  section.appendChild(gameRow);
  section.appendChild(make("p", { class: "settings-help" },
    hasCompatRoom
      ? "This title can share lobbies with linked versions (shown on the badge). Everyone still needs compatible ROMs."
      : "Lobby matching uses your exact game fingerprint — peers need the same title (and usually the same region).",
  ));

  return section;
}
