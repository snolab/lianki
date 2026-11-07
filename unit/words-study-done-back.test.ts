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
import {
  TrayBack,
  focusStillFree,
  inTypingField,
  listDone,
  reviewEnded,
  studyFinished,
} from "@/app/(app)/words/study-done-back";

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
    // A 44px tap target. The focused look is plain :focus, so it also shows
    // after a swipe, where a browser may not count the focus as visible.
    expect(h).toContain("min-h-11");
    expect(h).toContain("focus:ring-[3px]");
    expect(h).toContain("focus:bg-[oklch(");
    expect(h).not.toContain("focus-visible:");
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

describe("reviewEnded: the last word to review was just graded (focus goes to the way back)", () => {
  const end = { first: true, reviewable: true, exhausted: true, left: 0, waiting: 0 };
  test("the last unreviewed new or due word, graded: the end", () => {
    expect(reviewEnded(end)).toBe(true);
  });
  test("a correction of an earlier word when all are done: no focus jump (#511)", () => {
    expect(reviewEnded({ ...end, first: false })).toBe(false);
  });
  test("a fetched word about to join below: not the end", () => {
    expect(reviewEnded({ ...end, waiting: 1 })).toBe(false);
  });
  test("another new or due word still ungraded in the list: not the end", () => {
    expect(reviewEnded({ ...end, left: 1 })).toBe(false);
  });
  test("more words still to fetch: not the end", () => {
    expect(reviewEnded({ ...end, exhausted: false })).toBe(false);
  });
  test("browsing a word ahead of its due never ends the review", () => {
    expect(reviewEnded({ ...end, reviewable: false })).toBe(false);
  });
});

describe("the focus target and the G key", () => {
  test("listDone: what G waits for", () => {
    const done = { exhausted: true, left: 0, waiting: 0 };
    expect(listDone(done)).toBe(true);
    expect(listDone({ ...done, left: 1 })).toBe(false);
    expect(listDone({ ...done, waiting: 1 })).toBe(false);
    expect(listDone({ ...done, exhausted: false })).toBe(false);
  });
  test("the focus moved on to something real stays there; nothing yields", () => {
    const body = { id: "body" } as unknown as Element;
    const row = { id: "row" } as unknown as Element;
    const chat = { id: "chat" } as unknown as Element;
    expect(focusStillFree(row, row, body)).toBe(true);
    // The row it was on left the window, or a tap landed on nothing.
    expect(focusStillFree(body, row, body)).toBe(true);
    expect(focusStillFree(null, row, body)).toBe(true);
    expect(focusStillFree(chat, row, body)).toBe(false);
  });
  test("never while typing in a field", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(inTypingField({ tagName })).toBe(true);
    }
    expect(inTypingField({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(inTypingField({ tagName: "BUTTON" })).toBe(false);
    expect(inTypingField({ tagName: "BODY" })).toBe(false);
  });
  test("Study wires G to the same exit, only once the list is done", () => {
    expect(words).toMatch(
      /e\.code === "KeyG"\) \{[^}]*if \(loading \|\| loadError \|\| !listDone\(listNow\(\)\)\) return;\s*onExit\(\);/,
    );
    // The typing check comes before any study key.
    expect(words.indexOf("if (inTypingField(t)) return;")).toBeLessThan(
      words.indexOf('e.code === "KeyG"'),
    );
    // A scoped review counts every row; /words only what is due or new.
    expect(words).toContain("!!scope || x.kind");
    // A missed word's copy does not hold the end back.
    expect(words).toContain("requeue.current.later.filter((w) => w.from < 0).length");
  });
});

describe("Study's end of the list", () => {
  test("the end of the review focuses the way back and says so, politely", () => {
    expect(words).toContain("const first = !gradesNow.current.has(i);");
    // Focus moved on meanwhile (the chat input): left there.
    expect(words).toContain("focusStillFree(document.activeElement, backFrom.current");
    expect(words).toMatch(/btn\.focus\(\{ preventScroll: true, focusVisible: true \}/);
    expect(words).toContain('behavior: motionOff() ? "auto" : "smooth"');
    expect(words).toMatch(/role="status" aria-live="polite" className="sr-only" data-review-ended/);
    expect(words).toContain("setBackSaid(text.allReviewedBack.value);");
  });

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
