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

## Supported Systems

| System | Short | Core | Extensions |
|--------|-------|------|------------|
| PlayStation Portable | PSP | PPSSPP | `.iso` `.cso` `.elf` |
| Nintendo 64 | N64 | mupen64plus-next | `.n64` `.v64` `.z64` |
| Nintendo DS | DS | DeSmuME 2015 | `.nds` |
| PlayStation 1 | PS1 | Beetle PSX HW | `.pbp` `.chd` `.cue` `.img` `.mdf` `.ccd` |
| Game Boy Advance | GBA | mGBA | `.gba` |
| Game Boy Color | GBC | Gambatte | `.gbc` |
| Game Boy | GB | Gambatte | `.gb` |
| Super Nintendo | SNES | Snes9x | `.smc` `.sfc` `.fig` `.bs` |
| Nintendo Entertainment System | NES | FCEUmm | `.nes` `.fds` `.unf` |
| Sega Genesis / Mega Drive | Genesis | Genesis Plus GX | `.md` `.smd` `.gen` |
| Sega Game Gear | GG | Genesis Plus GX | `.gg` |
| Sega Master System | SMS | Genesis Plus GX | `.sms` |
| Atari 2600 | 2600 | Stella | `.a26` |
| Arcade (MAME) | Arcade | MAME | `.zip` |

All cores are fetched on-demand from the EmulatorJS CDN at game launch — nothing is bundled with the app.

---

## Performance Tiers

RetroVault automatically detects your hardware at startup and selects one of four performance tiers. Each tier picks core settings that balance visual quality against frame rate for that class of device.

| Tier | Typical Hardware | Description |
|------|-----------------|-------------|
| **Low** | Chromebook, old phone, software GPU | Maximum frameskip, native resolution, large audio buffer for stability |
| **Medium** | Mid-range laptop, integrated GPU | Light frameskip, native resolution, 2× anisotropic filtering |
| **High** | Gaming laptop, discrete GPU | No frameskip, 2× internal res (PSP/PS1), 4× aniso, PGXP enabled |
| **Ultra** | High-end desktop GPU | 4–8× internal res, 16× aniso, xBRZ texture shader, lowest audio latency |

The tier is determined by a points-based scoring system:

- **CPU** (0–30 pts): core count — 8+ cores scores 30, 2 cores scores 6
- **RAM** (0–20 pts): `navigator.deviceMemory` — 8 GB+ scores 20
- **GPU benchmark** (0–40 pts): WebGL draw-call micro-benchmark in 12 ms
- **GPU capabilities** (0–16 pts): anisotropic filtering, float textures, instanced arrays, Multi-Draw, MRT, VAO, compressed textures
- **Chromebook penalty**: all points × 0.75 (power-constrained SoCs throttle under GPU load)

You can override the auto-detected tier at any time using the **Performance / Quality / Auto** control in Settings.

### Audio latency adaptation

The audio buffer size is also tuned dynamically. At launch, RetroVault probes `AudioContext.baseLatency` to detect high-latency audio hardware (Bluetooth headsets, USB DACs). If the hardware reports >20 ms base latency, the audio buffer is automatically promoted to "large" — even on a high or ultra GPU tier — to prevent crackles. Low-latency hardware (≤8 ms) gets the minimum buffer for the tightest audio sync.

---

## Detailed 3D Core Settings

### PSP (PPSSPP)

| Setting | Low | Medium | High | Ultra |
|---------|-----|--------|------|-------|
| Internal resolution | 1× | 1× | 2× | 4× |
| Texture scaling | 1 (off) | 1 (off) | 2× xBRZ | 5× xBRZ |
| Texture shader (GPU) | Off | Off | Off | xBRZ |
| Anisotropic filtering | Off | 2× | 4× | 16× |
| Audio resampling | Off | **On** | On | On |
| Audio latency | Large | Medium | Medium | Minimum |
| PSP CPU clock | Default | Default | Default | **333 MHz** |
| Frameskip | Auto (3) | Auto (1) | None | None |
| In-flight frames | 1 | 2 | 3 | 3 |
| Buffer effects | Skip | Skip | Full | Full |

### Nintendo 64 (mupen64plus-next / GlideN64)

| Setting | Low | Medium | High | Ultra |
|---------|-----|--------|------|-------|
| RDP plugin | Rice | GlideN64 | GlideN64 | GlideN64 |
| Resolution factor | 1× | 1× | 2× | 4× |
| Bilinear mode | Standard | Standard | 3-point | 3-point |
| Framebuffer emulation | Off | On | On | On |
| HW lighting | Off | Off | On | On |
| Texture filter | None | None | **Smooth 1** | **Smooth 4** |
| Texture enhancement | — | — | — | **As Is** |
| Noise emulation | Off | Off | On | On |

### PlayStation 1 (Beetle PSX HW)

| Setting | Low | Medium | High | Ultra |
|---------|-----|--------|------|-------|
| Internal resolution | 1× native | 1× native | 2× | **8×** |
| CPU dynarec | Off | On | On | On |
| PGXP mode | Off | Off | Memory | **Memory + CPU** |
| PGXP textures | Off | Off | On | On |
| GPU overclock | 1× | 1× | **4×** | **8×** |
| GTE overclock | — | — | — | **On** |
| CD fast load | 2× | 4× | 6× | 8× |
| Texture filter | Nearest | Nearest | Bilinear | Bilinear |

---

## Project Structure

```
index.html                     HTML shell (<div id="app">)
vite.config.ts                 Dev server with COOP/COEP headers + build config
tsconfig.json                  TypeScript configuration
public/
  coi-serviceworker.js         Injects COOP/COEP headers for static hosting
  manifest.json                PWA manifest
src/
  main.ts                      Entry point — boot sequence, settings, wiring
  emulator.ts                  PSPEmulator class — EmulatorJS lifecycle + perf
  performance.ts               Hardware detection, GPU benchmark, tier classifier
  systems.ts                   System definitions + 4-tier core option tables
  library.ts                   GameLibrary — IndexedDB ROM store + blob cache
  ui.ts                        DOM construction and event wiring
  style.css                    Dark-theme CSS
data/
  loader.js                    EmulatorJS loader entry point
  src/                         EmulatorJS runtime sources
  cores/                       Core registry metadata
docs/
  CACHING.md                   Caching strategy documentation
  ROADMAP.md                   Feature roadmap and planned improvements
```

---

## Usage

1. Drop a ROM file onto the app or click the library area to browse.
2. RetroVault auto-detects the system from the file extension.
3. If the extension is ambiguous (e.g. `.zip`) you'll be prompted to pick the system.
4. EmulatorJS downloads the appropriate core from the CDN (cached after first load).
5. The game boots automatically with tier-appropriate settings.

### Controls

**Keyboard defaults** (configurable inside the EmulatorJS ⚙ settings menu):

| PSP Button | Key | Generic button | Key |
|-----------|-----|---------------|-----|
| D-pad | Arrow keys | A / B | Z / X |
| ✕ / ○ / □ / △ | Z / X / A / S | Start / Select | Enter / Backspace |
| L / R | Q / E | Analog stick | WASD |

**Gamepad:** plug in a USB or Bluetooth gamepad — EmulatorJS maps it automatically via the Web Gamepad API.

**Mobile:** virtual D-pad and buttons appear automatically on touch-screen devices.

### Application controls

| Control | Action |
|---------|--------|
| 💾 Save | Quick-save to slot 1 |
| 📂 Load | Quick-load from slot 1 |
| ↺ Reset | Restart the current game |
| 📁 New Game | Return to library |
| Volume slider | Adjust volume (persisted) |
| **F5** | Quick-save slot 1 |
| **F7** | Quick-load slot 1 |
| **F1** | Reset |
| ⚙ EmulatorJS | Full settings: key remap, shaders, save slots, … |

---

## Tech Stack

| Layer | Tool |
|-------|------|
| Build | [Vite 5](https://vitejs.dev) |
| Language | TypeScript 5 |
| Emulation | [EmulatorJS](https://emulatorjs.org) (RetroArch cores via CDN) |
| Rendering | WebGL 2 (hardware) / WebGL 1 (fallback) |
| Audio | Web Audio API |
| Persistence | `localStorage` (settings); IndexedDB (ROM blobs) |
| Tests | [Vitest](https://vitest.dev) |

### EmulatorJS CDN

```
https://cdn.emulatorjs.org/stable/data/
```

The `stable` channel is pinned to the latest tested release. RetroVault prefetches the JS glue and WASM binary for each system the user has in their library, and attempts ahead-of-time WebAssembly streaming compilation to minimise launch latency.

---

## Cross-Origin Isolation

The PSP (PPSSPP) core uses WebAssembly threads, which require `SharedArrayBuffer`. This API is only available in [Cross-Origin Isolated](https://web.dev/cross-origin-isolation-guide/) contexts:

```
Cross-Origin-Opener-Policy:  same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**Development:** `vite.config.ts` sets these headers on the dev server automatically.

**Production (static hosts):** `public/coi-serviceworker.js` intercepts all fetch responses and injects the headers. The page reloads once on first visit — this is expected.

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
| Performance ceiling | Running a PSP (333 MHz MIPS + custom GPU) in a browser tab is demanding. Expect 25–60 fps depending on game and device. CPU-heavy 3D titles may run slower. |
| No networking | PSP ad-hoc / infrastructure multiplayer is not implemented. |
| Save data path | EmulatorJS stores saves in IndexedDB keyed by game name. Renaming the ROM file can unlink existing saves. |
| Large ISOs | A 1 GB ISO creates a 1 GB Blob in browser memory. Fine on 8 GB+ desktop; may OOM on mobile. |
| iOS Safari | Cross-origin isolation via service worker is unreliable on WebKit. Use Chrome or Firefox on desktop for best results. |
| One game per session | EmulatorJS does not expose a clean `destroy()` API. Switching games requires a page reload (the library handles this). |

### Tips

- **Start with simpler games** (2D, action, puzzle) before trying GPU-heavy 3D titles.
- **Use Chrome or Firefox on desktop** — they have the most complete WebAssembly and WebGL 2 implementations.
- **Enable hardware acceleration** in your browser settings.
- **CSO format** — compressed PSP ISOs (`.cso`) download faster; PPSSPP decompresses them transparently.
- **Performance mode** — switch to Performance in the Settings panel if games are stuttering; this forces the low-tier core settings regardless of detected hardware.

---

## Legal

This application does **not** include or distribute any ROM files, BIOS images, or proprietary assets. You must supply your own legally obtained game files.

EmulatorJS is licensed under [GPL-3.0](https://github.com/EmulatorJS/EmulatorJS/blob/main/LICENSE).
