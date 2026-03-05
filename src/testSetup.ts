const JSDOM_CANVAS_GET_CONTEXT_WARNING =
  "Not implemented: HTMLCanvasElement's getContext() method"

function isExpectedJsdomCanvasWarning(args: unknown[]): boolean {
  return args.some((arg) => {
    if (typeof arg === "string") {
      return arg.includes(JSDOM_CANVAS_GET_CONTEXT_WARNING)
    }

    if (
      arg &&
      typeof arg === "object" &&
      "message" in arg &&
      typeof (arg as { message?: unknown }).message === "string"
    ) {
      return ((arg as { message: string }).message).includes(
        JSDOM_CANVAS_GET_CONTEXT_WARNING
      )
    }

    return false
  })
}

// jsdom logs this message when the optional native `canvas` dependency is not
// installed. In this project that is an expected test-environment limitation,
// not a product regression, so suppress only this exact warning family.
const originalConsoleError = console.error.bind(console)

console.error = ((...args: unknown[]) => {
  if (isExpectedJsdomCanvasWarning(args)) return
  originalConsoleError(...args)
}) as typeof console.error

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
