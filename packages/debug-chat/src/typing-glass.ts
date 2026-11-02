/**
 * The typing glass (owner, 2026-11-02: "帮我背景玻璃化，在我在这里打字的时候"):
 * while the chat's input has the focus, a frosted layer sits between the page
 * and the chat, so the page behind stops competing with what is being typed.
 * docs/design-principles.md, "Glass": a light tint in the page's own tone,
 * `blur(12px) saturate(1.4)`; near-opaque where nothing blurs.
 *
 * Lighter than the full-screen log's sheet (log-surface.ts SHEET_SCRIM): the
 * page should still read as the page, only frosted. A tap on it blurs the
 * input (DebugChat.tsx), which ends the glass; it never reaches the page.
 */
export const TYPING_SCRIM = {
  light: { l: 0.98, c: 0.01, h: 90, a: 0.3 },
  dark: { l: 0.18, c: 0.01, h: 260, a: 0.34 },
} as const;
/** The tint's alpha where nothing blurs behind it (no backdrop-filter, or reduced transparency). */
export const TYPING_SOLID_ALPHA = 0.9;
export const TYPING_FILTER = "blur(12px) saturate(1.4)";
/** The fade in and out, ms (none under prefers-reduced-motion). */
export const TYPING_FADE_MS = 150;

/** When the glass is up: typing in the open chat, on Lianki itself. */
export function showTypingGlass(s: {
  typing: boolean;
  open: boolean;
  /** The full-screen log has its own, stronger sheet. */
  fullLog: boolean;
  /** On another site (the userscript): leave its page alone. */
  embedded: boolean;
}): boolean {
  return s.typing && s.open && !s.fullLog && !s.embedded;
}

type Tint = { l: number; c: number; h: number; a: number };
const tintCss = (k: Tint, a: number) => `oklch(${k.l * 100}% ${k.c} ${k.h} / ${a})`;

/**
 * The layer's background and filter. `blur`: the browser can backdrop-filter;
 * `reduce`: prefers-reduced-transparency; `lightDark`: light-dark() parses
 * (older Safari falls back to the page's own colour at the same alpha).
 */
export function typingGlassLook(env: { blur: boolean; reduce: boolean; lightDark: boolean }): {
  background: string;
  filter: string;
} {
  const solid = !env.blur || env.reduce;
  const a = (k: Tint) => (solid ? TYPING_SOLID_ALPHA : k.a);
  const { light, dark } = TYPING_SCRIM;
  const background = env.lightDark
    ? `light-dark(${tintCss(light, a(light))}, ${tintCss(dark, a(dark))})`
    : `color-mix(in oklch, var(--background) ${Math.round(a(light) * 100)}%, transparent)`;
  return { background, filter: solid ? "none" : TYPING_FILTER };
}

/** The layer's opacity, visibility and their transition: shown at once, hidden after the fade. */
export function typingGlassMotion(
  shown: boolean,
  reducedMotion: boolean,
): { opacity: number; visibility: "visible" | "hidden"; transition: string } {
  const ms = reducedMotion ? 0 : TYPING_FADE_MS;
  return {
    opacity: shown ? 1 : 0,
    visibility: shown ? "visible" : "hidden",
    // Visibility flips at once on the way in, and only after the fade on the
    // way out, so a hidden layer is neither painted nor hit.
    transition: ms
      ? `opacity ${ms}ms ease-out, visibility 0s linear ${shown ? 0 : ms}ms`
      : "none",
  };
}
