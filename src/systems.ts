/**
 * systems.ts — Supported emulation systems and file-extension mapping
 *
 * EmulatorJS supports many systems via RetroArch cores. Each system
 * definition here maps to an EmulatorJS core identifier plus metadata
 * used throughout the UI (badges, colours, performance settings).
 *
 * PSP settings are now tier-aware: low / medium / high / ultra each
 * map to a different combination of PPSSPP RetroArch core options for
 * optimal performance-to-quality ratio on each hardware class.
 */

import type { PerformanceTier } from "./performance.js";

// ── System definition ─────────────────────────────────────────────────────────

export interface SystemInfo {
  /** EmulatorJS core/system name (value of EJS_core). */
  id: string;
  /** Full human-readable name. */
  name: string;
  /** Short label for library badges. */
  shortName: string;
  /** Accepted file extensions, lowercase without the leading dot. */
  extensions: string[];
  /** Badge background colour. */
  color: string;
  /** Whether PPSSPP (or another threads-dependent core) is used. */
  needsThreads: boolean;
  /** Whether the core requires a WebGL 2 context. */
  needsWebGL2: boolean;
  /**
   * EJS_Settings overrides applied in "performance" (low-spec) mode.
   * Keys are RetroArch core-option names; values are strings.
   */
  perfSettings: Record<string, string>;
  /**
   * EJS_Settings overrides applied in normal "quality" mode.
   */
  qualitySettings: Record<string, string>;
  /**
   * Optional tier-aware settings for systems that benefit from granular
   * tuning (PSP, N64). When present, these override perfSettings/qualitySettings.
   */
  tierSettings?: Record<PerformanceTier, Record<string, string>>;
}

// ── PPSSPP tier-specific core options ─────────────────────────────────────────

/**
 * Comprehensive PPSSPP RetroArch core options tuned for each hardware tier.
 *
 * Option reference (PPSSPP libretro):
 *   ppsspp_internal_resolution  — Rendering resolution multiplier (1–10)
 *   ppsspp_auto_frameskip       — Dynamic frameskip to maintain speed
 *   ppsspp_frameskip            — Fixed number of frames to skip (0–9)
 *   ppsspp_frameskip_type       — "Number of frames" or "Percent of FPS"
 *   ppsspp_fast_memory          — Skip memory access safety checks (faster)
 *   ppsspp_block_transfer_gpu   — Use GPU for block transfers (faster rendering)
 *   ppsspp_texture_scaling_level — Texture upscale factor (1–5, 1=off)
 *   ppsspp_texture_scaling_type  — Upscale algorithm (xBRZ, hybrid, etc.)
 *   ppsspp_texture_filtering     — Anisotropic filtering level
 *   ppsspp_texture_deposterize   — Reduce colour banding in textures
 *   ppsspp_gpu_hardware_transform — Hardware vertex transform (vs software)
 *   ppsspp_vertex_cache          — Cache transformed vertices (faster)
 *   ppsspp_lazy_texture_caching  — Skip re-hashing unchanged textures
 *   ppsspp_retain_changed_textures — Keep modified textures in VRAM
 *   ppsspp_spline_quality        — Spline/bezier curve quality (low/medium/high)
 *   ppsspp_software_skinning     — GPU-side vertex skinning
 *   ppsspp_io_timing_method      — I/O timing (fast/host/simulate UMD)
 *   ppsspp_lower_resolution_for_effects — Reduce resolution for post-processing
 *   ppsspp_inflight_frames       — CPU-GPU pipeline depth (improves throughput)
 *   ppsspp_rendering_mode        — Buffered vs non-buffered rendering
 *   ppsspp_cpu_core              — JIT vs interpreter
 */
const PSP_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  // ── Low: maximum performance, minimum quality ──────────────────────────────
  low: {
    ppsspp_internal_resolution: "1",        // Native 480×272
    ppsspp_auto_frameskip: "enabled",
    ppsspp_frameskip: "1",
    ppsspp_frameskip_type: "Number of frames",
    ppsspp_fast_memory: "enabled",
    ppsspp_block_transfer_gpu: "enabled",
    ppsspp_texture_scaling_level: "1",      // No upscaling
    ppsspp_texture_scaling_type: "xBRZ",
    ppsspp_texture_filtering: "auto",
    ppsspp_texture_deposterize: "disabled",
    ppsspp_gpu_hardware_transform: "enabled",
    ppsspp_vertex_cache: "enabled",
    ppsspp_lazy_texture_caching: "enabled", // Skip re-hashing
    ppsspp_retain_changed_textures: "disabled",
    ppsspp_spline_quality: "low",
    ppsspp_software_skinning: "enabled",
    ppsspp_io_timing_method: "Fast",
    ppsspp_lower_resolution_for_effects: "2",  // Half resolution effects
    ppsspp_inflight_frames: "2",
    ppsspp_rendering_mode: "buffered",
    ppsspp_cpu_core: "JIT",
  },

  // ── Medium: balanced — small quality bumps where cheap ─────────────────────
  medium: {
    ppsspp_internal_resolution: "1",        // Still native for CPU headroom
    ppsspp_auto_frameskip: "enabled",
    ppsspp_frameskip: "0",                  // Only auto-skip, not forced
    ppsspp_frameskip_type: "Number of frames",
    ppsspp_fast_memory: "enabled",
    ppsspp_block_transfer_gpu: "enabled",
    ppsspp_texture_scaling_level: "1",
    ppsspp_texture_scaling_type: "xBRZ",
    ppsspp_texture_filtering: "auto",
    ppsspp_texture_deposterize: "enabled",
    ppsspp_gpu_hardware_transform: "enabled",
    ppsspp_vertex_cache: "enabled",
    ppsspp_lazy_texture_caching: "enabled",
    ppsspp_retain_changed_textures: "enabled",
    ppsspp_spline_quality: "medium",
    ppsspp_software_skinning: "enabled",
    ppsspp_io_timing_method: "Fast",
    ppsspp_lower_resolution_for_effects: "0",  // Full resolution
    ppsspp_inflight_frames: "2",
    ppsspp_rendering_mode: "buffered",
    ppsspp_cpu_core: "JIT",
  },

  // ── High: quality focus with sensible limits ───────────────────────────────
  high: {
    ppsspp_internal_resolution: "2",        // 2× (960×544)
    ppsspp_auto_frameskip: "disabled",
    ppsspp_frameskip: "0",
    ppsspp_frameskip_type: "Number of frames",
    ppsspp_fast_memory: "enabled",
    ppsspp_block_transfer_gpu: "enabled",
    ppsspp_texture_scaling_level: "2",      // 2× texture upscale
    ppsspp_texture_scaling_type: "xBRZ",
    ppsspp_texture_filtering: "auto",
    ppsspp_texture_deposterize: "enabled",
    ppsspp_gpu_hardware_transform: "enabled",
    ppsspp_vertex_cache: "enabled",
    ppsspp_lazy_texture_caching: "disabled", // More accurate
    ppsspp_retain_changed_textures: "enabled",
    ppsspp_spline_quality: "high",
    ppsspp_software_skinning: "enabled",
    ppsspp_io_timing_method: "Fast",
    ppsspp_lower_resolution_for_effects: "0",
    ppsspp_inflight_frames: "3",
    ppsspp_rendering_mode: "buffered",
    ppsspp_cpu_core: "JIT",
  },

  // ── Ultra: maximum quality ─────────────────────────────────────────────────
  ultra: {
    ppsspp_internal_resolution: "3",        // 3× (1440×816)
    ppsspp_auto_frameskip: "disabled",
    ppsspp_frameskip: "0",
    ppsspp_frameskip_type: "Number of frames",
    ppsspp_fast_memory: "enabled",
    ppsspp_block_transfer_gpu: "enabled",
    ppsspp_texture_scaling_level: "3",      // 3× texture upscale
    ppsspp_texture_scaling_type: "xBRZ",
    ppsspp_texture_filtering: "auto",
    ppsspp_texture_deposterize: "enabled",
    ppsspp_gpu_hardware_transform: "enabled",
    ppsspp_vertex_cache: "enabled",
    ppsspp_lazy_texture_caching: "disabled",
    ppsspp_retain_changed_textures: "enabled",
    ppsspp_spline_quality: "high",
    ppsspp_software_skinning: "enabled",
    ppsspp_io_timing_method: "Fast",
    ppsspp_lower_resolution_for_effects: "0",
    ppsspp_inflight_frames: "3",
    ppsspp_rendering_mode: "buffered",
    ppsspp_cpu_core: "JIT",
  },
};

/**
 * Get the appropriate PPSSPP settings for a given performance tier.
 */
export function getPSPSettingsForTier(tier: PerformanceTier): Record<string, string> {
  return { ...PSP_TIER_SETTINGS[tier] };
}

// ── Supported systems ─────────────────────────────────────────────────────────

export const SYSTEMS: SystemInfo[] = [
  {
    id: "psp",
    name: "PlayStation Portable",
    shortName: "PSP",
    extensions: ["iso", "cso", "elf"],
    color: "#0070cc",
    needsThreads: true,
    needsWebGL2: true,
    qualitySettings: {
      ppsspp_internal_resolution: "2",
      ppsspp_auto_frameskip: "disabled",
      ppsspp_frameskip: "0",
      ppsspp_fast_memory: "enabled",
    },
    perfSettings: {
      ppsspp_internal_resolution: "1",
      ppsspp_auto_frameskip: "enabled",
      ppsspp_frameskip: "1",
      ppsspp_fast_memory: "enabled",
      ppsspp_block_transfer_gpu: "enabled",
    },
    tierSettings: PSP_TIER_SETTINGS,
  },
  {
    id: "nes",
    name: "Nintendo Entertainment System",
    shortName: "NES",
    extensions: ["nes", "fds", "unf", "unif"],
    color: "#e52b2b",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: {},
    perfSettings: {},
  },
  {
    id: "snes",
    name: "Super Nintendo",
    shortName: "SNES",
    extensions: ["snes", "smc", "sfc", "fig", "bs"],
    color: "#7b3fae",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: {},
    perfSettings: {},
  },
  {
    id: "gba",
    name: "Game Boy Advance",
    shortName: "GBA",
    extensions: ["gba"],
    color: "#7c4dff",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: {
      mgba_skip_bios: "ON",
    },
    perfSettings: {
      mgba_skip_bios: "ON",
    },
  },
  {
    id: "gbc",
    name: "Game Boy Color",
    shortName: "GBC",
    extensions: ["gbc"],
    color: "#e87d2a",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: {},
    perfSettings: {},
  },
  {
    id: "gb",
    name: "Game Boy",
    shortName: "GB",
    extensions: ["gb"],
    color: "#7a9e27",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: {},
    perfSettings: {},
  },
  {
    id: "n64",
    name: "Nintendo 64",
    shortName: "N64",
    extensions: ["n64", "v64", "z64"],
    color: "#1a7a1a",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: {},
    perfSettings: {
      "mupen64plus-rdp-plugin": "gliden64",
      "mupen64plus-resolution-factor": "1",
    },
  },
  {
    id: "psx",
    name: "PlayStation 1",
    shortName: "PS1",
    extensions: ["pbp", "chd", "cue", "img", "mdf", "ccd"],
    color: "#003087",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: {},
    perfSettings: {},
  },
  {
    id: "segaMD",
    name: "Sega Genesis / Mega Drive",
    shortName: "Genesis",
    extensions: ["md", "smd", "gen"],
    color: "#1a1ae6",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: {},
    perfSettings: {},
  },
  {
    id: "segaGG",
    name: "Game Gear",
    shortName: "GG",
    extensions: ["gg"],
    color: "#e64a1a",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: {},
    perfSettings: {},
  },
  {
    id: "segaMS",
    name: "Sega Master System",
    shortName: "SMS",
    extensions: ["sms"],
    color: "#2255cc",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: {},
    perfSettings: {},
  },
  {
    id: "atari2600",
    name: "Atari 2600",
    shortName: "2600",
    extensions: ["a26"],
    color: "#c0392b",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: {},
    perfSettings: {},
  },
  {
    id: "arcade",
    name: "Arcade (MAME)",
    shortName: "Arcade",
    extensions: ["zip"],
    color: "#e67e22",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: {},
    perfSettings: {},
  },
];

// ── Extension lookup tables ───────────────────────────────────────────────────

/** Extension → single unambiguous system. */
const UNIQUE_EXT: Map<string, SystemInfo> = new Map();
/** Extension → multiple candidate systems (ambiguous). */
const AMBIGUOUS_EXT: Map<string, SystemInfo[]> = new Map();

(function buildMaps() {
  const extToSystems = new Map<string, SystemInfo[]>();
  for (const sys of SYSTEMS) {
    for (const ext of sys.extensions) {
      if (!extToSystems.has(ext)) extToSystems.set(ext, []);
      extToSystems.get(ext)!.push(sys);
    }
  }
  for (const [ext, systems] of extToSystems) {
    if (systems.length === 1) UNIQUE_EXT.set(ext, systems[0]);
    else                      AMBIGUOUS_EXT.set(ext, systems);
  }
})();

/** All accepted extensions, for use in <input accept>. */
export const ALL_EXTENSIONS: string[] = [
  ...new Set(SYSTEMS.flatMap(s => s.extensions)),
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect the system(s) compatible with the given filename.
 *
 * - Returns a single SystemInfo when the extension is unambiguous.
 * - Returns an array of candidates when multiple systems share the extension.
 * - Returns null when the extension is unknown.
 */
export function detectSystem(
  fileName: string
): SystemInfo | SystemInfo[] | null {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (UNIQUE_EXT.has(ext))    return UNIQUE_EXT.get(ext)!;
  if (AMBIGUOUS_EXT.has(ext)) return AMBIGUOUS_EXT.get(ext)!;
  return null;
}

/** Look up a system by its EJS core identifier. */
export function getSystemById(id: string): SystemInfo | undefined {
  return SYSTEMS.find(s => s.id === id);
}
