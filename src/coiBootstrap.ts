const BASE_URL = new URL(import.meta.env.BASE_URL, window.location.href);
const SW_SCOPE = BASE_URL.pathname.endsWith("/") ? BASE_URL.pathname : `${BASE_URL.pathname}/`;
const SW_URL = new URL("coi-serviceworker.js", BASE_URL).toString();

export function registerCOIServiceWorker(): void {
  const needsCOI = !self.crossOriginIsolated;
  if (!("serviceWorker" in navigator)) return;

  void (async () => {
    try {
      const reg = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });

      if (needsCOI && !navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
        });
        window.location.reload();
        return;
      }

      if (needsCOI) {
        reg.addEventListener("updatefound", () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener("statechange", () => {
            if (newWorker.state === "activated" && navigator.serviceWorker.controller) {
              window.location.reload();
            }
          });
        });
      }
    } catch (err) {
      console.warn("[coi-sw] Service worker registration failed:", err);
      // Surfaces in DevTools / selectors when COI cannot activate (e.g. file://, blocked SW).
      document.documentElement.dataset.coiSw = "failed";
    }
  })();
}
