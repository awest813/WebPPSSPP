# RetroVault

A browser-based multi-system retro game emulator powered by [EmulatorJS](https://emulatorjs.org) and WebAssembly. No server required — everything runs client-side. You supply the ROMs.

---

## Quick Start

```bash
npm install
npm run dev
```

Open **http://localhost:5173** in Chrome or Firefox.

> **First visit on a static host:** `coi-serviceworker.js` registers and reloads the page once to enable `SharedArrayBuffer` support — this is expected.

---

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server with hot-reload on port 5173 |
| `npm run build` | Type-check + produce optimised static output in `dist/` |
| `npm run preview` | Serve the `dist/` build locally on port 4173 |
| `npm test` | Run Vitest unit tests |

---

## Features

- **20 supported systems** — PSP, N64, PS1, DS, GBA, GBC, GB, SNES, NES, Genesis, Game Gear, Master System, Atari 2600, Arcade (MAME), Saturn, Dreamcast, MAME 2003+, Atari 7800, Lynx, Neo Geo Pocket
- **Hardware-aware performance tiers** — automatic Low/Medium/High/Ultra classification based on GPU benchmark, CPU cores, RAM, and device type
- **Per-system, per-tier core settings** — granular tuning tables for PSP, N64, PS1, DS, GBA, Saturn, and Dreamcast
- **ROM library** — drag-and-drop import with IndexedDB persistence, metadata caching, and blob preloading on hover
- **Save state management** — 4 manual slots + auto-save on tab close, screenshot thumbnails, export/import as portable `.state` files, cross-game save migration
- **BIOS management** — upload and manage BIOS files for PS1, Saturn, Dreamcast, and Lynx from the Settings panel
- **ZIP extraction** — transparent ROM extraction from ZIP archives via the browser-native `DecompressionStream` API
- **ROM patching** — IPS, BPS, and UPS patch formats applied on-the-fly with CRC32 verification
- **Multi-disc support** — `.m3u` playlist handling for PS1, Saturn, and Dreamcast multi-disc games
- **PWA installable** — works offline, installable to home screen via Chrome/Edge "Add to Home Screen"
- **Touch controls** — virtual gamepad overlay with draggable button layout, haptic feedback, and per-system layout persistence
- **Orientation lock** — auto-lock to landscape when a game starts (Android Chrome)
- **FPS overlay** — real-time framerate, tier indicator, dropped-frame counter, and optional audio oscilloscope visualiser
- **Adaptive quality** — automatic tier downgrade prompt when sustained low FPS is detected; per-game tier memory
- **Audio latency adaptation** — probes hardware audio latency and adjusts buffer size to prevent crackles on Bluetooth/USB audio
- **AudioWorklet path** — low-latency audio processing in a dedicated thread with underrun detection
- **WebGPU opt-in** — experimental WebGPU rendering pre-warm (Chrome 113+)
- **Shader cache** — IndexedDB-backed GLSL cache with LRU eviction and `KHR_parallel_shader_compile` pre-compilation
- **Battery-aware** — auto-switches to Performance mode when battery drops below 20%

---

## Supported Systems

| System | Short | Core | Extensions | BIOS |
|--------|-------|------|------------|------|
| PlayStation Portable | PSP | PPSSPP | `.iso` `.cso` `.elf` | — |
| Nintendo 64 | N64 | mupen64plus-next | `.n64` `.v64` `.z64` | — |
| Nintendo DS | DS | DeSmuME 2015 | `.nds` | — |
| PlayStation 1 | PS1 | Beetle PSX HW | `.pbp` `.chd` `.cue` `.img` `.mdf` `.ccd` `.m3u` | Optional |
| Game Boy Advance | GBA | mGBA | `.gba` | — |
| Game Boy Color | GBC | Gambatte | `.gbc` | — |
| Game Boy | GB | Gambatte | `.gb` | — |
| Super Nintendo | SNES | Snes9x | `.snes` `.smc` `.sfc` `.fig` `.bs` | — |
| Nintendo Entertainment System | NES | FCEUmm | `.nes` `.fds` `.unf` `.unif` | — |
| Sega Genesis / Mega Drive | Genesis | Genesis Plus GX | `.md` `.smd` `.gen` | — |
| Sega Game Gear | GG | Genesis Plus GX | `.gg` | — |
| Sega Master System | SMS | Genesis Plus GX | `.sms` | — |
| Sega Saturn | Saturn | Beetle Saturn | `.cue` `.chd` `.mdf` `.img` `.ccd` `.m3u` | **Required** |
| Dreamcast | DC | Flycast | `.cdi` `.gdi` `.chd` `.m3u` | **Required** |
| Atari 2600 | 2600 | Stella | `.a26` | — |
| Atari 7800 | 7800 | ProSystem | `.a78` `.bin` | — |
| Atari Lynx | Lynx | Handy | `.lnx` `.lyx` | Optional |
| Arcade (MAME) | Arcade | MAME | `.zip` | — |
| Arcade (MAME 2003+) | MAME+ | MAME 2003+ | `.zip` `.7z` | — |
| Neo Geo Pocket | NGP | Mednafen NGP | `.ngp` `.ngc` `.ngpc` | — |

All cores are fetched on-demand from the EmulatorJS CDN at game launch — nothing is bundled with the app.

---

## Performance Tiers

RetroVault automatically detects your hardware at startup and selects one of four performance tiers. Each tier picks core settings that balance visual quality against frame rate for that class of device.

| Tier | Typical Hardware | Description |
|------|-----------------|-------------|
| **Low** | Chromebook, old phone, software GPU | Maximum frameskip, native resolution, large audio buffer for stability |
| **Medium** | Mid-range laptop, integrated GPU | Light frameskip, native resolution, 2x anisotropic filtering |
| **High** | Gaming laptop, discrete GPU | No frameskip, 2x internal res (PSP/PS1), 4x aniso, PGXP enabled |
| **Ultra** | High-end desktop GPU | 4-8x internal res, 16x aniso, xBRZ texture shader, lowest audio latency |

The tier is determined by a points-based scoring system:

- **CPU** (0-30 pts): core count — 8+ cores scores 30, 2 cores scores 6
- **RAM** (0-20 pts): `navigator.deviceMemory` — 8 GB+ scores 20
- **GPU benchmark** (0-40 pts): WebGL draw-call micro-benchmark (VAO-aware, 12 ms budget)
- **GPU capabilities** (0-16 pts): anisotropic filtering, float textures, instanced arrays, Multi-Draw, MRT, VAO, compressed textures
- **Chromebook penalty**: all points x 0.75 (power-constrained SoCs throttle under GPU load)

You can override the auto-detected tier at any time using the **Performance / Quality / Auto** control in Settings.

### Audio latency adaptation

The audio buffer size is tuned dynamically. At launch, RetroVault probes `AudioContext.baseLatency` to detect high-latency audio hardware (Bluetooth headsets, USB DACs). If the hardware reports >20 ms base latency, the audio buffer is automatically promoted to "large" — even on a high or ultra GPU tier — to prevent crackles. Low-latency hardware (<=8 ms) gets the minimum buffer for the tightest audio sync.

### Adaptive quality

If sustained low FPS (<25 fps for 10+ seconds) is detected during gameplay, RetroVault prompts you to downgrade to the next lower tier. The preference is remembered per game so subsequent launches use the stable tier automatically. You can clear per-game tier overrides by changing the performance mode in Settings.

---

## Detailed 3D Core Settings

### PSP (PPSSPP)

| Setting | Low | Medium | High | Ultra |
|---------|-----|--------|------|-------|
| Internal resolution | 1x | 1x | 2x | 4x |
| Texture scaling | 1 (off) | 1 (off) | 2x xBRZ | 5x xBRZ |
| Texture shader (GPU) | Off | Off | Off | xBRZ |
| Anisotropic filtering | Off | 2x | 4x | 16x |
| Audio resampling | Off | On | On | On |
| Audio latency | Large | Medium | Medium | Minimum |
| PSP CPU clock | Default | Default | Default | 333 MHz |
| Frameskip | Auto (3) | Auto (1) | None | None |
| In-flight frames | 1 | 2 | 3 | 3 |
| Buffer effects | Skip | Skip | Full | Full |

### Nintendo 64 (mupen64plus-next / GlideN64)

| Setting | Low | Medium | High | Ultra |
|---------|-----|--------|------|-------|
| RDP plugin | Rice | GlideN64 | GlideN64 | GlideN64 |
| Resolution factor | 1x | 1x | 2x | 4x |
| Bilinear mode | Standard | Standard | 3-point | 3-point |
| Framebuffer emulation | Off | On | On | On |
| HW lighting | Off | Off | On | On |
| Texture filter | None | None | Smooth 1 | Smooth 4 |
| Noise emulation | Off | Off | On | On |

### PlayStation 1 (Beetle PSX HW)

| Setting | Low | Medium | High | Ultra |
|---------|-----|--------|------|-------|
| Internal resolution | 1x native | 1x native | 2x | 8x |
| CPU dynarec | Off | On | On | On |
| PGXP mode | Off | Off | Memory | Memory + CPU |
| GPU overclock | 1x | 1x | 4x | 8x |
| GTE overclock | - | - | - | On |
| CD fast load | 2x | 4x | 6x | 8x |
| Texture filter | Nearest | Nearest | Bilinear | Bilinear |

### Sega Saturn (Beetle Saturn)

| Setting | Low | Medium | High | Ultra |
|---------|-----|--------|------|-------|
| Resolution | 1x native | 2x | 4x | 8x |
| Deinterlace | Weave | Bob | Bob | Yadif |

### Dreamcast (Flycast)

| Setting | Low | Medium | High | Ultra |
|---------|-----|--------|------|-------|
| Internal resolution | 640x480 | 1280x960 | 1920x1440 | 2560x1920 |
| Anisotropic filtering | Off | 4x | 8x | 16x |
| Texture upscaling | 1x | 1x | 2x | 4x |
| DSP | Off | On | On | On |
| Auto frame skip | On | Off | Off | Off |

### GBA (mGBA)

| Setting | Low | Medium | High | Ultra |
|---------|-----|--------|------|-------|
| Frameskip | 1 | 0 | 0 | 0 |
| Colour correction | Off | GBA LCD | GBA LCD | GBA LCD |
| Interframe blending | Off | Off | Mix | Mix |
| Idle optimization | Remove Known | Remove Known | Remove Known | Remove Known |

### Nintendo DS (DeSmuME 2015)

| Setting | Low | Medium | High | Ultra |
|---------|-----|--------|------|-------|
| CPU mode | Interpreter | JIT | JIT | JIT |
| Internal resolution | 256x192 | 256x192 | 512x384 | 1024x768 |
| Colour depth | 16-bit | 16-bit | 32-bit | 32-bit |
| OpenGL mode | Off | Off | On | On |
| Frameskip | 2 | 1 | 0 | 0 |

---

## Save States

RetroVault provides a full save state system independent of EmulatorJS's built-in saves:

- **4 manual slots** (1-4) — save/load via the in-game header buttons or keyboard shortcuts
- **Auto-save** (slot 0) — automatically captures state when the tab is hidden or closed; offers restore on next launch
- **Screenshots** — thumbnail captured at save time, displayed in the save gallery
- **Export/Import** — download `.state` files for backup or transfer to another device
- **Migration** — move saves between games when a ROM is renamed (Settings > Migrate Saves)

### Keyboard shortcuts (while playing)

| Key | Action |
|-----|--------|
| **F5** | Quick Save (slot 1) |
| **F7** | Quick Load (slot 1) |
| **F1** | Reset game |
| **Esc** | Return to library |

---

## BIOS Files

Some systems require BIOS files to run games. Upload them in Settings > BIOS Files.

| System | File | Required |
|--------|------|----------|
| PS1 | `scph5501.bin` (NTSC-U) | Optional (improves compatibility) |
| PS1 | `scph1001.bin` (NTSC-U) | Optional |
| PS1 | `scph5502.bin` (PAL) | Optional |
| Saturn | `sega_101.bin` (JP) | **Required** |
| Saturn | `mpr-17933.bin` (US/EU) | **Required** |
| Dreamcast | `dc_boot.bin` | **Required** |
| Dreamcast | `dc_flash.bin` | **Required** |
| Lynx | `lynxboot.img` | Optional |

---

## ROM Patching

Drop an `.ips`, `.bps`, or `.ups` patch file onto the app to apply it to a game in your library. Supported formats:

- **IPS** — International Patching System (NES/SNES era)
- **BPS** — Binary Patching System (modern, CRC32-verified)
- **UPS** — Universal Patching System (XOR-based, CRC32-verified)

The patched ROM replaces the stored copy in your library.

---

## Multi-Disc Games

For multi-disc PS1, Saturn, or Dreamcast games:

1. Drop the `.m3u` playlist file onto the app
2. RetroVault reads the playlist and prompts you to select each disc image
3. All disc images are stored in the library for future launches
4. The emulator handles disc swapping automatically

---

## Mobile & PWA

- **Install as app** — open in Chrome or Edge on Android, then Settings > "Install RetroVault App" or use the browser's "Add to Home Screen"
- **Touch controls** — virtual D-pad and face buttons appear automatically on touch devices; tap "Edit" in the game header to rearrange button positions
- **Haptic feedback** — brief vibration on button press/release (Android Chrome only)
- **Orientation lock** — auto-rotates to landscape when a game starts (Android Chrome)
- **Offline support** — the app shell is cached by the service worker for offline access

---

## Project Structure

```
index.html                     HTML shell (<div id="app">)
vite.config.ts                 Dev server with COOP/COEP headers + build config
tsconfig.json                  TypeScript configuration
vitest.config.ts               Test configuration

public/
  coi-serviceworker.js         Injects COOP/COEP headers for static hosting
  manifest.json                PWA manifest
  audio-processor.js           AudioWorklet processor for low-latency audio

src/
  main.ts                      Entry point — boot sequence, settings, wiring
  emulator.ts                  PSPEmulator class — EmulatorJS lifecycle + perf
  performance.ts               Hardware detection, GPU benchmark, tier classifier
  systems.ts                   System definitions + 4-tier core option tables
  library.ts                   GameLibrary — IndexedDB ROM store + blob cache
  ui.ts                        DOM construction and event wiring
  saves.ts                     SaveStateLibrary — save slots, export/import
  bios.ts                      BiosLibrary — BIOS file storage and validation
  archive.ts                   ZIP extraction (lazy-loaded)
  patcher.ts                   IPS/BPS/UPS patching (lazy-loaded)
  touchControls.ts             Virtual gamepad overlay (lazy-loaded)
  shaderCache.ts               WebGL shader cache with LRU eviction
  style.css                    Dark-theme CSS
  *.test.ts                    Unit tests (Vitest)

data/
  loader.js                    EmulatorJS loader entry point
  src/                         EmulatorJS runtime sources
  cores/                       Core registry metadata

docs/
  ROADMAP.md                   Feature roadmap and planned improvements
  CACHING.md                   Caching strategy documentation
```

---

## Usage

1. Drop a ROM file onto the app or click the drop zone to browse.
2. RetroVault auto-detects the system from the file extension.
3. If the extension is ambiguous (e.g. `.cue` matches PS1/Saturn) you'll be prompted to pick the system.
4. EmulatorJS downloads the appropriate core from the CDN (cached after first load).
5. The game boots automatically with tier-appropriate settings.

### Controls

**Keyboard defaults** (configurable inside the EmulatorJS settings menu):

| Button | Key | Button | Key |
|--------|-----|--------|-----|
| D-pad | Arrow keys | A / B | Z / X |
| X / Y | A / S | Start / Select | Enter / Shift |
| L / R | Q / W | | |

**Gamepad:** plug in a USB or Bluetooth gamepad — EmulatorJS maps it automatically via the Web Gamepad API.

**Mobile:** virtual D-pad and buttons appear automatically on touch-screen devices.

### In-game header controls

| Control | Action |
|---------|--------|
| <- Library | Return to library (Esc) |
| Save | Quick-save to slot 1 (F5) |
| Load | Quick-load from slot 1 (F7) |
| Saves | Open save state gallery |
| Reset | Restart the current game (F1) |
| FPS | Toggle FPS overlay |
| Edit | Rearrange touch control layout |
| Volume | Adjust volume (persisted) |

---

## Tech Stack

| Layer | Tool |
|-------|------|
| Build | [Vite 5](https://vitejs.dev) |
| Language | TypeScript 5 |
| Emulation | [EmulatorJS](https://emulatorjs.org) (RetroArch cores via CDN) |
| Rendering | WebGL 2 (hardware) / WebGL 1 (fallback) |
| Audio | Web Audio API + AudioWorklet |
| Persistence | `localStorage` (settings, per-game tiers, touch layouts); IndexedDB (ROMs, saves, BIOS, shader cache) |
| Tests | [Vitest](https://vitest.dev) |

### EmulatorJS CDN

```
https://cdn.emulatorjs.org/stable/data/
```

The `stable` channel is pinned to the latest tested release. RetroVault prefetches the JS glue and WASM binary for each system the user has in their library, and attempts ahead-of-time WebAssembly streaming compilation to minimise launch latency.

---

## Cross-Origin Isolation

The PSP (PPSSPP) core uses WebAssembly threads, which require `SharedArrayBuffer`. This API is only available in [Cross-Origin Isolated](https://web.dev/articles/cross-origin-isolation-guide) contexts:

```
Cross-Origin-Opener-Policy:  same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**Development:** `vite.config.ts` sets these headers on the dev server automatically.

**Production (static hosts):** `public/coi-serviceworker.js` intercepts all fetch responses and injects the headers. The page reloads once on first visit — this is expected. On Safari/WebKit, `credentialless` COEP is used instead of `require-corp` for CDN compatibility.

Other systems (NES, SNES, GBA, N64, PS1, etc.) do **not** require cross-origin isolation and will work on any standard host.

---

## Deploying to a Static Host

See [`guide.md`](guide.md) for step-by-step instructions for GitHub Pages, Netlify, Cloudflare Pages, and Vercel.

The short version: copy the `dist/` folder to any static host. The service worker handles the COOP/COEP requirement automatically. No server-side configuration is needed.

---

## Known Limitations

| Limitation | Details |
|-----------|---------|
| SharedArrayBuffer (PSP only) | Requires COOP + COEP isolation. Other systems are unaffected. |
| WebGL 2 (PSP, some PS1 settings) | Required for hardware-accelerated 3D cores. Chrome 58+, Firefox 51+. |
| Audio latency | Web Audio introduces several frames of buffering vs native; Bluetooth/USB audio adds more. The audio latency adapter mitigates this automatically. |
| Performance ceiling | Running a PSP (333 MHz MIPS + custom GPU) in a browser tab is demanding. Expect 25-60 fps depending on game and device. |
| No networking | PSP ad-hoc / infrastructure multiplayer is not implemented. |
| Save data path | EmulatorJS stores saves in IndexedDB keyed by game name. Renaming the ROM file can unlink existing saves (use the Migrate Saves tool). |
| Large ISOs | A 1 GB ISO creates a 1 GB Blob in browser memory. Fine on 8 GB+ desktop; may OOM on mobile. |
| iOS Safari | Cross-origin isolation via service worker is unreliable on older WebKit. Use Chrome or Firefox on desktop for best results. Safari 17+ works with `credentialless` COEP. |
| One game per session | EmulatorJS does not expose a clean `destroy()` API. Switching games requires a page reload (handled automatically). |
| 7-Zip archives | `.7z` files cannot be extracted in-browser. Extract the ROM manually first. |

### Tips

- **Start with simpler games** (2D, action, puzzle) before trying GPU-heavy 3D titles.
- **Use Chrome or Firefox on desktop** — they have the most complete WebAssembly and WebGL 2 implementations.
- **Enable hardware acceleration** in your browser settings.
- **CSO format** — compressed PSP ISOs (`.cso`) are smaller; PPSSPP decompresses them transparently.
- **Performance mode** — switch to Performance in Settings if games are stuttering; this forces the low-tier core settings regardless of detected hardware.
- **Hover to preload** — hovering over a game card preloads its ROM blob and prefetches the WASM core, making launches near-instant.

---

## Legal

This application does **not** include or distribute any ROM files, BIOS images, or proprietary assets. You must supply your own legally obtained game files.

EmulatorJS is licensed under [GPL-3.0](https://github.com/EmulatorJS/EmulatorJS/blob/main/LICENSE).
