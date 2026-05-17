/**
 * gameImport.ts — Game import pipeline: file resolution, archive extraction,
 * system detection, multi-disc handling, patch application, and library insertion.
 *
 * Extracted from src/ui.ts as part of the modularisation effort.
 */

import type { ArchiveFormat } from "../../archive.js";
import { ArchiveSelectionStore } from "../../archiveStore.js";
import { LEGACY_EVENTS } from "../../legacy.js";
import type { PSPEmulator } from "../../emulator.js";
import {
  GameLibrary,
  formatBytes,
  type GameMetadata,
} from "../../library.js";
import {
  SYSTEMS,
  ALL_EXTENSIONS,
  detectSystem,
  type SystemInfo,
} from "../../systems.js";
import type { Settings } from "../../types/settings.js";
import {
  fileExt,
  PATCH_EXT_SET,
  IMPORT_ARCHIVE_EXT_SET,
  IMPORT_ARCHIVE_FORMAT_BY_EXT,
  EXTRACTABLE_ARCHIVE_FORMATS,
  UNSUPPORTED_ARCHIVE_EXT_SET,
  MIN_NATIVE_PACKAGE_BIN_ENTRY_COUNT,
  NATIVE_PACKAGE_BIN_EXT,
  hasKnownRomHintInArchiveName,
  inferFileForSystem,
  formatArchiveProgressMessage,
  logImport,
  logImportWarn,
  isTransientImportError,
  withRetry,
  toLaunchFile,
} from "../gameImportHelpers.js";
import {
  hideLoadingOverlay,
  setLoadingMessage,
  setLoadingProgress,
  setLoadingSubtitle,
  showLoadingOverlay,
} from "../loadingOverlay.js";
import {
  pickSystem as pickSystemImpl,
  showArchiveEntryPickerDialog as showArchiveEntryPickerDialogImpl,
  showConfirmDialog as showConfirmDialogImpl,
  showGamePickerDialog as showGamePickerDialogImpl,
  showMultiDiscPicker as showMultiDiscPickerImpl,
} from "../modals.js";
import { showError } from "../toasts.js";

const FILE_SIZE_DECIMALS = 1;
const DOS_NATIVE_PACKAGE_EXTS = new Set(["exe", "com", "bat", "conf"]);

function parseM3U(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"))
    .map(line => line.split(/[/\\]/).pop() ?? line);
}

export async function resolveSystemAndAddImpl(
  file:          File,
  library:       GameLibrary,
  settings:      Settings,
  onLaunchGame:  (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef:   PSPEmulator | undefined,
  onApplyPatch:  ((gameId: string, patchFile: File) => Promise<void>) | undefined,
  onRenderLibrary: () => void,
  onFetchFromCloud: (game: GameMetadata, settings: Settings) => Promise<Blob>,
): Promise<void> {
  const ext = fileExt(file.name);
  if (PATCH_EXT_SET.has(ext)) {
    await handlePatchFileDrop(file, library, settings, onLaunchGame, emulatorRef, onApplyPatch, onRenderLibrary);
    return;
  }

  let resolvedFile = file;
  let archiveFormat: ArchiveFormat = "unknown";
  let archiveModulePromise: Promise<typeof import("../../archive.js")> | null = null;
  const getArchiveModule = (): Promise<typeof import("../../archive.js")> => {
    if (!archiveModulePromise) archiveModulePromise = import("../../archive.js");
    return archiveModulePromise;
  };

  logImport(
    emulatorRef,
    settings,
    `Received file "${file.name}" (${(file.size / 1024 / 1024).toFixed(FILE_SIZE_DECIMALS)} MB)`,
  );

  const shouldSniffArchive = IMPORT_ARCHIVE_EXT_SET.has(ext) || ext === "";
  if (shouldSniffArchive) {
    const archiveModule = await getArchiveModule();
    archiveFormat = await archiveModule.detectArchiveFormat(file);
    if (archiveFormat === "unknown") {
      archiveFormat = IMPORT_ARCHIVE_FORMAT_BY_EXT[ext] ?? "unknown";
    }
    if (archiveFormat !== "unknown") {
      logImport(
        emulatorRef,
        settings,
        `Archive format detected: ${archiveFormat.toUpperCase()} (from "${file.name}")`,
      );
    }
  }

  if (archiveFormat === "bzip2" || archiveFormat === "xz") {
    showError(
      `${archiveFormat.toUpperCase()} archives are not supported for automatic extraction.\n\n` +
      "Please extract the archive first and then import the ROM file directly."
    );
    logImportWarn(
      emulatorRef,
      settings,
      `${archiveFormat.toUpperCase()} archive requires manual extraction`,
    );
    return;
  }

  if (archiveFormat === "unknown" && UNSUPPORTED_ARCHIVE_EXT_SET.has(ext)) {
    const extLabel = ext.toUpperCase();
    showError(
      `${extLabel} archives cannot be extracted automatically in the browser.\n\n` +
      "Please extract the archive manually and import the ROM file directly."
    );
    logImportWarn(
      emulatorRef,
      settings,
      `${extLabel} archive is not supported for automatic extraction`,
    );
    return;
  }

  if (EXTRACTABLE_ARCHIVE_FORMATS.has(archiveFormat)) {
    const archiveModule = await getArchiveModule();
    showLoadingOverlay();
    setLoadingMessage(`Opening ${archiveFormat.toUpperCase()} archive…`);
    setLoadingSubtitle("Extracting game files — this may take a moment");
    logImport(
      emulatorRef,
      settings,
      `Starting ${archiveFormat.toUpperCase()} extraction`,
    );

    try {
      const extracted = await archiveModule.extractFromArchive(file, {
        onProgress: (progress) => {
          setLoadingMessage(formatArchiveProgressMessage(progress));
          if (progress.percent != null) setLoadingProgress(progress.percent);
        },
      });

      if (extracted) {
        const extractedCandidates = extracted.candidates ?? [];
        const shouldPreferNativePackageRouting =
          (archiveFormat === "zip" || archiveFormat === "7z") &&
          !hasKnownRomHintInArchiveName(file.name) &&
          extractedCandidates.length >= MIN_NATIVE_PACKAGE_BIN_ENTRY_COUNT &&
          extractedCandidates.every((candidate) => fileExt(candidate.name) === NATIVE_PACKAGE_BIN_EXT);
        const shouldPreferDosPackageRouting =
          archiveFormat === "zip" &&
          extractedCandidates.some((candidate) => DOS_NATIVE_PACKAGE_EXTS.has(fileExt(candidate.name)));

        if (shouldPreferNativePackageRouting || shouldPreferDosPackageRouting) {
          resolvedFile = file;
          setLoadingMessage("Detected native package archive — using original file…");
          setLoadingSubtitle("");
          logImport(
            emulatorRef,
            settings,
            shouldPreferDosPackageRouting
              ? `${archiveFormat.toUpperCase()} appears to be a DOS package; skipping inner extraction routing`
              : `${archiveFormat.toUpperCase()} appears to be a native package set (${extractedCandidates.length} BIN entries); skipping inner extraction routing`,
          );
        } else if (extractedCandidates.length > 1) {
          const savedPick = ArchiveSelectionStore.get(file.name, file.size);
          const pickedCandidate = savedPick 
            ? extractedCandidates.find(c => c.name === savedPick)
            : null;

          let picked = pickedCandidate;
          if (!picked) {
            hideLoadingOverlay();
            picked = await showArchiveEntryPickerDialogImpl(
              extracted.format,
              extractedCandidates,
            );
            if (picked) {
               ArchiveSelectionStore.set(file.name, file.size, picked.name);
            }
          }

          if (!picked) return;
          resolvedFile = new File([picked.blob!], picked.name, { type: picked.blob!.type });
          showLoadingOverlay();
          setLoadingMessage("File selected — detecting game system…");
          setLoadingSubtitle("");
          logImport(
            emulatorRef,
            settings,
            `Archive entry selected: "${picked.name}" (${formatBytes(picked.size)})`,
          );
        } else {
          resolvedFile = new File([extracted.blob!], extracted.name, { type: extracted.blob!.type });
        }
        setLoadingMessage("Detecting game system…");
        setLoadingSubtitle("");
        logImport(
          emulatorRef,
          settings,
          `${extracted.format.toUpperCase()} extraction succeeded: "${resolvedFile.name}" ` +
          `(${(resolvedFile.size / 1024 / 1024).toFixed(FILE_SIZE_DECIMALS)} MB)`,
        );
      } else {
        hideLoadingOverlay();
        const strictFormats = new Set<ArchiveFormat>(["tar", "gzip"]);
        if (strictFormats.has(archiveFormat)) {
          const pretty = archiveFormat === "gzip" ? "GZIP" : archiveFormat.toUpperCase();
          showError(
            `${pretty} archive does not contain a recognised ROM file.\n\n` +
            "Try extracting the archive manually and import the ROM file directly."
          );
          logImportWarn(
            emulatorRef,
            settings,
            `${pretty} extraction produced no ROM candidate`,
          );
          return;
        }
        logImport(
          emulatorRef,
          settings,
          `${archiveFormat.toUpperCase()} extraction found no ROM candidate; falling back to native package routing`,
        );
      }
    } catch (err) {
      hideLoadingOverlay();
      const reason = err instanceof Error ? err.message : String(err);
      const fallbackAllowed = archiveFormat === "zip" || archiveFormat === "7z";
      if (!fallbackAllowed) {
        showError(
          `Could not extract ${archiveFormat.toUpperCase()} archive:\n${reason}\n\n` +
          "Please extract the archive manually and import the ROM file directly."
        );
        logImportWarn(
          emulatorRef,
          settings,
          `${archiveFormat.toUpperCase()} extraction failed: ${reason}`,
        );
        return;
      }
      logImportWarn(
        emulatorRef,
        settings,
        `${archiveFormat.toUpperCase()} extraction failed (${reason}); falling back to native package routing`,
      );
    }
  } else if (IMPORT_ARCHIVE_EXT_SET.has(ext) && archiveFormat === "unknown") {
    logImportWarn(
      emulatorRef,
      settings,
      `Archive extension ".${ext}" had no recognised signature; attempting native package routing`,
    );
  }

  const detected = detectSystem(resolvedFile.name);
  let system: SystemInfo | null = null;

  if (detected === null) {
    const resolvedExt = fileExt(resolvedFile.name);
    const shouldOfferSystemPicker =
      resolvedExt === "" || (!ALL_EXTENSIONS.includes(resolvedExt) && !IMPORT_ARCHIVE_EXT_SET.has(resolvedExt));

    if (shouldOfferSystemPicker) {
      hideLoadingOverlay();
      logImport(
        emulatorRef,
        settings,
        `System detection failed for "${resolvedFile.name}". Prompting manual system selection.`,
      );
      const picked = await pickSystemImpl(
        resolvedFile.name,
        SYSTEMS,
        `We couldn't detect the console from this file. Choose the system you'd like to use:`
      );
      if (!picked) return;
      system = picked;
      resolvedFile = inferFileForSystem(resolvedFile, picked);
      logImport(
        emulatorRef,
        settings,
        `Manual system selected: ${picked.id}. Inferred filename "${resolvedFile.name}"`,
      );
    } else {
      hideLoadingOverlay();
      showError(
        `"${resolvedFile.name}" isn't a recognised ROM format.\n\n` +
        `Try a common format like .iso, .gba, .sfc, .nes, or .nds.\n` +
        `See Settings → Help for the full list of supported formats.`
      );
      return;
    }
  } else if (Array.isArray(detected)) {
    hideLoadingOverlay();
    system = await pickSystemImpl(resolvedFile.name, detected);
    if (!system) return;
  } else {
    system = detected;
  }

  logImport(
    emulatorRef,
    settings,
    `System resolved: ${system.id} (${system.name}) for "${resolvedFile.name}"`,
  );

  if (resolvedFile.name.toLowerCase().endsWith(".m3u")) {
    await handleM3UFile(resolvedFile, system, library, settings, onLaunchGame, emulatorRef, onApplyPatch, onRenderLibrary, onFetchFromCloud);
    return;
  }

  try {
    const existing = await library.findByFileName(resolvedFile.name, system.id);
    if (existing) {
      hideLoadingOverlay();
      const playExisting = await showConfirmDialogImpl(
        `"${existing.name}" is already in your library.`,
        { title: "Already in Library", confirmLabel: "Play Existing" }
      );
      if (!playExisting) return;
      showLoadingOverlay();
      setLoadingMessage(`Starting ${existing.name}…`);
      setLoadingSubtitle("Getting ready to play");
      try {
        let blob = existing.blob;
        if (!blob && existing.cloudId) {
          setLoadingSubtitle(`Downloading from ${existing.cloudId}…`);
          blob = await onFetchFromCloud(existing, settings);
        }
        if (!blob) {
          hideLoadingOverlay();
          showError(`"${existing.name}" could not be loaded. It may be missing from your library or cloud connection.`);
          return;
        }
        const existingFile = toLaunchFile(blob, existing.fileName);
        await library.markPlayed(existing.id);
        logImport(
          emulatorRef,
          settings,
          `Launching existing library entry: "${existing.name}" (${existing.id})`,
        );
        await onLaunchGame(existingFile, existing.systemId, existing.id);
      } catch (err) {
        hideLoadingOverlay();
        showError(`Could not load game: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
  } catch { /* fall through */ }

  showLoadingOverlay();
  setLoadingMessage("Saving game to library…");
  setLoadingSubtitle("This only takes a moment the first time");

  try {
    const entry = await withRetry(
      () => library.addGame(resolvedFile, system.id),
      {
        isRetryable: isTransientImportError,
        onRetry: (attempt, _err) => {
          setLoadingMessage(`Saving game to library… (retry ${attempt})`);
          logImportWarn(
            emulatorRef,
            settings,
            `library.addGame failed on attempt ${attempt}; retrying…`,
          );
        },
      },
    );
    settings.lastGameName = entry.name;
    logImport(
      emulatorRef,
      settings,
      `Game added to library: "${entry.name}" (id: ${entry.id}, system: ${entry.systemId})`,
    );
    onRenderLibrary();
    setLoadingMessage(`Starting ${entry.name}…`);
    setLoadingSubtitle("Getting ready to play");
    logImport(
      emulatorRef,
      settings,
      `Launching newly added game "${entry.name}"`,
    );
    await onLaunchGame(resolvedFile, system.id, entry.id);
  } catch (err) {
    hideLoadingOverlay();
    const errMsg = `Could not add game: ${err instanceof Error ? err.message : String(err)}`;
    logImportWarn(emulatorRef, settings, errMsg);
    showError(errMsg, () => {
      void resolveSystemAndAddImpl(file, library, settings, onLaunchGame, emulatorRef, onApplyPatch, onRenderLibrary, onFetchFromCloud);
    });
  }
}

async function handlePatchFileDrop(
  patchFile:     File,
  library:       GameLibrary,
  _settings:     Settings,
  _onLaunchGame: (file: File, systemId: string, gameId?: string) => Promise<void>,
  _emulatorRef:  PSPEmulator | undefined,
  onApplyPatch:  ((gameId: string, patchFile: File) => Promise<void>) | undefined,
  onRenderLibrary: () => void,
): Promise<void> {
  if (!onApplyPatch) { showError("Patch application is not available."); return; }

  let games: GameMetadata[];
  try { games = await library.getAllGamesMetadata(); } catch { games = []; }

  if (games.length === 0) { showError("Your library is empty. Add a game before applying a patch."); return; }

  const chosen = await showGamePickerDialogImpl(
    "Apply Patch to Game",
    `Select the game to patch with "${patchFile.name}":`,
    games
  );
  if (!chosen) return;

  try {
    showLoadingOverlay();
    setLoadingMessage(`Applying patch to ${chosen.name}…`);
    await onApplyPatch(chosen.id, patchFile);
    hideLoadingOverlay();
    onRenderLibrary();
  } catch (err) {
    hideLoadingOverlay();
    showError(`Patch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleM3UFile(
  m3uFile:       File,
  system:        SystemInfo,
  library:       GameLibrary,
  settings:      Settings,
  onLaunchGame:  (file: File, systemId: string, gameId?: string) => Promise<void>,
  emulatorRef:   PSPEmulator | undefined,
  _onApplyPatch: ((gameId: string, patchFile: File) => Promise<void>) | undefined,
  onRenderLibrary: () => void,
  _onFetchFromCloud: (game: GameMetadata, settings: Settings) => Promise<Blob>,
): Promise<void> {
  let m3uText: string;
  try { m3uText = await m3uFile.text(); } catch { showError("Could not read the .m3u file."); return; }

  const discFileNames = parseM3U(m3uText);
  if (discFileNames.length === 0) { showError("The .m3u file is empty or contains no disc entries."); return; }

  const storedDiscs = new Map<string, { id: string; blob: Blob }>();
  await Promise.all(
    discFileNames.map(async (fn) => {
      try {
        const entry = await library.findByFileName(fn, system.id);
        if (entry && entry.blob) storedDiscs.set(fn, { id: entry.id, blob: entry.blob });
      } catch { /* ignore */ }
    })
  );

  let discFiles: Map<string, Blob>;
  const missingDiscs = discFileNames.filter(fn => !storedDiscs.has(fn));

  if (missingDiscs.length > 0) {
    const userPicked = await showMultiDiscPickerImpl(missingDiscs);
    if (!userPicked) return;
    showLoadingOverlay();
    setLoadingMessage("Storing disc images…");
    for (const [fn, f] of userPicked) {
      try {
        const entry = await library.addGame(f, system.id);
        storedDiscs.set(fn, { id: entry.id, blob: f });
      } catch { /* ignore */ }
    }
    discFiles = userPicked;
  } else {
    discFiles = new Map();
    for (const [fn, { blob }] of storedDiscs) { discFiles.set(fn, blob); }
    showLoadingOverlay();
    setLoadingMessage("Preparing multi-disc game…");
  }

  const blobUrls: string[] = [];
  const syntheticLines: string[] = [];
  for (const fn of discFileNames) {
    const discBlob = discFiles.get(fn) ?? storedDiscs.get(fn)?.blob ?? null;
    if (!discBlob) { hideLoadingOverlay(); showError(`Disc file not found: "${fn}"`); return; }
    const url = URL.createObjectURL(discBlob);
    blobUrls.push(url);
    syntheticLines.push(url);
  }

  const syntheticM3U  = new Blob([syntheticLines.join("\n")], { type: "text/plain" });
  const syntheticFile = new File([syntheticM3U], m3uFile.name, { type: "text/plain" });
  const gameName = m3uFile.name.replace(/\.[^.]+$/, "");
  settings.lastGameName = gameName;

  try {
    const existing = await library.findByFileName(m3uFile.name, system.id);
    if (!existing) {
      await library.addGame(m3uFile, system.id);
      onRenderLibrary();
    }
  } catch { /* ignore */ }

  try {
    await onLaunchGame(syntheticFile, system.id);
    if (emulatorRef?.state === "error") {
      blobUrls.forEach(u => URL.revokeObjectURL(u));
      return;
    }
    const revokeOnReturn = () => { blobUrls.forEach(u => URL.revokeObjectURL(u)); };
    document.addEventListener(LEGACY_EVENTS.returnToLibrary, revokeOnReturn, { once: true });
  } catch (err) {
    hideLoadingOverlay();
    showError(`Multi-disc launch failed: ${err instanceof Error ? err.message : String(err)}`);
    blobUrls.forEach(u => URL.revokeObjectURL(u));
  }
}
