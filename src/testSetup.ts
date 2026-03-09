// ── Known console.error suppressions ─────────────────────────────────────────

const JSDOM_CANVAS_GET_CONTEXT_WARNING =
  "Not implemented: HTMLCanvasElement's getContext() method";

function matchesString(arg: unknown, needle: string): boolean {
  if (typeof arg === "string") return arg.includes(needle);
  if (
    arg &&
    typeof arg === "object" &&
    "message" in arg &&
    typeof (arg as { message?: unknown }).message === "string"
  ) {
    return (arg as { message: string }).message.includes(needle);
  }
  return false;
}

function isExpectedJsdomCanvasWarning(args: unknown[]): boolean {
  return args.some((arg) => matchesString(arg, JSDOM_CANVAS_GET_CONTEXT_WARNING));
}

// jsdom logs this message when the optional native `canvas` dependency is not
// installed. In this project that is an expected test-environment limitation,
// not a product regression, so suppress only this exact warning family.
const originalConsoleError = console.error.bind(console);

console.error = ((...args: unknown[]) => {
  if (isExpectedJsdomCanvasWarning(args)) return;
  originalConsoleError(...args);
}) as typeof console.error;

// ── Known console.warn suppressions ──────────────────────────────────────────
//
// Several tests exercise failure paths in the application that intentionally
// log [RetroVault] warnings. These are correct, expected messages and do not
// indicate a regression. Suppressing them keeps the test output signal/noise
// ratio high so genuine warnings stand out.

const EXPECTED_WARN_PATTERNS = [
  // WebGPU post-processor: pipeline build failure (tested explicitly)
  "[RetroVault] Failed to build WebGPU post-process pipeline:",
  // WebGPU post-processor: device loss path (tested explicitly)
  "[RetroVault] WebGPU device lost",
  // MemoryMonitor: pressure callback fire (tested explicitly in emulator tests)
  "[RetroVault] Memory pressure detected",
  // WebGPU post-processor: canvas context unavailable (jsdom environment)
  "[RetroVault] WebGPU canvas context unavailable",
  // WebGPU post-processor: render loop frame failure (tested explicitly)
  "[RetroVault] WebGPU post-process frame failed",
] as const;

function isExpectedWarn(args: unknown[]): boolean {
  return EXPECTED_WARN_PATTERNS.some((pattern) =>
    args.some((arg) => matchesString(arg, pattern)),
  );
}

const originalConsoleWarn = console.warn.bind(console);

console.warn = ((...args: unknown[]) => {
  if (isExpectedWarn(args)) return;
  originalConsoleWarn(...args);
}) as typeof console.warn;

// ── window.matchMedia stub ────────────────────────────────────────────────────

// jsdom does not implement window.matchMedia.  Provide a minimal stub that
// returns a MediaQueryList-like object.  Tests that need to simulate portrait
// mode can override window.matchMedia via vi.stubGlobal().
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener:    () => {},
      removeListener: () => {},
      addEventListener:    () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    } as MediaQueryList),
  });
}
