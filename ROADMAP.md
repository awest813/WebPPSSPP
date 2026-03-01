# Roadmap — Web PSP Emulator

This document tracks what is shipped, what is in flight, and what is planned.
Items are ordered roughly by value-to-effort ratio within each milestone.

---

## Current state — v1.0 (shipped)

The MVP is live on branch `claude/web-psp-emulator-vOHRd`.

| Area | What ships |
|------|-----------|
| **Emulation** | EmulatorJS PPSSPP core loaded from the stable CDN |
| **File loading** | Drag-and-drop or click-to-browse; blob-URL handoff to EJS; extension validation |
| **Browser checks** | SharedArrayBuffer + WebGL 2 pre-flight with actionable error messages |
| **Cross-origin isolation** | `coi-serviceworker.js` for static hosts; Vite headers in dev |
| **Controls** | EJS built-in toolbar (fullscreen, mute, volume, save/load state, touch pad, gamepad) + our header bar (Quick Save/Load, Reset, New Game, volume slider, F1/F5/F7 shortcuts) |
| **Persistence** | `localStorage`: volume, last-game-name |
| **Build** | Vite 5 + TypeScript 5; `npm run dev` / `npm run build` |

---

## v1.1 — Polish & developer experience

_Focus: no new features, just the rough edges that affect daily use._

- [ ] **Save-state slot picker** — swap the hard-coded slot 1 in Quick Save/Load
      for a 1–9 dropdown in the header; persist the selected slot in
      `localStorage`.
      _Files: `src/ui.ts`, `src/main.ts`_

- [ ] **File-size warning** — before handing a ROM to EJS, warn if it exceeds
      ~800 MB (risk of OOM on devices with <4 GB RAM); let the user cancel.
      _Files: `src/emulator.ts`_

- [ ] **BIOS file picker** — add an optional secondary file input on the landing
      page and pass the blob URL to `window.EJS_biosUrl`. Some titles exhibit
      better compatibility with a PSP firmware dump.
      _Files: `src/ui.ts`, `src/emulator.ts` (extend `LaunchOptions`)_

- [ ] **Keyboard shortcut overlay** — pressing `?` shows a modal listing all
      keyboard shortcuts and the EJS ⚙ controls.
      _Files: `src/ui.ts`, `src/style.css`_

- [ ] **Error retry without reload** — after an error, reset state and re-show
      the landing screen so the user can try a different file without a full
      page reload.
      _Files: `src/emulator.ts`, `src/ui.ts`, `src/main.ts`_

- [ ] **Gamepad connection indicator** — listen to `gamepadconnected` /
      `gamepaddisconnected` and display a controller icon + name in the status
      bar.
      _Files: `src/ui.ts`, `src/style.css`_

---

## v1.2 — Performance & UX

_Focus: make the emulator feel fast and trustworthy for regular users._

- [ ] **Real loading-progress bar** — EmulatorJS fires `EJS_onLoadProgress`
      (if available) or we can intercept `XMLHttpRequest` / `fetch` via a
      wrapper to display actual bytes downloaded; replace the current spinner
      with a horizontal progress bar.
      _Files: `src/emulator.ts`, `src/ui.ts`, `src/style.css`_

- [ ] **Screenshot download** — add a camera button that calls
      `canvas.toDataURL("image/png")` on the EJS canvas and triggers a
      `<a download>` click.
      _Files: `src/ui.ts`_

- [ ] **Recently-played list** — store the last 10 game names + load timestamps
      in `localStorage`; render them as clickable chips on the landing screen
      (display only — no ROM caching, the user still has to pick the file again).
      _Files: `src/main.ts`, `src/ui.ts`, `src/style.css`_

- [ ] **FPS overlay** — a toggleable FPS counter in the top-right corner of the
      emulator canvas, sampled from `requestAnimationFrame` deltas.
      _Files: `src/ui.ts`, `src/style.css`_

- [ ] **PWA manifest** — `public/manifest.json` + `<link rel="manifest">` so
      Chrome can offer "Add to Home Screen"; use a simple app icon derived from
      the existing PSP gamepad SVG.
      _Files: `public/manifest.json`, `index.html`_

---

## v1.3 — Deployment & CI

_Focus: make it painless to ship the static build anywhere._

- [ ] **GitHub Actions build workflow** — `.github/workflows/ci.yml` that runs
      `npm ci && npm run build` on every push / PR; fails the check if
      TypeScript or Vite errors.
      _Files: `.github/workflows/ci.yml`_

- [ ] **GitHub Pages deploy workflow** — `.github/workflows/deploy.yml` that
      deploys `dist/` to `gh-pages`; the `coi-serviceworker.js` handles headers
      since GH Pages doesn't allow custom response headers.
      _Files: `.github/workflows/deploy.yml`_

- [ ] **Netlify config** — `netlify.toml` with `[[headers]]` rules for
      `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` so the
      service-worker reload dance is skipped on Netlify.
      _Files: `netlify.toml`_

- [ ] **Docker / nginx self-host** — `Dockerfile` + `nginx.conf` snippet with
      the two required headers for anyone running on their own VPS.
      _Files: `Dockerfile`, `nginx.conf`_

---

## v2.0 — Library & multi-session

_Focus: turn a single-game tool into a real game library experience._

- [ ] **Hot-swap without page reload** — investigate whether EJS can be torn
      down and re-initialised in the same document. This requires removing all
      injected `<script>`, `<style>`, and `<canvas>` elements, deleting
      `window.EJS_*` globals, and replacing the `#ejs-player` container before
      re-injecting `loader.js`. Spike work needed before committing to this.
      _Complexity: high; may not be feasible without EJS changes upstream._

- [ ] **IndexedDB game library** — store game metadata (name, extension, cover
      art URL if user supplies one, last-played timestamp, total playtime) in
      IndexedDB. ROM files themselves are never stored.
      _Files: new `src/library.ts`_

- [ ] **Save-file export / import** — add "Export Save" and "Import Save"
      buttons that read/write from the EJS IndexedDB store. EJS already stores
      saves under a well-known key; we surface the raw bytes as a `.sav`
      download / upload.
      _Files: `src/emulator.ts`, `src/ui.ts`_

- [ ] **Cheat code manager** — pass an array to `window.EJS_cheats` and expose
      a simple textarea or list UI for entering GameShark / CWCheat codes.
      _Files: `src/emulator.ts` (extend `LaunchOptions`), new `src/cheats.ts`_

---

## v3.0 — Advanced features

_Long-horizon; only after v2.0 is solid._

- [ ] **Custom key-binding UI** — visual PSP button grid; user clicks a button
      cell and presses the desired key; persisted in `localStorage` as
      `EJS_defaultControls` format.
      _Files: new `src/keybindings.ts`, `src/style.css`_

- [ ] **Shader presets** — surface EJS's built-in shader support (`EJS_shaders`)
      as a drop-down list (CRT scanlines, LCD grid, sharp nearest-neighbour,
      xBRZ upscale). Persist chosen preset.
      _Files: `src/ui.ts`, `src/emulator.ts`_

- [ ] **Mobile-first redesign** — dedicated layout for phones: larger virtual
      buttons, haptic feedback via the Vibration API, portrait/landscape
      detection that resizes the canvas.
      _Files: `src/style.css`, `src/ui.ts`_

- [ ] **Offline PWA / core caching** — a full service worker that pre-caches
      the PPSSPP `.wasm` and `.js` assets after first use so the emulator
      launches without internet.
      _Replaces `coi-serviceworker.js` with a more capable Workbox-based SW._

---

## Out of scope (permanently)

- PSP ad-hoc or infrastructure **networking / multiplayer** — requires a relay
  server and is architecturally complex; not planned for this client-only project.
- **ROM distribution** — this project will never include or link to ROM files.
- **BIOS distribution** — same legal constraint; the BIOS file picker is opt-in
  and user-supplied.
- Compiling **PPSSPP from source** — EmulatorJS provides the pre-built WASM
  core; recompiling it is a separate CI project outside this repo's scope.

---

## Contributing

Bug reports and feature requests welcome via GitHub Issues.
For larger features, open a Discussion first to align on approach before coding.
