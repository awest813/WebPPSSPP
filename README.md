# RetroOasis

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![Vite](https://img.shields.io/badge/built%20with-Vite-646CFF.svg)
![TypeScript](https://img.shields.io/badge/language-TypeScript-3178C6.svg)
![Node](https://img.shields.io/badge/node-18%2B-339933.svg)

RetroOasis is a polished, self-hostable retro game library and emulator frontend for the browser. It is built with TypeScript, Vite, and [EmulatorJS](https://emulatorjs.org/), and it runs as a static web app: no backend server is required for local play.

Bring your own legally obtained ROMs and BIOS files. RetroOasis stores games, saves, cover art, optional connection credentials, and settings in your browser unless you explicitly connect a provider.

## Why RetroOasis?

Raw browser emulator integrations can boot games, but a good daily-use library needs more than a loader. RetroOasis adds:

- Drag-and-drop ROM import with system detection
- ZIP, 7z, RAR, TAR, and GZIP archive handling
- Local IndexedDB game library and save-state storage
- BIOS management and per-system launch checks
- Per-device performance tiers with per-system core options
- Save slots, thumbnails, auto-restore, and optional cloud sync
- Cover art discovery from free sources and optional bring-your-own provider credentials
- PWA install support and cross-origin isolation for threaded cores
- Experimental multiplayer, cloud libraries, and LANemu workflows

## Quick Start

```bash
git clone https://github.com/awest813/RetroOasis.git
cd RetroOasis
npm install
npm run dev
```

Open `http://localhost:5173`.

## Supported Systems

RetroOasis currently defines profiles for:

- PlayStation Portable
- PlayStation 1
- Nintendo 64
- Nintendo DS
- Nintendo 3DS, experimental
- NES, SNES, and SNES bsnes
- Game Boy, Game Boy Color, and Game Boy Advance
- Sega Genesis / Mega Drive, Genesis Wide, Sega CD / Mega-CD, Sega 32X, Game Gear, and Master System
- Sega Saturn
- Dreamcast, experimental Flycast
- MS-DOS via DOSBox Pure
- Arcade via FBNeo and MAME 2003+
- Atari 2600, Atari 7800, and Atari Lynx
- Intellivision
- Neo Geo Pocket

System definitions live in [src/systems.ts](./src/systems.ts). New system support should include extensions, core routing, tier settings, and tests.

## Importing Games

Use the on-screen drop zone, mobile add button, PWA file handling, or OS share target where supported. The import pipeline can:

- Detect systems from file extensions
- Ask the user when a file belongs to multiple systems
- Extract supported archives and pick the best ROM candidate
- Preserve native package archives when extraction would be wrong
- Apply IPS, BPS, and UPS patches
- Handle `.m3u` playlists for multi-disc games
- Support Sega CD disc images (`.cue`, `.chd`, `.iso`, `.m3u`) and Sega 32X ROMs (`.32x`, `.68k`)
- Route webretro-style links such as `?core=parallel_n64` as import hints

For privacy and legal clarity, RetroOasis does not provide ROM downloads.

## Saves, BIOS, and Cloud

Local data is stored in browser storage:

- ROM library: IndexedDB
- Save states and thumbnails: IndexedDB
- BIOS files: IndexedDB
- Settings and optional connection credentials: localStorage

Cloud features are optional. Save sync and cloud library indexing support WebDAV / Nextcloud, Google Drive, Dropbox, OneDrive, pCloud, Blomp, Box, and Mega depending on the flow and credentials configured in Settings.

## Cover Art and Metadata

Free cover sources run without an account:

- [Libretro Thumbnails](https://thumbnails.libretro.com/)
- [ramiabraham/cover-art-collection](https://github.com/ramiabraham/cover-art-collection)
- Wikimedia / Wikipedia metadata fallbacks

Optional cover and metadata providers can be enabled in Settings > Connections:

- RAWG
- MobyGames
- TheGamesDB
- SteamGridDB
- IGDB
- ScreenScraper.fr

Provider credentials are stored locally in the browser and sent directly from the browser to the provider.

## Development

### Requirements

- Node.js 18+; Node 20+ recommended
- npm 9+
- A modern browser. Desktop Chromium-based browsers usually have the best PSP and WebGL/WebGPU compatibility.

### Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Type-check and build production assets |
| `npm run preview` | Preview the production build on port 4173 |
| `npm test` | Run the Vitest suite |
| `npm run test:e2e` | Run Playwright end-to-end tests |
| `npm run lint` | Run ESLint |
| `npm run doctor` | Check common environment and hosting issues |

Production output is written to `dist/`.

## Cross-Origin Isolation

Threaded cores such as PPSSPP need `SharedArrayBuffer`, which requires cross-origin isolation.

RetroOasis handles this in two places:

| Environment | Mechanism |
| --- | --- |
| Development | Vite injects COOP / COEP headers |
| Static hosting | `public/coi-serviceworker.js` adds the required headers at runtime |

If a threaded core fails, check DevTools:

```js
self.crossOriginIsolated
```

It should be `true`. See [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) and [guide.md](./guide.md) for hosting notes.

## Project Map

| Area | Main files |
| --- | --- |
| App bootstrap | [src/main.ts](./src/main.ts) |
| Emulator orchestration | [src/emulator.ts](./src/emulator.ts) |
| System definitions and tier settings | [src/systems.ts](./src/systems.ts) |
| Device capability detection | [src/performance.ts](./src/performance.ts) |
| UI shell and extracted UI modules | [src/ui.ts](./src/ui.ts), [src/ui/](./src/ui/) |
| Game library and imports | [src/library.ts](./src/library.ts), [src/archive.ts](./src/archive.ts), [src/ui/screens/gameImport.ts](./src/ui/screens/gameImport.ts) |
| Saves and BIOS | [src/saves.ts](./src/saves.ts), [src/saveService.ts](./src/saveService.ts), [src/bios.ts](./src/bios.ts) |
| Cloud save and cloud library | [src/cloudSave.ts](./src/cloudSave.ts), [src/cloudLibrary.ts](./src/cloudLibrary.ts) |
| Multiplayer | [src/multiplayer.ts](./src/multiplayer.ts), [src/netplay/](./src/netplay/), [src/multiplayer/](./src/multiplayer/) |
| Tests | [src](./src), [tests/e2e](./tests/e2e), [tests/multiplayer](./tests/multiplayer) |

For deeper context, read [docs/ARCHITECTURE_MAP.md](./docs/ARCHITECTURE_MAP.md), [docs/ROADMAP.md](./docs/ROADMAP.md), and [docs/SUPPORT_RUNBOOK.md](./docs/SUPPORT_RUNBOOK.md).

## Troubleshooting

| Symptom | First checks |
| --- | --- |
| Game will not boot | Confirm the file extension, system choice, and required BIOS files |
| PSP fails immediately | Confirm `self.crossOriginIsolated === true` |
| Slow 3D performance | Use Performance mode, lower per-game graphics settings, or disable heavy post-processing |
| Import fails from archive | Try the extracted ROM directly; very large archives may exceed browser memory limits |
| Save states disappear | Check browser storage settings, private browsing mode, and quota warnings |
| Cloud sync fails | Reconnect the provider and verify OAuth tokens or WebDAV credentials |
| First-time setup fails | Run `npm run doctor` |

## Documentation

- [Deployment](./docs/DEPLOYMENT.md)
- [Architecture map](./docs/ARCHITECTURE_MAP.md)
- [Roadmap](./docs/ROADMAP.md)
- [Netplay guide](./docs/NETPLAY.md)
- [User testing checklist](./docs/USER_TESTING.md)
- [Support runbook](./docs/SUPPORT_RUNBOOK.md)
- [Contributing guide](./CONTRIBUTING.md)

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) before opening a pull request.

Good pull requests usually include:

- A focused explanation of what changed and why
- Tests for behavior changes
- Documentation updates when user-facing behavior changes
- Performance measurements for performance claims

Run at least:

```bash
npm test
npm run build
```

## Legal

RetroOasis does not include copyrighted games or proprietary BIOS files. You are responsible for using legally obtained content. Emulator cores are loaded through EmulatorJS and related configured core sources at runtime.

## Credits

- [EmulatorJS](https://emulatorjs.org/)
- [RetroArch](https://www.retroarch.com/) and the libretro core communities
- [PPSSPP](https://www.ppsspp.org/)
- [Vite](https://vitejs.dev/)
- [Vitest](https://vitest.dev/)
- [Playwright](https://playwright.dev/)
- [ramiabraham/cover-art-collection](https://github.com/ramiabraham/cover-art-collection)

## License

RetroOasis is licensed under the MIT License. See [LICENSE](./LICENSE).
