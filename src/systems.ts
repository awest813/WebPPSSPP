/**
 * systems.ts — Supported emulation systems and file-extension mapping
 *
 * EmulatorJS supports many systems via RetroArch cores. Each system
 * definition here maps to an EmulatorJS core identifier plus metadata
 * used throughout the UI (badges, colours, performance settings).
 *
 * Performance-heavy systems (PSP / NDS / N64) now use tier-aware settings:
 * low / medium / high / ultra map to progressively heavier core options so
 * low-end devices prioritize playability while high-end devices raise quality.
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
   * Whether this system requires a BIOS file to operate.
   * When true, RetroVault will check the BIOS store before launch.
   */
  needsBios?: boolean;
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
    ppsspp_lazy_texture_caching: "disabled",
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

const N64_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
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
  },
  medium: {
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

// ── PS1 (Beetle PSX) tier-specific core options ───────────────────────────────

/**
 * Beetle PSX / mednafen-psx-hw RetroArch core options per tier.
 *
 * Key options:
 *   beetle_psx_internal_resolution — Rendering resolution multiplier
 *   beetle_psx_frame_duping_enable — Repeat last frame when nothing changed (saves GPU)
 *   beetle_psx_filter              — Texture filter (nearest = fastest)
 *   beetle_psx_dither_mode         — Ordered dither to hide colour banding
 *   beetle_psx_cd_access_method    — CD-ROM emulation speed (sync = safest)
 *   beetle_psx_gte_overclock       — Overclock the Geometry Transformation Engine; reduces
 *                                    polygon dropout / lag in heavily-triangulated scenes
 *   beetle_psx_analog_calibration  — Correct analog stick drift via per-axis calibration
 */
const PSX_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    // Force Beetle PSX HW (mednafen_psx_hw) over the EmulatorJS default of
    // pcsx_rearmed. All beetle_psx_* options below require this core.
    retroarch_core: "mednafen_psx_hw",
    beetle_psx_internal_resolution: "1x(native)",
    beetle_psx_frame_duping_enable: "enabled",
    beetle_psx_filter: "nearest",
    beetle_psx_dither_mode: "internal",
    beetle_psx_cd_access_method: "sync",
    // Interpreter is slower but avoids dynarec bugs on low-spec hardware
    beetle_psx_cpu_dynarec: "disabled",
    beetle_psx_dynarec_invalidate: "full",
    beetle_psx_pgxp_mode: "disabled",
    beetle_psx_pgxp_texture: "disabled",
    beetle_psx_pgxp_vertex: "disabled",
    beetle_psx_analog_calibration: "disabled",
    beetle_psx_widescreen_hack: "disabled",
    beetle_psx_skip_deinterlacing: "enabled",
    beetle_psx_gpu_overclock: "1x(native)",
    beetle_psx_cd_fastload: "2x(native)",
    // GTE overclock disabled on low — avoid the extra CPU overhead on slow devices
    beetle_psx_gte_overclock: "disabled",
  },
  medium: {
    retroarch_core: "mednafen_psx_hw",
    beetle_psx_internal_resolution: "1x(native)",
    beetle_psx_frame_duping_enable: "enabled",
    beetle_psx_filter: "nearest",
    // 1x(native) dithering for better accuracy than internal dithering
    beetle_psx_dither_mode: "1x(native)",
    beetle_psx_cd_access_method: "async",
    beetle_psx_cpu_dynarec: "enabled",
    beetle_psx_dynarec_invalidate: "full",
    beetle_psx_pgxp_mode: "disabled",
    beetle_psx_pgxp_texture: "disabled",
    beetle_psx_pgxp_vertex: "disabled",
    // Analog calibration corrects stick drift at negligible cost — enable from medium up
    beetle_psx_analog_calibration: "enabled",
    beetle_psx_widescreen_hack: "disabled",
    beetle_psx_skip_deinterlacing: "enabled",
    beetle_psx_gpu_overclock: "1x(native)",
    // Medium hardware can handle faster CD access
    beetle_psx_cd_fastload: "6x",
    // GTE overclock disabled on medium — dynarec is fast enough without it
    beetle_psx_gte_overclock: "disabled",
  },
  high: {
    retroarch_core: "mednafen_psx_hw",
    beetle_psx_internal_resolution: "2x",
    beetle_psx_frame_duping_enable: "disabled",
    // Bilinear filtering smooths textures at higher internal resolutions
    beetle_psx_filter: "bilinear",
    beetle_psx_dither_mode: "internal",
    beetle_psx_cd_access_method: "async",
    beetle_psx_cpu_dynarec: "enabled",
    beetle_psx_dynarec_invalidate: "full",
    // PGXP memory mode: fixes the wobbly polygon effect on PS1 3D geometry
    beetle_psx_pgxp_mode: "memory",
    beetle_psx_pgxp_texture: "enabled",
    beetle_psx_pgxp_vertex: "enabled",
    beetle_psx_analog_calibration: "enabled",
    beetle_psx_widescreen_hack: "disabled",
    beetle_psx_skip_deinterlacing: "disabled",
    // 4x GPU overclock gives the PS1's GPU more headroom for high-res rendering
    beetle_psx_gpu_overclock: "4x",
    beetle_psx_cd_fastload: "6x",
    // GTE overclock: reduces geometry transformation lag at 2× internal resolution
    beetle_psx_gte_overclock: "enabled",
    // Adaptive smoothing for smoother 3D rendering at higher resolutions
    beetle_psx_adaptive_smoothing: "enabled",
    beetle_psx_super_sampling: "disabled",
  },
  ultra: {
    retroarch_core: "mednafen_psx_hw",
    // 4x internal resolution: sweet spot for ultra — 8x is overkill for typical display sizes
    beetle_psx_internal_resolution: "4x",
    beetle_psx_frame_duping_enable: "disabled",
    beetle_psx_filter: "bilinear",
    beetle_psx_dither_mode: "internal",
    beetle_psx_cd_access_method: "async",
    beetle_psx_cpu_dynarec: "enabled",
    beetle_psx_dynarec_invalidate: "full",
    // Full PGXP: fixes 3D geometry warping and texture perspective correction
    beetle_psx_pgxp_mode: "memory+cpu",
    beetle_psx_pgxp_texture: "enabled",
    beetle_psx_pgxp_vertex: "enabled",
    beetle_psx_analog_calibration: "enabled",
    beetle_psx_widescreen_hack: "disabled",
    beetle_psx_skip_deinterlacing: "disabled",
    // 8x GPU overclock: maximises rendering throughput for high-res output
    beetle_psx_gpu_overclock: "8x",
    beetle_psx_cd_fastload: "8x",
    // GTE overclock: reduces geometry transformation lag for smoother animations
    beetle_psx_gte_overclock: "enabled",
    beetle_psx_adaptive_smoothing: "enabled",
    // Super sampling for highest quality anti-aliasing at ultra tier
    beetle_psx_super_sampling: "enabled",
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

/**
 * Get the appropriate Beetle Saturn settings for a given performance tier.
 */
export function getSaturnSettingsForTier(tier: PerformanceTier): Record<string, string> {
  return { ...SATURN_TIER_SETTINGS[tier] };
}

/**
 * Get the appropriate Flycast (Dreamcast) settings for a given performance tier.
 */
export function getDreamcastSettingsForTier(tier: PerformanceTier): Record<string, string> {
  return { ...DREAMCAST_TIER_SETTINGS[tier] };
}

// ── Sega Saturn (Beetle Saturn) tier settings ─────────────────────────────────

const SATURN_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    beetle_saturn_resolution: "1x(native)",
    beetle_saturn_deinterlace_method: "weave",
    beetle_saturn_horizontal_overscan: "disabled",
    beetle_saturn_analog_stick_deadzone: "15%",
    beetle_saturn_region_detect: "Auto",
    beetle_saturn_multitap_port1: "disabled",
    beetle_saturn_multitap_port2: "disabled",
    beetle_saturn_virtuagun_input: "disabled",
    beetle_saturn_shared_ext: "disabled",
  },
  medium: {
    beetle_saturn_resolution: "2x",
    beetle_saturn_deinterlace_method: "bob",
    beetle_saturn_horizontal_overscan: "enabled",
    beetle_saturn_analog_stick_deadzone: "15%",
    beetle_saturn_region_detect: "Auto",
    beetle_saturn_multitap_port1: "disabled",
    beetle_saturn_multitap_port2: "disabled",
    beetle_saturn_virtuagun_input: "disabled",
    beetle_saturn_shared_ext: "disabled",
    beetle_saturn_horizontal_blend: "enabled",
  },
  high: {
    beetle_saturn_resolution: "4x",
    beetle_saturn_deinterlace_method: "bob",
    beetle_saturn_horizontal_overscan: "enabled",
    beetle_saturn_analog_stick_deadzone: "15%",
    beetle_saturn_region_detect: "Auto",
    beetle_saturn_multitap_port1: "disabled",
    beetle_saturn_multitap_port2: "disabled",
    beetle_saturn_virtuagun_input: "disabled",
    beetle_saturn_shared_ext: "disabled",
    beetle_saturn_horizontal_blend: "enabled",
    beetle_saturn_auto_calc_md5: "disabled",
  },
  ultra: {
    // 8x internal resolution for crisp sprite-heavy 2D and 3D geometry
    beetle_saturn_resolution: "8x",
    beetle_saturn_deinterlace_method: "yadif",
    beetle_saturn_horizontal_overscan: "enabled",
    beetle_saturn_analog_stick_deadzone: "15%",
    beetle_saturn_region_detect: "Auto",
    beetle_saturn_multitap_port1: "disabled",
    beetle_saturn_multitap_port2: "disabled",
    beetle_saturn_virtuagun_input: "disabled",
    beetle_saturn_shared_ext: "disabled",
    beetle_saturn_horizontal_blend: "enabled",
    beetle_saturn_auto_calc_md5: "disabled",
  },
};

// ── Dreamcast (Flycast) tier settings ─────────────────────────────────────────

const DREAMCAST_TIER_SETTINGS: Record<PerformanceTier, Record<string, string>> = {
  low: {
    flycast_internal_resolution: "640x480",
    flycast_anisotropic_filtering: "off",
    flycast_pvr_texture_upscaling: "1",
    flycast_enable_dsp: "disabled",
    flycast_synchronous_rendering: "enabled",
    flycast_enable_rttb: "disabled",
    flycast_div_matching: "enabled",
    flycast_auto_skip_frame: "enabled",
  },
  medium: {
    flycast_internal_resolution: "1280x960",
    flycast_anisotropic_filtering: "4",
    // Medium GPUs can handle 2x texture upscaling
    flycast_pvr_texture_upscaling: "2",
    flycast_enable_dsp: "enabled",
    flycast_synchronous_rendering: "enabled",
    flycast_enable_rttb: "disabled",
    flycast_div_matching: "enabled",
    flycast_auto_skip_frame: "disabled",
  },
  high: {
    flycast_internal_resolution: "1920x1440",
    flycast_anisotropic_filtering: "8",
    flycast_pvr_texture_upscaling: "2",
    flycast_enable_dsp: "enabled",
    flycast_synchronous_rendering: "disabled",
    flycast_enable_rttb: "enabled",
    flycast_div_matching: "enabled",
    flycast_auto_skip_frame: "disabled",
    flycast_delay_frame_swapping: "disabled",
    flycast_alpha_sorting: "Triangle Sorting",
  },
  ultra: {
    // 2560×1920 internal: 4× native Dreamcast resolution on high-end GPUs
    flycast_internal_resolution: "2560x1920",
    flycast_anisotropic_filtering: "16",
    // 2x texture upscaling: 4x is excessive on DC, 2x is better balance
    flycast_pvr_texture_upscaling: "2",
    flycast_enable_dsp: "enabled",
    flycast_synchronous_rendering: "disabled",
    flycast_enable_rttb: "enabled",
    flycast_div_matching: "enabled",
    flycast_auto_skip_frame: "disabled",
    flycast_delay_frame_swapping: "disabled",
    flycast_alpha_sorting: "Triangle Sorting",
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
    extensions: ["nds"],
    color: "#4b5d7a",
    needsThreads: false,
    needsWebGL2: false,
    qualitySettings: NDS_TIER_SETTINGS.high,
    perfSettings: NDS_TIER_SETTINGS.low,
    tierSettings: NDS_TIER_SETTINGS,
  },
  {
    id: "n64",
    name: "Nintendo 64",
    shortName: "N64",
    extensions: ["64", "n64", "v64", "z64"],
    color: "#1a7a1a",
    needsThreads: false,
    needsWebGL2: false,
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
    qualitySettings: SATURN_TIER_SETTINGS.high,
    perfSettings: SATURN_TIER_SETTINGS.low,
    tierSettings: SATURN_TIER_SETTINGS,
  },
  {
    id: "segaDC",
    name: "Dreamcast",
    shortName: "DC",
    extensions: ["cdi", "gdi", "chd", "m3u"],
    color: "#e07b20",
    needsThreads: false,
    needsWebGL2: false,
    needsBios: true,
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

/** Look up a system by its EJS core identifier (O(1) via Map). */
export function getSystemById(id: string): SystemInfo | undefined {
  return SYSTEM_BY_ID.get(id);
}
