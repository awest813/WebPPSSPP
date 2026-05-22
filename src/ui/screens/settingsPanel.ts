/**
 * settingsPanel.ts — Settings panel overlay with sidebar navigation,
 * tab switching, keyboard navigation, search, and focus management.
 *
 * Extracted from src/ui.ts as part of the modularisation effort.
 */

import { createElement as make } from "../dom.js";
import { trapFocus, isEditableTarget, FOCUSABLE_SELECTOR, safeScrollIntoView } from "../viewHelpers.js";
import { showError } from "../toasts.js";
import { registerNetplayInstance } from "../../netplaySingleton.js";
import { getApiKeyStore, getApiKeyTester } from "../coverArtRegistry.js";
import type { Settings } from "../../types/settings.js";
import type { DeviceCapabilities } from "../../performance.js";
import type { GameLibrary } from "../../library.js";
import type { BiosLibrary } from "../../bios.js";
import type { SaveStateLibrary } from "../../saves.js";
import type { PSPEmulator } from "../../emulator.js";
import type { NetplayManager } from "../../multiplayer.js";
import { buildPerfTab } from "../tabs/PerfTab.js";
import { buildDisplayTab } from "../tabs/DisplayTab.js";
import { buildLibraryTab } from "../tabs/LibraryTab.js";
import { buildCloudTab } from "../tabs/CloudTab.js";
import { buildMultiplayerTab } from "../tabs/MultiplayerTab.js";
import { buildDebugTab } from "../tabs/DebugTab.js";

const APP_NAME = "RetroOasis";

let _settingsPanelEscHandler: ((e: KeyboardEvent) => void) | null = null;
let _settingsPanelFocusTrap: ((e: KeyboardEvent) => void) | null = null;
let _settingsPanelSearchShortcutHandler: ((e: KeyboardEvent) => void) | null = null;
let _settingsTabBarRo: ResizeObserver | null = null;
let _settingsPanelIo: IntersectionObserver | null = null;
let _settingsContentCleanups: Array<() => void> = [];
let _settingsContentToken = 0;
let _settingsTabsModule: typeof import("../settingsTabs.js") | null = null;

export type SettingsTab = "performance" | "display" | "library" | "cloud" | "bios" | "multiplayer" | "achievements" | "apikeys" | "debug" | "about" | "help";
type CanonicalSettingsTab = Exclude<SettingsTab, "help">;

function canonicalSettingsTab(tab: SettingsTab | undefined): CanonicalSettingsTab | undefined {
  return tab === "help" ? "about" : tab;
}

const SETTINGS_SIDEBAR_ICON_SVG: Record<CanonicalSettingsTab, string> = {
  performance: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  display: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>`,
  library: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`,
  cloud: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`,
  bios: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>`,
  multiplayer: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  achievements: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  apikeys: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/><circle cx="7.5" cy="15.5" r="5.5"/><path d="M13 13 6 20"/></svg>`,
  debug: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`,
  about: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
};

function settingsSidebarIconEl(tabId: CanonicalSettingsTab): HTMLElement {
  const wrap = make("span", { class: "settings-sidebar__icon", "aria-hidden": "true" });
  wrap.innerHTML = SETTINGS_SIDEBAR_ICON_SVG[tabId];
  return wrap;
}

async function _loadSettingsTabs(): Promise<typeof import("../settingsTabs.js") | null> {
  if (!_settingsTabsModule) {
    try {
      _settingsTabsModule = await import("../settingsTabs.js");
    } catch {
      return null;
    }
  }
  return _settingsTabsModule;
}

function buildSettingsContent(
  container:        HTMLElement,
  settings:         Settings,
  deviceCaps:       DeviceCapabilities,
  library:          GameLibrary,
  biosLibrary:      BiosLibrary,
  onSettingsChange: (patch: Partial<Settings>) => void,
  emulatorRef?:     PSPEmulator,
  onLaunchGame?:    (file: File, systemId: string, gameId?: string) => Promise<void>,
  saveLibrary?:     SaveStateLibrary,
  getNetplayManager?: () => Promise<NetplayManager>,
  initialTab?:      SettingsTab
): void {
  _settingsContentCleanups.forEach((fn) => {
    try { fn(); } catch { /* ignore stale settings cleanup */ }
  });
  _settingsContentCleanups = [];
  const settingsContentToken = ++_settingsContentToken;
  container.innerHTML = "";

  const settingsShell = make("div", { class: "settings-shell" });
  const quickBar = make("div", { class: "settings-quickbar" });
  const perfModeLabel = settings.performanceMode === "performance" ? "Performance"
    : settings.performanceMode === "quality" ? "Quality"
    : "Auto";
  const tierFriendlyMap: Record<string, string> = { low: "entry-level", medium: "mid-range", high: "high-end" };
  const tierFriendly = tierFriendlyMap[deviceCaps.tier] ?? "unknown";
  const quickInfo = make("p", { class: "settings-quickbar__summary" },
    `Graphics: ${perfModeLabel} \u00b7 ${tierFriendly} device${deviceCaps.isLowSpec ? " \u00b7 optimised mode active" : ""}`
  );
  const searchInput = make("input", {
    class: "settings-search-input",
    type: "search",
    placeholder: "Search settings\u2026",
    "aria-label": "Search settings",
  }) as HTMLInputElement;
  const searchStatus = make("p", { class: "settings-search-status", "aria-live": "polite" });
  quickBar.append(quickInfo, searchInput, searchStatus);
  const activeTabLabel = make("p", { class: "settings-active-tab-label", "aria-live": "polite" });
  quickBar.append(activeTabLabel);

  const tabs: Array<{ id: CanonicalSettingsTab; label: string; ariaLabel: string }> = [
    { id: "performance",  label: "Performance",   ariaLabel: "Performance" },
    { id: "display",      label: "Display",        ariaLabel: "Display" },
    { id: "library",      label: "My Games",       ariaLabel: "My Games" },
    { id: "cloud",        label: "Cloud Storage",  ariaLabel: "Cloud Storage" },
    { id: "bios",         label: "System Files",   ariaLabel: "System Files" },
    { id: "multiplayer",  label: "Play Together",  ariaLabel: "Play Together" },
    { id: "achievements", label: "Achievements",   ariaLabel: "Achievements" },
    { id: "apikeys",      label: "API Keys",       ariaLabel: "API Keys" },
    { id: "debug",        label: "Advanced",       ariaLabel: "Advanced" },
    { id: "about",        label: "Help",            ariaLabel: "Help" },
  ];
  const tabIndexById = new Map<CanonicalSettingsTab, number>(tabs.map((t, i) => [t.id, i]));

  const requestedTab = canonicalSettingsTab(initialTab) ?? "performance";
  let activeTab: CanonicalSettingsTab = tabIndexById.has(requestedTab) ? requestedTab : "performance";
  let suppressScrollSpyUntil = 0;

  const tabBar = make("div", {
    class: "settings-sidebar",
    role: "tablist",
    "aria-label": "Settings sections",
  });
  const bodyEl = make("div", { class: "settings-body" });
  const panelsEl = make("div", { class: "settings-panels" });
  const jumpBar = make("div", { class: "settings-jumpbar", hidden: "true", "aria-label": "Search results" });
  const clearSearchBtn = make("button", {
    class: "btn btn--ghost settings-search-clear",
    type: "button",
    hidden: "true",
    "aria-label": "Clear settings search",
  }, "Clear search") as HTMLButtonElement;
  quickBar.append(clearSearchBtn, jumpBar);

  const tabBtns: HTMLButtonElement[] = [];
  const panels: HTMLElement[] = [];

  // Single-page scrolling view: all panels are visible.
  const switchTab = (id: CanonicalSettingsTab, scroll = true) => {
    if (!tabIndexById.has(id)) return;
    activeTab = id;
    if (scroll) suppressScrollSpyUntil = performance.now() + 900;
    const activeIndex = tabIndexById.get(id) ?? -1;
    tabBtns.forEach((btn, i) => {
      const isActive = tabs[i]!.id === id;
      btn.setAttribute("aria-selected", String(isActive));
      btn.setAttribute("tabindex", isActive ? "0" : "-1");
      btn.classList.toggle("settings-tab--active", isActive);
    });
    
    activeTabLabel.textContent = activeIndex >= 0 ? `Viewing: ${tabs[activeIndex]!.label}` : "";
    
    if (scroll && activeIndex >= 0) {
      const panel = panels[activeIndex]!;
      const top = Math.max(0, panel.offsetTop - panelsEl.offsetTop);
      try {
        bodyEl.scrollTo({ top, behavior: "smooth" });
      } catch {
        bodyEl.scrollTop = top;
        safeScrollIntoView(panel, { behavior: "smooth", block: "start" });
      }
    }
  };

  // IntersectionObserver to spy on scroll position and update active tab.
  // Guard against environments that do not implement the API (e.g. jsdom).
  _settingsPanelIo?.disconnect();
  _settingsPanelIo = typeof IntersectionObserver !== "undefined"
    ? new IntersectionObserver(() => {
        if (performance.now() < suppressScrollSpyUntil) return;
        const scrollAnchor = bodyEl.scrollTop + 96;
        let bestMatch = activeTab;
        let bestOffset = Number.NEGATIVE_INFINITY;
        panels.forEach((panel) => {
          const offset = panel.offsetTop;
          if (offset <= scrollAnchor && offset >= bestOffset) {
            bestOffset = offset;
            bestMatch = panel.id.replace("tab-panel-", "") as CanonicalSettingsTab;
          }
        });
        if (bestOffset > Number.NEGATIVE_INFINITY && bestMatch !== activeTab) {
          switchTab(bestMatch, false);
        }
      }, { root: bodyEl, threshold: 0.2 })
    : null;

  tabs.forEach((tab, i) => {
    const iconEl = settingsSidebarIconEl(tab.id);
    const labelEl = make("span", { class: "settings-sidebar__label" }, tab.label);
    const btn = make("button", {
      id: `tab-${tab.id}`,
      class: "settings-sidebar__item",
      type: "button",
      role: "tab",
      "aria-selected": tab.id === activeTab ? "true" : "false",
      tabindex: tab.id === activeTab ? "0" : "-1",
      "aria-controls": `tab-panel-${tab.id}`,
      "aria-label": tab.ariaLabel,
    }) as HTMLButtonElement;
    btn.append(iconEl, labelEl);
    btn.addEventListener("click", () => switchTab(tab.id));
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
        e.preventDefault();
        const nextIndex =
          e.key === "Home" ? 0 :
          e.key === "End" ? tabs.length - 1 :
          (e.key === "ArrowRight" || e.key === "ArrowDown") ? (i + 1) % tabs.length :
          (i - 1 + tabs.length) % tabs.length;
        const target = tabBtns[nextIndex]!;
        switchTab(tabs[nextIndex]!.id);
        target.focus();
        return;
      }
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        switchTab(tab.id);
      }
    });
    tabBar.appendChild(btn);
    tabBtns.push(btn);

    const panel = make("div", {
      id: `tab-panel-${tab.id}`,
      class: "settings-panel-content",
      role: "tabpanel",
      "aria-hidden": "false",
      "aria-labelledby": `tab-${tab.id}`,
    });
    
    // Add a heading for the section since it's a continuous page
    const panelHeader = make("h2", { class: "settings-panel-header" }, tab.label);
    panel.appendChild(panelHeader);

    panels.push(panel);
    panelsEl.appendChild(panel);
    _settingsPanelIo?.observe(panel);
  });

  bodyEl.appendChild(panelsEl);
  settingsShell.append(tabBar, bodyEl);
  container.append(quickBar, settingsShell);

  const updateTabBarOverflow = () => {
    requestAnimationFrame(() => {
      tabBar.classList.toggle("overflows", tabBar.scrollWidth > tabBar.clientWidth);
    });
  };
  updateTabBarOverflow();
  if (typeof ResizeObserver !== "undefined") {
    _settingsTabBarRo?.disconnect();
    _settingsTabBarRo = new ResizeObserver(updateTabBarOverflow);
    _settingsTabBarRo.observe(tabBar);
  }

  switchTab(activeTab);

  buildPerfTab(panels[0]!, settings, deviceCaps, onSettingsChange, emulatorRef, APP_NAME);
  buildDisplayTab(panels[1]!, settings, deviceCaps, onSettingsChange, emulatorRef, APP_NAME);
  buildLibraryTab(panels[2]!, settings, library, saveLibrary, onSettingsChange, onLaunchGame, emulatorRef, APP_NAME);
  buildCloudTab(panels[3]!, settings, library, onSettingsChange, APP_NAME);
  buildMultiplayerTab(panels[5]!, settings, onSettingsChange, getNetplayManager, settings.lastGameName, emulatorRef?.currentSystem?.id, APP_NAME);
  buildDebugTab(panels[8]!, settings, onSettingsChange, deviceCaps, emulatorRef, getNetplayManager, biosLibrary);
  panels[9]!.appendChild(make("p", { class: "settings-help", role: "status" }, "Loading help..."));

  try {
    void _loadSettingsTabs().then((st) => {
      if (!st) return;
      if (settingsContentToken !== _settingsContentToken) return;
      st.buildBiosTab(panels[4]!, biosLibrary, { appName: APP_NAME, onError: showError });
      st.buildAchievementsTab(panels[6]!, getApiKeyStore(), {
        appName: APP_NAME,
        onError: showError,
      });
      const apiKeysCleanup = st.buildApiKeysTab(panels[7]!, getApiKeyStore(), {
        appName: APP_NAME,
        getTester: (id: string) => getApiKeyTester(id),
        onError: showError,
      });
      _settingsContentCleanups.push(apiKeysCleanup);
      panels[9]!.textContent = "";
      st.buildAboutTab(panels[9]!, APP_NAME);
      if (requestedTab === "about") {
        switchTab("about");
      }
    });
  } catch (e) {
    console.error(`${APP_NAME} settings: dynamic tab load failed`, e);
  }

  const applySearchFilter = () => {
    const query = searchInput.value.trim().toLowerCase();
    let matchedSections = 0;
    jumpBar.innerHTML = "";
    jumpBar.hidden = true;
    clearSearchBtn.hidden = query.length === 0;

    for (let i = 0; i < panels.length; i++) {
      const panel = panels[i]!;
      const sections = Array.from(panel.querySelectorAll<HTMLElement>(".settings-section"));
      let panelMatched = false;
      let firstMatchLabel = "";

      for (const section of sections) {
        const indexedEls = Array.from(section.querySelectorAll<HTMLElement>(
          ".settings-section__title, .radio-row__label, .radio-row__desc, .settings-help, .toggle-row__text, label, button, summary"
        ));
        const haystack = indexedEls.map((el) => el.textContent ?? "").join(" ").toLowerCase();
        const match = query.length === 0 || haystack.includes(query);
        section.hidden = !match;
        if (match) {
          panelMatched = true;
          matchedSections += 1;
          if (!firstMatchLabel) {
            firstMatchLabel = section.querySelector<HTMLElement>(".settings-section__title")?.textContent?.trim() ?? "Section";
          }
        }
      }

      tabBtns[i]!.classList.toggle("settings-tab--match", panelMatched && query.length > 0);
      if (query.length > 0 && panelMatched) {
        const jumpBtn = make("button", {
          class: "settings-jumpbar__btn",
          type: "button",
          "aria-label": `Jump to ${tabs[i]!.label} settings`,
        }, `${tabs[i]!.label}${firstMatchLabel ? ` \u00b7 ${firstMatchLabel}` : ""}`) as HTMLButtonElement;
        jumpBtn.addEventListener("click", () => {
          switchTab(tabs[i]!.id);
          requestAnimationFrame(() => {
            const firstVisibleSection = panel.querySelector<HTMLElement>(".settings-section:not([hidden])");
            if (firstVisibleSection) safeScrollIntoView(firstVisibleSection, { block: "start", behavior: "smooth" });
            const firstFocusable = firstVisibleSection?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
            firstFocusable?.focus();
          });
        });
        jumpBar.appendChild(jumpBtn);
      }
    }

    if (query.length === 0) {
      searchStatus.textContent = "";
      return;
    }
    jumpBar.hidden = matchedSections === 0;
    searchStatus.textContent = matchedSections > 0
      ? `${matchedSections} matching section${matchedSections === 1 ? "" : "s"}`
      : "No matching settings";
  };
  searchInput.addEventListener("input", applySearchFilter);
  clearSearchBtn.addEventListener("click", () => {
    searchInput.value = "";
    applySearchFilter();
    searchInput.focus();
  });
}

export function closeSettingsPanel(): void {
  const panel = document.getElementById("settings-panel");
  if (panel && !panel.hidden) {
    panel.hidden = true;
  }
  if (_settingsPanelEscHandler) {
    document.removeEventListener("keydown", _settingsPanelEscHandler);
    _settingsPanelEscHandler = null;
  }
  if (_settingsPanelFocusTrap) {
    document.removeEventListener("keydown", _settingsPanelFocusTrap);
    _settingsPanelFocusTrap = null;
  }
  if (_settingsPanelSearchShortcutHandler) {
    document.removeEventListener("keydown", _settingsPanelSearchShortcutHandler, { capture: true });
    _settingsPanelSearchShortcutHandler = null;
  }
  _settingsTabBarRo?.disconnect();
  _settingsTabBarRo = null;
  _settingsPanelIo?.disconnect();
  _settingsPanelIo = null;
  _settingsContentCleanups.forEach((fn) => {
    try { fn(); } catch { /* ignore stale settings cleanup */ }
  });
  _settingsContentCleanups = [];
  _settingsContentToken += 1;
}

export function openSettingsPanel(
  settings:         Settings,
  deviceCaps:       DeviceCapabilities,
  library:          GameLibrary,
  biosLibrary:      BiosLibrary,
  onSettingsChange: (patch: Partial<Settings>) => void,
  emulatorRef?:     PSPEmulator,
  onLaunchGame?:    (file: File, systemId: string, gameId?: string) => Promise<void>,
  saveLibrary?:     SaveStateLibrary,
  getNetplayManagerOrInstance?: (() => Promise<NetplayManager>) | NetplayManager,
  initialTab?:      SettingsTab
): void {
  const panel   = document.getElementById("settings-panel")!;
  const content = document.getElementById("settings-content")!;
  const previousFocus = document.activeElement as HTMLElement | null;

  if (typeof getNetplayManagerOrInstance !== "function" && getNetplayManagerOrInstance != null) {
    registerNetplayInstance(getNetplayManagerOrInstance);
  }
  const getNetplayManager: (() => Promise<NetplayManager>) | undefined =
    typeof getNetplayManagerOrInstance === "function"
      ? getNetplayManagerOrInstance
      : getNetplayManagerOrInstance != null
        ? () => Promise.resolve(getNetplayManagerOrInstance)
        : undefined;

  try {
    buildSettingsContent(content, settings, deviceCaps, library, biosLibrary, onSettingsChange, emulatorRef, onLaunchGame, saveLibrary, getNetplayManager, initialTab);
  } catch (error) {
    console.error(`[${APP_NAME}] Failed to render settings panel`, error);
    content.innerHTML = "";
    const fallback = make("div", { class: "settings-render-error", role: "alert" });
    fallback.append(
      make("h4", { class: "settings-section__title" }, "Settings could not load"),
      make("p", { class: "settings-help" }, error instanceof Error ? error.message : "An unexpected error stopped the settings panel from rendering."),
    );
    content.appendChild(fallback);
  }
  panel.hidden = false;
  if (initialTab) {
    const tabToFocus = canonicalSettingsTab(initialTab);
    const jumpToRequestedTab = () => {
      if (!tabToFocus) return;
      content.querySelector<HTMLButtonElement>(`#tab-${tabToFocus}`)?.click();
    };
    requestAnimationFrame(() => requestAnimationFrame(jumpToRequestedTab));
    window.setTimeout(jumpToRequestedTab, 180);
    window.setTimeout(jumpToRequestedTab, 520);
  }
  requestAnimationFrame(() => {
    (document.getElementById("settings-close") as HTMLButtonElement | null)?.focus();
  });

  const focusTrapFn = (e: KeyboardEvent) => trapFocus(panel, e);

  const close = () => {
    closeSettingsPanel();
    previousFocus?.focus();
  };

  if (_settingsPanelEscHandler) {
    document.removeEventListener("keydown", _settingsPanelEscHandler);
  }
  if (_settingsPanelFocusTrap) {
    document.removeEventListener("keydown", _settingsPanelFocusTrap);
  }
  if (_settingsPanelSearchShortcutHandler) {
    document.removeEventListener("keydown", _settingsPanelSearchShortcutHandler, { capture: true });
  }
  _settingsPanelEscHandler = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (document.querySelector(".confirm-overlay--visible")) return;
    close();
  };
  _settingsPanelFocusTrap  = focusTrapFn;
  _settingsPanelSearchShortcutHandler = (e: KeyboardEvent) => {
    const isSearchShortcut = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k";
    if (!isSearchShortcut || isEditableTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const searchEl = content.querySelector<HTMLInputElement>(".settings-search-input");
    searchEl?.focus();
    searchEl?.select();
  };

  document.getElementById("settings-close")!.onclick   = close;
  document.getElementById("settings-backdrop")!.onclick = close;
  document.addEventListener("keydown", _settingsPanelEscHandler);
  document.addEventListener("keydown", _settingsPanelFocusTrap);
  document.addEventListener("keydown", _settingsPanelSearchShortcutHandler, { capture: true });
}
