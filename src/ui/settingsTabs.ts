import { BiosLibrary, BIOS_REQUIREMENTS } from "../bios.js";
import { SYSTEMS } from "../systems.js";
import { createElement as make } from "./dom.js";
import type { RAUserSummary, RARecentAchievement } from "../types/metadata.js";
import { parseRAKey } from "../raCredentials.js";
import {
  ApiKeyStore,
  redactKey,
  looksLikePlaceholderOrUrl,
  type ApiKeyProviderConfig,
} from "../apiKeyStore.js";
import { getStorageEstimate, formatBytes } from "../library.js";

type JsonObject = Record<string, unknown>;

export function buildBiosTab(container: HTMLElement, biosLibrary: BiosLibrary, opts: {
  appName: string;
  onError(message: string): void;
}): void {
  const { onError } = opts;
  void opts.appName; // part of standardized opts interface
  const biosSection = make("div", { class: "settings-section" });
  biosSection.appendChild(make("h4", { class: "settings-section__title" }, "System Startup Files"));
  biosSection.appendChild(make("p", { class: "settings-help" },
    "Some older consoles need a startup file to run games. " +
    "If a game won't start, you may need to add one here. " +
    "PS1 works out of the box (compatibility core). For higher accuracy, upload an official " +
    `BIOS extracted from a console you own, or download the free OpenBIOS below.`
  ));

  const biosGrid = make("div", { class: "bios-grid" });
  biosSection.appendChild(biosGrid);

  for (const sysId of Object.keys(BIOS_REQUIREMENTS)) {
    const sysInfo = SYSTEMS.find((system) => system.id === sysId);
    if (!sysInfo) continue;
    const reqs = BIOS_REQUIREMENTS[sysId]!;

    const sysBlock = make("div", { class: "bios-system" });
    const sysHeader = make("div", { class: "bios-system__header" });
    const sysBadge = make("span", { class: "sys-badge" }, sysInfo.shortName);
    sysBadge.style.background = sysInfo.color;
    sysHeader.append(sysBadge, document.createTextNode(` ${sysInfo.name}`));
    sysBlock.appendChild(sysHeader);

    for (const req of reqs) {
      const row = make("div", { class: "bios-row" });
      const statusDot = make("span", { class: "bios-dot bios-dot--unknown" });
      const labelWrap = make("span", { class: "bios-label" });
      labelWrap.appendChild(document.createTextNode(req.displayName));
      labelWrap.appendChild(make("code", {
        class: "bios-filename",
        title: `Required filename: ${req.fileName}`,
        "aria-label": `Required filename: ${req.fileName}`,
      }, req.fileName));
      const desc = make("span", { class: "bios-desc" }, req.description);
      const requiredBadge = req.required
        ? make("span", { class: "bios-required" }, "Required")
        : make("span", { class: "bios-optional" }, "Optional");

      const uploadInput = make("input", {
        type: "file",
        accept: ".bin,.img,.rom",
        "aria-label": `Upload ${req.displayName}`,
        style: "display:none",
      }) as HTMLInputElement;

      const uploadBtn = make("button", { type: "button", class: "btn bios-upload-btn" }, "Upload") as HTMLButtonElement;
      uploadBtn.addEventListener("click", () => uploadInput.click());
      uploadInput.addEventListener("change", async () => {
        const file = uploadInput.files?.[0];
        if (!file) return;
        uploadInput.value = "";
        uploadBtn.disabled = true;
        uploadBtn.setAttribute("aria-busy", "true");
        try {
          const canonical = new File([file], req.fileName, { type: file.type });
          await biosLibrary.addBios(canonical, sysId);
          statusDot.className = "bios-dot bios-dot--ok";
          uploadBtn.textContent = "Replace";
          if (downloadBtn) downloadBtn.textContent = "Re-download";
        } catch (err) {
          onError(`BIOS upload failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          uploadBtn.disabled = false;
          uploadBtn.removeAttribute("aria-busy");
        }
      });

      // "Download Free" button — only shown for entries with a free downloadUrl.
      let downloadBtn: HTMLButtonElement | null = null;
      if (req.downloadUrl) {
        downloadBtn = make("button", { type: "button", class: "btn bios-download-btn" }, "Download Free") as HTMLButtonElement;
        downloadBtn.title = `Fetch ${req.displayName} automatically`;
        downloadBtn.addEventListener("click", async () => {
          if (!downloadBtn) return;
          const origText = downloadBtn.textContent ?? "Download Free";
          downloadBtn.disabled = true;
          downloadBtn.setAttribute("aria-busy", "true");
          downloadBtn.textContent = "Downloading…";
          try {
            const resp = await fetch(req.downloadUrl!);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const blob = await resp.blob();
            const canonical = new File([blob], req.fileName, { type: "application/octet-stream" });
            await biosLibrary.addBios(canonical, sysId);
            statusDot.className = "bios-dot bios-dot--ok";
            uploadBtn.textContent = "Replace";
            downloadBtn.textContent = "Re-download";
          } catch (err) {
            onError(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
            downloadBtn.textContent = origText;
          } finally {
            downloadBtn.disabled = false;
            downloadBtn.removeAttribute("aria-busy");
          }
        });
      }

      void biosLibrary.findBios(sysId, req.fileName).then((found) => {
        if (found) {
          statusDot.className = "bios-dot bios-dot--ok";
          uploadBtn.textContent = "Replace";
          if (downloadBtn) downloadBtn.textContent = "Re-download";
        } else if (req.required) {
          statusDot.className = "bios-dot bios-dot--missing";
        }
      }).catch(() => {});

      row.append(statusDot, uploadInput, labelWrap, requiredBadge, desc, uploadBtn);
      if (downloadBtn) row.appendChild(downloadBtn);
      sysBlock.appendChild(row);
    }

    biosGrid.appendChild(sysBlock);
  }

  container.appendChild(biosSection);
}

export function buildAboutTab(container: HTMLElement, appName: string): void {
  const quickStartSection = make("div", { class: "settings-section" });
  quickStartSection.appendChild(make("h4", { class: "settings-section__title" }, "How to Get Started"));
  const steps = [
    "Drop a game file onto the page, or click the upload area to browse for one.",
    "If asked, choose which system to use — this happens with some common file formats.",
    "Your game launches automatically — enjoy!",
    "Save your progress with F5, load it back with F7, and press Esc to return to your game library. Saves stay local first, and save sync can mirror them if you connect it later.",
  ];
  const stepList = make("ol", { class: "help-steps" });
  for (const step of steps) stepList.appendChild(make("li", { class: "help-step" }, step));
  quickStartSection.appendChild(stepList);

  const shortcutsSection = make("div", { class: "settings-section" });
  shortcutsSection.appendChild(make("h4", { class: "settings-section__title" }, "Keyboard Shortcuts"));
  const shortcuts: Array<[string, string]> = [
    ["F5", "Save progress (quick save)"],
    ["F7", "Load saved progress (quick load)"],
    ["F1", "Reset game"],
    ["F9", "Open Settings (Advanced tab)"],
    ["Esc", "Return to game library"],
    ["F3", "Toggle on-screen debug overlay"],
  ];
  const shortcutList = make("div", { class: "device-info-details" });
  for (const [key, desc] of shortcuts) {
    const row = make("div", { class: "shortcut-row" });
    row.append(make("kbd", { class: "shortcut-key" }, key), make("span", { class: "shortcut-desc device-info" }, desc));
    shortcutList.appendChild(row);
  }
  shortcutsSection.appendChild(shortcutList);

  const mpSection = make("div", { class: "settings-section" });
  mpSection.appendChild(make("h4", { class: "settings-section__title" }, "Play with friends online"));
  const mpSteps = [
    "Open Settings → Play Together. Turn on Online play and paste the WebSocket URL (wss://…) from whoever runs your server — everyone must use the same URL.",
    "Launch the same game as your friend (same title and system when possible).",
    "Click Play Together on the home screen, or Online in the game toolbar. Host creates a room and shares the invite code; Join pastes the code from your friend.",
    "If something fails, open Play Together and use Logs to copy connection details for troubleshooting.",
  ];
  const mpList = make("ol", { class: "help-steps" });
  for (const step of mpSteps) mpList.appendChild(make("li", { class: "help-step" }, step));
  mpSection.append(mpList, make("p", { class: "settings-help" },
    `In-game Wi-Fi or Nintendo WFC features inside a ROM are not the same as ${appName} Play Together — use Host / Join here for link-style multiplayer.`
  ));

  const troubleSection = make("div", { class: "settings-section" });
  troubleSection.appendChild(make("h4", { class: "settings-section__title" }, "Troubleshooting"));
  const troubles: Array<[string, string]> = [
    ["Game won't load", "Check that the file is a valid ROM. ZIP files are automatically extracted — if it still fails, try unzipping the file manually first."],
    ["PSP game won't start", "PSP games need a special browser feature. Try refreshing the page once — this sets things up automatically."],
    ["No sound", "Make sure the browser tab isn't muted. Some games take a few seconds to start audio."],
    ["Game is slow or choppy", "Open Settings → Performance and switch to Performance mode. Closing other browser tabs can also help."],
    ["Saves aren't working", "Your saves live in your browser on this device. If you turn on save sync, it mirrors those saves instead of replacing them. Clearing browser data will erase the local copy, so export saves first if you want a backup."],
    ["Controls not responding", "Click on the game screen first to make sure it has focus. Gamepads should be connected before launching a game."],
    ["Stuck on loading screen", "Try refreshing the page. If the issue persists, the game file may be corrupted or an unsupported format."],
    ["Can't connect to a friend online", "Confirm Settings → Play Together has the same server URL for both of you, Online play is on, and you are playing the same game. Try Logs in the Play Together window; strict networks may need a TURN server under Advanced."],
  ];
  for (const [problem, solution] of troubles) {
    const item = make("div", { class: "trouble-item" });
    item.append(make("p", { class: "trouble-item__q" }, problem), make("p", { class: "trouble-item__a" }, solution));
    troubleSection.appendChild(item);
  }

  const aboutSection = make("div", { class: "settings-section" });
  aboutSection.appendChild(make("h4", { class: "settings-section__title" }, `About ${appName}`));
  aboutSection.appendChild(make("p", { class: "settings-help" },
    `${appName} lets you play retro games from classic systems — PSP, N64, PS1, NDS, GBA, SNES, NES, Genesis and more — right in your browser. No installs, no account, nothing to sign up for.`
  ));
  aboutSection.appendChild(make("p", { class: "settings-help" },
    `Your local game library and saves stay on this device by default. If you turn on save sync or add remote library sources, ${appName} can mirror progress and show remote games beside your local ROMs. Nothing uploads until you connect a provider.`
  ));

  // Storage usage estimate
  const storageSection = make("div", { class: "settings-section" });
  storageSection.appendChild(make("h4", { class: "settings-section__title" }, "Storage Usage"));
  const storageInfo = make("p", { class: "settings-help", "aria-live": "polite" }, "Calculating storage…");
  storageSection.appendChild(storageInfo);
  void getStorageEstimate().then((est) => {
    let text = `This browser is using approximately ${formatBytes(est.used)} of storage for ${appName} data (ROMs, saves, BIOS files).`;
    if (est.quota !== null && est.percentUsed !== null) {
      text += ` Your browser has allocated ${formatBytes(est.quota)} to this site; ${est.percentUsed}% is in use.`;
      if (est.percentUsed >= 80) {
        text += " Warning: you are approaching your storage limit — consider removing games you no longer need.";
      }
    } else {
      text += " Your browser does not report a storage quota for this site.";
    }
    storageInfo.textContent = text;
  });

  const links = make("div", { class: "help-links" });
  links.appendChild(make("a", {
    href: "https://emulatorjs.org",
    target: "_blank",
    rel: "noopener",
    class: "btn help-link-btn",
  }, "Powered by EmulatorJS"));
  links.appendChild(make("a", {
    href: "https://github.com/awest813/RetroOasis/issues/new?labels=bug&template=bug_report.md",
    target: "_blank",
    rel: "noopener noreferrer",
    class: "btn help-link-btn",
  }, "Report a Bug"));
  links.appendChild(make("a", {
    href: "https://github.com/awest813/RetroOasis/blob/main/PRIVACY.md",
    target: "_blank",
    rel: "noopener noreferrer",
    class: "btn help-link-btn",
  }, "Privacy Policy"));
  aboutSection.appendChild(links);

  const dataSection = make("div", { class: "settings-section" });
  dataSection.appendChild(make("h4", { class: "settings-section__title" }, "Data Management"));
  dataSection.appendChild(make("p", { class: "settings-help" },
    "Export your library metadata, optional connection credentials, and settings to a JSON file. ROM files are not included."
  ));
  
  const dataButtons = make("div", { class: "help-links" });
  
  const exportBtn = make("button", { type: "button", class: "btn" }, "Export Library JSON") as HTMLButtonElement;
  const importStatus = make("p", { class: "settings-import-status", "aria-live": "polite" });
  exportBtn.addEventListener("click", async () => {
    const origText = exportBtn.textContent ?? "Export Library JSON";
    exportBtn.disabled = true;
    exportBtn.setAttribute("aria-busy", "true");
    exportBtn.textContent = "Exporting...";
    importStatus.textContent = "";
    importStatus.className = "settings-import-status";
    try {
      const { GameLibrary } = await import("../library.js");
      const lib = new GameLibrary();
      const meta = await lib.getAllGamesMetadata();
      const settings = localStorage.getItem("retro-oasis.apiKeys") || "{}";
      const apiKeys = JSON.parse(settings) as JsonObject;
      const data = {
        version: 1,
        exportedAt: Date.now(),
        library: meta,
        apiKeys,
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `retro-oasis-library-${new Date().toISOString().split("T")[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      importStatus.textContent = "Library metadata exported.";
      importStatus.className = "settings-import-status settings-import-status--success";
    } catch (err) {
      console.error("Export failed:", err);
      importStatus.textContent = "Failed to export data: " + (err instanceof Error ? err.message : String(err));
      importStatus.className = "settings-import-status settings-import-status--error";
    } finally {
      exportBtn.disabled = false;
      exportBtn.removeAttribute("aria-busy");
      exportBtn.textContent = origText;
    }
  });

  const importInput = make("input", {
    type: "file",
    accept: ".json",
    style: "display:none",
    "aria-label": "Import library metadata JSON",
  }) as HTMLInputElement;
  const importBtn = make("button", { type: "button", class: "btn" }, "Import Library JSON") as HTMLButtonElement;
  importBtn.addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    importBtn.disabled = true;
    importBtn.classList.add("is-loading");
    importBtn.setAttribute("aria-busy", "true");
    importStatus.textContent = "Importing...";
    importStatus.className = "settings-import-status settings-import-status--dim";
    try {
      const text = await file.text();
      const data = JSON.parse(text) as { apiKeys?: JsonObject };
      if (data.apiKeys) {
        localStorage.setItem("retro-oasis.apiKeys", JSON.stringify(data.apiKeys));
      }
      importStatus.textContent = "Metadata imported successfully. Refreshing...";
      importStatus.className = "settings-import-status settings-import-status--success";
      window.location.reload();
    } catch (err) {
      importBtn.disabled = false;
      importBtn.classList.remove("is-loading");
      importBtn.removeAttribute("aria-busy");
      importStatus.textContent = "Failed to import data: " + (err instanceof Error ? err.message : String(err));
      importStatus.className = "settings-import-status settings-import-status--error";
    }
  });

  dataButtons.append(exportBtn, importBtn, importInput, importStatus);
  dataSection.appendChild(dataButtons);

  container.append(quickStartSection, shortcutsSection, mpSection, troubleSection, storageSection, dataSection, aboutSection);
}

export function buildAchievementsTab(
  container: HTMLElement,
  store: ApiKeyStore,
  opts: {
    appName: string;
    onError(message: string): void;
  },
): void {
  void opts.onError;
  void opts.appName; // part of standardized opts interface
  container.innerHTML = "";

  const raState = store.getState("retroachievements");
  const showSetupButton = (label = "Set up RetroAchievements") => {
    const setupBtn = make("button", { class: "btn btn--primary" }, label);
    setupBtn.addEventListener("click", () => {
      const apiKeysTab = document.getElementById("tab-apikeys");
      apiKeysTab?.click();
    });
    return setupBtn;
  };

  if (!raState.enabled || !raState.key) {
    const empty = make("div", { class: "settings-section achievements-empty" });
    empty.appendChild(make("h4", { class: "settings-section__title" }, "RetroAchievements"));
    empty.appendChild(make("p", { class: "settings-help" },
      "Connect your RetroAchievements account to track progress, earn trophies, and see your rank. " +
      "You'll need a free account from retroachievements.org."
    ));
    empty.appendChild(showSetupButton());
    container.appendChild(empty);
    return;
  }

  const parsedCreds = parseRAKey(raState.key);
  if (!parsedCreds) {
    const invalid = make("div", { class: "settings-section achievements-empty" });
    invalid.appendChild(make("h4", { class: "settings-section__title" }, "RetroAchievements"));
    invalid.appendChild(make("p", { class: "settings-help" },
      "Your saved RetroAchievements login is not in the expected username:token format."
    ));
    invalid.appendChild(showSetupButton("Fix RetroAchievements login"));
    container.appendChild(invalid);
    return;
  }

  // If configured, show the dashboard
  const dashboard = make("div", { class: "achievements-dashboard" });
  
  const header = make("div", { class: "settings-section achievements-header" });
  header.appendChild(make("h4", { class: "settings-section__title" }, "Your Achievements"));
  header.appendChild(make("p", { class: "settings-help" }, "Fetching your latest progress…"));
  dashboard.appendChild(header);

  container.appendChild(dashboard);

  // Lazy load achievements data
  void import("../achievements.js").then(({ getRAClient }) => {
    const creds = parsedCreds;
    const client = getRAClient(creds.username, creds.apiKey);
    if (!client) return;

    client.getUserSummary().then((summary: RAUserSummary) => {
      header.querySelector(".settings-help")!.textContent = 
        `Welcome back, ${creds.username}! You have ${summary.TotalPoints} points and ${summary.TotalTruePoints} true points.`;
      
      const stats = make("div", { class: "achievements-stats-grid" });
      stats.append(
        _buildStatCard("Rank", `#${summary.Rank || "---"}`),
        _buildStatCard("Completed", summary.RecentlyCompleted?.length || "0"),
        _buildStatCard("Last Played", summary.RecentlyPlayed?.[0]?.Title || "None")
      );
      dashboard.appendChild(stats);

      if (summary.RecentAchievements && summary.RecentAchievements.length > 0) {
        const recentSection = make("div", { class: "settings-section" });
        recentSection.appendChild(make("h5", { class: "settings-section__title" }, "Recent Trophies"));
        const trophyList = make("div", { class: "trophy-list" });
        summary.RecentAchievements.slice(0, 5).forEach((ach: RARecentAchievement) => {
          const item = make("div", { class: "trophy-item" });
          const img = make("img", {
            src: `https://media.retroachievements.org/Badge/${encodeURIComponent(String(ach.BadgeName))}.png`,
            class: "trophy-badge",
            alt: `${String(ach.Title)} achievement badge`,
          });
          const text = make("div", { class: "trophy-text" });
          text.appendChild(make("div", { class: "trophy-name" }, String(ach.Title)));
          text.appendChild(make("div", { class: "trophy-game" }, String(ach.GameTitle)));
          item.append(img, text);
          trophyList.appendChild(item);
        });
        recentSection.appendChild(trophyList);
        dashboard.appendChild(recentSection);
      }
    }).catch(err => {
      header.querySelector(".settings-help")!.textContent = "Failed to fetch achievements data. Check your RetroAchievements connection.";
      console.error(err);
    });
  }).catch(err => {
    header.querySelector(".settings-help")!.textContent = "Could not load RetroAchievements tools.";
    console.error(err);
  });
}

function _buildStatCard(label: string, value: string | number): HTMLElement {
  const card = make("div", { class: "stat-card" });
  card.appendChild(make("div", { class: "stat-card__label" }, label));
  card.appendChild(make("div", { class: "stat-card__value" }, String(value)));
  return card;
}

// ── Connections tab ──────────────────────────────────────────────────────────

/**
 * Result of a provider connection test. Providers may be missing a key,
 * unreachable, or rejecting the current key; the UI renders distinct
 * statuses for each case.
 */
export interface ApiKeyProviderTester {
  /** Run a cheap request against the third-party API. */
  testConnection(opts?: { signal?: AbortSignal }): Promise<true | string>;
}

type CredentialField = {
  id: string;
  label: string;
  placeholder: string;
  secret?: boolean;
};

type ConnectionProviderMeta = {
  displayName: string;
  purposeLabel: string;
  description: string;
  signupLabel: string;
  category: "cover" | "metadata" | "achievements";
  recommended?: boolean;
  fields: CredentialField[];
  serialize(values: Record<string, string>): string;
  hydrate(key: string): Record<string, string>;
};

function splitCredentialPair(key: string): [string, string] {
  const idx = key.indexOf(":");
  if (idx < 0) return [key, ""];
  return [key.slice(0, idx), key.slice(idx + 1)];
}

function getConnectionProviderMeta(cfg: ApiKeyProviderConfig): ConnectionProviderMeta {
  const singleKey = (label = "Access key", placeholder = "Paste your credential, then Save or Enter"): ConnectionProviderMeta => ({
    displayName: cfg.name,
    purposeLabel: "Cover art",
    description: cfg.description,
    signupLabel: "Get key",
    category: "cover",
    fields: [{ id: "key", label, placeholder, secret: true }],
    serialize: (values) => values["key"] ?? "",
    hydrate: (key) => ({ key }),
  });

  switch (cfg.id) {
    case "retroachievements":
      return {
        displayName: "RetroAchievements",
        purposeLabel: "Achievements",
        description: "Track trophies, progress, and profile stats while you play supported games.",
        signupLabel: "Open control panel",
        category: "achievements",
        fields: [
          { id: "username", label: "Username", placeholder: "RetroAchievements username" },
          { id: "apiKey", label: "Web token", placeholder: "Paste your RetroAchievements web token", secret: true },
        ],
        serialize: (values) => `${values["username"] ?? ""}:${values["apiKey"] ?? ""}`,
        hydrate: (key) => {
          const [username, apiKey] = splitCredentialPair(key);
          return { username, apiKey };
        },
      };
    case "igdb":
      return {
        displayName: "IGDB Covers + Metadata",
        purposeLabel: "Premium covers",
        description: "Adds broad modern and retro cover fallback plus richer game details from IGDB.",
        signupLabel: "Open IGDB setup",
        category: "metadata",
        recommended: true,
        fields: [
          { id: "clientId", label: "Client ID", placeholder: "Twitch Developer client ID" },
          { id: "clientSecret", label: "Client Secret", placeholder: "Twitch Developer client secret", secret: true },
        ],
        serialize: (values) => `${values["clientId"] ?? ""}:${values["clientSecret"] ?? ""}`,
        hydrate: (key) => {
          const [clientId, clientSecret] = splitCredentialPair(key);
          return { clientId, clientSecret };
        },
      };
    case "screenscraper":
      return {
        displayName: "ScreenScraper Retro Covers",
        purposeLabel: "Retro covers",
        description: "Connects high-quality retro box art and media from your ScreenScraper account.",
        signupLabel: "Create ScreenScraper account",
        category: "cover",
        recommended: true,
        fields: [
          { id: "userid", label: "User ID", placeholder: "ScreenScraper user ID" },
          { id: "password", label: "Password", placeholder: "ScreenScraper password", secret: true },
        ],
        serialize: (values) => `${values["userid"] ?? ""}:${values["password"] ?? ""}`,
        hydrate: (key) => {
          const [userid, password] = splitCredentialPair(key);
          return { userid, password };
        },
      };
    case "steamgriddb":
      return {
        ...singleKey(),
        displayName: "SteamGridDB Posters",
        purposeLabel: "Posters",
        description: "Adds polished poster-style grids and artwork for games that match SteamGridDB.",
        signupLabel: "Get SteamGridDB key",
      };
    case "rawg":
      return {
        ...singleKey(),
        displayName: "RAWG Game Artwork",
        purposeLabel: "Artwork",
        description: "Adds broad artwork and screenshots from RAWG as a connected fallback source.",
        signupLabel: "Get RAWG key",
      };
    case "mobygames":
      return {
        ...singleKey(),
        displayName: "MobyGames Covers",
        purposeLabel: "Covers",
        description: "Adds long-running platform-specific cover data from MobyGames.",
        signupLabel: "Request MobyGames key",
      };
    case "thegamesdb":
      return {
        ...singleKey(),
        displayName: "TheGamesDB Box Art",
        purposeLabel: "Box art",
        description: "Adds community-maintained front and back box art from TheGamesDB.",
        signupLabel: "Get TheGamesDB key",
      };
    default:
      return singleKey();
  }
}

function buildConnectionSummaryCard(label: string, value: string, detail: string): HTMLElement {
  const card = make("div", { class: "connections-summary-card" });
  card.append(
    make("span", { class: "connections-summary-card__label" }, label),
    make("strong", { class: "connections-summary-card__value" }, value),
    make("span", { class: "connections-summary-card__detail" }, detail),
  );
  return card;
}

/** Format a Date as a compact "Xs ago" / "Xm ago" label. */
function timeAgo(at: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 5)    return "just now";
  if (secs < 60)   return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60)   return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24)  return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Build the "Connections" settings tab. Renders one row per registered
 * {@link ApiKeyProviderConfig} with:
 *   - masked input + show/hide toggle + Save / Remove buttons
 *   - enabled checkbox (and a visually-dimmed row when disabled)
 *   - status pill (Active / No key / Invalid key / Disabled / Testing)
 *   - provider setup external link and Test button
 *   - inline test result message (ok / error) with `aria-live`
 *   - drag-and-drop reorder via a grab handle, with ▲/▼ buttons as
 *     an accessible fallback
 *
 * Keys are persisted in {@link ApiKeyStore}. Tests are delegated to the
 * provider instances supplied by the caller (typically the chained
 * cover-art registry in `ui.ts`).
 */
export function buildApiKeysTab(
  container: HTMLElement,
  store: ApiKeyStore,
  opts: {
    appName: string;
    getTester(providerId: string): ApiKeyProviderTester | null;
    onError(message: string): void;
  },
): () => void {
  const { appName, getTester, onError } = opts;

  // Clear any prior content so the tab is safe to rebuild.
  container.innerHTML = "";

  const intro = make("div", { class: "settings-section" });
  intro.appendChild(make("h4", { class: "settings-section__title" }, "Connections"));
  intro.appendChild(make("p", { class: "settings-help" },
    `${appName} already searches free cover sources automatically. Connect optional providers here for better cover matches, richer metadata, and achievements. ` +
    "Credentials stay in this browser and are sent directly to the service they belong to."));
  intro.appendChild(make("div", { class: "connections-free-sources" },
    make("span", { class: "connections-free-sources__badge" }, "Always on"),
    make("span", {}, "Libretro, cover-art-collection, and Wikimedia run without setup."),
  ));

  const summary = make("div", { class: "api-keys-summary", role: "status", "aria-live": "polite" }) as HTMLDivElement;
  intro.appendChild(summary);
  container.appendChild(intro);

  const list = make("div", { class: "api-keys-list", role: "list" });
  container.appendChild(list);

  // Track last-test timestamps & results per provider for the inline message.
  const lastTestAt = new Map<string, number>();
  const lastTestMsg = new Map<string, { kind: "ok" | "error"; text: string }>();

  const rebuild = () => {
    list.innerHTML = "";
    const order = store.getOrder();
    const byId = new Map(store.listProviders().map((p) => [p.id, p]));
    let configured = 0;
    let activeConnected = 0;
    let coverConnected = 0;
    let achievementConnected = 0;
    const recommendedMissing: string[] = [];
    order.forEach((id, index) => {
      const cfg = byId.get(id);
      if (!cfg) return;
      const state = store.getState(id);
      const meta = getConnectionProviderMeta(cfg);
      if (state.key) configured++;
      if (state.key && state.enabled) {
        activeConnected++;
        if (meta.category === "cover" || meta.category === "metadata") coverConnected++;
        if (meta.category === "achievements") achievementConnected++;
      }
      if (meta.recommended && !state.key) recommendedMissing.push(meta.displayName);
      const row = buildRow(cfg, index, order.length);
      list.appendChild(row);
    });
    const nextStep = recommendedMissing[0]
      ? `Connect ${recommendedMissing[0]} next`
      : configured === order.length
        ? "All optional connections are configured"
        : "Optional providers can be added anytime";
    summary.innerHTML = "";
    summary.append(
      buildConnectionSummaryCard("Free covers", "3 active", "No setup needed"),
      buildConnectionSummaryCard("Connected", `${activeConnected} of ${order.length}`, `${coverConnected} artwork / ${achievementConnected} achievements`),
      buildConnectionSummaryCard("Next step", nextStep, "Recommended providers improve match quality"),
    );
  };

  const buildRow = (cfg: ApiKeyProviderConfig, index: number, total: number): HTMLElement => {
    const state = store.getState(cfg.id);
    const meta = getConnectionProviderMeta(cfg);
    const row = make("div", {
      class: `api-key-row${state.enabled ? "" : " api-key-row--disabled"}`,
      role: "listitem",
      "data-provider-id": cfg.id,
      draggable: "true",
    });

    // Drag handle (visually obvious; purely decorative for a11y — keyboard
    // users reorder via the ▲/▼ buttons further down the row).
    const dragHandle = make("span", {
      class: "api-key-row__drag",
      "aria-hidden": "true",
      title: "Drag to reorder",
    }, "⋮⋮") as HTMLSpanElement;

    // Header: drag handle + name + status pill.
    const header = make("div", { class: "api-key-row__header" });
    header.appendChild(dragHandle);
    const titleWrap = make("div", { class: "api-key-row__title-wrap" });
    titleWrap.append(
      make("h5", { class: "api-key-row__name" }, meta.displayName),
      make("span", { class: "api-key-row__purpose" }, meta.purposeLabel),
    );
    header.appendChild(titleWrap);
    const statusPill = make("span", {
      class: "api-key-status",
      role: "status",
      "aria-live": "polite",
    }) as HTMLSpanElement;
    header.appendChild(statusPill);
    row.appendChild(header);
    row.appendChild(make("p", { class: "settings-help api-key-row__desc" }, meta.description));

    // Credential input(s) + paste + show/hide toggle.
    const inputWrap = make("div", { class: "api-key-row__input-wrap" });
    const inputId = `api-key-input-${cfg.id}`;
    const hydrated = meta.hydrate(state.key);
    const credentialInputs: HTMLInputElement[] = [];
    const credentialGrid = make("div", { class: "api-key-row__credential-grid" });
    for (const [fieldIndex, field] of meta.fields.entries()) {
      const fieldId = meta.fields.length === 1 ? inputId : `${inputId}-${field.id}`;
      const fieldWrap = make("div", { class: "api-key-row__field" });
      const label = make("label", { class: "api-key-row__label", for: fieldId }, field.label);
      const input = make("input", {
        id: fieldId,
        class: "api-key-input",
        type: field.secret ? "password" : "text",
        autocomplete: "off",
        spellcheck: "false",
        "data-credential-field": field.id,
        "data-secret-field": field.secret ? "true" : "false",
        "aria-label": `${meta.displayName} ${field.label}`,
        placeholder: state.key && meta.fields.length === 1 && fieldIndex === 0
          ? redactKey(state.key)
          : field.placeholder,
      }) as HTMLInputElement;
      input.value = hydrated[field.id] ?? "";
      credentialInputs.push(input);
      fieldWrap.append(label, input);
      credentialGrid.appendChild(fieldWrap);
    }

    const pasteBtn = make("button", {
      type: "button",
      class: "btn btn--ghost btn--sm api-key-paste-btn",
      "aria-label": `Paste ${meta.displayName} credentials from clipboard`,
      title: "Insert text from the clipboard",
    }, "Paste") as HTMLButtonElement;
    pasteBtn.addEventListener("click", () => {
      void (async () => {
        try {
          if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
            onError("Clipboard paste is not available in this browser. Use Ctrl+V (⌘V on Mac) in the field.");
            credentialInputs[0]?.focus();
            return;
          }
          const text = await navigator.clipboard.readText();
          const t = typeof text === "string" ? text.trim() : "";
          if (!t) {
            onError("Clipboard was empty.");
            credentialInputs[0]?.focus();
            return;
          }
          const pasted = meta.hydrate(t);
          let usedStructuredPaste = false;
          for (const input of credentialInputs) {
            const fieldId = input.dataset.credentialField ?? "";
            if (pasted[fieldId]) {
              input.value = pasted[fieldId]!;
              usedStructuredPaste = true;
            }
          }
          if (!usedStructuredPaste && credentialInputs[0]) credentialInputs[0].value = t;
          credentialInputs[0]?.focus();
        } catch {
          onError(
            "Could not read the clipboard — use Ctrl+V in the field, or allow clipboard access for this site.",
          );
          credentialInputs[0]?.focus();
        }
      })();
    });

    const showBtn = make("button", {
      type: "button",
      class: "btn btn--ghost btn--sm api-key-show-btn",
      "aria-label": `Show or hide the ${meta.displayName} secret fields`,
      "aria-pressed": "false",
    }, "Show") as HTMLButtonElement;
    showBtn.addEventListener("click", () => {
      const secretInputs = credentialInputs.filter((input) => input.dataset.secretField === "true");
      const show = secretInputs.some((input) => input.type === "password");
      for (const input of secretInputs) {
        input.type = show ? "text" : "password";
      }
      showBtn.textContent = show ? "Hide" : "Show";
      showBtn.setAttribute("aria-pressed", String(show));
    });

    const keyLine = make("div", { class: "api-key-row__key-line" });
    keyLine.append(credentialGrid, pasteBtn, showBtn);
    inputWrap.append(keyLine);
    row.appendChild(inputWrap);

    // Warning for placeholder-looking values.
    const warn = make("p", { class: "api-key-row__warn", hidden: "true" }) as HTMLElement;
    warn.setAttribute("role", "note");
    row.appendChild(warn);
    const updatePlaceholderWarning = () => {
      const suspicious = credentialInputs.some((input) => looksLikePlaceholderOrUrl(input.value));
      warn.textContent = suspicious
        ? "That value looks like a URL or placeholder - double-check you copied the credential."
        : "";
      warn.hidden = !suspicious;
    };
    for (const input of credentialInputs) input.addEventListener("input", updatePlaceholderWarning);
    // Select all on focus so replacing a previously-saved key is one click.
    for (const input of credentialInputs) input.addEventListener("focus", () => input.select());

    // Inline test-result line (separate from the pill so the full message
    // stays visible without depending on toasts).
    const testMsg = make("p", { class: "api-key-row__test-msg", "aria-live": "polite" }) as HTMLParagraphElement;
    const prev = lastTestMsg.get(cfg.id);
    if (prev) {
      testMsg.classList.add(prev.kind === "ok" ? "api-key-row__test-msg--ok" : "api-key-row__test-msg--error");
      testMsg.textContent = prev.text;
    }
    row.appendChild(testMsg);

    // Actions row.
    const actions = make("div", { class: "api-key-row__actions" });

    const enabledId = `api-key-enabled-${cfg.id}`;
    const enabledWrap = make("label", { class: "api-key-enabled", for: enabledId });
    const enableLabel = cfg.id === "retroachievements"
      ? `Use ${meta.displayName} for achievement tracking`
      : cfg.id === "igdb"
        ? `Use ${meta.displayName} for cover art and game metadata`
        : `Use ${meta.displayName} for cover art`;
    const enabledBox = make("input", {
      id: enabledId, type: "checkbox", class: "api-key-enabled__box",
      "aria-label": enableLabel,
    }) as HTMLInputElement;
    enabledBox.checked = state.enabled;
    enabledBox.addEventListener("change", () => {
      store.setEnabled(cfg.id, enabledBox.checked);
      row.classList.toggle("api-key-row--disabled", !enabledBox.checked);
      renderStatus();
    });
    enabledWrap.append(enabledBox, document.createTextNode(" Enabled"));
    actions.appendChild(enabledWrap);

    const saveBtn = make("button", { type: "button", class: "btn btn--primary" }, "Save & test") as HTMLButtonElement;
    const saveKey = (opts: { testAfterSave?: boolean } = {}) => {
      // Clear stale test feedback BEFORE persisting — persisting triggers a
      // rebuild via the store's change notification, which would otherwise
      // re-render the previous error message from the captured map.
      lastTestMsg.delete(cfg.id);
      lastTestAt.delete(cfg.id);
      const values: Record<string, string> = {};
      for (const input of credentialInputs) values[input.dataset.credentialField ?? "key"] = input.value;
      const result = store.setKey(cfg.id, meta.serialize(values));
      if (result !== true) {
        onError(`${meta.displayName}: ${result}`);
        renderStatus("invalid");
        return false;
      }
      for (const input of credentialInputs) input.value = "";
      if (credentialInputs.length === 1 && credentialInputs[0]) {
        credentialInputs[0].placeholder = redactKey(store.getKey(cfg.id));
      }
      warn.hidden = true;
      testMsg.textContent = "";
      testMsg.className = "api-key-row__test-msg";
      renderStatus();
      if (opts.testAfterSave) void runTest();
      return true;
    };
    saveBtn.addEventListener("click", () => { saveKey({ testAfterSave: true }); });
    // Enter to save for keyboard users.
    for (const input of credentialInputs) input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); saveKey({ testAfterSave: true }); }
    });
    actions.appendChild(saveBtn);

    const removeBtn = make("button", { type: "button", class: "btn btn--ghost" }, "Remove") as HTMLButtonElement;
    removeBtn.addEventListener("click", () => {
      // Clear stale test feedback before the removal triggers a rebuild.
      lastTestMsg.delete(cfg.id);
      lastTestAt.delete(cfg.id);
      store.removeKey(cfg.id);
      for (const [i, input] of credentialInputs.entries()) {
        input.value = "";
        input.placeholder = meta.fields[i]?.placeholder ?? "Paste credential";
      }
      testMsg.textContent = "";
      testMsg.className = "api-key-row__test-msg";
      renderStatus();
    });
    actions.appendChild(removeBtn);

    const testBtn = make("button", { type: "button", class: "btn" }, "Test again") as HTMLButtonElement;
    testBtn.addEventListener("click", () => { void runTest(); });
    actions.appendChild(testBtn);

    const link = make("a", {
      class: "btn btn--ghost api-key-row__signup",
      href: cfg.signupUrl,
      target: "_blank",
      rel: "noopener noreferrer",
    }, `${meta.signupLabel} ->`);
    actions.appendChild(link);

    // Reorder controls (kept as an accessible fallback for drag-and-drop).
    const upBtn = make("button", {
      type: "button", class: "btn btn--ghost api-key-row__reorder",
      "aria-label": `Move ${cfg.name} up`,
    }, "▲") as HTMLButtonElement;
    if (index === 0) upBtn.disabled = true;
    upBtn.addEventListener("click", () => {
      const order = store.getOrder();
      const i = order.indexOf(cfg.id);
      if (i > 0) {
        const next = [...order];
        [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
        store.setOrder(next);
      }
    });
    const downBtn = make("button", {
      type: "button", class: "btn btn--ghost api-key-row__reorder",
      "aria-label": `Move ${cfg.name} down`,
    }, "▼") as HTMLButtonElement;
    if (index >= total - 1) downBtn.disabled = true;
    downBtn.addEventListener("click", () => {
      const order = store.getOrder();
      const i = order.indexOf(cfg.id);
      if (i >= 0 && i < order.length - 1) {
        const next = [...order];
        [next[i + 1], next[i]] = [next[i]!, next[i + 1]!];
        store.setOrder(next);
      }
    });
    actions.append(upBtn, downBtn);

    row.appendChild(actions);

    // Drag-and-drop reordering (HTML5 dnd). Keyboard users have the ▲/▼
    // buttons above, so this is purely an enhancement for pointer users.
    row.addEventListener("dragstart", (ev) => {
      row.classList.add("api-key-row--dragging");
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = "move";
        // Some browsers need a text payload to start the drag.
        try { ev.dataTransfer.setData("text/plain", cfg.id); } catch { /* jsdom */ }
      }
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("api-key-row--dragging");
      list.querySelectorAll(".api-key-row--drag-over")
        .forEach((el) => el.classList.remove("api-key-row--drag-over"));
    });
    row.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      row.classList.add("api-key-row--drag-over");
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("api-key-row--drag-over");
    });
    row.addEventListener("drop", (ev) => {
      ev.preventDefault();
      row.classList.remove("api-key-row--drag-over");
      const sourceId = ev.dataTransfer?.getData("text/plain");
      if (!sourceId || sourceId === cfg.id) return;
      const order = store.getOrder();
      const from = order.indexOf(sourceId);
      const to = order.indexOf(cfg.id);
      if (from < 0 || to < 0) return;
      const next = [...order];
      next.splice(from, 1);
      next.splice(to, 0, sourceId);
      store.setOrder(next);
    });

    const renderStatus = (override?: "invalid" | "ok" | "testing") => {
      const s = store.getState(cfg.id);
      statusPill.classList.remove(
        "api-key-status--active",
        "api-key-status--missing",
        "api-key-status--invalid",
        "api-key-status--disabled",
        "api-key-status--testing",
      );
      if (override === "testing") {
        statusPill.classList.add("api-key-status--testing");
        statusPill.textContent = "Testing…";
        return;
      }
      if (override === "invalid") {
        statusPill.classList.add("api-key-status--invalid");
        statusPill.textContent = "Invalid key";
        return;
      }
      if (!s.key) {
        statusPill.classList.add("api-key-status--missing");
        statusPill.textContent = "No key";
      } else if (!s.enabled) {
        statusPill.classList.add("api-key-status--disabled");
        statusPill.textContent = "Disabled";
      } else if (lastTestMsg.get(cfg.id)?.kind === "error") {
        statusPill.classList.add("api-key-status--invalid");
        statusPill.textContent = "Invalid key";
      } else {
        statusPill.classList.add("api-key-status--active");
        const t = lastTestAt.get(cfg.id);
        // Append last-tested timestamp so the "Active" state communicates
        // freshness of the test rather than just "a key is saved".
        statusPill.textContent = t
          ? `Active · tested ${timeAgo(t)}`
          : "Active";
      }
    };

    const runTest = async () => {
      const s = store.getState(cfg.id);
      if (!s.key) {
        onError(`${meta.displayName}: save credentials before testing.`);
        return;
      }
      const tester = getTester(cfg.id);
      if (!tester) {
        onError(`${meta.displayName}: no tester is registered for this provider.`);
        return;
      }
      renderStatus("testing");
      const origTestText = testBtn.textContent ?? "Test again";
      testBtn.disabled = true;
      testBtn.classList.add("is-loading");
      testBtn.setAttribute("aria-busy", "true");
      testBtn.textContent = "Testing...";
      testMsg.textContent = "";
      testMsg.className = "api-key-row__test-msg";
      try {
        const result = await tester.testConnection();
        if (result === true) {
          lastTestAt.set(cfg.id, Date.now());
          lastTestMsg.set(cfg.id, { kind: "ok", text: `Connection OK - ${meta.displayName} is ready.` });
          testMsg.classList.add("api-key-row__test-msg--ok");
          testMsg.textContent = `Connection OK - ${meta.displayName} is ready.`;
          renderStatus("ok");
        } else {
          lastTestMsg.set(cfg.id, { kind: "error", text: result });
          testMsg.classList.add("api-key-row__test-msg--error");
          testMsg.textContent = result;
          renderStatus("invalid");
          onError(`${meta.displayName}: ${result}`);
        }
      } catch (err) {
        const message = `Could not test ${meta.displayName}: ${err instanceof Error ? err.message : String(err)}`;
        lastTestMsg.set(cfg.id, { kind: "error", text: message });
        testMsg.classList.add("api-key-row__test-msg--error");
        testMsg.textContent = message;
        renderStatus("invalid");
        onError(message);
      } finally {
        testBtn.disabled = false;
        testBtn.classList.remove("is-loading");
        testBtn.removeAttribute("aria-busy");
        testBtn.textContent = origTestText;
        rebuild();
      }
    };

    renderStatus();
    return row;
  };

  // Footer with "restore defaults" link for ordering only.
  const footer = make("div", { class: "settings-section api-keys-footer" });
  const resetBtn = make("button", { type: "button", class: "btn btn--ghost" }, "Restore default order") as HTMLButtonElement;
  resetBtn.addEventListener("click", () => {
    store.resetOrder();
  });
  footer.append(
    make("p", { class: "settings-help" },
      "Providers run in the order shown above. Free sources (Libretro Thumbnails, cover-art-collection, Wikimedia) " +
      "always run first and are not affected by this list.",
    ),
    resetBtn,
  );
  container.appendChild(footer);

  rebuild();
  return store.subscribe(() => rebuild());
}
