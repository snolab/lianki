/**
 * The study view's end of the list keeps a way back (app/(app)/words/study-done-back.tsx;
 * owner, 2026-11-05: "都学完了的情况也是显示返回按钮", and the "no more cards"
 * picture itself as the back action): the tray after the last word, and the
 * every-word-learned / none-due state, are a button doing what the toolbar's
 * exit does — back to the lists on /words, back to the book (closing the
 * overlay) in the reader's paragraph review.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyTray } from "@/app/(app)/words/EmptyTray";
import { TrayBack, studyFinished } from "@/app/(app)/words/study-done-back";

const app = join(import.meta.dir, "../app/(app)");
const words = readFileSync(join(app, "words/WordsClient.tsx"), "utf8");
const review = readFileSync(join(app, "read/[id]/reader-word-review.tsx"), "utf8");

const html = (art: boolean) =>
  renderToStaticMarkup(
    createElement(TrayBack, { label: "Back to the book", onExit: () => {}, art }),
  );

describe("TrayBack", () => {
  test("the picture is a button named by its visible label", () => {
    const h = html(true);
    expect(h).toMatch(/^<button type="button"/);
    expect(h).toContain('data-testid="study-done-back"');
    expect(h).toContain("<span>Back to the book</span>");
    // The picture is decoration inside the button: hidden from screen readers.
    expect(h).toMatch(/<span aria-hidden="true" data-empty-tray="true" class="block"><svg/);
    // A 44px tap target with a keyboard focus ring.
    expect(h).toContain("min-h-11");
    expect(h).toContain("focus-visible:ring-2");
    // Colours are oklch only.
    expect(h).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
  });

  test("a short over-scroll keeps the label button without the picture", () => {
    expect(html(false)).not.toContain("<svg");
    expect(html(false)).toContain("Back to the book");
  });

  test("a tap runs the exit, once", () => {
    let exits = 0;
    const el = TrayBack({ label: "← lists", onExit: () => exits++, art: true }) as ReactElement<{
      onClick: () => void;
    }>;
    el.props.onClick();
    expect(exits).toBe(1);
  });

  test("the tray before the first word stays decoration: no button, hidden", () => {
    const h = renderToStaticMarkup(createElement(EmptyTray, {}));
    expect(h).toMatch(/^<div aria-hidden="true" data-empty-tray="true"/);
    expect(h).toContain("<svg");
    expect(h).not.toContain("<button");
  });

  test("finished only when nothing is left to fetch or grade", () => {
    expect(studyFinished(true, 0)).toBe(true);
    expect(studyFinished(true, 3)).toBe(false);
    expect(studyFinished(false, 0)).toBe(false);
  });
});

describe("Study's end of the list", () => {
  test("the empty state and the end of the list both offer the toolbar's exit", () => {
    const uses = [...words.matchAll(/<TrayBack label=\{(\w+)\} onExit=\{(\w+)\} art/g)];
    expect(uses.length).toBe(2);
    for (const m of uses) expect([m[1], m[2]]).toEqual(["exitLabel", "onExit"]);
    // The end-of-list one is not gated on being finished: it is there in every state.
    expect(words).not.toMatch(/finished && \(\s*<div[^]*?<TrayBack/);
    // The same label as the toolbar's exit button, which runs the same onExit.
    expect(words).toContain("const exitLabel = scope?.exitLabel ?? text.backToLists.value;");
    expect(words).toMatch(/onClick=\{onExit\}\s*>\s*\{exitLabel\}/);
    // The study keys leave Enter / Space on the focused button to the button.
    expect(words).toContain('t.closest?.("[data-testid=study-done-back]")');
  });

  test("in the reader's paragraph review the exit closes the overlay, back to the book", () => {
    expect(review).toContain("onExit={() => close.current()}");
    expect(review).toContain("exitLabel: t.backToBook.value");
    // Closing returns focus to the paragraph the review was opened from.
    expect(review).toMatch(/return \(\) => back\?\.focus\(/);
  });
});
