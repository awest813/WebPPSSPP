# RetroVault Roadmap

This document tracks planned improvements, experiments under investigation, and longer-term vision items.
Entries move from *Planned* → *In Progress* → *Done* as work happens.

Items within each phase are roughly ordered by expected impact.

---

## Project Status

| Phase | Title | Status |
|-------|-------|--------|
| 1 | Foundation | ✅ Complete |
| 2 | 3D Rendering & Audio Quality | ✅ Complete |
| 3 | Platform & Compatibility | ✅ Complete |
| 4 | Save & State Management | ✅ Complete |
| 5 | Mobile & PWA | ✅ Complete |
| 5.1 | Polish & Performance | ✅ Complete |
| 5.2 | Core Correctness & Keyboard Controls | ✅ Complete |
| 6 | Multiplayer & Social | ✅ Complete |
| 7 | WebGPU Native Path | ✅ Complete |
| 7.1 | 3D Emulator Overhaul | ✅ Complete |
| 8 | Advanced 3D Rendering & Quality | 🔜 Next |
| 9 | Intelligent Performance Optimization | 📋 Planned |
| 10 | Community, Accessibility & Ecosystem | 📋 Planned |

---

## Phase 1 — Foundation (Complete)

Core infrastructure shipped in the initial release.

- [x] EmulatorJS multi-system integration (PSP, N64, PS1, NDS, GBA, SNES, NES, Genesis, ...)
- [x] Hardware tier classification (Low / Medium / High / Ultra) via WebGL benchmark + CPU/RAM heuristics
- [x] Per-system, per-tier RetroArch core option tables (PSP, N64, PS1, NDS, GBA)
- [x] ROM library with IndexedDB blob persistence and metadata cache
- [x] Cross-origin isolation via `coi-serviceworker.js` (enables SharedArrayBuffer / PSP threads)
- [x] FPS monitor — zero-GC ring-buffer rAF loop with dropped-frame tracking
- [x] WebGL driver pre-warming (shader compile + draw call before first game launch)
- [x] CDN preconnect + prefetch for `loader.js` and WASM cores
- [x] Page Visibility API auto-pause (saves battery when tab is hidden)
- [x] WebGL context-loss detection and graceful recovery prompt
- [x] Battery Status API integration — auto-switch to Performance mode at ≤20%
- [x] Chromebook (CrOS) penalty in tier classification

---

## Phase 2 — 3D Rendering & Audio Quality (Complete)

Improvements to visual fidelity and audio latency for 3D-heavy systems.

### 3D Rendering

- [x] **PSP ultra tier**: 5× xBRZ texture scaling, GPU-side xBRZ texture shader, 16× anisotropic filtering, PSP CPU locked to full 333 MHz
- [x] **PSP medium tier**: 2× anisotropic filtering (near-free on any discrete GPU)
- [x] **N64 high tier**: Smooth filtering 1 texture pass (removes pixel crawl at 2× res)
- [x] **N64 ultra tier**: Smooth filtering 4 + texture enhancement mode at 4× internal resolution
- [x] **PS1 high tier**: 4× GPU overclock, PGXP memory mode (fixes wobbly polygon geometry)
- [x] **PS1 ultra tier**: 4× internal resolution, Memory + CPU PGXP, 8× GPU overclock, GTE overclock (best accuracy; reduces polygon wobble and improves animation smoothness)
- [x] **GPU benchmark**: VAO-aware draw-call benchmark (more realistic 3D workload proxy)
- [x] **GPU capability detection**: Multi-Draw, MRT, VAO, compressed textures, half-float textures — all surfaced as tier-bonus points
- [x] **Shader cache**: Persist GLSL shader strings to IndexedDB (`retrovault-shaders`); pre-compile via `KHR_parallel_shader_compile`; LRU eviction at 64 programs; djb2 keying
- [x] **WebGPU rendering path**: `preWarmWebGPU()` acquires a `GPUDevice`; toggled in Settings; falls back silently to WebGL
- [x] **PSP Vulkan-style pipeline warm-up**: Pre-compiles 5 representative PSP GPU shader patterns on a throw-away GL context

### Audio

- [x] **Audio latency adapter**: Probes `AudioContext.baseLatency`; promotes buffer size for high-latency hardware (Bluetooth, USB DACs)
- [x] **PSP medium tier audio resampling**: Enabled; improves music quality with negligible CPU overhead
- [x] **AudioWorklet path**: `setupAudioWorklet()` runs in a dedicated thread for ~5–10 ms lower latency; underrun events posted back via `MessagePort`
- [x] **Dynamic audio buffer sizing**: Monitors consecutive silent frames to detect underruns; exposed via `emulator.onAudioUnderrun` callback
- [x] **Audio visualiser overlay**: Optional oscilloscope embedded in the FPS overlay; draws time-domain waveform at ≤30 fps

### Adaptive Quality

- [x] **Low-FPS detector**: Sustained <25 FPS for ~5 s triggers `onLowFPS` callback (reduced from 10 s for faster user feedback)
- [x] **Auto tier downgrade**: Non-blocking confirmation dialog; re-launches at one tier lower; saves downgraded tier as per-game profile
- [x] **Per-game performance profile**: `saveGameTierProfile()` / `getGameTierProfile()` persist last stable tier per game in `localStorage`

---

## Phase 3 — Platform & Compatibility (Complete)

Broader system support and compatibility improvements.

- [x] **Additional systems**: Saturn (Beetle Saturn), Dreamcast (Flycast), MAME 2003+, Atari 7800, Lynx, Neo Geo Pocket — 6 new systems with tier-aware core options
- [x] **BIOS management**: `BiosLibrary` persists BIOS blobs in IndexedDB; known requirements for PS1, Saturn, Dreamcast, Lynx; per-file status dots and upload controls
- [x] **CHD compression**: Accepted for PS1, Saturn, and Dreamcast; cores decompress natively via libchdr WASM
- [x] **ZIP / 7z / RAR transparency**: Pure-JS ZIP parser + libunrar.js worker; first ROM-compatible entry auto-selected; clear error for truly unsupported formats
- [x] **Soft-patch support**: Full IPS (RLE + post-EOF), BPS (VLQ, all action types, 3-CRC), and UPS (XOR hunks + CRC); per-game patch button on library cards
- [x] **Multi-disc games**: `.m3u` for PS1, Saturn, Dreamcast; `showMultiDiscPicker()` collects missing disc files; synthetic `.m3u` with blob URLs passed to EmulatorJS

---

## Phase 4 — Save & State Management (Complete)

Improved persistence, portability, and crash-recovery for save data.

- [x] **Save state export/import**: `SaveStateLibrary` with IndexedDB blob storage; per-slot `.state` file export/import
- [x] **Save state gallery**: 160×120 JPEG thumbnails, timestamps, 5-slot UI (auto-save + 4 manual)
- [x] **Auto-save on tab close**: `beforeunload` + `visibilitychange:hidden` → slot 0; crash-recovery restore prompt on next launch
- [x] **Save data migration**: "Migrate Saves" tool in Settings panel re-keys states when a ROM is renamed
- [x] **Cloud save sync**: WebDAV adapter with conflict resolution; extensible `CloudSaveProvider` interface; `NullCloudProvider` no-op for testing
- [x] **Save versioning**: `SAVE_FORMAT_VERSION`, djb2 checksum, gzip compression with fallback for forward-compatible save files

---

## Phase 5 — Mobile & PWA (Complete)

First-class mobile experience and installability.

- [x] **Progressive Web App**: Combined COI + PWA service worker; app-shell caching; "Install RetroVault" button in Settings
- [x] **Touch control layout editor**: 12 draggable virtual buttons; positions persisted per system and per orientation
- [x] **Haptic feedback**: `navigator.vibrate(12)` on press, `vibrate(6)` on release; toggled in Settings
- [x] **Orientation lock**: `screen.orientation.lock("landscape-primary")` on game start; graceful no-op on iOS/desktop
- [x] **iOS Safari improvements**: `credentialless` COEP for CDN compatibility on Safari 17+ / iOS 17+
- [x] **Reduced initial bundle**: Dynamic `import()` for `archive.ts`, `patcher.ts`, `touchControls.ts`; Vite `manualChunks` for `tools` and `touch` chunks
- [x] **Portrait mode touch controls**: Per-orientation layouts with separate `localStorage` keys; auto-rebuild on `orientationchange`/`resize`

---

## Phase 5.1 — Polish & Performance (Complete)

Bug fixes, performance improvements, and quality-of-life enhancements.

- [x] **Fix auto-save restore handler leak**: One-shot `retrovault:gameStarted` event listener replaces monkey-patching
- [x] **O(1) system lookup**: Pre-built `Map<string, SystemInfo>` replaces `SYSTEMS.find()` linear search on the hot launch path
- [x] **FPS monitor bind optimisation**: `this._tick.bind(this)` moved from `start()` to constructor — one allocation instead of one per game launch
- [x] **Shader cache eviction**: LRU eviction runs every 10 writes instead of every `record()` call
- [x] **Info toast notifications**: `showInfoToast()` for success messages with 5-second auto-dismiss
- [x] **Blob creation efficiency**: `stateBytes.buffer as ArrayBuffer` replaces `stateBytes.slice().buffer` double-copy
- [x] **FPS monitor adaptive callback**: Fires every 10 frames normally; widens to 30 after 3 consecutive healthy callbacks (≥55 fps); narrows immediately on FPS drop

---

## Phase 5.2 — Core Correctness & Keyboard Controls (Complete)

Fixes for silent bugs where the wrong PS1 core was used and keyboard shortcuts leaked into the emulator.

- [x] **PS1 core fix**: All Beetle PSX HW tier options now inject `retroarch_core: "mednafen_psx_hw"` so EmulatorJS always uses Beetle PSX HW, not the default PCSX ReARMed
- [x] **Keyboard shortcut isolation**: Global keydown listener registered with `{ capture: true }`; `stopPropagation()` on matched shortcuts prevents them reaching EmulatorJS
- [x] **Escape key default prevented**: `preventDefault()` added to Escape shortcut handler
- [x] **F9 shortcut**: Opens Debug Settings tab regardless of emulator state

---

## Phase 6 — Multiplayer & Social (Complete)

Networked features for real-time multiplayer gaming.

- [x] **NetplayManager**: Wires EmulatorJS built-in Netplay into RetroVault; manages server URL, ICE servers, game ID derivation (djb2), and persistence
- [x] **NETPLAY_SUPPORTED_SYSTEM_IDS**: PSP, N64, NDS explicitly supported; DS wires EJS globals at launch
- [x] **Username management**: `validateUsername()`, `netplayUsername` in Settings, `EJS_playerName` wired in emulator
- [x] **Lobby browser foundation**: `fetchLobbyRooms()` probes `/rooms`, `/lobby/rooms`, `/netplay/rooms`; normalises payload shapes; resilient to network failures
- [x] **ICE server management**: Custom STUN/TURN entry UI (`#netplay-ice-add`); ICE list persisted in Settings
- [x] **NetplayMetricsCollector**: Incremental running sums (O(1) snapshot); `NetplaySessionMetrics` and `netplayErrorMessage()` exported
- [x] **WebRTC peer-to-peer data channels**: `PeerDataChannel` class in `src/netplay/peerChannel.ts`; bidirectional typed messages (ping/pong, state, input, chat); `SpectatorChannel` for read-only receive; graceful `RTCPeerConnection` negotiation (offer/answer/ICE) with auto-reconnect
- [x] **Lobby browser UI**: Host / Join / Browse / Watch four-tab modal; Browse panel has room cards with Quick Join and Watch buttons, filter by Nearby / This Game / All Rooms, and auto-refresh every 30 s with live countdown
- [x] **Spectator mode**: `watchRoom()` on `EasyNetplayManager` joins as read-only spectator; `"spectating"` → `"watching"` state machine; `spectator_joined` event; Watch tab in the multiplayer modal with leave/stop-watching button
- [ ] **Rollback netcode**: Frame-delay + rollback for low-latency gameplay on lossy connections (long-term)

---

## Phase 7 — WebGPU Native Path (Complete)

WebGPU integration for post-processing, GPU readback, and rendering pipeline foundations.

- [x] **WebGPU post-processing pipeline**: `WebGPUPostProcessor` — CRT scanlines, barrel distortion, edge-aware sharpening
- [x] **LCD shadow-mask effect**: RGB sub-pixel grid + horizontal row-gap lines
- [x] **Bloom effect**: Single-pass 8-tap Gaussian; `bloomThreshold` + `bloomIntensity` parameters
- [x] **FXAA**: Single-pass WGSL Lottes-style luminance edge detection; 4–6 samples per fragment
- [x] **GPU readback elimination**: Async `mapAsync()` screenshot path avoids synchronous GPU stall
- [x] **GPU timestamp profiling**: `timestamp-query` at render pass start/end; resolved asynchronously once per 60 frames
- [x] **Bind group caching**: `GPUBindGroup` created once per texture handle; invalidated only on resize or effect switch
- [x] **WebGPU type safety**: `@webgpu/types` dev dependency; all `any` casts replaced with proper WebGPU types
- [x] **Tier-aware post-processing**: `adjustConfigForTier()` caps bloom and softens effects on low/medium devices
- [ ] **Retire WebGL 2 for 3D cores**: Port PPSSPP-Web and mupen64plus-Next to emit WebGPU command buffers natively (requires upstream EmulatorJS / libretro changes)

---

## Phase 7.1 — 3D Emulator Overhaul (Complete)

Comprehensive overhaul of all 3D system emulators with improved tier tuning, GPU benchmarking, and diagnostics.

### GPU Benchmark & Tier Classification

- [x] **Logarithmic GPU scoring**: `log10(drawCalls) * 21.5` — better discrimination across the full GPU spectrum
- [x] **ETC2 / ASTC detection**: Surfaced as `gpuCaps.etc2Textures` / `gpuCaps.astcTextures` and tier bonus points
- [x] **VRAM estimation**: `estimateVRAM()` approximates GPU memory from `maxTextureSize`, MRT count, and compression support
- [x] **Tier-scaled shader cache**: GLSL cap 16→128, WGSL cap 8→64; poll interval adapts from 16 ms (low) to 4 ms (ultra)

### 3D System Tier Overhaul

- [x] **PSP**: High tier — 8× anisotropic filtering, 2 inflight frames; ultra — CPU locked to 222 MHz
- [x] **N64**: Medium — `FromMem` depth RDRAM; high — texture enhancement; ultra — depth compare + 4000-entry texture cache
- [x] **PS1**: Medium — 6× CD fast-load; high — adaptive smoothing; ultra — 4× res + super-sampling
- [x] **NDS**: Ultra core count corrected (4→2); high/ultra — pointer type + microphone support
- [x] **Saturn**: Medium/high/ultra — horizontal colour blending; high/ultra — skip MD5 for faster disc loads
- [x] **Dreamcast**: Medium — 2× texture upscaling; high/ultra — triangle-sorted alpha + no frame-swap delay

### Audio & Adaptive Quality

- [x] **N64 audio adaptation**: Bluetooth/USB DAC hardware triggers enlarged audio buffer
- [x] **PS1 audio adaptation**: High-latency hardware forces synchronous CD access to prevent desync

### Debug & Diagnostics

- [x] **Diagnostic event timeline**: 200-event ring buffer with category badges (performance, audio, render, system, error)
- [x] **Enhanced Debug tab**: GPU renderer, estimated VRAM, max texture size, ETC2/ASTC, MRT count, multi-draw
- [x] **Expanded "Copy Debug Info"**: Includes VRAM, compression support, multi-draw, and last 50 timeline events
- [x] **Performance tab VRAM display**: Estimated VRAM alongside max texture size

---

## Phase 8 — Advanced 3D Rendering & Quality (Next)

Next-generation rendering improvements for the primary 3D systems.
Phase 8 is the immediate successor to Phase 6 and builds directly on the
WebGPU rendering pipeline completed in Phase 7/7.1.

**Recommended start order:**
1. Dynamic resolution scaling (DRS) — highest impact for low-end devices
2. FSR 1.0 upscaling — quality improvement on all tiers
3. Per-game graphics profiles — enables granular user control
4. Texture replacement packs — community content
5. TAA / audio filters — optional polish

### Rendering Pipeline

- [x] **FSR 1.0 upscaling**: AMD FidelityFX Super Resolution-inspired WGSL fragment shader (EASU + RCAS); `fsrSharpness` config param; tier-aware sharpness reduction; available in Settings and per-game graphics dialog
- [ ] **Temporal anti-aliasing (TAA)**: Lightweight frame-blend pass to reduce shimmer on PSP and N64; opt-in via Settings; disabled on Low/Medium
- [x] **Resolution scaling presets**: "Native", "2× Crisp", "4× Ultra", "Display Match" — `ResolutionPreset` type + `getResolutionCoreOptions()` in `performance.ts`; applied via `coreSettingsOverride` in `LaunchOptions`
- [x] **Dynamic resolution scaling (DRS)**: Auto-lower internal resolution after 2 seconds below 25 FPS; auto-raise after 10 seconds above 55 FPS; logged in diagnostic timeline; `onDRSChange` callback; `enableDRS()` / `isDRSEnabled` on `PSPEmulator`
- [x] **Per-game graphics profiles**: `PerGameGraphicsProfile` (resolution preset, post-effect override, DRS toggle) stored in `localStorage`; "🎨 Graphics" button in emulator toolbar; accessible from the in-game toolbar; `getGameGraphicsProfile` / `saveGameGraphicsProfile` / `clearGameGraphicsProfile` in `library.ts`

### Texture Management

- [ ] **Texture replacement packs**: User-uploaded ZIP with high-res replacements; matched by hash; PSP (PPSSPP native) and N64 (Rice/GLideN64) formats
- [ ] **Texture prefetching**: Profile first 30 s of gameplay; preload frequently-used textures on subsequent launches
- [ ] **Compressed texture streaming**: Transcode to ETC2/ASTC on devices that support it; reduce VRAM usage 4–8×

### Audio Enhancement

- [ ] **Audio enhancement filters**: Optional low-pass filter for PSP/N64 audio crunch; adjustable cutoff in Settings
- [ ] **Spatial audio**: Binaural spatialization as an AudioWorklet filter node for stereo-positioned games; toggled in Settings

---

## Phase 9 — Intelligent Performance Optimization (Planned)

Data-driven and heuristic approaches to automatically tune emulator settings.

### Adaptive Tuning

- [ ] **Game compatibility database**: Community JSON mapping game IDs to known-good tier overrides, required BIOS, and known issues; checked at launch
- [ ] **Thermal-aware throttling**: Compute Pressure API monitoring; proactive tier reduction before OS-forced throttling; logged in diagnostic timeline
- [ ] **Memory pressure detection**: `performance.measureUserAgentSpecificMemory()` monitoring; reduce texture caches or lower resolution near JS heap limit
- [ ] **Startup profiler**: High-resolution timestamp per launch phase (core download, WASM compile, BIOS load, first frame); surface slowest phase in UI
- [ ] **FPS prediction**: Use first 5 s of gameplay to predict if current tier will sustain 60 fps; offer immediate downgrade if prediction is below threshold

### Caching & Preloading

- [ ] **Intelligent core preloading**: Track most-launched systems; background-prefetch top-2 cores at startup; saves 5–15 s on next launch
- [ ] **Per-game shader warmup**: Record exact programs compiled during first 60 s of each game; pre-compile those on subsequent launches
- [ ] **WASM compilation caching**: IndexedDB-backed `WebAssembly.Module` cache as fallback when CDN cache headers are insufficient
- [ ] **Capability cache TTL**: `detectCapabilitiesCached()` uses `sessionStorage` under key `retrovault-devcaps-v1`; expose a settings button to clear and re-run detection

---

## Phase 10 — Community, Accessibility & Ecosystem (Planned)

Features that grow the user base and make RetroVault accessible to everyone.

### Accessibility

- [ ] **Screen reader support**: ARIA labels, roles, and live regions for library grid, settings panel, and emulator controls; full keyboard navigation
- [ ] **High contrast mode**: `prefers-contrast: more` CSS theme with larger touch targets and bolder text
- [ ] **Colourblind-safe badges**: Icon + colour system badge combinations distinguishable under protanopia, deuteranopia, and tritanopia
- [ ] **Reduced motion compliance**: Disable CSS transitions, FPS overlay animation, and audio visualiser when `prefers-reduced-motion: reduce`

### Community Features

- [ ] **Game rating & notes**: 1–5 star ratings and text notes in IndexedDB; surfaced on library cards
- [ ] **Share configurations**: Export a game's tier overrides + graphics settings + control layout as JSON; another user can import to replicate the setup
- [ ] **Community compatibility reports**: Opt-in anonymous telemetry (game ID + system + tier + average FPS) to build the Phase 9 compatibility database

### Platform Expansion

- [ ] **Electron wrapper**: Native desktop app; SharedArrayBuffer without service-worker workarounds; native filesystem ROM access
- [ ] **Android TWA**: Trusted Web Activity on Google Play; full-screen Chrome tab with native install/update lifecycle
- [ ] **Gamepad API enhancements**: Analog calibration, dual-rumble vibration, per-game button remapping; control mapping editor in Settings
- [ ] **Cloud save backends**: Google Drive, Dropbox, and WebDAV adapters for the `CloudSaveProvider` interface; end-to-end encryption; bidirectional sync with conflict resolution

### Developer Experience

- [ ] **Plugin API**: Stable interface for third-party extensions; register custom shaders, UI themes, and system-specific overlays; plugins loaded as ES modules
- [ ] **Debug console overlay**: In-game backtick/tilde overlay — live core-option values, FPS graph, audio buffer occupancy, and diagnostic timeline; supports runtime core-option changes
- [ ] **Automated regression testing**: Headless Playwright suite booting representative ROMs, capturing FPS after 10 s, and asserting above a minimum threshold; runs on CI

---

## Performance Targets

| Metric | Current | Target | Notes |
|--------|---------|--------|-------|
| First meaningful paint | ~200 ms | ≤100 ms | Reduce initial bundle, defer non-critical CSS |
| PSP game boot (cached core) | ~3 s | ≤1.5 s | Shader pre-warm + WASM cache |
| PSP game boot (uncached, fast connection) | ~15 s | ≤8 s | Intelligent core preloading |
| Audio base latency (low-latency HW) | ~12–20 ms | ≤8 ms | AudioWorklet + adaptive buffer |
| FPS overlay CPU overhead | ~0.1 ms/frame | ≤0.05 ms/frame | Zero-GC ring buffer (done) |
| Initial JS bundle | ~80 KB gzip | ≤40 KB gzip | Aggressive code splitting |
| IndexedDB cold-open (first ROM add) | ~80 ms | ≤20 ms | Warm IDB connection at startup |
| GPU benchmark duration | ~12 ms | ≤8 ms | Adaptive budget based on warmup |
| Shader cache pre-compile (50 programs) | ~200 ms | ≤100 ms | `KHR_parallel_shader_compile` + tier-adaptive polling |
| Post-process frame time (CRT + bloom) | ~2 ms | ≤1 ms | Bind group caching + tier reduction |
| N64 sustained FPS (medium tier, 1× res) | ~45–55 fps | ≥58 fps | Optimised GLideN64 settings |
| PS1 sustained FPS (high tier, 2× res) | ~50–55 fps | ≥58 fps | PGXP + GTE overclock tuning |
| Diagnostic timeline overhead | N/A | ≤0.01 ms/event | Append-only array, capped at 200 |

---

## How to Contribute

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for code style, branching, and PR guidelines.

- **Performance improvements** must include a benchmark or empirical measurement in the PR description.
- **New system support** requires a `tierSettings` table with Low / Medium / High / Ultra entries.
- **Bug fixes** for emulator correctness should include a regression test.
- **Documentation changes** do not need tests but must be accurate and consistent with code.
