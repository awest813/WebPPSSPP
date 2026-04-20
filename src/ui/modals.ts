import { formatBytes, type GameMetadata } from "../library.js";
import type { SystemInfo } from "../systems.js";
import { getSystemById, getSystemFeatureSummary } from "../systems.js";
import type { ArchiveFormat } from "../archive.js";
import { createElement } from "./dom.js";

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
      const btn = createElement("button", { class: "system-pick-btn" });
      const badge = createElement("span", { class: "sys-badge" }, system.shortName);
      badge.style.background = system.color;
      const content = createElement("span", { class: "system-pick-btn__content" });
      content.appendChild(createElement("span", {}, system.name));
      const summary = getSystemFeatureSummary(system);
      if (summary.length > 0) {
        content.appendChild(
          createElement(
            "span",
            {
              class: "system-pick-btn__meta",
              title: system.stabilityNotice ?? "Experimental support",
            },
            summary.join(" • "),
          ),
        );
      }
      btn.append(badge, content);
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
      const btn = createElement("button", { class: "game-picker-btn" });
      const badge = createElement("span", { class: "sys-badge" }, system?.shortName ?? game.systemId);
      badge.style.background = system?.color ?? "#555";
      btn.append(badge, document.createTextNode(` ${game.name}`));
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
): Promise<CoverArtPickResult> {
  return new Promise((resolve) => {
    const overlay = createElement("div", { class: "confirm-overlay" });
    const box = createElement("div", {
      class: "confirm-box cover-art-box",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": `Set Cover Art for ${gameName}`,
    });

    box.appendChild(createElement("h3", { class: "confirm-title" }, "Set Cover Art"));
    box.appendChild(createElement("p", { class: "confirm-body" },
      `Choose an image to use as cover art for "${gameName}".`,
    ));

    // ── File upload section ──────────────────────────────────────────────────
    const fileSection = createElement("div", { class: "cover-art-section" });
    const fileInput = createElement("input", {
      type: "file",
      accept: "image/jpeg,image/png,image/webp,image/gif,image/avif",
      "aria-label": "Upload image file",
      style: "display:none",
    }) as HTMLInputElement;
    const btnFile = createElement("button", { class: "btn btn--primary cover-art-btn" }, "📁 Upload Image File");
    btnFile.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      close({ type: "file", blob: file });
    });
    fileSection.append(fileInput, btnFile);

    // ── URL section ─────────────────────────────────────────────────────────
    const urlSection = createElement("div", { class: "cover-art-section" });
    const urlInput = createElement("input", {
      type: "url",
      placeholder: "https://example.com/cover.jpg",
      "aria-label": "Image URL",
      class: "cover-art-url-input",
    }) as HTMLInputElement;
    const btnUrl = createElement("button", { class: "btn cover-art-btn" }, "🔗 Use Image URL");
    btnUrl.addEventListener("click", () => {
      const url = urlInput.value.trim();
      if (!url) { urlInput.focus(); return; }
      close({ type: "url", url });
    });
    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); btnUrl.click(); }
    });
    urlSection.append(urlInput, btnUrl);

    // ── Auto-fetch section ───────────────────────────────────────────────────
    // Triggers an online search against the community cover-art-collection.
    // The caller runs the provider + candidate picker; this dialog only
    // signals the intent so that all network logic stays in the UI layer.
    const autoSection = createElement("div", { class: "cover-art-section" });
    const btnAuto = createElement(
      "button",
      { class: "btn cover-art-btn" },
      "🔍 Auto-fetch from online",
    );
    btnAuto.addEventListener("click", () => close({ type: "auto" }));
    autoSection.appendChild(btnAuto);

    box.append(fileSection, urlSection, autoSection);

    // ── Footer ───────────────────────────────────────────────────────────────
    const footer = createElement("div", { class: "confirm-footer" });
    const btnCancel = createElement("button", { class: "btn" }, "Cancel");
    footer.appendChild(btnCancel);

    if (hasExistingArt) {
      const btnRemove = createElement("button", { class: "btn btn--danger-filled" }, "🗑 Remove Art");
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
    const box = createElement("div", {
      class: "confirm-box cover-art-box cover-art-candidate-box",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": `Choose cover art for ${gameName}`,
    });

    box.appendChild(createElement("h3", { class: "confirm-title" }, "Choose a cover"));
    box.appendChild(createElement(
      "p",
      { class: "confirm-body" },
      candidates.length === 0
        ? `No online matches were found for "${gameName}". Try uploading an image file instead.`
        : `Pick the best match for "${gameName}". Images come from the community cover-art-collection on GitHub.`,
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
        const card = createElement("button", {
          class: "cover-art-candidate",
          type: "button",
          title: `${c.title} (${Math.round(c.score * 100)}% match, ${c.sourceName})`,
          "aria-label": `Use cover "${c.title}" from ${c.sourceName}`,
        });
        const img = createElement("img", {
          class: "cover-art-candidate__img",
          alt: "",
          loading: "lazy",
          src: c.imageUrl,
        }) as HTMLImageElement;
        // Fall back to a neutral label if the thumbnail fails to load.
        img.addEventListener("error", () => { img.style.opacity = "0.35"; });
        const label = createElement("span", { class: "cover-art-candidate__label" }, c.title);
        card.append(img, label);
        card.addEventListener("click", () => close(c.imageUrl));
        grid.appendChild(card);
      }
      box.appendChild(grid);
    }

    const footer = createElement("div", { class: "confirm-footer" });
    const btnCancel = createElement("button", { class: "btn" }, "Cancel");
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
      btnCancel.focus();
    });
  });
}
