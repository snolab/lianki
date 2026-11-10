import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Shatter } from "@/app/(app)/words/Shatter";
import { crackPattern, hashSeed, rng, SHATTER_H, SHATTER_W } from "@/lib/words/shatter";
import { shatterOn } from "@/lib/words/shatter-gate";

const KEY = "list-1\u0000bonjour";

/** Every x,y in a path's data. */
const points = (d: string) =>
  [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);

describe("shatter: a locked slip's cracks (words.shatter)", () => {
  it("the same card always gets the same cracks", () => {
    expect(crackPattern(KEY)).toEqual(crackPattern(KEY));
    expect(hashSeed(KEY)).toBe(hashSeed(KEY));
    const a = rng(7);
    const b = rng(7);
    for (let i = 0; i < 5; i++) expect(a()).toBe(b());
  });

  it("different cards crack differently", () => {
    const seen = new Set(
      ["a", "b", "c", "d", "e", "f"].map((t) => crackPattern(`l\u0000${t}`).rays.join()),
    );
    expect(seen.size).toBe(6);
  });

  it("5–7 rays from the impact, each reaching past an edge; the impact clear of the stamp and status", () => {
    for (let k = 0; k < 60; k++) {
      const g = crackPattern(`list\u0000word${k}`);
      expect(g.rays.length).toBeGreaterThanOrEqual(5);
      expect(g.rays.length).toBeLessThanOrEqual(7);
      expect(g.at.x).toBeGreaterThanOrEqual(0.22);
      expect(g.at.x).toBeLessThanOrEqual(0.72);
      expect(g.at.y).toBeGreaterThanOrEqual(0.3);
      expect(g.at.y).toBeLessThanOrEqual(0.7);
      for (const ray of g.rays) {
        const pts = points(ray);
        expect(pts[0][0]).toBeCloseTo(g.at.x * SHATTER_W, 0);
        expect(pts[0][1]).toBeCloseTo(g.at.y * SHATTER_H, 0);
        const [x, y] = pts.at(-1)!;
        // Out of the box, or the step cap ran out (a long, winding crack).
        const out = x < 0 || x > SHATTER_W || y < 0 || y > SHATTER_H;
        expect(out || pts.length === 25).toBe(true);
      }
    }
  });

  it("renders a static SVG for a row mounted ended, a live one once", () => {
    const rest = renderToStaticMarkup(createElement(Shatter, { seed: KEY, live: false }));
    expect(rest).toContain('data-shatter="rest"');
    expect(rest).toContain('aria-hidden="true"');
    expect(rest).not.toContain("lk-shatter-live");
    expect(rest).not.toContain("lk-shatter-hit");
    expect(rest).toContain('preserveAspectRatio="none"');
    const live = renderToStaticMarkup(createElement(Shatter, { seed: KEY, live: true }));
    expect(live).toContain('data-shatter="live"');
    expect(live).toContain("lk-shatter-live");
    expect(live).toContain("lk-shatter-hit");
    // The same cracks either way.
    const paths = (html: string) => html.match(/<path d="[^"]+"/g);
    expect(paths(live)).toEqual(paths(rest));
  });

  it("the gate: on for dev holders while the flag is on, nobody when off", () => {
    expect(shatterOn({ "words.shatter": true }, true)).toBe(true);
    expect(shatterOn({ "words.shatter": true }, false)).toBe(false);
    expect(shatterOn({ "words.shatter": false }, true)).toBe(false);
    expect(shatterOn({}, true)).toBe(false);
    expect(shatterOn(null, true)).toBe(false);
  });
});
