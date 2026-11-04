import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

// The owner (2026-11-04, PC /read): "mousehover不再移动竹简focus". The
// focused slip (/words, and /read's word review, which is the same Study)
// moves by keys, grading and voice; never by the mouse passing over it.
// Hover may still reveal (CSS), but no hover handler may move the focus.

const HOVER = /on(Mouse(Move|Enter|Over)|Pointer(Enter|Over))=/;

/** The source of one function component, up to the next top-level function. */
function body(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  expect(at).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\nfunction ", at + 1);
  return src.slice(at, next < 0 ? undefined : next);
}

describe("hover never moves the focused slip", () => {
  it("/words desktop rows have no hover handler", () => {
    const src = readFileSync("app/(app)/words/WordsClient.tsx", "utf8");
    expect(body(src, "DeskWordRow")).not.toMatch(HOVER);
    expect(src).not.toMatch(/onHover=/);
  });

  it("/read desktop items have no hover handler", () => {
    const src = readFileSync("app/(app)/read/[id]/reader-blocks.tsx", "utf8");
    expect(body(src, "DeskItem")).not.toMatch(HOVER);
  });
});
