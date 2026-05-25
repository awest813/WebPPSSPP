import { createElement as make, buildToggleRow } from "../dom.js";
import { showError, showInfoToast } from "../toasts.js";
import { showConfirmDialog, showGamePickerDialog } from "../modals.js";
import type { Settings } from "../../types/settings.js";
import { type GameMetadata, formatBytes } from "../../library.js";
import { GameLibrary } from "../../library.js";
import { SaveStateLibrary } from "../../saves.js";
import { SYSTEMS, getSystemFeatureSummary } from "../../systems.js";
import type { PSPEmulator } from "../../emulator.js";
import { sessionTracker, formatPlayTime } from "../../sessionTracker.js";

export function buildLibraryTab(
  container:        HTMLElement,
  settings:         Settings,
  library:          GameLibrary,
  saveLibrary:      SaveStateLibrary | undefined,
  onSettingsChange: (patch: Partial<Settings>) => void,
  onLaunchGame?:    (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef?:     PSPEmulator,
  appName = "RetroOasis",
  renderLibraryFn?: (library: GameLibrary, settings: Settings, onLaunchGame?: (file: File, systemId: string, gameId?: string) => Promise<void>, emulatorRef?: PSPEmulator) => Promise<void>
): void {
  // Library stats
  const libraryMyGamesHeadingId = "settings-library-my-games-heading";
  const libSection = make("div", {
    class: "settings-section",
    role: "region",
    "aria-labelledby": libraryMyGamesHeadingId,
  });
  libSection.appendChild(make("h4", {
    class: "settings-section__title",
    id: libraryMyGamesHeadingId,
  }, "My Game Library"));

  const statsEl = make("p", { class: "device-info" }, "Calculating\u2026");
  libSection.appendChild(statsEl);
  const loadStats = () => {
    Promise.all([library.count(), library.totalSize()]).then(([count, total]) => {
      statsEl.textContent = count === 0
        ? "No games added yet \u2014 drop a ROM file to get started!"
        : `${count} game${count !== 1 ? "s" : ""} \u00b7 ${formatBytes(total)} stored in your browser`;
    }).catch(() => {
      statsEl.textContent = "Could not load library stats. ";
      const retryBtn = make("button", { class: "btn btn--sm btn--ghost", type: "button" }, "Retry");
      retryBtn.addEventListener("click", () => { retryBtn.remove(); loadStats(); });
      statsEl.appendChild(retryBtn);
    });
  };
  loadStats();

  const btnClear = make("button", { type: "button", class: "btn btn--danger settings-clear-btn" }, "Remove All Games");
  btnClear.addEventListener("click", async () => {
    const confirmed = await showConfirmDialog(
      "This will remove all games from your library. Your save states will not be deleted.",
      { title: "Remove All Games?", confirmLabel: "Remove All", isDanger: true }
    );
    if (!confirmed) return;
    await library.clearAll();
    // Close the settings panel through the close button so the Escape key
    // handler is removed and focus is properly restored to the caller.
    (document.getElementById("settings-close") as HTMLButtonElement | null)?.click();
    document.title = appName;
    if (onLaunchGame) void renderLibraryFn?.(library, settings, onLaunchGame, emulatorRef);
  });
  libSection.appendChild(btnClear);
  container.appendChild(libSection);

  // Organization
  const libraryOrgHeadingId = "settings-library-organization-heading";
  const orgSection = make("div", {
    class: "settings-section",
    role: "region",
    "aria-labelledby": libraryOrgHeadingId,
  });
  orgSection.appendChild(make("h4", {
    class: "settings-section__title",
    id: libraryOrgHeadingId,
  }, "Organization"));

  orgSection.appendChild(buildToggleRow(
    "Group by system",
    "Enable this to group games by their system (PSP, NES, etc.) or favorites when browsing your library.",
    settings.libraryGrouped,
    (v) => onSettingsChange({ libraryGrouped: v })
  ));
  container.appendChild(orgSection);

  // Save states
  if (saveLibrary) {
    const librarySavesHeadingId = "settings-library-saved-progress-heading";
    const saveSection = make("div", {
      class: "settings-section",
      role: "region",
      "aria-labelledby": librarySavesHeadingId,
    });
    saveSection.appendChild(make("h4", {
      class: "settings-section__title",
      id: librarySavesHeadingId,
    }, "Saved Progress"));

    const saveStatsEl = make("p", { class: "device-info" }, "Calculating\u2026");
    saveSection.appendChild(saveStatsEl);
    saveLibrary.count().then((count) => {
      saveStatsEl.textContent = count === 0
        ? "No saved progress yet \u2014 use Quick Save in-game to snapshot your progress"
        : `${count} save state${count !== 1 ? "s" : ""} stored in your browser`;
    }).catch(() => { saveStatsEl.textContent = "Could not load save stats."; });

    saveSection.appendChild(buildToggleRow(
      "Auto-save when leaving",
      "Automatically save your progress when you close the tab or switch away \u2014 so you never lose unsaved work",
      settings.autoSaveEnabled,
      (v) => onSettingsChange({ autoSaveEnabled: v })
    ));

    const migrateSection = make("div", { class: "settings-subsection" });
    migrateSection.appendChild(make("p", { class: "settings-help" },
      "If you renamed a ROM file, use this tool to move its saves to the new library entry."
    ));

    const btnMigrate = make("button", { type: "button", class: "btn" }, "Migrate Saves\u2026");
    btnMigrate.addEventListener("click", async () => {
      let games: GameMetadata[];
      try { games = await library.getAllGamesMetadata(); } catch { games = []; }
      if (games.length < 2) { showError("You need at least two games in your library to migrate saves."); return; }

      const source = await showGamePickerDialog("Select Source Game", "Choose the game whose saves you want to move:", games);
      if (!source) return;
      const targets = games.filter(g => g.id !== source.id);
      const target = await showGamePickerDialog("Select Target Game", "Choose the game to receive the saves:", targets);
      if (!target) return;

      try {
        const count = await saveLibrary.migrateSaves(source.id, target.id, target.name);
        showInfoToast(count > 0
          ? `Migrated ${count} save state${count !== 1 ? "s" : ""} from "${source.name}" to "${target.name}".`
          : `No saves found for "${source.name}".`
        );
      } catch (err) {
        showError(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    migrateSection.appendChild(btnMigrate);
    saveSection.appendChild(migrateSection);

    const btnClearSaves = make("button", { type: "button", class: "btn btn--danger settings-clear-btn" }, "Clear All Saves");
    btnClearSaves.addEventListener("click", async () => {
      const confirmed = await showConfirmDialog(
        "This will delete all save states and cannot be undone.",
        { title: "Clear All Saves?", confirmLabel: "Clear All", isDanger: true }
      );
      if (!confirmed) return;
      await saveLibrary.clearAll();
      saveStatsEl.textContent = "0 save states stored locally";
    });
    saveSection.appendChild(btnClearSaves);
    container.appendChild(saveSection);
  }

  // Play History
  const libraryHistoryHeadingId = "settings-library-play-history-heading";
  const historySection = make("div", {
    class: "settings-section",
    role: "region",
    "aria-labelledby": libraryHistoryHeadingId,
  });
  historySection.appendChild(make("h4", {
    class: "settings-section__title",
    id: libraryHistoryHeadingId,
  }, "Play History"));

  const historyStatsEl = make("p", { class: "device-info" }, "Calculating\u2026");
  historySection.appendChild(historyStatsEl);
  sessionTracker.getAllStats().then((statsMap) => {
    if (statsMap.size === 0) {
      historyStatsEl.textContent = "No play history recorded yet \u2014 launch a game to start tracking.";
      return;
    }
    let totalMs = 0;
    let sessionCount = 0;
    for (const stats of statsMap.values()) {
      totalMs      += stats.totalMs;
      sessionCount += stats.sessionCount;
    }
    historyStatsEl.textContent =
      `${formatPlayTime(totalMs)} played across ${sessionCount} session${sessionCount !== 1 ? "s" : ""} ` +
      `in ${statsMap.size} game${statsMap.size !== 1 ? "s" : ""}`;
  }).catch(() => { historyStatsEl.textContent = "Could not load play history stats."; });

  historySection.appendChild(buildToggleRow(
    "Record play time",
    "Track how long you play each game. Data is stored only in your browser.",
    settings.recordPlayHistory,
    (v) => onSettingsChange({ recordPlayHistory: v })
  ));

  const btnClearHistory = make("button", { type: "button", class: "btn btn--danger settings-clear-btn" }, "Clear Play History");
  btnClearHistory.addEventListener("click", async () => {
    const confirmed = await showConfirmDialog(
      "This will delete all recorded play sessions and cannot be undone.",
      { title: "Clear Play History?", confirmLabel: "Clear All", isDanger: true }
    );
    if (!confirmed) return;
    await sessionTracker.clearAll();
    historyStatsEl.textContent = "No play history recorded yet \u2014 launch a game to start tracking.";
  });
  historySection.appendChild(btnClearHistory);
  container.appendChild(historySection);

  // Supported systems
  const librarySystemsHeadingId = "settings-library-supported-systems-heading";
  const sysSection = make("div", {
    class: "settings-section",
    role: "region",
    "aria-labelledby": librarySystemsHeadingId,
  });
  sysSection.appendChild(make("h4", {
    class: "settings-section__title",
    id: librarySystemsHeadingId,
  }, "Supported Systems"));
  const sysList = make("div", { class: "sys-list" });
  for (const sys of SYSTEMS) {
    const chip = make("span", { class: "sys-chip" }, sys.shortName);
    chip.style.setProperty("--sys-color", sys.color);
    chip.title = [sys.name, ...getSystemFeatureSummary(sys)].join(" \u2022 ");
    sysList.appendChild(chip);
  }
  sysSection.appendChild(sysList);
  container.appendChild(sysSection);
}
