# guide.md — Hosting RetroVault on a strict static web host

This guide is for **strict static hosts** (for example: GitHub Pages, Netlify static deploys, Cloudflare Pages, S3 static website hosting), where you may not have full control over server runtime logic.

The app is built with Vite and outputs static files in `dist/`.

---

## 1) Build the project

```bash
npm install
npm run build
```

If the build succeeds, deploy the generated `dist/` folder.

---

## 2) Why strict hosts need special handling

PPSSPP (via EmulatorJS) needs `SharedArrayBuffer` for threading.
That requires cross-origin isolation:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

On strict static hosts, you often cannot inject these headers globally. This project includes `public/coi-serviceworker.js` to apply these headers from a service worker so the app can still work.

---

## 3) Deploy checklist (important)

1. Ensure `coi-serviceworker.js` is present at the site root after deploy:
   - `https://your-domain.example/coi-serviceworker.js`
2. Ensure `index.html` is served from the root.
3. Do not block service workers in your host/browser policies.
4. Use HTTPS (required by service workers on non-localhost).
5. After first load, allow the page to reload once (expected behavior while the isolation service worker activates).

---

## 4) Verify in browser after deploy

Open DevTools Console and run:

```js
self.crossOriginIsolated
```

Expected result:

- `true` → PPSSPP can run.
- `false` → isolation failed (check service worker registration and host pathing).

Also verify service worker status in DevTools:

- Application → Service Workers → `coi-serviceworker.js` should be active.

---

## 5) Troubleshooting strict hosts

### A) `crossOriginIsolated` stays `false`

- Confirm `coi-serviceworker.js` is reachable at root.
- Confirm deploy did not rewrite/move the file.
- Hard refresh (or clear site data) and reopen.
- Confirm HTTPS is enabled.

### B) Emulator loader/core files fail to download

The app fetches EmulatorJS assets from:

- `https://cdn.emulatorjs.org/stable/data/`

If your host/network has strict CSP/firewall rules, allow that origin.

### C) Works on desktop, fails on iOS Safari

This is a known platform limitation for cross-origin isolation + service workers on iOS WebKit. Prefer desktop Chrome/Firefox for reliable PPSSPP support.

---

## 6) Host-specific notes

If your host supports custom headers, adding real COOP/COEP headers at the edge/server is more robust than relying only on the service worker.

But if your host is strict and only supports static files, this repo's service worker approach is the fallback path.

---

## 7) Minimal deployment flow

```bash
npm run build
# upload dist/* to your static host root
```

Then:

1. Open the site.
2. Wait for first auto-reload.
3. Confirm `self.crossOriginIsolated === true`.
4. Launch a PSP game file.


## 8) Manual test checklist — API Keys tab (cover art providers)

After deploying or before shipping, quickly sanity-check the bring-your-own
API key UX for the RAWG, MobyGames, and TheGamesDB cover art providers:

1. **No-key default**: In a fresh browser profile, open a library that has
   games without cover art and run **Fetch missing covers**. Results should
   still come back — Libretro Thumbnails and the GitHub cover-art-collection
   run without keys.
2. **Add a RAWG key**: Open **Settings → API Keys**, paste a RAWG key, click
   **Save**, then **Test**. The status pill must change to **Active ✓** and
   an inline "Connection OK — RAWG is ready." message should appear under
   the input. Re-run **Fetch missing covers**; candidates labelled "RAWG"
   should now appear for systems RAWG supports (SNES, PSX, NDS, …).
3. **Invalid key**: Paste an obviously-wrong string (e.g. a URL). Saving
   should be blocked with a validation error, and the red-orange warning
   hint should appear under the input.
4. **Disable provider**: Uncheck **Enabled** for RAWG. The row should dim
   visually, covers should stop coming from RAWG, but the key stays saved
   (re-check **Enabled** to restore).
5. **Remove key**: Click **Remove**. Status returns to **No key** and the
   provider no longer runs.
6. **MobyGames / TheGamesDB**: Repeat steps 2–5 with a MobyGames or
   TheGamesDB key.
7. **Reorder**: Drag a row to a new position (or use the ▲ / ▼ buttons for
   keyboard access) to swap provider priority; the change takes effect on
   the next **Fetch missing covers** run.
8. **Summary badge**: The "X of Y providers configured" line near the top of
   the tab should update as keys are saved or removed.

Expected privacy guarantees:

- Keys are visible only inside the input when you click **Show** — they are
  never echoed to toasts, console logs, or error messages.
- Keys are stored in this browser's `localStorage` only. Clearing site
  data removes them.
