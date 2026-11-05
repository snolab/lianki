// Generates the /membership plan-card material tiles in public/membership/*.svg
// (preview ?card=paper|wood|marble, app/(app)/membership/plan-cards.css).
// Deterministic: same output every run.  bun scripts/gen-membership-materials.ts
const out = new URL("../public/membership/", import.meta.url).pathname;
let s = 7;
const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
const f = (n: number) => +n.toFixed(1);
const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>\n`;

// Fibres (宣紙): curved strands, drawn again one tile over where they cross an
// edge, so the tile repeats without a seam.
function fibres(color: string, n: number, alpha: [number, number]) {
  s = 11;
  const W = 260;
  let p = "";
  for (let i = 0; i < n; i++) {
    const x = r() * W;
    const y = r() * W;
    const a = r() * Math.PI * 2;
    const len = 8 + r() * 34;
    const bend = (r() - 0.5) * len * 0.22;
    const x2 = x + Math.cos(a) * len;
    const y2 = y + Math.sin(a) * len;
    const cx = (x + x2) / 2 - Math.sin(a) * bend;
    const cy = (y + y2) / 2 + Math.cos(a) * bend;
    const w = f(0.25 + r() * 0.5);
    const o = f(alpha[0] + r() * (alpha[1] - alpha[0]));
    for (const dx of [-W, 0, W])
      for (const dy of [-W, 0, W]) {
        const xs = [x, x2, cx].map((v) => v + dx);
        const ys = [y, y2, cy].map((v) => v + dy);
        if (Math.max(...xs) < 0 || Math.min(...xs) > W) continue;
        if (Math.max(...ys) < 0 || Math.min(...ys) > W) continue;
        p += `<path d="M${f(xs[0])} ${f(ys[0])}Q${f(xs[2])} ${f(ys[2])} ${f(xs[1])} ${f(ys[1])}" stroke-width="${w}" stroke-opacity="${o}"/>`;
      }
  }
  return svg(W, W, `<g fill="none" stroke="${color}" stroke-linecap="round">${p}</g>`);
}

// Gold flecks (洒金): small irregular scraps of leaf, a few larger.
function flecks() {
  s = 23;
  const W = 220;
  let p = "";
  for (let i = 0; i < 46; i++) {
    const x = 4 + r() * (W - 8);
    const y = 4 + r() * (W - 8);
    const size = r() < 0.12 ? 2.5 + r() * 3 : 0.6 + r() * 1.6;
    const k = 4 + Math.floor(r() * 3);
    const pts = [];
    for (let j = 0; j < k; j++) {
      const a = (j / k) * Math.PI * 2 + r() * 0.8;
      const d = size * (0.5 + r() * 0.7);
      pts.push(`${f(x + Math.cos(a) * d)} ${f(y + Math.sin(a) * d)}`);
    }
    p += `<path d="M${pts.join("L")}Z" fill-opacity="${f(0.55 + r() * 0.4)}"/>`;
  }
  return svg(W, W, `<g fill="oklch(0.8 0.12 85)">${p}</g>`);
}

// Deckle (耳付き) frame for -webkit-mask-box-image, slice 16: a ragged 96px
// square. Each side's middle starts and ends at the same depth, so repeats join.
function deckle() {
  s = 5;
  const side = () => {
    const pts: [number, number][] = [];
    for (let t = 0; t <= 96; t += 2)
      pts.push([t, 3.5 + (r() - 0.5) * (t > 16 && t < 80 ? 4.5 : 3)]);
    for (const t of [0, 16, 80, 96]) pts[t / 2][1] = 3.5;
    return pts;
  };
  const [top, right, bottom, left] = [side(), side(), side(), side()];
  const pts = [
    ...top.map(([t, d]) => `${t} ${f(d)}`),
    ...right.map(([t, d]) => `${f(96 - d)} ${t}`),
    ...bottom.map(([t, d]) => `${96 - t} ${f(96 - d)}`),
    ...left.map(([t, d]) => `${f(d)} ${96 - t}`),
  ];
  return svg(
    96,
    96,
    `<filter id="b"><feTurbulence type="fractalNoise" baseFrequency=".35" numOctaves="2" seed="4"/><feDisplacementMap in="SourceGraphic" scale="2.2"/><feGaussianBlur stdDeviation=".45"/></filter><path filter="url(#b)" fill="oklch(0 0 0)" d="M${pts.join("L")}Z"/>`,
  );
}

// Wood (木目): long low-frequency noise banded into growth lines, plus pores.
function wood(color: string, op: number, poreOp: number) {
  return svg(
    640,
    220,
    `<filter id="w" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
      `<feTurbulence type="fractalNoise" baseFrequency=".0016 .022" numOctaves="3" seed="9" stitchTiles="stitch" result="t"/>` +
      `<feComponentTransfer in="t" result="b"><feFuncR type="table" tableValues="0 .15 .9 .1 0 .2 1 .1 0 .15 .8 .1 0"/></feComponentTransfer>` +
      `<feColorMatrix in="b" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${op} 0 0 0 0" result="figure"/>` +
      `<feTurbulence type="fractalNoise" baseFrequency=".0035 .3" numOctaves="2" seed="4" stitchTiles="stitch" result="s"/>` +
      `<feColorMatrix in="s" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${f(op * 4)} 0 0 0 ${f(-op * 2.1)}" result="streaks"/>` +
      `<feMerge result="lines"><feMergeNode in="figure"/><feMergeNode in="streaks"/></feMerge>` +
      `<feTurbulence type="fractalNoise" baseFrequency=".012 .7" numOctaves="2" seed="3" stitchTiles="stitch" result="p"/>` +
      `<feColorMatrix in="p" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${f(poreOp * 6)} 0 0 0 ${f(-poreOp * 3.1)}" result="pores"/>` +
      `<feMerge result="m"><feMergeNode in="lines"/><feMergeNode in="pores"/></feMerge>` +
      `<feFlood flood-color="${color}"/><feComposite in2="m" operator="in"/></filter>` +
      `<rect width="100%" height="100%" filter="url(#w)"/>`,
  );
}

// Marble (大理石): a few straight diagonal lines — a main vein, a branch, some
// hairlines — bent by low-frequency noise (feDisplacementMap), each with a
// soft halo, over a faint cloud. One slab, laid on with background-size: cover
// (stone does not repeat).
function marble(color: string, op: number, seed: number) {
  s = seed;
  const W = 900;
  let lines = "";
  for (let i = 0; i < 9; i++) {
    const main = i < 3;
    const x0 = -300 + r() * (W + 300);
    const tilt = 0.55 + r() * 0.5;
    const w = main ? 1.6 + r() * 1.6 : 0.5 + r() * 0.6;
    const o = main ? 0.8 + r() * 0.2 : 0.3 + r() * 0.3;
    lines += `<path d="M${f(x0)} -250L${f(x0 + (W + 500) * tilt)} ${W + 250}" stroke-width="${f(w)}" stroke-opacity="${f(o)}"/>`;
  }
  return svg(
    W,
    W,
    `<filter id="m" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
      `<feTurbulence type="fractalNoise" baseFrequency=".0028" numOctaves="3" seed="${seed}" result="n"/>` +
      `<feDisplacementMap in="SourceGraphic" in2="n" scale="150" xChannelSelector="R" yChannelSelector="G" result="v"/>` +
      `<feGaussianBlur in="v" stdDeviation="5" result="halo"/>` +
      `<feColorMatrix in="halo" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 .45 0" result="soft"/>` +
      `<feGaussianBlur in="v" stdDeviation=".45" result="crisp"/>` +
      `<feTurbulence type="fractalNoise" baseFrequency=".005" numOctaves="3" seed="${seed + 2}" result="c"/>` +
      `<feColorMatrix in="c" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 .2 0 0 0 -.08" result="ca"/><feFlood flood-color="${color}"/><feComposite in2="ca" operator="in" result="cloud"/>` +
      `<feMerge><feMergeNode in="cloud"/><feMergeNode in="soft"/><feMergeNode in="crisp"/></feMerge></filter>` +
      `<g filter="url(#m)" fill="none" stroke="${color}" opacity="${op}">${lines}<rect width="${W}" height="${W}" fill="${color}" fill-opacity="0" stroke="none"/></g>`,
  );
}

const files: Record<string, string> = {
  "fibres-light.svg": fibres("oklch(0.45 0.03 70)", 110, [0.07, 0.2]),
  "fibres-dark.svg": fibres("oklch(0.9 0.02 85)", 110, [0.05, 0.14]),
  "flecks.svg": flecks(),
  "deckle.svg": deckle(),
  "wood-light.svg": wood("oklch(0.32 0.06 50)", 0.26, 0.1),
  "wood-dark.svg": wood("oklch(0.8 0.05 70)", 0.1, 0.04),
  "marble-gray.svg": marble("oklch(0.5 0.015 250)", 0.75, 21),
  "marble-gold.svg": marble("oklch(0.68 0.11 80)", 0.9, 34),
  "marble-pale.svg": marble("oklch(0.88 0.01 85)", 0.7, 21),
};
for (const [n, c] of Object.entries(files)) await Bun.write(out + n, c);
console.log(
  Object.entries(files)
    .map(([n, c]) => `${n} ${c.length}B`)
    .join("\n"),
);
