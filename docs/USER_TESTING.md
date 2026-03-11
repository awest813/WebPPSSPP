# RetroVault — User Testing Guide

This document provides structured manual test scenarios for RetroVault. Use it to validate a new build, verify a bug fix, or perform pre-release testing. Each section lists the pre-conditions, steps, and expected outcomes.

> **Automated tests** cover unit and integration logic (`npm test`). This guide covers the user-visible flows that require a real browser environment.

---

## Prerequisites

Before running any tests:

1. Install dependencies: `npm install`
2. Start the dev server: `npm run dev`
3. Open `http://localhost:5173` in Chrome or Edge (desktop recommended for PSP tests)
4. Open DevTools Console and verify `self.crossOriginIsolated === true`
5. Have at least one legally obtained ROM file available for testing

---

## 1. First Launch & Environment

| # | Step | Expected |
|---|------|----------|
| 1.1 | Open the app for the first time | Landing screen loads with drag-and-drop zone; no console errors |
| 1.2 | Run `self.crossOriginIsolated` in DevTools console | Returns `true` |
| 1.3 | Check DevTools → Application → Service Workers | `coi-serviceworker.js` is active and running |
| 1.4 | Run `npm run doctor` in terminal | All checks pass; no blockers reported |
| 1.5 | Resize browser window to mobile width (375 px) | Layout adjusts gracefully; no overflow |

---

## 2. ROM Library

### 2.1 Adding Games

| # | Step | Expected |
|---|------|----------|
| 2.1.1 | Drag a ROM file onto the drop zone | File is imported; game card appears in library with correct system icon and name |
| 2.1.2 | Click the import button and use file picker to add a second ROM | Second card appears; library updates without full page reload |
| 2.1.3 | Add a ZIP archive containing a ROM | Archive is extracted transparently; game card uses the ROM filename inside the archive |
| 2.1.4 | Add a 7z archive | Archive is extracted; game card appears |
| 2.1.5 | Add a RAR archive | Archive is extracted via libunrar.js; game card appears |
| 2.1.6 | Add an unsupported file type (e.g. `.pdf`) | Clear error message shown; no crash |

### 2.2 Library Interaction

| # | Step | Expected |
|---|------|----------|
| 2.2.1 | Hover over a game card | Hover effect visible; Play and Delete buttons appear |
| 2.2.2 | Click the game card's delete button | Confirmation prompt shown; on confirm, card is removed |
| 2.2.3 | Add 10+ games | Library grid scrolls; all cards are visible and correctly labelled |
| 2.2.4 | Refresh the page after adding games | Library re-populates from IndexedDB; all added games still present |

---

## 3. Launching a Game

| # | Step | Expected |
|---|------|----------|
| 3.1 | Click Play on any game card | Emulator overlay appears; game loads and starts rendering |
| 3.2 | Launch a PSP game | PPSSPP core loads; `self.crossOriginIsolated === true` required |
| 3.3 | Launch an N64 game | mupen64plus-Next core loads; game renders at the configured internal resolution |
| 3.4 | Launch a GBA game | mGBA core loads; game renders immediately |
| 3.5 | During gameplay, press Escape | Returns to the library; emulator is torn down cleanly |
| 3.6 | Return to library and relaunch the same game | Game restarts from scratch (or offers auto-save restore if auto-save is enabled) |

---

## 4. Performance Tier Detection

| # | Step | Expected |
|---|------|----------|
| 4.1 | Open Settings → Performance | Current device tier (Low/Medium/High/Ultra) displayed; GPU renderer string shown |
| 4.2 | Change Performance Mode to "Low" | Tier badge in header updates; next game launch uses Low-tier core settings |
| 4.3 | Change Performance Mode back to "Auto" | Tier reverts to auto-detected value |
| 4.4 | Check "Estimated VRAM" field in Performance tab | A numeric MB value is displayed (heuristic estimate) |
| 4.5 | Open Settings → Debug | GPU renderer string, max texture size, ETC2/ASTC support, MRT count visible |

---

## 5. Save States

### 5.1 Manual Saves

| # | Step | Expected |
|---|------|----------|
| 5.1.1 | Launch a game, press F5 | Save state written to slot 1; brief confirmation shown |
| 5.1.2 | Press F7 | State loaded from slot 1; game resumes from saved point |
| 5.1.3 | Open Settings → Saves (or save gallery icon) | Gallery modal shows slot 1 with a 160×120 thumbnail and timestamp |
| 5.1.4 | Click Save in slot 2 from the gallery | State saved to slot 2; thumbnail and timestamp update |
| 5.1.5 | Click Export on a filled slot | Browser downloads a `.state` file |
| 5.1.6 | Delete the state from slot 2, then Import from the exported file | Slot 2 re-populates with the imported thumbnail |

### 5.2 Auto-Save

| # | Step | Expected |
|---|------|----------|
| 5.2.1 | Enable Auto-Save in Settings | Toggle turns on |
| 5.2.2 | Launch a game, play briefly, then close the tab | State is written to slot 0 (auto-save) |
| 5.2.3 | Reopen the app and launch the same game | "Restore auto-save?" prompt appears |
| 5.2.4 | Accept the restore prompt | Game resumes from the auto-saved point |
| 5.2.5 | Decline the restore prompt | Game starts fresh; auto-save slot remains for next time |

---

## 6. BIOS Management

| # | Step | Expected |
|---|------|----------|
| 6.1 | Open Settings → BIOS | List of required BIOS files shown with red (missing) dots |
| 6.2 | Upload a PS1 BIOS file (`scph1001.bin` or similar) | Status dot turns green; file name confirmed |
| 6.3 | Launch a PS1 game after uploading BIOS | Game boots with the correct BIOS |
| 6.4 | Upload a file with the wrong name | Warning shown; system lists expected filename(s) |
| 6.5 | Refresh the page; re-open Settings → BIOS | Previously uploaded BIOS files still listed as green (persisted in IndexedDB) |

---

## 7. ROM Patching

| # | Step | Expected |
|---|------|----------|
| 7.1 | Select a game in the library; click the Patch button | Patch file chooser opens |
| 7.2 | Apply a valid IPS patch | Confirmation shown; patched ROM launches correctly |
| 7.3 | Apply a valid BPS patch | Same as above; three-CRC verification passes |
| 7.4 | Apply a valid UPS patch | Same as above |
| 7.5 | Apply an invalid/corrupt patch file | Clear error message; original ROM unaffected |

---

## 8. Post-Processing Effects (WebGPU)

| # | Step | Expected |
|---|------|----------|
| 8.1 | Open Settings → Display; enable WebGPU | Toggle activates; "WebGPU available" indicator shown if supported |
| 8.2 | Select "CRT" post-processing effect | Scanlines and barrel distortion overlay applied to game canvas |
| 8.3 | Select "LCD" effect | RGB sub-pixel grid visible over canvas |
| 8.4 | Select "Bloom" effect | Bright areas have a visible glow halo |
| 8.5 | Select "FXAA" effect | Jagged edges on game geometry visibly smoothed |
| 8.6 | Select "Sharpen" effect | Image detail increased; no major artefacts |
| 8.7 | Select "None" (disable effects) | Canvas returns to raw core output |
| 8.8 | On a Low/Medium tier device, enable Bloom | Effect is automatically capped/disabled by tier-aware config |

---

## 9. Touch Controls (Mobile / Responsive)

| # | Step | Expected |
|---|------|----------|
| 9.1 | Resize browser to mobile width (375 px) or use DevTools device emulation | Touch controls toggle becomes available in Settings |
| 9.2 | Enable Touch Controls in Settings | 12 virtual buttons render over the game canvas |
| 9.3 | Drag a button to a new position | Button snaps to new position; layout persists after page reload |
| 9.4 | Rotate device or switch DevTools orientation | Layout rebuilds for the new orientation; portrait and landscape use separate stored positions |
| 9.5 | Tap and hold D-pad/face buttons during gameplay | Inputs register in-game with visible pressed-state feedback |
| 9.6 | Disable Touch Controls in Settings | Overlay buttons disappear; game canvas returns to full screen |

---

## 10. Keyboard Shortcuts

| # | Shortcut | Expected |
|---|----------|----------|
| 10.1 | F1 | Opens / closes Settings panel |
| 10.2 | F5 (in-game) | Quick-save to slot 1 |
| 10.3 | F7 (in-game) | Quick-load from slot 1 |
| 10.4 | F9 | Opens Settings panel on the Debug tab |
| 10.5 | Escape (in-game) | Returns to library; emulator torn down |
| 10.6 | Arrow keys during gameplay | Directional input reaches the game, not the browser (no page scroll) |
| 10.7 | F5 pressed outside of gameplay | Does **not** trigger browser refresh (shortcut intercepted) |

---

## 11. FPS Monitor & Debug Overlay

| # | Step | Expected |
|---|------|----------|
| 11.1 | Enable "Show FPS" in Settings | FPS counter appears top-left during gameplay |
| 11.2 | Enable "Audio Visualiser" in Settings | Oscilloscope waveform appears alongside FPS counter |
| 11.3 | Press F3 (dev overlay toggle) | Developer debug overlay appears top-right with device cap details |
| 11.4 | Press F3 again | Dev overlay hides |
| 11.5 | Open Settings → Debug → "Copy Debug Info" | Clipboard contains GPU info, tier, diagnostic timeline |

---

## 12. Multiplayer / Netplay

| # | Step | Expected |
|---|------|----------|
| 12.1 | Open Settings → Multiplayer | Netplay panel visible |
| 12.2 | Enable Netplay toggle | Additional fields (Server URL, Display Name) appear |
| 12.3 | Enter a Display Name | Name saved; no error for valid usernames |
| 12.4 | Enter a name exceeding 32 characters | Validation error shown; name not saved |
| 12.5 | Enter a server URL and click "Add ICE Server" | ICE server added to list and persisted |
| 12.6 | Launch a supported game (PSP, N64, NDS) with Netplay enabled | Netplay button appears in emulator toolbar |
| 12.7 | Open Multiplayer → Browse and click "Quick Join" on an available room | App switches to Join tab, pre-fills invite code, and starts joining automatically |
| 12.8 | Trigger a failed join (invalid/closed room), then click **📋 Logs** in modal header | Diagnostics are copied to clipboard with timestamped entries |

---

## 13. Cloud Save Sync

| # | Step | Expected |
|---|------|----------|
| 13.1 | Open the save gallery for a game | Cloud bar visible above the slot grid |
| 13.2 | Connect to a WebDAV server (if available) | Status indicator turns active |
| 13.3 | Sync saves | States uploaded; status indicator confirms completion |
| 13.4 | Disconnect WebDAV | Status returns to disconnected; local saves intact |

---

## 14. PWA Install

| # | Step | Expected |
|---|------|----------|
| 14.1 | Open Settings | "Install RetroVault App" button visible (if browser supports PWA install) |
| 14.2 | Click the install button | Browser native install prompt appears |
| 14.3 | Accept install | App installs to OS; opens as standalone window on next launch |

---

## 15. Cross-Browser Compatibility

Run a representative subset of the above tests in each target browser:

| Browser | Priority | Notes |
|---------|----------|-------|
| Chrome / Edge (latest) | High | Reference platform; all features should work |
| Firefox (latest) | High | WebGPU may be absent; all other features should work |
| Safari 17+ (macOS) | Medium | PSP requires HTTPS + service worker; some WebGPU features absent |
| Chrome (Android) | Medium | Touch controls, orientation lock, PWA install |
| Safari (iOS 17+) | Low | `credentialless` COEP required; PSP may have threading limits |

---

## 16. Regression Checklist (Post-Change Validation)

Run these after any code change to catch regressions:

- [ ] `npm test` — all 1050+ unit tests pass
- [ ] `npm run build` — TypeScript type-check and Vite build succeed with no errors
- [ ] `npm run lint` — no ESLint errors
- [ ] App loads at `http://localhost:5173` with no console errors
- [ ] `self.crossOriginIsolated === true` in console
- [ ] A game can be added to the library and launched
- [ ] Save state save + load round-trip works
- [ ] FPS counter appears during gameplay
- [ ] Escape returns to library cleanly

---

## Reporting Bugs Found During Testing

When filing a bug:

1. Open Settings → Debug
2. Click "Copy Debug Info"
3. Paste the debug info into the GitHub issue
4. Include browser name/version, OS, and steps to reproduce
5. If relevant, include a screenshot or screen recording

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for issue template details.
