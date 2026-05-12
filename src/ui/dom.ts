export function queryRequired<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`UI: element not found: "${selector}"`);
  return node;
}

export function buildToggleRow(label: string, desc: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const row = createElement("label", { class: "toggle-row" });
  const left = createElement("span", { class: "toggle-row__text" });
  left.append(createElement("span", { class: "radio-row__label" }, label), createElement("span", { class: "radio-row__desc" }, desc));
  const toggle = createElement("span", { class: "toggle-switch" });
  const input  = createElement("input", { type: "checkbox" }) as HTMLInputElement;
  input.checked = checked;
  input.setAttribute("aria-label", label);
  const knob = createElement("span", { class: "toggle-switch__knob" });
  toggle.classList.toggle("is-checked", checked);
  toggle.append(input, knob);
  input.addEventListener("change", () => {
    toggle.classList.toggle("is-checked", input.checked);
    onChange(input.checked);
  });
  row.append(left, toggle);
  return row;
}

export function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<string | Node>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  // Buttons default to type="submit" — set type="button" unless explicitly overridden
  if (tag === "button" && !("type" in attrs)) {
    (node as HTMLButtonElement).type = "button";
  }
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

