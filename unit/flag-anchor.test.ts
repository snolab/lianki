import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { FLAG_KEYS } from "@/lib/flags";
import { FLAG_HIGHLIGHT, FlagCard } from "@/app/(app)/dev/flags/FlagCard";
import { flagKeyFromHash, scrollToFlag } from "@/app/(app)/dev/flags/flag-anchor";

const DOTTED = "books.catalogue";

/** A document with only getElementById: a CSS selector lookup would throw here. */
function fakeDoc(ids: string[]) {
  const scrolls: { id: string; options: unknown }[] = [];
  const doc = {
    getElementById: (id: string) =>
      ids.includes(id)
        ? ({
            scrollIntoView: (options: unknown) => scrolls.push({ id, options }),
          } as unknown as HTMLElement)
        : null,
  };
  return { doc, scrolls };
}

describe("flagKeyFromHash", () => {
  test("reads the key, dots kept", () => {
    expect(flagKeyFromHash(`#${DOTTED}`)).toBe(DOTTED);
  });
  test("decodes a percent-encoded fragment", () => {
    expect(flagKeyFromHash("#books%2Ecatalogue")).toBe(DOTTED);
  });
  test("a malformed escape is used as written", () => {
    expect(flagKeyFromHash("#100%")).toBe("100%");
  });
  test("no hash, no key", () => {
    expect(flagKeyFromHash("")).toBeNull();
    expect(flagKeyFromHash("#")).toBeNull();
  });
});

describe("scrollToFlag", () => {
  test("scrolls the card with a dotted key into view and returns the key", () => {
    const { doc, scrolls } = fakeDoc([DOTTED]);
    expect(scrollToFlag(doc, `#${DOTTED}`, false)).toBe(DOTTED);
    expect(scrolls).toEqual([{ id: DOTTED, options: { behavior: "smooth", block: "start" } }]);
  });
  test("reduced motion jumps instead of animating", () => {
    const { doc, scrolls } = fakeDoc([DOTTED]);
    scrollToFlag(doc, `#${DOTTED}`, true);
    expect(scrolls[0]?.options).toEqual({ behavior: "auto", block: "start" });
  });
  test("a hash naming no card does nothing", () => {
    const { doc, scrolls } = fakeDoc([DOTTED]);
    expect(scrollToFlag(doc, "#no.such.flag", false)).toBeNull();
    expect(scrollToFlag(doc, "", false)).toBeNull();
    expect(scrolls).toEqual([]);
  });
});

describe("FlagCard anchor", () => {
  const props = (key: (typeof FLAG_KEYS)[number], highlighted: boolean) => ({
    flag: { key, description: "d", enabled: false, updatedAt: null, updatedBy: null },
    busy: false,
    highlighted,
    onToggle() {},
  });

  test("every registry flag's card has its key as id", () => {
    for (const key of FLAG_KEYS) {
      const html = renderToString(createElement(FlagCard, props(key, false)));
      expect(html).toContain(`<section id="${key}"`);
    }
  });
  test("only the card reached by a link is highlighted", () => {
    const on = renderToString(createElement(FlagCard, props(FLAG_KEYS[0]!, true)));
    const off = renderToString(createElement(FlagCard, props(FLAG_KEYS[0]!, false)));
    expect(on).toContain('data-highlighted="true"');
    expect(off).not.toContain("data-highlighted");
    expect(on).toContain("oklch(0.95_0.07_95)");
    expect(off).not.toContain("oklch(0.95_0.07_95)");
  });
  test("the highlight uses oklch colours only", () => {
    expect(FLAG_HIGHLIGHT).toContain("oklch(");
    expect(FLAG_HIGHLIGHT).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});
