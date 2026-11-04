/**
 * Explore cards on /home (app/(app)/home/FeatureCard.tsx): name, one line of
 * explanation, and a screenshot behind them that never moves layout.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FeatureCard } from "@/app/(app)/home/FeatureCard";
import { HOME_EXPLORE, HOME_FEATURE_SHOT, homeFeatureShot } from "@/lib/home-features";
import { APP_NAV } from "@/lib/app-nav";
import navHome from "@/app/(app)/home/page.content";

const base = {
  featureKey: "read",
  href: "/read",
  icon: "bookOpen" as const,
  label: "Read",
  desc: "Read your own texts and books",
};

describe("FeatureCard", () => {
  test("with a screenshot: light and dark, lazy, sized, with alt text", () => {
    const html = renderToStaticMarkup(
      createElement(FeatureCard, {
        ...base,
        shot: { light: "/a-light.webp", dark: "/a-dark.webp", alt: "Screenshot: Read" },
      }),
    );
    expect(html).toContain('href="/read"');
    expect(html).toContain("Read your own texts and books");
    expect(html).toContain('<source media="(prefers-color-scheme: dark)" srcSet="/a-dark.webp"/>');
    expect(html).toContain('src="/a-light.webp"');
    expect(html).toContain('alt="Screenshot: Read"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain(`width="${HOME_FEATURE_SHOT.width}"`);
    expect(html).toContain(`height="${HOME_FEATURE_SHOT.height}"`);
    // Fixed-height card, the image placed absolutely: no layout shift.
    expect(html).toContain("lk-feature-card");
    expect(html).toContain("lk-feature-shot");
  });

  test("without a screenshot: the same card, no picture", () => {
    const html = renderToStaticMarkup(createElement(FeatureCard, { ...base, shot: null }));
    expect(html).toContain("lk-feature-card");
    expect(html).toContain("Read your own texts and books");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<picture");
  });
});

describe("home feature screenshots", () => {
  test("every Explore feature is in the nav and has an explanation", () => {
    const cards = (navHome.content as unknown as { cards: Record<string, unknown> }).cards;
    for (const k of HOME_EXPLORE) {
      expect(APP_NAV.some((n) => n.key === k)).toBe(true);
      expect(cards[k]).toBeDefined();
    }
  });

  test("every screenshot exists, light and dark, and stays small", () => {
    for (const k of HOME_EXPLORE) {
      for (const scheme of ["light", "dark"] as const) {
        const url = homeFeatureShot(k, scheme)!;
        const file = join(import.meta.dir, "..", "public", url);
        expect(existsSync(file)).toBe(true);
        expect(statSync(file).size).toBeLessThan(40 * 1024);
      }
    }
  });

  test("CSS gives the card its own height and keeps the shot out of the flow", async () => {
    const css = await Bun.file(join(import.meta.dir, "..", "app", "globals.css")).text();
    const card = css.match(/\.lk-feature-card \{([^}]*)\}/)?.[1] ?? "";
    const shot = css.match(/\.lk-feature-shot \{([^}]*)\}/)?.[1] ?? "";
    expect(card).toMatch(/min-height: \d/);
    expect(shot).toContain("position: absolute");
  });
});
