# RetroOasis — UI Style Guide

**Design System: Dark Chrome v3**

> 2000s elegant: charcoal base, steel-blue & bronze accents, glossy surfaces, refined metallic detail.

---

## 1. Identity

| Token | Value |
|---|---|
| App name | RetroOasis |
| Design system name | Dark Chrome v3 |
| Brand personality | Retro-tech, premium, 2000s cool |

The logo SVG receives a steel-blue `drop-shadow` glow — never purple or any off-palette colour. All brand name text uses the `--font-display` (Exo 2) typeface with the steel-blue gradient.

---

## 2. Color Tokens

All colours are defined as CSS custom properties on `:root` in `src/style.css`. **Never use raw hex or `rgba()` values in component styles** — always reference a token.

### 2a. Surface & Border

| Token | Value | Usage |
|---|---|---|
| `--c-bg` | `#0a0a0d` | Page/app background |
| `--c-surface` | `#111116` | Card / modal base |
| `--c-surface2` | `#18181f` | Inputs, secondary surfaces |
| `--c-surface3` | `#212129` | Hover state surfaces, active chips |
| `--c-border` | `#2d2d3a` | Standard border |
| `--c-border-lt` | `#3d3d52` | Lighter border (separators, sub-rows) |

### 2b. Primary Accent — Steel Blue

| Token | Value | Usage |
|---|---|---|
| `--c-accent` | `#4a7fc0` | Primary CTA, focus rings, active states |
| `--c-accent-h` | `#6699d8` | Hover / lighter shade of accent |
| `--c-accent-light` | `#8ab4e8` | Subtle text highlight |
| `--c-accent-dark` | `#182840` | Deep accent for gradients |
| `--c-accent-dim` | `rgba(74,127,192, 0.15)` | Focus ring glow, tinted backgrounds |
| `--c-accent-glow` | `rgba(74,127,192, 0.30)` | Ambient glow on active elements |

### 2c. Secondary Accent — Antique Bronze / Gold

| Token | Value | Usage |
|---|---|---|
| `--c-gold` | `#b89040` | Cover-art button, loading spinner inner ring, premium highlights |
| `--c-gold-h` | `#cca855` | Hover / lighter gold |
| `--c-gold-dim` | `rgba(184,144,64, 0.14)` | Tinted gold backgrounds |
| `--c-gold-glow` | `rgba(184,144,64, 0.25)` | Gold ambient glow |

### 2d. Tertiary Accent — Silver-Slate

| Token | Value | Usage |
|---|---|---|
| `--c-accent-2` | `#7a98b8` | Info states, secondary chip borders |
| `--c-accent-2-dim` | `rgba(122,152,184, 0.14)` | Tinted info backgrounds |
| `--c-accent-2-glow` | `rgba(122,152,184, 0.25)` | Info ambient glow |

### 2e. Semantic Colors

| Token | Value | Usage |
|---|---|---|
| `--c-danger` | `#c84040` | Errors, destructive actions, delete buttons |
| `--c-warn` | `#b89040` | Warnings, performance suggestions (also equals `--c-gold`) |
| `--c-success` | `#3a9a60` | Confirmations, running state, BIOS found |
| `--c-fav` | `#f43f5e` | Favourites star / heart only — do not use for errors |

### 2f. Legacy / System Aliases

| Token | Value | Notes |
|---|---|---|
| `--c-joy-red` | `#c84040` | Same as `--c-danger`; kept for system badge compatibility |
| `--c-joy-blue` | `#3a72cc` | System badge compatibility |
| `--c-joy-red-dim` | `rgba(200,64,64, 0.12)` | |
| `--c-joy-blue-dim` | `rgba(58,114,204, 0.12)` | |

### 2g. Text Hierarchy

| Token | Value | Usage |
|---|---|---|
| `--c-text` | `#dcdce8` | Primary body text |
| `--c-text-dim` | `#848499` | Secondary / metadata text |
| `--c-text-faint` | `#545468` | Placeholder, label text |
| `--c-text-muted` | `#696978` | Disabled / lowest-priority text |

### 2h. Glass & Depth

| Token | Value | Usage |
|---|---|---|
| `--glass-bg` | `rgba(10,10,13, 0.95)` | Frosted header / footer backgrounds |
| `--glass-border` | `rgba(55,55,75, 0.50)` | Borders on frosted surfaces |

### Colour Usage Rules

- **Backgrounds** → use `color-mix(in srgb, var(--c-TOKEN) PERCENT%, transparent)` (e.g. `color-mix(in srgb, var(--c-danger) 12%, transparent)`)
- **Glows / drop-shadows** → use `var(--c-TOKEN)` directly in `filter: drop-shadow()`, or use `color-mix(in srgb, var(--c-TOKEN) N%, transparent)` in `box-shadow`
- **No raw `rgba()` with off-palette RGB values** — all raw values must match a token's underlying RGB

---

## 3. Typography

| Token | Value | Usage |
|---|---|---|
| `--font-display` | `"Exo 2", system-ui, …` | Headings, modal titles, library titles, brand name |
| `--font-sans` | `"Inter", system-ui, …` | All body text, UI controls, labels |
| `--font-mono` | `"SF Mono", "Fira Code", …` | Code, FPS overlay, dev debug panel |

**Base:** `15px`, `var(--font-sans)`, `color: var(--c-text)`, `-webkit-font-smoothing: antialiased`

### Type Scale (common classes)

| Element / class | Size | Weight | Notes |
|---|---|---|---|
| `.library-title` | `1.3rem` | 800 | Exo 2, gradient text |
| `.modal-title` | `1.05rem` | 800 | Exo 2, gradient text |
| `.settings-section__title` | `0.71rem` | 800 | Uppercase, `0.10em` letter-spacing |
| `.brand-long` | inherited | 800 | Exo 2, gradient text |
| Body text | `0.9–0.95rem` | 400–600 | Inter |
| Labels / meta | `0.74–0.84rem` | 500–700 | Inter |
| Tiny chips / badges | `0.65–0.72rem` | 700–900 | Uppercase, letter-spacing |

---

## 4. Spacing & Layout

| Token | Value | Usage |
|---|---|---|
| `--header-h` | `64px` | App header height |
| `--footer-h` | `38px` | Status bar height |
| `--sidebar-w` | `300px` | (unused sidebar placeholder) |
| `--settings-sidebar-w` | `162px` | Settings panel side nav |
| `--toast-bottom` | `calc(var(--footer-h) + var(--safe-bottom) + 14px)` | Toast vertical position |

**Safe areas** (`--safe-top/bottom/left/right`) are applied to all fixed/sticky elements that touch screen edges.

### Grid

| Breakpoint | Card columns |
|---|---|
| ≤ 400px | 2 fixed |
| 401–599px | `auto-fill, minmax(145px, 1fr)` |
| 600–899px | `auto-fill, minmax(170px, 1fr)` |
| ≥ 900px | `auto-fill, minmax(210px, 1fr)` |

---

## 5. Border Radius

| Token | Value | Usage |
|---|---|---|
| `--radius-sm` | `5px` | Smallest rounding (e.g. code tokens, inner elements) |
| `--radius` | `8px` | Standard: inputs, settings rows, picker buttons |
| `--radius-lg` | `13px` | BIOS blocks, toasts, error banners |
| `--radius-xl` | `18px` | Cards, modals, confirm dialogs |
| `--radius-pill` | `999px` | Chips, filter buttons, search bar, badge pills |

---

## 6. Shadows

| Token | Value | Usage |
|---|---|---|
| `--shadow-sm` | `0 4px 18px rgba(0,0,0,0.55)` | Subtle elevation |
| `--shadow` | `0 20px 60px rgba(0,0,0,0.85)` | Standard modal/floating element |
| `--shadow-lg` | `0 32px 80px rgba(0,0,0,0.90)` | Large overlay shadow |
| `--shadow-card` | `0 4px 16px rgba(0,0,0,0.65)` | Game card at rest |
| `--shadow-lift` | `0 14px 40px rgba(0,0,0,0.75)` | Lifted card / hovered button |

---

## 7. Transitions & Animation

| Token | Value | Usage |
|---|---|---|
| `--transition-fast` | `0.1s ease` | Micro-interactions (icon colour, opacity) |
| `--transition` | `0.18s ease` | Standard hover/state changes |
| `--transition-med` | `0.25s ease` | Slightly slower fades |
| `--spring-fast` | `0.2s cubic-bezier(0.34, 1.56, 0.64, 1)` | Small spring (button scale, badge pop) |
| `--spring` | `0.3s cubic-bezier(0.34, 1.56, 0.64, 1)` | Spring for cards, modals |

**Reduced motion:** All transitions and animations are collapsed to `0.01ms` when `prefers-reduced-motion: reduce` is active. Static fallbacks are provided for spinner and pulsing dots.

### Named keyframes

| Keyframe | Effect |
|---|---|
| `fade-in` | Simple opacity 0→1 |
| `slide-up-fade` | Opacity + Y+scale entrance |
| `slide-in-right-fade` | Opacity + X entrance |
| `spin` / `spin-reverse` | Loading spinner rings |
| `pulse` | Opacity breathe (sync indicators, live dots) |
| `pulse-dot` | Scale + opacity breathe (status dots) |
| `new-badge-pulse` | Box-shadow breathe on "NEW" badge |
| `lobby-shimmer` | Skeleton shimmer (netplay lobby) |

---

## 8. Component Patterns

### Buttons (`.btn`)

Base class: `.btn` — pill-shaped, `36px` min-height (44px on touch/coarse pointer devices).

| Modifier | Purpose |
|---|---|
| `.btn--primary` | Steel-blue gradient fill, gloss shine, main CTA |
| `.btn--ghost` | Translucent, subtle border — secondary actions |
| `.btn--danger` | Danger-red outline, danger text |
| `.btn--danger-filled` | Solid danger-red fill — destructive confirm |
| `.btn--active` | Accent-tinted, used for toggled/active state |

**Rules:**
- Always use the `.btn` base class; never style a `<button>` directly in components
- Disabled buttons use `opacity: 0.38` and `pointer-events: none`
- Active scale: `transform: scale(0.93)` at `0.07s ease`
- Primary hover: `translateY(-2px) scale(1.02)`

### Inputs & Select

All text inputs and `<select>` elements share:
- `background: var(--c-surface2)`
- `border: 1.5px solid var(--c-border)`
- `border-radius: var(--radius)` (pill for search/sort: `var(--radius-pill)`)
- `color: var(--c-text)`
- Focus ring: `border-color: var(--c-accent); box-shadow: 0 0 0 3px var(--c-accent-dim)`

Classes: `.settings-input`, `.settings-select`, `.settings-search-input`, `.library-search`, `.confirm-input`, `.cover-art-url-input`

### Modals

Structure: `backdrop > .modal-box > .modal-header + .modal-subtitle? + content`

- Backdrop: `rgba(0,0,0,0.72)` with `backdrop-filter: blur(6px)`
- Box: `background: linear-gradient(180deg, rgba(20,26,38,0.96) 0%, rgba(15,20,30,0.98) 100%)`, `border-radius: var(--radius-xl)`
- Entrance: `translateY(24px) scale(0.93)` → `translateY(0) scale(1)` via `--spring`

### Cards (`.game-card`)

- `border-radius: var(--radius-xl)`
- Hover: `translateY(-9px) scale(1.04)` + system-color border glow
- Active: `scale(0.97)` at `0.07s ease`
- Touch/coarse: hover lift suppressed; active-state overlay shown instead
- `contain: layout style paint` + `content-visibility: auto` for performance

### Chips & Badges

| Class | Usage |
|---|---|
| `.sys-badge` | System short-name (coloured background from system data) |
| `.sys-filter-chip` | System filter bar — pill, uppercase |
| `.system-feature-chip` | Feature tags inside cards (saveable, multiplayer, etc.) |
| `.system-feature-chip--accent` | Accent-tinted feature chip |
| `.system-feature-chip--warn` | Warning-tinted feature chip |
| `.netplay-room-status` | Open / full / locked pill in lobby |
| `.tier-badge` | Device performance tier |

### Toggle Switch

```
<label class="toggle-row">
  <span class="toggle-switch">
    <input type="checkbox" />
    <span class="toggle-switch__knob"></span>
  </span>
  <span class="toggle-row__text">…</span>
</label>
```

Off: `--c-surface3` background. On: steel-blue gradient with `box-shadow` glow.

### Toasts

`.info-toast` — bottom of screen, above footer. Variants: `--success`, `--warning`, `--error`. Entrance: `slide-up-fade` spring animation.

### Status Dots

`.status-dot` — 7×7 px circle. States: `idle`, `loading` (gold, pulse), `running` (success, glow), `paused` (accent, glow), `error` (danger).

---

## 9. Accessibility

- **Focus rings:** Every interactive element exposes `:focus-visible` with `outline: 2px solid var(--c-accent); outline-offset: 2px` (or 3px box-shadow equivalent for inputs)
- **Touch targets:** All buttons minimum `44×44 pt` on `(pointer: coarse)` devices (Apple HIG compliance)
- **Reduced motion:** Full collapse of transitions/animations + static spinner fallback
- **ARIA:** Modals use `role="dialog"` and `aria-modal="true"`; live regions use `aria-live="polite"` and `role="status"`
- **Color contrast:** `--c-text` (#dcdce8) on `--c-surface` (#111116) ≈ 11.5:1 (AAA); `--c-accent` (#4a7fc0) on `--c-bg` (#0a0a0d) ≈ 4.7:1 (AA)
- **iOS zoom prevention:** Inputs default to `font-size: 16px` on coarse-pointer devices to prevent Safari auto-zoom

---

## 10. File & Naming Conventions

| Pattern | Example | Notes |
|---|---|---|
| Block | `.game-card` | Standalone component |
| Block + element | `.game-card__icon` | Child of block (double underscore) |
| Block + modifier | `.game-card--new` | State/variant (double dash) |
| Utility | `.animate-slide-up` | Applied directly in JS via `.classList.add()` |
| JS hook | `data-*` attributes | Never use `js-*` prefixes; prefer IDs for singletons |

CSS is authored as a single `src/style.css` file. Sections are delimited by `/* ── Section name ───… */` comment headers. The order follows the app render tree (reset → tokens → shell → landing → cards → overlays → modals → settings → components → responsive).

---

## 11. Do & Don't

| ✅ Do | ❌ Don't |
|---|---|
| Use `color-mix(in srgb, var(--c-TOKEN) N%, transparent)` for tinted backgrounds | Use raw `rgba()` with values not matching a token |
| Reference `--c-fav` for favourites star colour | Use `#f43f5e` or `rgba(244,63,94,…)` directly |
| Use `--c-gold` / `--c-gold-h` for cover-art and premium highlights | Use purple (`rgba(139,92,246,…)` or similar) — not in palette |
| Use `var(--radius)` on inputs, `var(--radius-xl)` on cards/modals | Mix radius values inconsistently across similar components |
| Use `var(--transition)` / `--spring` tokens | Hard-code `0.2s ease` etc. in new rules |
| Expose `:focus-visible` rings on every interactive element | Omit focus styles or use only `:focus` (without `-visible`) for new rules |
| Use `--c-danger` / `--c-success` / `--c-warn` semantic tokens | Use system-specific RGBs like `rgba(48,209,88,…)` for generic states |
