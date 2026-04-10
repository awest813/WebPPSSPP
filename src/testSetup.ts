// ── Known console.error suppressions ─────────────────────────────────────────

const JSDOM_CANVAS_GET_CONTEXT_WARNINGS = [
  "Not implemented: HTMLCanvasElement's getContext() method",
  "Not implemented: HTMLCanvasElement.prototype.getContext",
] as const;

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
  return JSDOM_CANVAS_GET_CONTEXT_WARNINGS.some((pattern) =>
    args.some((arg) => matchesString(arg, pattern)),
  );
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
  // ThermalMonitor: elevated pressure warning (tested explicitly in emulator tests)
  "[RetroVault] Thermal pressure elevated",
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

// ── Pointer capture stubs ─────────────────────────────────────────────────────

// jsdom does not implement the Pointer Events capture API.  Provide no-op
// stubs so that code calling setPointerCapture/releasePointerCapture does not
// throw in the test environment.  Actual capture routing is handled by the
// browser; tests simulate it by dispatching events directly on the element.
if (typeof HTMLElement !== "undefined") {
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = () => {};
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    HTMLElement.prototype.releasePointerCapture = () => {};
  }
  if (!HTMLElement.prototype.hasPointerCapture) {
    HTMLElement.prototype.hasPointerCapture = () => false;
  }
}

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

// Older jsdom environments may lack PointerEvent. A lightweight MouseEvent-
// based shim is sufficient for the touch-control tests in this repo.
if (typeof globalThis !== "undefined" && typeof globalThis.PointerEvent === "undefined") {
  class PointerEventShim extends MouseEvent {
    pointerId: number;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }

  Object.defineProperty(globalThis, "PointerEvent", {
    configurable: true,
    writable: true,
    value: PointerEventShim,
  });
}

// Older jsdom versions used for Vitest compatibility may not implement the
// Blob convenience readers that browser code relies on.
if (typeof Blob !== "undefined") {
  if (!Blob.prototype.arrayBuffer) {
    Blob.prototype.arrayBuffer = async function (): Promise<ArrayBuffer> {
      const reader = new FileReader();
      return await new Promise<ArrayBuffer>((resolve, reject) => {
        reader.onerror = () => reject(reader.error ?? new Error("Failed to read blob as ArrayBuffer"));
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(this as Blob);
      });
    };
  }

  if (!Blob.prototype.text) {
    Blob.prototype.text = async function (): Promise<string> {
      const reader = new FileReader();
      return await new Promise<string>((resolve, reject) => {
        reader.onerror = () => reject(reader.error ?? new Error("Failed to read blob as text"));
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.readAsText(this as Blob);
      });
    };
  }
}
