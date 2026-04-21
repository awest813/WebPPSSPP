export function queryRequired<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`UI: element not found: "${selector}"`);
  return node;
}

export function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<string | Node>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

/**
 * Escape HTML special characters to safe entity references.
 * Safe to use inside innerHTML / template literals and HTML attributes
 * (including both single-quoted and double-quoted attribute values).
 */
export function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":  return "&amp;";
      case "<":  return "&lt;";
      case ">":  return "&gt;";
      case '"':  return "&quot;";
      case "'":  return "&#39;";
      default:   return c;
    }
  });
}

/** CSS selector matching all keyboard-focusable interactive elements. */
export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Implement a focus trap inside `container`.
 * Pass the `keydown` event directly; the handler returns without action
 * when the pressed key is not Tab.
 */
export function trapFocus(container: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== "Tab") return;
  const focusable = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  ).filter((el) => !el.closest("[hidden]"));
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last  = focusable[focusable.length - 1]!;
  if (e.shiftKey) {
    if (document.activeElement === first) { e.preventDefault(); last.focus(); }
  } else {
    if (document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}

/**
 * Return `true` when `target` is an editable element (input, textarea,
 * select, or contentEditable).  Used to guard keyboard shortcut handlers
 * that should not fire while the user is typing.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    target.isContentEditable ||
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT"
  );
}

/**
 * Scroll `target` into view, falling back to the zero-argument form on
 * browsers that do not support the `ScrollIntoViewOptions` overload.
 */
export function safeScrollIntoView(
  target: HTMLElement,
  options: ScrollIntoViewOptions,
): void {
  try {
    target.scrollIntoView(options);
  } catch {
    target.scrollIntoView();
  }
}

