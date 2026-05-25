import { createElement as make, buildToggleRow } from "../dom.js";
import type { Settings } from "../../types/settings.js";
import type { DeviceCapabilities } from "../../performance.js";
import { clearCapabilitiesCache } from "../../performance.js";
import type { PSPEmulator } from "../../emulator.js";
import { BiosLibrary, BIOS_REQUIREMENTS } from "../../bios.js";
import type { NetplayManager } from "../../multiplayer.js";
import { peekNetplayManager } from "../../netplaySingleton.js";
import { showInfoToast, showError } from "../toasts.js";

const APP_NAME = "RetroOasis";

export function buildDebugTab(
  container: HTMLElement,
  settings: Settings,
  onSettingsChange: (patch: Partial<Settings>) => void,
  deviceCaps: DeviceCapabilities,
  emulatorRef?: PSPEmulator,
  getNetplayManager?: () => Promise<NetplayManager>,
  biosLibrary?: BiosLibrary
): void {
  // Settings section
  const debugAdvancedHeadingId = "settings-debug-advanced-heading";
  const settingsSection = make("div", {
    class: "settings-section",
    role: "region",
    "aria-labelledby": debugAdvancedHeadingId,
  });
  settingsSection.appendChild(make("h4", {
    class: "settings-section__title",
    id: debugAdvancedHeadingId,
  }, "Advanced Settings"));
  settingsSection.appendChild(make("p", { class: "settings-help" },
    "These settings are for troubleshooting. You don't normally need to change them."
  ));

  settingsSection.appendChild(buildToggleRow(
    "Detailed logging",
    "Write extra diagnostic information to the browser console \u2014 helpful when reporting issues",
    settings.verboseLogging,
    (v) => onSettingsChange({ verboseLogging: v })
  ));

  // Environment section
  const debugEnvHeadingId = "settings-debug-environment-heading";
  const envSection = make("div", {
    class: "settings-section",
    role: "region",
    "aria-labelledby": debugEnvHeadingId,
  });
  envSection.appendChild(make("h4", {
    class: "settings-section__title",
    id: debugEnvHeadingId,
  }, "Environment"));

  const isIsolated = "crossOriginIsolated" in self ? self.crossOriginIsolated : false;
  const hasSAB     = typeof SharedArrayBuffer !== "undefined";
  const hasWasm    = typeof WebAssembly !== "undefined";

  envSection.appendChild(make("p", { class: "device-info" },
    `Cross-Origin Isolated: ${isIsolated ? "Yes (PSP supported)" : "No \u2014 PSP games will fail (reload after coi-serviceworker.js)"}`
  ));
  envSection.appendChild(make("p", { class: "device-info" },
    `SharedArrayBuffer: ${hasSAB ? "Available" : "Not available"}`
  ));
  envSection.appendChild(make("p", { class: "device-info" },
    `WebAssembly: ${hasWasm ? "Available" : "Not available"}`
  ));

  if (getNetplayManager) {
    const netplayStatus = make("p", { class: "device-info" }, "Checking Play Together status\u2026");
    envSection.appendChild(netplayStatus);
    getNetplayManager().then(nm => {
      // NetplayManager doesn't have isConnected/isEnabled, it has enabled and isActive
      netplayStatus.textContent = nm.isActive
        ? "Play Together: Active and configured"
        : nm.enabled
        ? "Play Together: Enabled but server missing"
        : "Play Together: Disabled";
    }).catch(() => {
      netplayStatus.textContent = "Play Together: Error loading manager";
    });
  }
  envSection.appendChild(make("p", { class: "device-info" },
    `User Agent: ${navigator.userAgent}`
  ));

  // GPU & VRAM section
  const debugGpuHeadingId = "settings-debug-gpu-heading";
  const gpuSection = make("div", {
    class: "settings-section",
    role: "region",
    "aria-labelledby": debugGpuHeadingId,
  });
  gpuSection.appendChild(make("h4", {
    class: "settings-section__title",
    id: debugGpuHeadingId,
  }, "GPU & Memory"));
  gpuSection.appendChild(make("p", { class: "device-info" },
    `GPU: ${deviceCaps.gpuCaps.renderer}`
  ));
  gpuSection.appendChild(make("p", { class: "device-info" },
    `Estimated VRAM: ${deviceCaps.estimatedVRAMMB} MB`
  ));
  gpuSection.appendChild(make("p", { class: "device-info" },
    `Max Texture Size: ${deviceCaps.gpuCaps.maxTextureSize}px`
  ));
  gpuSection.appendChild(make("p", { class: "device-info" },
    `Compressed Textures: ${deviceCaps.gpuCaps.compressedTextures ? "Yes" : "No"} ` +
    `(ETC2: ${deviceCaps.gpuCaps.etc2Textures ? "Yes" : "No"}, ASTC: ${deviceCaps.gpuCaps.astcTextures ? "Yes" : "No"})`
  ));
  gpuSection.appendChild(make("p", { class: "device-info" },
    `MRT Attachments: ${deviceCaps.gpuCaps.maxColorAttachments} | Multi-Draw: ${deviceCaps.gpuCaps.multiDraw ? "Yes" : "No"}`
  ));

  // PS1 status section \u2014 shows BIOS file availability and core info
  const debugPs1HeadingId = "settings-debug-ps1-heading";
  const ps1Section = make("div", {
    class: "settings-section",
    role: "region",
    "aria-labelledby": debugPs1HeadingId,
  });
  ps1Section.appendChild(make("h4", {
    class: "settings-section__title",
    id: debugPs1HeadingId,
  }, "PS1 Status"));
  ps1Section.appendChild(make("p", { class: "settings-help" },
    "PlayStation 1 uses the PCSX ReARMed core (pcsx_rearmed). A BIOS file is " +
    "optional but improves game compatibility. Upload BIOS files in the BIOS tab."
  ));

  const psxBiosReqs = BIOS_REQUIREMENTS["psx"] ?? [];
  // Snapshot map populated by async checks \u2014 used by the "Copy Debug Info" button
  const psxBiosSnapshot = new Map<string, boolean | null>();
  for (const req of psxBiosReqs) psxBiosSnapshot.set(req.fileName, null);

  for (const req of psxBiosReqs) {
    const row = make("p", { class: "device-info" });
    row.textContent = `${req.displayName}: checking\u2026`;
    ps1Section.appendChild(row);

    if (biosLibrary) {
      biosLibrary.findBios("psx", req.fileName).then(found => {
        psxBiosSnapshot.set(req.fileName, found !== null);
        row.textContent = `${req.displayName}: ${found ? "Uploaded" : "Not found"}`;
      }).catch(() => {
        psxBiosSnapshot.set(req.fileName, null);
        row.textContent = `${req.displayName}: \u2014 (could not check)`;
      });
    } else {
      psxBiosSnapshot.set(req.fileName, null);
      row.textContent = `${req.displayName}: \u2014 (BIOS library unavailable)`;
    }
  }

  // NDS status section \u2014 shows BIOS file availability and active DeSmuME settings
  const debugNdsHeadingId = "settings-debug-nds-heading";
  const ndsSection = make("div", {
    class: "settings-section",
    role: "region",
    "aria-labelledby": debugNdsHeadingId,
  });
  ndsSection.appendChild(make("h4", {
    class: "settings-section__title",
    id: debugNdsHeadingId,
  }, "NDS Status"));
  ndsSection.appendChild(make("p", { class: "settings-help" },
    "Nintendo DS uses the DeSmuME 2015 core. BIOS files are optional \u2014 DeSmuME falls back to a " +
    "built-in HLE BIOS when they are absent \u2014 but some games require the real files. " +
    "Upload BIOS files in the BIOS tab."
  ));

  const ndsBiosReqs = BIOS_REQUIREMENTS["nds"] ?? [];
  // Snapshot map populated by async checks \u2014 used by the "Copy Debug Info" button
  const ndsBiosSnapshot = new Map<string, boolean | null>();
  for (const req of ndsBiosReqs) ndsBiosSnapshot.set(req.fileName, null);

  for (const req of ndsBiosReqs) {
    const row = make("p", { class: "device-info" });
    row.textContent = `${req.displayName}: checking\u2026`;
    ndsSection.appendChild(row);

    if (biosLibrary) {
      biosLibrary.findBios("nds", req.fileName).then(found => {
        ndsBiosSnapshot.set(req.fileName, found !== null);
        row.textContent = `${req.displayName}: ${found ? "Uploaded" : "Not found (optional)"}`;
      }).catch(() => {
        ndsBiosSnapshot.set(req.fileName, null);
        row.textContent = `${req.displayName}: \u2014 (could not check)`;
      });
    } else {
      ndsBiosSnapshot.set(req.fileName, null);
      row.textContent = `${req.displayName}: \u2014 (BIOS library unavailable)`;
    }
  }

  // Show active DeSmuME performance settings when an NDS game is running
  const activeSystem = emulatorRef?.currentSystem;
  const activeCoreSettingsForNds = emulatorRef?.activeCoreSettings;
  if (activeSystem?.id === "nds" && activeCoreSettingsForNds) {
    const dsCpuMode    = activeCoreSettingsForNds["desmume_cpu_mode"]             ?? "\u2014";
    const dsFrameskip  = activeCoreSettingsForNds["desmume_frameskip"]            ?? "\u2014";
    const dsResolution = activeCoreSettingsForNds["desmume_internal_resolution"]  ?? "\u2014";
    const dsOpenGL     = activeCoreSettingsForNds["desmume_opengl_mode"]          ?? "\u2014";
    const dsTiming     = activeCoreSettingsForNds["desmume_advanced_timing"]      ?? "\u2014";
    const dsColorDepth = activeCoreSettingsForNds["desmume_color_depth"]          ?? "\u2014";
    const dsPointer    = activeCoreSettingsForNds["desmume_pointer_type"]         ?? "\u2014";
    const dsMicMode    = activeCoreSettingsForNds["desmume_mic_mode"]             ?? "\u2014";
    ndsSection.appendChild(make("p", { class: "device-info" },
      `Active DeSmuME settings (tier: ${emulatorRef?.activeTier ?? "\u2014"})`
    ));
    ndsSection.appendChild(make("p", { class: "device-info" },
      `CPU mode: ${dsCpuMode} | Frameskip: ${dsFrameskip} | Resolution: ${dsResolution}`
    ));
    ndsSection.appendChild(make("p", { class: "device-info" },
      `OpenGL: ${dsOpenGL} | Advanced timing: ${dsTiming} | Color depth: ${dsColorDepth}`
    ));
    ndsSection.appendChild(make("p", { class: "device-info" },
      `Touchscreen mode: ${dsPointer} | Mic mode: ${dsMicMode}`
    ));
  }

  // Emulator state section
  const debugStateHeadingId = "settings-debug-emulator-state-heading";
  const stateSection = make("div", {
    class: "settings-section",
    role: "region",
    "aria-labelledby": debugStateHeadingId,
  });
  stateSection.appendChild(make("h4", {
    class: "settings-section__title",
    id: debugStateHeadingId,
  }, "Emulator State"));

  stateSection.appendChild(make("p", { class: "device-info" },
    `State: ${emulatorRef?.state ?? "unknown"}`
  ));
  stateSection.appendChild(make("p", { class: "device-info" },
    `Active System: ${emulatorRef?.currentSystem?.name ?? "\u2014"} (id: ${emulatorRef?.currentSystem?.id ?? "\u2014"})`
  ));
  stateSection.appendChild(make("p", { class: "device-info" },
    `Active Tier: ${emulatorRef?.activeTier ?? "\u2014"}`
  ));
  const adapterInfo = emulatorRef?.webgpuAdapterInfo;
  const adapterLabel = (adapterInfo?.vendor || adapterInfo?.device)
    ? `${adapterInfo.device || adapterInfo.vendor}${adapterInfo.isFallbackAdapter ? " (software)" : ""}`
    : null;
  if (adapterLabel) {
    stateSection.appendChild(make("p", { class: "device-info" },
      `WebGPU Adapter: ${adapterLabel}`
    ));
  }

  // Active core settings section (PSP / RetroArch options applied at launch)
  const activeCoreSettings = emulatorRef?.activeCoreSettings;
  if (activeCoreSettings && Object.keys(activeCoreSettings).length > 0) {
    const debugCoreHeadingId = "settings-debug-active-core-heading";
    const coreSettingsSection = make("div", {
      class: "settings-section",
      role: "region",
      "aria-labelledby": debugCoreHeadingId,
    });
    coreSettingsSection.appendChild(make("h4", {
      class: "settings-section__title",
      id: debugCoreHeadingId,
    }, "Active Core Settings"));
    coreSettingsSection.appendChild(make("p", { class: "settings-help" },
      "RetroArch / PPSSPP core options that were passed to the emulator at launch."
    ));
    const list = make("ul", { class: "core-settings-list" });
    for (const [key, value] of Object.entries(activeCoreSettings)) {
      const item = make("li", { class: "core-settings-item" });
      item.appendChild(make("span", { class: "core-settings-key" }, key));
      item.appendChild(make("span", { class: "core-settings-value" }, String(value)));
      list.appendChild(item);
    }
    coreSettingsSection.appendChild(list);
    stateSection.appendChild(coreSettingsSection);
  }

  // Startup profiler section (Phase 9)
  const profSummary = emulatorRef?.startupProfiler?.summary();
  if (profSummary && profSummary.records.length > 0) {
    const debugProfHeadingId = "settings-debug-launch-profile-heading";
    const profSection = make("div", {
      class: "settings-section",
      role: "region",
      "aria-labelledby": debugProfHeadingId,
    });
    profSection.appendChild(make("h4", {
      class: "settings-section__title",
      id: debugProfHeadingId,
    }, "Last Launch Profile"));
    profSection.appendChild(make("p", { class: "settings-help" },
      "Time spent in each phase of the most recent game launch."
    ));
    const profList = make("ul", { class: "core-settings-list" });
    for (const r of profSummary.records) {
      const item = make("li", { class: "core-settings-item" });
      const isSlowest = r === profSummary.slowest;
      item.appendChild(make("span", { class: "core-settings-key" }, `${isSlowest ? "[slowest] " : ""}${r.phase}`));
      item.appendChild(make("span", { class: "core-settings-value" }, `${r.durationMs.toFixed(0)} ms`));
      profList.appendChild(item);
    }
    const totalItem = make("li", { class: "core-settings-item" });
    totalItem.appendChild(make("span", { class: "core-settings-key" }, "total"));
    totalItem.appendChild(make("span", { class: "core-settings-value" }, `${profSummary.totalMs.toFixed(0)} ms`));
    profList.appendChild(totalItem);
    profSection.appendChild(profList);
    stateSection.appendChild(profSection);
  }

  // Diagnostic event timeline section
  const debugTimelineHeadingId = "settings-debug-diagnostic-timeline-heading";
  const timelineSection = make("div", {
    class: "settings-section",
    role: "region",
    "aria-labelledby": debugTimelineHeadingId,
  });
  timelineSection.appendChild(make("h4", {
    class: "settings-section__title",
    id: debugTimelineHeadingId,
  }, "Diagnostic Timeline"));
  timelineSection.appendChild(make("p", { class: "settings-help" },
    "Recent performance and system events logged during emulator operation."
  ));

  const diagnosticEvents = emulatorRef?.diagnosticLog ?? [];
  if (diagnosticEvents.length === 0) {
    timelineSection.appendChild(make("p", { class: "device-info" },
      "No diagnostic events recorded yet. Events appear after launching a game."
    ));
  } else {
    const eventList = make("ul", { class: "core-settings-list" });
    // Display only the most recent events to keep the panel responsive
    const MAX_DISPLAYED_DIAGNOSTIC_EVENTS = 20;
    const recentEvents = diagnosticEvents.slice(-MAX_DISPLAYED_DIAGNOSTIC_EVENTS).reverse();
    for (const evt of recentEvents) {
      const item = make("li", { class: "core-settings-item" });
      const time = new Date(evt.timestamp).toLocaleTimeString();
      const badge = evt.category === "error" ? "[error]"
        : evt.category === "performance" ? "[perf]"
        : evt.category === "audio" ? "[audio]"
        : evt.category === "render" ? "[render]"
        : "[info]";
      item.appendChild(make("span", { class: "core-settings-key" }, `${badge} ${time}`));
      item.appendChild(make("span", { class: "core-settings-value" }, evt.message));
      eventList.appendChild(item);
    }
    timelineSection.appendChild(eventList);
  }

  // Actions section
  const debugActionsHeadingId = "settings-debug-actions-heading";
  const actionsSection = make("div", {
    class: "settings-section",
    role: "region",
    "aria-labelledby": debugActionsHeadingId,
  });
  actionsSection.appendChild(make("h4", {
    class: "settings-section__title",
    id: debugActionsHeadingId,
  }, "Actions"));
  actionsSection.appendChild(make("p", { class: "settings-help" },
    "Copy a snapshot of diagnostics to the clipboard for bug reports."
  ));

  const btnCopy = make("button", { type: "button", class: "btn" }, "Copy Debug Info") as HTMLButtonElement;
  btnCopy.addEventListener("click", () => {
    const lines = [
      `${APP_NAME} Debug Info \u2014 ${new Date().toISOString()}`,
      ``,
      `[Environment]`,
      `Cross-Origin Isolated: ${isIsolated}`,
      `SharedArrayBuffer: ${hasSAB}`,
      `WebAssembly: ${hasWasm}`,
      `User Agent: ${navigator.userAgent}`,
      ``,
      `[Device]`,
      `Tier: ${deviceCaps.tier}`,
      `GPU Score: ${deviceCaps.gpuBenchmarkScore}/100`,
      `Estimated VRAM: ${deviceCaps.estimatedVRAMMB} MB`,
      `Low-Spec: ${deviceCaps.isLowSpec}`,
      `ChromeOS: ${deviceCaps.isChromOS}`,
      `WebGL2: ${deviceCaps.gpuCaps.webgl2}`,
      `WebGPU: ${deviceCaps.webgpuAvailable}`,
      `Max Texture: ${deviceCaps.gpuCaps.maxTextureSize}px`,
      `Anisotropic: ${deviceCaps.gpuCaps.anisotropicFiltering} (max ${deviceCaps.gpuCaps.maxAnisotropy}\u00d7)`,
      `Float Textures: ${deviceCaps.gpuCaps.floatTextures}`,
      `Instanced Arrays: ${deviceCaps.gpuCaps.instancedArrays}`,
      `ETC2 Textures: ${deviceCaps.gpuCaps.etc2Textures}`,
      `ASTC Textures: ${deviceCaps.gpuCaps.astcTextures}`,
      `Compressed Textures: ${deviceCaps.gpuCaps.compressedTextures}`,
      `MRT Attachments: ${deviceCaps.gpuCaps.maxColorAttachments}`,
      `Multi-Draw: ${deviceCaps.gpuCaps.multiDraw}`,
      ``,
      `[Emulator]`,
      `State: ${emulatorRef?.state ?? "unknown"}`,
      `System: ${emulatorRef?.currentSystem?.id ?? "\u2014"}`,
      `Tier: ${emulatorRef?.activeTier ?? "\u2014"}`,
      `Thermal Pressure: ${emulatorRef?.thermalPressureState ?? "unknown"}`,
    ];
    if (adapterLabel) {
      lines.push(`WebGPU Adapter: ${adapterLabel}`);
    }
    const snapshotSettings = emulatorRef?.activeCoreSettings;
    if (snapshotSettings && Object.keys(snapshotSettings).length > 0) {
      lines.push(``, `[Core Settings]`);
      for (const [key, value] of Object.entries(snapshotSettings)) {
        lines.push(`${key}: ${String(value)}`);
      }
    }
    // Include startup profiler summary
    const profSummary = emulatorRef?.startupProfiler?.summary();
    if (profSummary && profSummary.records.length > 0) {
      lines.push(``, `[Startup Profile]`);
      for (const r of profSummary.records) {
        lines.push(`${r.phase}: ${r.durationMs.toFixed(0)} ms`);
      }
      lines.push(`total: ${profSummary.totalMs.toFixed(0)} ms`);
    }
    // Include PS1 BIOS status (populated asynchronously when the tab opened)
    if (psxBiosReqs.length > 0) {
      lines.push(``, `[PS1 BIOS]`);
      for (const req of psxBiosReqs) {
        const status = psxBiosSnapshot.get(req.fileName);
        lines.push(`${req.fileName}: ${status === true ? "present" : status === false ? "missing" : "unknown"}`);
      }
    }
    // Include NDS BIOS status (populated asynchronously when the tab opened)
    if (ndsBiosReqs.length > 0) {
      lines.push(``, `[NDS BIOS]`);
      for (const req of ndsBiosReqs) {
        const status = ndsBiosSnapshot.get(req.fileName);
        lines.push(`${req.fileName}: ${status === true ? "present" : status === false ? "missing (optional)" : "unknown"}`);
      }
    }
    lines.push(
      ``,
      `[Netplay]`,
      `Enabled: ${peekNetplayManager()?.enabled ?? false}`,
      `Active: ${peekNetplayManager()?.isActive ?? false}`,
      `Server: ${peekNetplayManager()?.serverUrl || "\u2014"}`,
      `ICE Servers: ${peekNetplayManager()?.iceServers?.length ?? 0}`,
      ...(peekNetplayManager()?.iceServers ?? []).map((s) =>
        `  ${Array.isArray(s.urls) ? s.urls.join(", ") : s.urls}`
      ),
    );

    // Include diagnostic event log
    const diagEvents = emulatorRef?.diagnosticLog ?? [];
    if (diagEvents.length > 0) {
      lines.push(``, `[Diagnostic Timeline (last ${Math.min(50, diagEvents.length)} events)]`);
      const recentDiag = diagEvents.slice(-50);
      for (const evt of recentDiag) {
        const t = new Date(evt.timestamp).toLocaleTimeString();
        lines.push(`[${t}] [${evt.category}] ${evt.message}`);
      }
    }

    const origText = btnCopy.textContent ?? "Copy Debug Info";
    btnCopy.disabled = true;
    btnCopy.setAttribute("aria-busy", "true");
    btnCopy.textContent = "Copying...";

    navigator.clipboard.writeText(lines.join("\n")).then(() => {
      showInfoToast("Debug info copied to clipboard.");
    }).catch(() => {
      showError("Could not copy to clipboard.");
    }).finally(() => {
      btnCopy.disabled = false;
      btnCopy.removeAttribute("aria-busy");
      btnCopy.textContent = origText;
    });
  });
  actionsSection.appendChild(btnCopy);

  // Clear device capability cache \u2014 forces full re-detection on next page load
  const btnClearCaps = make("button", { type: "button", class: "btn btn--secondary" }, "Clear Capability Cache");
  btnClearCaps.title = "Force re-detection of GPU tier and device capabilities on next reload.";
  btnClearCaps.addEventListener("click", () => {
    clearCapabilitiesCache();
    showInfoToast("Capability cache cleared. Reload the page to re-detect device capabilities.");
  });
  actionsSection.appendChild(btnClearCaps);

  // Thermal pressure section (Phase 9)
  const debugThermalHeadingId = "settings-debug-thermal-heading";
  const thermalSection = make("div", {
    class: "settings-section",
    role: "region",
    "aria-labelledby": debugThermalHeadingId,
  });
  thermalSection.appendChild(make("h4", {
    class: "settings-section__title",
    id: debugThermalHeadingId,
  }, "Thermal & Pressure"));
  thermalSection.appendChild(make("p", { class: "settings-help" },
    "Compute Pressure API \u2014 monitors CPU thermal load to proactively prevent OS-forced throttling. " +
    "Requires Chrome 125+ (or a compatible browser)."
  ));
  const thermalState = emulatorRef?.thermalPressureState ?? "unknown";
  const thermalLabel = thermalState === "nominal"  ? "\u2705 Nominal \u2014 device is cool"
    : thermalState === "fair"     ? "\U0001f7e1 Fair \u2014 minor thermal load"
    : thermalState === "serious"  ? "\U0001f7e0 Serious \u2014 sustained high thermal load"
    : thermalState === "critical" ? "\U0001f534 Critical \u2014 OS throttling is active"
    : "\u26aa Unknown \u2014 Compute Pressure API unavailable";
  thermalSection.appendChild(make("p", { class: "device-info" },
    `Thermal Pressure: ${thermalLabel}`
  ));
  if (thermalState === "unknown") {
    thermalSection.appendChild(make("p", { class: "device-info" },
      "Compute Pressure API is not available in this browser."
    ));
  }

  container.append(settingsSection, envSection, gpuSection, ps1Section, ndsSection, stateSection, timelineSection, thermalSection, actionsSection);
}
