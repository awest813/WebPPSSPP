# RetroOasis

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![Vite](https://img.shields.io/badge/built%20with-Vite-646CFF.svg)
![TypeScript](https://img.shields.io/badge/language-TypeScript-3178C6.svg)
![Tests](https://img.shields.io/badge/tests-1775%20passing-brightgreen.svg)
![Node](https://img.shields.io/badge/node-18%2B-339933.svg)

RetroOasis is a browser-based multi-system retro emulator frontend built on [EmulatorJS](https://emulatorjs.org/) stable (`cdn.emulatorjs.org/stable`). Cores ship as compressed `*-wasm.data` packages that the loader downloads and decompresses at runtime. The app provides ROM library management, save states, hardware-aware performance tuning, optional WebGPU post-processing, and experimental netplay — all without a backend server.

## Overview

RetroOasis is designed for users who want a polished, self-hostable retro gaming experience in the browser without running a backend server.

It solves the practical problems that raw EmulatorJS integrations leave to app developers:

- Automatic system detection and ROM-library management
- BIOS file storage and per-system validation
- Per-device hardware tier detection (Low / Medium / High / Ultra) with system-specific tuning
- Save-state UX with slots, thumbnails, auto-save, export/import, and optional cloud sync
- Cross-origin isolation for threaded cores (COOP/COEP via service worker)
- WebGPU post-processing pipeline (CRT, sharpen, LCD, bloom, FXAA)
- Touch controls, PWA install flow, and mobile-first orientation handling

**Who it is for:**

- Users who want a polished browser emulator frontend they can self-host
- Developers building on or extending a TypeScript + Vite emulator app
- Contributors interested in web-platform performance, rendering, and emulation tooling

## Quick Start

```bash
git clone https://github.com/awest813/RetroOasis.git
cd RetroOasis
npm install
npm run dev
```

Open `http://localhost:5173`.

## Features

### Emulation

- **Many systems** via EmulatorJS — PSP (PPSSPP), N64, PS1 (Beetle PSX HW), NDS (DeSmuME 2015), GBA, SNES, NES, Sega Genesis / Saturn (Yabause), arcade (FBNeo / MAME 2003+), Atari, Neo Geo Pocket, and more
- **Core alignment**: NDS tier tables force `desmume2015` (EmulatorJS otherwise prefers melonDS first). Saturn uses Yabause with RetroOasis-specific `yabause_*` tier presets (not Beetle Saturn).
- **Dreamcast**: available through an external Flycast WASM core with ROM-type and BIOS support, but it is **experimental** and still being stabilized; some games may boot slowly, glitch, or crash.
- **Archive support**: ZIP, 7z, and RAR files are transparently extracted before launch
- **Soft-patch support**: Full IPS, BPS, and UPS patcher with CRC verification
- **Multi-disc games**: `.m3u` support for PS1, Saturn, and Dreamcast with disc-picker UI
- **CHD compression**: accepted for PS1, Saturn, and Dreamcast; cores decompress natively

### Performance

- **Hardware tier detection**: GPU benchmark + CPU/RAM heuristics classify the device as Low / Medium / High / Ultra
- **Per-system tier tables**: optimised RetroArch core-option sets for PSP, N64, PS1, NDS, GBA, Saturn (Yabause), and others
- **Adaptive quality**: sustained sub-25 FPS triggers an optional one-step tier downgrade with user confirmation
- **Per-game profiles**: last stable tier saved per game ID in `localStorage`
- **WebGPU post-processing**: CRT, sharpen, LCD, bloom, and FXAA effects with tier-aware intensity scaling
- **Shader cache**: GLSL programs persisted to IndexedDB with LRU eviction and parallel pre-compilation
- **Audio latency adapter**: auto-enlarges audio buffer for Bluetooth and USB DAC hardware

### Library & Saves

- **ROM library**: drag-and-drop import, IndexedDB blob storage, metadata cache
- **BIOS management**: per-file status display, upload controls, and `EJS_biosUrl` wiring
- **Cover art auto-fetch**: one-click online lookup against the community [cover-art-collection](https://github.com/ramiabraham/cover-art-collection); per-game picker plus a toolbar "Fetch covers" bulk action for all games missing art
- **Save-state gallery**: 5-slot gallery with 160×120 JPEG thumbnails, timestamps, and export/import
- **Auto-save on close**: saves to slot 0 on tab close/hide; offers crash-recovery restore on next launch
- **Cloud save sync**: WebDAV adapter with conflict resolution; extensible provider interface

### Platform & Mobile

- **PWA**: combined COI + PWA service worker; app-shell caching; "Install RetroOasis" button
- **Touch controls**: 12 draggable virtual buttons with per-orientation layouts and haptic feedback
- **Orientation lock**: `screen.orientation.lock("landscape-primary")` on game launch
- **iOS Safari**: `credentialless` COEP for CDN compatibility on Safari 17+ / iOS 17+

### Networking (experimental)

- **Netplay**: WebRTC-based peer-to-peer multiplayer for supported systems (PSP, N64, NDS, GBA, GBC, GB)
- **Lobby browser**: refresh room list, join a room, or start a host session in one click
- **Local wireless**: play on the same Wi-Fi network with near-zero latency — no remote server needed
- **ICE server management**: configurable STUN/TURN servers for NAT traversal
- **ROM alias grouping**: regional variants (USA / Europe / Japan) automatically share the same room

See [`docs/NETPLAY.md`](docs/NETPLAY.md) for the full setup guide.

## Project Architecture

```text
User
  |
  v
UI Layer (src/ui.ts, src/ui/, src/style.css)
  |
  +--> Library + Assets (src/library.ts, src/archive.ts, src/patcher.ts, src/cloudLibrary.ts)
  |
  +--> Saves / BIOS / Cloud (src/saves.ts, src/saveService.ts, src/bios.ts, src/cloudSave.ts, src/autoRestore.ts)
  |
  v
Emulator Orchestrator (src/main.ts, src/emulator.ts)
  |
  +--> Performance / Tier Logic (src/performance.ts, src/systems.ts)
  |
  +--> Optional Post-Process (src/webgpuPostProcess.ts, src/shaderCache.ts, src/wasmCache.ts)
  |
  +--> Networking (src/multiplayer.ts, src/netplay/)
  |
  v
EmulatorJS CDN (`*-wasm.data` core blobs + loader)
```

### Core subsystems

| Subsystem | Files |
|-----------|-------|
| Engine / orchestration | `src/main.ts`, `src/emulator.ts` |
| UI / overlays | `src/ui.ts`, `src/ui/`, `src/style.css`, `src/touchControls.ts` |
| Persistence | `src/saves.ts`, `src/saveService.ts`, `src/bios.ts`, `src/library.ts` |
| Performance / tier | `src/performance.ts`, `src/systems.ts` |
| Rendering (post-process) | `src/webgpuPostProcess.ts`, `src/shaderCache.ts`, `src/wasmCache.ts` |
| ROM tools | `src/archive.ts`, `src/patcher.ts` |
| Networking | `src/multiplayer.ts`, `src/netplay/`, `src/cloudSave.ts` |
| Cloud library | `src/cloudLibrary.ts`, `src/cloudSaveSingleton.ts` |

For a detailed map, see [`docs/ARCHITECTURE_MAP.md`](docs/ARCHITECTURE_MAP.md).

## Repository Structure

```text
src/                  TypeScript application source and unit tests
src/ui/               UI component modules (extracted from ui.ts during ongoing refactor)
src/netplay/          Netplay subsystem (EasyNetplay, signalling, diagnostics)
public/               Static assets (service worker, PWA manifest, audio worklet)
docs/                 Project documentation (architecture, netplay, performance)
data/                 Vendor EmulatorJS assets and localisation files
tools/                Utility scripts (aliases, parsers, doctor)
minify/               Minification tooling
index.html            App entry point
vite.config.ts        Dev / build configuration
vitest.config.ts      Test runner configuration
ROADMAP.md            Planned improvements and upcoming work
guide.md              Static-host deployment guide
```

## Installation

### Requirements

- Node.js 18+ (Node 20+ recommended)
- npm 9+
- A modern browser: Chrome / Edge 113+, Firefox 116+, or Safari 17+ (desktop recommended for PSP)

### Clone and install

```bash
git clone https://github.com/awest813/RetroOasis.git
cd RetroOasis
npm install
```

## Build

```bash
npm run build
```

Output is generated in `dist/`. The build step runs a full TypeScript type-check before bundling.

## Running the Project

### Development server

```bash
npm run dev
```

Opens at `http://localhost:5173` with cross-origin isolation headers pre-configured.

### Preview production build locally

```bash
npm run preview
```

### Static hosting

Deploy the contents of `dist/` to any static host. See [`guide.md`](guide.md) for host-specific steps and cross-origin isolation requirements.

## Testing

### Automated tests

```bash
npm test
```

Runs the full Vitest suite (1700+ unit tests across all modules).

### Manual / user testing

See [`docs/USER_TESTING.md`](docs/USER_TESTING.md) for a structured checklist covering all major user-facing flows.

### Environment health check

Run the project doctor to detect common setup blockers (unsupported Node version, missing dependencies, missing static-host files):

```bash
npm run doctor
```

### Lint

```bash
npm run lint
```

## CLI / Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server |
| `npm run build` | Type-check + production build |
| `npm run preview` | Preview the production build locally |
| `npm test` | Run the Vitest unit test suite |
| `npm run lint` | Lint `src/` with ESLint |
| `npm run doctor` | First-time environment diagnostics |

## Cross-Origin Isolation

The PSP core (PPSSPP) requires `SharedArrayBuffer`, which requires cross-origin isolation headers (`COOP: same-origin` + `COEP: require-corp`).

RetroOasis handles this automatically in two ways:

| Environment | Mechanism |
|-------------|-----------|
| Development | `vite.config.ts` injects the headers on every response |
| Static production | `public/coi-serviceworker.js` intercepts requests and adds headers at runtime |

If PSP fails to launch, open DevTools console and verify:

```js
self.crossOriginIsolated // should be true
```

## Troubleshooting

| Symptom | Suggested fix |
|---------|---------------|
| Game does not boot | Verify ROM extension and required BIOS availability |
| PSP core fails | Check cross-origin isolation (`self.crossOriginIsolated === true`) |
| Poor performance | Switch to Performance tier in Settings; disable heavy post-processing |
| No saves appearing | Confirm IndexedDB is enabled and storage is not blocked by the browser |
| Archive import fails | Test with an uncompressed ROM file to isolate extraction issues |
| First-time setup issues | Run `npm run doctor` to check environment |
| iOS Safari failures | PSP requires `SharedArrayBuffer`; iOS WebKit has limited support — use desktop Chrome/Firefox |

## FAQ

**Does this project include ROMs or BIOS files?**
No. You must supply legally obtained game files and firmware.

**Is a backend server required?**
No. The app is designed for fully static hosting and client-side execution.

**Which browser works best?**
Desktop Chrome / Edge provides the best compatibility and performance, especially for PSP. Firefox is a strong alternative. Safari 17+ works for most systems but PSP may require HTTPS and service worker activation.

**Can I contribute new system support?**
Yes. Add a system definition in `src/systems.ts` with a `tierSettings` table (Low / Medium / High / Ultra entries), then include tests and docs updates. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

**How do I report a bug?**
Open a GitHub issue with the output of "Copy Debug Info" from the Settings → Debug panel.

## Roadmap

RetroOasis tracks planned work in [`ROADMAP.md`](ROADMAP.md). Current priorities are:

**Technical Debt & Modernisation**

- **Architectural componentization** — `ui.ts` (~7000 lines) is being split into a feature-based module system. `src/ui/` already contains extracted UI components; further extraction into `src/modules/` is planned.
- **State management** — Introducing a centralised `RetroOasisStore` with an Observer pattern to replace prop-drilling and prevent unnecessary full-page re-renders.
- **Testing & CI** — Moving toward Playwright integration tests for critical user journeys (Add ROM → Play → Save → Cloud Sync) alongside the existing Vitest unit suite.

**Netplay & Online UX Overhaul**

- **Visual lobby browser** — Replace raw IP entry with a room-grid UI showing the game being played, player counts, and region-based latency.
- **"Play Together" share links** — Instant session invitations via deep-link URL that auto-launch the emulator and load the correct game.
- **In-game social overlay** — Non-intrusive chat, ping radar, and desync-protection indicator accessible during gameplay.
- **Advanced networking** — Full STUN/TURN NAT punching and rollback netplay depth controls for supported cores.

See [`ROADMAP.md`](ROADMAP.md) for the full phase-by-phase breakdown.

## Contributing

Contributions are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) before opening a pull request.

Quick summary:

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-change`)
3. Make changes with tests and docs updates
4. Run `npm test` and `npm run build`
5. Open a pull request with a clear description of what changed and why

Performance improvements must include an empirical measurement or benchmark result. New system support requires a `tierSettings` table covering all four tiers.

## License

This repository is licensed under the MIT License. See [`LICENSE`](LICENSE).

## Credits

- [EmulatorJS](https://emulatorjs.org/) — browser emulator integration and core loading
- [PPSSPP](https://www.ppsspp.org/) — PSP emulation core
- [Vite](https://vitejs.dev/) — build tooling
- [Vitest](https://vitest.dev/) — test runner
- [ramiabraham/cover-art-collection](https://github.com/ramiabraham/cover-art-collection) — community-maintained cover art used by the auto-fetch feature
- The libretro / RetroArch core communities that power the underlying emulation

---

> **Legal note:** This project does not distribute copyrighted games, proprietary BIOS files, or compiled emulator cores. EmulatorJS fetches core packages from the public CDN when you start a game.
