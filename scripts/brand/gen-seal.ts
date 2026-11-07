#!/usr/bin/env bun
/**
 * The seal (煉, 印泥 red) — generates every logo file from one source:
 *
 *   public/icon.svg                 header logo, favicon (transparent)
 *   public/favicon.ico              16/32/48 (transparent)
 *   public/icon-192.png, -512.png   manifest "any" (transparent)
 *   public/icon-maskable-192.png, -512.png   manifest "maskable" (paper)
 *   public/apple-icon.png, apple-touch-icon.png   iOS home screen (paper)
 *
 * The seal is a 朱文 (red-relief) stamp: a red rim and the red 煉, with the
 * paper showing through between them — never a filled red tile. Its worn,
 * hand-pressed edge is baked into the path geometry here rather than done
 * with SVG filters (feTurbulence/feDisplacementMap): WebKit drew the filtered
 * version as a crisp red square on the iPhone (2026-11-07).
 *
 * The icons iOS and Android crop to a shape must be opaque (iOS fills
 * transparency with black), so those sit on the light paper (宣紙,
 * --background in app/globals.css) instead.
 *
 * Run: bun scripts/brand/gen-seal.ts   (needs Playwright's Chromium)
 * Then bump the ?v= on the icon URLs (app/layout.tsx, public/manifest.json,
 * Header.tsx, AppShell.tsx).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const ROOT = join(import.meta.dir, "../..");
const PUB = join(ROOT, "public");

/** Seal red and paper, as in app/globals.css (--brand, --background). */
const SEAL = "oklch(0.53 0.207 22.3)";
const SEAL_DARK = "oklch(0.6 0.205 18.3)";
const PAPER = "oklch(0.945 0.02 82)";

type Pt = [number, number];

// ── seeded noise ────────────────────────────────────────────────────────────
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 2D value noise in [-1, 1]. */
function noise2(seed: number) {
  const r = rng(seed);
  const N = 256;
  const tab = Array.from({ length: N * N }, () => r() * 2 - 1);
  const at = (x: number, y: number) => tab[(((y % N) + N) % N) * N + (((x % N) + N) % N)];
  const fade = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = fade(x - x0);
    const fy = fade(y - y0);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
    return a + (b - a) * fy;
  };
}

const nx = [noise2(11), noise2(12)];
const ny = [noise2(21), noise2(22)];
/** The displacement field: a slow wobble plus a fine ragged edge. */
function displace([x, y]: Pt): Pt {
  const slow = 1 / 45;
  const fine = 1 / 11;
  return [
    x + 7 * nx[0](x * slow, y * slow) + 2.6 * nx[1](x * fine, y * fine),
    y + 7 * ny[0](x * slow, y * slow) + 2.6 * ny[1](x * fine, y * fine),
  ];
}

// ── path flattening (the glyph uses M, L, V, Q, Z only) ─────────────────────
function flatten(d: string, step: number): Pt[][] {
  const toks = d.match(/[MLVHQZ]|-?\d*\.?\d+/g) ?? [];
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  let p: Pt = [0, 0];
  let i = 0;
  const num = () => Number(toks[i++]);
  const line = (q: Pt) => {
    const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / step));
    for (let k = 1; k <= n; k++)
      cur.push([p[0] + ((q[0] - p[0]) * k) / n, p[1] + ((q[1] - p[1]) * k) / n]);
    p = q;
  };
  let cmd = "";
  while (i < toks.length) {
    if (/[A-Z]/.test(toks[i])) cmd = toks[i++];
    if (cmd === "M") {
      if (cur.length) out.push(cur);
      p = [num(), num()];
      cur = [p];
      cmd = "L";
    } else if (cmd === "L") line([num(), num()]);
    else if (cmd === "V") line([p[0], num()]);
    else if (cmd === "H") line([num(), p[1]]);
    else if (cmd === "Q") {
      const c: Pt = [num(), num()];
      const q: Pt = [num(), num()];
      const len = Math.hypot(c[0] - p[0], c[1] - p[1]) + Math.hypot(q[0] - c[0], q[1] - c[1]);
      const n = Math.max(2, Math.ceil(len / step));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const u = 1 - t;
        cur.push([
          u * u * p[0] + 2 * u * t * c[0] + t * t * q[0],
          u * u * p[1] + 2 * u * t * c[1] + t * t * q[1],
        ]);
      }
      p = q;
    } else if (cmd === "Z") {
      if (cur.length) out.push(cur);
      cur = [];
    } else throw new Error(`unsupported path command ${cmd}`);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** A rounded square, as one closed contour sampled every `step` units. */
function roundedSquare(inset: number, radius: number, step: number): Pt[] {
  const a = inset;
  const b = 1000 - inset;
  const pts: Pt[] = [];
  const seg = (p: Pt, q: Pt) => {
    const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / step));
    for (let k = 0; k < n; k++)
      pts.push([p[0] + ((q[0] - p[0]) * k) / n, p[1] + ((q[1] - p[1]) * k) / n]);
  };
  const arc = (cx: number, cy: number, from: number) => {
    const n = Math.max(2, Math.ceil((Math.PI / 2) * radius) / step);
    for (let k = 0; k < n; k++) {
      const t = from + ((Math.PI / 2) * k) / n;
      pts.push([cx + radius * Math.cos(t), cy + radius * Math.sin(t)]);
    }
  };
  seg([a + radius, a], [b - radius, a]);
  arc(b - radius, a + radius, -Math.PI / 2);
  seg([b, a + radius], [b, b - radius]);
  arc(b - radius, b - radius, 0);
  seg([b - radius, b], [a + radius, b]);
  arc(a + radius, b - radius, Math.PI / 2);
  seg([a, b - radius], [a, a + radius]);
  arc(a + radius, a + radius, Math.PI);
  return pts;
}

const fmt = (n: number) => String(Math.round(n));
function toPath(contours: Pt[][]): string {
  return contours
    .map((c) => {
      // Drop points that round onto the previous one.
      const pts = c
        .map(([x, y]) => [fmt(x), fmt(y)])
        .filter((p, k, a) => k === 0 || p[0] !== a[k - 1][0] || p[1] !== a[k - 1][1]);
      return "M" + pts.map((p) => p.join(" ")).join("L") + "Z";
    })
    .join("");
}

// ── the seal ────────────────────────────────────────────────────────────────
/** The glyph sits inside the rim, a little smaller than the old 白文 seal. */
const GLYPH_SCALE = 0.74;
const glyphSrc = readFileSync(join(import.meta.dir, "lian-glyph.path"), "utf8").trim();
const glyph = flatten(glyphSrc, 6).map((c) =>
  c.map(([x, y]) => displace([500 + (x - 500) * GLYPH_SCALE, 500 + (y - 500) * GLYPH_SCALE])),
);

// The rim: an outer and an inner rounded square, each worn separately, so its
// width wanders like a real impression's.
const RIM_OUT = 62;
const RIM_W = 50;
const rimOuter = roundedSquare(RIM_OUT, 70, 6).map(displace);
const rimInner = roundedSquare(RIM_OUT + RIM_W, 34, 6)
  .reverse()
  .map(([x, y]) => {
    // Sample the field somewhere else, so the inner edge wanders on its own.
    const [dx, dy] = displace([x + 3000, y + 3000]);
    return [dx - 3000, dy - 3000] as Pt;
  });

// Specks where the paste missed the paper: small irregular voids cut from the
// red (an SVG mask of plain shapes, no filters).
const r = rng(7);
const specks: Pt[][] = [];
for (let k = 0; k < 70; k++) {
  const cx = 70 + r() * 860;
  const cy = 70 + r() * 860;
  const rad = 2.5 + r() ** 2 * 9;
  const n = 7;
  const c: Pt[] = [];
  for (let j = 0; j < n; j++) {
    const t = (2 * Math.PI * j) / n;
    const rr = rad * (0.6 + r() * 0.7);
    c.push([cx + rr * Math.cos(t), cy + rr * Math.sin(t) * (0.7 + r() * 0.5)]);
  }
  specks.push(c);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
<!-- Generated by scripts/brand/gen-seal.ts — edit that, not this. The seal (煉, 印泥 red): a 朱文 stamp on a transparent background. -->
<style>.s{fill:${SEAL}}@media (prefers-color-scheme:dark){.s{fill:${SEAL_DARK}}}</style>
<defs><mask id="w" maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="1000"><rect width="1000" height="1000" fill="#fff"/><path fill="#000" d="${toPath(specks)}"/></mask></defs>
<g class="s" mask="url(#w)"><path fill-rule="evenodd" d="${toPath([rimOuter, rimInner])}"/><path d="${toPath(glyph)}"/></g>
</svg>
`;
writeFileSync(join(PUB, "icon.svg"), svg);
console.log(`icon.svg ${svg.length} bytes`);

// ── rasters ─────────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const page = await browser.newPage({ colorScheme: "light" });
const svgUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

/** `size` px square; the seal at `fill` of it, on `bg` (transparent if null). */
async function render(size: number, fill: number, bg: string | null): Promise<Buffer> {
  await page.setViewportSize({ width: size, height: size });
  const s = Math.round(size * fill);
  await page.setContent(
    `<html><body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${bg ?? "transparent"}">` +
      `<img src="${svgUrl}" width="${s}" height="${s}"></body></html>`,
  );
  await page.waitForFunction(() => document.images[0]?.complete);
  return page.screenshot({ omitBackground: bg === null, type: "png" });
}

const files: [string, Buffer][] = [
  ["icon-192.png", await render(192, 1, null)],
  ["icon-512.png", await render(512, 1, null)],
  // Maskable: the seal inside the 80% safe zone, on paper.
  ["icon-maskable-192.png", await render(192, 0.62, PAPER)],
  ["icon-maskable-512.png", await render(512, 0.62, PAPER)],
  // iOS rounds the corners itself; leave a paper margin like other app icons.
  ["apple-icon.png", await render(180, 0.78, PAPER)],
];
for (const [name, buf] of files) writeFileSync(join(PUB, name), buf);
writeFileSync(join(PUB, "apple-touch-icon.png"), files[4][1]);

// favicon.ico: PNG-compressed entries (Vista+ format), transparent.
const icoSizes = [16, 32, 48];
const pngs = [];
for (const s of icoSizes) pngs.push(await render(s, 1, null));
await browser.close();
const head = Buffer.alloc(6 + 16 * pngs.length);
head.writeUInt16LE(0, 0);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(pngs.length, 4);
let off = head.length;
pngs.forEach((png, k) => {
  const e = 6 + 16 * k;
  head.writeUInt8(icoSizes[k], e);
  head.writeUInt8(icoSizes[k], e + 1);
  head.writeUInt16LE(1, e + 4);
  head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(png.length, e + 8);
  head.writeUInt32LE(off, e + 12);
  off += png.length;
});
writeFileSync(join(PUB, "favicon.ico"), Buffer.concat([head, ...pngs]));
console.log(
  "icons written:",
  [...files.map((f) => f[0]), "apple-touch-icon.png", "favicon.ico"].join(", "),
);
