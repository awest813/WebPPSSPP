import { BiosLibrary, BIOS_REQUIREMENTS } from "../bios.js";
import { SYSTEMS } from "../systems.js";
import { createElement as make } from "./dom.js";
import {
  ApiKeyStore,
  redactKey,
  looksLikePlaceholderOrUrl,
  type ApiKeyProviderConfig,
} from "../apiKeyStore.js";

export function buildBiosTab(container: HTMLElement, biosLibrary: BiosLibrary, opts: {
  appName: string;
  onError(message: string): void;
}): void {
  const { appName, onError } = opts;
  const biosSection = make("div", { class: "settings-section" });
  biosSection.appendChild(make("h4", { class: "settings-section__title" }, "System Startup Files"));
  biosSection.appendChild(make("p", { class: "settings-help" },
    "Some older consoles need a startup file to run games. " +
    "If a game won't start, you may need to add one here. " +
    `You can extract these files from a physical console you own — ${appName} cannot provide them.`
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

      const uploadBtn = make("button", { class: "btn bios-upload-btn" }, "Upload");
      uploadBtn.addEventListener("click", () => uploadInput.click());
      uploadInput.addEventListener("change", async () => {
        const file = uploadInput.files?.[0];
        if (!file) return;
        uploadInput.value = "";
        try {
          const canonical = new File([file], req.fileName, { type: file.type });
          await biosLibrary.addBios(canonical, sysId);
          statusDot.className = "bios-dot bios-dot--ok";
          uploadBtn.textContent = "Replace";
        } catch (err) {
          onError(`BIOS upload failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

      void biosLibrary.findBios(sysId, req.fileName).then((found) => {
        if (found) {
          statusDot.className = "bios-dot bios-dot--ok";
          uploadBtn.textContent = "Replace";
        } else if (req.required) {
          statusDot.className = "bios-dot bios-dot--missing";
        }
      }).catch(() => {});

      row.append(statusDot, uploadInput, labelWrap, requiredBadge, desc, uploadBtn);
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
    "Save your progress with F5, load it back with F7, and press Esc to return to your game library. Saves stay local first, and cloud backup can mirror them if you connect it later.",
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
    "Open ⚙ Settings → Play Together. Turn on Online play and paste the WebSocket URL (wss://…) from whoever runs your server — everyone must use the same URL.",
    "Launch the same game as your friend (same title and system when possible).",
    "Click Play Together on the home screen, or Online in the game toolbar. Host creates a room and shares the invite code; Join pastes the code from your friend.",
    "If something fails, open Play Together and use 📋 Logs to copy connection details for troubleshooting.",
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
    ["Game is slow or choppy", "Open ⚡ Settings → Performance and switch to Performance mode. Closing other browser tabs can also help."],
    ["Saves aren't working", "Your saves live in your browser on this device. If you connect cloud backup, it mirrors those saves instead of replacing them. Clearing browser data will erase the local copy, so export saves first if you want a backup."],
    ["Controls not responding", "Click on the game screen first to make sure it has focus. Gamepads should be connected before launching a game."],
    ["Stuck on loading screen", "Try refreshing the page. If the issue persists, the game file may be corrupted or an unsupported format."],
    ["Can't connect to a friend online", "Confirm Settings → Play Together has the same server URL for both of you, Online play is on, and you are playing the same game. Try 📋 Logs in the Play Together window; strict networks may need a TURN server under Advanced."],
  ];
  for (const [problem, solution] of troubles) {
    const item = make("div", { class: "trouble-item" });
    item.append(make("p", { class: "trouble-item__q" }, `❓ ${problem}`), make("p", { class: "trouble-item__a" }, solution));
    troubleSection.appendChild(item);
  }

  const aboutSection = make("div", { class: "settings-section" });
  aboutSection.appendChild(make("h4", { class: "settings-section__title" }, `About ${appName}`));
  aboutSection.appendChild(make("p", { class: "settings-help" },
    `${appName} lets you play retro games from classic systems — PSP, N64, PS1, NDS, GBA, SNES, NES, Genesis and more — right in your browser. No installs, no account, nothing to sign up for.`
  ));
  aboutSection.appendChild(make("p", { class: "settings-help" },
    `Your local game library and saves stay on this device by default. If you connect cloud storage, cloud saves mirror progress and cloud library sources add remote games beside your local ROMs. ${appName} does not upload anything until you connect a provider.`
  ));

  const links = make("div", { class: "help-links" });
  links.appendChild(make("a", {
    href: "https://emulatorjs.org",
    target: "_blank",
    rel: "noopener",
    class: "btn help-link-btn",
  }, "Powered by EmulatorJS"));
  aboutSection.appendChild(links);

  container.append(quickStartSection, shortcutsSection, mpSection, troubleSection, aboutSection);
}

// ── API Keys tab ─────────────────────────────────────────────────────────────

/**
 * Result of a provider connection test. Providers may be missing a key,
 * unreachable, or rejecting the current key; the UI renders distinct
 * statuses for each case.
 */
export interface ApiKeyProviderTester {
  /** Run a cheap request against the third-party API. */
  testConnection(opts?: { signal?: AbortSignal }): Promise<true | string>;
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
 * Build the "API Keys" settings tab. Renders one row per registered
 * {@link ApiKeyProviderConfig} with:
 *   - masked input + show/hide toggle + Save / Remove buttons
 *   - enabled checkbox (and a visually-dimmed row when disabled)
 *   - status pill (Active / No key / Invalid key / Disabled / Testing)
 *   - "Get an API key" external link and Test button
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
): void {
  const { appName, getTester, onError } = opts;

  // Clear any prior content so the tab is safe to rebuild.
  container.innerHTML = "";

  const intro = make("div", { class: "settings-section" });
  intro.appendChild(make("h4", { class: "settings-section__title" }, "External API Keys"));
  intro.appendChild(make("p", { class: "settings-help" },
    `${appName} can pull cover art and metadata from third-party services that require an account. ` +
    "Add an API key to turn a provider on. Keys are stored only in this browser, and are sent directly " +
    "to the service they belong to — nothing is uploaded by " + appName + "."));

  // Summary badge: "X of Y providers configured".
  const summary = make("p", { class: "settings-help api-keys-summary", role: "status", "aria-live": "polite" }) as HTMLParagraphElement;
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
    order.forEach((id, index) => {
      const cfg = byId.get(id);
      if (!cfg) return;
      if (store.getState(id).key) configured++;
      const row = buildRow(cfg, index, order.length);
      list.appendChild(row);
    });
    summary.textContent = `${configured} of ${order.length} providers configured.`;
  };

  const buildRow = (cfg: ApiKeyProviderConfig, index: number, total: number): HTMLElement => {
    const state = store.getState(cfg.id);
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
    header.appendChild(make("h5", { class: "api-key-row__name" }, cfg.name));
    const statusPill = make("span", {
      class: "api-key-status",
      role: "status",
      "aria-live": "polite",
    }) as HTMLSpanElement;
    header.appendChild(statusPill);
    row.appendChild(header);
    row.appendChild(make("p", { class: "settings-help api-key-row__desc" }, cfg.description));

    // Key input + show/hide toggle.
    const inputWrap = make("div", { class: "api-key-row__input-wrap" });
    const inputId = `api-key-input-${cfg.id}`;
    const label = make("label", { class: "api-key-row__label", for: inputId }, "API key");
    const input = make("input", {
      id: inputId,
      class: "api-key-input",
      type: "password",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": `${cfg.name} API key`,
      placeholder: state.key ? redactKey(state.key) : "Paste your key here",
    }) as HTMLInputElement;
    if (state.key) input.value = state.key;

    const showBtn = make("button", {
      type: "button",
      class: "btn btn--ghost api-key-show-btn",
      "aria-label": `Show or hide the ${cfg.name} API key`,
      "aria-pressed": "false",
    }, "Show") as HTMLButtonElement;
    showBtn.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      showBtn.textContent = show ? "Hide" : "Show";
      showBtn.setAttribute("aria-pressed", String(show));
    });

    inputWrap.append(label, input, showBtn);
    row.appendChild(inputWrap);

    // Warning for placeholder-looking values.
    const warn = make("p", { class: "api-key-row__warn", hidden: "true" }) as HTMLElement;
    warn.setAttribute("role", "note");
    row.appendChild(warn);
    input.addEventListener("input", () => {
      if (looksLikePlaceholderOrUrl(input.value)) {
        warn.textContent = "That value looks like a URL or placeholder — double-check you copied the key.";
        warn.hidden = false;
      } else {
        warn.hidden = true;
      }
    });
    // Select all on focus so replacing a previously-saved key is one click.
    input.addEventListener("focus", () => input.select());

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
    const enabledBox = make("input", {
      id: enabledId, type: "checkbox", class: "api-key-enabled__box",
      "aria-label": `Use ${cfg.name} for cover art`,
    }) as HTMLInputElement;
    enabledBox.checked = state.enabled;
    enabledBox.addEventListener("change", () => {
      store.setEnabled(cfg.id, enabledBox.checked);
      row.classList.toggle("api-key-row--disabled", !enabledBox.checked);
      renderStatus();
    });
    enabledWrap.append(enabledBox, document.createTextNode(" Enabled"));
    actions.appendChild(enabledWrap);

    const saveBtn = make("button", { type: "button", class: "btn btn--primary" }, "Save") as HTMLButtonElement;
    const saveKey = () => {
      // Clear stale test feedback BEFORE persisting — persisting triggers a
      // rebuild via the store's change notification, which would otherwise
      // re-render the previous error message from the captured map.
      lastTestMsg.delete(cfg.id);
      lastTestAt.delete(cfg.id);
      const result = store.setKey(cfg.id, input.value);
      if (result !== true) {
        onError(`${cfg.name}: ${result}`);
        renderStatus("invalid");
        return false;
      }
      input.value = "";
      input.placeholder = redactKey(store.getKey(cfg.id));
      warn.hidden = true;
      testMsg.textContent = "";
      testMsg.className = "api-key-row__test-msg";
      renderStatus();
      return true;
    };
    saveBtn.addEventListener("click", () => { saveKey(); });
    // Enter to save for keyboard users.
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); saveKey(); }
    });
    actions.appendChild(saveBtn);

    const removeBtn = make("button", { type: "button", class: "btn btn--ghost" }, "Remove") as HTMLButtonElement;
    removeBtn.addEventListener("click", () => {
      // Clear stale test feedback before the removal triggers a rebuild.
      lastTestMsg.delete(cfg.id);
      lastTestAt.delete(cfg.id);
      store.removeKey(cfg.id);
      input.value = "";
      input.placeholder = "Paste your key here";
      testMsg.textContent = "";
      testMsg.className = "api-key-row__test-msg";
      renderStatus();
    });
    actions.appendChild(removeBtn);

    const testBtn = make("button", { type: "button", class: "btn" }, "Test") as HTMLButtonElement;
    testBtn.addEventListener("click", () => { void runTest(); });
    actions.appendChild(testBtn);

    const link = make("a", {
      class: "btn btn--ghost api-key-row__signup",
      href: cfg.signupUrl,
      target: "_blank",
      rel: "noopener noreferrer",
    }, "Get an API key ↗");
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
      } else {
        statusPill.classList.add("api-key-status--active");
        const t = lastTestAt.get(cfg.id);
        // Append last-tested timestamp so the "Active" state communicates
        // freshness of the test rather than just "a key is saved".
        statusPill.textContent = t
          ? `Active ✓ · tested ${timeAgo(t)}`
          : (override === "ok" ? "Active ✓" : "Active");
      }
    };

    const runTest = async () => {
      const s = store.getState(cfg.id);
      if (!s.key) {
        onError(`${cfg.name}: save a key before testing.`);
        return;
      }
      const tester = getTester(cfg.id);
      if (!tester) {
        onError(`${cfg.name}: no tester is registered for this provider.`);
        return;
      }
      renderStatus("testing");
      testBtn.disabled = true;
      testBtn.classList.add("is-loading");
      testMsg.textContent = "";
      testMsg.className = "api-key-row__test-msg";
      try {
        const result = await tester.testConnection();
        if (result === true) {
          lastTestAt.set(cfg.id, Date.now());
          lastTestMsg.set(cfg.id, { kind: "ok", text: `Connection OK — ${cfg.name} is ready.` });
          testMsg.classList.add("api-key-row__test-msg--ok");
          testMsg.textContent = `Connection OK — ${cfg.name} is ready.`;
          renderStatus("ok");
        } else {
          lastTestMsg.set(cfg.id, { kind: "error", text: result });
          testMsg.classList.add("api-key-row__test-msg--error");
          testMsg.textContent = result;
          renderStatus("invalid");
          onError(`${cfg.name}: ${result}`);
        }
      } finally {
        testBtn.disabled = false;
        testBtn.classList.remove("is-loading");
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
      "Providers run in the order shown above. Free sources (Libretro Thumbnails, cover-art-collection) " +
      "always run first and are not affected by this list.",
    ),
    resetBtn,
  );
  container.appendChild(footer);

  rebuild();
  store.subscribe(() => rebuild());
}
