import { createElement as make, buildToggleRow } from "../dom.js";
import { showInfoToast } from "../toasts.js";
import { peekNetplayManager } from "../../netplaySingleton.js";
import {
  DEFAULT_ICE_SERVERS,
  validateIceServerUrl as standaloneValidateIceServerUrl,
} from "../../multiplayerUtils.js";
import { store } from "../../store/index.js";
import { fromNetplayIceServers, toNetplayIceServers } from "../../store/bridge.js";
import { diagWarn } from "../../diagnosticLog.js";
import { ICON_CLOSE_X_SVG } from "../../chromeIcons.js";
import {
  buildSupportedSystemsSection,
  buildCurrentGameCompatibilitySection,
} from "../multiplayerInfo.js";

import type { Settings } from "../../types/settings.js";
import type { NetplayManager, NetplayLobbyRoom } from "../../multiplayer.js";

const LATENCY_GOOD_THRESHOLD_MS = 80;
const LATENCY_WARN_THRESHOLD_MS = 200;

export function buildMultiplayerTab(
  container:        HTMLElement,
  settings:         Settings,
  onSettingsChange: (patch: Partial<Settings>) => void,
  getNetplayManager?: () => Promise<NetplayManager>,
  currentGameName?: string | null,
  currentSystemId?: string | null,
  appName = "RetroOasis",
): void {
  const APP_NAME = appName;

  peekNetplayManager();
  let currentEnabled = settings.netplayEnabled;
  let currentServerUrl = settings.netplayServerUrl.trim();

  const validateServerUrl = (url: string): string | null => {
    const netplayManager = peekNetplayManager();
    if (netplayManager) return netplayManager.validateServerUrl(url);
    const trimmed = url.trim();
    if (trimmed.length === 0) return null;
    if (!/^wss?:\/\//i.test(trimmed)) {
      return "Server URL must start with ws:// or wss://";
    }
    try {
      new URL(trimmed);
    } catch {
      return "Server URL is not a valid URL";
    }
    return null;
  };

  const validateUsername = (name: string): string | null => {
    const netplayManager = peekNetplayManager();
    if (netplayManager) return netplayManager.validateUsername(name);
    return name.trim().length > 32 ? "Display name must be 32 characters or fewer" : null;
  };

  const getNetplayStatus = (): {
    enabled: boolean;
    hasUrl: boolean;
    ready: boolean;
  } => {
    const enabled = currentEnabled;
    const hasUrl = currentServerUrl.length > 0;
    const ready = enabled && hasUrl && !validateServerUrl(currentServerUrl);
    return { enabled, hasUrl, ready };
  };

  const callNm = (fn: (m: NetplayManager) => void): void => {
    const nm = peekNetplayManager();
    if (nm) { fn(nm); }
    else if (getNetplayManager) { void getNetplayManager().then(fn).catch(err => console.warn("Failed to get netplay manager:", err)); }
  };

  const introHeadingId = "settings-playtogether-intro-heading";
  const introSection = make("div", {
    class: "settings-section settings-section--playtogether-intro",
    role: "region",
    "aria-labelledby": introHeadingId,
  });
  introSection.appendChild(make("h4", { class: "settings-section__title", id: introHeadingId }, "Play Together overview"));
  introSection.appendChild(make("p", { class: "settings-help" },
    "Point each device at the same WebSocket server with the same ROM, then host or join through the lobby. " +
    `${APP_NAME} Play Together does not piggy‑back Nintendo WFC or other ROM-internal Wi‑Fi menus.`,
  ));

  const statusBadge = make("span", { class: "netplay-status-pill netplay-status-pill--inactive" });
  const updateStatusBadge = () => {
    const { enabled, hasUrl, ready } = getNetplayStatus();
    statusBadge.textContent = ready
      ? "Ready to play online"
      : enabled && !hasUrl
        ? "Add a server URL"
        : !enabled && hasUrl
          ? "Turn on Online play"
          : "Not set up yet";
    statusBadge.className = ready
      ? "netplay-status-pill netplay-status-pill--active"
      : "netplay-status-pill netplay-status-pill--inactive";
  };
  updateStatusBadge();
  introSection.appendChild(statusBadge);

  introSection.appendChild(buildToggleRow(
    "Online play",
    "Shows Play Together on the home screen and Online in the game toolbar. In-game Wi-Fi or WFC features inside a ROM are separate from this setting.",
    settings.netplayEnabled,
    (v) => {
      currentEnabled = v;
      onSettingsChange({ netplayEnabled: v });
      callNm(m => m.setEnabled(v));
      serverSection.hidden = !v;
      updateStatusBadge();
    }
  ));

  container.appendChild(introSection);
  container.appendChild(buildSupportedSystemsSection(APP_NAME));

  const netplayServerHeadingId = "settings-netplay-server-heading";
  const netplayUrlHelpId = "settings-netplay-url-help";
  const netplayUsernameHelpId = "settings-netplay-username-help";

  const serverSection = make("div", {
    class: "settings-section",
    role: "region",
    "aria-labelledby": netplayServerHeadingId,
  });
  serverSection.hidden = !settings.netplayEnabled;
  serverSection.appendChild(make("h4", { class: "settings-section__title", id: netplayServerHeadingId }, "Server address"));
  serverSection.appendChild(make("p", {
    class: "settings-help",
    id: netplayUrlHelpId,
  },
    "Paste the full Play Together WebSocket URL (example: wss://games.example.net:443/netplay). " +
    "Keep the scheme, host, port, and path identical for everyone in the match."
  ));

  const urlRow   = make("div", { class: "settings-input-row" });
  const urlLabel = make("label", { class: "settings-input-label", for: "netplay-server-url" }, "WebSocket URL (wss:// or ws://)");
  const urlInput = make("input", {
    type:               "text",
    id:                 "netplay-server-url",
    name:               "netplayServerUrl",
    class:              "settings-input",
    placeholder:        "wss://netplay.example.com/room…",
    value:              settings.netplayServerUrl,
    autocomplete:       "off",
    autocorrect:        "off",
    autocapitalize:     "none",
    spellcheck:         "false",
    "aria-describedby": netplayUrlHelpId,
  }) as HTMLInputElement;
  urlInput.addEventListener("input", () => urlInput.setCustomValidity(""));
  urlInput.addEventListener("change", () => {
    const url = urlInput.value.trim();
    const err = validateServerUrl(url);
    if (err) {
      urlInput.setCustomValidity(err);
      urlInput.reportValidity();
      return;
    }
    urlInput.setCustomValidity("");
    currentServerUrl = url;
    const patch: Partial<Settings> = { netplayServerUrl: url };
    if (!currentEnabled) {
      currentEnabled = true;
      patch.netplayEnabled = true;
      callNm(m => m.setEnabled(true));
      serverSection.hidden = false;
      const toggleInput = introSection.querySelector<HTMLInputElement>(".toggle-row input[type=checkbox]");
      if (toggleInput) toggleInput.checked = true;
    }
    onSettingsChange(patch);
    callNm(m => m.setServerUrl(url));
    updateStatusBadge();
  });
  urlInput.addEventListener("input", () => urlInput.setCustomValidity(""));
  urlRow.append(urlLabel, urlInput);
  serverSection.appendChild(urlRow);

  const unameRow   = make("div", { class: "settings-input-row" });
  const unameLabel = make("label", { class: "settings-input-label", for: "netplay-username" }, "Display name");
  const unameInput = make("input", {
    type:               "text",
    id:                 "netplay-username",
    name:               "netplayUsername",
    class:              "settings-input",
    placeholder:        "Display name (optional)…",
    value:              settings.netplayUsername,
    autocomplete:       "nickname",
    autocorrect:        "off",
    autocapitalize:     "words",
    spellcheck:         "false",
    maxlength:          "32",
    "aria-describedby": netplayUsernameHelpId,
  }) as HTMLInputElement;
  unameInput.addEventListener("input", () => unameInput.setCustomValidity(""));
  unameInput.addEventListener("change", () => {
    const name = unameInput.value.trim();
    const err = validateUsername(name);
    if (err) {
      unameInput.setCustomValidity(err);
      unameInput.reportValidity();
      return;
    }
    unameInput.setCustomValidity("");
    onSettingsChange({ netplayUsername: name });
    callNm(m => m.setUsername(name));
  });
  unameRow.append(unameLabel, unameInput);
  serverSection.appendChild(unameRow);
  serverSection.appendChild(make("p", {
    class: "settings-help",
    id: netplayUsernameHelpId,
  },
    "Optional name visible in the lobby. Leave blank to use a temporary guest name.",
  ));

  const iceDetails = make("details", { class: "netplay-advanced" }) as HTMLDetailsElement;
  const iceSummary = make("summary", {}, "Advanced: Connection Servers (STUN / ICE)");
  iceDetails.appendChild(iceSummary);

  const iceContent = make("div", { class: "netplay-advanced-content" });
  iceContent.appendChild(make("p", { class: "settings-help" },
    "Google STUN servers are used by default for WebRTC hole-punching. " +
    "For networks with strict symmetric NAT, add a TURN server (e.g. turn:turn.example.com:3478)."
  ));

  let iceServers: RTCIceServer[] = (() => {
    const fromStore = store.get("settings").netplayIceServers;
    if (fromStore.length > 0) return fromNetplayIceServers(fromStore);
    return [...(peekNetplayManager()?.iceServers ?? DEFAULT_ICE_SERVERS)];
  })();

  const commitIceServers = (): void => {
    onSettingsChange({
      netplayIceServers: toNetplayIceServers(iceServers),
    });
  };

  const iceList = make("div", { class: "netplay-ice-list" });
  const renderIceList = () => {
    iceList.innerHTML = "";
    if (iceServers.length === 0) {
      iceList.appendChild(make("p", { class: "netplay-ice-empty" },
        "No ICE servers configured — peer connections may fail."
      ));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const srv of iceServers) {
      const urls   = Array.isArray(srv.urls) ? srv.urls : [srv.urls];
      const urlStr = urls.join(", ");
      const row = make("div", { class: "netplay-ice-row" });
      row.appendChild(make("span", { class: "netplay-ice-url" }, urlStr));
      const removeBtn = make("button", {
        type: "button",
        class: "btn netplay-ice-remove",
        "aria-label": `Remove ${urlStr}`,
      }) as HTMLButtonElement;
      removeBtn.innerHTML = ICON_CLOSE_X_SVG;
      removeBtn.addEventListener("click", () => {
        const idx = iceServers.indexOf(srv);
        if (idx !== -1) iceServers.splice(idx, 1);
        commitIceServers();
        renderIceList();
      });
      row.appendChild(removeBtn);
      fragment.appendChild(row);
    }
    iceList.appendChild(fragment);
  };
  renderIceList();
  iceContent.appendChild(iceList);

  const addRow = make("div", { class: "settings-input-row" });
  const addInput = make("input", {
    type:         "text",
    id:           "netplay-ice-add",
    name:         "iceServerUrl",
    class:        "settings-input",
    placeholder:  "stun:stun.example.com:3478…",
    "aria-label": "New ICE server URL",
    autocomplete: "off",
    autocorrect:  "off",
    autocapitalize: "none",
    spellcheck:   "false",
  }) as HTMLInputElement;
  const addBtn = make("button", { type: "button", class: "btn btn--primary" }, "Add") as HTMLButtonElement;
  addBtn.addEventListener("click", () => {
    const url = addInput.value.trim();
    if (!url) return;
    const netplayManager = peekNetplayManager();
    const err = netplayManager
      ? netplayManager.validateIceServerUrl(url)
      : standaloneValidateIceServerUrl(url);
    if (err) {
      addInput.setCustomValidity(err);
      addInput.reportValidity();
      return;
    }
    addInput.setCustomValidity("");
    iceServers.push({ urls: url });
    commitIceServers();
    addInput.value = "";
    renderIceList();
  });
  addInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addBtn.click();
    }
  });
  addInput.addEventListener("input", () => addInput.setCustomValidity(""));
  addRow.append(addInput, addBtn);
  iceContent.appendChild(addRow);

  const resetBtn = make("button", { type: "button", class: "btn settings-clear-btn" }, "Reset to defaults") as HTMLButtonElement;
  resetBtn.addEventListener("click", () => {
    iceServers = [...DEFAULT_ICE_SERVERS];
    commitIceServers();
    renderIceList();
  });
  iceContent.appendChild(resetBtn);

  iceDetails.appendChild(iceContent);
  serverSection.appendChild(iceDetails);

  container.append(serverSection);

  const netplayLobbyHeadingId = "settings-netplay-lobby-heading";
  const lobbySection = make("div", {
    class: "settings-section netplay-lobby",
    role: "region",
    "aria-labelledby": netplayLobbyHeadingId,
  });
  lobbySection.hidden = !getNetplayStatus().ready;
  lobbySection.appendChild(make("h4", {
    class: "settings-section__title",
    id: netplayLobbyHeadingId,
  }, "Room Browser"));

  const lobbyScopeHint = currentGameName
    ? `Showing rooms for: ${currentGameName}`
    : "Open a game and come back here to see rooms for that title.";
  lobbySection.appendChild(make("p", { class: "settings-help" }, lobbyScopeHint));

  const lobbyRoomList = make("div", { class: "netplay-lobby-list" });
  let lobbyAbort: AbortController | null = null;
  let lobbyAutoRefreshTimer: ReturnType<typeof setInterval> | null = null;
  const lobbyLastRefreshed = make("p", { class: "netplay-lobby-timestamp" });

  let selectedLobbyRoom: NetplayLobbyRoom | null = null;
  let joinBtnRef: HTMLButtonElement | null = null;
  const syncJoinBtn = () => {
    if (!joinBtnRef) return;
    joinBtnRef.disabled = !selectedLobbyRoom;
    joinBtnRef.title = selectedLobbyRoom
      ? `Join "${selectedLobbyRoom.name || "selected room"}"`
      : "Select a room above to join";
  };

  const renderLobbyRooms = (rooms: NetplayLobbyRoom[]) => {
    lobbyRoomList.innerHTML = "";
    selectedLobbyRoom = null;
    syncJoinBtn();
    if (rooms.length === 0) {
      lobbyRoomList.appendChild(make("p", { class: "netplay-lobby-empty" },
        "No open rooms right now — be the first to create one!"
      ));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const room of rooms) {
      const row = make("div", { class: "netplay-lobby-row" });

      const nameEl = make("span", { class: "netplay-lobby-name" },
        room.name ?? `Room ${room.id}`
      );

      const isFull = room.players !== undefined && room.maxPlayers !== undefined
        && room.players >= room.maxPlayers;
      const statusVariant = isFull ? "full" : room.hasPassword ? "locked" : "open";
      const statusLabel   = isFull ? "Full" : room.hasPassword ? "Password" : "Open";
      const statusChip = make("span", {
        class: `netplay-room-status netplay-room-status--${statusVariant}`,
      }, statusLabel);

      const hostEl = room.host
        ? make("span", { class: "netplay-lobby-host" }, room.host)
        : null;

      const playersEl = (room.players !== undefined)
        ? make("span", { class: "netplay-lobby-players" },
            room.maxPlayers !== undefined
              ? `${room.players}/${room.maxPlayers}`
              : `${room.players}`
          )
        : null;

      let latencyEl: HTMLElement | null = null;
      if (room.latencyMs !== undefined) {
        const ms = Math.round(room.latencyMs);
        const latencyVariant = ms <= LATENCY_GOOD_THRESHOLD_MS ? "good" : ms <= LATENCY_WARN_THRESHOLD_MS ? "warn" : "bad";
        latencyEl = make("span", {
          class: `netplay-lobby-latency netplay-lobby-latency--${latencyVariant}`,
          title: "Round-trip latency",
        }, `${ms} ms`);
      }

      row.appendChild(nameEl);
      row.appendChild(statusChip);
      if (hostEl)    row.appendChild(hostEl);
      if (playersEl) row.appendChild(playersEl);
      if (latencyEl) row.appendChild(latencyEl);

      row.addEventListener("click", () => {
        lobbyRoomList.querySelectorAll<HTMLElement>(".netplay-lobby-row--selected")
          .forEach(el => el.classList.remove("netplay-lobby-row--selected"));
        row.classList.add("netplay-lobby-row--selected");
        selectedLobbyRoom = room;
        syncJoinBtn();
      });

      fragment.appendChild(row);
    }
    lobbyRoomList.appendChild(fragment);
  };
  renderLobbyRooms([]);
  lobbySection.appendChild(lobbyRoomList);

  const lobbyFooter = make("div", { class: "netplay-lobby-footer" });
  const refreshBtn = make("button", {
    type: "button",
    class: "btn btn--primary netplay-lobby-refresh",
    "aria-label": "Refresh room list",
  }) as HTMLButtonElement;
  refreshBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.49-4.5"/></svg> Refresh`;

  const doLobbyRefresh = async () => {
    const netplayManager = peekNetplayManager();
    if (!netplayManager) return;
    if (!lobbySection.isConnected || !!lobbySection.closest("[hidden]")) {
      if (lobbyAutoRefreshTimer) {
        clearInterval(lobbyAutoRefreshTimer);
        lobbyAutoRefreshTimer = null;
      }
      if (lobbyAbort) {
        lobbyAbort.abort();
        lobbyAbort = null;
      }
      return;
    }
    if (lobbyAbort) lobbyAbort.abort();
    lobbyAbort = new AbortController();
    refreshBtn.disabled = true;
    refreshBtn.setAttribute("aria-busy", "true");
    refreshBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.49-4.5"/></svg> Refreshing…`;
    lobbyLastRefreshed.textContent = "";

    lobbyRoomList.innerHTML = "";
    const skelFrag = document.createDocumentFragment();
    for (let i = 0; i < 3; i++) {
      const skel = make("div", { class: "netplay-lobby-skeleton" });
      skel.appendChild(make("div", { class: "netplay-lobby-skeleton__bar netplay-lobby-skeleton__bar--grow" }));
      skel.appendChild(make("div", { class: "netplay-lobby-skeleton__bar netplay-lobby-skeleton__bar--medium" }));
      skel.appendChild(make("div", { class: "netplay-lobby-skeleton__bar netplay-lobby-skeleton__bar--short" }));
      skelFrag.appendChild(skel);
    }
    lobbyRoomList.appendChild(skelFrag);

    try {
      const rooms = await netplayManager.fetchLobbyRooms(lobbyAbort.signal);
      renderLobbyRooms(rooms);
      const now = new Date();
      lobbyLastRefreshed.textContent =
        `Updated ${now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      diagWarn(settings.verboseLogging, `[${APP_NAME}] Lobby fetch failed:`, err);
      lobbyRoomList.innerHTML = "";
      lobbyRoomList.appendChild(make("p", { class: "netplay-lobby-error" },
        "Couldn't reach the server. Check your connection and server URL, then try again."
      ));
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.removeAttribute("aria-busy");
      refreshBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.49-4.5"/></svg> Refresh`;
    }
  };

  refreshBtn.addEventListener("click", doLobbyRefresh);

  const autoNote = make("p", { class: "netplay-auto-note" }, "Auto-refreshes every 30 seconds");
  lobbyFooter.append(refreshBtn, lobbyLastRefreshed, autoNote);
  lobbySection.appendChild(lobbyFooter);

  const syncLobbyVisibility = () => {
    const wasHidden = lobbySection.hidden;
    const netplayManager = peekNetplayManager();
    const nowActive = netplayManager?.isActive ?? false;
    lobbySection.hidden = !nowActive;
    if (wasHidden && nowActive) {
      void doLobbyRefresh();
      if (lobbyAutoRefreshTimer) clearInterval(lobbyAutoRefreshTimer);
      lobbyAutoRefreshTimer = setInterval(() => { void doLobbyRefresh(); }, 30_000);
    } else if (!nowActive && lobbyAutoRefreshTimer) {
      clearInterval(lobbyAutoRefreshTimer);
      lobbyAutoRefreshTimer = null;
    }
  };
  introSection.addEventListener("change", syncLobbyVisibility);
  urlInput.addEventListener("change", syncLobbyVisibility);

  container.append(lobbySection);

  // === Current game compatibility section ====================================
  const gameCompatSection = buildCurrentGameCompatibilitySection({
    appName: APP_NAME,
    currentGameName,
    currentSystemId,
  });
  if (gameCompatSection) {
    container.appendChild(gameCompatSection);
  }

  // === Room actions section ==================================================
  const netplayRoomActionsHeadingId = "settings-netplay-room-actions-heading";
  const roomSection = make("div", {
    class: "settings-section",
    role: "region",
    "aria-labelledby": netplayRoomActionsHeadingId,
  });
  roomSection.appendChild(make("h4", {
    class: "settings-section__title",
    id: netplayRoomActionsHeadingId,
  }, "Room Actions"));

  if (!getNetplayStatus().ready) {
    roomSection.appendChild(make("p", { class: "settings-help" },
      "Server URL is required — enable Online play and add a server URL above to start playing with others."
    ));
  } else {
    const hasGame = !!currentGameName;
    roomSection.appendChild(make("p", { class: "settings-help" },
      hasGame
        ? `Use the Online button in the toolbar while playing ${currentGameName} to create or join a room. ${APP_NAME} Play Together uses a separate lobby from in-game Wi-Fi features.`
        : `Open a game, then use the Online button in the toolbar to create or join a room. ${APP_NAME} Play Together uses a separate lobby from in-game Wi-Fi features.`
    ));
    const actionRow = make("div", { class: "netplay-room-actions" });
    const createBtn = make("button", {
      type: "button",
      class: "btn btn--primary netplay-create-room",
      title: "Start a game and use the Online button to create a Play Together room",
      "aria-label": "Create room — shows how to start a room from the in-game Online button",
    }) as HTMLButtonElement;
    createBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Create Room`;
    const joinBtn = make("button", {
      type: "button",
      class: "btn netplay-join-room",
      title: "Select a room above to join",
      disabled: "",
      "aria-label": "Join selected room — shows how to connect after choosing a room above",
    }) as HTMLButtonElement;
    joinBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg> Join Room`;
    joinBtnRef = joinBtn;
    syncJoinBtn();
    createBtn.addEventListener("click", () => {
      showInfoToast(
        hasGame
          ? `Use the Online button in the toolbar to create a room for ${currentGameName}.`
          : "Start a game first, then use the Online button in the toolbar to create a room."
      );
    });
    joinBtn.addEventListener("click", () => {
      const room = selectedLobbyRoom;
      showInfoToast(
        room
          ? `Start "${currentGameName || "the game"}" — the app will connect you to "${room.name ?? "the selected room"}".`
          : "Select a room in the Room Browser above, then start the same game to join it."
      );
    });
    actionRow.append(createBtn, joinBtn);
    roomSection.appendChild(actionRow);
  }
  container.appendChild(roomSection);
}
