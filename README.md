# RetroVault

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![Vite](https://img.shields.io/badge/built%20with-Vite-646CFF.svg)
![TypeScript](https://img.shields.io/badge/language-TypeScript-3178C6.svg)

RetroVault is a browser-based multi-system retro emulator frontend that runs EmulatorJS cores in WebAssembly with local ROM, save-state, and performance-management tooling.

## Overview

RetroVault is designed for people who want a self-hostable retro gaming experience in the browser without running a backend server.

It solves a few practical problems that raw EmulatorJS integrations often leave to app developers:

- system detection and ROM-library management
- BIOS file storage and validation
- per-device performance tuning (Low/Medium/High/Ultra)
- save-state UX (slots, thumbnails, import/export)
- modern browser requirements for threaded cores (COOP/COEP)

**Who it is for:**

- Users who want a polished browser emulator frontend
- Developers who want to extend a TypeScript + Vite emulator app
- Contributors interested in performance, rendering, and web-platform optimization

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## Features

- Multi-system emulation via EmulatorJS cores (PSP, N64, PS1, DS, GBA, SNES, NES, Sega systems, and more)
- ROM library with drag-and-drop import, IndexedDB storage, and metadata tracking
- Performance tier detection (Low/Medium/High/Ultra) with per-system tuning tables
- Save-state manager with slots, thumbnails, auto-save, and export/import
- BIOS management for systems that require firmware files (for example Saturn and Dreamcast)
- Optional WebGPU post-processing effects (CRT, sharpen, LCD, bloom, FXAA)
- Touch controls for mobile devices with layout customization and haptics
- PWA install flow and static-host-friendly cross-origin isolation support
- Experimental networking modules (netplay + cloud save sync)

## Screenshots / Demo

> TODO: Add current screenshots or a hosted demo URL.

```md
![Library view](docs/screenshot-library.png)
![In-game HUD](docs/screenshot-gameplay.png)
```

## Project Architecture

At a high level, RetroVault coordinates a browser UI, local data stores, and EmulatorJS core loading:

```text
User
  |
  v
UI Layer (src/ui.ts, src/style.css)
  |
  +--> Library + Assets (src/library.ts, src/archive.ts, src/patcher.ts)
  |
  +--> Saves/BIOS (src/saves.ts, src/bios.ts, src/autoRestore.ts)
  |
  v
Emulator Orchestrator (src/main.ts, src/emulator.ts)
  |
  +--> Performance/Tier Logic (src/performance.ts, src/systems.ts)
  |
  +--> Optional Post-Process (src/webgpuPostProcess.ts, src/shaderCache.ts)
  |
  v
EmulatorJS CDN Cores (WASM + JS)
```

### Core subsystems

- **Core engine/orchestration:** startup, settings, and game launch lifecycle
- **Frontend UI:** library, settings, overlays, controls, and status prompts
- **Persistence layer:** IndexedDB/localStorage for ROMs, saves, BIOS, and settings
- **Performance layer:** capability detection and system-specific tier overrides
- **Networking layer (optional/experimental):** WebRTC netplay + WebDAV cloud saves

For a deeper map, see [`docs/ARCHITECTURE_MAP.md`](docs/ARCHITECTURE_MAP.md).

## Repository Structure

```text
src/                  Main TypeScript application code
public/               Static assets (service worker, manifest, worklet)
docs/                 Project documentation and planning artifacts
data/                 Legacy/vendor EmulatorJS-related assets and localization
tools/                Utility scripts (aliases, parsers, generation)
minify/               Minification tooling
index.html            App entry HTML
vite.config.ts        Dev/build configuration
vitest.config.ts      Test runner configuration
```

## Installation

### Requirements

- Node.js 18+ (Node 20+ recommended)
- npm 9+
- Modern browser (Chrome/Edge/Firefox recommended)

### Clone

```bash
git clone https://github.com/nihalmostafaw/WebPPSSPP.git
cd WebPPSSPP
```

### Install dependencies

```bash
npm install
```

## Build

```bash
npm run build
```

Build output is generated in `dist/`.

## Running the Project

### Development

```bash
npm run dev
```

### Preview production build locally

```bash
npm run preview
```

### Static hosting

Deploy the contents of `dist/` to any static host. See [`guide.md`](guide.md) for host-specific setup guidance.

## Testing

```bash
npm test
```

## Environment health check (recommended for first-time setup)

Run the project doctor to quickly detect common setup blockers (unsupported Node version, missing dependencies, missing static-host files):

```bash
npm run doctor
```

Optional quality checks:

```bash
npm run lint
```

## CLI / Scripts

Defined in `package.json`:

- `npm run dev` — start Vite dev server
- `npm run build` — type-check + production build
- `npm run preview` — preview the build locally
- `npm test` — run Vitest test suite
- `npm run lint` — lint `src/` with ESLint
- `npm run doctor` — run first-time environment diagnostics

## Cross-Origin Isolation (Important)

The PSP core requires `SharedArrayBuffer`, which requires cross-origin isolation headers.

RetroVault supports this in two ways:

- **Development:** headers are provided by `vite.config.ts`
- **Static production:** `public/coi-serviceworker.js` injects headers at runtime

If PSP fails to launch, verify isolation behavior first.

## Troubleshooting

- **Game does not boot:** verify ROM extension support and required BIOS availability.
- **PSP-specific failures:** check COOP/COEP isolation and browser compatibility.
- **Poor performance:** force Performance mode in settings and disable heavy post-processing.
- **No saves appearing:** confirm IndexedDB is available and storage is not blocked.
- **Archive import issues:** test with uncompressed ROM files to isolate extraction issues.
- **First-time setup confusion:** run `npm run doctor` to catch environment issues early.

## FAQ

### Does this project include ROMs or BIOS files?
No. You must provide legally obtained game files and firmware.

### Is a backend server required?
No. The app is designed for static hosting and client-side execution.

### Which browser works best?
Desktop Chrome/Edge/Firefox generally provide the best compatibility and performance.

### Can I contribute new system support?
Yes. Add system definitions and tuning in `src/systems.ts`, then include tests and docs updates.

## Roadmap

High-level goals (see [`docs/ROADMAP.md`](docs/ROADMAP.md) for full detail):

- Improve launch latency and caching strategy
- Expand compatibility tooling and diagnostics
- Strengthen cloud save and multiplayer UX
- Add richer accessibility and community-facing features
- Continue rendering/audio performance optimizations

## Contributing

Contributions are welcome.

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-change`)
3. Make changes with tests/docs updates
4. Run `npm test` and `npm run build`
5. Open a pull request

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License

This repository is licensed under the MIT License. See [`LICENSE`](LICENSE).

## Credits

- [EmulatorJS](https://emulatorjs.org/) for browser emulator integration and core loading
- [Vite](https://vitejs.dev/) for build tooling
- [Vitest](https://vitest.dev/) for testing
- The broader libretro/core emulator communities that power underlying emulation

---

> Legal note: This project does not distribute copyrighted games or proprietary BIOS files.
