# RetroVault Roadmap

This document tracks planned improvements, experiments under investigation, and longer-term vision items. Entries move from *Planned* -> *In Progress* -> *Done* as work happens.

Items within each phase are roughly ordered by expected impact.

---

## Phase 1 — Foundation (Complete)

Core infrastructure shipped in the initial release.

- [x] EmulatorJS multi-system integration (PSP, N64, PS1, NDS, GBA, SNES, NES, Genesis, ...)
- [x] Hardware tier classification (Low / Medium / High / Ultra) via WebGL benchmark + CPU/RAM heuristics
- [x] Per-system, per-tier RetroArch core option tables (PSP, N64, PS1, NDS, GBA)
- [x] ROM library with IndexedDB blob persistence and metadata cache
- [x] Cross-origin isolation via `coi-serviceworker.js` (enables SharedArrayBuffer / PSP threads)
- [x] FPS monitor -- zero-GC ring-buffer rAF loop with dropped-frame tracking
- [x] WebGL driver pre-warming (shader compile + draw call before first game launch)
- [x] CDN preconnect + prefetch for loader.js and WASM cores
- [x] Page Visibility API auto-pause (saves battery when tab is hidden)
- [x] WebGL context-loss detection and graceful recovery prompt
- [x] Battery Status API integration -- auto-switch to Performance mode at <=20%
- [x] Chromebook (CrOS) penalty in tier classification

---

## Phase 2 — 3D Rendering & Audio Quality (Complete)

Improvements to visual fidelity and audio latency for 3D-heavy systems.

### 3D Rendering

- [x] **PSP ultra tier**: 5x xBRZ texture scaling, GPU-side xBRZ texture shader, 16x anisotropic filtering, PSP CPU locked to full 333 MHz
- [x] **PSP medium tier**: 2x anisotropic filtering (near-free on any discrete GPU)
- [x] **N64 high tier**: Smooth filtering 1 texture pass (removes pixel crawl at 2x res)
- [x] **N64 ultra tier**: Smooth filtering 4 + texture enhancement mode at 4x internal resolution
- [x] **PS1 high tier**: 4x GPU overclock, PGXP memory mode (fixes wobbly polygon geometry)
- [x] **PS1 ultra tier**: 8x internal resolution, Memory + CPU PGXP, 8x GPU overclock, GTE overclock (smoother skeletal animations)
- [x] **GPU benchmark**: VAO-aware draw-call benchmark (more realistic 3D workload proxy)
- [x] **GPU capability detection**: Multi-Draw, MRT (Multiple Render Targets), VAO, compressed textures, half-float textures -- all surfaced as tier-bonus points
- [x] **Shader cache**: Persist GLSL shader source strings to IndexedDB (`retrovault-shaders`); pre-compile on next session via `KHR_parallel_shader_compile` (non-blocking); LRU eviction at 64 programs; djb2 keying
- [x] **WebGPU rendering path**: Opt-in backend -- `preWarmWebGPU()` acquires a `GPUDevice` and warms the GPU command queue; toggled in Settings; surfaced as `emulator.webgpuAvailable`; falls back silently to WebGL on unsupported browsers
- [x] **PSP Vulkan-style pipeline warm-up**: `warmUpPSPPipeline()` pre-compiles 5 representative PSP GPU shader patterns (textured quad, vertex color blend, flat-shaded, fog, alpha-test) on a throw-away GL context before the first game launch

### Audio

- [x] **Audio latency adapter**: Probes `AudioContext.baseLatency` at launch; automatically promotes audio buffer size for high-latency hardware (Bluetooth, USB DACs) regardless of GPU tier
- [x] **PSP medium tier audio resampling**: Enabled (was disabled); improves music quality with negligible CPU overhead
- [x] **AudioWorklet path**: `setupAudioWorklet()` loads `audio-processor.js` into an `AudioWorkletNode`; the worklet runs in a dedicated thread for ~5-10 ms lower latency; connects into the EJS OpenAL audio graph when accessible via `EJS_emulator.Module.AL`; underrun events posted back to the main thread via `MessagePort`
- [x] **Dynamic audio buffer sizing**: AudioWorklet processor monitors consecutive silent frames to detect underruns; underrun count surfaced via `emulator.onAudioUnderrun` callback and `emulator.audioUnderruns` getter for adaptive UI
- [x] **Audio visualiser overlay**: Optional oscilloscope canvas embedded in the FPS overlay; `AudioVisualiser` class connects an `AnalyserNode` to the EJS OpenAL context; draws time-domain waveform at <=30 fps; toggled in Settings

### Adaptive Quality

- [x] **Low-FPS detector**: Sustained <25 FPS for 10 seconds triggers `onLowFPS` callback; UI can prompt the user to switch to Performance mode
- [x] **Auto tier downgrade**: When `onLowFPS` fires, `showTierDowngradePrompt()` shows a non-blocking confirmation dialog; on accept, re-launches the current game at one tier lower via `LaunchOptions.tierOverride`; saves the downgraded tier as the per-game profile
- [x] **Per-game performance profile**: `saveGameTierProfile(gameId, tier)` / `getGameTierProfile(gameId)` persist the last stable tier per game in `localStorage` (key: `rv:tier:{id}`); automatically applied on subsequent launches; cleared via `clearGameTierProfile()`

---

## Phase 3 — Platform & Compatibility (Complete)

Broader system support and compatibility improvements.

- [x] **Additional systems**: Saturn (Beetle Saturn), Dreamcast (Flycast), MAME 2003+, Atari 7800, Lynx, Neo Geo Pocket -- 6 new systems added with tier-aware core options for Saturn and Dreamcast; `segaDC` and `segaSaturn` added to CDN prefetch map
- [x] **BIOS management**: `BiosLibrary` class persists BIOS blobs in a dedicated IndexedDB database (`retrovault-bios`); known requirements for PS1, Saturn, Dreamcast, Lynx; per-file status dots (green / red / grey) and upload controls in the Settings panel; `EJS_biosUrl` wired in `LaunchOptions`
- [x] **CHD compression**: CHD format accepted for PS1, Saturn, and Dreamcast; cores decompress CHD natively via their libchdr WASM implementation
- [x] **ZIP/7Z transparency**: Pure-JS ZIP parser reads the central directory, selects the first ROM-compatible entry by extension, and decompresses deflate data via the browser-native `DecompressionStream` API; 7z surfaces a clear unsupported-format error
- [x] **Soft-patch support**: Full IPS (including RLE records and post-EOF truncation), BPS (with VLQ decoding, all four action types, and three-CRC verification), and UPS (XOR hunks + CRC) implementations; per-game patch button on library cards
- [x] **Multi-disc games**: `.m3u` extension added to PS1, Saturn, and Dreamcast; `parseM3U()` extracts disc filenames; `showMultiDiscPicker()` dialog collects missing disc files from the user; synthetic `.m3u` with blob URLs passed to EmulatorJS

---

## Phase 4 — Save & State Management (Complete)

Improved persistence, portability, and crash-recovery for save data.

- [x] **Save state export/import**: `SaveStateLibrary` stores save state blobs in a dedicated IndexedDB database (`retrovault-saves`); per-slot export as `.state` files and import for cross-device portability
- [x] **Save state gallery**: Screenshot thumbnails captured at save time via `captureScreenshot()` + `createThumbnail()` resizing to 160x120 JPEG; gallery shows all 5 slots (auto-save + 4 manual) with thumbnails, timestamps, save/load/export/import/delete controls
- [x] **Auto-save on tab close**: `beforeunload` and `visibilitychange: hidden` trigger quick-save to slot 0 (auto-save); on next launch, `promptAutoSaveRestore()` offers crash-recovery restore; toggle in Settings
- [x] **Save data migration**: Settings panel "Migrate Saves" tool re-keys save states from one game ID to another when a ROM file is renamed
- [x] **Cloud save sync (infrastructure)**: Sync interface designed for future Google Drive/Dropbox/WebDAV integration; save state blobs are portable `.state` format compatible with standalone RetroArch

---

## Phase 5 — Mobile & PWA (Complete)

First-class mobile experience and installability.

- [x] **Progressive Web App**: Combined COI + PWA cache service worker. Caches the app shell on install for fast repeat loads and offline support. `beforeinstallprompt` surfaced as an "Install RetroVault App" button in Settings.
- [x] **Touch control layout editor**: `TouchControlsOverlay` renders 12 draggable virtual buttons (D-pad, ABXY, L/R, Start/Select) over the emulator canvas. Positions persisted per system to `localStorage`.
- [x] **Haptic feedback**: `navigator.vibrate(12)` on press, `vibrate(6)` on release. Toggled in Settings; no-op on iOS and desktop.
- [x] **Orientation lock**: `screen.orientation.lock("landscape-primary")` when a game starts. Gracefully ignored on iOS Safari and desktop.
- [x] **iOS Safari improvements**: `credentialless` COEP for CDN compatibility on Safari 17+ / iOS 17+.
- [x] **Reduced initial bundle size**: Dynamic `import()` for `archive.ts`, `patcher.ts`, and `touchControls.ts`. Vite `manualChunks` creates separate `tools` and `touch` browser-cacheable chunks.

---

## Phase 5.1 — Polish & Performance (Complete)

Bug fixes, performance improvements, and quality-of-life enhancements.

- [x] **Fix auto-save restore handler leak**: Replaced monkey-patching of `emulator.onGameStart` with a one-shot event listener (`retrovault:gameStarted`) that removes itself after firing, preventing stale restore handlers from persisting across game launches
- [x] **O(1) system lookup**: Replaced `SYSTEMS.find()` linear search in `getSystemById()` with a pre-built `Map<string, SystemInfo>` for constant-time lookups on the hot launch path
- [x] **FPS monitor bind optimization**: Moved `this._tick.bind(this)` from `start()` (called on every game start/resume) to the constructor (called once), eliminating repeated function allocation
- [x] **Shader cache eviction optimization**: LRU eviction now runs every 10 writes instead of on every `record()` call, avoiding redundant reads of all cached programs during shader-heavy startup
- [x] **Info toast notifications**: Added `showInfoToast()` for success messages (save migration) instead of abusing `showError()`, with a green success banner and 5-second auto-dismiss
- [x] **Package metadata alignment**: Fixed `package.json` name (`web-psp-emulator` -> `retrovault`) and description to match the actual product
- [x] **Blob creation efficiency**: Replaced `stateBytes.slice().buffer` double-copy pattern with direct `stateBytes.buffer as ArrayBuffer` in save state persistence
- [x] **README overhaul**: Complete rewrite covering all 20 systems, 5 completed phases, save states, BIOS management, patching, multi-disc, PWA, touch controls, detailed settings tables for all tier-tuned systems

---

## Phase 5.2 — Core Correctness & Keyboard Controls (Complete)

Fixes for silent bugs where the wrong PS1 core was used and keyboard shortcuts
could leak through to the emulator's own input handler.

- [x] **PS1 core fix**: EmulatorJS's `psx` system defaults to PCSX ReARMed (`pcsx_rearmed`) — the first entry in its core registry. All `beetle_psx_*` tier options (PGXP, GPU overclock, internal resolution, dynarec, filters) require Beetle PSX HW (`mednafen_psx_hw`). Fixed by injecting `retroarch_core: "mednafen_psx_hw"` into every PSX tier-settings object, which EmulatorJS honours over the default when the value is found in the registry. All four tiers (low/medium/high/ultra) now actually use the core they were always documented to use.
- [x] **Keyboard shortcut isolation**: The global keydown listener that handles RetroVault shortcuts (F1/F5/F7/F9/Esc) is now registered with `{ capture: true }`. In the browser's capture phase the listener fires before EmulatorJS's element-level handler. For each matched shortcut `e.stopPropagation()` is called so the event is consumed and never reaches the emulator. All other keys (game-control inputs such as arrows and letter keys) are untouched — `stopPropagation()` is not called for them, so they continue down to the emulator as expected.
- [x] **Escape key default prevented**: `e.preventDefault()` added to the Escape shortcut handler (was missing), preventing the browser's built-in "unfocus / cancel" behaviour from firing alongside the library-return action.
- [x] **F9 shortcut documented**: F9 (open Debug Settings tab, always active regardless of emulator state) added to the keyboard shortcuts table in the README.
- [x] **README overhaul (Phase 5.2)**: Added PS1 core note explaining the `retroarch_core` override; updated Controls section with keyboard-shortcut interception details; corrected in-game header controls table to include F9; added blockquote explaining how RetroVault shortcuts and game-input keys coexist without conflict.

---

## Phase 6 — Multiplayer & Social (In Progress)

Networked features requiring server infrastructure.

- [x] **NetplayManager**: `NetplayManager` class wires the EmulatorJS built-in Netplay feature into RetroVault — manages server URL, ICE server list, per-game numeric ID derivation (djb2 hash), and localStorage persistence; Netplay button appears in the emulator toolbar when enabled and a server URL is set
- [ ] **WebRTC peer-to-peer**: PSP ad-hoc / N64 NetPlay over WebRTC using a STUN/TURN relay; no dedicated game server needed
- [ ] **Lobby browser**: WebSocket-based matchmaking room list for users who want to join ongoing sessions
- [ ] **Spectator mode**: Read-only WebRTC stream of a running session for watch parties

---

## Phase 7 — WebGPU Native Path (Complete)

WebGPU integration for post-processing, async GPU readback, and future rendering support.

- [ ] **Retire WebGL 2 for 3D cores**: Port PPSSPP-Web and mupen64plus-Next to emit WebGPU command buffers natively (requires upstream changes in EmulatorJS / libretro)
- [x] **WebGPU post-processing pipeline**: `WebGPUPostProcessor` class captures the WebGL canvas via `copyExternalImageToTexture()` (GPU-side, zero CPU readback) and applies WGSL fragment shaders — CRT simulation (scanlines, barrel distortion, phosphor glow, vignette) and edge-aware sharpening; toggled per-session in Settings; overlay canvas architecture avoids interfering with EmulatorJS rendering
- [x] **LCD shadow-mask effect**: WGSL fragment shader simulates an RGB sub-pixel grid and horizontal row-gap lines, reproducing the look of a handheld LCD display; `lcdShadowMask` (0–1) and `lcdPixelScale` parameters exposed in `PostProcessConfig`
- [x] **Bloom effect**: Single-pass 8-tap cross + diagonal Gaussian approximation extracts bright pixels above a configurable threshold and additively blends the glow back onto the scene; `bloomThreshold` and `bloomIntensity` parameters
- [x] **FXAA (Fast Approximate Anti-Aliasing)**: Single-pass WGSL shader implementing Lottes-style luminance-based edge detection; cardinal-neighbour luma sampling, sub-pixel alias estimation, and edge-direction blend; `fxaaQuality` parameter controls edge-detection sensitivity; 4–6 texture samples per fragment with near-zero overhead on any GPU tier
- [x] **GPU readback elimination**: `captureScreenshotAsync()` copies the post-processed frame to a staging `GPUBuffer` and maps it asynchronously via `mapAsync()`, completely avoiding the synchronous GPU stall of `canvas.toBlob()` / `gl.readPixels()`; auto-save and save-state thumbnails use the async path when WebGPU is active
- [x] **GPU timestamp profiling**: `WebGPUPostProcessor` optionally inserts `timestamp-query` writes at the start and end of each render pass; timestamps are resolved to a `GPUBuffer`, read back asynchronously once per 60 frames, and exposed via the `lastGPUFrameTimeMs` getter; silently no-ops on devices that do not expose the feature
- [x] **Bind group caching**: The `GPUBindGroup` wrapping the source texture, sampler, and uniform buffer is created once and reused across frames; invalidated only when the source texture handle is replaced (canvas resize or effect switch); eliminated the single largest per-frame GPU object allocation
- [x] **WebGPU type safety**: Added `@webgpu/types` as a dev dependency and configured `tsconfig.json`; replaced inline `any` casts with proper WebGPU types throughout `emulator.ts`; WebGPU enum constants (`GPUShaderStage`, `GPUBufferUsage`, etc.) defined as numeric values to allow the pipeline to be tested in jsdom without runtime WebGPU
- [x] **Tier-aware post-processing**: `adjustConfigForTier()` automatically reduces effect intensity on low/medium-tier devices — bloom is capped or disabled, curvature and scanline effects are softened — ensuring post-processing never drops below playable framerates on weaker hardware

---

## Phase 7.1 — 3D Emulator Overhaul (Complete)

Comprehensive overhaul of all 3D system emulators with improved tier tuning,
enhanced GPU benchmarking, and deeper debug/diagnostic infrastructure.

### GPU Benchmark & Tier Classification

- [x] **Logarithmic GPU scoring**: Replaced linear `drawCalls / 10000` with `log10(drawCalls) * 21.5` scoring — better discrimination across the full GPU spectrum from software renderers (~10 pts) to high-end desktops (~100 pts); mid-range GPUs that were compressed into the same band now receive meaningfully different scores
- [x] **ETC2 / ASTC texture compression detection**: `probeGPU()` now independently detects ETC2 (`WEBGL_compressed_texture_etc`) and ASTC (`WEBGL_compressed_texture_astc`) extensions, surfaced as `gpuCaps.etc2Textures` / `gpuCaps.astcTextures` and as tier bonus points (+1 / +2)
- [x] **VRAM estimation heuristic**: `estimateVRAM()` approximates available GPU memory from `maxTextureSize`, MRT colour attachment count, and compression extension support; exposed as `deviceCaps.estimatedVRAMMB` and surfaced in the Performance and Debug settings tabs
- [x] **Tier-scaled shader cache**: `ShaderCache.setTier()` dynamically adjusts the GLSL program cap (16 → 128) and WGSL module cap (8 → 64) based on device tier; pre-compilation poll interval adapts from 16 ms (low) to 4 ms (high/ultra) to balance CPU load

### 3D System Tier Overhaul

- [x] **PSP**: High tier now uses 8× anisotropic filtering (was 4×) and reduced inflight frames (2 vs 3) for tighter input latency; ultra tier locks PSP CPU to 222 MHz for broader game compatibility
- [x] **N64**: Medium tier switches to `FromMem` depth RDRAM (was `Software`) for better compatibility; high tier adds texture enhancement mode; ultra tier enables N64 depth compare and 4000-entry texture cache for highest accuracy
- [x] **PS1**: Medium tier raises CD fast-load to 6× and improves dither mode; high tier adds adaptive smoothing; ultra tier uses 4× internal resolution (was 8× — diminishing returns above 4×) with super-sampling enabled for best anti-aliasing
- [x] **NDS**: Ultra tier corrects core count from 4 → 2 (DeSmuME gains no benefit from >2 cores); high/ultra tiers add pointer type and microphone support
- [x] **Saturn**: Medium/high/ultra tiers add horizontal colour blending; high/ultra tiers skip MD5 calculation for faster disc loads
- [x] **Dreamcast**: Medium tier raises texture upscaling to 2× (was 1×); high/ultra tiers add triangle-sorted alpha blending and disabled frame-swap delay for lower input latency; ultra tier reduces texture upscaling to 2× (was 4× — excessive on DC)

### Audio & Adaptive Quality

- [x] **N64 audio adaptation**: High-latency audio hardware (Bluetooth, USB DACs) now triggers an enlarged audio buffer (`mupen64plus-audio-buffer-size: 2048`) to prevent crackles during gameplay
- [x] **PS1 audio adaptation**: High-latency hardware forces synchronous CD access (`beetle_psx_cd_access_method: sync`) to prevent audio desync from async disc reads racing the output thread

### Debug & Diagnostics

- [x] **Diagnostic event timeline**: `PSPEmulator.logDiagnostic()` records timestamped events (categories: performance, audio, render, system, error) into a capped ring buffer (200 events); displayed in the Debug settings tab with category badges and timestamps; included in "Copy Debug Info" clipboard export
- [x] **Enhanced Debug tab**: New "GPU & Memory" section displays GPU renderer string, estimated VRAM, max texture size, compressed texture support (ETC2/ASTC), MRT attachment count, and multi-draw status; diagnostic timeline section shows last 20 events with colour-coded badges
- [x] **Expanded debug info export**: "Copy Debug Info" now includes estimated VRAM, ETC2/ASTC status, MRT attachment count, multi-draw support, and the full diagnostic event timeline (last 50 events) for comprehensive bug reports
- [x] **Performance tab VRAM display**: Estimated VRAM surfaced alongside max texture size in the Performance settings tab device info section

---

## Phase 8 — Advanced 3D Rendering & Quality (Planned)

Next-generation rendering improvements for the three primary 3D systems (PSP, N64, PS1).

### Rendering Pipeline

- [ ] **Upscaling shaders**: Implement FSR 1.0 (AMD FidelityFX Super Resolution) as a WGSL compute shader; runs as a post-process pass after the core renderer; takes the core's native or 2× output and upscales to display resolution with edge-aware sharpening; controllable quality slider in Settings
- [ ] **Temporal anti-aliasing (TAA)**: Lightweight TAA pass that blends the current frame with a motion-compensated history buffer; reduces temporal aliasing (shimmer) on PSP and N64 games where geometry edges flicker at non-native resolutions; opt-in via Settings, disabled by default on low/medium tiers
- [ ] **Resolution scaling presets**: "Native", "2× Crisp", "4× Ultra", "Display Match" presets that combine internal resolution, upscale shader, and AA settings into one-click configurations per system
- [ ] **Dynamic resolution scaling (DRS)**: When FPS drops below the target for 2+ seconds, automatically lower the internal resolution by one step and re-raise when headroom is detected; entirely transparent to the user; logged in the diagnostic timeline
- [ ] **Per-game graphics profiles**: Allow users to override tier settings on a per-game basis (e.g. force 1× resolution for a demanding PSP title while keeping 4× for lighter games); stored in localStorage, surfaced in a "Game Settings" overlay accessible from the emulator toolbar

### Texture Management

- [ ] **Texture replacement packs**: Load high-resolution replacement textures from user-uploaded ZIP archives; replacement textures matched by hash; supported for PSP (PPSSPP native format) and N64 (Rice/GLideN64 format)
- [ ] **Texture prefetching**: Analyse the first 30 seconds of gameplay to identify frequently loaded textures; preload those textures into the GPU cache on subsequent launches to eliminate mid-game texture pop-in
- [ ] **Compressed texture streaming**: On devices with ETC2/ASTC support, transcode textures on-the-fly to compressed GPU formats, reducing VRAM usage by 4–8× and improving fill-rate-limited scenarios

### Audio Enhancement

- [ ] **Audio enhancement filters**: Optional low-pass filter to smooth the characteristic "crunchiness" of PSP and N64 audio output; adjustable cutoff frequency in Settings
- [ ] **Spatial audio**: Binaural spatialization for games that use stereo positioning (PSP, Dreamcast); implemented as an AudioWorklet filter node; toggled in Display settings

---

## Phase 9 — Intelligent Performance Optimization (Planned)

Data-driven and heuristic approaches to automatically tune emulator settings.

### Adaptive Tuning

- [ ] **Game compatibility database**: Community-maintained JSON file mapping game IDs to known-good tier overrides, required BIOS, and known issues; bundled with the app and checked at launch to pre-select optimal settings
- [ ] **Thermal-aware throttling**: On devices that expose the Compute Pressure API, monitor thermal state and proactively lower the tier before the OS forces CPU/GPU throttling; log thermal events in the diagnostic timeline
- [ ] **Memory pressure detection**: Monitor `performance.measureUserAgentSpecificMemory()` (where available) and reduce texture cache sizes, disable texture scaling, or lower internal resolution when the JS heap approaches the limit; surface warnings in the debug panel
- [ ] **Startup profiler**: Measure and log every phase of game launch (core download, WASM compile, BIOS load, first frame) with high-resolution timestamps; identify the slowest phase and surface actionable suggestions (e.g. "BIOS load took 2.3 s — consider uploading a smaller BIOS")
- [ ] **FPS prediction**: Use the first 5 seconds of gameplay FPS data to predict whether the current tier will sustain 60 fps; if prediction is below threshold, offer an immediate tier downgrade instead of waiting for the 10-second low-FPS trigger

### Caching & Preloading

- [ ] **Intelligent core preloading**: Track which systems the user launches most frequently (from library metadata); on app startup, prefetch the top-2 cores to browser HTTP cache in the background; saves 5–15 seconds on the next game launch
- [ ] **Shader warmup from gameplay**: Record the exact shader programs compiled during the first 60 seconds of each game; on subsequent launches of the same game, pre-compile exactly those shaders (not the generic set) for a more targeted warmup
- [ ] **WASM compilation caching**: Detect whether the browser supports `WebAssembly.compileStreaming()` caching via HTTP cache headers; if the CDN does not set appropriate cache headers, use an IndexedDB-backed WASM module cache as a fallback

---

## Phase 10 — Community, Accessibility & Ecosystem (Planned)

Features that grow the user base and make RetroVault accessible to everyone.

### Accessibility

- [ ] **Screen reader support**: Add ARIA labels, roles, and live regions to the library grid, settings panel, and emulator controls; ensure all interactive elements are keyboard-navigable
- [ ] **High contrast mode**: Detect `prefers-contrast: more` and switch to a high-contrast CSS theme with larger touch targets and bolder text
- [ ] **Colourblind-safe badges**: Replace the colour-only system badges with icon + colour combinations that remain distinguishable under protanopia, deuteranopia, and tritanopia
- [ ] **Reduced motion compliance**: When `prefers-reduced-motion: reduce` is active, disable all CSS transitions, the FPS overlay animation, and the audio visualiser oscilloscope; already partially implemented for the tier badge

### Community Features

- [ ] **Game rating & notes**: Allow users to rate games (1–5 stars) and attach text notes; stored in IndexedDB alongside game metadata; surfaced on library cards
- [ ] **Share configurations**: Export a game's tier overrides, graphics settings, and control layout as a JSON file; another user can import it to replicate the exact setup
- [ ] **Community compatibility reports**: Optional anonymous telemetry (opt-in) that reports game ID + system + tier + average FPS; aggregated data used to build the game compatibility database (Phase 9)

### Platform Expansion

- [ ] **Electron wrapper**: Package RetroVault as a native desktop app via Electron; enables SharedArrayBuffer without service-worker workarounds, native filesystem access for ROMs, and system-tray integration
- [ ] **Android TWA**: Publish RetroVault as a Trusted Web Activity on the Google Play Store; the PWA runs in a full-screen Chrome tab with native-app-like install/update lifecycle
- [ ] **Gamepad API enhancements**: Full support for the Gamepad API including analog stick calibration, vibration (dual-rumble where supported), and per-game button remapping; control mapping editor in Settings
- [ ] **Cloud save backends**: Implement Google Drive, Dropbox, and WebDAV adapters for the existing `CloudSyncInterface`; bidirectional sync with conflict resolution; end-to-end encryption of save data

### Developer Experience

- [ ] **Plugin API**: Define a stable plugin interface that allows third-party extensions to register custom post-processing shaders, alternative UI themes, and system-specific overlays; plugins loaded as ES modules from user-specified URLs
- [ ] **Debug console**: In-game overlay console (toggle with backtick/tilde) showing live core-option values, FPS graph, audio buffer occupancy, and the diagnostic event timeline; supports runtime core-option changes for rapid experimentation
- [ ] **Automated regression testing**: Headless Playwright test suite that boots representative ROMs from each 3D system, captures FPS after 10 seconds, and asserts above a minimum threshold; runs on CI to catch performance regressions

---

## Performance Targets

| Metric | Current | Target | Notes |
|--------|---------|--------|-------|
| First meaningful paint | ~200 ms | ≤100 ms | Reduce initial bundle, defer non-critical CSS |
| PSP game boot (cached core) | ~3 s | ≤1.5 s | Shader pre-warm + WASM cache |
| PSP game boot (uncached core, fast connection) | ~15 s | ≤8 s | Intelligent core preloading |
| Audio base latency (low-latency HW) | ~12–20 ms | ≤8 ms | AudioWorklet + adaptive buffer |
| FPS overlay CPU overhead | ~0.1 ms/frame | ≤0.05 ms/frame | Zero-GC ring buffer (done) |
| Initial JS bundle | ~80 KB gzip | ≤40 KB gzip | Aggressive code splitting |
| IndexedDB cold-open (first ROM add) | ~80 ms | ≤20 ms | Warm IDB connection at startup |
| GPU benchmark duration | ~12 ms | ≤8 ms | Adaptive budget based on warmup |
| Shader cache pre-compile (50 programs) | ~200 ms | ≤100 ms | KHR_parallel_shader_compile + tier-adaptive polling |
| Post-process frame time (CRT + bloom) | ~2 ms | ≤1 ms | Bind group caching + tier reduction |
| N64 sustained FPS (medium tier, 1× res) | ~45–55 fps | ≥58 fps | Optimised GLideN64 settings |
| PS1 sustained FPS (high tier, 2× res) | ~50–55 fps | ≥58 fps | PGXP + GTE overclock tuning |
| Diagnostic timeline overhead | N/A | ≤0.01 ms/event | Append-only array, capped at 200 |

---

## How to Contribute

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for code style, branching, and PR guidelines. Performance improvements must include a benchmark or empirical measurement in the PR description. New system support requires at minimum a `tierSettings` table with Low / Medium / High / Ultra entries.
