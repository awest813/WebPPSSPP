import { formatRelativeTime, type GameLibrary, type GameMetadata } from "../library.js";
import { getSystemById } from "../systems.js";
import type { Settings } from "../types/settings.js";
import type { PSPEmulator } from "../emulator.js";
import { isSvgMarkup } from "../chromeIcons.js";
import { createElement as make } from "./dom.js";

export function buildLibraryHero(opts: {
  game: GameMetadata;
  library: GameLibrary;
  settings: Settings;
  onLaunchGame(file: File, systemId: string, gameId?: string): Promise<void>;
  systemIcon(systemId: string): string;
  escapeHtml(value: string): string;
  fetchFromCloud(game: GameMetadata, settings: Settings, libraryForCache?: GameLibrary): Promise<Blob | null>;
  toLaunchFile(blob: Blob, fileName: string): File;
  showLoadingOverlay(): void;
  setLoadingMessage(message: string): void;
  setLoadingSubtitle(message: string): void;
  hideLoadingOverlay(): void;
  showError(message: string): void;
}): HTMLElement {
  const {
    game,
    library,
    settings,
    onLaunchGame,
    systemIcon,
    escapeHtml,
    fetchFromCloud,
    toLaunchFile,
    showLoadingOverlay,
    setLoadingMessage,
    setLoadingSubtitle,
    hideLoadingOverlay,
    showError,
  } = opts;

  const hero = make("div", { class: "library-hero" });
  const system = getSystemById(game.systemId);

  const bg = make("div", { class: "library-hero__bg" });
  bg.style.background = `linear-gradient(90deg, #121212 0%, rgba(18,18,18,0.7) 40%, transparent 100%), radial-gradient(circle at 20% 30%, ${system?.color ?? "#8b5cf6"}22 0%, transparent 70%)`;
  
  if (game.hasCoverArt) {
    void library.getCoverArt(game.id).then(blob => {
      if (blob) {
        const url = URL.createObjectURL(blob);
        bg.style.backgroundImage = `linear-gradient(90deg, #121212 0%, rgba(18,18,18,0.7) 40%, transparent 100%), url(${url})`;
      }
    });
  }

  const content = make("div", { class: "library-hero__content" });
  const tag = make("div", { class: "library-hero__tag" }, "Recently Played");
  const title = make("h2", { class: "library-hero__title" }, game.name);

  const meta = make("div", { class: "library-hero__meta" });
  const sysName = system?.shortName ?? game.systemId.toUpperCase();
  const iconOutput = systemIcon(game.systemId);
  const iconHtml = iconOutput.includes("/assets/")
    ? `<img src="${iconOutput}" alt="" class="hero-sys-icon" />`
    : isSvgMarkup(iconOutput)
      ? iconOutput
      : escapeHtml(iconOutput);
  meta.innerHTML = `<span>${iconHtml} ${escapeHtml(sysName)}</span> • <span>${game.lastPlayedAt ? `Played ${formatRelativeTime(game.lastPlayedAt)}` : "Never played"}</span>`;

  const actions = make("div", { class: "library-hero__actions" });
  const playBtn = make("button", { class: "btn--hero" });
  playBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> START`;
  playBtn.addEventListener("click", async () => {
    showLoadingOverlay();
    setLoadingMessage(`Starting ${game.name}…`);
    setLoadingSubtitle("Getting ready to play");
    try {
      let blob = await library.getGameBlob(game.id);
      if (!blob && game.cloudId) {
        setLoadingMessage("Streaming from cloud…");
        setLoadingSubtitle(`Downloading ${game.name} from ${game.cloudId} (Pull & Play)`);
        blob = await fetchFromCloud(game, settings, library);
      }
      if (!blob) {
        hideLoadingOverlay();
        showError(`"${game.name}" could not be found in your library. Try adding it again.`);
        return;
      }
      await library.markPlayed(game.id);
      await onLaunchGame(toLaunchFile(blob, game.fileName), game.systemId, game.id);
    } catch (err) {
      hideLoadingOverlay();
      showError(`Failed to start game: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  actions.appendChild(playBtn);
  content.append(tag, title, meta, actions);
  hero.append(bg, content);

  return hero;
}

export function buildLibraryRow(opts: {
  title: string;
  systemId: string | null;
  games: GameMetadata[];
  library: GameLibrary;
  settings: Settings;
  onLaunchGame(file: File, systemId: string, gameId?: string): Promise<void>;
  emulatorRef?: PSPEmulator;
  onApplyPatch?: (gameId: string, patchFile: File) => Promise<void>;
  isScroll?: boolean;
  systemIcon(systemId: string): string;
  buildGameCard(
    game: GameMetadata,
    library: GameLibrary,
    settings: Settings,
    onLaunchGame: (file: File, systemId: string, gameId?: string) => Promise<void>,
    emulatorRef?: PSPEmulator,
    onApplyPatch?: (gameId: string, patchFile: File) => Promise<void>,
  ): HTMLElement;
}): HTMLElement {
  const {
    title,
    systemId,
    games,
    library,
    settings,
    onLaunchGame,
    emulatorRef,
    onApplyPatch,
    isScroll = true,
    systemIcon,
    buildGameCard,
  } = opts;

  const row = make("div", { class: "library-row" });
  const header = make("div", { class: "library-row__header" });

  if (systemId) {
    const iconOutput = systemIcon(systemId);
    const icon = make("span", { class: "library-row__icon-span" });
    if (iconOutput.includes("/assets/")) {
      icon.innerHTML = `<img src="${iconOutput}" alt="" class="row-sys-icon" />`;
    } else if (isSvgMarkup(iconOutput)) {
      icon.innerHTML = iconOutput;
    } else {
      icon.textContent = iconOutput;
    }
    const sys = getSystemById(systemId);
    if (sys) icon.style.color = sys.color;
    header.appendChild(icon);
  }

  header.appendChild(make("h3", { class: "library-row__title" }, title));

  const container = make("div", { class: isScroll ? "library-row__scroll" : "library-row__grid" });
  for (const game of games) {
    container.appendChild(buildGameCard(game, library, settings, onLaunchGame, emulatorRef, onApplyPatch));
  }

  row.append(header, container);
  return row;
}
