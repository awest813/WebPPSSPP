import { formatBytes, type GameMetadata } from "../library.js";
import type { SystemInfo } from "../systems.js";
import { getSystemById, getSystemFeatureSummary } from "../systems.js";

/**
 * Shared picker row (ambiguous extension + duplicate library entries): premium
 * system icon when available, consistent typography and experimental badge.
 */
function wireSystemPickerRow(
  btn: HTMLButtonElement,
  system: SystemInfo | undefined,
  opts: {
    headline: string;
    /** When set, overrides automatic feature summary for the meta line. */
    metaLine?: string | null;
    /** Short label when `system` is missing (unknown `systemId`). */
    fallbackShort?: string;
  },
): void {
  const short = system?.shortName ?? opts.fallbackShort ?? "?";
  const color = system?.color ?? "#555";

  const visual = createElement("div", { class: "system-pick-btn__visual" });
  if (system?.iconUrl) {
    const img = createElement("img", {
      class: "system-pick-btn__icon",
      src: system.iconUrl,
      alt: "",
      loading: "lazy",
      decoding: "async",
    }) as HTMLImageElement;
    img.addEventListener(
      "error",
      () => {
        img.remove();
        const fb = createElement("span", { class: "sys-badge system-pick-btn__badge-fallback" }, short);
        fb.style.setProperty("--sys-color", color);
        fb.style.background = color;
        visual.appendChild(fb);
      },
      { once: true },
    );
    visual.appendChild(img);
  } else {
    const badge = createElement("span", { class: "sys-badge system-pick-btn__badge-fallback" }, short);
    badge.style.setProperty("--sys-color", color);
    badge.style.background = color;
    visual.appendChild(badge);
  }

  const content = createElement("div", { class: "system-pick-btn__content" });
  const titleRow = createElement("div", { class: "system-pick-btn__title-row" });
  titleRow.appendChild(createElement("span", { class: "system-pick-btn__headline" }, opts.headline));
  if (system?.experimental) {
    titleRow.appendChild(
      createElement(
        "span",
        {
          class: "sys-badge sys-badge--experimental",
          title: system.stabilityNotice ?? "Experimental support",
        },
        "EXP",
      ),
    );
  }
  content.appendChild(titleRow);

  const summary =
    opts.metaLine !== undefined
      ? opts.metaLine
      : system
        ? getSystemFeatureSummary(system).join(" • ")
        : "";
  if (summary) {
    const metaTitle = system?.experimental
      ? (system.stabilityNotice ?? summary)
      : summary;
    content.appendChild(
      createElement(
        "span",
        { class: "system-pick-btn__meta", title: metaTitle },
        summary,
      ),
    );
  }

  btn.append(visual, content);
}
import type { ArchiveFormat } from "../archive.js";
import { createElement } from "./dom.js";
import type { RAProgress, SGDBAssets, IGDBMetadata, IGDBGenre, RAAchievement } from "../types/metadata.js";

export function isTopmostOverlay(overlay: HTMLElement): boolean {
  const all = document.querySelectorAll<HTMLElement>(".confirm-overlay");
  return all.length > 0 && all[all.length - 1] === overlay;
}

export function showConfirmDialog(
  message: string,
  opts: { title?: string; confirmLabel?: string; isDanger?: boolean } = {},
): Promise<boolean> {
  const { title, confirmLabel = "Confirm", isDanger = false } = opts;
  return new Promise((resolve) => {
    const overlay = createElement("div", { class: "confirm-overlay" });
    const box = createElement("div", { class: "confirm-box", role: "dialog", "aria-modal": "true" });
    if (title) box.setAttribute("aria-label", title);
    if (title) box.appendChild(createElement("h3", { class: "confirm-title" }, title));
    box.appendChild(createElement("p", { class: "confirm-body" }, message));

    const footer = createElement("div", { class: "confirm-footer" });
    const btnCancel = createElement("button", { class: "btn" }, "Cancel");
    const btnConfirm = createElement(
      "button",
      { class: isDanger ? "btn btn--danger-filled" : "btn btn--primary" },
      confirmLabel,
    );
    footer.append(btnCancel, btnConfirm);
    box.appendChild(footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = (result: boolean) => {
      document.removeEventListener("keydown", onKey, { capture: true });
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), 200);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopmostOverlay(overlay)) {
        e.preventDefault();
        e.stopPropagation();
        close(false);
      }
    };
    btnCancel.addEventListener("click", () => close(false));
    btnConfirm.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
    });
    document.addEventListener("keydown", onKey, { capture: true });
    requestAnimationFrame(() => {
      overlay.classList.add("confirm-overlay--visible");
      btnConfirm.focus();
    });
  });
}

export function pickSystem(
  fileName: string,
  candidates: SystemInfo[],
  subtitleText?: string,
): Promise<SystemInfo | null> {
  return new Promise((resolve) => {
    const panel = document.getElementById("system-picker")!;
    const list = document.getElementById("system-picker-list")!;
    const subtitle = document.getElementById("system-picker-subtitle")!;
    const closeBtn = document.getElementById("system-picker-close")!;
    const backdrop = document.getElementById("system-picker-backdrop")!;

    subtitle.textContent = subtitleText ?? `The file "${fileName}" could belong to several systems. Choose one:`;
    list.innerHTML = "";
    const fragment = document.createDocumentFragment();
    for (const system of candidates) {
      const btn = createElement("button", { class: "system-pick-btn", type: "button" });
      wireSystemPickerRow(btn, system, { headline: system.name });
      btn.addEventListener("click", () => close(system));
      fragment.appendChild(btn);
    }
    list.appendChild(fragment);
    panel.hidden = false;
    requestAnimationFrame(() => {
      const firstBtn = list.querySelector<HTMLButtonElement>(".system-pick-btn");
      (firstBtn ?? closeBtn).focus();
    });

    let closed = false;
    const onCloseClick = () => close(null);
    const onBackdropClick = () => close(null);

    const close = (result: SystemInfo | null) => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onEsc);
      closeBtn.removeEventListener("click", onCloseClick);
      backdrop.removeEventListener("click", onBackdropClick);
      panel.hidden = true;
      resolve(result);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close(null);
    };
    closeBtn.addEventListener("click", onCloseClick);
    backdrop.addEventListener("click", onBackdropClick);
    document.addEventListener("keydown", onEsc);
  });
}

export function showGamePickerDialog(
  title: string,
  message: string,
  games: GameMetadata[],
): Promise<GameMetadata | null> {
  return new Promise((resolve) => {
    const overlay = createElement("div", { class: "confirm-overlay" });
    const box = createElement("div", { class: "confirm-box", role: "dialog", "aria-modal": "true", "aria-label": title });

    box.appendChild(createElement("h3", { class: "confirm-title" }, title));
    box.appendChild(createElement("p", { class: "confirm-body" }, message));

    const list = createElement("div", { class: "game-picker-list" });
    const fragment = document.createDocumentFragment();
    for (const game of games) {
      const system = getSystemById(game.systemId);
      const btn = createElement("button", { class: "system-pick-btn", type: "button" });
      wireSystemPickerRow(btn, system, {
        headline: game.name,
        metaLine: system
          ? getSystemFeatureSummary(system).join(" • ")
          : game.systemId,
        fallbackShort: game.systemId,
      });
      btn.addEventListener("click", () => close(game));
      fragment.appendChild(btn);
    }
    list.appendChild(fragment);
    box.appendChild(list);

    const cancelBtn = createElement("button", { class: "btn" }, "Cancel");
    cancelBtn.addEventListener("click", () => close(null));
    box.appendChild(cancelBtn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = (result: GameMetadata | null) => {
      document.removeEventListener("keydown", onKey, { capture: true });
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), 200);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopmostOverlay(overlay)) {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      }
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener("keydown", onKey, { capture: true });
    requestAnimationFrame(() => {
      overlay.classList.add("confirm-overlay--visible");
      cancelBtn.focus();
    });
  });
}

export function showArchiveEntryPickerDialog(
  format: ArchiveFormat,
  candidates: Array<{ name: string; blob: Blob; size: number }>,
): Promise<{ name: string; blob: Blob; size: number } | null> {
  return new Promise((resolve) => {
    const overlay = createElement("div", { class: "confirm-overlay" });
    const box = createElement(
      "div",
      { class: "confirm-box archive-picker-box", role: "dialog", "aria-modal": "true", "aria-label": "Choose archive entry" },
    );

    const pretty = format === "gzip" ? "GZIP" : format.toUpperCase();
    box.appendChild(createElement("h3", { class: "confirm-title" }, "Choose File from Archive"));
    box.appendChild(
      createElement(
        "p",
        { class: "confirm-body" },
        `${pretty} archive contains multiple game files. Choose which one to import:`,
      ),
    );

    const list = createElement("div", { class: "game-picker-list" });
    const fragment = document.createDocumentFragment();
    for (const candidate of candidates) {
      const btn = createElement("button", { class: "game-picker-btn" });
      const badge = createElement("span", { class: "sys-badge" }, formatBytes(candidate.size));
      badge.style.background = "var(--c-accent)";
      btn.append(badge, document.createTextNode(` ${candidate.name}`));
      btn.addEventListener("click", () => close(candidate));
      fragment.appendChild(btn);
    }
    list.appendChild(fragment);
    box.appendChild(list);

    const footer = createElement("div", { class: "confirm-footer" });
    const btnCancel = createElement("button", { class: "btn" }, "Cancel");
    footer.appendChild(btnCancel);
    box.appendChild(footer);

    let closed = false;
    const close = (picked: { name: string; blob: Blob; size: number } | null) => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onEsc, { capture: true });
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), 180);
      resolve(picked);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopmostOverlay(overlay)) {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      }
    };
    btnCancel.addEventListener("click", () => close(null));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener("keydown", onEsc, { capture: true });

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.classList.add("confirm-overlay--visible");
      btnCancel.focus();
    });
  });
}

export function showMultiDiscPicker(discFileNames: string[]): Promise<Map<string, File> | null> {
  return new Promise((resolve) => {
    const overlay = createElement("div", { class: "confirm-overlay" });
    const box = createElement(
      "div",
      { class: "confirm-box multidisc-box", role: "dialog", "aria-modal": "true", "aria-label": "Multi-Disc Game Setup" },
    );

    box.appendChild(createElement("h3", { class: "confirm-title" }, "Multi-Disc Game"));
    box.appendChild(createElement(
      "p",
      { class: "confirm-body" },
      `This game spans ${discFileNames.length} disc${discFileNames.length !== 1 ? "s" : ""}. Please select each disc image file:`,
    ));

    const fileMap = new Map<string, File>();

    for (const fileName of discFileNames) {
      const row = createElement("div", { class: "multidisc-row" });
      const status = createElement("span", { class: "bios-dot bios-dot--missing" });
      const label = createElement("span", { class: "multidisc-label" }, fileName);
      const fileInput = createElement("input", { type: "file", style: "display:none", "aria-label": `Select ${fileName}` }) as HTMLInputElement;
      const btn = createElement("button", { class: "btn" }, "Select…");

      btn.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        fileMap.set(fileName, file);
        status.className = "bios-dot bios-dot--ok";
        btn.textContent = file.name;
        checkAllSelected();
      });
      row.append(status, fileInput, label, btn);
      box.appendChild(row);
    }

    const footer = createElement("div", { class: "confirm-footer" });
    const btnCancel = createElement("button", { class: "btn" }, "Cancel");
    const btnConfirm = createElement("button", { class: "btn btn--primary", disabled: "true" }, "Launch Game");
    footer.append(btnCancel, btnConfirm);
    box.appendChild(footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const checkAllSelected = () => {
      const allReady = discFileNames.every((fileName) => fileMap.has(fileName));
      btnConfirm.disabled = !allReady;
    };

    const close = (result: Map<string, File> | null) => {
      document.removeEventListener("keydown", onKey, { capture: true });
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), 200);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopmostOverlay(overlay)) {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      }
    };
    btnCancel.addEventListener("click", () => close(null));
    btnConfirm.addEventListener("click", () => close(fileMap));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener("keydown", onKey, { capture: true });
    requestAnimationFrame(() => {
      overlay.classList.add("confirm-overlay--visible");
      btnCancel.focus();
    });
  });
}

export type CoverArtPickResult =
  | { type: "file"; blob: Blob }
  | { type: "url"; url: string }
  | { type: "auto" }
  | { type: "remove" }
  | null;

/** Optional hooks for the cover-art dialog (e.g. jump to Settings → API Keys). */
export type CoverArtPickerOptions = {
  /** After the dialog closes, open Settings on the API Keys tab. */
  onOpenApiKeysSettings?: () => void;
};

async function readClipboardTextForPaste(): Promise<string | null> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
      const t = await navigator.clipboard.readText();
      return typeof t === "string" ? t : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Modal dialog that lets the user set or remove cover art for a game.
 *
 * Returns:
 *   { type: "file", blob }  — user picked a local image file
 *   { type: "url", url }    — user entered an image URL
 *   { type: "remove" }      — user wants to remove existing art
 *   null                    — cancelled
 */
export function showCoverArtPickerDialog(
  gameName: string,
  hasExistingArt: boolean,
  options?: CoverArtPickerOptions,
): Promise<CoverArtPickResult> {
  return new Promise((resolve) => {
    const overlay = createElement("div", { class: "confirm-overlay" });
    const titleId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? `cover-art-title-${crypto.randomUUID()}`
        : `cover-art-title-${Date.now().toString(36)}`;
    const box = createElement("div", {
      class: "confirm-box cover-art-box",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": titleId,
      "aria-label": `Cover art for ${gameName}`,
    });

    box.appendChild(createElement("h3", { id: titleId, class: "confirm-title cover-art-dialog__title" }, "Cover art"));
    box.appendChild(createElement("p", { class: "confirm-body cover-art-dialog__subtitle" },
      `Choose artwork for “${gameName}”. High-resolution square or portrait images work best.`,
    ));

    // ── File upload section ──────────────────────────────────────────────────
    const fileSection = createElement("div", { class: "cover-art-section cover-art-panel" });
    fileSection.appendChild(createElement("div", { class: "cover-art-panel__label" }, "From your device"));
    const fileInput = createElement("input", {
      type: "file",
      accept: "image/jpeg,image/png,image/webp,image/gif,image/avif",
      "aria-label": "Upload image file",
      style: "display:none",
    }) as HTMLInputElement;
    const btnFile = createElement("button", {
      class: "btn btn--primary cover-art-btn",
      type: "button",
    }, "Upload image…");
    btnFile.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      close({ type: "file", blob: file });
    });
    fileSection.append(fileInput, btnFile);

    // ── URL section ─────────────────────────────────────────────────────────
    const urlSection = createElement("div", { class: "cover-art-section cover-art-panel" });
    urlSection.appendChild(createElement("div", { class: "cover-art-panel__label" }, "From a URL"));
    const urlHelpId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? `cover-art-url-help-${crypto.randomUUID()}`
        : `cover-art-url-help-${Date.now().toString(36)}`;
    const urlClipId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? `cover-art-url-clip-${crypto.randomUUID()}`
        : `cover-art-url-clip-${Date.now().toString(36)}`;
    const urlInput = createElement("input", {
      type: "url",
      placeholder: "https://…/cover.jpg — paste a direct image link",
      "aria-label": "Image URL",
      class: "cover-art-url-input",
      "aria-describedby": `${urlHelpId} ${urlClipId}`.trim(),
      autocomplete: "url",
      inputMode: "url",
      spellcheck: "false",
    }) as HTMLInputElement;
    const urlClipMsg = createElement("p", {
      id: urlClipId,
      class: "cover-art-clipboard-msg",
      role: "status",
      "aria-live": "polite",
      hidden: "",
    }) as HTMLParagraphElement;
    const setUrlClipFeedback = (text: string, ok: boolean) => {
      urlClipMsg.textContent = text;
      urlClipMsg.hidden = !text;
      urlClipMsg.classList.toggle("cover-art-clipboard-msg--ok", ok && !!text);
      urlClipMsg.classList.toggle("cover-art-clipboard-msg--err", !ok && !!text);
      if (text) window.setTimeout(() => { urlClipMsg.textContent = ""; urlClipMsg.hidden = true; }, 5000);
    };
    const btnPasteUrl = createElement("button", {
      class: "btn btn--ghost cover-art-paste-url",
      type: "button",
      "aria-label": "Paste image URL from clipboard",
      title: "Insert text copied to the clipboard",
    }, "Paste");
    btnPasteUrl.addEventListener("click", () => {
      void (async () => {
        const text = await readClipboardTextForPaste();
        if (text === null) {
          setUrlClipFeedback(
            "Could not read the clipboard — paste with Ctrl+V (⌘V on Mac) or allow clipboard access for this site.",
            false,
          );
          urlInput.focus();
          return;
        }
        const trimmed = text.trim();
        if (!trimmed) {
          setUrlClipFeedback("Clipboard was empty.", false);
          urlInput.focus();
          return;
        }
        urlInput.value = trimmed;
        setUrlClipFeedback("Pasted from clipboard.", true);
        urlInput.focus();
      })();
    });
    const urlRow = createElement("div", { class: "cover-art-url-row" });
    urlRow.append(urlInput, btnPasteUrl);
    const btnUrl = createElement("button", {
      class: "btn cover-art-btn",
      type: "button",
      "aria-label": "Use image URL as cover art",
    }, "Use this URL");
    btnUrl.addEventListener("click", () => {
      const url = urlInput.value.trim();
      if (!url) { urlInput.focus(); return; }
      close({ type: "url", url });
    });
    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); btnUrl.click(); }
    });
    const openKeysHandler = options?.onOpenApiKeysSettings;
    const btnOpenKeys = openKeysHandler
      ? createElement("button", {
        class: "btn btn--ghost cover-art-open-apikeys",
        type: "button",
        "aria-label": "Close and open Settings on the API Keys tab",
      }, "Configure API keys…")
      : null;
    urlSection.append(
      urlRow,
      urlClipMsg,
      createElement(
        "p",
        { class: "settings-help cover-art-url-hint", id: urlHelpId },
        "Paste a direct link to an image file (JPEG, PNG, WebP, GIF, AVIF). The host must allow hotlinking (CORS) so the browser can load it. Tip: use Paste, then Enter.",
      ),
      btnUrl,
    );

    // ── Auto-fetch section ───────────────────────────────────────────────────
    // Triggers an online search against the community cover-art-collection.
    // The caller runs the provider + candidate picker; this dialog only
    // signals the intent so that all network logic stays in the UI layer.
    const discoverOffline = typeof navigator !== "undefined" && !navigator.onLine;
    const autoSection = createElement("div", {
      class:
        "cover-art-section cover-art-panel cover-art-panel--discover" +
        (discoverOffline ? " cover-art-panel--discover-offline" : ""),
    });
    autoSection.appendChild(createElement(
      "div",
      { class: "cover-art-panel__label" },
      discoverOffline ? "Unavailable offline" : "Discover online",
    ));
    const autoHint = createElement("p", {
      class: "cover-art-panel__hint",
    }, "Searches your configured cover providers (GitHub collection, Libretro, and any APIs you enable). Use Configure API keys below if you use RAWG, MobyGames, TheGamesDB, or similar.");
    const btnAuto = createElement(
      "button",
      {
        class: "btn btn--highlight cover-art-btn cover-art-btn--discover",
        type: "button",
        "aria-label": discoverOffline
          ? "Search online databases — unavailable while offline"
          : "Search online databases for cover art matching this game",
      },
      "Search & pick…",
    );
    btnAuto.addEventListener("click", () => close({ type: "auto" }));
    if (discoverOffline) {
      btnAuto.disabled = true;
      btnAuto.title = "Requires an internet connection";
      btnAuto.setAttribute("aria-disabled", "true");
      autoHint.hidden = true;
      autoSection.appendChild(createElement(
        "p",
        { class: "cover-art-panel__hint cover-art-panel__hint--offline" },
        "You're offline — upload an image or paste a URL above. Online search returns when you're connected.",
      ));
    }
    autoSection.append(autoHint, btnAuto);
    if (btnOpenKeys) autoSection.appendChild(btnOpenKeys);

    box.append(fileSection, urlSection, autoSection);

    // ── Footer ───────────────────────────────────────────────────────────────
    const footer = createElement("div", { class: "confirm-footer confirm-footer--cover-picker" });
    const btnCancel = createElement("button", { class: "btn", type: "button" }, "Cancel");
    footer.appendChild(btnCancel);

    if (hasExistingArt) {
      const btnRemove = createElement("button", { class: "btn btn--danger-filled", type: "button" }, "Remove art");
      btnRemove.addEventListener("click", () => close({ type: "remove" }));
      footer.appendChild(btnRemove);
    }

    box.appendChild(footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    let closed = false;
    const close = (result: CoverArtPickResult) => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onEsc, { capture: true });
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), 180);
      resolve(result);
    };

    if (btnOpenKeys && openKeysHandler) {
      btnOpenKeys.addEventListener("click", () => {
        close(null);
        requestAnimationFrame(() => openKeysHandler());
      });
    }

    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopmostOverlay(overlay)) {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      }
    };
    btnCancel.addEventListener("click", () => close(null));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
    document.addEventListener("keydown", onEsc, { capture: true });

    requestAnimationFrame(() => {
      overlay.classList.add("confirm-overlay--visible");
      btnFile.focus();
    });
  });
}

// ── Cover art candidate picker ───────────────────────────────────────────────

/**
 * One item shown by the candidate picker. Mirrors the subset of
 * `CoverArtCandidate` the UI needs — the modal is deliberately kept free of
 * network / provider dependencies so it can be reused by future providers.
 */
export interface CoverArtCandidateDisplay {
  title: string;
  imageUrl: string;
  sourceName: string;
  score: number;
}

/**
 * Modal dialog showing up to N candidate covers returned by a provider.
 * Resolves with the selected candidate's `imageUrl`, or `null` when the
 * user cancels / chooses "None of these".
 */
export function showCoverArtCandidatePicker(
  gameName: string,
  candidates: CoverArtCandidateDisplay[],
): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = createElement("div", { class: "confirm-overlay" });
    const candTitleId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? `cover-cand-title-${crypto.randomUUID()}`
        : `cover-cand-title-${Date.now().toString(36)}`;
    const box = createElement("div", {
      class: "confirm-box cover-art-box cover-art-candidate-box",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": candTitleId,
      "aria-label": `Choose cover art for ${gameName}`,
    });

    box.appendChild(createElement("h3", { id: candTitleId, class: "confirm-title cover-art-candidate__title" }, "Pick a cover"));
    box.appendChild(createElement(
      "p",
      { class: "confirm-body cover-art-candidate__intro" },
      candidates.length === 0
        ? `No online matches for “${gameName}”. Upload an image from the previous menu, or paste a direct image URL.`
        : `${candidates.length} match${candidates.length === 1 ? "" : "es"} for “${gameName}” — choose one, or dismiss to try another source in Settings → API Keys.`,
    ));

    let closed = false;
    const close = (result: string | null): void => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onEsc, { capture: true });
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), 180);
      resolve(result);
    };

    if (candidates.length > 0) {
      const grid = createElement("div", { class: "cover-art-candidate-grid" });
      for (const c of candidates) {
        const scorePct = Math.round(c.score * 100);
        const isPerfect = c.score >= 0.99;
        const card = createElement("button", {
          class: `cover-art-candidate${isPerfect ? " cover-art-candidate--perfect" : ""}`,
          type: "button",
          title: `${c.title} — ${scorePct}% match · ${c.sourceName}`,
          "aria-label": `Use cover art: ${c.title}, ${scorePct} percent match from ${c.sourceName}`,
        });

        const img = createElement("img", {
          class: "cover-art-candidate__img",
          alt: "",
          loading: "lazy",
          src: c.imageUrl,
          crossorigin: "anonymous",
        }) as HTMLImageElement;

        // Confidence badge — data attrs drive CSS color coding
        const badge = createElement("div", { class: "cover-art-candidate__score-badge" });
        const scoreSpan = createElement("span", {}, isPerfect ? "Exact match" : `${scorePct}%`);
        if (isPerfect) (scoreSpan as HTMLElement).setAttribute("data-perfect", "1");
        const sourceSpan = createElement("span", {}, c.sourceName);
        (sourceSpan as HTMLElement).setAttribute("data-source", c.sourceName);
        badge.append(scoreSpan, sourceSpan);

        img.addEventListener("error", () => {
          img.style.opacity = "0.25";
          img.alt = "Image unavailable";
        });
        const label = createElement("span", { class: "cover-art-candidate__label" }, c.title);
        card.append(img, badge, label);
        card.addEventListener("click", () => close(c.imageUrl));
        grid.appendChild(card);
      }
      box.appendChild(grid);
    } else {
      // Rich empty state
      const empty = createElement("div", { class: "cover-art-no-results" });
      empty.innerHTML = `
        <div class="cover-art-no-results__icon" aria-hidden="true">✦</div>
        <p class="cover-art-no-results__text">
          No covers found for <strong>“${gameName}”</strong>.<br>
          Use <strong>Upload image</strong> or a direct <strong>image URL</strong> from the cover menu.
        </p>
      `;
      box.appendChild(empty);
    }

    const footer = createElement("div", { class: "confirm-footer confirm-footer--cover-candidates" });
    if (candidates.length > 0) {
      const btnNone = createElement("button", {
        class: "btn btn--ghost",
        type: "button",
      }, "None of these");
      btnNone.addEventListener("click", () => close(null));
      footer.appendChild(btnNone);
    }
    const btnCancel = createElement("button", { class: "btn", type: "button" }, "Close");
    btnCancel.addEventListener("click", () => close(null));
    footer.appendChild(btnCancel);

    box.appendChild(footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && isTopmostOverlay(overlay)) {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      }
    };
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
    document.addEventListener("keydown", onEsc, { capture: true });

    requestAnimationFrame(() => {
      overlay.classList.add("confirm-overlay--visible");
      const first = box.querySelector<HTMLButtonElement>(".cover-art-candidate");
      (first ?? btnCancel).focus();
    });
  });
}


/**
 * Premium Game Details modal.
 * Shows high-res cover art, achievements, play stats, and launch options.
 */
export function showGameDetails(
  game: GameMetadata,
  opts: {
    system: SystemInfo | null;
    formatBytes: (n: number) => string;
    onLaunch: () => void;
    onRemove: () => void;
    onToggleFav: () => void;
    onEditArt: () => void;
    getRAProgress?: () => Promise<RAProgress | null>;
    getSGDBAssets?: () => Promise<SGDBAssets | null>;
    getIGDBMetadata?: () => Promise<IGDBMetadata | null>;
  }
): Promise<void> {
  const { system, formatBytes, onLaunch, onRemove, onToggleFav, onEditArt, getRAProgress, getSGDBAssets, getIGDBMetadata } = opts;

  return new Promise((resolve) => {
    const overlay = createElement("div", { class: "confirm-overlay confirm-overlay--details" });
    const box = createElement("div", {
      class: "details-box",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": `Details for ${game.name}`,
    });

    const close = () => {
      document.removeEventListener("keydown", onKey, { capture: true });
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => { overlay.remove(); resolve(); }, 200);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopmostOverlay(overlay)) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };

    // ── Layout ───────────────────────────────────────────────────────────────
    
    // Background Blur of the cover art
    const bg = createElement("div", { class: "details-bg" });
    if (game.thumbnailUrl) bg.style.backgroundImage = `url(${game.thumbnailUrl})`;
    box.appendChild(bg);

    const content = createElement("div", { class: "details-content" });
    
    // Left: High-res Cover + System Badge
    const left = createElement("div", { class: "details-left" });
    const coverWrap = createElement("div", { class: "details-cover-wrap" });
    if (game.thumbnailUrl) {
      coverWrap.appendChild(createElement("img", { src: game.thumbnailUrl, class: "details-cover", alt: "" }));
    } else {
      coverWrap.appendChild(createElement("div", { class: "details-cover-placeholder" }, "No Art"));
    }
    
    const editArtBtn = createElement("button", { class: "details-edit-art", title: "Change Cover Art" }, "✎");
    editArtBtn.addEventListener("click", onEditArt);
    coverWrap.appendChild(editArtBtn);
    left.appendChild(coverWrap);
    
    if (system) {
      const sysBadge = createElement("div", { class: "details-sys-badge" }, system.shortName);
      sysBadge.style.backgroundColor = system.color;
      left.appendChild(sysBadge);
    }
    
    // Right: Info + Achievements + Actions
    const right = createElement("div", { class: "details-right" });
    
    const header = createElement("div", { class: "details-header" });
    header.appendChild(createElement("h2", { class: "details-title" }, game.name));
    
    const meta = createElement("div", { class: "details-meta" }, 
      `${system?.name || "Unknown System"} • ${formatBytes(game.size)}`
    );
    header.appendChild(meta);
    right.appendChild(header);

    // Apply SGDB Assets if available
    if (getSGDBAssets) {
      void getSGDBAssets().then(assets => {
        if (!assets) return;
        if (assets.heroUrl) {
          bg.style.backgroundImage = `url(${assets.heroUrl})`;
          bg.style.filter = "blur(10px) brightness(0.6)"; 
          bg.style.opacity = "1";
        }
        if (assets.logoUrl) {
          const logo = createElement("img", { src: assets.logoUrl, class: "details-logo", alt: game.name });
          header.querySelector(".details-title")?.replaceWith(logo);
        }
      });
    }

    // Apply IGDB Metadata if available
    if (getIGDBMetadata) {
      void getIGDBMetadata().then(data => {
        if (!data) return;
        
        // Summary
        if (data.summary) {
          const summary = createElement("p", { class: "details-summary" }, data.summary);
          header.appendChild(summary);
        }
        
        // Rating & Genre Pill
        const infoRow = createElement("div", { class: "details-info-row" });
        if (data.rating) {
          const rating = createElement("div", { class: "details-rating" }, `★ ${Math.round(data.rating) / 10}`);
          infoRow.appendChild(rating);
        }
        if (data.genres) {
          data.genres.slice(0, 2).forEach((g: IGDBGenre) => {
            infoRow.appendChild(createElement("div", { class: "details-genre" }, g.name));
          });
        }
        header.appendChild(infoRow);
      });
    }

    // Achievements Section
    const achSection = createElement("div", { class: "details-achievements" });
    if (system?.hasAchievements && getRAProgress) {
      achSection.appendChild(createElement("h4", { class: "details-section-title" }, "Achievements"));
      const progressContainer = createElement("div", { class: "details-ach-loading" }, "Loading achievements…");
      achSection.appendChild(progressContainer);
      
      getRAProgress().then(data => {
        progressContainer.innerHTML = "";
        if (!data) {
          progressContainer.textContent = "RetroAchievements not connected.";
          return;
        }
        
        const bar = createElement("div", { class: "ach-progress-bar" });
        const pct = (data.numUnlocked / data.numAchievements) * 100;
        bar.innerHTML = `<div class="ach-progress-fill" style="width: ${pct}%"></div>`;
        
        const label = createElement("div", { class: "ach-progress-label" }, 
          `${data.numUnlocked} / ${data.numAchievements} Unlocked (${data.pointsEarned} pts)`
        );
        
        progressContainer.append(bar, label);

        // Show a few recent locked/unlocked
        const list = createElement("div", { class: "details-ach-list" });
        data.achievements.slice(0, 3).forEach((ach: RAAchievement) => {
          const item = createElement("div", { class: `details-ach-item ${ach.isUnlocked ? "unlocked" : "locked"}` });
          item.innerHTML = `
            <img src="https://media.retroachievements.org/Badge/${ach.badgeName}.png" class="details-ach-icon" alt="${ach.name} achievement badge">
            <div class="details-ach-text">
              <div class="details-ach-name">${ach.name}</div>
              <div class="details-ach-desc">${ach.description}</div>
            </div>
          `;
          list.appendChild(item);
        });
        progressContainer.appendChild(list);
      }).catch(() => {
        progressContainer.textContent = "Could not fetch achievements.";
      });
    }
    right.appendChild(achSection);

    // Footer Actions
    const footer = createElement("div", { class: "details-footer" });
    
    const launchBtn = createElement("button", { class: "btn btn--primary btn--large" }, "▶ Play Game");
    launchBtn.addEventListener("click", () => { close(); onLaunch(); });
    
    const favBtn = createElement("button", { class: `btn ${game.isFavorite ? "btn--active" : ""}` }, "★ Favorite");
    favBtn.addEventListener("click", () => { 
      onToggleFav(); 
      favBtn.classList.toggle("btn--active");
    });
    
    const strategyBtn = createElement("button", { class: "btn" }, "📚 Strategy");
    strategyBtn.addEventListener("click", () => {
      window.open(`https://strategywiki.org/wiki/Special:Search?search=${encodeURIComponent(game.name)}`, "_blank");
    });
    
    const removeBtn = createElement("button", { class: "btn btn--danger" }, "Remove");
    removeBtn.addEventListener("click", () => { close(); onRemove(); });

    const closeBtn = createElement("button", { class: "btn" }, "Close");
    closeBtn.addEventListener("click", close);

    footer.append(launchBtn, favBtn, strategyBtn, removeBtn, closeBtn);
    right.appendChild(footer);

    content.append(left, right);
    box.appendChild(content);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey, { capture: true });

    requestAnimationFrame(() => {
      overlay.classList.add("confirm-overlay--visible");
      launchBtn.focus();
    });
  });
}
