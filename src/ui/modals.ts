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
    requestAnimationFrame(() => closeBtn.focus());

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
    requestAnimationFrame(() => overlay.classList.add("confirm-overlay--visible"));
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
    requestAnimationFrame(() => overlay.classList.add("confirm-overlay--visible"));
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
      if (allReady) btnConfirm.removeAttribute("disabled");
      else btnConfirm.setAttribute("disabled", "true");
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
    requestAnimationFrame(() => overlay.classList.add("confirm-overlay--visible"));
  });
}
