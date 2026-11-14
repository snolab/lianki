/**
 * The 开发 badge on the dev site's app icons (docs/dev-whole-page.md, "The
 * dev site as its own app"): a dark ink plate with 开发 in paper colour, at the
 * foot of the seal, so the home-screen icon of 开发站 never passes for
 * Lianki's. Made from the app's own icons when they are asked for — the SVG by
 * adding two elements, the PNGs by drawing into their pixels — so no badged
 * file is kept in the repo. The two characters are drawn as strokes (below),
 * not text: a PNG has no font, and the SVG must look the same everywhere.
 */
import { type Rgba, decodePng, encodePng } from "./png";

/** Where the plate sits, as fractions of the icon's width and height. */
export type BadgeBox = { x0: number; y0: number; x1: number; y1: number };

/** "any" icons: the seal fills the square, so the plate covers its lower edge. */
export const BADGE_ANY: BadgeBox = { x0: 0.14, y0: 0.66, x1: 0.86, y1: 0.94 };
/** "maskable" icons: inside the 80 % safe circle (corners at most 0.4 from the centre). */
export const BADGE_MASKABLE: BadgeBox = { x0: 0.28, y0: 0.62, x1: 0.72, y1: 0.82 };

/** Plate and characters: ink and paper (app/globals.css --background), never the seal's red. */
export const BADGE_INK = "oklch(0.28 0.03 260)";
export const BADGE_PAPER = "oklch(0.945 0.02 82)";

type Pt = [number, number];

/** 开 and 发 as centre-line strokes in a 1×1 box (y down), drawn with round caps. */
export const GLYPHS: Pt[][][] = [
  [
    [
      [0.12, 0.16],
      [0.88, 0.16],
    ],
    [
      [0.04, 0.5],
      [0.96, 0.5],
    ],
    [
      [0.36, 0.16],
      [0.36, 0.6],
      [0.3, 0.8],
      [0.1, 0.96],
    ],
    [
      [0.66, 0.16],
      [0.66, 0.96],
    ],
  ],
  [
    [
      [0.22, 0.08],
      [0.16, 0.3],
    ],
    [
      [0.06, 0.32],
      [0.94, 0.32],
    ],
    [
      [0.66, 0.06],
      [0.78, 0.18],
    ],
    [
      [0.48, 0.04],
      [0.44, 0.42],
      [0.3, 0.72],
      [0.06, 0.96],
    ],
    [
      [0.38, 0.52],
      [0.78, 0.52],
      [0.6, 0.74],
      [0.3, 0.96],
    ],
    [
      [0.44, 0.64],
      [0.68, 0.84],
      [0.96, 0.96],
    ],
  ],
];

/** The characters' strokes placed in the plate (same units as `box`), and their width. */
export function badgeStrokes(box: { x: number; y: number; w: number; h: number }): {
  strokes: Pt[][];
  width: number;
} {
  const g = box.h * 0.66;
  const gap = g * 0.14;
  const left = box.x + (box.w - (2 * g + gap)) / 2;
  const top = box.y + (box.h - g) / 2;
  const strokes = GLYPHS.flatMap((glyph, i) =>
    glyph.map((s) => s.map(([x, y]) => [left + i * (g + gap) + x * g, top + y * g] as Pt)),
  );
  return { strokes, width: g * 0.12 };
}

const fmt = (n: number) => String(Math.round(n * 10) / 10);

/**
 * `svg` with the badge drawn over it, in its own viewBox units (or its
 * width/height when it has no viewBox). An SVG with neither is returned as is.
 */
export function badgeSvg(svg: string, at: BadgeBox = BADGE_ANY): string {
  const vb = /<svg\b[^>]*\bviewBox="([^"]+)"/
    .exec(svg)?.[1]
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  let frame: [number, number, number, number] | null = null;
  if (vb && vb.length === 4 && vb.every(Number.isFinite)) frame = [vb[0]!, vb[1]!, vb[2]!, vb[3]!];
  else {
    const w = Number(/<svg\b[^>]*\bwidth="([\d.]+)"/.exec(svg)?.[1]);
    const h = Number(/<svg\b[^>]*\bheight="([\d.]+)"/.exec(svg)?.[1]);
    if (w > 0 && h > 0) frame = [0, 0, w, h];
  }
  const end = svg.lastIndexOf("</svg>");
  if (!frame || end < 0) return svg;
  const [mx, my, fw, fh] = frame;
  const box = {
    x: mx + at.x0 * fw,
    y: my + at.y0 * fh,
    w: (at.x1 - at.x0) * fw,
    h: (at.y1 - at.y0) * fh,
  };
  const { strokes, width } = badgeStrokes(box);
  const d = strokes
    .map((s) => s.map(([x, y], i) => `${i ? "L" : "M"}${fmt(x)} ${fmt(y)}`).join(""))
    .join("");
  const badge =
    `<!-- 开发 badge: lib/dev-site/badge.ts (the dev site's icon only) -->` +
    `<rect x="${fmt(box.x)}" y="${fmt(box.y)}" width="${fmt(box.w)}" height="${fmt(box.h)}" rx="${fmt(box.h * 0.24)}" fill="${BADGE_INK}"/>` +
    `<path d="${d}" fill="none" stroke="${BADGE_PAPER}" stroke-width="${fmt(width)}" stroke-linecap="round" stroke-linejoin="round"/>\n`;
  return svg.slice(0, end) + badge + svg.slice(end);
}

/** An `oklch(L C H)` colour (L in 0..1) as 8-bit sRGB, gamut-clipped. */
export function oklchToRgb(css: string): [number, number, number] {
  const m = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(css);
  if (!m) throw new Error(`not an oklch() colour: ${css}`);
  const [L, C, H] = [Number(m[1]), Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  const a = C * Math.cos(H);
  const b = C * Math.sin(H);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ];
  return lin.map((x) => {
    const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.max(x, 0) ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  }) as [number, number, number];
}

function segDist(px: number, py: number, [ax, ay]: Pt, [bx, by]: Pt): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Straight-alpha "over": colour `c` at coverage `k` onto pixel `i` of `d`. */
function over(d: Uint8Array, i: number, c: [number, number, number], k: number) {
  if (k <= 0) return;
  const da = d[i + 3]! / 255;
  const oa = k + da * (1 - k);
  for (let j = 0; j < 3; j++) d[i + j] = Math.round((c[j]! * k + d[i + j]! * da * (1 - k)) / oa);
  d[i + 3] = Math.round(oa * 255);
}

/** The badge drawn into a copy of `img` (anti-aliased plate and strokes). */
export function badgeRgba(img: Rgba, at: BadgeBox = BADGE_ANY): Rgba {
  const { width: W, height: H } = img;
  const data = new Uint8Array(img.data);
  const box = { x: at.x0 * W, y: at.y0 * H, w: (at.x1 - at.x0) * W, h: (at.y1 - at.y0) * H };
  const r = box.h * 0.24;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const { strokes, width } = badgeStrokes(box);
  const segs: [Pt, Pt][] = strokes.flatMap((s) => s.slice(1).map((p, i) => [s[i]!, p] as [Pt, Pt]));
  const ink = oklchToRgb(BADGE_INK);
  const paper = oklchToRgb(BADGE_PAPER);
  for (let y = Math.max(0, Math.floor(box.y)); y < Math.min(H, Math.ceil(box.y + box.h)); y++)
    for (let x = Math.max(0, Math.floor(box.x)); x < Math.min(W, Math.ceil(box.x + box.w)); x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const qx = Math.abs(px - cx) - (box.w / 2 - r);
      const qy = Math.abs(py - cy) - (box.h / 2 - r);
      const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      const plate = Math.min(1, Math.max(0, 0.5 - sd));
      if (plate <= 0) continue;
      const i = (y * W + x) * 4;
      over(data, i, ink, plate);
      let dist = Infinity;
      for (const [a, b] of segs) dist = Math.min(dist, segDist(px, py, a, b));
      over(data, i, paper, Math.min(plate, Math.max(0, width / 2 - dist + 0.5)));
    }
  return { width: W, height: H, data };
}

/** A PNG icon with the badge on it, as a PNG. */
export function badgePng(png: Uint8Array, at: BadgeBox = BADGE_ANY): Uint8Array {
  return encodePng(badgeRgba(decodePng(png), at));
}
