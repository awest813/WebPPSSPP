

/**
 * A key-down handler registered with the input router.
 * Return `true` to signal the event was handled (stops dispatch to lower-priority
 * contexts).  Return `false` or `undefined` to let the event fall through.
 */
export type KeyHandler = (e: KeyboardEvent) => boolean | void;

export interface InputRouterContext {
  handlers: KeyHandler[];
  priority: number;
}

/**
 * Centralised keyboard routing that replaces ad-hoc `document.addEventListener`
 * calls scattered through the UI layer.
 *
 * Usage:
 *   1. Create a single `InputRouter` instance at init time.
 *   2. Register handlers grouped by logical context (e.g. "global", "settings",
 *      "library-grid").  Handlers in higher-priority contexts run first.
 *   3. Enable / disable whole contexts as the UI state changes.
 *   4. Call `destroy()` during cleanup to remove the global listener.
 */
export class InputRouter {
  private _contexts = new Map<string, InputRouterContext>();
  private _enabled = new Set<string>();
  private _boundHandler: ((e: KeyboardEvent) => void) | null = null;
  private _destroyed = false;

  constructor() {
    this._boundHandler = this._onKeyDown.bind(this);
    document.addEventListener("keydown", this._boundHandler, { capture: true });
  }

  /** Register a context with one or more handlers. Higher `priority` runs first. */
  register(context: string, handlers: KeyHandler[], priority = 0): void {
    if (this._destroyed) return;
    this._contexts.set(context, { handlers, priority });
    this._enabled.add(context);
  }

  /** Remove a context and its handlers entirely. */
  unregister(context: string): void {
    this._contexts.delete(context);
    this._enabled.delete(context);
  }

  /** Enable an already-registered context so its handlers receive events. */
  enable(context: string): void {
    if (this._contexts.has(context)) this._enabled.add(context);
  }

  /** Disable a context so its handlers are skipped. */
  disable(context: string): void {
    this._enabled.delete(context);
  }

  /** True when the context is both registered and enabled. */
  isEnabled(context: string): boolean {
    return this._enabled.has(context) && this._contexts.has(context);
  }

  /** Remove the global listener and clear all state. */
  destroy(): void {
    this._destroyed = true;
    if (this._boundHandler) {
      document.removeEventListener("keydown", this._boundHandler, { capture: true });
      this._boundHandler = null;
    }
    this._contexts.clear();
    this._enabled.clear();
  }

  // ── internal ──────────────────────────────────────────────────────────────

  private _onKeyDown(e: KeyboardEvent): void {
    if (this._destroyed) return;

    // Sort enabled contexts by priority (descending) and run handlers in order.
    const sorted = Array.from(this._contexts.entries())
      .filter(([name]) => this._enabled.has(name))
      .sort(([, a], [, b]) => b.priority - a.priority);

    for (const [, ctx] of sorted) {
      for (const handler of ctx.handlers) {
        try {
          if (handler(e) === true) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        } catch (err) {
          console.warn("InputRouter: handler error", err);
        }
      }
    }
  }
}
