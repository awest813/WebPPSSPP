/**
 * systems.ts — Supported emulation systems and file-extension mapping
 *
 * EmulatorJS supports many systems via RetroArch cores. Each system
 * definition here maps to an EmulatorJS core identifier plus metadata
 * used throughout the UI (badges, colours, performance settings).
 *
 * Performance-heavy systems (PSP / NDS / N64 / Saturn) use tier-aware settings;
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
  /** High-fidelity glassmorphic icon asset URL. */
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
   * Whether this system requires a BIOS file to operate.
   * When true, RetroVault will check the BIOS store before launch.
   */
  needsBios?: boolean;
  /**
   * Whether this system renders 3D graphics (polygon-based geometry).
   * When true, post-processing effects like FSR and TAA are particularly
   * beneficial. 2D pixel-art systems omit this field (defaults to false).
   */
  is3D?: boolean;
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
 * Core rendering & GPU options:
 *   ppsspp_internal_resolution          — Rendering resolution multiplier (1–10)
 *   ppsspp_block_transfer_gpu           — Use GPU for block transfers (faster rendering)
 *   ppsspp_gpu_hardware_transform       — Hardware vertex transform (vs software)
 *   ppsspp_vertex_cache                 — Cache transformed vertices (faster)
 *   ppsspp_rendering_mode               — Buffered vs non-buffered rendering
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
    ppsspp_lazy_texture_caching: "enabled",
    ppsspp_retain_changed_textures: "disabled",
    ppsspp_spline_quality: "low",
    ppsspp_software_skinning: "enabled",
    ppsspp_io_timing_method: "Fast",
    ppsspp_lower_resolution_for_effects: "2",
    // 1 in-flight frame reduces GPU command buffer memory pressure on low-VRAM devices
    ppsspp_inflight_frames: "1",
    ppsspp_rendering_mode: "buffered",
    ppsspp_cpu_core: "JIT",
    ppsspp_audio_latency: "2",
    ppsspp_audio_resampling: "disabled",
    ppsspp_locked_cpu_speed: "0",
    // Target 30 fps on low-spec hardware: each frame has twice the GPU budget
    // compared to a 60 fps target, yielding smoother and more consistent 3D
    // rendering on devices that cannot sustain full speed.
    ppsspp_force_max_fps: "30",
    ppsspp_cheats: "enabled",
    ppsspp_skip_buffer_effects: "enabled",
    ppsspp_disable_slow_framebuf_effects: "enabled",
    ppsspp_gpu_anisotropic_filtering: "off",
    ppsspp_texture_shader: "Off",
    ppsspp_change_emulated_psp_cpu_clock: "0",
    ppsspp_separate_io_thread: "enabled",
    ppsspp_unsafe_func_replacements: "enabled",
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
    // Lazy texture hashing cuts CPU cost in texture-heavy 3D titles; safe at 1× IR
    ppsspp_lazy_texture_caching: "enabled",
    ppsspp_retain_changed_textures: "enabled",
    ppsspp_spline_quality: "medium",
    ppsspp_software_skinning: "enabled",
    ppsspp_io_timing_method: "Fast",
    ppsspp_lower_resolution_for_effects: "0",
    ppsspp_inflight_frames: "2",
    ppsspp_rendering_mode: "buffered",
    ppsspp_cpu_core: "JIT",
    ppsspp_audio_latency: "1",
    // Enable resampling at medium: the CPU cost is modest and audio quality
    // is noticeably better, especially for music-heavy titles.
    ppsspp_audio_resampling: "enabled",
    ppsspp_locked_cpu_speed: "0",
    ppsspp_force_max_fps: "60",
    ppsspp_cheats: "enabled",
    ppsspp_skip_buffer_effects: "disabled",
    ppsspp_disable_slow_framebuf_effects: "enabled",
    // 2x anisotropic filtering is nearly free on any discrete GPU
    ppsspp_gpu_anisotropic_filtering: "2x",
    ppsspp_texture_shader: "Off",
    ppsspp_change_emulated_psp_cpu_clock: "0",
    ppsspp_separate_io_thread: "enabled",
    ppsspp_unsafe_func_replacements: "enabled",
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
    // At 2× IR, lazy hashing still wins most 3D titles vs full CPU texture hashing
    ppsspp_lazy_texture_caching: "enabled",
    ppsspp_retain_changed_textures: "enabled",
    ppsspp_spline_quality: "high",
    ppsspp_software_skinning: "enabled",
    ppsspp_io_timing_method: "Fast",
    ppsspp_lower_resolution_for_effects: "0",
    // 2 in-flight frames for more responsive input latency at high tier
    ppsspp_inflight_frames: "2",
    ppsspp_rendering_mode: "buffered",
    ppsspp_cpu_core: "JIT",
    ppsspp_audio_latency: "1",
    ppsspp_audio_resampling: "enabled",
    ppsspp_locked_cpu_speed: "0",
    ppsspp_force_max_fps: "0",
    ppsspp_cheats: "enabled",
    ppsspp_skip_buffer_effects: "disabled",
    ppsspp_disable_slow_framebuf_effects: "disabled",
    // 8x anisotropic: high-tier GPUs can handle this easily for sharp oblique textures
    ppsspp_gpu_anisotropic_filtering: "8x",
    ppsspp_texture_shader: "Off",
    ppsspp_change_emulated_psp_cpu_clock: "0",
    ppsspp_separate_io_thread: "enabled",
    ppsspp_unsafe_func_replacements: "enabled",
  },

  // ── Ultra: maximum quality ─────────────────────────────────────────────────
  ultra: {
    ppsspp_internal_resolution: "4",
    ppsspp_auto_frameskip: "disabled",
    ppsspp_frameskip: "0",
    ppsspp_frameskip_type: "Number of frames",
    ppsspp_fast_memory: "enabled",
    ppsspp_block_transfer_gpu: "enabled",
    // 5× texture scaling via xBRZ gives the clearest texture upscale without
    // introducing the blur artifacts of bilinear-only approaches.
    ppsspp_texture_scaling_level: "5",
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
    // 2 in-flight frames for better input responsiveness even on ultra
    ppsspp_inflight_frames: "2",
    ppsspp_rendering_mode: "buffered",
    ppsspp_cpu_core: "JIT",
    // Minimum audio buffer for the lowest possible audio latency on capable hardware
    ppsspp_audio_latency: "0",
    ppsspp_audio_resampling: "enabled",
    // Lock emulated CPU to 222 MHz for better compatibility with demanding titles
    ppsspp_locked_cpu_speed: "222",
    ppsspp_force_max_fps: "0",
    ppsspp_cheats: "enabled",
    ppsspp_skip_buffer_effects: "disabled",
    ppsspp_disable_slow_framebuf_effects: "disabled",
    // 16x anisotropic: maximum texture quality on high-refresh-rate surfaces
    ppsspp_gpu_anisotropic_filtering: "16x",
    // GPU-side xBRZ texture shader: sharpens textures in-flight without CPU cost
    ppsspp_texture_shader: "xBRZ",
    // Lock emulated PSP CPU to full 333 MHz: improves compatibility with titles
    // that run at reduced clock by default and benefits CPU-limited games.
    ppsspp_change_emulated_psp_cpu_clock: "333",
    ppsspp_separate_io_thread: "enabled",
    ppsspp_unsafe_func_replacements: "enabled",
  },
};

/**
 * mupen64plus-next RetroArch core options per tier.
 *
 * `retroarch_core: "mupen64plus_next"` is injected on every tier so EmulatorJS
 * always loads GLideN64/Rice-capable mupen64plus-next. Without it, Safari
 * mobile reverses the core list and would default to parallel_n64, ignoring
 * these `mupen64plus-*` keys.
 */
const N64_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    retroarch_core: "mupen64plus_next",
    // Rice plugin: lightest-weight RDP; skips most accuracy features.
    "mupen64plus-rdp-plugin": "rice",
    "mupen64plus-resolution-factor": "1",
    "mupen64plus-cpucore": "dynamic_recompiler",
    "mupen64plus-framerate": "fullspeed",
    "mupen64plus-virefresh": "auto",
    "mupen64plus-BilinearMode": "standard",
    "mupen64plus-EnableFBEmulation": "False",
    "mupen64plus-EnableCopyColorToRDRAM": "Off",
    "mupen64plus-EnableCopyDepthToRDRAM": "Off",
    "mupen64plus-EnableCopyColorFromRDRAM": "False",
    "mupen64plus-EnableLOD": "False",
    "mupen64plus-EnableHWLighting": "False",
    "mupen64plus-txFilterMode": "None",
    "mupen64plus-txHiresEnable": "False",
    "mupen64plus-EnableNoise": "False",
    "mupen64plus-astick-deadzone": "15",
    "mupen64plus-CountPerOp": "0",
  },
  medium: {
    retroarch_core: "mupen64plus_next",
    "mupen64plus-rdp-plugin": "gliden64",
    "mupen64plus-resolution-factor": "1",
    "mupen64plus-cpucore": "dynamic_recompiler",
    "mupen64plus-framerate": "fullspeed",
    "mupen64plus-virefresh": "auto",
    "mupen64plus-BilinearMode": "standard",
    "mupen64plus-EnableFBEmulation": "True",
    "mupen64plus-EnableCopyColorToRDRAM": "Async",
    // FromMem is faster and more compatible than Software on medium tier
    "mupen64plus-EnableCopyDepthToRDRAM": "FromMem",
    "mupen64plus-EnableCopyColorFromRDRAM": "False",
    "mupen64plus-EnableLOD": "True",
    "mupen64plus-EnableHWLighting": "False",
    "mupen64plus-txFilterMode": "None",
    "mupen64plus-txHiresEnable": "False",
    "mupen64plus-EnableNoise": "False",
    "mupen64plus-astick-deadzone": "15",
    "mupen64plus-CountPerOp": "0",
  },
  high: {
    retroarch_core: "mupen64plus_next",
    "mupen64plus-rdp-plugin": "gliden64",
    "mupen64plus-resolution-factor": "2",
    "mupen64plus-cpucore": "dynamic_recompiler",
    "mupen64plus-framerate": "fullspeed",
    "mupen64plus-virefresh": "auto",
    // 3-point bilinear filtering: better texture quality than standard bilinear
    "mupen64plus-BilinearMode": "3point",
    "mupen64plus-EnableFBEmulation": "True",
    "mupen64plus-EnableCopyColorToRDRAM": "Async",
    "mupen64plus-EnableCopyDepthToRDRAM": "Software",
    "mupen64plus-EnableCopyColorFromRDRAM": "True",
    "mupen64plus-EnableLOD": "True",
    "mupen64plus-EnableHWLighting": "True",
    // Smooth filtering 1: gentle texture smoothing that removes pixel crawl
    // without the blurriness of stronger filters.
    "mupen64plus-txFilterMode": "Smooth filtering 1",
    "mupen64plus-txHiresEnable": "False",
    // "As Is" passes textures through the enhancement pipeline without altering them,
    // enabling texture filtering and caching without additional processing
    "mupen64plus-txEnhancementMode": "As Is",
    "mupen64plus-EnableN64DepthCompare": "False",
    "mupen64plus-EnableNoise": "True",
    "mupen64plus-astick-deadzone": "15",
    "mupen64plus-CountPerOp": "0",
  },
  ultra: {
    retroarch_core: "mupen64plus_next",
    "mupen64plus-rdp-plugin": "gliden64",
    // 4× internal resolution for sharp, clean geometry at high DPI
    "mupen64plus-resolution-factor": "4",
    "mupen64plus-cpucore": "dynamic_recompiler",
    "mupen64plus-framerate": "fullspeed",
    "mupen64plus-virefresh": "auto",
    "mupen64plus-BilinearMode": "3point",
    "mupen64plus-EnableFBEmulation": "True",
    "mupen64plus-EnableCopyColorToRDRAM": "Async",
    "mupen64plus-EnableCopyDepthToRDRAM": "Software",
    "mupen64plus-EnableCopyColorFromRDRAM": "True",
    "mupen64plus-EnableLOD": "True",
    "mupen64plus-EnableHWLighting": "True",
    // Smooth filtering 4: strongest smoothing pass — appropriate at 4× res
    // where the original pixel grid is no longer visible.
    "mupen64plus-txFilterMode": "Smooth filtering 4",
    // Enhancement mode preserves original texture data while applying filters
    "mupen64plus-txEnhancementMode": "As Is",
    "mupen64plus-txHiresEnable": "False",
    // N64 depth compare for highest accuracy at ultra tier
    "mupen64plus-EnableN64DepthCompare": "True",
    // Larger texture cache for better performance with enhanced textures
    "mupen64plus-MaxTxCacheSize": "4000",
    "mupen64plus-EnableNoise": "True",
    "mupen64plus-astick-deadzone": "15",
    "mupen64plus-CountPerOp": "0",
  },
};

const NDS_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    // EmulatorJS defaults to melonDS first; our tier tables target DeSmuME 2015.
    retroarch_core: "desmume2015",
    desmume_num_cores: "1",
    desmume_cpu_mode: "interpreter",
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
 *   mgba_frameskip         — 0 = no skip, 1–4 = skip N frames
 *   mgba_color_correction  — GBA LCD colour correction (CPU cost on low-spec)
 *   mgba_interframe_blending — Ghost/blend between frames (mimics LCD blur)
 *   mgba_skip_bios         — Skip the GBA boot logo (always ON for speed)
 *   mgba_idle_optimization — Detect busy-wait loops and replace with halts
 *   mgba_audio_buffer_size — Audio output buffer in samples (512/1024/2048/4096).
 *                            Larger buffers prevent underruns on high-latency audio
 *                            hardware (Bluetooth/USB); smaller buffers reduce latency
 *                            on direct-wired audio.
 */
const GBA_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    mgba_skip_bios: "ON",
    mgba_frameskip: "1",
    mgba_color_correction: "disabled",
    mgba_interframe_blending: "disabled",
    mgba_idle_optimization: "Remove Known",
    mgba_solar_sensor_level: "0",
    mgba_allow_opposing_directions: "no",
    mgba_force_gbp: "OFF",
    // Larger buffer on low-spec hardware: more headroom to prevent audio
    // underruns when the CPU is already under pressure from frameskip recovery.
    mgba_audio_buffer_size: "2048",
  },
  medium: {
    mgba_skip_bios: "ON",
    mgba_frameskip: "0",
    mgba_color_correction: "Game Boy Advance",
    mgba_interframe_blending: "disabled",
    mgba_idle_optimization: "Remove Known",
    mgba_solar_sensor_level: "0",
    mgba_allow_opposing_directions: "no",
    mgba_force_gbp: "OFF",
    mgba_audio_buffer_size: "1024",
  },
  high: {
    mgba_skip_bios: "ON",
    mgba_frameskip: "0",
    mgba_color_correction: "Game Boy Advance",
    mgba_interframe_blending: "mix",
    mgba_idle_optimization: "Remove Known",
    mgba_solar_sensor_level: "0",
    mgba_allow_opposing_directions: "no",
    mgba_force_gbp: "OFF",
    // 512-sample buffer for lowest latency on capable hardware
    mgba_audio_buffer_size: "512",
  },
  ultra: {
    mgba_skip_bios: "ON",
    mgba_frameskip: "0",
    mgba_color_correction: "Game Boy Advance",
    mgba_interframe_blending: "mix",
    mgba_idle_optimization: "Remove Known",
    mgba_solar_sensor_level: "0",
    mgba_allow_opposing_directions: "no",
    mgba_force_gbp: "OFF",
    mgba_audio_buffer_size: "512",
  },
};

// ── PS1 (Beetle PSX HW) tier-specific core options ────────────────────────────
//
// EmulatorJS loads mednafen_psx_hw with HAVE_HW, so libretro option keys use the
// beetle_psx_hw_* prefix (see beetle-psx-libretro libretro_options.h).

/**
 * Beetle PSX HW / mednafen_psx_hw RetroArch core options per tier.
 *
 * Key options:
 *   beetle_psx_hw_internal_resolution — GPU resolution multiplier (1x–16x)
 *   beetle_psx_hw_frame_duping          — Repeat last frame when unchanged (saves GPU)
 *   beetle_psx_hw_filter                  — Texture filter (nearest = fastest)
 *   beetle_psx_hw_dither_mode           — Dither pattern (match native / internal / off)
 *   beetle_psx_hw_cd_access_method      — Disc read model (sync = safest; async can hitch less)
 *   beetle_psx_hw_gte_overclock         — One-cycle GTE latency (big win for 3D-heavy games)
 *   beetle_psx_hw_analog_calibration    — DualShock analog range calibration
 *   beetle_psx_hw_cpu_dynarec           — Lightrec dynarec: disabled | execute | …
 */
const PSX_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    // Force Beetle PSX HW over EmulatorJS default pcsx_rearmed so these options apply.
    retroarch_core: "mednafen_psx_hw",
    beetle_psx_hw_renderer: "hardware",
    beetle_psx_hw_internal_resolution: "1x(native)",
    beetle_psx_hw_frame_duping: "enabled",
    beetle_psx_hw_filter: "nearest",
    beetle_psx_hw_dither_mode: "1x(native)",
    beetle_psx_hw_depth: "16bpp(native)",
    beetle_psx_hw_cd_access_method: "sync",
    beetle_psx_hw_cpu_dynarec: "disabled",
    beetle_psx_hw_dynarec_invalidate: "full",
    beetle_psx_hw_pgxp_mode: "disabled",
    beetle_psx_hw_pgxp_texture: "disabled",
    beetle_psx_hw_pgxp_vertex: "disabled",
    beetle_psx_hw_analog_calibration: "disabled",
    beetle_psx_hw_widescreen_hack: "disabled",
    beetle_psx_hw_renderer_software_fb: "enabled",
    beetle_psx_hw_gpu_overclock: "1x(native)",
    beetle_psx_hw_cd_fastload: "2x(native)",
    beetle_psx_hw_gte_overclock: "disabled",
    beetle_psx_hw_mdec_yuv: "disabled",
  },
  medium: {
    retroarch_core: "mednafen_psx_hw",
    beetle_psx_hw_renderer: "hardware",
    beetle_psx_hw_internal_resolution: "1x(native)",
    beetle_psx_hw_frame_duping: "enabled",
    beetle_psx_hw_filter: "nearest",
    beetle_psx_hw_dither_mode: "1x(native)",
    beetle_psx_hw_depth: "16bpp(native)",
    beetle_psx_hw_cd_access_method: "async",
    // "execute" = max-performance dynarec (upstream value; not "enabled")
    beetle_psx_hw_cpu_dynarec: "execute",
    beetle_psx_hw_dynarec_invalidate: "full",
    beetle_psx_hw_pgxp_mode: "disabled",
    beetle_psx_hw_pgxp_texture: "disabled",
    beetle_psx_hw_pgxp_vertex: "disabled",
    beetle_psx_hw_analog_calibration: "enabled",
    beetle_psx_hw_widescreen_hack: "disabled",
    beetle_psx_hw_renderer_software_fb: "enabled",
    beetle_psx_hw_gpu_overclock: "1x(native)",
    beetle_psx_hw_cd_fastload: "6x",
    beetle_psx_hw_gte_overclock: "disabled",
    beetle_psx_hw_mdec_yuv: "enabled",
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
    beetle_psx_hw_pgxp_mode: "memory + CPU",
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
    beetle_psx_hw_negatevelopment: "enabled",
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
 * Get the appropriate Beetle PSX settings for a given performance tier.
 */
export function getPSXSettingsForTier(tier: PerformanceTier): Record<string, string> {
  return { ...PSX_TIER_SETTINGS[tier] };
}


// ── Sega Saturn (Yabause) tier settings ───────────────────────────────────────
//
// EmulatorJS maps `segaSaturn` → Yabause (not Beetle Saturn). Options follow
// libretro yabause_core_options (frameskip, HLE BIOS, expansion RAM, multitap, threads).

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

const DREAMCAST_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    reicast_boot_to_bios:         "disabled",
    reicast_hle_bios:             "disabled",
    reicast_threaded_rendering:   "disabled",
    reicast_synchronous_rendering:"disabled",
    reicast_internal_resolution:  "640x480",
    reicast_mipmapping:           "disabled",
    reicast_anisotropic_filtering:"1",
    reicast_texupscale:           "disabled",
    reicast_enable_rttb:          "disabled",
    reicast_enable_purupuru:      "disabled",
    reicast_alpha_sorting:        "per-strip (fast, least accurate)",
    reicast_delay_frame_swapping: "disabled",
    reicast_frame_skipping:       "enabled",
    reicast_framerate:            "normal",
  },
  medium: {
    reicast_boot_to_bios:         "disabled",
    reicast_hle_bios:             "disabled",
    reicast_threaded_rendering:   "enabled",
    reicast_synchronous_rendering:"disabled",
    reicast_internal_resolution:  "640x480",
    reicast_mipmapping:           "enabled",
    reicast_anisotropic_filtering:"2",
    reicast_texupscale:           "disabled",
    reicast_enable_rttb:          "disabled",
    reicast_enable_purupuru:      "enabled",
    reicast_alpha_sorting:        "per-strip (fast, least accurate)",
    reicast_delay_frame_swapping: "disabled",
    reicast_frame_skipping:       "disabled",
    reicast_framerate:            "normal",
  },
  high: {
    reicast_boot_to_bios:         "disabled",
    reicast_hle_bios:             "disabled",
    reicast_threaded_rendering:   "enabled",
    reicast_synchronous_rendering:"disabled",
    reicast_internal_resolution:  "1280x960",
    reicast_mipmapping:           "enabled",
    reicast_anisotropic_filtering:"4",
    reicast_texupscale:           "disabled",
    reicast_enable_rttb:          "enabled",
    reicast_enable_purupuru:      "enabled",
    reicast_alpha_sorting:        "per-triangle (normal)",
    reicast_delay_frame_swapping: "disabled",
    reicast_frame_skipping:       "disabled",
    reicast_framerate:            "normal",
  },
  ultra: {
    reicast_boot_to_bios:         "disabled",
    reicast_hle_bios:             "disabled",
    reicast_threaded_rendering:   "enabled",
    reicast_synchronous_rendering:"disabled",
    reicast_internal_resolution:  "1920x1440",
    reicast_mipmapping:           "enabled",
    reicast_anisotropic_filtering:"8",
    reicast_texupscale:           "2x",
    reicast_enable_rttb:          "enabled",
    reicast_enable_purupuru:      "enabled",
    reicast_alpha_sorting:        "per-triangle (normal)",
    reicast_delay_frame_swapping: "disabled",
    reicast_frame_skipping:       "disabled",
    reicast_framerate:            "normal",
  },
};

// ── Supported systems ─────────────────────────────────────────────────────────

export const SYSTEMS: SystemInfo[] = [
  {
    id: "psp",
    name: "PlayStation Portable",
    shortName: "PSP",
    iconUrl: "/assets/psp_system_icon_premium_1775433994525.png",
    extensions: ["iso", "cso", "elf", "pbp"],
    color: "#0070cc",
    needsThreads: true,
    needsWebGL2: true,
    is3D: true,
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
    iconUrl: "/assets/nes_system_icon_premium_1775435133234.png",
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
    iconUrl: "/assets/snes_system_icon_premium_1775434976156.png",
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
    iconUrl: "/assets/gba_system_icon_premium_1775434039102.png",
    extensions: ["gba"],
    color: "#7c4dff",
    needsThreads: false,
    needsWebGL2: false,
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
    id: "nds",
    name: "Nintendo DS",
    shortName: "DS",
    iconUrl: "/assets/nds_system_icon_premium_1775435000887.png",
    extensions: ["nds"],
    color: "#4b5d7a",
    needsThreads: false,
    needsWebGL2: false,
    is3D: true,
    qualitySettings: NDS_TIER_SETTINGS.high,
    perfSettings: NDS_TIER_SETTINGS.low,
    tierSettings: NDS_TIER_SETTINGS,
  },
  {
    id: "n64",
    name: "Nintendo 64",
    shortName: "N64",
    iconUrl: "/assets/n64_system_icon_premium_1775434016833.png",
    extensions: ["64", "n64", "v64", "z64"],
    color: "#1a7a1a",
    needsThreads: false,
    needsWebGL2: false,
    is3D: true,
    qualitySettings: N64_TIER_SETTINGS.high,
    perfSettings: N64_TIER_SETTINGS.low,
    tierSettings: N64_TIER_SETTINGS,
  },
  {
    id: "psx",
    name: "PlayStation 1",
    shortName: "PS1",
    iconUrl: "/assets/psx_system_icon_premium_1775434989040.png",
    extensions: ["bin", "pbp", "chd", "cue", "img", "mdf", "ccd", "m3u", "iso"],
    color: "#003087",
    needsThreads: false,
    needsWebGL2: false,
    is3D: true,
    qualitySettings: PSX_TIER_SETTINGS.high,
    perfSettings: PSX_TIER_SETTINGS.low,
    tierSettings: PSX_TIER_SETTINGS,
  },
  {
    id: "segaMD",
    name: "Sega Genesis / Mega Drive",
    shortName: "Genesis",
    iconUrl: "/assets/genesis_system_icon_premium_1775435147615.png",
    extensions: ["md", "smd", "gen"],
    color: "#1a1ae6",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: GENESIS_TIER_SETTINGS.high,
    perfSettings: GENESIS_TIER_SETTINGS.low,
    tierSettings: GENESIS_TIER_SETTINGS,
  },
  {
    id: "segaGG",
    name: "Game Gear",
    shortName: "GG",
    extensions: ["gg"],
    color: "#e64a1a",
    needsThreads: false,
    needsWebGL2: false,
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
    qualitySettings: {},
    perfSettings: {},
  },
  {
    id: "atari7800",
    name: "Atari 7800",
    shortName: "7800",
    extensions: ["a78", "bin"],
    color: "#8b6000",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: {},
    perfSettings: {},
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
    qualitySettings: {},
    perfSettings: {},
  },
  {
    id: "ngp",
    name: "Neo Geo Pocket",
    shortName: "NGP",
    extensions: ["ngp", "ngc", "ngpc"],
    color: "#cc2222",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: {},
    perfSettings: {},
  },
];

// ── Lookup tables ─────────────────────────────────────────────────────────────

/** System id → SystemInfo for O(1) lookup. */
const SYSTEM_BY_ID: Map<string, SystemInfo> = new Map();

/** Extension → single unambiguous system. */
const UNIQUE_EXT: Map<string, SystemInfo> = new Map();
/** Extension → multiple candidate systems (ambiguous). */
const AMBIGUOUS_EXT: Map<string, SystemInfo[]> = new Map();

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
  if (AMBIGUOUS_EXT.has(ext)) return AMBIGUOUS_EXT.get(ext)!;
  return null;
}

/** Look up a system by its EJS core identifier (O(1) via Map). */
export function getSystemById(id: string): SystemInfo | undefined {
  return SYSTEM_BY_ID.get(id);
}
