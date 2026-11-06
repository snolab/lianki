/**
 * Explore cards on /home (app/(app)/home/FeatureCard.tsx): name, one line of
 * explanation, and a wordless drawing behind them that never moves layout.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FeatureArt } from "@/app/(app)/home/FeatureArt";
import { FeatureCard } from "@/app/(app)/home/FeatureCard";
import { HOME_EXPLORE, HOME_EXPLORE_HREF } from "@/lib/home-features";
import { APP_NAV } from "@/lib/app-nav";
import navHome from "@/app/(app)/home/page.content";

const art = (feature: (typeof HOME_EXPLORE)[number]) =>
  renderToStaticMarkup(createElement(FeatureArt, { feature }));

describe("FeatureCard", () => {
  test("the name and explanation over the feature's drawing, no image file", () => {
    const html = renderToStaticMarkup(
      createElement(FeatureCard, {
        featureKey: "read",
        href: "/read",
        icon: "bookOpen" as const,
        label: "Read",
        desc: "Read your own texts and books",
      }),
    );
    expect(html).toContain('href="/read"');
    expect(html).toContain("Read your own texts and books");
    expect(html).toContain("lk-feature-card");
    expect(html).toContain("lk-feature-art");
    expect(html).not.toContain("<img");
  });
});

describe("home feature drawings", () => {
  test("every Explore feature is in the nav and has an explanation", () => {
    const cards = (navHome.content as unknown as { cards: Record<string, unknown> }).cards;
    for (const k of HOME_EXPLORE) {
      expect(APP_NAV.some((n) => n.key === k)).toBe(true);
      expect(cards[k]).toBeDefined();
    }
  });

  test("eight cards; Word lists is one card and opens the Add a list tree", () => {
    expect(HOME_EXPLORE.length).toBe(8);
    expect(HOME_EXPLORE_HREF.words).toBe("/words#add-list");
  });

  test("each is its own drawing, decorative, and stays small", () => {
    const all = HOME_EXPLORE.map(art);
    expect(new Set(all).size).toBe(HOME_EXPLORE.length);
    for (const svg of all) {
      expect(svg).toContain('aria-hidden="true"');
      expect(svg.length).toBeLessThan(3 * 1024);
    }
  });

  test("no words in a drawing, and no fixed colours: only the theme's tokens", () => {
    for (const k of HOME_EXPLORE) {
      const svg = art(k);
      expect(svg).not.toContain("<text");
      expect(svg).not.toContain("<image");
      // Tags only: nothing but markup, so nothing a reader would read.
      expect(svg).not.toMatch(/>[^<]/);
      const colours = [...svg.matchAll(/(?:fill|stroke)="([^"]*)"/g)].map((m) => m[1]);
      for (const c of colours) expect(c).toMatch(/^(none|var\(--(ink|seal|wash|sheet)\))$/);
    }
  });

  test("CSS gives the card its own height and keeps the drawing out of the flow", async () => {
    const css = await Bun.file(join(import.meta.dir, "..", "app", "globals.css")).text();
    const card = css.match(/\.lk-feature-card \{([^}]*)\}/)?.[1] ?? "";
    const drawing = css.match(/\.lk-feature-art \{([^}]*)\}/)?.[1] ?? "";
    expect(card).toMatch(/min-height: \d/);
    expect(drawing).toContain("position: absolute");
    expect(drawing).toContain("--ink: color-mix(in oklch, var(--foreground)");
  });
});
