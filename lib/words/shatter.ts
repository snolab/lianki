/**
 * The cracked-glass look of a slip that can no longer be swiped (/words, flag
 * `words.shatter`): its countdown ended and it reads "↓ back" (retired,
 * lib/words/requeue.ts). Owner, 2026-11-10 22:59 JST: tell the ended cards
 * apart from the ones that still have time left.
 *
 * Pure and deterministic: the same seed (the card's key) always gives the same
 * cracks, so a re-render or a row scrolled out and back in never changes them.
 * Coordinates are in a fixed box (`SHATTER_W` × `SHATTER_H`) that the SVG
 * stretches over the slip (`preserveAspectRatio="none"`, non-scaling strokes),
 * so any row height — the pinch's `--row-h` — fits without new geometry.
 */

export const SHATTER_W = 400;
export const SHATTER_H = 100;

export type CrackPattern = {
  /** The impact point, as a share of the box (0–1), for the flash and the reveal. */
  at: { x: number; y: number };
  /** Radial cracks from the impact to past an edge: SVG path data. */
  rays: string[];
  /** Short pieces of the ring around the impact, between neighbouring rays. */
  ring: string[];
  /** Small side cracks branching off the rays. */
  twigs: string[];
};

/** FNV-1a, 32 bit: a stable number from any string. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small seeded PRNG, uniform in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const d = (pts: readonly (readonly [number, number])[]) =>
  pts.map(([x, y], k) => `${k ? "L" : "M"}${r1(x)} ${r1(y)}`).join("");

/** The cracks for one card: 5–7 rays, a broken ring, a few twigs. */
export function crackPattern(seed: string): CrackPattern {
  const rand = rng(hashSeed(seed));
  const W = SHATTER_W;
  const H = SHATTER_H;
  // Clear of the stamp at the left and the status at the right.
  const ix = W * (0.22 + rand() * 0.5);
  const iy = H * (0.3 + rand() * 0.4);
  const n = 5 + Math.floor(rand() * 3);
  const turn = rand() * Math.PI * 2;
  const rays: string[] = [];
  const twigs: string[] = [];
  const knees: [number, number][] = [];
  const out = (x: number, y: number) => x < -4 || x > W + 4 || y < -4 || y > H + 4;
  for (let k = 0; k < n; k++) {
    let a = turn + (k / n) * Math.PI * 2 + (rand() - 0.5) * 0.6;
    let x = ix;
    let y = iy;
    const pts: [number, number][] = [[x, y]];
    for (let step = 0; step < 24 && !out(x, y); step++) {
      a += (rand() - 0.5) * 0.3;
      // The box is wide: steps are longer across than up and down.
      const len = 14 + rand() * 22;
      x += Math.cos(a) * len;
      y += Math.sin(a) * len * 0.7;
      pts.push([x, y]);
      if (step === 0) knees.push([x, y]);
      if (step > 0 && rand() < 0.25) {
        const b = a + (rand() < 0.5 ? -1 : 1) * (0.5 + rand() * 0.6);
        const l = 8 + rand() * 14;
        twigs.push(
          d([
            [x, y],
            [x + Math.cos(b) * l, y + Math.sin(b) * l * 0.7],
          ]),
        );
      }
    }
    rays.push(d(pts));
  }
  // The ring: between neighbouring first knees, skipping some, bent once.
  const ring: string[] = [];
  for (let k = 0; k < knees.length; k++) {
    if (rand() < 0.35) continue;
    const [ax, ay] = knees[k];
    const [bx, by] = knees[(k + 1) % knees.length];
    const mx = (ax + bx) / 2 + (rand() - 0.5) * 6;
    const my = (ay + by) / 2 + (rand() - 0.5) * 3;
    ring.push(
      d([
        [ax, ay],
        [mx, my],
        [bx, by],
      ]),
    );
  }
  return { at: { x: ix / W, y: iy / H }, rays, ring, twigs };
}
