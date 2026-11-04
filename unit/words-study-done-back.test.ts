/**
 * The study view's done state keeps a way back (app/(app)/words/study-done-back.tsx;
 * owner, 2026-11-05: "都学完了的情况也是显示返回按钮"): every word learned or
 * none due shows a button that does what the toolbar's exit does — back to the
 * lists on /words, back to the book (closing the overlay) in the reader's review.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StudyDoneBack, studyFinished } from "@/app/(app)/words/study-done-back";

const app = join(import.meta.dir, "../app/(app)");
const words = readFileSync(join(app, "words/WordsClient.tsx"), "utf8");
const review = readFileSync(join(app, "read/[id]/reader-word-review.tsx"), "utf8");

describe("StudyDoneBack", () => {
  test("renders the exit label as a button", () => {
    const html = renderToStaticMarkup(
      createElement(StudyDoneBack, { label: "Back to the book", onExit: () => {} }),
    );
    expect(html).toContain('data-testid="study-done-back"');
    expect(html).toContain('type="button"');
    expect(html).toContain("Back to the book");
    // Colours are oklch only.
    expect(html).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
  });

  test("a tap runs the exit, once", () => {
    let exits = 0;
    const el = StudyDoneBack({ label: "← lists", onExit: () => exits++ }) as ReactElement<{
      onClick: () => void;
    }>;
    el.props.onClick();
    expect(exits).toBe(1);
  });

  test("finished only when nothing is left to fetch or grade", () => {
    expect(studyFinished(true, 0)).toBe(true);
    expect(studyFinished(true, 3)).toBe(false);
    expect(studyFinished(false, 0)).toBe(false);
  });
});

describe("Study's done states", () => {
  test("the empty state and the end of a finished list both offer the exit", () => {
    const uses = [...words.matchAll(/<StudyDoneBack label=\{(\w+)\} onExit=\{(\w+)\} \/>/g)];
    expect(uses.length).toBe(2);
    for (const m of uses) expect([m[1], m[2]]).toEqual(["exitLabel", "onExit"]);
    // The same label as the toolbar's exit button, which runs the same onExit.
    expect(words).toContain("const exitLabel = scope?.exitLabel ?? text.backToLists.value;");
    expect(words).toMatch(/onClick=\{onExit\}\s*>\s*\{exitLabel\}/);
    // The every-word-learned hint and the button agree on "finished".
    expect(words).toContain("studyFinished(exhausted, ahead.length)");
  });

  test("in the reader's paragraph review the exit closes the overlay, back to the book", () => {
    expect(review).toContain("onExit={() => close.current()}");
    expect(review).toContain("exitLabel: t.backToBook.value");
    // Closing returns focus to the paragraph the review was opened from.
    expect(review).toMatch(/return \(\) => back\?\.focus\(/);
  });
});
