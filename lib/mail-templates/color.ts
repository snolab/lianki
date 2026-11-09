/**
 * oklch → hex for MAIL ONLY (docs/mail-templates.md, "Layout and colours").
 *
 * Every colour in the code base is written in oklch() (owner rule). Most mail
 * clients (Outlook, Gmail's app, older Apple Mail) do not understand oklch()
 * or light-dark(), and drop the declaration, so the mail renderer — and only
 * the mail renderer — turns the oklch tokens into hex when it renders a mail.
 * This is the one allowed exception to the oklch rule; the source tokens stay
 * oklch (./layout.ts) and nothing else in the app uses this module.
 *
 * Pure and client-safe (the /dev/templates preview renders through it too).
 */

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** OKLCH (L 0..1, C, H degrees) → gamma-encoded sRGB 0..1, clamped into the gamut. */
export function oklchToSrgb(l: number, c: number, h: number): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3;
  const M = m_ ** 3;
  const S = s_ ** 3;
  const lin = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
  const enc = (x: number) => {
    const v = clamp01(x);
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return [enc(lin[0]), enc(lin[1]), enc(lin[2])];
}

const hex2 = (v: number) =>
  Math.round(clamp01(v) * 255)
    .toString(16)
    .padStart(2, "0");

/** `oklch(0.53 0.207 22.3)` (optionally `/ alpha`, ignored: mail gets opaque colours) → `#rrggbb`. */
export function oklchToHex(css: string): string | null {
  const m =
    /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.]+%?\s*)?\)$/i.exec(
      css.trim(),
    );
  if (!m) return null;
  const l = Number(m[1]) / (m[2] ? 100 : 1);
  const [r, g, b] = oklchToSrgb(l, Number(m[3]), Number(m[4]));
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/** Every oklch() in a piece of HTML/CSS replaced by its hex (stored template edits included). */
export const hexifyOklch = (s: string): string =>
  s.replace(/oklch\([^()]*\)/gi, (m) => oklchToHex(m) ?? m);

/** WCAG 2 relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG 2 contrast ratio of two `#rrggbb` colours (1..21). */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
