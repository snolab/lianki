/**
 * The typing glass (owner, 2026-11-02: "帮我背景玻璃化，在我在这里打字的时候";
 * corrected 2026-11-03: "打字时的背景模糊应该只用于聊天框那一小块区域，不要全屏背景模糊"):
 * while the chat's input has the focus, the chat box's own area gets a frosted
 * glass background, so what sits right behind the box stops competing with
 * what is being typed. Only the box: the rest of the page stays sharp and
 * usable, and nothing catches taps. docs/design-principles.md, "Glass": a
 * tint in the page's own tone, `blur(12px) saturate(1.4)`, a hairline edge;
 * near-opaque where nothing blurs.
 *
 * Lighter than the full-screen log's sheet (log-surface.ts SHEET_SCRIM).
 */
export const TYPING_SCRIM = {
  light: { l: 0.98, c: 0.01, h: 90, a: 0.6 },
  dark: { l: 0.18, c: 0.01, h: 260, a: 0.55 },
} as const;
/** The box's 1px hairline edge (a box-shadow ring, so nothing moves). */
export const TYPING_EDGE = "light-dark(oklch(50% 0.01 260 / 0.18), oklch(90% 0.01 260 / 0.16))";
/** The tint's alpha where nothing blurs behind it (no backdrop-filter, or reduced transparency). */
export const TYPING_SOLID_ALPHA = 0.9;
export const TYPING_FILTER = "blur(12px) saturate(1.4)";
/** The fade in and out, ms (none under prefers-reduced-motion). */
export const TYPING_FADE_MS = 150;

/**
 * When the glass is up: typing in the open chat. It covers only the box, so
 * it is up on other sites (the userscript) too; the host page is untouched.
 */
export function showTypingGlass(s: {
  typing: boolean;
  open: boolean;
  /** The full-screen log has its own, stronger sheet. */
  fullLog: boolean;
}): boolean {
  return s.typing && s.open && !s.fullLog;
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
  edge: string;
} {
  const solid = !env.blur || env.reduce;
  const a = (k: Tint) => (solid ? TYPING_SOLID_ALPHA : k.a);
  const { light, dark } = TYPING_SCRIM;
  const background = env.lightDark
    ? `light-dark(${tintCss(light, a(light))}, ${tintCss(dark, a(dark))})`
    : `color-mix(in oklch, var(--background) ${Math.round(a(light) * 100)}%, transparent)`;
  const edge = env.lightDark
    ? `0 0 0 1px ${TYPING_EDGE}`
    : "0 0 0 1px color-mix(in oklch, currentColor 18%, transparent)";
  return { background, filter: solid ? "none" : TYPING_FILTER, edge };
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
    // way out, so a hidden layer is not painted (and costs no blur pass).
    transition: ms
      ? `opacity ${ms}ms ease-out, visibility 0s linear ${shown ? 0 : ms}ms`
      : "none",
  };
}

/**
 * One frame while typing (owner, 2026-11-03: "点进输入框、对焦之后，会有一个包括
 * 聊天记录的框框显示出来；这个时候里面那个框框就没必要继续显示了"; and "尽量减少视觉上的
 * 嵌套数量"). While the glass is up it is the frame, so the bar's own box goes
 * inside it: its border turns transparent (the width stays, so nothing moves),
 * its tint and its own blur go. Caret, placeholder, mic and + stay put. At
 * rest nothing is overridden, and the bar's resting border is back.
 */
export function barInGlass(shown: boolean): {
  borderColor?: string;
  background?: string;
  backdropFilter?: string;
  WebkitBackdropFilter?: string;
} {
  if (!shown) return {};
  return {
    borderColor: "transparent",
    background: "transparent",
    backdropFilter: "none",
    WebkitBackdropFilter: "none",
  };
}

/** The bar's frame fades with the glass: border and tint over the same 150 ms. */
export const BAR_IN_GLASS_TRANSITION = `border-color ${TYPING_FADE_MS}ms ease-out, background-color ${TYPING_FADE_MS}ms ease-out`;
