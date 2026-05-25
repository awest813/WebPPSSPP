# RetroOasis Plan

This is the single source of truth for shipped work, active improvements, and future work. It replaces the previous planning notes with one maintained plan.

## Current State

### Emulation And Systems

- Multi-system EmulatorJS integration: PSP, N64, PS1, NDS, GBA, SNES, NES, Genesis, Saturn, Dreamcast, arcade, Atari 7800, Lynx, Neo Geo Pocket, and related configured cores.
- Hardware tier classification through WebGL benchmark, CPU/RAM heuristics, Chromebook handling, and battery-aware performance choices.
- Per-system and per-tier RetroArch options, including tuned 3D systems and dynamic resolution support.
- IndexedDB-backed ROM library, metadata cache, BIOS library, save states, thumbnails, and WASM/shader caches.
- Archive handling for ZIP, 7z, RAR, TAR, and GZIP, plus IPS/BPS/UPS patching.
- Multi-disc `.m3u` and CHD support for PS1, Saturn, and Dreamcast.
- Cross-origin isolation support through `public/coi-serviceworker.js`.

### Rendering, Audio, And Performance

- WebGL/WebGPU capability detection, VRAM estimation, shader cache, pipeline warmup, and post-processing effects.
- WebGPU post-processing: CRT, LCD, bloom, FXAA, FSR 1.0, TAA, screenshots, timestamp profiling, and bind group caching.
- Dynamic resolution scaling, per-game graphics profiles, and tier-aware effect limits.
- Audio latency detection, AudioWorklet support, adaptive buffering, underrun detection, filters, and waveform overlay.
- Thermal, memory, startup, FPS prediction, core preloading, CDN-aware core prefetch, and diagnostic timeline systems.

### Saves, Sync, And Storage

- Local-first save state library with manual slots, auto-save, thumbnails, crash recovery prompt, migration, versioning, checksum, and compression.
- Save Sync providers: WebDAV, Google Drive, Dropbox, OneDrive, Box, pCloud, Blomp, and Mega.
- Remote library indexing and connection management for supported providers.
- Storage pressure warnings that point users toward Save Sync without implying it replaces local saves.

### UI, Accessibility, And PWA

- Settings tabs, library UI, import flow, game cards, FPS overlay, loading/toast helpers, and modal flows split into focused modules.
- Keyboard navigation, gamepad library navigation, global shortcuts, skip link, focus-visible states, live regions, and ARIA labeling across the app.
- Touch controls with layout editing, haptics, orientation handling, and modular touch DOM/binding code.
- PWA install flow, combined COI/PWA service worker, app shell caching, and iOS Safari COEP compatibility.
- Current theme and settings wording use Connections, Save Sync, Remote Library Sources, and Play Together consistently.

### Multiplayer And Play Together

- EmulatorJS netplay wiring, username management, ICE/TURN settings, share links, lobby browsing, spectator mode, metrics, and diagnostics.
- WebRTC peer channel with typed messages, ping/pong, input/state/chat message support, read-only spectator channel, and reconnect handling.
- LANemu support documentation and connection doctor coverage.

### Cover Art And Metadata

- Free providers: Libretro thumbnails, cover-art-collection, and Wikimedia/Wikipedia fallbacks.
- Optional Connections providers: RAWG, MobyGames, TheGamesDB, SteamGridDB, IGDB, and ScreenScraper.fr.
- Local credential storage, provider ordering, connection testing, and caching.

### Testing And Tooling

- Vitest unit coverage across core modules.
- Playwright e2e coverage for import, launch, Save Sync, save/load hotkeys, and settings flows.
- `npm run doctor`, `npm run lint`, `npm run build`, and focused test suites are the standard validation loop.
- Recent full validation baseline: doctor, build, lint, 2477 Vitest tests, focused settings/save/cloud/emulator Vitest, and 15 Playwright e2e tests passing.

## Active Improvement Plan

### UI Architecture

| Work | Status | Notes |
| --- | --- | --- |
| Extract DOM helpers, settings tabs, tab builders, toasts/loading helpers, feature pills, game cards, import helpers, library nav, FPS overlay | Done | Keep modules focused and test-covered. |
| Split remaining `src/ui.ts` coordinator work | Partial | `src/ui.ts` is much smaller but still owns orchestration. |
| Introduce a top-level `UIManager` coordinator | Planned | Clarify lifecycle, subscriptions, and cleanup ownership. |
| Wire `UIDirtyTracker` through library, header, and overlay paths | Planned | Reduce unnecessary renders and make update intent explicit. |
| Keep lazy UI modules safe after close/unmount | Ongoing | Preserve stale-render guards and cleanup callbacks. |

### Save And Load UX

| Work | Status | Notes |
| --- | --- | --- |
| Menu save/load readiness for emulator cores | Done | Recent fixes ensure the hamburger menu can save/load once cores expose state hooks. |
| Save Sync wording and e2e coverage | Done | Tests now target Save Sync rather than older Cloud Storage copy. |
| Bidirectional Save Sync with clearer conflict UI | Planned | Go beyond mirroring into explicit sync state, conflict choice, and recovery guidance. |
| Downloadable save-state export flow | Planned | Support runbook previously tracked this as a future support need. |
| End-to-end encrypted Save Sync | Planned | Higher-trust remote save mode, especially for generic providers. |

### Settings And Cloud UX

| Work | Status | Notes |
| --- | --- | --- |
| Connections wording sweep | Done | User-facing copy should say Connections or credentials, not older provider-key wording. |
| Save Sync and Remote Library Sources separation | Done | e2e tests now avoid mixing the two connect flows. |
| High-contrast theme toggle | Planned | Pair with contrast media query support. |
| Font size preference | Planned | Separate from UI scale so text can grow without distorting controls. |
| Controller navigation in Settings | Planned | Keep Settings usable from couch/handheld setups. |
| Colorblind-safe system badges | Planned | Audit system colors and add alternative badge treatment. |

### Touch And Mobile

| Work | Status | Notes |
| --- | --- | --- |
| Touch controls split into preferences, input, layouts, builders, binders, and overlay orchestration | Done | Existing compatibility shims should remain until all call sites are stable. |
| Visual/manual mobile pass | Planned | Verify edit mode, orientation changes, D-pad diagonals, analog stick release, haptics, and layout reset. |
| Rumble support | Planned | Use `GamepadHapticActuator` where available. |
| Analog calibration | Planned | Needed for inconsistent controllers and handheld browsers. |
| Per-game button remapping UI | Planned | Store per-game mappings with export/import path later. |

### Play Together

| Work | Status | Notes |
| --- | --- | --- |
| Signaling import graph cleanup | Done | Build no longer warns about mixed static/dynamic `signalingClient` imports. |
| In-game chat overlay | Planned | Message type exists; UI, moderation affordances, and focus handling are still needed. |
| Ping radar and connection quality hints | Planned | Use existing metrics and diagnostics. |
| Desync protection | Planned | Detect divergent state where core APIs allow it. |
| Rollback netplay research | Research | Large scope; depends on state rewind and per-core determinism. |

### Dreamcast And Core Reliability

| Work | Status | Notes |
| --- | --- | --- |
| Dreamcast import routing and experimental Flycast wiring | Done | Treated as experimental. |
| Dreamcast stability tuning | Research | Track upstream core behavior, BIOS needs, threaded runtime, and browser support. |
| Headless core smoke coverage | Planned | Add representative launch/save checks where legally distributable fixtures allow it. |
| 4.3-pre core routing checks | Done | Covered by `npm run doctor`. |

### Performance And Bundle Weight

| Work | Status | Notes |
| --- | --- | --- |
| Remove conflicting manual Vite chunk rules | Done | Previous lightweight audit completed this. |
| First meaningful paint target | Planned | Target <=100 ms by deferring non-critical CSS/JS. |
| Initial JS gzip target | Planned | Target <=40 KB via further route/module splitting. |
| PSP cached boot target | Planned | Target <=1.5 s with shader prewarm and WASM cache. |
| IndexedDB cold-open target | Planned | Warm connection at startup to target <=20 ms. |
| Headless Playwright FPS assertions | Planned | Needs stable representative ROM fixtures or synthetic core harness. |

### Accessibility

| Work | Status | Notes |
| --- | --- | --- |
| Keyboard, focus, live-region, and ARIA sweep | Done | Keep coverage as UI moves. |
| Reduced-motion coverage | Partial | Audit all transitions, overlays, skeletons, and animated affordances. |
| `prefers-contrast: more` support | Planned | Pair with explicit high-contrast toggle. |
| Reduced transparency support | Planned | Add `prefers-reduced-transparency` handling where supported/fallback toggle otherwise. |

### Community And Distribution

| Work | Status | Notes |
| --- | --- | --- |
| Per-game notes and star ratings | Planned | IndexedDB-backed local-only first. |
| Share tier, graphics, and control presets as JSON | Planned | Reuse import/export patterns. |
| Anonymous compatibility telemetry | Planned | Only if privacy review and explicit opt-in are in place. |
| Electron wrapper | Medium term | Native FS access and SharedArrayBuffer without service worker. |
| Android Trusted Web Activity | Medium term | Package PWA for Play Store-style distribution. |
| Plugin API | Medium term | Stable ES-module surface for shaders, themes, and system-specific UI. |

## Performance Targets

| Metric | Current/Observed | Target |
| --- | --- | --- |
| First meaningful paint | About 200 ms | <=100 ms |
| PSP cached boot | About 3 s | <=1.5 s |
| PSP uncached boot on fast connection | About 15 s | <=8 s |
| Audio base latency on low-latency hardware | About 12-20 ms | <=8 ms |
| FPS overlay CPU overhead | About 0.1 ms/frame | <=0.05 ms/frame |
| Initial JS bundle | About 80 KB gzip | <=40 KB gzip |
| IndexedDB cold-open on first ROM add | About 80 ms | <=20 ms |
| GPU benchmark duration | About 12 ms | <=8 ms |
| Shader cache precompile for 50 programs | About 200 ms | <=100 ms |
| Post-process frame time with CRT and bloom | About 2 ms | <=1 ms |
| N64 sustained FPS on medium tier, 1x res | About 45-55 fps | >=58 fps |
| PS1 sustained FPS on high tier compatibility profile | About 50-55 fps | >=58 fps |
| Diagnostic timeline overhead | Not measured | <=0.01 ms/event |

## Validation Policy

- Performance work must include an empirical measurement or benchmark note.
- New system support must include extensions, core routing, tier settings, and tests.
- Emulator correctness fixes need regression coverage when practical.
- UX changes that affect import, save/load, settings, Save Sync, Play Together, or launch flows should run focused Vitest plus relevant Playwright e2e.
- Documentation changes do not need tests, but must stay consistent with code and user-facing wording.

## Useful Commands

```bash
npm run doctor
npm run build
npm run lint
npm test
npm run test:e2e
```
