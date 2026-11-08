/**
 * The grade keys (lib/words/swipe.ts KEY_RATING): one map for /words and the
 * reader v2. The reader once read H J K L as Again Hard Good Easy, the reverse
 * of /words' L K J H, so his /words habit (H = Easy) graded paragraphs Again
 * (owner, 2026-11-04: a paragraph reviewed many times still looked new).
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KEY_RATING, keyRating, rowTap } from "@/lib/words/swipe";

const key = (code: string, shiftKey = false) => ({ code, shiftKey });

describe("grade keys", () => {
  it("L K J H = Again Hard Good Easy, as 1–4", () => {
    expect(["KeyL", "KeyK", "KeyJ", "KeyH"].map((c) => keyRating(key(c)))).toEqual([1, 2, 3, 4]);
    expect(["Digit1", "Digit2", "Digit3", "Digit4"].map((c) => keyRating(key(c)))).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("the outer fingers agree: 1 and L are Again, 4 and H are Easy", () => {
    expect(KEY_RATING.Digit1).toBe(KEY_RATING.KeyL);
    expect(KEY_RATING.Digit4).toBe(KEY_RATING.KeyH);
  });

  it("Shift and other keys grade nothing", () => {
    expect(keyRating(key("KeyH", true))).toBeNull();
    expect(keyRating(key("KeyU"))).toBeNull();
    expect(keyRating(key("Space"))).toBeNull();
  });

  it("/words and the reader v2 both grade through keyRating, with no map of their own", () => {
    const root = join(import.meta.dir, "..");
    for (const f of ["app/(app)/words/WordsClient.tsx", "app/(app)/reader/[id]/ReaderV2.tsx"]) {
      const src = readFileSync(join(root, f), "utf8");
      expect(src).toContain("keyRating(e)");
      // No letter-keyed grade map (h: 1 …) of its own.
      expect(src).not.toMatch(/\bh: [1-4],/);
      expect(src).not.toMatch(/KeyH: [1-4]/);
    }
  });

  it("a click on a slip focuses it, a tap reveals it: neither grades", () => {
    expect(rowTap(false)).toBe("focus");
    expect(rowTap(true)).toBe("reveal");
    const src = readFileSync(
      join(import.meta.dir, "..", "app/(app)/words/WordsClient.tsx"),
      "utf8",
    );
    // The row's tap handler never grades (it once was `grade(i, 1)`: click = Again).
    const tap = src.slice(src.indexOf("onTap={(now) => {"), src.indexOf("onSwipeStart={"));
    expect(tap).toContain("rowTap(touch)");
    expect(tap).not.toMatch(/grade\(/);
  });
});
