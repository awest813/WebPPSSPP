import { createElement as make } from "../dom.js";
import { showError, showInfoToast } from "../toasts.js";
import type { Settings, CloudLibraryConnection } from "../../types/settings.js";
import { GameLibrary, formatRelativeTime } from "../../library.js";
import {
  isGoogleOAuthConfigured,
  isDropboxOAuthConfigured,
  startGoogleOAuth,
  startDropboxOAuth,
  getGoogleClientId,
  getDropboxAppKey,
  setGoogleClientId,
  setDropboxAppKey,
} from "../../oauthPopup.js";
import { getCloudSaveManager } from "../../cloudSaveSingleton.js";
import { createProvider } from "../../cloudLibrary.js";
import {
  WebDAVProvider,
  GoogleDriveProvider,
  DropboxProvider,
  pCloudProvider,
  BlompProvider,
  BoxProvider,
  OneDriveProvider,
  MegaProvider,
} from "../../cloudSave.js";
import { createUuid } from "../../uuid.js";
import { detectSystem } from "../../systems.js";
import { LEGACY_EVENTS } from "../../legacy.js";
import {
  showLoadingOverlay,
  hideLoadingOverlay,
  setLoadingMessage,
  setLoadingSubtitle,
} from "../loadingOverlay.js";

interface CloudProviderMeta {
  id:    string;
  label: string;
}

const CLOUD_PROVIDER_ICON_SVG: Record<string, string> = {
  gdrive: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v11z"/></svg>`,
  dropbox: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
  onedrive: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>`,
  webdav: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  pcloud: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/></svg>`,
  blomp: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>`,
  box: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05"/></svg>`,
  mega: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
};

const OVERLAY_FADE_DELAY_MS = 200;

function cloudProviderPickerIconEl(providerId: string): HTMLElement {
  const wrap = make("span", { class: "cloud-provider-card__icon", "aria-hidden": "true" });
  const svg = CLOUD_PROVIDER_ICON_SVG[providerId];
  wrap.innerHTML = svg ?? CLOUD_PROVIDER_ICON_SVG["webdav"]!;
  return wrap;
}

const CLOUD_SAVE_PROVIDERS: CloudProviderMeta[] = [
  { id: "gdrive",   label: "Google Drive" },
  { id: "dropbox",  label: "Dropbox" },
  { id: "onedrive", label: "OneDrive" },
  { id: "webdav",   label: "WebDAV" },
  { id: "pcloud",   label: "pCloud" },
  { id: "blomp",    label: "Blomp" },
  { id: "box",      label: "Box" },
  { id: "mega",     label: "MEGA" },
];

const CLOUD_LIBRARY_PROVIDERS: CloudProviderMeta[] = [
  { id: "gdrive",   label: "Google Drive" },
  { id: "dropbox",  label: "Dropbox" },
  { id: "onedrive", label: "OneDrive" },
  { id: "webdav",   label: "WebDAV" },
  { id: "pcloud",   label: "pCloud" },
  { id: "blomp",    label: "Blomp" },
  { id: "box",      label: "Box" },
  { id: "mega",     label: "MEGA" },
];

const ALL_CLOUD_PROVIDERS: CloudProviderMeta[] = [
  { id: "gdrive",   label: "Google Drive" },
  { id: "dropbox",  label: "Dropbox" },
  { id: "onedrive", label: "OneDrive" },
  { id: "webdav",   label: "WebDAV" },
  { id: "pcloud",   label: "pCloud" },
  { id: "blomp",    label: "Blomp" },
  { id: "box",      label: "Box" },
  { id: "mega",     label: "MEGA" },
];

function getCloudProviderLabel(id: string): string {
  return ALL_CLOUD_PROVIDERS.find(p => p.id === id)?.label ?? id;
}

function pasteIntoCloudWizardInput(input: HTMLInputElement, fieldNameForErrors: string): void {
  void (async () => {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
        showError("Clipboard paste is not available. Use Ctrl+V (⌘V on Mac) in the field.");
        input.focus();
        return;
      }
      const text = await navigator.clipboard.readText();
      const t = typeof text === "string" ? text.trim() : "";
      if (!t) {
        showError("Clipboard was empty.");
        input.focus();
        return;
      }
      input.value = t;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    } catch {
      showError(
        `Could not read the clipboard for ${fieldNameForErrors} — paste with Ctrl+V in the field, or allow clipboard access for this site.`,
      );
      input.focus();
    }
  })();
}

function appendCloudWizardLabeledField(
  form: HTMLElement,
  labelText: string,
  input: HTMLInputElement,
  pasteAccessibilityName: string,
): void {
  const row = make("div", { class: "settings-input-row" });
  const label = make("label", { class: "settings-input-label", for: input.id }, labelText);
  const line = make("div", { class: "settings-input-paste-line" });
  const pasteBtn = make("button", {
    type: "button",
    class: "btn btn--ghost btn--sm",
    "aria-label": `Paste ${pasteAccessibilityName} from clipboard`,
    title: "Insert text from the clipboard",
  }, "Paste") as HTMLButtonElement;
  pasteBtn.addEventListener("click", () => pasteIntoCloudWizardInput(input, pasteAccessibilityName));
  line.append(input, pasteBtn);
  row.append(label, line);
  form.appendChild(row);
}

function cloudWizardHeadingId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? `cloud-wizard-h-${crypto.randomUUID()}`
    : `cloud-wizard-h-${Date.now().toString(36)}`;
}

function appendOAuthSignInButton(opts: {
  providerId: string;
  providerLabel: string;
  container: HTMLElement;
  tokenInput: HTMLInputElement;
  getErrorEl: () => HTMLElement;
}): boolean {
  const oauthAvailable =
    (opts.providerId === "gdrive" && isGoogleOAuthConfigured()) ||
    (opts.providerId === "dropbox" && isDropboxOAuthConfigured());

  if (!oauthAvailable) return false;

  const oauthRow = make("div", { class: "settings-input-row oauth-signin-row" });
  const oauthBtn = make("button", {
    class: "btn btn--primary oauth-signin-btn",
    type: "button",
    "aria-label": `Sign in with ${opts.providerLabel} (browser OAuth)`,
  }, `Sign in with ${opts.providerLabel}`) as HTMLButtonElement;
  oauthRow.appendChild(oauthBtn);
  opts.container.appendChild(oauthRow);

  const divider = make("div", { class: "oauth-divider", role: "separator" });
  divider.appendChild(make("span", { class: "oauth-divider__line", "aria-hidden": "true" }));
  divider.appendChild(make("span", { class: "oauth-divider__text" }, "Or paste a token"));
  divider.appendChild(make("span", { class: "oauth-divider__line", "aria-hidden": "true" }));
  opts.container.appendChild(divider);

  oauthBtn.addEventListener("click", async () => {
    oauthBtn.disabled = true;
    oauthBtn.textContent = "Waiting for sign-in…";
    try {
      const result = opts.providerId === "gdrive"
        ? await startGoogleOAuth()
        : await startDropboxOAuth();
      opts.tokenInput.value = result.accessToken;
      oauthBtn.textContent = "Signed in";
    } catch (err) {
      oauthBtn.disabled = false;
      oauthBtn.textContent = `Sign in with ${opts.providerLabel}`;
      const msg = err instanceof Error ? err.message : "OAuth sign-in failed.";
      const errorEl = opts.getErrorEl();
      errorEl.textContent = msg;
      errorEl.hidden = false;
    }
  });

  return true;
}

function showCloudConnectDialog(): Promise<boolean> {
  const cloudManager = getCloudSaveManager();

  return new Promise((resolve) => {
    const overlay = make("div", { class: "confirm-overlay" });
    const box = make("div", {
      class: "confirm-box cloud-wizard-box",
      role:  "dialog",
      "aria-modal": "true",
      "aria-label": "Cloud Connection",
    });

    const close = (result: boolean) => {
      document.removeEventListener("keydown", onKeydown, { capture: true });
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), OVERLAY_FADE_DELAY_MS);
      resolve(result);
    };

    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
    };
    document.addEventListener("keydown", onKeydown, { capture: true });
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });

    // ── Step 1: Provider picker ───────────────────────────────────────────────

    const renderStep1 = () => {
      box.innerHTML = "";
      const titleId = cloudWizardHeadingId();
      box.setAttribute("aria-labelledby", titleId);
      box.appendChild(make("h3", { id: titleId, class: "confirm-box__title" }, "Connect Cloud Save Backup"));
      box.appendChild(make("p", { class: "confirm-box__body" },
        "Choose a cloud provider to mirror RetroOasis save states across devices. Core-managed save files and memory cards stay local to this browser."
      ));

      const providerGrid = make("div", { class: "cloud-provider-grid" });
      let selectedId = CLOUD_SAVE_PROVIDERS[0]?.id ?? "local";

      for (const p of CLOUD_SAVE_PROVIDERS) {
        const pCard = make("button", {
          class: `cloud-provider-card${p.id === selectedId ? " active" : ""}`,
          type: "button",
          "aria-label": `${p.label} — backup provider`,
          "aria-pressed": p.id === selectedId ? "true" : "false",
        }) as HTMLButtonElement;
        pCard.appendChild(cloudProviderPickerIconEl(p.id));
        pCard.appendChild(make("span", { class: "cloud-provider-card__label" }, p.label));
        pCard.addEventListener("click", () => {
          selectedId = p.id;
          providerGrid.querySelectorAll(".cloud-provider-card").forEach((c) => {
            c.classList.remove("active");
            c.setAttribute("aria-pressed", "false");
          });
          pCard.classList.add("active");
          pCard.setAttribute("aria-pressed", "true");
        });
        providerGrid.appendChild(pCard);
      }
      box.appendChild(providerGrid);

      const actions = make("div", { class: "confirm-box__actions" });
      const cancelBtn = make("button", { class: "btn" }, "Cancel") as HTMLButtonElement;
      const nextBtn   = make("button", { class: "btn btn--primary" }, "Next →") as HTMLButtonElement;
      cancelBtn.addEventListener("click", () => close(false));
      nextBtn.addEventListener("click", () => renderStep2(selectedId));
      actions.append(cancelBtn, nextBtn);
      box.appendChild(actions);
    };

    // ── Step 2: Credential form ───────────────────────────────────────────────

    const renderStep2 = (providerId: string) => {
      box.innerHTML = "";
      const meta = CLOUD_SAVE_PROVIDERS.find(p => p.id === providerId);
      if (!meta) { close(false); return; }
      const stepTitleId = cloudWizardHeadingId();
      box.setAttribute("aria-labelledby", stepTitleId);
      box.appendChild(make("h3", { id: stepTitleId, class: "confirm-box__title" }, `Connect ${meta.label}`));

      const form = make("div", { class: "cloud-wizard-form" });

      type CredResult = { ok: false; error: string } | { ok: true; data: Record<string, string> };
      let getCredentials: () => CredResult = () => ({ ok: true, data: {} });

      if (providerId === "webdav") {
        const urlInp  = make("input", { type: "url",  id: "csd-url",  class: "settings-input", placeholder: "https://dav.example.com/saves", autocomplete: "off" }) as HTMLInputElement;
        const userInp = make("input", { type: "text", id: "csd-user", class: "settings-input", placeholder: "Username", autocomplete: "username" }) as HTMLInputElement;
        const passInp = make("input", { type: "password", id: "csd-pass", class: "settings-input", placeholder: "Password", autocomplete: "current-password" }) as HTMLInputElement;
        appendCloudWizardLabeledField(form, "Server URL", urlInp, "server URL");
        appendCloudWizardLabeledField(form, "Username", userInp, "username");
        appendCloudWizardLabeledField(form, "Password", passInp, "password");
        getCredentials = () => {
          const url  = urlInp.value.trim();
          const user = userInp.value.trim();
          const pass = passInp.value;
          if (!url)  return { ok: false, error: "Server URL is required." };
          if (!user) return { ok: false, error: "Username is required." };
          return { ok: true, data: { url, user, pass } };
        };

      } else if (providerId === "pcloud") {
        const tokenInp = make("input", { type: "text", id: "csd-token", class: "settings-input", placeholder: "pCloud access token", autocomplete: "off" }) as HTMLInputElement;
        appendCloudWizardLabeledField(form, "Access Token", tokenInp, "access token");

        const regionRow = make("div", { class: "settings-input-row" });
        const regionSel = make("select", { id: "csd-region", class: "settings-input" }) as HTMLSelectElement;
        regionSel.appendChild(Object.assign(document.createElement("option"), { value: "us", textContent: "US" }));
        regionSel.appendChild(Object.assign(document.createElement("option"), { value: "eu", textContent: "EU" }));
        regionRow.append(make("label", { class: "settings-input-label", for: "csd-region" }, "Region"), regionSel);

        form.append(regionRow);
        getCredentials = () => {
          const token  = tokenInp.value.trim();
          if (!token) return { ok: false, error: "Access token is required." };
          return { ok: true, data: { token, region: regionSel.value } };
        };

      } else if (providerId === "blomp") {
        const userInp = make("input", { type: "text", id: "csd-user", class: "settings-input", placeholder: "Blomp username", autocomplete: "username" }) as HTMLInputElement;
        const passInp = make("input", { type: "password", id: "csd-pass", class: "settings-input", placeholder: "Password", autocomplete: "current-password" }) as HTMLInputElement;
        const containerInp = make("input", { type: "text", id: "csd-container", class: "settings-input", placeholder: "retrooasis", autocomplete: "off" }) as HTMLInputElement;
        appendCloudWizardLabeledField(form, "Username", userInp, "username");
        appendCloudWizardLabeledField(form, "Password", passInp, "password");
        appendCloudWizardLabeledField(form, "Container (optional)", containerInp, "container name");
        getCredentials = () => {
          const user      = userInp.value.trim();
          const pass      = passInp.value;
          const container = containerInp.value.trim() || "retrooasis";
          if (!user) return { ok: false, error: "Username is required." };
          return { ok: true, data: { user, pass, container } };
        };

      } else if (providerId === "box") {
        const tokenInp = make("input", { type: "text", id: "csd-token", class: "settings-input", placeholder: "Box OAuth access token", autocomplete: "off" }) as HTMLInputElement;
        const folderInp = make("input", { type: "text", id: "csd-folder", class: "settings-input", placeholder: "0 (root)", autocomplete: "off" }) as HTMLInputElement;
        appendCloudWizardLabeledField(form, "Access Token", tokenInp, "access token");
        appendCloudWizardLabeledField(form, "Root Folder ID (optional)", folderInp, "folder ID");
        getCredentials = () => {
          const token    = tokenInp.value.trim();
          const folderId = folderInp.value.trim() || "0";
          if (!token) return { ok: false, error: "Access token is required." };
          return { ok: true, data: { token, folderId } };
        };

      } else if (providerId === "onedrive") {
        const tokenInp = make("input", { type: "text", id: "csd-token", class: "settings-input", placeholder: "OneDrive access token", autocomplete: "off" }) as HTMLInputElement;
        const rootInp = make("input", { type: "text", id: "csd-rootid", class: "settings-input", placeholder: "root (optional)", autocomplete: "off" }) as HTMLInputElement;
        appendCloudWizardLabeledField(form, "Access Token", tokenInp, "access token");
        appendCloudWizardLabeledField(form, "Root Folder ID (optional)", rootInp, "root folder ID");
        getCredentials = () => {
          const token = tokenInp.value.trim();
          if (!token) return { ok: false, error: "Access token is required." };
          return { ok: true, data: { token, rootId: rootInp.value.trim() || "root" } };
        };

      } else if (providerId === "mega") {
        const emailInp = make("input", { type: "email", id: "csd-email", class: "settings-input", placeholder: "MEGA email address", autocomplete: "email" }) as HTMLInputElement;
        const passInp = make("input", { type: "password", id: "csd-pass", class: "settings-input", placeholder: "Password", autocomplete: "current-password" }) as HTMLInputElement;
        appendCloudWizardLabeledField(form, "Email", emailInp, "email");
        appendCloudWizardLabeledField(form, "Password", passInp, "password");
        getCredentials = () => {
          const email = emailInp.value.trim();
          const pass  = passInp.value;
          if (!email) return { ok: false, error: "Email is required." };
          if (!pass)  return { ok: false, error: "Password is required." };
          return { ok: true, data: { email, pass } };
        };

      } else {
        // gdrive, dropbox — OAuth sign-in button + manual access token fallback
        const tokenInp = make("input", { type: "text", id: "csd-token", class: "settings-input", placeholder: `${meta.label} access token`, autocomplete: "off" }) as HTMLInputElement;

        appendOAuthSignInButton({
          providerId,
          providerLabel: meta.label,
          container: form,
          tokenInput: tokenInp,
          getErrorEl: () => errorMsg,
        });

        appendCloudWizardLabeledField(form, "Access Token", tokenInp, "access token");
        getCredentials = () => {
          const token = tokenInp.value.trim();
          if (!token) return { ok: false, error: "Access token is required." };
          return { ok: true, data: { token } };
        };
      }

      box.appendChild(form);

      const errorMsg = make("p", { class: "cloud-wizard-error", "aria-live": "assertive" });
      errorMsg.hidden = true;
      box.appendChild(errorMsg);

      const actions = make("div", { class: "confirm-box__actions" });
      const backBtn    = make("button", { class: "btn" }, "← Back") as HTMLButtonElement;
      const connectBtn = make("button", { class: "btn btn--primary" }, "Connect") as HTMLButtonElement;
      actions.append(backBtn, connectBtn);
      box.appendChild(actions);

      backBtn.addEventListener("click", () => renderStep1());

      connectBtn.addEventListener("click", async () => {
        const creds = getCredentials();
        if (!creds.ok) {
          errorMsg.textContent = creds.error;
          errorMsg.hidden = false;
          return;
        }
        errorMsg.hidden = true;
        connectBtn.disabled = true;
        connectBtn.textContent = "Connecting…";

        try {
          let provider;
          const d = creds.data;
          if (providerId === "webdav") {
            cloudManager.saveWebDAVConfig(d["url"]!, d["user"]!, d["pass"]!);
            provider = new WebDAVProvider(d["url"]!, d["user"]!, d["pass"]!);
          } else if (providerId === "gdrive") {
            cloudManager.saveGDriveConfig(d["token"]!);
            provider = new GoogleDriveProvider(d["token"]!);
          } else if (providerId === "dropbox") {
            cloudManager.saveDropboxConfig(d["token"]!);
            provider = new DropboxProvider(d["token"]!);
          } else if (providerId === "pcloud") {
            cloudManager.savePCloudConfig(d["token"]!, d["region"] as "us" | "eu");
            provider = new pCloudProvider(d["token"]!, d["region"] as "us" | "eu");
          } else if (providerId === "blomp") {
            cloudManager.saveBlompConfig(d["user"]!, d["pass"]!, d["container"]!);
            provider = new BlompProvider(d["user"]!, d["pass"]!, d["container"]!);
          } else if (providerId === "box") {
            cloudManager.saveBoxConfig(d["token"]!, d["folderId"]!);
            provider = new BoxProvider(d["token"]!, d["folderId"]!);
          } else if (providerId === "onedrive") {
            cloudManager.saveOneDriveConfig(d["token"]!, d["rootId"]!);
            provider = new OneDriveProvider(d["token"]!, d["rootId"]!);
          } else if (providerId === "mega") {
            cloudManager.saveMegaConfig(d["email"]!, d["pass"]!);
            provider = new MegaProvider(d["email"]!, d["pass"]!);
          } else {
            throw new Error("Unknown provider.");
          }
          await cloudManager.connect(provider);
          close(true);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "Connection failed.";
          errorMsg.textContent = msg;
          errorMsg.hidden = false;
          connectBtn.disabled = false;
          connectBtn.textContent = "Connect";
        }
      });
    };

    // Kick off step 1
    renderStep1();

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("confirm-overlay--visible"));
  });
}

function showAddCloudLibraryDialog(
  settings:         Settings,
  onSettingsChange: (patch: Partial<Settings>) => void,
  rebuildTab:       () => void,
): Promise<void> {
  return new Promise((resolve) => {
    const overlay = make("div", { class: "confirm-overlay" });
    const box = make("div", {
      class: "confirm-box cloud-wizard-box",
      role:  "dialog",
      "aria-modal": "true",
      "aria-label": "Add Cloud Library Source",
    });

    const close = () => {
      document.removeEventListener("keydown", onKeydown, { capture: true });
      overlay.classList.remove("confirm-overlay--visible");
      setTimeout(() => overlay.remove(), OVERLAY_FADE_DELAY_MS);
      resolve();
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    };
    document.addEventListener("keydown", onKeydown, { capture: true });
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    // ── Step 1: Provider picker ───────────────────────────────────────────────

    const renderStep1 = () => {
      box.innerHTML = "";
      const titleId = cloudWizardHeadingId();
      box.setAttribute("aria-labelledby", titleId);
      box.appendChild(make("h3", { id: titleId, class: "confirm-box__title" }, "Add Cloud Library Source"));
      box.appendChild(make("p", { class: "confirm-box__body" },
        "Choose a cloud provider. Remote games will appear in your library alongside local files."
      ));

      const grid = make("div", { class: "cloud-provider-grid" });
      for (const p of CLOUD_LIBRARY_PROVIDERS) {
        const card = make("button", {
          class: "cloud-provider-card",
          type:  "button",
          "aria-label": p.label,
        }) as HTMLButtonElement;
        card.appendChild(cloudProviderPickerIconEl(p.id));
        card.appendChild(make("span", { class: "cloud-provider-card__label" }, p.label));
        card.addEventListener("click", () => renderStep2(p.id));
        grid.appendChild(card);
      }
      box.appendChild(grid);

      const actions = make("div", { class: "confirm-box__actions" });
      const cancelBtn = make("button", { class: "btn" }, "Cancel") as HTMLButtonElement;
      cancelBtn.addEventListener("click", close);
      actions.appendChild(cancelBtn);
      box.appendChild(actions);
    };

    // ── Step 2: Credential form ───────────────────────────────────────────────

    const renderStep2 = (providerId: string) => {
      box.innerHTML = "";
      const meta = CLOUD_LIBRARY_PROVIDERS.find(p => p.id === providerId);
      if (!meta) { close(); return; }
      const stepTitleId = cloudWizardHeadingId();
      box.setAttribute("aria-labelledby", stepTitleId);
      box.appendChild(make("h3", { id: stepTitleId, class: "confirm-box__title" }, `${meta.label} library`));

      const form = make("div", { class: "cloud-wizard-form" });

      // Connection name
      const nameInp = make("input", {
        type:        "text",
        id:          "cld-name",
        class:       "settings-input",
        placeholder: `My ${meta.label} Library`,
        autocomplete: "off",
      }) as HTMLInputElement;
      appendCloudWizardLabeledField(form, "Display Name", nameInp, "display name");
      form.appendChild(make("p", { class: "settings-help" }, "This name will appear in your library filters."));

      type LibCredResult = { ok: false; error: string } | { ok: true; config: CloudLibraryConnection["config"] };
      let getCredentials: () => LibCredResult = () => ({
        ok: true,
        config: "{}",
      });

      if (providerId === "webdav") {
        const urlInp  = make("input", { type: "url",      id: "cld-url",  class: "settings-input", placeholder: "https://dav.example.com/roms", autocomplete: "off" }) as HTMLInputElement;
        const userInp = make("input", { type: "text",     id: "cld-user", class: "settings-input", placeholder: "Username", autocomplete: "username" }) as HTMLInputElement;
        const passInp = make("input", { type: "password", id: "cld-pass", class: "settings-input", placeholder: "Password", autocomplete: "current-password" }) as HTMLInputElement;
        appendCloudWizardLabeledField(form, "Server URL", urlInp, "server URL");
        appendCloudWizardLabeledField(form, "Username", userInp, "username");
        appendCloudWizardLabeledField(form, "Password", passInp, "password");
        getCredentials = () => {
          const url  = urlInp.value.trim();
          const user = userInp.value.trim();
          const pass = passInp.value;
          if (!url)  return { ok: false, error: "Server URL is required.", config: "{}" };
          if (!user) return { ok: false, error: "Username is required.", config: "{}" };
          return { ok: true, config: JSON.stringify({ url, username: user, password: pass }) };
        };

      } else if (providerId === "pcloud") {
        const tokenInp = make("input", { type: "text", id: "cld-token", class: "settings-input", placeholder: "pCloud access token", autocomplete: "off" }) as HTMLInputElement;
        appendCloudWizardLabeledField(form, "Access Token", tokenInp, "access token");

        const regionRow = make("div", { class: "settings-input-row" });
        const regionSel = make("select", { id: "cld-region", class: "settings-input" }) as HTMLSelectElement;
        regionSel.appendChild(Object.assign(document.createElement("option"), { value: "us", textContent: "US" }));
        regionSel.appendChild(Object.assign(document.createElement("option"), { value: "eu", textContent: "EU" }));
        regionRow.append(make("label", { class: "settings-input-label", for: "cld-region" }, "Region"), regionSel);

        form.append(regionRow);
        getCredentials = () => {
          const token  = tokenInp.value.trim();
          if (!token) return { ok: false, error: "Access token is required.", config: "{}" };
          return { ok: true, config: JSON.stringify({ accessToken: token, region: regionSel.value }) };
        };

      } else if (providerId === "blomp") {
        const userInp = make("input", { type: "text",     id: "cld-user",      class: "settings-input", placeholder: "Blomp username", autocomplete: "username" }) as HTMLInputElement;
        const passInp = make("input", { type: "password", id: "cld-pass",      class: "settings-input", placeholder: "Password", autocomplete: "current-password" }) as HTMLInputElement;
        const containerInp = make("input", { type: "text", id: "cld-container", class: "settings-input", placeholder: "retrooasis", autocomplete: "off" }) as HTMLInputElement;
        appendCloudWizardLabeledField(form, "Username", userInp, "username");
        appendCloudWizardLabeledField(form, "Password", passInp, "password");
        appendCloudWizardLabeledField(form, "Container (optional)", containerInp, "container name");
        getCredentials = () => {
          const user = userInp.value.trim();
          if (!user) return { ok: false, error: "Username is required.", config: "{}" };
          const container = containerInp.value.trim() || "retrooasis";
          return { ok: true, config: JSON.stringify({ username: user, password: passInp.value, container }) };
        };

      } else if (providerId === "onedrive") {
        const tokenInp = make("input", { type: "text", id: "cld-token",  class: "settings-input", placeholder: "OneDrive access token", autocomplete: "off" }) as HTMLInputElement;
        const rootInp = make("input", { type: "text", id: "cld-rootid", class: "settings-input", placeholder: "root (optional)", autocomplete: "off" }) as HTMLInputElement;
        appendCloudWizardLabeledField(form, "Access Token", tokenInp, "access token");
        appendCloudWizardLabeledField(form, "Root Folder ID (optional)", rootInp, "root folder ID");
        getCredentials = () => {
          const token = tokenInp.value.trim();
          if (!token) return { ok: false, error: "Access token is required.", config: "{}" };
          return { ok: true, config: JSON.stringify({ accessToken: token, rootId: rootInp.value.trim() || undefined }) };
        };

      } else if (providerId === "box") {
        const tokenInp = make("input", { type: "text", id: "cld-token",  class: "settings-input", placeholder: "Box OAuth access token", autocomplete: "off" }) as HTMLInputElement;
        const folderInp = make("input", { type: "text", id: "cld-folder", class: "settings-input", placeholder: "0 (root)", autocomplete: "off" }) as HTMLInputElement;
        appendCloudWizardLabeledField(form, "Access Token", tokenInp, "access token");
        appendCloudWizardLabeledField(form, "Root Folder ID (optional)", folderInp, "folder ID");
        getCredentials = () => {
          const token = tokenInp.value.trim();
          if (!token) return { ok: false, error: "Access token is required.", config: "{}" };
          return { ok: true, config: JSON.stringify({ accessToken: token, rootFolderId: folderInp.value.trim() || "0" }) };
        };

      } else if (providerId === "mega") {
        const emailInp = make("input", { type: "email", id: "cld-email", class: "settings-input", placeholder: "MEGA email address", autocomplete: "email" }) as HTMLInputElement;
        const passInp = make("input", { type: "password", id: "cld-pass", class: "settings-input", placeholder: "Password", autocomplete: "current-password" }) as HTMLInputElement;
        appendCloudWizardLabeledField(form, "Email", emailInp, "email");
        appendCloudWizardLabeledField(form, "Password", passInp, "password");
        getCredentials = () => {
          const email = emailInp.value.trim();
          const pass  = passInp.value;
          if (!email) return { ok: false, error: "Email is required.", config: "{}" };
          if (!pass)  return { ok: false, error: "Password is required.", config: "{}" };
          return { ok: true, config: JSON.stringify({ megaEmail: email, megaPassword: pass }) };
        };

      } else {
        // gdrive, dropbox — OAuth sign-in button + manual access token fallback
        const tokenInp = make("input", { type: "text", id: "cld-token", class: "settings-input", placeholder: `${meta.label} access token`, autocomplete: "off" }) as HTMLInputElement;

        appendOAuthSignInButton({
          providerId,
          providerLabel: meta.label,
          container: form,
          tokenInput: tokenInp,
          getErrorEl: () => errorMsg,
        });

        appendCloudWizardLabeledField(form, "Access Token", tokenInp, "access token");
        getCredentials = () => {
          const token = tokenInp.value.trim();
          if (!token) return { ok: false, error: "Access token is required.", config: "{}" };
          return { ok: true, config: JSON.stringify({ accessToken: token }) };
        };
      }

      box.appendChild(form);

      const errorMsg = make("p", { class: "cloud-wizard-error", "aria-live": "assertive" });
      errorMsg.hidden = true;
      box.appendChild(errorMsg);

      const actions = make("div", { class: "confirm-box__actions" });
      const backBtn  = make("button", { class: "btn" }, "← Back") as HTMLButtonElement;
      const saveBtn  = make("button", { class: "btn btn--primary" }, "Add Source") as HTMLButtonElement;
      actions.append(backBtn, saveBtn);
      box.appendChild(actions);

      backBtn.addEventListener("click", () => renderStep1());

      saveBtn.addEventListener("click", () => {
        void (async () => {
          const creds = getCredentials();
          if (!creds.ok) {
            errorMsg.textContent = creds.error;
            errorMsg.hidden = false;
            return;
          }
          errorMsg.hidden = true;

          const probe = createProvider({
            provider: providerId as CloudLibraryConnection["provider"],
            config: creds.config,
          });
          if (!probe) {
            errorMsg.textContent =
              "Those details could not be assembled into a valid connection. Double-check every field.";
            errorMsg.hidden = false;
            return;
          }

          const prevLabel = saveBtn.textContent;
          saveBtn.disabled = true;
          saveBtn.textContent = "Verifying…";

          try {
            if (!(await probe.isAvailable())) {
              errorMsg.textContent =
                "Cannot reach this provider right now. Check the URL or token, fix typos, then try again.";
              errorMsg.hidden = false;
              return;
            }

            const connName = nameInp.value.trim() || meta.label;
            const newConn: CloudLibraryConnection = {
              id:       createUuid(),
              provider: providerId as CloudLibraryConnection["provider"],
              name:     connName,
              enabled:  true,
              config:   creds.config,
            };

            onSettingsChange({ cloudLibraries: [...settings.cloudLibraries, newConn] });
            rebuildTab();
            close();
          } catch (e) {
            errorMsg.textContent =
              e instanceof Error ? e.message : "Could not verify this connection.";
            errorMsg.hidden = false;
          } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = prevLabel ?? "Add Source";
          }
        })();
      });
    };

    // Kick off step 1
    renderStep1();

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("confirm-overlay--visible"));
  });
}

const _cloudLibrarySyncConnIds = new Set<string>();

async function syncCloudLibrary(
  conn: CloudLibraryConnection,
  library: GameLibrary,
  syncTrigger?: HTMLButtonElement,
): Promise<void> {
  if (_cloudLibrarySyncConnIds.has(conn.id)) return;
  _cloudLibrarySyncConnIds.add(conn.id);

  const provider = createProvider(conn);
  if (!provider) {
    _cloudLibrarySyncConnIds.delete(conn.id);
    showError("This connection is missing required fields. Edit or remove it and add the source again.");
    return;
  }

  if (syncTrigger) {
    syncTrigger.disabled = true;
    syncTrigger.setAttribute("aria-busy", "true");
    syncTrigger.classList.add("is-loading");
  }

  showLoadingOverlay();
  setLoadingMessage(`Syncing ${conn.name}…`);
  try {
    if (!(await provider.isAvailable())) {
      throw new Error(
        "Could not reach this provider. Check the network, token expiry, or reconnect the source in Settings → Cloud Storage.",
      );
    }

    setLoadingSubtitle("Scanning root folder for playable files…");
    const files = await provider.listFiles();
    const romFiles = files.filter((f) => !f.isDirectory && detectSystem(f.name));

    setLoadingSubtitle(`Found ${romFiles.length} matching file(s). Updating library…`);

    for (const f of romFiles) {
      const res = detectSystem(f.name);
      if (res) {
        const sys = Array.isArray(res) ? res[0] : res;
        if (!sys) continue;
        const systemId = sys.id;
        await library.upsertVirtualGame(
          f.name.replace(/\.[^.]+$/, ""),
          f.name,
          systemId,
          f.size,
          conn.id,
          f.path,
          f.thumbnailUrl
        );
      }
    }

    if (romFiles.length === 0) {
      showInfoToast(
        `Connected to ${conn.name}, but no supported ROM extensions were found in the root folder. Add files there or nested-folder listing is not run yet.`,
        "info",
      );
    } else {
      showInfoToast(`Synced ${romFiles.length} game file(s) from ${conn.name}.`, "success");
    }
    document.dispatchEvent(new CustomEvent(LEGACY_EVENTS.libraryCatalogNeedsRefresh));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Cloud library sync failed.";
    showError(message);
  } finally {
    _cloudLibrarySyncConnIds.delete(conn.id);
    hideLoadingOverlay();
    if (syncTrigger) {
      syncTrigger.disabled = false;
      syncTrigger.removeAttribute("aria-busy");
      syncTrigger.classList.remove("is-loading");
    }
  }
}

export function buildCloudTab(
  container:        HTMLElement,
  settings:         Settings,
  library:          GameLibrary,
  onSettingsChange: (patch: Partial<Settings>) => void,
  appName?: string,
): void {
  const APP_NAME = appName ?? "RetroOasis";
  container.innerHTML = "";
  const netOffline = typeof navigator !== "undefined" && !navigator.onLine;
  const cloudStorageHeadingId = "settings-cloud-storage-heading";
  const cloudSaveBackupHeadingId = "settings-cloud-save-backup-heading";
  const cloudLibrarySourcesHeadingId = "settings-cloud-library-sources-heading";
  const cloudOauthKeysHeadingId = "settings-cloud-oauth-keys-heading";
  const cloudOauthKeysHelpId = "settings-cloud-oauth-keys-help";

  const section = make("div", {
    class: "settings-section",
    role: "region",
    "aria-labelledby": cloudStorageHeadingId,
  });
  section.appendChild(make("h4", {
    class: "settings-section__title",
    id: cloudStorageHeadingId,
  }, "Cloud Storage"));
  section.appendChild(make("p", { class: "settings-section__desc" }, `${APP_NAME} uses cloud storage in two independent ways: cloud save-state backup mirrors RetroOasis snapshots, and cloud library sources add remote games beside your local ROMs.`));
  const cloudStorageSummary = make("p", {
    class: "cloud-storage-summary",
    role: "status",
    "aria-live": "polite",
  }, "Checking local library cache...");
  void library.getAllGamesMetadata().then((games) => {
    const remoteIndexed = games.filter(game => game.cloudId).length;
    const browserReady = games.filter(game => game.hasLocalBlob).length;
    cloudStorageSummary.textContent =
      `${browserReady} browser-ready game${browserReady === 1 ? "" : "s"} ` +
      `and ${remoteIndexed} cloud-indexed game${remoteIndexed === 1 ? "" : "s"} ready in your library.`;
  }).catch(() => {
    cloudStorageSummary.textContent = "Library storage status could not be read.";
  });
  section.appendChild(cloudStorageSummary);

  const overview = make("div", { class: "cloud-storage-overview" });

  const saveCard = make("div", { class: "cloud-storage-card" });
  saveCard.innerHTML = `
    <div class="cloud-storage-card__eyebrow">Cloud save states</div>
    <h5 class="cloud-storage-card__title">Mirror progress, keep local ownership</h5>
    <p class="cloud-storage-card__body">Snapshots stay in this browser first. When backup is connected, ${APP_NAME} mirrors them quietly to your provider.</p>
  `;

  const libraryCard = make("div", { class: "cloud-storage-card" });
  libraryCard.innerHTML = `
    <div class="cloud-storage-card__eyebrow">Cloud library</div>
    <h5 class="cloud-storage-card__title">Index remote games, cache after play</h5>
    <p class="cloud-storage-card__body">Cloud games appear beside local ROMs. After the first download, a browser copy is kept for faster future launches when storage allows.</p>
  `;

  overview.append(saveCard, libraryCard);
  section.appendChild(overview);

  // ── Cloud save backup section ───────────────────────────────────────────────

  const cloudManager = getCloudSaveManager();
  const cloudSaveTitleEl = () => make("h5", {
    class: "cloud-library-section__title",
    id: cloudSaveBackupHeadingId,
  }, "Cloud Save Backup");

  const saveSection = make("div", {
    class: "cloud-library-section",
    role: "region",
    "aria-labelledby": cloudSaveBackupHeadingId,
  });
  saveSection.appendChild(cloudSaveTitleEl());

  const buildSaveStatus = () => {
    const statusRow = make("div", { class: "cloud-save-status-row" });

    if (cloudManager.isConnected()) {
      const provLabel = getCloudProviderLabel(cloudManager.providerId);
      const statusDot = make("span", { class: "cloud-connection-item__status status--online" }, "Connected");
      const provName  = make("span", { class: "cloud-save-status__provider" }, `${provLabel} backup active`);
      const lastSync  = cloudManager.lastSyncAt
        ? make("span", { class: "cloud-save-status__lastsync" }, `Last sync: ${formatRelativeTime(cloudManager.lastSyncAt)}`)
        : make("span", { class: "cloud-save-status__lastsync" }, "Save states will be mirrored after your next RetroOasis save.");
      const disconnectBtn = make("button", {
        class: "btn btn--sm",
        type: "button",
        "aria-label": `Disconnect cloud save backup (${provLabel})`,
      }, "Disconnect") as HTMLButtonElement;
      disconnectBtn.addEventListener("click", () => {
        cloudManager.disconnect();
        saveSection.innerHTML = "";
        saveSection.appendChild(cloudSaveTitleEl());
        saveSection.appendChild(buildSaveStatus());
      });
      statusRow.append(statusDot, provName, lastSync, disconnectBtn);
      if (cloudManager.lastError) {
        statusRow.appendChild(make("p", {
          class: "cloud-save-status__error",
          role: "status",
          "aria-live": "polite",
        }, `Last backup issue: ${cloudManager.lastError}`));
      }
    } else {
      const hint = make("p", { class: "settings-help" },
        "Save states live in your browser. Connect a cloud provider to keep those RetroOasis snapshots backed up and accessible on other devices."
      );
      const connectBtn = make("button", {
        class: "btn btn--primary",
        type: "button",
        "aria-label": `Connect cloud backup — ${APP_NAME} will open a dialog to choose a cloud provider`,
      }, "Connect cloud backup") as HTMLButtonElement;
      connectBtn.addEventListener("click", () => {
        void showCloudConnectDialog().then(connected => {
          if (connected) {
            saveSection.innerHTML = "";
            saveSection.appendChild(cloudSaveTitleEl());
            saveSection.appendChild(buildSaveStatus());
          }
        });
      });
      if (netOffline) {
        connectBtn.disabled = true;
        connectBtn.title = "Connect when you're back online";
      }
      statusRow.append(hint, connectBtn);
    }

    return statusRow;
  };

  saveSection.appendChild(buildSaveStatus());
  section.appendChild(saveSection);

  // ── Cloud library sources section ──────────────────────────────────────────

  const rebuildTab = () => buildCloudTab(container, settings, library, onSettingsChange, appName);

  const list = make("div", { class: "cloud-connection-list" });

  const librarySection = make("div", {
    class: "cloud-library-section",
    role: "region",
    "aria-labelledby": cloudLibrarySourcesHeadingId,
  });
  librarySection.appendChild(make("h5", {
    class: "cloud-library-section__title",
    id: cloudLibrarySourcesHeadingId,
  }, "Cloud Library Sources"));
  librarySection.appendChild(make("p", { class: "settings-help" },
    "Connect a remote folder below. Supported ROM files are indexed beside local games; first launch downloads and stores a browser copy when quota allows."));

  if (settings.cloudLibraries.length === 0) {
    const empty = make("div", { class: "cloud-connection-empty" });
    empty.innerHTML = `<p>No cloud library sources connected yet.</p><p>Your local library still works normally. Add a cloud source to browse remote games alongside it.</p>`;
    list.appendChild(empty);
  } else {
    settings.cloudLibraries.forEach((conn) => {
      const item   = make("div", { class: "cloud-connection-item" });
      const info   = make("div", { class: "cloud-connection-item__info" });
      info.appendChild(make("strong", {}, conn.name));
      const sourceMeta = make("span", {}, `${getCloudProviderLabel(conn.provider)} source`);
      info.appendChild(sourceMeta);
      void library.getAllGamesMetadata().then((games) => {
        const indexedGames = games.filter(game => game.cloudId === conn.id);
        const cached = indexedGames.filter(game => game.hasLocalBlob).length;
        sourceMeta.textContent =
          `${getCloudProviderLabel(conn.provider)} source · ${indexedGames.length} indexed · ${cached} cached`;
      }).catch(() => {
        sourceMeta.textContent = `${getCloudProviderLabel(conn.provider)} source`;
      });

      const statusDot = make("span", { class: "cloud-connection-item__status" }, "Checking...");
      info.appendChild(statusDot);

      // Async availability check — update badge once resolved
      const provider = createProvider(conn);
      if (provider) {
        provider.isAvailable().then(ok => {
          statusDot.textContent = ok ? "Ready" : "Unavailable";
          statusDot.className   = `cloud-connection-item__status ${ok ? "status--online" : "status--offline"}`;
        }).catch(() => {
          statusDot.textContent = "Unavailable";
          statusDot.className   = "cloud-connection-item__status status--offline";
        });
      } else {
        statusDot.textContent = "Config error";
        statusDot.className   = "cloud-connection-item__status status--offline";
      }

      const actions = make("div", { class: "cloud-connection-item__actions" });

      const syncBtn = make("button", {
        class: "btn btn--sm",
        type: "button",
        "aria-label": `Sync remote games from ${conn.name}`,
      }, "Sync");
      syncBtn.addEventListener("click", () => { void syncCloudLibrary(conn, library, syncBtn); });
      if (netOffline) {
        syncBtn.disabled = true;
        syncBtn.title = "Requires an internet connection";
      }

      const removeBtn = make("button", {
        class: "btn btn--sm btn--danger",
        type: "button",
        "aria-label": `Remove cloud library source ${conn.name}`,
      }, "Remove");
      removeBtn.addEventListener("click", () => {
        const filtered = settings.cloudLibraries.filter(c => c.id !== conn.id);
        onSettingsChange({ cloudLibraries: filtered });
        rebuildTab();
      });

      actions.append(syncBtn, removeBtn);
      item.append(info, actions);
      list.appendChild(item);
    });
  }

  const addBtn = make("button", {
    class: "btn btn--primary cloud-connection-add",
    type: "button",
    "aria-label": "Add a new cloud library source",
  }, "Connect New Source");
  addBtn.addEventListener("click", () => {
    void showAddCloudLibraryDialog(settings, onSettingsChange, rebuildTab);
  });
  if (netOffline) {
    addBtn.disabled = true;
    addBtn.title = "Requires an internet connection";
  }

  librarySection.append(list, addBtn);
  section.append(librarySection);

  // ── OAuth App Keys section ────────────────────────────────────────────────

  const oauthSection = make("div", {
    class: "cloud-library-section",
    role: "region",
    "aria-labelledby": cloudOauthKeysHeadingId,
  });
  oauthSection.appendChild(make("h5", {
    class: "cloud-library-section__title",
    id: cloudOauthKeysHeadingId,
  }, "OAuth App Keys (optional)"));
  oauthSection.appendChild(make("p", {
    class: "settings-help",
    id: cloudOauthKeysHelpId,
  },
    "If you have your own Google or Dropbox OAuth app, paste the client ID / app key here (or use Paste next to each field). " +
    "This enables a \"Sign in with…\" button so you can authenticate with one click instead of pasting tokens manually."
  ));

  const gIdRow = make("div", { class: "settings-input-row" });
  const gIdLine = make("div", { class: "settings-input-paste-line" });
  const gIdInp = make("input", {
    type: "text",
    id: "oauth-google-client-id",
    class: "settings-input",
    placeholder: "Google OAuth Client ID",
    autocomplete: "off",
    "aria-describedby": cloudOauthKeysHelpId,
  }) as HTMLInputElement;
  gIdInp.value = getGoogleClientId();
  const gIdPaste = make("button", {
    type: "button",
    class: "btn btn--ghost btn--sm",
    "aria-label": "Paste Google OAuth Client ID from clipboard",
    title: "Insert text from the clipboard",
  }, "Paste") as HTMLButtonElement;
  gIdPaste.addEventListener("click", () => pasteIntoCloudWizardInput(gIdInp, "Google Client ID"));
  gIdLine.append(gIdInp, gIdPaste);
  gIdRow.append(
    make("label", { class: "settings-input-label", for: "oauth-google-client-id" }, "Google Client ID"),
    gIdLine,
  );

  const dbKeyRow = make("div", { class: "settings-input-row" });
  const dbKeyLine = make("div", { class: "settings-input-paste-line" });
  const dbKeyInp = make("input", {
    type: "text",
    id: "oauth-dropbox-app-key",
    class: "settings-input",
    placeholder: "Dropbox App Key",
    autocomplete: "off",
    "aria-describedby": cloudOauthKeysHelpId,
  }) as HTMLInputElement;
  dbKeyInp.value = getDropboxAppKey();
  const dbKeyPaste = make("button", {
    type: "button",
    class: "btn btn--ghost btn--sm",
    "aria-label": "Paste Dropbox App Key from clipboard",
    title: "Insert text from the clipboard",
  }, "Paste") as HTMLButtonElement;
  dbKeyPaste.addEventListener("click", () => pasteIntoCloudWizardInput(dbKeyInp, "Dropbox App Key"));
  dbKeyLine.append(dbKeyInp, dbKeyPaste);
  dbKeyRow.append(
    make("label", { class: "settings-input-label", for: "oauth-dropbox-app-key" }, "Dropbox App Key"),
    dbKeyLine,
  );

  const oauthSaveBtn = make("button", { class: "btn btn--sm", type: "button" }, "Save Keys") as HTMLButtonElement;
  oauthSaveBtn.addEventListener("click", () => {
    setGoogleClientId(gIdInp.value);
    setDropboxAppKey(dbKeyInp.value);
    oauthSaveBtn.textContent = "Saved";
    setTimeout(() => { oauthSaveBtn.textContent = "Save Keys"; }, 1500);
  });

  oauthSection.append(gIdRow, dbKeyRow, oauthSaveBtn);
  section.appendChild(oauthSection);

  container.appendChild(section);
}
