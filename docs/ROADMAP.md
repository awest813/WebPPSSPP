# RetroOasis Roadmap

This document describes **what is shipped**, **what is being built next**, and **longer-term directions**. It is updated from the actual codebase state — not from prior planning documents — so contributors can trust what they find here.

The standalone `ROADMAP.md` (root) and `docs/UI_REFACTOR_PLAN.md` have been merged into this file to keep one source of truth.

---

## What's Shipped

All phases 1–9 listed in prior roadmaps are complete. Below is the current state grouped by subsystem.

### Emulation & Systems

- Multi-system integration via EmulatorJS stable CDN: PSP (PPSSPP), N64 (ParaLLEl N64), PS1 (PCSX ReARMed), NDS (DeSmuME 2015 pinned), GBA, SNES, NES, Genesis, Saturn (Yabause), Dreamcast (experimental Flycast), arcade (FBNeo / MAME 2003+), Atari 7800, Lynx, Neo Geo Pocket
- Hardware tier classification (Low / Medium / High / Ultra) via WebGL GPU benchmark + CPU/RAM heuristics
- Per-system, per-tier RetroArch core-option tables for all supported systems
- ROM library with IndexedDB blob storage and metadata cache
- Archive transparency: ZIP, 7z, RAR extraction before launch
- Soft-patching: full IPS, BPS, UPS with CRC verification
- Multi-disc `.m3u` support for PS1, Saturn, Dreamcast
- CHD compression accepted for PS1, Saturn, Dreamcast
- BIOS management: `BiosLibrary` with IndexedDB persistence, per-file status, upload controls
- Cross-origin isolation via `coi-serviceworker.js` (SharedArrayBuffer / PSP threads)
- FPS monitor: zero-GC ring-buffer rAF loop with dropped-frame tracking
- WebGL context-loss detection and graceful recovery
- Battery Status API integration (auto Performance mode at ≤20%)
- Chromebook tier penalty

### 3D Rendering & Post-Processing

- Tier-tuned 3D settings for PSP (xBRZ, anisotropic), N64 (ParaLLEl RDP scaling), PS1 (PCSX ReARMed compatibility profile), NDS, Saturn, Dreamcast
- GPU benchmark: VAO-aware draw-call benchmark, logarithmic scoring (`log10(drawCalls) * 21.5`)
- GPU capability detection: Multi-Draw, MRT, VAO, compressed textures (ETC2/ASTC), half-float — surfaced as tier-bonus points
- VRAM estimation from `maxTextureSize`, MRT count, compression
- Shader cache: IndexedDB-backed GLSL store, `KHR_parallel_shader_compile` pre-compile, LRU eviction, djb2 keying, tier-scaled caps (16–128 GLSL, 8–64 WGSL)
- Tier-scaled shader cache poll interval (4–16 ms)
- WebGPU rendering path: `preWarmWebGPU()` with silent WebGL fallback
- PSP Vulkan-style pipeline warm-up: 5 representative shader patterns on throw-away GL context
- WebGPU post-processing pipeline: CRT scanlines + barrel distortion, LCD shadow-mask, bloom (8-tap Gaussian), FXAA (Lottes-style luminance edge detection), FSR 1.0 upscaling (EASU + RCAS)
- Temporal anti-aliasing (TAA): frame-blend with configurable blend, history texture lifecycle
- Resolution scaling presets: Native, 2× Crisp, 4× Ultra, Display Match
- Dynamic resolution scaling (DRS): auto-lower on sustained <25 FPS, auto-raise on >55 FPS
- Per-game graphics profiles: resolution preset, post-effect overrides, DRS toggle in `localStorage`
- GPU readback elimination: async `mapAsync()` screenshot path
- GPU timestamp profiling (WebGPU): asynchronous, once per 60 frames
- Bind group caching: `GPUBindGroup` per texture handle, invalidated on resize/effect switch
- WebGPU type safety: `@webgpu/types` dev dependency, no `any` casts
- Tier-aware post-processing: `adjustConfigForTier()` caps bloom and softens effects on low/medium devices

### Audio

- Audio latency adapter: `AudioContext.baseLatency` probe, buffer promotion for Bluetooth/USB DACs
- AudioWorklet path: dedicated thread, ~5–10 ms lower latency, underrun events via `MessagePort`
- Dynamic audio buffer sizing: silent-frame monitoring, `emulator.onAudioUnderrun` callback
- Audio enhancement filters: `BiquadFilterNode` (lowpass/highpass) with adjustable cutoff
- Audio visualiser overlay: oscilloscope in FPS overlay, ≤30 fps
- Per-core audio adaptation for high-latency hardware

### Saves & Cloud

- Save state export/import: `SaveStateLibrary` with IndexedDB, per-slot `.state` files
- Save state gallery: 160×120 JPEG thumbnails, timestamps, 5 slots (auto-save + 4 manual)
- Auto-save on tab close: `beforeunload` + `visibilitychange:hidden` → slot 0, crash-recovery prompt
- Save data migration tool ("Migrate Saves" in Settings)
- Save versioning: format version, djb2 checksum, gzip compression
- Cloud save with **8 providers**: WebDAV, Google Drive, Dropbox, OneDrive, Box, pCloud, Blomp (OpenStack Swift), Mega (E2E encryption). Extensible `CloudSaveProvider` interface, OAuth support, conflict resolution, `NullCloudProvider` for testing.

### Mobile & PWA

- Combined COI + PWA service worker, app-shell caching, "Install RetroOasis" button
- Touch control layout editor: 12 draggable virtual buttons, positions per-system and per-orientation
- Haptic feedback (`navigator.vibrate`), orientation lock
- iOS Safari: `credentialless` COEP for CDN compatibility (Safari 17+ / iOS 17+)
- Reduced initial bundle: dynamic `import()` for archive/patcher/touch controls, Vite manual chunks
- Portrait mode touch controls with separate `localStorage` keys

### Multiplayer & Netplay

- `NetplayManager` wiring EmulatorJS built-in netplay into RetroOasis
- Supported systems: PSP, N64, NDS (with EJS global wiring)
- Username management, `EJS_playerName` wiring
- ICE server management: STUN/TURN config UI, custom TURN entry, persistence
- WebRTC peer-to-peer data channels: `PeerDataChannel` in `src/netplay/peerChannel.ts`, typed messages (ping/pong, state, input, chat), `SpectatorChannel` for read-only receive, auto-reconnect
- Lobby browser: `fetchLobbyRooms()`, four-tab modal (Host / Join / Browse / Watch), room cards with Quick Join / Watch buttons, filter by Nearby / This Game / All Rooms, 30 s auto-refresh
- Spectator mode: `watchRoom()`, `"spectating"` → `"watching"` state machine, Watch tab UI
- Share links: `getShareLink()`, `?join=<code>` deep link handling, tests
- `NetplayMetricsCollector` with incremental running sums, frame delay tracking for diagnostics

### Performance & Adaptive Tuning

- Game compatibility database: `GameCompatibilityDb` in `src/compatibility.ts`, built-in entries, user-importable JSON overlay, remote merge
- Thermal-aware throttling: `ThermalMonitor`, Compute Pressure API (`PressureObserver`), wired into emulator
- Memory pressure detection: `MemoryMonitor` via `performance.memory`, emulator callback
- Startup profiler: `StartupProfiler` tracking `core_download` and `first_frame` phases
- FPS prediction: `FpsPrediction` with 5 s observation window and linear regression
- Intelligent core preloading: top-2 systems prefetched at idle
- CDN-accurate core prefetch: `cores/<core>-wasm.data` blobs matching EmulatorJS CDN
- Per-game shader warmup: 60 s recording window on game start, pre-compile on subsequent launches
- WASM compilation caching: `WasmModuleCache` in IndexedDB with ETag/Last-Modified validation
- Capability cache TTL: `sessionStorage` under `retro-oasis-devcaps-v1`, clearable from Debug tab
- Diagnostic event timeline: 200-event ring buffer with category badges
- Enhanced Debug tab: GPU renderer, VRAM, texture compression, multi-draw support

### Debugging & Developer Tools

- Debug console overlay (`src/ui/debugConsole.ts`): toggleable (Shift+F3 or Debug button), draggable, commands (help, reset, pause, resume, step, stats, log, clear), shows diagnostic log entries with timestamps
- Developer Debug Overlay (F3): FPS, frame time, P95, dropped frames, JS heap, emulator state, 60-sample frame-time graph, no pointer interaction
- Expanded "Copy Debug Info": includes VRAM, compression support, multi-draw, last 50 timeline events
- Performance tab VRAM display alongside max texture size

### UI & Accessibility (Shipped)

- **~225 ARIA attributes** in `src/ui.ts`: labels, live regions, descriptions, roles on skip-link, library search, game cards, modals, overlays, settings sidebar, tabs, buttons
- **Keyboard navigation**: library grid (arrow keys, Home, End, PageUp, PageDown), global shortcuts (F5 save, F7 load, F1 reset, F9 debug tab, F3 dev overlay, Escape return-to-library), skip link, focus-visible outlines
- **Gamepad library navigation**: full polling loop, D-pad with auto-repeat (400 ms / 150 ms), A/Start to launch, `"using-gamepad"` CSS class
- **Reduced-motion compliance**: partial — `@media (prefers-reduced-motion: reduce)` in 4 locations in `src/style.css`; `prefersReducedMotion()` detection in `performance.ts` with tests
- **CSS transitions**: 148+ transition rules across panels, overlays, modals, FPS overlay, settings tabs, game cards, header glow, skeleton loading
- **VirtualGrid**: `VirtualGrid<T>` in `src/ui/virtualGrid.ts` (~100 game threshold), wired into library, full test suite
- **UIDirtyTracker**: exported from `performance.ts`, used by `DevOverlay`, test coverage

### Testing

- **1700+ Vitest unit tests** across all modules
- **Playwright E2E tests**: `tests/e2e/` (addRom, play, cloudSync, save), Chromium target, auto-start Vite, trace on retry
- `npm run doctor` for first-time environment diagnostics
- `npm run lint` for ESLint

### Cover Art

| Provider | Source | Credential |
|----------|--------|------------|
| LibretroCoverArtProvider | `thumbnails.libretro.com` | Free |
| GitHubCoverArtProvider | `cover-art-collection` repo | Free |
| ChainedCoverArtProvider | Composes all providers (max 4 concurrent) | — |
| RawgCoverArtProvider | RAWG API | API key |
| MobyGamesCoverArtProvider | MobyGames API | API key |
| TheGamesDBCoverArtProvider | TheGamesDB API | API key |
| ScreenScraperCoverArtProvider | ScreenScraper | Credential |
| IGDBCoverArtProvider / IGDBClient | IGDB API | API key |
| SGDBClient / SteamGridDB | SteamGridDB | API key |

Credential management via `ApiKeyStore`, per-provider caching (5 min – 24 h), `testConnection()` on keyed providers.

### Correctness Fixes

- PS1 core pinned to PCSX ReARMed (`pcsx_rearmed`)
- NDS core pinned to DeSmuME 2015 (`desmume2015`)
- Saturn options corrected to Yabause keys (`yabause_*`)
- Keyboard shortcuts isolated with `{ capture: true }` + `stopPropagation()`
- Auto-save handler leak fixed (one-shot event listener)
- O(1) system lookup via `Map<string, SystemInfo>`
- FPS monitor bind allocation moved to constructor
- Blob creation uses direct `ArrayBuffer` cast instead of double-copy

---

## What's In Progress

These items have partial implementation or active work in the codebase.

| Area | Item | Status |
|------|------|--------|
| **UI refactor** | Extract layout helpers (`make`, `el`) into `src/ui/dom.ts` | DONE |
| | Settings tabs separated into `src/ui/settingsTabs.ts` | DONE |
| | Toasts/loading/feature-pills → `toasts.ts`, `loadingOverlay.ts`, `systemFeatures.ts` | DONE |
| | Tabs → `src/ui/tabs/` (PerfTab, DisplayTab, LibraryTab, CloudTab, MultiplayerTab, DebugTab) | DONE |
| | Centralized `InputRouter` in `src/ui/InputRouter.ts` | DONE |
| | Easy Netplay modal → `src/ui/easyNetplayModal.ts` (1,115 lines) | DONE |
| | Import helpers → `src/ui/gameImportHelpers.ts` (140 lines) | DONE |
| | `systemIcon`/`escHtml` → `src/ui/viewHelpers.ts` | DONE |
| | `buildGameCard` → `src/ui/widgets/gameCard.ts` (605 lines) | DONE |
| | Split remaining monolithic `src/ui.ts` (~8,946→2,610 lines) into modules | PARTIAL (2,610 lines remain) |
| | Extract settings panel shell → `src/ui/screens/settingsPanel.ts` (~440 lines) | DONE |
| | Extract library gamepad navigation → `src/ui/widgets/libraryNav.ts` (~370 lines) | DONE |
| | Extract `resolveSystemAndAdd` + import pipeline → `src/ui/screens/gameImport.ts` (~530 lines) | DONE |
| | Extract FPS overlay + perf suggestion → `src/ui/widgets/fpsOverlay.ts` (~110 lines) | DONE |
| | Introduce `UIManager` top-level coordinator | PENDING |
| | Wire `UIDirtyTracker` into library, header, overlay paths | PENDING |
 | **UX polish** | UI scale slider (`--ui-scale`) — Display tab, 80%-150%, persisted | DONE |
 | | Font size preference (`--font-scale`) | NOT STARTED |
| | High-contrast mode toggle | NOT STARTED |
| | Controller navigation in settings panel | NOT STARTED |
| | Colorblind-safe system badges | NOT STARTED |
| **Reduced motion** | Full coverage of all animations and overlays | PARTIAL |
| **In-game chat UI** | Chat message type exists in `peerChannel.ts` | PARTIAL |
| | Chat overlay UI, ping radar, desync protection | NOT STARTED |

---

## Planned

Items with no implementation yet, ordered by estimated priority.

### Near term

| Theme | Work |
|-------|------|
| **Texture pipeline** | Replacement packs (hash-matched ZIP, PSP/N64 formats); prefetching after gameplay profile; compressed texture streaming (ETC2/ASTC) |
| **Spatial audio** | Binaural AudioWorklet filter node, toggled in Settings |
| **Cloud save expansion** | End-to-end encryption; bidirectional sync with proper conflict UI |
| **Gamepad enhancements** | Rumble (`GamepadHapticActuator`), analog calibration, per-game button remapping with settings UI |
| **Accessibility** | Complete reduced-motion coverage; high-contrast theme (`prefers-contrast: more`); colourblind-safe badges; `prefers-reduced-transparency` support |

### Medium term

| Theme | Work |
|-------|------|
| **Community features** | Per-game star ratings and notes (IndexedDB); share tier/graphics/control presets as JSON; anonymous compatibility telemetry |
| **Electron wrapper** | Native desktop build (SharedArrayBuffer without service worker, native FS ROM access) |
| **Android TWA** | Trusted Web Activity for Play Store distribution |
| **Plugin API** | Stable ES-module surface for custom shaders, themes, and system-specific UI |
| **CI depth** | Headless Playwright FPS threshold assertions on representative ROMs |

### Research & upstream-dependent

| Item | Notes |
|------|-------|
| **Dreamcast stability** | In-app launch is experimental via external Flycast WASM core; ongoing tuning and upstream tracking |
| **Rollback netplay** | Frame-delay + state rewind for lossy links — large scope, no implementation |
| **WebGPU-native 3D cores** | Requires upstream EmulatorJS / libretro changes to emit WebGPU command buffers (not owned by this repo) |

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
| N64 sustained FPS (medium, 1× res) | ~45–55 fps | ≥58 fps | ParaLLEl N64 tier tuning |
| PS1 sustained FPS (high, compatibility profile) | ~50–55 fps | ≥58 fps | PCSX ReARMed tier tuning |
| Diagnostic timeline overhead | N/A | ≤0.01 ms/event | Append-only array, capped at 200 |

---

## How to Contribute

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for code style, branching, and PR guidelines.

- **Performance improvements** must include a benchmark or empirical measurement in the PR description.
- **New system support** requires a `tierSettings` table with Low / Medium / High / Ultra entries.
- **Bug fixes** for emulator correctness should include a regression test.
- **Documentation changes** do not need tests but must be accurate and consistent with code.
