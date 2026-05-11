# Stability, Lightweight, and Touch Refactor Audit

Date: 2026-05-11

## Stopping Point

This checkpoint completes a safe first pass on stability, startup weight, and touch-control modularization. The current state is intentionally conservative: existing public imports continue to work, while newer lightweight modules let UI and settings code avoid loading heavier implementation files until needed.

## Completed

- Split RetroAchievements credential parsing into `src/raCredentials.ts`, with focused parser coverage in `src/raCredentials.test.ts`.
- Added cleanup guards around the lazy LAN multiplayer home panel so async status updates and subscriptions do not outlive their modal.
- Lazily loaded settings tab builders from `src/ui.ts`, including stale-render guards and cleanup callbacks for settings content.
- Removed manual Vite chunk rules that were working against the dynamic import graph.
- Split touch code into smaller modules:
  - `src/touch/preferences.ts` for touch preference/default helpers.
  - `src/touch/input.ts` for key bindings and haptics.
  - `src/touch/layouts.ts` for built-in layouts and localStorage persistence.
  - `src/touch/index.ts` as the new public touch barrel.
- Kept compatibility shims in `src/touchControls.ts` and `src/touchPreferences.ts` so existing imports remain valid.

## Debug And Audit Results

- `npm run doctor`: passed, no blocking environment issues.
- `npm audit --audit-level=moderate`: passed, 0 vulnerabilities.
- `git diff --check`: passed after trimming two extra EOF blank lines.
- UTF-8 spot check for touch files: passed, no BOM and no mojibake sequence detected.
- `npm run build`: passed.
- `npm run lint`: passed.
- `npm test`: passed, 38 test files and 2419 tests.

## Notes For The Next Pass

- The touch overlay still owns DOM construction and pointer binding in one class. The next natural refactor is to split DOM builders and pointer binders into focused modules while leaving `TouchControlsOverlay` as the orchestration layer.
- A visual/manual mobile pass should follow the next touch refactor, especially for edit mode, orientation changes, D-pad diagonals, analog stick release behavior, and haptic toggles.
- Keep the compatibility exports until call sites have fully migrated to `src/touch/index.ts` or direct lightweight modules.
