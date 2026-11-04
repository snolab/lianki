/**
 * The selection card's icon group (app/(app)/read/[id]/reader-select-card.tsx,
 * owner 2026-11-05 02:10 JST): read aloud, copy text and copy link are icons
 * only, each named by its label (aria-label and tooltip); no look-up button.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CardIcons } from "@/app/(app)/read/[id]/reader-card-icons";

const noop = () => {};
const html = renderToStaticMarkup(
  createElement(CardIcons, {
    items: [
      { action: "read-aloud", icon: "speakerHigh", label: "Read aloud", run: noop },
      { action: "copy-text", icon: "copy", label: "Copy text", run: noop },
      {
        action: "copy-link",
        icon: "link",
        label: "Copy link",
        run: noop,
        testId: "read-select-link",
      },
    ],
  }),
);
const buttons = [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)];

describe("CardIcons", () => {
  test("three icon buttons, in order, each with its label as aria-label and title", () => {
    expect(buttons.map((b) => b[0].match(/data-action="([^"]+)"/)?.[1])).toEqual([
      "read-aloud",
      "copy-text",
      "copy-link",
    ]);
    for (const [b, label] of buttons.map((b, i) => [
      b[0],
      ["Read aloud", "Copy text", "Copy link"][i],
    ]))
      expect(b).toContain(`aria-label="${label}" title="${label}"`);
    expect(html).toContain('data-testid="read-select-link"');
  });

  test("icon only: no visible text, a Phosphor svg in currentColor", () => {
    for (const [, inner] of buttons) {
      expect(inner.replace(/<[^>]+>/g, "").trim()).toBe("");
      expect(inner).toMatch(/<svg[^>]*data-icon="(speakerHigh|copy|link)"[^>]*fill="currentColor"/);
      expect(inner).toContain('aria-hidden="true"');
    }
  });

  test("44px tap targets on touch, compact under a fine pointer", () => {
    for (const [b] of buttons) expect(b).toMatch(/h-11 w-11.*pointer-fine:h-8 pointer-fine:w-8/);
  });

  test("the card has no look-up action and no text buttons for copy or read aloud", () => {
    const src = readFileSync(
      join(import.meta.dir, "../app/(app)/read/[id]/reader-select-card.tsx"),
      "utf8",
    );
    expect(src).not.toContain("lookUp");
    expect(src).not.toContain("{t.copyText}");
    expect(src).not.toContain("{t.readAloud}");
    // No Translate button: the rest comes as he scrolls, a failure's line is its retry.
    expect(src).not.toContain("actions.translate");
    expect(src).toContain('data-testid="read-select-translate-retry"');
  });
});
