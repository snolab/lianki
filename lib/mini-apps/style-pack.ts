/**
 * The style pack (public/m/presets/lianki.css) as a string, so the srcdoc
 * frame gets it inlined (docs/mini-apps.md, "Style pack"): a srcdoc app has
 * no origin of its own, and a stylesheet link from it depends on the page's
 * host matching the CSP's. unit/mini-apps-rules.test.ts keeps this equal to
 * the public file. Edit the CSS there, then copy it here.
 */
export const STYLE_PACK_CSS = `/*
 * Lianki style pack: a mini version of lianki.com's own CSS for mini apps
 * (docs/mini-apps.md, "Style pack").
 *   <link rel="stylesheet" href="/m/presets/lianki.css">
 * In the srcdoc sandbox the host inlines this file into the app, so it always
 * applies. Tokens are app/globals.css's (seal-ink red is the theme colour, not
 * a danger colour); every colour is oklch. Plain elements (button, input,
 * select, textarea, a, h1–h3, table) look like Lianki without any class;
 * .card, .pill, .segmented and the .lk-* helpers add the rest.
 * Night mode: the host sets <html data-theme="dark|light"> from the site's
 * theme; with none, the system's preference decides.
 */
@import url("https://fonts.googleapis.com/css2?family=Klee+One:wght@400;600&family=LXGW+WenKai+TC:wght@400;700&display=swap");

:root {
  /* Seal red (印泥), paper (宣紙) and ink (墨). */
  --lk-brand: oklch(0.53 0.207 22.3);
  --lk-bg: oklch(0.945 0.02 82);
  --lk-fg: oklch(0.22 0.015 65);
  --lk-muted: oklch(0.46 0.02 68);
  --lk-line: oklch(0.5 0.02 70 / 0.25);
  --lk-line-strong: oklch(0.5 0.02 70 / 0.45);
  --lk-surface: oklch(0.975 0.012 85);
  --lk-surface-2: oklch(0.92 0.022 82);
  --lk-field: oklch(0.99 0.006 85);
  --lk-primary: oklch(0.53 0.207 22.3);
  --lk-primary-deep: oklch(0.49 0.2 22.3);
  --lk-on-primary: oklch(0.985 0.01 85);
  --lk-secondary: oklch(0.89 0.12 86);
  --lk-on-secondary: oklch(0.21 0.01 60);
  --lk-gold-ink: oklch(0.5 0.1 70);
  --lk-bold-bg: oklch(0.89 0.12 86);
  --lk-bold-fg: oklch(0.49 0.2 22.3);
  --lk-seal-off: oklch(0.46 0.02 68);
  --lk-good: oklch(0.55 0.12 145);
  --lk-focus: oklch(0.53 0.207 22.3 / 0.45);
  --lk-shadow: 0 1px 2px oklch(0.2 0.02 60 / 0.12), 0 4px 16px oklch(0.2 0.02 60 / 0.08);
  --lk-chart-1: var(--lk-primary);
  --lk-chart-2: oklch(0.6 0.11 230);
  --lk-chart-3: oklch(0.7 0.13 86);
  --lk-chart-4: oklch(0.55 0.12 145);
  --lk-radius: 0.75rem;
  --lk-radius-pill: 999px;
  --lk-font: "LXGW WenKai TC", "Klee One", ui-sans-serif, system-ui, sans-serif;
  --lk-font-mono: ui-monospace, "SF Mono", Menlo, monospace;
  color-scheme: light;
}
/* Night (松煙墨), from the host's theme or else the system. */
:root[data-theme="dark"] {
  --lk-brand: oklch(0.6 0.205 18.3);
  --lk-bg: oklch(0.18 0.01 65);
  --lk-fg: oklch(0.92 0.02 82);
  --lk-muted: oklch(0.72 0.02 72);
  --lk-line: oklch(0.8 0.02 80 / 0.2);
  --lk-line-strong: oklch(0.8 0.02 80 / 0.38);
  --lk-surface: oklch(0.23 0.012 65);
  --lk-surface-2: oklch(0.27 0.014 65);
  --lk-field: oklch(0.2 0.01 65);
  --lk-primary: oklch(0.6 0.205 18.3);
  --lk-primary-deep: oklch(0.53 0.207 22.3);
  --lk-gold-ink: oklch(0.89 0.12 86);
  --lk-bold-bg: oklch(0.49 0.2 22.3);
  --lk-bold-fg: oklch(0.89 0.12 86);
  --lk-seal-off: oklch(0.72 0.02 72);
  --lk-good: oklch(0.72 0.12 145);
  --lk-focus: oklch(0.6 0.205 18.3 / 0.5);
  --lk-shadow: 0 1px 2px oklch(0 0 0 / 0.4), 0 4px 16px oklch(0 0 0 / 0.3);
  color-scheme: dark;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]):not([data-theme="dark"]) {
    --lk-brand: oklch(0.6 0.205 18.3);
    --lk-bg: oklch(0.18 0.01 65);
    --lk-fg: oklch(0.92 0.02 82);
    --lk-muted: oklch(0.72 0.02 72);
    --lk-line: oklch(0.8 0.02 80 / 0.2);
    --lk-line-strong: oklch(0.8 0.02 80 / 0.38);
    --lk-surface: oklch(0.23 0.012 65);
    --lk-surface-2: oklch(0.27 0.014 65);
    --lk-field: oklch(0.2 0.01 65);
    --lk-primary: oklch(0.6 0.205 18.3);
    --lk-primary-deep: oklch(0.53 0.207 22.3);
    --lk-gold-ink: oklch(0.89 0.12 86);
    --lk-bold-bg: oklch(0.49 0.2 22.3);
    --lk-bold-fg: oklch(0.89 0.12 86);
    --lk-seal-off: oklch(0.72 0.02 72);
    --lk-good: oklch(0.72 0.12 145);
    --lk-focus: oklch(0.6 0.205 18.3 / 0.5);
    --lk-shadow: 0 1px 2px oklch(0 0 0 / 0.4), 0 4px 16px oklch(0 0 0 / 0.3);
    color-scheme: dark;
  }
}

/* ── Base ─────────────────────────────────────────────────────────────── */
*,
*::before,
*::after {
  box-sizing: border-box;
}
html,
body {
  margin: 0;
  min-height: 100%;
  background: var(--lk-bg);
  color: var(--lk-fg);
  font-family: var(--lk-font);
  font-size: 16px;
  line-height: 1.55;
  -webkit-text-size-adjust: 100%;
  -webkit-tap-highlight-color: transparent;
}
body {
  padding: 1rem;
}
h1,
h2,
h3 {
  line-height: 1.2;
  margin: 0 0 0.5em;
  font-weight: 700;
}
h1 {
  font-size: 1.75rem;
}
h2 {
  font-size: 1.35rem;
}
h3 {
  font-size: 1.1rem;
}
p {
  margin: 0 0 0.75em;
}
a {
  color: var(--lk-gold-ink);
  text-underline-offset: 0.2em;
}
a:hover {
  color: var(--lk-primary);
}
hr {
  border: 0;
  border-top: 1px solid var(--lk-line);
  margin: 1rem 0;
}
code,
kbd,
pre {
  font-family: var(--lk-font-mono);
  font-size: 0.92em;
}
pre {
  background: var(--lk-surface-2);
  border-radius: 0.5rem;
  padding: 0.75rem;
  overflow: auto;
}
table {
  border-collapse: collapse;
  width: 100%;
}
th,
td {
  border-bottom: 1px solid var(--lk-line);
  padding: 0.4rem 0.5rem;
  text-align: start;
}
::selection {
  background: var(--lk-bold-bg);
  color: var(--lk-bold-fg);
}
:focus-visible {
  outline: 2px solid var(--lk-focus);
  outline-offset: 2px;
}

/* ── Controls ─────────────────────────────────────────────────────────── */
button,
.lk-btn,
input[type="button"],
input[type="submit"],
input[type="reset"] {
  min-height: 2.75rem;
  min-width: 2.75rem;
  padding: 0 1rem;
  border-radius: var(--lk-radius);
  border: 1px solid var(--lk-line-strong);
  background: var(--lk-surface);
  color: var(--lk-fg);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  touch-action: manipulation;
  transition:
    background-color 0.15s,
    border-color 0.15s,
    transform 0.05s;
}
button:hover,
.lk-btn:hover {
  border-color: var(--lk-primary);
}
button:active,
.lk-btn:active {
  transform: translateY(1px);
}
button:disabled,
.lk-btn:disabled {
  opacity: 0.45;
  cursor: default;
  transform: none;
}
/* The main action: seal-red fill, paper text. */
button.primary,
button[type="submit"],
.lk-btn-primary {
  background: var(--lk-primary);
  border-color: var(--lk-primary);
  color: var(--lk-on-primary);
}
button.primary:hover,
button[type="submit"]:hover,
.lk-btn-primary:hover {
  background: var(--lk-primary-deep);
}
/* The second action: gold fill. */
button.secondary,
.lk-btn-secondary {
  background: var(--lk-secondary);
  border-color: var(--lk-secondary);
  color: var(--lk-on-secondary);
}
/* A quiet action: text only. */
button.ghost,
.lk-btn-ghost {
  background: transparent;
  border-color: transparent;
  color: var(--lk-gold-ink);
}
input:not(
  [type="button"],
  [type="submit"],
  [type="reset"],
  [type="checkbox"],
  [type="radio"],
  [type="range"]
),
select,
textarea,
.lk-input {
  min-height: 2.75rem;
  width: 100%;
  padding: 0.5rem 0.75rem;
  border-radius: var(--lk-radius);
  border: 1px solid var(--lk-line-strong);
  background: var(--lk-field);
  color: var(--lk-fg);
  font: inherit;
}
textarea {
  min-height: 6rem;
  resize: vertical;
}
input::placeholder,
textarea::placeholder {
  color: var(--lk-muted);
}
input:focus,
select:focus,
textarea:focus {
  border-color: var(--lk-primary);
  outline: 2px solid var(--lk-focus);
  outline-offset: 0;
}
input[type="checkbox"],
input[type="radio"],
input[type="range"],
progress {
  accent-color: var(--lk-primary);
}
label {
  display: block;
  font-weight: 600;
  margin-bottom: 0.25rem;
}

/* ── Pieces ───────────────────────────────────────────────────────────── */
.card,
.lk-card {
  background: var(--lk-surface);
  border: 1px solid var(--lk-line);
  border-radius: var(--lk-radius);
  box-shadow: var(--lk-shadow);
  padding: 1rem;
}
/* A small rounded tag; .pill.on is the seal-red current one. */
.pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
  min-height: 2rem;
  padding: 0 0.8rem;
  border-radius: var(--lk-radius-pill);
  border: 1px solid var(--lk-line-strong);
  background: var(--lk-surface);
  color: var(--lk-fg);
  font-size: 0.9rem;
}
.pill.on,
.pill[aria-pressed="true"] {
  background: var(--lk-primary);
  border-color: var(--lk-primary);
  color: var(--lk-on-primary);
}
/* A switch that shows every state: the current one seal-red, the others outlined. */
.segmented {
  display: inline-flex;
  padding: 0.2rem;
  gap: 0.2rem;
  border-radius: var(--lk-radius);
  border: 1px solid var(--lk-line-strong);
  background: var(--lk-surface-2);
}
.segmented > button {
  min-height: 2.25rem;
  border-radius: calc(var(--lk-radius) - 0.2rem);
  border: 1px dashed var(--lk-line-strong);
  background: transparent;
  color: var(--lk-seal-off);
}
.segmented > button[aria-pressed="true"],
.segmented > button.on {
  border-style: solid;
  border-color: var(--lk-primary);
  background: var(--lk-primary);
  color: var(--lk-on-primary);
}

/* ── Layout helpers ───────────────────────────────────────────────────── */
.lk-app {
  max-width: 40rem;
  margin: 0 auto;
}
.lk-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}
.lk-stack {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.lk-muted {
  color: var(--lk-muted);
}
.lk-mono {
  font-family: var(--lk-font-mono);
  font-variant-numeric: tabular-nums;
}
.lk-seal {
  display: inline-grid;
  place-items: center;
  border-radius: 0.4rem;
  background: var(--lk-primary);
  color: var(--lk-on-primary);
  padding: 0.1rem 0.45rem;
  font-weight: 700;
}
`;
