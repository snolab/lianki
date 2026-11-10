// The on/off switch as a box seal (app/components/SealSwitch.tsx; owner,
// 2026-11-11): markup and roles, the two states' colours and outline from
// app/globals.css, their contrast in light and dark, the words in 16 locales.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { contrast, oklchToHex } from "@/lib/mail-templates/color";
import sealSwitch from "@/app/components/seal-switch.content";
import { SealStamp, SealSwitch } from "@/app/components/SealSwitch";
import { mockIntlayer } from "./support/intlayer-mock";

mockIntlayer();

const LOCALES = [
  "en",
  "zh",
  "hi",
  "es",
  "fr",
  "ar",
  "bn",
  "pt",
  "ru",
  "ur",
  "id",
  "de",
  "ja",
  "sw",
  "mr",
  "ko",
];

describe("markup", () => {
  const html = (checked: boolean, extra: Record<string, unknown> = {}) =>
    renderToString(createElement(SealSwitch, { checked, "aria-label": "levels", ...extra }));

  test("a switch, named by its row, with its state", () => {
    const on = html(true);
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain('aria-label="levels"');
    expect(on).toContain('data-seal="on"');
    expect(on).toContain('type="button"');
    expect(html(false)).toContain('aria-checked="false"');
    expect(html(false)).toContain('data-seal="off"');
  });

  test("both words are in the box (one shows), and neither is read out", () => {
    const out = html(false);
    expect(out).toContain('<span data-word="on">开</span>');
    expect(out).toContain('<span data-word="off">关闭</span>');
    expect(out).toMatch(/<span aria-hidden="true" class="lk-seal"/);
  });

  test("a form choice can be a checkbox; disabled passes through", () => {
    const out = html(true, { role: "checkbox", disabled: true });
    expect(out).toContain('role="checkbox"');
    expect(out).toContain('disabled=""');
  });

  test("the stamp alone, for a row that is itself the switch", () => {
    const out = renderToString(createElement(SealStamp, { on: true, size: "sm" }));
    expect(out).toContain('data-size="sm"');
    expect(out).not.toContain("role=");
  });
});

describe("app/globals.css", () => {
  const css = readFileSync("app/globals.css", "utf8");
  const rootStart = css.indexOf(":root {\n  /* Seal red");
  const root = css.slice(rootStart, css.indexOf("\n}\n", rootStart));
  const darkStart = css.indexOf("@media (prefers-color-scheme: dark) {\n  :root {", rootStart);
  const dark = css.slice(darkStart, css.indexOf("\n  }\n", darkStart));
  const token = (block: string, name: string) => {
    const m = block.match(new RegExp(`${name}:\\s*([^;]+);`));
    return m?.[1]?.trim();
  };
  const resolve = (block: string, name: string): string => {
    const v = token(block, name) ?? token(root, name);
    if (!v) throw new Error(`no ${name}`);
    const ref = v.match(/^var\((--[\w-]+)\)$/);
    return ref ? resolve(block, ref[1]!) : v;
  };
  const hex = (v: string) => {
    const h = oklchToHex(v);
    if (!h) throw new Error(`not oklch: ${v}`);
    return h;
  };
  const rule = (sel: string) => {
    const i = css.indexOf(`${sel} {`);
    expect(i).toBeGreaterThan(-1);
    return css.slice(i, css.indexOf("}", i));
  };

  for (const [scheme, block] of [
    ["light", root],
    ["dark", dark],
  ] as const) {
    test(`${scheme}: the words are AA (4.5:1), the box edge 3:1`, () => {
      const page = hex(resolve(block, "--background"));
      const seal = hex(resolve(block, "--lk-seal-on"));
      const ink = hex(resolve(block, "--lk-seal-on-ink"));
      const off = hex(resolve(block, "--lk-seal-off"));
      expect(contrast(ink, seal)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(off, page)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(seal, page)).toBeGreaterThanOrEqual(3);
    });
  }

  test("every colour is oklch", () => {
    for (const v of [token(root, "--lk-seal-off"), token(dark, "--lk-seal-off")])
      expect(v).toMatch(/^oklch\(/);
  });

  test("on: a filled seal-red box with the paper word", () => {
    const on = rule(".lk-seal");
    expect(on).toContain("background-color: var(--lk-seal-on)");
    expect(on).toContain("border: 2px solid var(--lk-seal-on)");
    expect(on).toContain("color: var(--lk-seal-on-ink)");
  });

  test("off: the same box, grey and dashed, no fill", () => {
    const off = rule('.lk-seal[data-seal="off"]');
    expect(off).toContain("border-style: dashed");
    expect(off).toContain("border-color: var(--lk-seal-off)");
    expect(off).toContain("background-color: transparent");
    expect(off).toContain("color: var(--lk-seal-off)");
    expect(off).not.toMatch(/padding|min-width|font-size/);
  });

  test("the tap target is at least 40px tall; no motion when reduced", () => {
    expect(rule(".lk-seal-switch")).toContain("min-height: 2.5rem");
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.lk-seal,\s*\.lk-seal\[data-stamping\] \{\s*animation: none;/,
    );
  });
});

describe("the words", () => {
  const { on, off } = sealSwitch.content as unknown as Record<
    "on" | "off",
    { translation: Record<string, string> }
  >;
  test("16 locales, each with two different, short words", () => {
    for (const l of LOCALES) {
      expect(on.translation[l]?.length).toBeGreaterThan(0);
      expect(off.translation[l]?.length).toBeGreaterThan(0);
      expect(on.translation[l]).not.toBe(off.translation[l]);
      expect(Math.max(on.translation[l]!.length, off.translation[l]!.length)).toBeLessThan(12);
    }
    expect(on.translation.zh).toBe("开");
    expect(off.translation.zh).toBe("关闭");
  });
});
