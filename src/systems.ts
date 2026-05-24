/**
 * systems.ts — Supported emulation systems and file-extension mapping
 *
 * EmulatorJS supports many systems via RetroArch cores. Each system
 * definition here maps to an EmulatorJS core identifier plus metadata
 * used throughout the UI (badges, colours, performance settings).
 *
 * Performance-heavy systems (PSP / NDS / N64 / Saturn / Dreamcast) use tier-aware settings;
 * low / medium / high / ultra map to progressively heavier core options so
 * low-end devices prioritize playability while high-end devices raise quality.
 */

import type { PerformanceTier } from "./performance.js";

// ── System definition ─────────────────────────────────────────────────────────

export interface SystemInfo {
  /** EmulatorJS core/system name (value of EJS_core). */
  id: string;
  /**
   * Override EJS_core with this value at launch time.
   * Use when the internal system ID (id) differs from the EmulatorJS core name —
   * e.g. id="segaDC" but EJS_core must be "flycast".
   */
  coreId?: string;
  /**
   * Absolute URL to a custom core `.data` bundle.
   * When set, EJS_corePath is passed to EmulatorJS so the loader fetches this
   * URL directly instead of constructing a CDN-relative path.
   * Required for cores not hosted on the official EmulatorJS CDN (e.g. Flycast).
   */
  corePath?: string;
  /** Full human-readable name. */
  name: string;
  /** Short label for library badges. */
  shortName: string;
  /** Whether support exists but should be presented as experimental. */
  experimental?: boolean;
  /** Short user-facing note about stability or support status. */
  stabilityNotice?: string;
  /** Optional system art asset URL for external metadata integrations. */
  iconUrl?: string;
  /** Accepted file extensions, lowercase without the leading dot. */
  extensions: string[];
  /** Badge background colour. */
  color: string;
  /** Whether PPSSPP (or another threads-dependent core) is used. */
  needsThreads: boolean;
  /** Whether the core requires a WebGL 2 context. */
  needsWebGL2: boolean;
  /**
   * How touch controls should behave on mobile.
   * - `"overlay"`: RetroOasis's virtual controls are useful for this system.
   * - `"builtin"`: The core has its own touch-first UI, so RetroOasis should
   *   keep its overlay off by default.
   */
  touchControlMode?: "overlay" | "builtin";
  /**
   * Whether this system requires a BIOS file to operate.
   * When true, RetroOasis will check the BIOS store before launch.
   */
  needsBios?: boolean;
  /**
   * Whether this system renders 3D graphics (polygon-based geometry).
   * When true, post-processing effects like FSR and TAA are particularly
   * beneficial. 2D pixel-art systems omit this field (defaults to false).
   */
  is3D?: boolean;
  /**
   * Whether this system is supported by RetroAchievements.org.
   */
  hasAchievements?: boolean;
  /**
   * Numeric identifier used by ScreenScraper.fr.
   */
  screenscraperId?: number;
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

function fixedCoreTierSettings(
  retroarchCore: string,
  extra: Record<string, string> = {},
): Record<PerformanceTier, Record<string, string>> {
  const make = (): Record<string, string> => ({ retroarch_core: retroarchCore, ...extra });
  return { low: make(), medium: make(), high: make(), ultra: make() };
}

function overrideRetroarchCore(
  base: Record<PerformanceTier, Record<string, string>>,
  retroarchCore: string,
): Record<PerformanceTier, Record<string, string>> {
  return {
    low:    { ...base.low,    retroarch_core: retroarchCore },
    medium: { ...base.medium, retroarch_core: retroarchCore },
    high:   { ...base.high,   retroarch_core: retroarchCore },
    ultra:  { ...base.ultra,  retroarch_core: retroarchCore },
  };
}

// ── PPSSPP tier-specific core options ─────────────────────────────────────────

/**
 * Comprehensive PPSSPP RetroArch core options tuned for each hardware tier.
 *
 * Core rendering & GPU options:
 *   ppsspp_internal_resolution          — Rendering resolution multiplier (1–10)
 *   ppsspp_block_transfer_gpu           — Use GPU for block transfers (faster rendering)
 *   ppsspp_gpu_hardware_transform       — Hardware vertex transform (vs software)
 *   ppsspp_vertex_cache                 — Cache transformed vertices (faster)
 *   ppsspp_rendering_mode               — Hardware backend (OpenGL for the web build)
 *   ppsspp_inflight_frames              — CPU-GPU pipeline depth (improves throughput)
 *   ppsspp_lower_resolution_for_effects — Reduce resolution for post-processing
 *   ppsspp_skip_buffer_effects          — Skip expensive framebuffer effects
 *   ppsspp_disable_slow_framebuf_effects — Disable slow framebuffer operations
 *   ppsspp_gpu_anisotropic_filtering    — GPU-level anisotropic filtering (off/2x/4x/8x/16x)
 *
 * Texture options:
 *   ppsspp_texture_scaling_level  — Texture upscale factor (1–5, 1=off)
 *   ppsspp_texture_scaling_type   — Upscale algorithm (xBRZ, hybrid, etc.)
 *   ppsspp_texture_filtering      — Anisotropic filtering level
 *   ppsspp_texture_deposterize    — Reduce colour banding in textures
 *   ppsspp_lazy_texture_caching   — Skip re-hashing unchanged textures
 *   ppsspp_retain_changed_textures — Keep modified textures in VRAM
 *   ppsspp_texture_shader          — GPU shader for texture replacement
 *
 * CPU & frameskip:
 *   ppsspp_cpu_core              — JIT vs interpreter
 *   ppsspp_auto_frameskip        — Dynamic frameskip to maintain speed
 *   ppsspp_frameskip             — Fixed number of frames to skip (0–9)
 *   ppsspp_frameskip_type        — "Number of frames" or "Percent of FPS"
 *   ppsspp_fast_memory           — Skip memory access safety checks (faster)
 *   ppsspp_locked_cpu_speed      — Lock CPU clock (0 = default PSP speed)
 *   ppsspp_force_max_fps         — Force max FPS cap (0 = uncapped, 60 = standard)
 *   ppsspp_change_emulated_psp_cpu_clock — Over/underclock emulated PSP CPU (±MHz)
 *   ppsspp_unsafe_func_replacements — Replace known functions with fast native versions
 *
 * I/O & audio:
 *   ppsspp_io_timing_method      — I/O timing (fast/host/simulate UMD)
 *   ppsspp_separate_io_thread    — Run I/O on a separate thread (reduces stalls)
 *   ppsspp_audio_latency         — Audio buffer size: 0=low, 1=medium, 2=high
 *   ppsspp_audio_resampling      — High-quality audio resampling
 *
 * Misc:
 *   ppsspp_spline_quality        — Spline/bezier curve quality (low/medium/high)
 *   ppsspp_software_skinning     — GPU-side vertex skinning
 *   ppsspp_cheats                — Enable cheat engine (minor overhead)
 */
const PSP_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  // ── Low: maximum performance, minimum quality ──────────────────────────────
  low: {
    ppsspp_internal_resolution: "1",
    ppsspp_auto_frameskip: "enabled",
    ppsspp_frameskip: "3",
    ppsspp_frameskip_type: "Number of frames",
    ppsspp_fast_memory: "enabled",
    ppsspp_block_transfer_gpu: "enabled",
    ppsspp_texture_scaling_level: "1",
    ppsspp_texture_scaling_type: "xBRZ",
    ppsspp_texture_filtering: "auto",
    ppsspp_texture_deposterize: "disabled",
    ppsspp_gpu_hardware_transform: "enabled",
    ppsspp_vertex_cache: "enabled",
    ppsspp_vertex_range_inline: "enabled",
    ppsspp_lazy_texture_caching: "enabled",
    ppsspp_retain_changed_textures: "disabled",
    ppsspp_spline_quality: "low",
    ppsspp_software_skinning: "enabled",
    ppsspp_io_timing_method: "Fast",
    ppsspp_lower_resolution_for_effects: "2",
    ppsspp_inflight_frames: "1",
    ppsspp_rendering_mode: "OpenGL",
    ppsspp_cpu_core: "JIT",
    ppsspp_audio_latency: "2",
    ppsspp_audio_resampling: "disabled",
    ppsspp_locked_cpu_speed: "0",
    ppsspp_force_max_fps: "30",
    ppsspp_cheats: "enabled",
    ppsspp_skip_buffer_effects: "enabled",
    ppsspp_disable_slow_framebuf_effects: "enabled",
    ppsspp_gpu_anisotropic_filtering: "off",
    ppsspp_texture_shader: "Off",
    ppsspp_change_emulated_psp_cpu_clock: "0",
    ppsspp_separate_io_thread: "enabled",
    ppsspp_unsafe_func_replacements: "enabled",
    ppsspp_gpu_driver: "OpenGL",
  },

  // ── Medium: balanced — quality bumps where cost is low ─────────────────────
  medium: {
    ppsspp_internal_resolution: "1",
    ppsspp_auto_frameskip: "enabled",
    ppsspp_frameskip: "1",
    ppsspp_frameskip_type: "Number of frames",
    ppsspp_fast_memory: "enabled",
    ppsspp_block_transfer_gpu: "enabled",
    ppsspp_texture_scaling_level: "1",
    ppsspp_texture_scaling_type: "xBRZ",
    ppsspp_texture_filtering: "auto",
    ppsspp_texture_deposterize: "enabled",
    ppsspp_gpu_hardware_transform: "enabled",
    ppsspp_vertex_cache: "enabled",
    ppsspp_vertex_range_inline: "enabled",
    ppsspp_lazy_texture_caching: "enabled",
    ppsspp_retain_changed_textures: "enabled",
    ppsspp_spline_quality: "medium",
    ppsspp_software_skinning: "enabled",
    ppsspp_io_timing_method: "Fast",
    ppsspp_lower_resolution_for_effects: "0",
    ppsspp_inflight_frames: "2",
    ppsspp_rendering_mode: "OpenGL",
    ppsspp_cpu_core: "JIT",
    ppsspp_audio_latency: "1",
    ppsspp_audio_resampling: "enabled",
    ppsspp_locked_cpu_speed: "0",
    ppsspp_force_max_fps: "60",
    ppsspp_cheats: "enabled",
    ppsspp_skip_buffer_effects: "disabled",
    ppsspp_disable_slow_framebuf_effects: "enabled",
    ppsspp_gpu_anisotropic_filtering: "2x",
    ppsspp_texture_shader: "Off",
    ppsspp_change_emulated_psp_cpu_clock: "0",
    ppsspp_separate_io_thread: "enabled",
    ppsspp_unsafe_func_replacements: "enabled",
    ppsspp_gpu_driver: "OpenGL",
  },

  // ── High: quality focus with sensible limits ───────────────────────────────
  high: {
    ppsspp_internal_resolution: "2",
    ppsspp_auto_frameskip: "disabled",
    ppsspp_frameskip: "0",
    ppsspp_frameskip_type: "Number of frames",
    ppsspp_fast_memory: "enabled",
    ppsspp_block_transfer_gpu: "enabled",
    ppsspp_texture_scaling_level: "2",
    ppsspp_texture_scaling_type: "xBRZ",
    ppsspp_texture_filtering: "auto",
    ppsspp_texture_deposterize: "enabled",
    ppsspp_gpu_hardware_transform: "enabled",
    ppsspp_vertex_cache: "enabled",
    ppsspp_vertex_range_inline: "enabled",
    ppsspp_lazy_texture_caching: "enabled",
    ppsspp_retain_changed_textures: "enabled",
    ppsspp_spline_quality: "high",
    ppsspp_software_skinning: "enabled",
    ppsspp_io_timing_method: "Fast",
    ppsspp_lower_resolution_for_effects: "0",
    ppsspp_inflight_frames: "2",
    ppsspp_rendering_mode: "OpenGL",
    ppsspp_cpu_core: "JIT",
    ppsspp_audio_latency: "1",
    ppsspp_audio_resampling: "enabled",
    ppsspp_locked_cpu_speed: "0",
    ppsspp_force_max_fps: "0",
    ppsspp_cheats: "enabled",
    ppsspp_skip_buffer_effects: "disabled",
    ppsspp_disable_slow_framebuf_effects: "disabled",
    ppsspp_gpu_anisotropic_filtering: "8x",
    ppsspp_texture_shader: "Off",
    ppsspp_change_emulated_psp_cpu_clock: "0",
    ppsspp_separate_io_thread: "enabled",
    ppsspp_unsafe_func_replacements: "enabled",
    ppsspp_gpu_driver: "OpenGL",
  },

  // ── Ultra: maximum quality ─────────────────────────────────────────────────
  ultra: {
    ppsspp_internal_resolution: "4",
    ppsspp_auto_frameskip: "disabled",
    ppsspp_frameskip: "0",
    ppsspp_frameskip_type: "Number of frames",
    ppsspp_fast_memory: "enabled",
    ppsspp_block_transfer_gpu: "enabled",
    ppsspp_texture_scaling_level: "5",
    ppsspp_texture_scaling_type: "xBRZ",
    ppsspp_texture_filtering: "auto",
    ppsspp_texture_deposterize: "enabled",
    ppsspp_gpu_hardware_transform: "enabled",
    ppsspp_vertex_cache: "enabled",
    ppsspp_vertex_range_inline: "enabled",
    ppsspp_lazy_texture_caching: "disabled",
    ppsspp_retain_changed_textures: "enabled",
    ppsspp_spline_quality: "high",
    ppsspp_software_skinning: "enabled",
    ppsspp_io_timing_method: "Fast",
    ppsspp_lower_resolution_for_effects: "0",
    ppsspp_inflight_frames: "2",
    ppsspp_rendering_mode: "OpenGL",
    ppsspp_cpu_core: "JIT",
    ppsspp_audio_latency: "0",
    ppsspp_audio_resampling: "enabled",
    ppsspp_locked_cpu_speed: "222",
    ppsspp_force_max_fps: "0",
    ppsspp_cheats: "enabled",
    ppsspp_skip_buffer_effects: "disabled",
    ppsspp_disable_slow_framebuf_effects: "disabled",
    ppsspp_gpu_anisotropic_filtering: "16x",
    ppsspp_texture_shader: "xBRZ",
    ppsspp_change_emulated_psp_cpu_clock: "333",
    ppsspp_separate_io_thread: "enabled",
    ppsspp_unsafe_func_replacements: "enabled",
    ppsspp_gpu_driver: "OpenGL",
  },
};

/**
 * parallel_n64 RetroArch core options per tier.
 *
 * Replaced mupen64plus_next with parallel_n64 as the default core to fix
 * booting issues with titles like Banjo-Kazooie.
 */
const N64_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    retroarch_core: "parallel_n64",
    "parallel-n64-gfxplugin": "glide64",
    "parallel-n64-rspplugin": "hle",
    "parallel-n64-screensize": "320x240",
    "parallel-n64-framerate": "fullspeed",
  },
  medium: {
    retroarch_core: "parallel_n64",
    "parallel-n64-gfxplugin": "glide64",
    "parallel-n64-rspplugin": "hle",
    "parallel-n64-screensize": "640x480",
    "parallel-n64-framerate": "fullspeed",
  },
  high: {
    retroarch_core: "parallel_n64",
    "parallel-n64-gfxplugin": "parallel",
    "parallel-n64-rspplugin": "parallel",
    "parallel-n64-parallel-rdp-upscaling": "2x",
  },
  ultra: {
    retroarch_core: "parallel_n64",
    "parallel-n64-gfxplugin": "parallel",
    "parallel-n64-rspplugin": "parallel",
    "parallel-n64-parallel-rdp-upscaling": "4x",
  },
};

const NDS_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    // EmulatorJS defaults to melonDS first; our tier tables target DeSmuME 2015.
    retroarch_core: "desmume2015",
    desmume_num_cores: "1",
    desmume_cpu_mode: "jit",
    desmume_frameskip: "2",
    desmume_internal_resolution: "256x192",
    desmume_advanced_timing: "disabled",
    desmume_opengl_mode: "disabled",
    desmume_color_depth: "16-bit",
    desmume_gfx_edgemark: "disabled",
    desmume_gfx_linehack: "enabled",
    desmume_gfx_txthack: "enabled",
    desmume_screens_gap: "0",
    desmume_firmware_language: "Auto",
    // Keep stylus/touchscreen input enabled even on low-end devices.
    desmume_pointer_type: "touch",
    desmume_motion_enabled: "disabled",
    desmume_gyro_enabled: "disabled",
    desmume_filtering: "none",
  },
  medium: {
    retroarch_core: "desmume2015",
    desmume_num_cores: "2",
    desmume_cpu_mode: "jit",
    desmume_frameskip: "1",
    desmume_internal_resolution: "256x192",
    desmume_advanced_timing: "disabled",
    desmume_opengl_mode: "disabled",
    desmume_color_depth: "16-bit",
    desmume_gfx_edgemark: "enabled",
    desmume_gfx_linehack: "enabled",
    desmume_gfx_txthack: "disabled",
    desmume_screens_gap: "0",
    desmume_firmware_language: "Auto",
    desmume_pointer_type: "touch",
  },
  high: {
    retroarch_core: "desmume2015",
    desmume_num_cores: "2",
    desmume_cpu_mode: "jit",
    desmume_frameskip: "0",
    desmume_internal_resolution: "512x384",
    desmume_advanced_timing: "enabled",
    desmume_opengl_mode: "enabled",
    desmume_color_depth: "32-bit",
    desmume_gfx_edgemark: "enabled",
    desmume_gfx_linehack: "disabled",
    desmume_gfx_txthack: "disabled",
    desmume_screens_gap: "0",
    desmume_firmware_language: "Auto",
    desmume_pointer_type: "touch",
    desmume_mic_mode: "internal",
  },
  ultra: {
    retroarch_core: "desmume2015",
    // DeSmuME doesn't benefit from >2 cores; setting 4 wastes threads
    desmume_num_cores: "2",
    desmume_cpu_mode: "jit",
    desmume_frameskip: "0",
    desmume_internal_resolution: "1024x768",
    desmume_advanced_timing: "enabled",
    desmume_opengl_mode: "enabled",
    desmume_color_depth: "32-bit",
    desmume_gfx_edgemark: "enabled",
    desmume_gfx_linehack: "disabled",
    desmume_gfx_txthack: "disabled",
    desmume_screens_gap: "0",
    desmume_firmware_language: "Auto",
    desmume_pointer_type: "touch",
    desmume_mic_mode: "internal",
    desmume_motion_enabled: "enabled",
    desmume_gyro_enabled: "enabled",
    desmume_filtering: "bilinear",
  },
};

// ── GBA (mGBA) tier-specific core options ─────────────────────────────────────

/**
 * mGBA RetroArch core options per performance tier.
 *
 * Key options:
 *   mgba_skip_bios         — Skip the GBA boot logo (always ON for speed)
 *   mgba_idle_optimization — Detect busy-wait loops and replace with halts
 *   mgba_audio_buffer_size — Audio output buffer in samples (512/1024/2048/4096).
 *                            Larger buffers prevent underruns on high-latency audio
 *                            hardware (Bluetooth/USB); smaller buffers reduce latency
 *                            on direct-wired audio.
 */
const GBA_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    retroarch_core: "mgba",
    mgba_skip_bios: "ON",
    mgba_idle_optimization: "Remove Known",
    mgba_solar_sensor_level: "0",
    mgba_allow_opposing_directions: "no",
    mgba_force_gbp: "OFF",
    // Larger buffer on low-spec hardware: more headroom to prevent audio
    // underruns when the CPU is already under pressure from frameskip recovery.
    mgba_audio_buffer_size: "2048",
  },
  medium: {
    retroarch_core: "mgba",
    mgba_skip_bios: "ON",
    mgba_idle_optimization: "Remove Known",
    mgba_solar_sensor_level: "0",
    mgba_allow_opposing_directions: "no",
    mgba_force_gbp: "OFF",
    mgba_audio_buffer_size: "1024",
  },
  high: {
    retroarch_core: "mgba",
    mgba_skip_bios: "ON",
    mgba_idle_optimization: "Remove Known",
    mgba_solar_sensor_level: "0",
    mgba_allow_opposing_directions: "no",
    mgba_force_gbp: "OFF",
    // 512-sample buffer for lowest latency on capable hardware
    mgba_audio_buffer_size: "512",
  },
  ultra: {
    retroarch_core: "mgba",
    mgba_skip_bios: "ON",
    mgba_idle_optimization: "Remove Known",
    mgba_solar_sensor_level: "0",
    mgba_allow_opposing_directions: "no",
    mgba_force_gbp: "OFF",
    mgba_audio_buffer_size: "512",
  },
};

// ── PS1 tier-specific core options ───────────────────────────────────────────
//
// Strategy:
//   low / medium  → pcsx_rearmed (EmulatorJS default; lightweight, high compat)
//   high / ultra  → mednafen_psx_hw (Beetle PSX HW with Vulkan, PGXP, upscaling)
//
// pcsx_rearmed key options:
//   pcsx_rearmed_drc               — Dynamic recompiler (big speed win)
//   pcsx_rearmed_frameskip         — 0 = off; raise only if GPU bound
//   pcsx_rearmed_spu_update_freq   — SPU update frequency (lower = faster)
//   pcsx_rearmed_show_bios_bootlogo — Skip the PS1 boot logo for speed
//
// mednafen_psx_hw (Beetle PSX HW) key options:
//   beetle_psx_hw_internal_resolution — GPU resolution multiplier (1x–16x)
//   beetle_psx_hw_frame_duping        — Repeat last frame when unchanged
//   beetle_psx_hw_filter              — Texture filter (nearest = fastest)
//   beetle_psx_hw_pgxp_mode          — Perspective-correct geometry
//   beetle_psx_hw_gte_overclock      — One-cycle GTE latency
/**
 * PS1 RetroArch core options per tier.
 *
 * low/medium: pcsx_rearmed (default, no retroarch_core override needed).
 * high/ultra: mednafen_psx_hw (Beetle PSX HW — Vulkan, PGXP, high-res).
 */
const PSX_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  // pcsx_rearmed is the EmulatorJS default — no retroarch_core override needed.
  // Only set performance-critical pcsx_rearmed_ options.
  low: {
    pcsx_rearmed_drc: "enabled",
    pcsx_rearmed_frameskip: "0",
    pcsx_rearmed_spu_update_freq: "50",
    pcsx_rearmed_show_bios_bootlogo: "disabled",
  },
  medium: {
    pcsx_rearmed_drc: "enabled",
    pcsx_rearmed_frameskip: "0",
    pcsx_rearmed_spu_update_freq: "100",
    pcsx_rearmed_show_bios_bootlogo: "disabled",
  },
  high: {
    retroarch_core: "mednafen_psx_hw",
    beetle_psx_hw_renderer: "hardware",
    beetle_psx_hw_internal_resolution: "2x",
    beetle_psx_hw_frame_duping: "disabled",
    beetle_psx_hw_filter: "bilinear",
    beetle_psx_hw_dither_mode: "internal resolution",
    beetle_psx_hw_depth: "32bpp",
    beetle_psx_hw_cd_access_method: "async",
    beetle_psx_hw_cpu_dynarec: "execute",
    beetle_psx_hw_dynarec_invalidate: "full",
    // Upstream labels: "memory only" / "memory + CPU (Buggy)"
    beetle_psx_hw_pgxp_mode: "memory only",
    beetle_psx_hw_pgxp_texture: "enabled",
    // Core docs recommend leaving vertex cache off — fewer false-positive glitches
    beetle_psx_hw_pgxp_vertex: "disabled",
    beetle_psx_hw_analog_calibration: "enabled",
    beetle_psx_hw_widescreen_hack: "disabled",
    beetle_psx_hw_renderer_software_fb: "enabled",
    beetle_psx_hw_gpu_overclock: "4x",
    beetle_psx_hw_cd_fastload: "6x",
    beetle_psx_hw_gte_overclock: "enabled",
    beetle_psx_hw_adaptive_smoothing: "enabled",
    beetle_psx_hw_super_sampling: "disabled",
    beetle_psx_hw_mdec_yuv: "enabled",
    beetle_psx_hw_msaa: "2x",
  },
  ultra: {
    retroarch_core: "mednafen_psx_hw",
    beetle_psx_hw_renderer: "hardware",
    beetle_psx_hw_internal_resolution: "4x",
    beetle_psx_hw_frame_duping: "disabled",
    beetle_psx_hw_filter: "bilinear",
    beetle_psx_hw_dither_mode: "disabled",
    beetle_psx_hw_depth: "32bpp",
    beetle_psx_hw_cd_access_method: "async",
    beetle_psx_hw_cpu_dynarec: "execute",
    beetle_psx_hw_dynarec_invalidate: "full",
    beetle_psx_hw_pgxp_mode: "memory + CPU (Buggy)",
    beetle_psx_hw_pgxp_texture: "enabled",
    beetle_psx_hw_pgxp_vertex: "disabled",
    beetle_psx_hw_analog_calibration: "enabled",
    beetle_psx_hw_widescreen_hack: "disabled",
    beetle_psx_hw_renderer_software_fb: "enabled",
    beetle_psx_hw_gpu_overclock: "8x",
    beetle_psx_hw_cd_fastload: "8x",
    beetle_psx_hw_gte_overclock: "enabled",
    beetle_psx_hw_adaptive_smoothing: "enabled",
    beetle_psx_hw_super_sampling: "enabled",
    beetle_psx_hw_mdec_yuv: "enabled",
    beetle_psx_hw_msaa: "4x",
    beetle_psx_hw_enable_gpu_prim_bufs: "enabled",
    beetle_psx_hw_spu_overclock: "200",
    beetle_psx_hw_show_video_resolution: "enabled",
    beetle_psx_hw_lightrec_timing: "performance",
    beetle_psx_hw_executes_on_mcu: "disabled",
    beetle_psx_hw_rcnt_mode: "fast",
    beetle_psx_hw_ignore_badreads: "enabled",
    beetle_psx_hw_itype2_timing: "fast",
  },
};

/**
 * Get the appropriate PPSSPP settings for a given performance tier.
 */
export function getPSPSettingsForTier(tier: PerformanceTier): Record<string, string> {
  return { ...PSP_TIER_SETTINGS[tier] };
}

/**
 * Get the appropriate DeSmuME (NDS) settings for a given performance tier.
 */
export function getNDSSettingsForTier(tier: PerformanceTier): Record<string, string> {
  return { ...NDS_TIER_SETTINGS[tier] };
}

/**
 * Get the appropriate mGBA settings for a given performance tier.
 */
export function getGBASettingsForTier(tier: PerformanceTier): Record<string, string> {
  return { ...GBA_TIER_SETTINGS[tier] };
}

/**
 * Get the appropriate Gambatte GB settings for a given performance tier.
 * Use this for original Game Boy (.gb) ROMs.
 */
export function getGBSettingsForTier(tier: PerformanceTier): Record<string, string> {
  return { ...GB_TIER_SETTINGS[tier] };
}

/**
 * Get the appropriate Gambatte GBC settings for a given performance tier.
 * Use this for native Game Boy Color (.gbc) ROMs.
 */
export function getGBCSettingsForTier(tier: PerformanceTier): Record<string, string> {
  return { ...GBC_TIER_SETTINGS[tier] };
}

/**
 * Get the appropriate Beetle PSX settings for a given performance tier.
 */
export function getPSXSettingsForTier(tier: PerformanceTier): Record<string, string> {
  return { ...PSX_TIER_SETTINGS[tier] };
}


// ── NES (FCEUmm) tier-specific core options ───────────────────────────────────
//
// EmulatorJS uses FCEUmm for NES. Key options:
//   fceumm_overscan           — crop the 8-px overscan borders
//   fceumm_palettes           — colour palette (default → NES Classic → Wavebeam → CXA2025AS)
//   fceumm_sndquality         — audio resampling quality (Low / High)
//   fceumm_no_sprite_limit    — remove 8 sprites/scanline HW limit (reduces flicker)
//   fceumm_use_official_overclocking — PPU overclock (reduces scanline flicker)

const NES_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    fceumm_overscan: "enabled",
    fceumm_palettes: "default",
    fceumm_sndquality: "Low",
    fceumm_no_sprite_limit: "disabled",
    fceumm_gamepad_p1: "gamepad",
    fceumm_gamepad_p2: "gamepad",
    fceumm_use_official_overclocking: "disabled",
  },
  medium: {
    fceumm_overscan: "enabled",
    fceumm_palettes: "nes-classic",
    fceumm_sndquality: "High",
    fceumm_no_sprite_limit: "disabled",
    fceumm_gamepad_p1: "gamepad",
    fceumm_gamepad_p2: "gamepad",
    fceumm_use_official_overclocking: "disabled",
  },
  high: {
    fceumm_overscan: "enabled",
    // Wavebeam palette is vibrant and well-suited for HD displays
    fceumm_palettes: "wavebeam",
    fceumm_sndquality: "High",
    // Removing the sprite limit reduces flickering in multi-sprite games (e.g. Battletoads)
    fceumm_no_sprite_limit: "enabled",
    fceumm_gamepad_p1: "gamepad",
    fceumm_gamepad_p2: "gamepad",
    fceumm_use_official_overclocking: "disabled",
  },
  ultra: {
    fceumm_overscan: "enabled",
    // Sony CXA2025AS is the most colour-accurate consumer CRT palette
    fceumm_palettes: "sony-cxa2025as",
    fceumm_sndquality: "High",
    fceumm_no_sprite_limit: "enabled",
    fceumm_gamepad_p1: "gamepad",
    fceumm_gamepad_p2: "gamepad",
    // PPU overclocking reduces scanline flicker at the cost of minor accuracy
    fceumm_use_official_overclocking: "enabled",
  },
};

// ── SNES (Snes9x) tier-specific core options ──────────────────────────────────
//
// EmulatorJS uses Snes9x for SNES. Key options:
//   snes9x_frameskip          — "auto" | "disabled"
//   snes9x_audio_interpolation — "none" | "gaussian" | "cubic" | "sinc"
//   snes9x_overclock_cycles   — "disabled" | "compatible" | "max"
//   snes9x_blargg_ntsc_filter — NTSC scanline emulation

const SNES_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    snes9x_frameskip: "auto",
    snes9x_frameskip_threshold: "33",
    // Gaussian is the reference SNES SPC700 audio algorithm — minimal CPU cost
    snes9x_audio_interpolation: "gaussian",
    snes9x_overclock_cycles: "disabled",
    snes9x_blargg_ntsc_filter: "disabled",
    snes9x_overscan: "enabled",
    snes9x_gfx_hires: "enabled",
    snes9x_gfx_transp: "enabled",
  },
  medium: {
    snes9x_frameskip: "auto",
    snes9x_frameskip_threshold: "33",
    snes9x_audio_interpolation: "gaussian",
    snes9x_overclock_cycles: "disabled",
    snes9x_blargg_ntsc_filter: "disabled",
    snes9x_overscan: "enabled",
    snes9x_gfx_hires: "enabled",
    snes9x_gfx_transp: "enabled",
  },
  high: {
    snes9x_frameskip: "disabled",
    // Sinc is the highest-quality audio resampler in Snes9x
    snes9x_audio_interpolation: "sinc",
    // "compatible" overclock helps SA-1/SuperFX titles without compatibility issues
    snes9x_overclock_cycles: "compatible",
    snes9x_blargg_ntsc_filter: "disabled",
    snes9x_overscan: "enabled",
    snes9x_gfx_hires: "enabled",
    snes9x_gfx_transp: "enabled",
  },
  ultra: {
    snes9x_frameskip: "disabled",
    snes9x_audio_interpolation: "sinc",
    // Max overclock: Star Fox / Yoshi's Island run remarkably smoother
    snes9x_overclock_cycles: "max",
    snes9x_blargg_ntsc_filter: "disabled",
    snes9x_overscan: "enabled",
    snes9x_gfx_hires: "enabled",
    snes9x_gfx_transp: "enabled",
  },
};

const SNES_BSNES_TIER_SETTINGS = fixedCoreTierSettings("bsnes");

// ── Game Boy (Gambatte) tier settings ─────────────────────────────────────────
//
// Gambatte is the precision GB/GBC core. Key options for the original Game Boy:
//   gambatte_gb_hwmode         — hardware to emulate: "GB" (DMG) or "GBC" (run GB
//                                games in GBC mode to unlock built-in GBC colorisation)
//   gambatte_gb_colorization   — GBC palette colorisation for monochrome GB titles
//                                ("disabled" | "internal" | "custom")
//   gambatte_gb_internal_palette — built-in DMG palette name (e.g. "GB - DMG")
//   gambatte_mix_frames        — LCD ghosting simulation ("disabled" | "mix")
//   gambatte_dark_filter_level — darkness filter 0–100 (mimics original screen bias)
//
// Low tier uses authentic "GB" hardware mode for maximum performance.
// Medium and above switch to "GBC" hardware mode so the core applies GBC's
// built-in palettes to monochrome GB titles, improving visual quality.

const GB_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    retroarch_core: "gambatte",
    // Emulate the original DMG hardware for authenticity and lowest CPU cost.
    gambatte_gb_hwmode: "GB",
    gambatte_gb_colorization: "disabled",
    gambatte_gb_internal_palette: "GB - DMG",
    gambatte_mix_frames: "disabled",
    gambatte_up_down_allowed: "disabled",
    gambatte_turbo_period: "4",
    gambatte_dark_filter_level: "0",
  },
  medium: {
    retroarch_core: "gambatte",
    // Run GB games in GBC mode to enable built-in GBC colour palettes.
    gambatte_gb_hwmode: "GBC",
    gambatte_gb_colorization: "internal",
    gambatte_gb_internal_palette: "GB - DMG",
    gambatte_mix_frames: "disabled",
    gambatte_up_down_allowed: "disabled",
    gambatte_turbo_period: "4",
    gambatte_dark_filter_level: "0",
  },
  high: {
    retroarch_core: "gambatte",
    gambatte_gb_hwmode: "GBC",
    gambatte_gb_colorization: "internal",
    gambatte_gb_internal_palette: "GB - DMG",
    // "mix" blending replicates the DMG LCD motion handling most faithfully
    gambatte_mix_frames: "mix",
    gambatte_up_down_allowed: "disabled",
    gambatte_turbo_period: "4",
    gambatte_dark_filter_level: "0",
  },
  ultra: {
    retroarch_core: "gambatte",
    gambatte_gb_hwmode: "GBC",
    gambatte_gb_colorization: "internal",
    gambatte_gb_internal_palette: "GB - DMG",
    gambatte_mix_frames: "mix",
    gambatte_up_down_allowed: "disabled",
    gambatte_turbo_period: "4",
    // 10% darkness mimics the slight greenish bias of original DMG screens
    gambatte_dark_filter_level: "10",
  },
};

// ── Game Boy Color (Gambatte) tier settings ───────────────────────────────────
//
// Native GBC games (.gbc) are already full-colour — the colorisation and
// internal-palette keys are therefore omitted here (they only affect monochrome
// GB titles running in GBC compatibility mode).
//
//   gambatte_gb_hwmode  — always "GBC" for native Game Boy Color hardware
//   gambatte_mix_frames — GBC LCD also exhibits inter-frame ghosting; "mix"
//                         replicates it on capable devices
//   gambatte_dark_filter_level — slight colour bias present on GBC screens

const GBC_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    retroarch_core: "gambatte",
    gambatte_gb_hwmode: "GBC",
    gambatte_mix_frames: "disabled",
    gambatte_up_down_allowed: "disabled",
    gambatte_turbo_period: "4",
    gambatte_dark_filter_level: "0",
  },
  medium: {
    retroarch_core: "gambatte",
    gambatte_gb_hwmode: "GBC",
    gambatte_mix_frames: "disabled",
    gambatte_up_down_allowed: "disabled",
    gambatte_turbo_period: "4",
    gambatte_dark_filter_level: "0",
  },
  high: {
    retroarch_core: "gambatte",
    gambatte_gb_hwmode: "GBC",
    // GBC LCD ghosting is subtler than DMG but still present on capable hardware
    gambatte_mix_frames: "mix",
    gambatte_up_down_allowed: "disabled",
    gambatte_turbo_period: "4",
    gambatte_dark_filter_level: "0",
  },
  ultra: {
    retroarch_core: "gambatte",
    gambatte_gb_hwmode: "GBC",
    gambatte_mix_frames: "mix",
    gambatte_up_down_allowed: "disabled",
    gambatte_turbo_period: "4",
    // Slight colour bias on the original GBC screen
    gambatte_dark_filter_level: "10",
  },
};

// ── Atari 2600 (Stella) tier settings ─────────────────────────────────────────
//
// Stella's main visual quality options are TV signal filter type and phosphor glow.

const ATARI2600_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    stella_filter: "none",
    stella_palette: "standard",
    stella_phosphor: "byrom",
    stella_phosphor_blend: "40",
    stella_crop_hoverscan: "enabled",
  },
  medium: {
    stella_filter: "none",
    stella_palette: "z26",
    stella_phosphor: "byrom",
    stella_phosphor_blend: "50",
    stella_crop_hoverscan: "enabled",
  },
  high: {
    // "composite" adds gentle RF-style bloom to the image
    stella_filter: "composite",
    stella_palette: "z26",
    stella_phosphor: "byrom",
    stella_phosphor_blend: "60",
    stella_crop_hoverscan: "enabled",
  },
  ultra: {
    // "svideo" gives the warmest CRT look without the harshness of RF noise
    stella_filter: "svideo",
    stella_palette: "standard",
    stella_phosphor: "byrom",
    stella_phosphor_blend: "70",
    stella_crop_hoverscan: "enabled",
  },
};

// ── Sega Saturn (Yabause) tier settings ───────────────────────────────────────
//
// EmulatorJS maps `segaSaturn` → Yabause (not Beetle Saturn). Options follow
// libretro yabause_core_options (frameskip, HLE BIOS, expansion RAM, multitap, threads).

// Additional lightweight 2D cores expose fewer renderer knobs than the main
// console profiles. These tables keep tier intent explicit and avoid empty
// launch settings for supported systems.
const ARCADE_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    retroarch_core: "fbneo",
  },
  medium: {
    retroarch_core: "fbneo",
  },
  high: {
    retroarch_core: "fbneo",
  },
  ultra: {
    retroarch_core: "fbneo",
  },
};

const MAME2003_PLUS_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    retroarch_core: "mame2003_plus",
    "mame2003-plus_frameskip": "1",
    "mame2003-plus_sample_rate": "22050",
    "mame2003-plus_skip_disclaimer": "enabled",
    "mame2003-plus_skip_warnings": "disabled",
    "mame2003-plus_display_setup": "disabled",
    "mame2003-plus_input_interface": "retropad",
    "mame2003-plus_mouse_device": "pointer",
    "mame2003-plus_display_artwork": "disabled",
    "mame2003-plus_art_resolution": "1",
    "mame2003-plus_vector_resolution": "640x480",
    "mame2003-plus_vector_antialias": "disabled",
    "mame2003-plus_dcs_speedhack": "enabled",
  },
  medium: {
    retroarch_core: "mame2003_plus",
    "mame2003-plus_frameskip": "0",
    "mame2003-plus_sample_rate": "30000",
    "mame2003-plus_skip_disclaimer": "enabled",
    "mame2003-plus_skip_warnings": "disabled",
    "mame2003-plus_display_setup": "disabled",
    "mame2003-plus_input_interface": "retropad",
    "mame2003-plus_mouse_device": "pointer",
    "mame2003-plus_display_artwork": "disabled",
    "mame2003-plus_art_resolution": "1",
    "mame2003-plus_vector_resolution": "640x480",
    "mame2003-plus_vector_antialias": "disabled",
    "mame2003-plus_dcs_speedhack": "enabled",
  },
  high: {
    retroarch_core: "mame2003_plus",
    "mame2003-plus_frameskip": "0",
    "mame2003-plus_sample_rate": "44100",
    "mame2003-plus_skip_disclaimer": "enabled",
    "mame2003-plus_skip_warnings": "disabled",
    "mame2003-plus_display_setup": "disabled",
    "mame2003-plus_input_interface": "retropad",
    "mame2003-plus_mouse_device": "pointer",
    "mame2003-plus_display_artwork": "enabled",
    "mame2003-plus_art_resolution": "1",
    "mame2003-plus_vector_resolution": "1024x768",
    "mame2003-plus_vector_antialias": "enabled",
    "mame2003-plus_dcs_speedhack": "enabled",
  },
  ultra: {
    retroarch_core: "mame2003_plus",
    "mame2003-plus_frameskip": "0",
    "mame2003-plus_sample_rate": "48000",
    "mame2003-plus_skip_disclaimer": "enabled",
    "mame2003-plus_skip_warnings": "disabled",
    "mame2003-plus_display_setup": "disabled",
    "mame2003-plus_input_interface": "retropad",
    "mame2003-plus_mouse_device": "pointer",
    "mame2003-plus_display_artwork": "enabled",
    "mame2003-plus_art_resolution": "2",
    "mame2003-plus_vector_resolution": "1280x960",
    "mame2003-plus_vector_antialias": "enabled",
    "mame2003-plus_dcs_speedhack": "enabled",
  },
};

const ATARI7800_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low:    { retroarch_core: "prosystem" },
  medium: { retroarch_core: "prosystem" },
  high:   { retroarch_core: "prosystem" },
  ultra:  { retroarch_core: "prosystem" },
};

const LYNX_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low:    { retroarch_core: "handy", handy_rot: "None" },
  medium: { retroarch_core: "handy", handy_rot: "None" },
  high:   { retroarch_core: "handy", handy_rot: "None" },
  ultra:  { retroarch_core: "handy", handy_rot: "None" },
};

const NGP_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low:    { retroarch_core: "mednafen_ngp", ngp_language: "english" },
  medium: { retroarch_core: "mednafen_ngp", ngp_language: "english" },
  high:   { retroarch_core: "mednafen_ngp", ngp_language: "english" },
  ultra:  { retroarch_core: "mednafen_ngp", ngp_language: "english" },
};

const SATURN_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    retroarch_core: "yabause",
    yabause_frameskip: "enabled",
    yabause_force_hle_bios: "disabled",
    yabause_addon_cartridge: "none",
    yabause_multitap_port1: "disabled",
    yabause_multitap_port2: "disabled",
    yabause_numthreads: "1",
  },
  medium: {
    retroarch_core: "yabause",
    yabause_frameskip: "disabled",
    yabause_force_hle_bios: "disabled",
    yabause_addon_cartridge: "none",
    yabause_multitap_port1: "disabled",
    yabause_multitap_port2: "disabled",
    yabause_numthreads: "2",
  },
  high: {
    retroarch_core: "yabause",
    yabause_frameskip: "disabled",
    yabause_force_hle_bios: "disabled",
    yabause_addon_cartridge: "1M_ram",
    yabause_multitap_port1: "disabled",
    yabause_multitap_port2: "disabled",
    yabause_numthreads: "4",
  },
  ultra: {
    retroarch_core: "yabause",
    yabause_frameskip: "disabled",
    yabause_force_hle_bios: "disabled",
    yabause_addon_cartridge: "4M_ram",
    yabause_multitap_port1: "disabled",
    yabause_multitap_port2: "disabled",
    yabause_numthreads: "8",
  },
};

// ── Sega Genesis / Mega Drive (genesis_plus_gx) tier settings ───────────────────

const GENESIS_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    retroarch_core: "genesis_plus_gx",
    genesis_plus_gx_volume: "80",
    genesis_plus_gx_analog_mode: "disabled",
    genesis_plus_gx_hq_fm: "disabled",
    genesis_plus_gx_pcm_volume: "80",
    genesis_plus_gx_sms_palette: "sms_ntsc",
    genesis_plus_gx_gb_palette: "gb_ntsc",
    genesis_plus_gx_cpu_overclock: "none",
    genesis_plus_gx_sound_output: "mono",
    genesis_plus_gx_no_sprite_limit: "disabled",
    genesis_plus_gx_ym2612_improved: "disabled",
    genesis_plus_gx_blargg_ntsc_filter: "disabled",
    genesis_plus_gx_lcd_filter: "disabled",
    genesis_plus_gx_frame_skip: "2",
    genesis_plus_gx_television_mode: "ntsc",
    genesis_plus_gx_cartridge_slot: "none",
    genesis_plus_gx_extern_cpu: "disabled",
  },
  medium: {
    retroarch_core: "genesis_plus_gx",
    genesis_plus_gx_volume: "90",
    genesis_plus_gx_analog_mode: "disabled",
    genesis_plus_gx_hq_fm: "enabled",
    genesis_plus_gx_pcm_volume: "90",
    genesis_plus_gx_sms_palette: "sms_ntsc",
    genesis_plus_gx_gb_palette: "gb_ntsc",
    genesis_plus_gx_cpu_overclock: "none",
    genesis_plus_gx_sound_output: "stereo",
    genesis_plus_gx_no_sprite_limit: "disabled",
    genesis_plus_gx_ym2612_improved: "disabled",
    genesis_plus_gx_blargg_ntsc_filter: "disabled",
    genesis_plus_gx_lcd_filter: "disabled",
    genesis_plus_gx_frame_skip: "1",
    genesis_plus_gx_television_mode: "ntsc",
    genesis_plus_gx_cartridge_slot: "none",
    genesis_plus_gx_extern_cpu: "disabled",
  },
  high: {
    retroarch_core: "genesis_plus_gx",
    genesis_plus_gx_volume: "100",
    genesis_plus_gx_analog_mode: "dual_analog",
    genesis_plus_gx_hq_fm: "enabled",
    genesis_plus_gx_pcm_volume: "100",
    genesis_plus_gx_sms_palette: "sms_ntsc",
    genesis_plus_gx_gb_palette: "gb_ntsc",
    genesis_plus_gx_cpu_overclock: "2x",
    genesis_plus_gx_sound_output: "stereo",
    genesis_plus_gx_no_sprite_limit: "enabled",
    genesis_plus_gx_ym2612_improved: "enabled",
    genesis_plus_gx_blargg_ntsc_filter: "enabled",
    genesis_plus_gx_lcd_filter: "disabled",
    genesis_plus_gx_frame_skip: "0",
    genesis_plus_gx_television_mode: "ntsc",
    genesis_plus_gx_cartridge_slot: "none",
    genesis_plus_gx_extern_cpu: "enabled",
  },
  ultra: {
    retroarch_core: "genesis_plus_gx",
    genesis_plus_gx_volume: "100",
    genesis_plus_gx_analog_mode: "dual_analog",
    genesis_plus_gx_hq_fm: "enabled",
    genesis_plus_gx_pcm_volume: "100",
    genesis_plus_gx_sms_palette: "sms_ntsc",
    genesis_plus_gx_gb_palette: "gb_ntsc",
    genesis_plus_gx_cpu_overclock: "4x",
    genesis_plus_gx_sound_output: "stereo",
    genesis_plus_gx_no_sprite_limit: "enabled",
    genesis_plus_gx_ym2612_improved: "enabled",
    genesis_plus_gx_blargg_ntsc_filter: "enabled",
    genesis_plus_gx_lcd_filter: "enabled",
    genesis_plus_gx_frame_skip: "0",
    genesis_plus_gx_television_mode: "ntsc",
    genesis_plus_gx_cartridge_slot: "mcd",
    genesis_plus_gx_extern_cpu: "enabled",
  },
};

// ── Dreamcast (Flycast / reicast) tier settings ───────────────────────────────

const GENESIS_WIDE_TIER_SETTINGS = overrideRetroarchCore(GENESIS_TIER_SETTINGS, "genesis_plus_gx_wide");

const SEGA_CD_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    ...GENESIS_TIER_SETTINGS.low,
    genesis_plus_gx_cartridge_slot: "mcd",
    genesis_plus_gx_cdda_volume: "80",
    genesis_plus_gx_pcm_volume: "80",
  },
  medium: {
    ...GENESIS_TIER_SETTINGS.medium,
    genesis_plus_gx_cartridge_slot: "mcd",
    genesis_plus_gx_cdda_volume: "90",
    genesis_plus_gx_pcm_volume: "90",
  },
  high: {
    ...GENESIS_TIER_SETTINGS.high,
    genesis_plus_gx_cartridge_slot: "mcd",
    genesis_plus_gx_cdda_volume: "100",
    genesis_plus_gx_pcm_volume: "100",
  },
  ultra: {
    ...GENESIS_TIER_SETTINGS.ultra,
    genesis_plus_gx_cartridge_slot: "mcd",
    genesis_plus_gx_cdda_volume: "100",
    genesis_plus_gx_pcm_volume: "100",
  },
};

const SEGA_32X_TIER_SETTINGS = fixedCoreTierSettings("picodrive");

const INTELLIVISION_TIER_SETTINGS = fixedCoreTierSettings("freeintv");

const N3DS_TIER_SETTINGS = fixedCoreTierSettings("azahar");

const DOS_TIER_SETTINGS = fixedCoreTierSettings("dosbox_pure");

const DREAMCAST_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    flycast_cable_type:            "VGA",
    flycast_volume_modifier_enable:"enabled",
    flycast_boot_to_bios:          "disabled",
    flycast_hle_bios:              "disabled",
    flycast_threaded_rendering:    "disabled",
    flycast_synchronous_rendering: "disabled",
    flycast_internal_resolution:   "640x480",
    flycast_mipmapping:            "disabled",
    flycast_anisotropic_filtering: "1",
    flycast_texupscale:            "disabled",
    flycast_enable_rttb:           "disabled",
    flycast_enable_purupuru:       "disabled",
    flycast_dsp:                   "disabled",
    flycast_alpha_sorting:         "per-strip (fast, least accurate)",
    flycast_delay_frame_swapping:  "enabled",
    flycast_frame_skipping:        "enabled",
    flycast_framerate:             "normal",
    flycast_widescreen_cheats:     "disabled",
    flycast_widescreen_hack:       "disabled",
  },
  medium: {
    flycast_cable_type:            "VGA",
    flycast_volume_modifier_enable:"enabled",
    flycast_boot_to_bios:          "disabled",
    flycast_hle_bios:              "disabled",
    flycast_threaded_rendering:    "enabled",
    flycast_synchronous_rendering: "disabled",
    flycast_internal_resolution:   "640x480",
    flycast_mipmapping:            "enabled",
    flycast_anisotropic_filtering: "2",
    flycast_texupscale:            "disabled",
    flycast_enable_rttb:           "disabled",
    flycast_enable_purupuru:       "enabled",
    flycast_dsp:                   "enabled",
    flycast_alpha_sorting:         "per-strip (fast, least accurate)",
    flycast_delay_frame_swapping:  "disabled",
    flycast_frame_skipping:        "disabled",
    flycast_framerate:             "normal",
    flycast_widescreen_cheats:     "disabled",
    flycast_widescreen_hack:       "disabled",
  },
  high: {
    flycast_cable_type:            "VGA",
    flycast_volume_modifier_enable:"enabled",
    flycast_boot_to_bios:          "disabled",
    flycast_hle_bios:              "disabled",
    flycast_threaded_rendering:    "enabled",
    flycast_synchronous_rendering: "disabled",
    flycast_internal_resolution:   "1280x960",
    flycast_mipmapping:            "enabled",
    flycast_anisotropic_filtering: "4",
    flycast_texupscale:            "disabled",
    flycast_enable_rttb:           "enabled",
    flycast_enable_purupuru:       "enabled",
    flycast_dsp:                   "enabled",
    flycast_alpha_sorting:         "per-triangle (normal)",
    flycast_delay_frame_swapping:  "disabled",
    flycast_frame_skipping:        "disabled",
    flycast_framerate:             "normal",
    flycast_widescreen_cheats:     "disabled",
    flycast_widescreen_hack:       "disabled",
  },
  ultra: {
    flycast_cable_type:            "VGA",
    flycast_volume_modifier_enable:"enabled",
    flycast_boot_to_bios:          "disabled",
    flycast_hle_bios:              "disabled",
    flycast_threaded_rendering:    "enabled",
    flycast_synchronous_rendering: "disabled",
    flycast_internal_resolution:   "1920x1440",
    flycast_mipmapping:            "enabled",
    flycast_anisotropic_filtering: "8",
    flycast_texupscale:            "2x",
    flycast_enable_rttb:           "enabled",
    flycast_enable_purupuru:       "enabled",
    flycast_dsp:                   "enabled",
    flycast_alpha_sorting:         "per-triangle (normal)",
    flycast_delay_frame_swapping:  "disabled",
    flycast_frame_skipping:        "disabled",
    flycast_framerate:             "normal",
    flycast_widescreen_cheats:     "disabled",
    flycast_widescreen_hack:       "disabled",
  },
};

// ── Supported systems ─────────────────────────────────────────────────────────

export const SYSTEMS: SystemInfo[] = [
  {
    id: "psp",
    name: "PlayStation Portable",
    shortName: "PSP",
    extensions: ["iso", "cso", "elf", "pbp"],
    color: "#0070cc",
    needsThreads: true,
    needsWebGL2: true,
    is3D: true,
    hasAchievements: true,
    screenscraperId: 61,
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
    hasAchievements: true,
    screenscraperId: 1,
    qualitySettings: NES_TIER_SETTINGS.high,
    perfSettings: NES_TIER_SETTINGS.low,
    tierSettings: NES_TIER_SETTINGS,
  },
  {
    id: "snes",
    name: "Super Nintendo",
    shortName: "SNES",
    extensions: ["snes", "smc", "sfc", "fig", "bs"],
    color: "#7b3fae",
    needsThreads: false,
    needsWebGL2: false,
    hasAchievements: true,
    screenscraperId: 4,
    qualitySettings: SNES_TIER_SETTINGS.high,
    perfSettings: SNES_TIER_SETTINGS.low,
    tierSettings: SNES_TIER_SETTINGS,
  },
  {
    id: "snesBsnes",
    coreId: "snes",
    name: "Super Nintendo (bsnes)",
    shortName: "SNES bsnes",
    experimental: true,
    stabilityNotice: "Uses the EmulatorJS 4.3-pre bsnes core. Prefer the standard SNES profile unless you specifically want bsnes accuracy testing.",
    extensions: ["snes", "smc", "sfc", "fig", "bs"],
    color: "#6e49b7",
    needsThreads: false,
    needsWebGL2: false,
    hasAchievements: true,
    screenscraperId: 4,
    qualitySettings: SNES_BSNES_TIER_SETTINGS.high,
    perfSettings: SNES_BSNES_TIER_SETTINGS.low,
    tierSettings: SNES_BSNES_TIER_SETTINGS,
  },
  {
    id: "gba",
    name: "Game Boy Advance",
    shortName: "GBA",
    extensions: ["gba"],
    color: "#7c4dff",
    needsThreads: false,
    needsWebGL2: false,
    hasAchievements: true,
    screenscraperId: 12,
    qualitySettings: GBA_TIER_SETTINGS.high,
    perfSettings: GBA_TIER_SETTINGS.low,
    tierSettings: GBA_TIER_SETTINGS,
  },
  {
    id: "gbc",
    name: "Game Boy Color",
    shortName: "GBC",
    extensions: ["gbc"],
    color: "#e87d2a",
    needsThreads: false,
    needsWebGL2: false,
    hasAchievements: true,
    screenscraperId: 10,
    qualitySettings: GBC_TIER_SETTINGS.high,
    perfSettings: GBC_TIER_SETTINGS.low,
    tierSettings: GBC_TIER_SETTINGS,
  },
  {
    id: "gb",
    name: "Game Boy",
    shortName: "GB",
    extensions: ["gb"],
    color: "#7a9e27",
    needsThreads: false,
    needsWebGL2: false,
    hasAchievements: true,
    screenscraperId: 9,
    qualitySettings: GB_TIER_SETTINGS.high,
    perfSettings: GB_TIER_SETTINGS.low,
    tierSettings: GB_TIER_SETTINGS,
  },
  {
    id: "nds",
    name: "Nintendo DS",
    shortName: "DS",
    extensions: ["nds"],
    color: "#4b5d7a",
    needsThreads: false,
    needsWebGL2: false,
    is3D: true,
    touchControlMode: "builtin",
    screenscraperId: 28,
    qualitySettings: NDS_TIER_SETTINGS.high,
    perfSettings: NDS_TIER_SETTINGS.low,
    tierSettings: NDS_TIER_SETTINGS,
  },
  {
    id: "3ds",
    name: "Nintendo 3DS",
    shortName: "3DS",
    experimental: true,
    stabilityNotice: "Experimental: 3DS support uses the new EmulatorJS 4.3-pre Azahar core and requires threaded WebGL 2 support.",
    extensions: ["3ds", "cci", "cxi", "app"],
    color: "#c62828",
    needsThreads: true,
    needsWebGL2: true,
    is3D: true,
    touchControlMode: "builtin",
    qualitySettings: N3DS_TIER_SETTINGS.high,
    perfSettings: N3DS_TIER_SETTINGS.low,
    tierSettings: N3DS_TIER_SETTINGS,
  },
  {
    id: "n64",
    name: "Nintendo 64",
    shortName: "N64",
    extensions: ["64", "n64", "v64", "z64"],
    color: "#1a7a1a",
    needsThreads: false,
    needsWebGL2: false,
    is3D: true,
    hasAchievements: true,
    qualitySettings: N64_TIER_SETTINGS.high,
    perfSettings: N64_TIER_SETTINGS.low,
    tierSettings: N64_TIER_SETTINGS,
  },
  {
    id: "psx",
    name: "PlayStation 1",
    shortName: "PS1",
    extensions: ["bin", "pbp", "chd", "cue", "img", "mdf", "ccd", "m3u", "iso"],
    color: "#003087",
    needsThreads: false,
    needsWebGL2: false,
    is3D: true,
    hasAchievements: true,
    qualitySettings: PSX_TIER_SETTINGS.high,
    perfSettings: PSX_TIER_SETTINGS.low,
    tierSettings: PSX_TIER_SETTINGS,
  },
  {
    id: "segaMD",
    name: "Sega Genesis / Mega Drive",
    shortName: "Genesis",
    extensions: ["md", "smd", "gen"],
    color: "#1a1ae6",
    needsThreads: false,
    needsWebGL2: false,
    hasAchievements: true,
    qualitySettings: GENESIS_TIER_SETTINGS.high,
    perfSettings: GENESIS_TIER_SETTINGS.low,
    tierSettings: GENESIS_TIER_SETTINGS,
  },
  {
    id: "segaMDWide",
    coreId: "segaMD",
    name: "Sega Genesis / Mega Drive (Wide)",
    shortName: "Genesis Wide",
    experimental: true,
    stabilityNotice: "Uses the EmulatorJS 4.3-pre Genesis Plus GX Wide core for widescreen-compatible games.",
    extensions: ["md", "smd", "gen"],
    color: "#263bdc",
    needsThreads: false,
    needsWebGL2: false,
    hasAchievements: true,
    qualitySettings: GENESIS_WIDE_TIER_SETTINGS.high,
    perfSettings: GENESIS_WIDE_TIER_SETTINGS.low,
    tierSettings: GENESIS_WIDE_TIER_SETTINGS,
  },
  {
    id: "segaCD",
    name: "Sega CD / Mega-CD",
    shortName: "Sega CD",
    extensions: ["cue", "chd", "iso", "bin", "m3u"],
    color: "#0f4fa8",
    needsThreads: false,
    needsWebGL2: false,
    needsBios: true,
    hasAchievements: true,
    qualitySettings: SEGA_CD_TIER_SETTINGS.high,
    perfSettings: SEGA_CD_TIER_SETTINGS.low,
    tierSettings: SEGA_CD_TIER_SETTINGS,
  },
  {
    id: "sega32x",
    name: "Sega 32X",
    shortName: "32X",
    extensions: ["32x", "68k"],
    color: "#31343a",
    needsThreads: false,
    needsWebGL2: false,
    hasAchievements: true,
    qualitySettings: SEGA_32X_TIER_SETTINGS.high,
    perfSettings: SEGA_32X_TIER_SETTINGS.low,
    tierSettings: SEGA_32X_TIER_SETTINGS,
  },
  {
    id: "segaGG",
    name: "Game Gear",
    shortName: "GG",
    extensions: ["gg"],
    color: "#e64a1a",
    needsThreads: false,
    needsWebGL2: false,
    hasAchievements: true,
    qualitySettings: GENESIS_TIER_SETTINGS.high,
    perfSettings: GENESIS_TIER_SETTINGS.low,
    tierSettings: GENESIS_TIER_SETTINGS,
  },
  {
    id: "segaMS",
    name: "Sega Master System",
    shortName: "SMS",
    extensions: ["sms"],
    color: "#2255cc",
    needsThreads: false,
    needsWebGL2: false,
    hasAchievements: true,
    qualitySettings: GENESIS_TIER_SETTINGS.high,
    perfSettings: GENESIS_TIER_SETTINGS.low,
    tierSettings: GENESIS_TIER_SETTINGS,
  },
  {
    id: "atari2600",
    name: "Atari 2600",
    shortName: "2600",
    extensions: ["a26"],
    color: "#c0392b",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: ATARI2600_TIER_SETTINGS.high,
    perfSettings: ATARI2600_TIER_SETTINGS.low,
    tierSettings: ATARI2600_TIER_SETTINGS,
  },
  {
    id: "intv",
    name: "Intellivision",
    shortName: "INTV",
    extensions: ["int", "itv", "rom"],
    color: "#7b4a22",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: INTELLIVISION_TIER_SETTINGS.high,
    perfSettings: INTELLIVISION_TIER_SETTINGS.low,
    tierSettings: INTELLIVISION_TIER_SETTINGS,
  },
  {
    id: "dos",
    name: "MS-DOS (DOSBox Pure)",
    shortName: "DOS",
    experimental: true,
    stabilityNotice: "Experimental: DOS support uses EmulatorJS 4.3-pre DOSBox Pure with generated BOOTUP.BAT startup support.",
    extensions: ["zip", "dosz", "exe", "com", "bat", "conf"],
    color: "#2f6f55",
    needsThreads: true,
    needsWebGL2: false,
    qualitySettings: DOS_TIER_SETTINGS.high,
    perfSettings: DOS_TIER_SETTINGS.low,
    tierSettings: DOS_TIER_SETTINGS,
  },
  {
    id: "arcade",
    name: "Arcade (FBNeo)",
    shortName: "Arcade",
    extensions: ["zip"],
    color: "#e67e22",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: ARCADE_TIER_SETTINGS.high,
    perfSettings: ARCADE_TIER_SETTINGS.low,
    tierSettings: ARCADE_TIER_SETTINGS,
  },

  // ── Phase 3 additions ──────────────────────────────────────────────────────

  {
    id: "segaSaturn",
    name: "Sega Saturn",
    shortName: "Saturn",
    extensions: ["cue", "chd", "mdf", "img", "ccd", "m3u"],
    color: "#6b4c9a",
    needsThreads: false,
    needsWebGL2: false,
    needsBios: true,
    is3D: true,
    qualitySettings: SATURN_TIER_SETTINGS.high,
    perfSettings: SATURN_TIER_SETTINGS.low,
    tierSettings: SATURN_TIER_SETTINGS,
  },
  {
    id: "segaDC",
    coreId: "flycast",
    corePath: "https://github.com/nasomers/flycast-wasm/releases/download/v1.0.0/flycast-wasm.data",
    name: "Dreamcast",
    shortName: "DC",
    experimental: true,
    stabilityNotice: "Experimental: Dreamcast support is still being stabilized. Performance varies by hardware — use Performance mode on low-end devices. Some games may boot slowly, glitch, or crash.",
    extensions: ["cdi", "gdi", "chd", "m3u", "iso", "cue", "bin", "elf"],
    color: "#e07b20",
    needsThreads: false,
    needsWebGL2: true,
    needsBios: true,
    is3D: true,
    qualitySettings: DREAMCAST_TIER_SETTINGS.high,
    perfSettings: DREAMCAST_TIER_SETTINGS.low,
    tierSettings: DREAMCAST_TIER_SETTINGS,
  },
  {
    id: "mame2003",
    name: "Arcade (MAME 2003+)",
    shortName: "MAME+",
    extensions: ["zip", "7z"],
    color: "#8b1a1a",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: MAME2003_PLUS_TIER_SETTINGS.high,
    perfSettings: MAME2003_PLUS_TIER_SETTINGS.low,
    tierSettings: MAME2003_PLUS_TIER_SETTINGS,
  },
  {
    id: "atari7800",
    name: "Atari 7800",
    shortName: "7800",
    extensions: ["a78", "bin"],
    color: "#8b6000",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: ATARI7800_TIER_SETTINGS.high,
    perfSettings: ATARI7800_TIER_SETTINGS.low,
    tierSettings: ATARI7800_TIER_SETTINGS,
  },
  {
    id: "lynx",
    name: "Atari Lynx",
    shortName: "Lynx",
    extensions: ["lnx", "lyx"],
    color: "#2a8b6e",
    needsThreads: false,
    needsWebGL2: false,
    needsBios: false,
    qualitySettings: LYNX_TIER_SETTINGS.high,
    perfSettings: LYNX_TIER_SETTINGS.low,
    tierSettings: LYNX_TIER_SETTINGS,
  },
  {
    id: "ngp",
    name: "Neo Geo Pocket",
    shortName: "NGP",
    extensions: ["ngp", "ngc", "ngpc"],
    color: "#cc2222",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: NGP_TIER_SETTINGS.high,
    perfSettings: NGP_TIER_SETTINGS.low,
    tierSettings: NGP_TIER_SETTINGS,
  },
];

// ── Lookup tables ─────────────────────────────────────────────────────────────

/** System id → SystemInfo for O(1) lookup. */
const SYSTEM_BY_ID: Map<string, SystemInfo> = new Map();

/** Extension → single unambiguous system. */
const UNIQUE_EXT: Map<string, SystemInfo> = new Map();
/** Extension → multiple candidate systems (ambiguous). */
const AMBIGUOUS_EXT: Map<string, SystemInfo[]> = new Map();

const WEBRETRO_CORE_TO_SYSTEM_ID: Record<string, string> = {
  desmume: "nds",
  desmume2015: "nds",
  fbneo: "arcade",
  fceumm: "nes",
  flycast: "segaDC",
  freeintv: "intv",
  gambatte: "gbc",
  genesis_plus_gx: "segaMD",
  picodrive: "sega32x",
  handy: "lynx",
  mame2003_plus: "mame2003",
  mednafen_ngp: "ngp",
  mednafen_psx: "psx",
  mednafen_psx_hw: "psx",
  melonds: "nds",
  mgba: "gba",
  // mupen64plus_next is kept as a backward-compatibility alias so that games
  // previously stored with the old default core still resolve to the n64 system.
  mupen64plus_next: "n64",
  nestopia: "nes",
  parallel_n64: "n64",
  pcsx_rearmed: "psx",
  ppsspp: "psp",
  prosystem: "atari7800",
  snes9x: "snes",
  stella2014: "atari2600",
  yabause: "segaSaturn",
};

function preferredCandidateForSharedCore(systems: SystemInfo[]): SystemInfo | null {
  const coreIds = new Set(systems.map(sys => sys.coreId ?? sys.id));
  if (coreIds.size !== 1) return null;

  const canonical = systems.find(sys => !sys.experimental && !sys.coreId);
  return canonical ?? systems.find(sys => !sys.experimental) ?? null;
}

(function buildMaps() {
  const extToSystems = new Map<string, SystemInfo[]>();
  for (const sys of SYSTEMS) {
    SYSTEM_BY_ID.set(sys.id, sys);
    for (const ext of sys.extensions) {
      if (!extToSystems.has(ext)) extToSystems.set(ext, []);
      extToSystems.get(ext)!.push(sys);
    }
  }
  for (const [ext, systems] of extToSystems) {
    if (systems.length === 1) UNIQUE_EXT.set(ext, systems[0]!);
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
  const dotIdx = fileName.lastIndexOf(".");
  const ext = (dotIdx > 0 && dotIdx < fileName.length - 1)
    ? fileName.substring(dotIdx + 1).toLowerCase()
    : "";
  if (!ext) return null;
  if (UNIQUE_EXT.has(ext))    return UNIQUE_EXT.get(ext)!;
  if (AMBIGUOUS_EXT.has(ext)) {
    const systems = AMBIGUOUS_EXT.get(ext)!;
    return preferredCandidateForSharedCore(systems) ?? systems;
  }
  return null;
}

/** Look up a system by its EJS core identifier (O(1) via Map). */
export function getSystemById(id: string): SystemInfo | undefined {
  return SYSTEM_BY_ID.get(id);
}

export function getSystemByCoreHint(coreHint: string | null | undefined): SystemInfo | undefined {
  if (!coreHint) return undefined;
  const normalized = coreHint.trim().toLowerCase().replace(/-/g, "_");
  if (!normalized || normalized === "autodetect") return undefined;
  return SYSTEM_BY_ID.get(WEBRETRO_CORE_TO_SYSTEM_ID[normalized] ?? normalized);
}

/**
 * Human-readable system capabilities used across the UI for consistent
 * messaging in cards, pickers, and settings.
 */
export function getSystemFeatureSummary(
  system: SystemInfo,
  opts: { includeExperimental?: boolean } = {},
): string[] {
  const { includeExperimental = true } = opts;
  const features: string[] = [];
  if (includeExperimental && system.experimental) features.push("Experimental");
  if (system.is3D) features.push("3D core");
  else features.push("2D core");
  if (system.needsBios) features.push("BIOS");
  if (system.needsWebGL2) features.push("WebGL 2");
  if (system.needsThreads) features.push("Multi-threaded");
  if (system.touchControlMode === "builtin") features.push("Built-in touch");
  if (system.hasAchievements) features.push("RetroAchievements");
  return features;
}

