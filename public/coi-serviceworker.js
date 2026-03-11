/**
 * coi-serviceworker — Cross-Origin Isolation + PWA Cache Service Worker
 *
 * Dual-purpose service worker that handles:
 *
 * 1. Cross-Origin Isolation (COI) — injects COOP/COEP headers so that
 *    SharedArrayBuffer is available for the PPSSPP core's threading model.
 *    Static hosts (GitHub Pages, Netlify) cannot set custom HTTP headers, so
 *    the SW intercepts every fetch and injects them.
 *
 * 2. PWA App Shell Cache — caches the HTML/CSS/JS app shell for fast repeat
 *    loads and basic offline support (the library and game assets stored in
 *    IndexedDB remain available without a network connection).
 *
 * 3. iOS Safari COEP `credentialless` — Safari/WebKit does not support the
 *    `Cross-Origin-Resource-Policy` header for third-party CDN assets in the
 *    same way Chromium does. Switching to `COEP: credentialless` allows
 *    no-credentials cross-origin fetches without requiring CORP on each
 *    resource. This restores SharedArrayBuffer support on iOS 17+ / Safari 17+
 *    where the full COOP+COEP isolation is otherwise blocked by CDN assets
 *    lacking CORP headers.
 *
 * In development, Vite sets the COOP/COEP headers directly on the dev server,
 * so the SW registration is skipped when `window.crossOriginIsolated === true`.
 *
 * Adapted from https://github.com/gzuidhof/coi-serviceworker (MIT License).
 */

/* ── Service Worker context ────────────────────────────────────────────────── */
if (typeof window === "undefined") {
  const CACHE_NAME = "retrovault-shell-v1";

  // App shell resources to pre-cache on install.
  // Only same-origin assets are cached here; CDN emulator cores are large
  // and handled by the browser HTTP cache via prefetch hints instead.
  const PRECACHE_URLS = ["/", "/index.html"];

  self.addEventListener("install", (event) => {
    self.skipWaiting();
    event.waitUntil(
      caches.open(CACHE_NAME).then((cache) =>
        cache.addAll(PRECACHE_URLS).catch(() => {
          // Pre-cache failures are non-fatal; SW still activates normally.
        })
      )
    );
  });

  self.addEventListener("activate", (event) => {
    // Evict any previous cache versions so stale shells don't persist.
    event.waitUntil(
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      ).then(() => self.clients.claim())
    );
  });

  self.addEventListener("fetch", (event) => {
    const req = event.request;

    // Skip non-http(s) requests (chrome-extension://, data:, etc.)
    if (!req.url.startsWith("http")) return;

    // Avoid fetching with cache = "only-if-cached" on cross-origin requests,
    // which throws a TypeError in some browsers.
    if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;

    // ── iOS / Safari COEP strategy detection ─────────────────────────────────
    // `credentialless` COEP (Chrome 96+, Firefox 119+) allows cross-origin
    // no-credentials requests without requiring CORP headers on each resource.
    // Safari/WebKit does not yet support `credentialless` as a response header
    // that grants isolation, but we send it for forward-compatibility so that
    // when WebKit adds support the CDN assets (which lack CORP) do not block
    // isolation on iOS/iPadOS. Until then, Safari users may still lack SAB for
    // PSP but all other systems (NES/SNES/GBA/…) work fine.
    //
    // Chrome on iOS uses "CriOS" in the user-agent (not "Chrome") because Apple
    // requires all iOS browsers to use the WebKit engine. Both Safari and Chrome
    // on iOS share the same WebKit limitation, so we treat them identically.
    const ua = req.headers.get("user-agent") ?? "";
    const isWebKit =
      (/Safari\//.test(ua) && !/Chrome\//.test(ua) && !/Chromium\//.test(ua)) ||
      /CriOS\//.test(ua);
    const coepValue = isWebKit ? "credentialless" : "require-corp";

    // ── Caching strategy ──────────────────────────────────────────────────────
    // Navigation requests (HTML): network-first with cache fallback.
    // This guarantees the user always gets the freshest app shell when online,
    // but can still load the cached shell when offline.
    const isSameOriginNav =
      req.mode === "navigate" &&
      req.url.startsWith(self.location.origin);

    if (isSameOriginNav) {
      event.respondWith(
        fetch(req)
          .then((res) => {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone)).catch(() => {});
            return addCOIHeaders(res, coepValue);
          })
          .catch(() =>
            caches.match(req).then((cached) =>
              cached ?? new Response("Offline — please check your connection and reload.", {
                status: 503,
                statusText: "Service Unavailable",
                headers: { "Content-Type": "text/plain" },
              })
            )
          )
      );
      return;
    }

    // All other requests: inject COI headers, cache same-origin assets.
    event.respondWith(
      fetch(req)
        .then((response) => {
          if (response.status === 0 || (!response.ok && response.type === "opaque")) {
            return response;
          }
          // Cache same-origin static assets (JS/CSS) for fast repeat visits.
          if (
            req.url.startsWith(self.location.origin) &&
            (req.destination === "script" || req.destination === "style")
          ) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone)).catch(() => {});
          }
          return addCOIHeaders(response, coepValue);
        })
        .catch(() => fetch(req))
    );
  });

  /**
   * Reconstruct a Response with COI headers injected.
   * These three headers together establish a Cross-Origin Isolated context:
   *   COOP  – prevents cross-origin windows sharing a browsing context group.
   *   COEP  – gates cross-origin resource loading (require-corp or credentialless).
   *   CORP  – opt-in to cross-origin sharing for same-origin resources so that
   *            COEP: require-corp doesn't block them.
   */
  function addCOIHeaders(response, coepValue) {
    const headers = new Headers(response.headers);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", coepValue);
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

/* ── Window / main-thread context ──────────────────────────────────────────── */
} else {
  // In development, Vite sets the headers directly — no SW needed for COI.
  // The SW is still registered for PWA install support even when isolated.
  const needsCOI = !self.crossOriginIsolated;

  if ("serviceWorker" in navigator) {
    (async () => {
      try {
        const swUrl = document.currentScript.src;
        const reg = await navigator.serviceWorker.register(swUrl, { scope: "/" });

        if (needsCOI && !navigator.serviceWorker.controller) {
          // Newly installed — wait for the SW to take control then reload
          // so it can inject COOP/COEP headers on the next navigation.
          await new Promise((resolve) => {
            navigator.serviceWorker.addEventListener("controllerchange", resolve, {
              once: true,
            });
          });
          window.location.reload();
        } else if (needsCOI) {
          // Already controlled — watch for SW updates.
          reg.addEventListener("updatefound", () => {
            const newWorker = reg.installing;
            if (!newWorker) return;
            newWorker.addEventListener("statechange", () => {
              if (
                newWorker.state === "activated" &&
                navigator.serviceWorker.controller
              ) {
                window.location.reload();
              }
            });
          });
        }
      } catch (err) {
        console.warn("[coi-sw] Service worker registration failed:", err);
      }
    })();
  }
}
