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

## Phase 6 — Multiplayer & Social (Future)

Networked features requiring server infrastructure.

- [ ] **WebRTC peer-to-peer**: PSP ad-hoc / N64 NetPlay over WebRTC using a STUN/TURN relay; no dedicated game server needed
- [ ] **Lobby browser**: WebSocket-based matchmaking room list for users who want to join ongoing sessions
- [ ] **Spectator mode**: Read-only WebRTC stream of a running session for watch parties

---

## Phase 7 — WebGPU Native Path (Future)

Full WebGPU integration once spec and browser support mature.

- [ ] **Retire WebGL 2 for 3D cores**: Port PPSSPP-Web and mupen64plus-Next to emit WebGPU command buffers natively (requires upstream changes in EmulatorJS / libretro)
- [ ] **Compute shader post-processing**: Use WebGPU compute for xBRZ and CRT shader passes, freeing the fragment shader pipeline for the core's own rendering
- [ ] **GPU readback elimination**: Replace synchronous `gl.readPixels()` screenshot calls with async `GPUBuffer.mapAsync()` to avoid GPU stalls

---

## Performance Targets

| Metric | Current | Target |
|--------|---------|--------|
| First meaningful paint | ~200 ms | <=100 ms |
| PSP game boot (cached core) | ~3 s | <=1.5 s |
| PSP game boot (uncached core, fast connection) | ~15 s | <=8 s |
| Audio base latency (low-latency HW) | ~12-20 ms | <=8 ms |
| FPS overlay CPU overhead | ~0.1 ms/frame | <=0.05 ms/frame |
| Initial JS bundle | ~80 KB gzip | <=40 KB gzip |
| IndexedDB cold-open (first ROM add) | ~80 ms | <=20 ms |

---

## How to Contribute

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for code style, branching, and PR guidelines. Performance improvements must include a benchmark or empirical measurement in the PR description. New system support requires at minimum a `tierSettings` table with Low / Medium / High / Ultra entries.
