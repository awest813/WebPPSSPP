/**
 * gameCard.ts — Builds a single game card element with full interactions:
 * play, remove, favorite, patch, system change, cover art management.
 *
 * Extracted from src/ui.ts as part of the modularisation effort.
 */

import { getSystemById, SYSTEMS } from "../../systems.js";
import { type GameMetadata, type GameLibrary, formatBytes, formatRelativeTime, clearGameTierProfile, clearGameGraphicsProfile } from "../../library.js";
import type { PSPEmulator } from "../../emulator.js";
import type { Settings } from "../../types/settings.js";
import { shaderCache } from "../../shaderCache.js";
import { isSvgMarkup, ICON_CLOSE_X_SVG, ICON_TROPHY_SVG } from "../../chromeIcons.js";
import { diagWarn } from "../../diagnosticLog.js";
import { parseRAKey } from "../../raCredentials.js";
import {
  fetchAndValidateCoverArt,
  type CoverArtCandidate,
} from "../../coverArt.js";
import {
  getCoverArtProvider,
  getApiKeyStore,
} from "../coverArtRegistry.js";
import { showInfoToast, showError } from "../toasts.js";
import {
  showLoadingOverlay,
  hideLoadingOverlay,
  setLoadingMessage,
  setLoadingSubtitle,
} from "../loadingOverlay.js";
import { systemIcon } from "../viewHelpers.js";
import { buildSystemFeatureRow } from "../systemFeatures.js";
import {
  showConfirmDialog,
  pickSystem,
  showCoverArtPickerDialog as showCoverArtPickerDialogImpl,
  showCoverArtCandidatePicker,
  showGameDetails,
  type CoverArtPickResult,
} from "../modals.js";
import { createElement as make } from "../dom.js";
import { toLaunchFile } from "../gameImportHelpers.js";
import type { RAProgress } from "../../types/metadata.js";

const _raProgressCache = new Map<string, { data: RAProgress; ts: number }>();
const RA_CACHE_TTL = 10 * 60 * 1000;

function getCachedRAProgress(gameId: string): RAProgress | null {
  const entry = _raProgressCache.get(gameId);
  if (!entry) return null;
  if (Date.now() - entry.ts > RA_CACHE_TTL) {
    _raProgressCache.delete(gameId);
    return null;
  }
  return entry.data;
}

function setCachedRAProgress(gameId: string, data: RAProgress): void {
  _raProgressCache.set(gameId, { data, ts: Date.now() });
}

export function buildGameCard(
  game:          GameMetadata,
  library:       GameLibrary,
  settings:      Settings,
  opts: {
    onLaunchGame:      (file: File, systemId: string, gameId?: string) => Promise<void>;
    onRenderLibrary:   () => void;
    onFetchFromCloud:  (game: GameMetadata, settings: Settings) => Promise<Blob>;
    onOpenApiKeySettings?: () => void;
    emulatorRef?:      PSPEmulator;
    onApplyPatch?:     (gameId: string, patchFile: File) => Promise<void>;
    libraryShowFavorites?: boolean;
  }
): HTMLElement {
  const { onLaunchGame, onRenderLibrary, onFetchFromCloud, onOpenApiKeySettings, emulatorRef, onApplyPatch, libraryShowFavorites } = opts;
  const system = getSystemById(game.systemId);
  const sysColor = system?.color ?? "#555";

  const NEW_THRESHOLD_MS = 24 * 60 * 60 * 1000;
  const isNew = Date.now() - game.addedAt < NEW_THRESHOLD_MS;

  const ariaLabel = isNew
    ? `New game: Play ${game.name} (${system?.shortName ?? game.systemId})`
    : `Play ${game.name} (${system?.shortName ?? game.systemId})`;
  const card = make("div", { class: "game-card", role: "button", tabindex: "0", "aria-label": ariaLabel });
  if (isNew) card.classList.add("game-card--new");
  card.style.setProperty("--sys-color", sysColor);

  const icon = make("div", { class: "game-card__icon" });
  icon.setAttribute("aria-hidden", "true");
  icon.style.setProperty("--sys-gradient", `linear-gradient(135deg, ${sysColor}33, ${sysColor}11)`);

  const cardTop = make("div", { class: "game-card__topline" });
  const cardSystem = make("span", { class: "game-card__system-chip" }, system?.shortName ?? game.systemId.toUpperCase());
  cardSystem.style.setProperty("--sys-color", sysColor);
  const cardStatus = make("span", {
    class: `game-card__status-chip${game.cloudId ? " game-card__status-chip--cloud" : ""}`,
  }, game.cloudId ? "Cloud" : game.lastPlayedAt ? "Played" : "New");
  cardTop.append(cardSystem, cardStatus);
  icon.appendChild(cardTop);

  const sysIconWrap = make("span", { class: "game-card__sys-icon", "aria-hidden": "true" });
  const iconOutput = systemIcon(game.systemId);
  if (iconOutput.includes("/assets/")) {
    const sysImg = make("img", { src: iconOutput, alt: "", class: "sys-icon-img" });
    sysImg.addEventListener("error", () => {
      sysImg.remove();
      sysIconWrap.textContent = system?.shortName ?? game.systemId.toUpperCase();
    }, { once: true });
    sysIconWrap.appendChild(sysImg);
  } else if (isSvgMarkup(iconOutput)) {
    sysIconWrap.innerHTML = iconOutput;
  } else {
    sysIconWrap.textContent = iconOutput;
  }
  icon.appendChild(sysIconWrap);

  if (game.cloudId) {
    const cloudBadge = make("div", { class: "game-card__cloud-badge", title: "Cloud Stream" });
    icon.appendChild(cloudBadge);
  }

  if (isNew) {
    const newBadge = make("div", { class: "game-card__new-badge", "aria-hidden": "true" }, "NEW");
    icon.appendChild(newBadge);
  }

  if (system?.hasAchievements) {
    const achBadge = make("div", { class: "game-card__ach-badge", title: "RetroAchievements Supported" });
    achBadge.innerHTML = ICON_TROPHY_SVG;
    icon.appendChild(achBadge);
  }

  const fallback = make("div", { class: "game-card__fallback" });
  fallback.style.setProperty("--sys-color-bright", `${sysColor}dd`);
  const fallbackIcon = make("div", { class: "game-card__fallback-icon" });
  if (iconOutput.includes("/assets/")) {
    const fallbackImg = make("img", { src: iconOutput, alt: "", class: "game-card__fallback-img" });
    fallbackImg.addEventListener("error", () => {
      fallbackImg.remove();
      fallbackIcon.textContent = system?.shortName ?? game.systemId.toUpperCase();
    }, { once: true });
    fallbackIcon.appendChild(fallbackImg);
  } else if (isSvgMarkup(iconOutput)) {
    fallbackIcon.innerHTML = iconOutput;
  } else {
    fallbackIcon.textContent = iconOutput;
  }
  const fallbackName = make("div", { class: "game-card__fallback-name" }, game.name);
  fallback.append(fallbackIcon, fallbackName);
  icon.appendChild(fallback);

  let coverArtObjectUrl: string | null = null;
  const coverArtImg = make("img", {
    alt: "",
    class: "game-card__cover-art",
    draggable: "false",
    loading: "lazy",
  }) as HTMLImageElement;

  const restoreFallback = () => {
    icon.classList.remove("game-card__icon--has-art");
    if (coverArtImg.parentNode) coverArtImg.parentNode.removeChild(coverArtImg);
    fallback.classList.remove("game-card__fallback--hidden");
    if (coverArtObjectUrl) {
      URL.revokeObjectURL(coverArtObjectUrl);
      coverArtObjectUrl = null;
    }
  };
  coverArtImg.onerror = restoreFallback;

  const applyCoverArt = (src: string) => {
    coverArtImg.src = src;
    icon.classList.add("game-card__icon--has-art");
    if (!icon.contains(coverArtImg)) {
      icon.appendChild(coverArtImg);
    }
    fallback.classList.add("game-card__fallback--hidden");
  };

  if (game.hasCoverArt) {
    void library.getCoverArt(game.id).then((blob) => {
      if (!blob) return;
      if (!icon.isConnected) return;
      coverArtObjectUrl = URL.createObjectURL(blob);
      applyCoverArt(coverArtObjectUrl);
    });
  } else if (game.thumbnailUrl) {
    applyCoverArt(game.thumbnailUrl);
  }

  const info = make("div", { class: "game-card__info" });
  const name = make("div", { class: "game-card__name" }, game.name);
  const meta = make("div", { class: "game-card__meta" });
  const size = make("span", { class: "game-card__size" }, formatBytes(game.size));
  meta.append(size);
  if (system?.experimental) {
    meta.append(make("span", { class: "sys-badge sys-badge--experimental", title: system.stabilityNotice ?? "Experimental support" }, "EXP"));
  }

  const featureRow = buildSystemFeatureRow(system, { includeExperimental: false, max: 5, includeOnline: true });
  const played = make("div", { class: "game-card__played" },
    game.lastPlayedAt
      ? `Played ${formatRelativeTime(game.lastPlayedAt)}`
      : `Added ${formatRelativeTime(game.addedAt)}`
  );
  if (!game.lastPlayedAt && isNew) played.classList.add("game-card__played--fresh");
  const scanline = make("div", { class: "game-card__scanline" });
  scanline.append(
    make("span", { class: "game-card__scan-title" }, game.name),
    make("span", { class: "game-card__scan-meta" }, `${system?.shortName ?? game.systemId.toUpperCase()} / ${formatBytes(game.size)}`),
  );

  info.append(name, meta);
  if (featureRow) info.append(featureRow);
  info.append(played);

  const btnRemove = make("button", {
    class: "game-card__remove",
    title: "Remove from library",
    "aria-label": `Remove ${game.name}`,
  });
  btnRemove.innerHTML = ICON_CLOSE_X_SVG;
  btnRemove.addEventListener("click", async (e) => {
    e.stopPropagation();
    const confirmed = await showConfirmDialog(
      `"${game.name}" will be removed from your library. The file will not be deleted from your device.`,
      { title: "Remove Game", confirmLabel: "Remove", isDanger: true }
    );
    if (!confirmed) return;
    await library.removeGame(game.id);
    clearGameTierProfile(game.id);
    clearGameGraphicsProfile(game.id);
    void shaderCache.clearForGame(game.id);
    showInfoToast(`"${game.name}" removed from library.`, "info");
    onRenderLibrary();
  });

  const btnFav = make("button", {
    class: `game-card__fav${game.isFavorite ? " active" : ""}`,
    title: game.isFavorite ? "Remove from favorites" : "Add to favorites",
    "aria-label": game.isFavorite ? `Remove ${game.name} from favorites` : `Add ${game.name} to favorites`,
    "aria-pressed": String(game.isFavorite),
  }, "\u2605");
  btnFav.addEventListener("click", async (e) => {
    e.stopPropagation();
    const next = !game.isFavorite;
    await library.setFavorite(game.id, next);
    game.isFavorite = next;
    btnFav.classList.toggle("active", next);
    btnFav.title = next ? "Remove from favorites" : "Add to favorites";
    btnFav.setAttribute("aria-label", next ? `Remove ${game.name} from favorites` : `Add ${game.name} to favorites`);
    btnFav.setAttribute("aria-pressed", String(next));
    if (libraryShowFavorites || settings.libraryGrouped) {
      onRenderLibrary();
    }
  });

  let patchInput: HTMLInputElement | null = null;
  let btnPatch: HTMLButtonElement | null = null;
  if (onApplyPatch) {
    patchInput = make("input", {
      type: "file",
      accept: ".ips,.bps,.ups",
      "aria-label": `Apply patch to ${game.name}`,
      style: "display:none",
    }) as HTMLInputElement;

    btnPatch = make("button", {
      class: "game-card__patch",
      title: "Apply IPS/BPS/UPS patch",
      "aria-label": `Apply patch to ${game.name}`,
    }, "\u2295") as HTMLButtonElement;

    btnPatch.addEventListener("click", (e) => { e.stopPropagation(); patchInput!.click(); });
    patchInput.addEventListener("change", async () => {
      const patchFile = patchInput!.files?.[0];
      if (!patchFile) return;
      patchInput!.value = "";
      try {
        showLoadingOverlay();
        setLoadingMessage(`Applying patch to ${game.name}\u2026`);
        await onApplyPatch(game.id, patchFile);
        hideLoadingOverlay();
        showInfoToast(`Patch applied to "${game.name}".`, "success");
        onRenderLibrary();
      } catch (err) {
        hideLoadingOverlay();
        showError(`Patch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  const btnChangeSystem = make("button", {
    class: "game-card__change-sys",
    title: "Change system / emulator",
    "aria-label": `Change system for ${game.name}`,
  }, "\u27F3");

  btnChangeSystem.addEventListener("click", async (e) => {
    e.stopPropagation();
    const newSystem = await pickSystem(
      game.name,
      SYSTEMS,
      `Choose the emulator for "${game.name}". Currently assigned to: ${system?.name ?? game.systemId}`
    );
    if (!newSystem || newSystem.id === game.systemId) return;
    try {
      await library.changeSystemId(game.id, newSystem.id);
      onRenderLibrary();
    } catch (err) {
      showError(`Could not change system: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  const playOverlay = make("div", { class: "game-card__play-overlay", "aria-hidden": "true" });
  const playBtn     = make("div", { class: "game-card__play-btn" }, "\u25B6");
  playOverlay.appendChild(playBtn);

  const btnArt = make("button", {
    class: "game-card__art-btn",
    title: game.hasCoverArt || game.thumbnailUrl ? "Change cover art" : "Set cover art",
    "aria-label": game.hasCoverArt || game.thumbnailUrl
      ? `Change cover art for ${game.name}`
      : `Set cover art for ${game.name}`,
  }, "");

  const handleCoverArtResult = async (result: CoverArtPickResult | null, artBtn: HTMLButtonElement): Promise<void> => {
    if (result === null) return;
    try {
      if (result.type === "remove") {
        const hadOnlyThumbnail = !game.hasCoverArt && !!game.thumbnailUrl;
        await library.setCoverArt(game.id, null);
        if (hadOnlyThumbnail) {
          await library.setThumbnailUrl(game.id, undefined);
          game.thumbnailUrl = undefined;
        }
        icon.classList.remove("game-card__icon--has-art");
        coverArtImg.remove();
        showInfoToast(`Cover art removed for "${game.name}".`, "info");
        game.hasCoverArt = false;
        if (game.thumbnailUrl) {
          applyCoverArt(game.thumbnailUrl);
          artBtn.title = "Change cover art";
          artBtn.setAttribute("aria-label", `Change cover art for ${game.name}`);
        } else {
          artBtn.title = "Set cover art";
          artBtn.setAttribute("aria-label", `Set cover art for ${game.name}`);
        }

      } else if (result.type === "file") {
        await library.setCoverArt(game.id, result.blob);
        if (coverArtObjectUrl) URL.revokeObjectURL(coverArtObjectUrl);
        coverArtObjectUrl = URL.createObjectURL(result.blob);
        if (!icon.contains(coverArtImg)) applyCoverArt(coverArtObjectUrl);
        else coverArtImg.src = coverArtObjectUrl;
        showInfoToast(`Cover art set for "${game.name}".`, "success");
        game.hasCoverArt = true;
        artBtn.title = "Change cover art";
        artBtn.setAttribute("aria-label", `Change cover art for ${game.name}`);

      } else if (result.type === "auto") {
        const provider = getCoverArtProvider();
        let candidates: CoverArtCandidate[] = [];

        artBtn.classList.add("game-card__art-btn--loading");
        artBtn.setAttribute("aria-busy", "true");
        artBtn.disabled = true;

        let hashes: { md5?: string } | undefined;
        const store = getApiKeyStore();
        if (store.getState("screenscraper").enabled) {
          try {
            const blob = await library.getGameBlob(game.id);
            if (blob) {
              const { calculateMD5 } = await import("../../crypto.js");
              const md5 = await calculateMD5(blob);
              hashes = { md5 };
            }
          } catch (err) {
            diagWarn(settings.verboseLogging, "Hash calculation for cover art failed:", err);
          }
        }

        try {
          candidates = await provider.search(game.name, game.systemId, {
            limit: 12,
            hashes,
            fileName: game.fileName,
          });
          candidates.sort((a, b) => b.score - a.score);
        } catch (err) {
          showError(`Cover art search failed: ${err instanceof Error ? err.message : String(err)}`);
          return;
        } finally {
          artBtn.classList.remove("game-card__art-btn--loading");
          artBtn.removeAttribute("aria-busy");
          artBtn.disabled = false;
        }
        const pickedUrl = await showCoverArtCandidatePicker(
          game.name,
          candidates.map((c) => ({
            title: c.title,
            imageUrl: c.imageUrl,
            sourceName: c.sourceName,
            score: c.score,
          })),
        );
        if (!pickedUrl) return;

        let fetchedBlob: Blob;
        try {
          fetchedBlob = await fetchAndValidateCoverArt(pickedUrl);
        } catch (fetchErr) {
          showError(
            `Could not download the selected cover: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}. ` +
            "Try again or upload an image file instead.",
          );
          return;
        }
        await library.setCoverArt(game.id, fetchedBlob);
        if (coverArtObjectUrl) URL.revokeObjectURL(coverArtObjectUrl);
        coverArtObjectUrl = URL.createObjectURL(fetchedBlob);
        if (!icon.contains(coverArtImg)) applyCoverArt(coverArtObjectUrl);
        else coverArtImg.src = coverArtObjectUrl;
        showInfoToast(`Cover art set for "${game.name}".`, "success");
        game.hasCoverArt = true;
        artBtn.title = "Change cover art";
        artBtn.setAttribute("aria-label", `Change cover art for ${game.name}`);

      } else if (result.type === "url") {
        let fetchedBlob: Blob;
        try {
          fetchedBlob = await fetchAndValidateCoverArt(result.url);
        } catch (fetchErr) {
          showError(
            `Could not use that URL as cover art: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}. ` +
            "The host must allow hotlinking (CORS). Try downloading the image and uploading it instead.",
          );
          return;
        }
        await library.setCoverArt(game.id, fetchedBlob);
        if (coverArtObjectUrl) URL.revokeObjectURL(coverArtObjectUrl);
        coverArtObjectUrl = URL.createObjectURL(fetchedBlob);
        if (!icon.contains(coverArtImg)) applyCoverArt(coverArtObjectUrl);
        else coverArtImg.src = coverArtObjectUrl;
        showInfoToast(`Cover art set for "${game.name}".`, "success");
        game.hasCoverArt = true;
        artBtn.title = "Change cover art";
        artBtn.setAttribute("aria-label", `Change cover art for ${game.name}`);
      }
    } catch (err) {
      showError(`Cover art update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  btnArt.addEventListener("click", async (e) => {
    e.stopPropagation();
    const result = await showCoverArtPickerDialogImpl(
      game.name,
      !!(game.hasCoverArt || game.thumbnailUrl),
      { onOpenApiKeysSettings: onOpenApiKeySettings ?? (() => {}) },
    );
    await handleCoverArtResult(result, btnArt);
  });

  card.append(icon, scanline, info);
  if (patchInput && btnPatch) card.append(patchInput, btnPatch);
  card.append(btnArt, btnChangeSystem, btnFav, btnRemove, playOverlay);

  let preloadTriggered = false;
  const triggerPreload = () => {
    if (preloadTriggered) return;
    preloadTriggered = true;
    library.preloadGame(game.id);
    if (emulatorRef) emulatorRef.prefetchCore(game.systemId);
  };
  card.addEventListener("mouseenter", triggerPreload);
  card.addEventListener("focusin",    triggerPreload);

  const launch = async () => {
    showLoadingOverlay();
    setLoadingMessage(`Starting ${game.name}\u2026`);
    setLoadingSubtitle("Getting ready to play");
    try {
      let blob = await library.getGameBlob(game.id);
      if (!blob && game.cloudId) {
        setLoadingMessage("Streaming from cloud\u2026");
        setLoadingSubtitle(`Downloading ${game.name} from ${game.cloudId} (Pull & Play)`);
        blob = await onFetchFromCloud(game, settings);
      }
      if (!blob) {
        hideLoadingOverlay();
        showError(`"${game.name}" could not be found in your library. Try adding it again.`);
        return;
      }
      const file = toLaunchFile(blob, game.fileName);
      await library.markPlayed(game.id);
      await onLaunchGame(file, game.systemId, game.id);
    } catch (err) {
      hideLoadingOverlay();
      showError(`Failed to start game: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const updateSidebar = () => {
    const empty = document.querySelector(".landing-details__empty");
    const content = document.getElementById("landing-details-content");
    if (!empty || !content) return;
    empty.setAttribute("hidden", "true");
    content.removeAttribute("hidden");
    
    const coverSrc = coverArtObjectUrl || game.thumbnailUrl || "";
    
    content.innerHTML = "";
    
    if (coverSrc) {
      const img = document.createElement("img");
      img.src = coverSrc;
      img.className = "landing-details__cover";
      img.alt = "";
      content.appendChild(img);
    }
    
    const title = document.createElement("div");
    title.className = "landing-details__title";
    title.textContent = game.name;
    content.appendChild(title);
    
    const meta = document.createElement("div");
    meta.className = "landing-details__meta";
    meta.innerHTML = `
      <strong>Platform:</strong> ${system?.name ?? game.systemId}<br>
      <strong>Added:</strong> ${formatRelativeTime(game.addedAt)}<br>
      <strong>Last Played:</strong> ${game.lastPlayedAt ? formatRelativeTime(game.lastPlayedAt) : 'Never'}
    `;
    content.appendChild(meta);
    
    const actions = document.createElement("div");
    actions.className = "landing-details__actions";
    
    const btnPlay = document.createElement("button");
    btnPlay.className = "btn btn--primary";
    btnPlay.textContent = "Play";
    btnPlay.onclick = launch;
    
    actions.appendChild(btnPlay);
    content.appendChild(actions);
  };

  card.addEventListener("mouseenter", updateSidebar);
  card.addEventListener("focusin", updateSidebar);



  card.addEventListener("click", () => {
    void showGameDetails(game, {
      system: system ?? null,
      formatBytes,
      coverArtSrc: coverArtObjectUrl || game.thumbnailUrl || undefined,
      onLaunch:    () => { void launch(); },
      onRemove:    () => btnRemove.click(),
      onToggleFav: () => btnFav.click(),
      onEditArt:   () => {
        void showCoverArtPickerDialogImpl(
          game.name,
          !!coverArtObjectUrl,
          { onOpenApiKeysSettings: onOpenApiKeySettings ?? (() => {}) },
        ).then(res => handleCoverArtResult(res, btnArt)).catch(err => {
          console.warn("Cover art dialog failed:", err);
        });
      },
      getRAProgress: system?.hasAchievements ? async () => {
        const cached = getCachedRAProgress(game.id);
        if (cached) return cached;

        const store = getApiKeyStore();
        const state = store.getState("retroachievements");
        if (!state.enabled || !state.key) return null;

        const { getRAClient } = await import("../../achievements.js");
        const { calculateMD5 } = await import("../../crypto.js");

        const creds = parseRAKey(state.key);
        if (!creds) return null;
        const client = getRAClient(creds.username, creds.apiKey);

        const blob = await library.getGameBlob(game.id);
        if (!blob) return null;
        const hash = await calculateMD5(blob);

        const raGameId = await client!.getGameIdByHash(hash);
        if (!raGameId) return null;

        const data = await client!.getGameInfoAndUserProgress(raGameId);
        if (data) setCachedRAProgress(game.id, data);
        return data;
      } : undefined,
      getSGDBAssets: async () => {
        const store = getApiKeyStore();
        const state = store.getState("steamgriddb");
        if (!state.enabled || !state.key) return null;

        const { SGDBClient } = await import("../../steamgriddb.js");
        const client = new SGDBClient(state.key);

        try {
          const games = await client.searchGame(game.name);
          if (games.length === 0) return null;
          const sgdbId = games[0]!.id;

          const [heroes, logos] = await Promise.all([
            client.getHero(sgdbId),
            client.getLogo(sgdbId)
          ]);

          return {
            heroUrl: heroes[0]?.url,
            logoUrl: logos[0]?.url
          };
        } catch (err) {
          console.error("SteamGridDB fetch failed:", err);
          return null;
        }
      },
      getIGDBMetadata: async () => {
        const store = getApiKeyStore();
        const state = store.getState("igdb");

        if (state.enabled && state.key) {
          const { IGDBClient } = await import("../../igdb.js");
          const client = new IGDBClient(state.key);

          try {
            const games = await client.searchGame(game.name);
            if (games[0]) return games[0];
          } catch (err) {
            console.error("IGDB fetch failed:", err);
          }
        }

        const { WikipediaMetadataClient } = await import("../../freeMetadata.js");
        return new WikipediaMetadataClient().searchGame(game.name);
      }
    });
  });

  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      card.click();
    }
  });

  return card;
}
