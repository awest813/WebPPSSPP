# RetroVault Roadmap

This document tracks planned improvements, experiments under investigation, and longer-term vision items. Entries move from *Planned* → *In Progress* → *Done* as work happens.

Items within each phase are roughly ordered by expected impact.

---

## Phase 1 — Foundation ✅ (Current)

Core infrastructure shipped in the initial release.

- [x] EmulatorJS multi-system integration (PSP, N64, PS1, NDS, GBA, SNES, NES, Genesis, …)
- [x] Hardware tier classification (Low / Medium / High / Ultra) via WebGL benchmark + CPU/RAM heuristics
- [x] Per-system, per-tier RetroArch core option tables (PSP, N64, PS1, NDS, GBA)
- [x] ROM library with IndexedDB blob persistence and metadata cache
- [x] Cross-origin isolation via `coi-serviceworker.js` (enables SharedArrayBuffer / PSP threads)
- [x] FPS monitor — zero-GC ring-buffer rAF loop with dropped-frame tracking
- [x] WebGL driver pre-warming (shader compile + draw call before first game launch)
- [x] CDN preconnect + prefetch for loader.js and WASM cores
- [x] Page Visibility API auto-pause (saves battery when tab is hidden)
- [x] WebGL context-loss detection and graceful recovery prompt
- [x] Battery Status API integration — auto-switch to Performance mode at ≤20%
- [x] Chromebook (CrOS) penalty in tier classification

---

## Phase 2 — 3D Rendering & Audio Quality 🔄 (Active)

Improvements to visual fidelity and audio latency for 3D-heavy systems.

### 3D Rendering

- [x] **PSP ultra tier**: 5× xBRZ texture scaling, GPU-side xBRZ texture shader, 16× anisotropic filtering, PSP CPU locked to full 333 MHz
- [x] **PSP medium tier**: 2× anisotropic filtering (near-free on any discrete GPU)
- [x] **N64 high tier**: Smooth filtering 1 texture pass (removes pixel crawl at 2× res)
- [x] **N64 ultra tier**: Smooth filtering 4 + texture enhancement mode at 4× internal resolution
- [x] **PS1 high tier**: 4× GPU overclock, PGXP memory mode (fixes wobbly polygon geometry)
- [x] **PS1 ultra tier**: 8× internal resolution, Memory + CPU PGXP, 8× GPU overclock, GTE overclock (smoother skeletal animations)
- [x] **GPU benchmark**: VAO-aware draw-call benchmark (more realistic 3D workload proxy)
- [x] **GPU capability detection**: Multi-Draw, MRT (Multiple Render Targets), VAO, compressed textures, half-float textures — all surfaced as tier-bonus points
- [ ] **Shader cache**: Persist compiled WebGL shader programs to IndexedDB to eliminate recompile stutter on repeat launches
- [ ] **WebGPU rendering path**: Opt-in backend using the WebGPU API where available (Chrome 113+); eliminates ANGLE translation overhead on Windows and removes the Metal → OpenGL compatibility layer on macOS
- [ ] **PSP Vulkan-style pipeline warm-up**: Prime the PPSSPP pipeline cache before the first rendered frame

### Audio

- [x] **Audio latency adapter**: Probes `AudioContext.baseLatency` at launch; automatically promotes audio buffer size for high-latency hardware (Bluetooth, USB DACs) regardless of GPU tier
- [x] **PSP medium tier audio resampling**: Enabled (was disabled); improves music quality with negligible CPU overhead
- [ ] **AudioWorklet path**: When `AudioWorkletNode` is available, route audio through a low-latency worklet processor instead of the default ScriptProcessor — reduces output latency by 1–2 render quanta (~5–10 ms)
- [ ] **Dynamic audio buffer sizing**: Monitor audio underruns via the Web Audio API and adaptively grow/shrink the buffer to find the smallest stable size for the current hardware
- [ ] **Audio visualiser overlay**: Optional oscilloscope / spectrum display in the FPS overlay panel

### Adaptive Quality

- [x] **Low-FPS detector**: Sustained <25 FPS for 10 seconds triggers `onLowFPS` callback; UI can prompt the user to switch to Performance mode
- [ ] **Auto tier downgrade**: If `onLowFPS` fires and the user accepts, automatically re-launch the current game at one tier lower without a full page reload
- [ ] **Per-game performance profile**: Store the last stable tier for each game in IndexedDB so the correct tier is pre-selected on subsequent launches

---

## Phase 3 — Platform & Compatibility 📅 (Planned)

Broader system support and compatibility improvements.

- [ ] **Additional systems**: Saturn (Beetle Saturn), Dreamcast (Flycast), MAME 2003+, Atari 7800, Lynx, Neo Geo Pocket
- [ ] **BIOS management**: Allow users to upload system BIOS files (PS1, Saturn, Dreamcast) stored in IndexedDB; surface a clear per-system BIOS status indicator
- [ ] **CHD compression**: Client-side CHD decompression for PS1/Dreamcast images to reduce memory footprint
- [ ] **ZIP/7Z transparency**: Decompress ROM archives in-browser before launch (via WASM libarchive) so users can drop compressed ROM packs directly
- [ ] **Soft-patch support**: Apply IPS/BPS/UPS patches on-the-fly before launching a ROM — enables fan translation and ROM hack support without pre-patching
- [ ] **Multi-disc games**: Handle `.m3u` playlist files for PS1 games that span multiple discs

---

## Phase 4 — Save & State Management 📅 (Planned)

Improved persistence, portability, and cloud sync for save data.

- [ ] **Save state export/import**: Download and upload `.state` files for any slot, enabling cross-device portability
- [ ] **Cloud save sync**: Optional sync of save states to user-supplied storage (Google Drive, Dropbox, or any WebDAV endpoint) via the File System Access API
- [ ] **Save state gallery**: Screenshot thumbnails captured at save-state creation time stored alongside the state blob
- [ ] **Auto-save on tab close**: Write a "crash-recovery" quick-save when `beforeunload` or `visibilitychange: hidden` fires, so progress is never lost on accidental tab closure
- [ ] **Save data migration**: Tool to re-key saves when a ROM file is renamed

---

## Phase 5 — Mobile & PWA 📅 (Planned)

First-class mobile experience and installability.

- [ ] **Progressive Web App**: Service worker + `manifest.json` to enable "Add to Home Screen" installation on Android/iOS
- [ ] **Touch control layout editor**: Drag-and-drop virtual button positioning with per-game profiles
- [ ] **Haptic feedback**: `navigator.vibrate()` for button presses on Android Chrome
- [ ] **Orientation lock**: Auto-lock to landscape when a game is running on mobile
- [ ] **iOS Safari improvements**: Investigate COOP/COEP alternatives (`credentialless` COEP) to restore PSP thread support on WebKit without the service worker reload dance
- [ ] **Reduce initial bundle size**: Code-split the library and emulator modules; lazy-load the system selection UI so the initial paint is under 50 KB

---

## Phase 6 — Multiplayer & Social 🔮 (Future)

Networked features requiring server infrastructure.

- [ ] **WebRTC peer-to-peer**: PSP ad-hoc / N64 NetPlay over WebRTC using a STUN/TURN relay; no dedicated game server needed
- [ ] **Lobby browser**: WebSocket-based matchmaking room list for users who want to join ongoing sessions
- [ ] **Spectator mode**: Read-only WebRTC stream of a running session for watch parties

---

## Phase 7 — WebGPU Native Path 🔮 (Future)

Full WebGPU integration once spec and browser support mature.

- [ ] **Retire WebGL 2 for 3D cores**: Port PPSSPP-Web and mupen64plus-Next to emit WebGPU command buffers natively (requires upstream changes in EmulatorJS / libretro)
- [ ] **Compute shader post-processing**: Use WebGPU compute for xBRZ and CRT shader passes, freeing the fragment shader pipeline for the core's own rendering
- [ ] **GPU readback elimination**: Replace synchronous `gl.readPixels()` screenshot calls with async `GPUBuffer.mapAsync()` to avoid GPU stalls

---

## Performance Targets

| Metric | Current | Target |
|--------|---------|--------|
| First meaningful paint | ~200 ms | ≤100 ms |
| PSP game boot (cached core) | ~3 s | ≤1.5 s |
| PSP game boot (uncached core, fast connection) | ~15 s | ≤8 s |
| Audio base latency (low-latency HW) | ~12–20 ms | ≤8 ms |
| FPS overlay CPU overhead | ~0.1 ms/frame | ≤0.05 ms/frame |
| Initial JS bundle | ~80 KB gzip | ≤40 KB gzip |
| IndexedDB cold-open (first ROM add) | ~80 ms | ≤20 ms |

---

## How to Contribute

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for code style, branching, and PR guidelines. Performance improvements must include a benchmark or empirical measurement in the PR description. New system support requires at minimum a `tierSettings` table with Low / Medium / High / Ultra entries.
