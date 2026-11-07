/**
 * The reader's word scan panel (BookScan): its numbers, as the first reader
 * showed them, and when its details start open (lib/read/scan-buckets.ts).
 */
import { describe, expect, test } from "bun:test";
import { scanBuckets, scanOpenAtStart, type WordRow } from "@/lib/read/scan-buckets";

const lists = new Set(["chat", "manger", "être"]);
const by = { word: (w: string) => lists.has(w), head: (h: string) => lists.has(h) };

describe("the scan panel's numbers", () => {
  test("each distinct word lands in exactly one bucket", () => {
    const rows: WordRow[] = [
      ["le", 120, 0.9, 1, 0, 0], // a card, mastered
      ["chien", 40, 0.2, 0, 0, 0], // a card, not mastered: learning
      ["maison", 12, 0, 0, 1, 0], // score 0 is a card too: learning (own deck flag is moot)
      ["chat", 9, -1, 0, 0, 0], // no card, in a word list: new
      ["mangeait", 7, -1, 0, 0, 0, 0, ["manger"]], // no card, its headword in a list: new
      ["xyzzy", 6, -1, 0, 1, 0], // no card, in his own deck: new
      ["ornithorynque", 5, -1, 0, 0, 0, 1], // no card, the dictionary has it: new
      ["Paris", 30, -1, 0, 0, 1], // a proper name
      ["Marie", 3, -1, 0, 0, 1, 0, ["chat"]], // a name whose head is listed: new wins
      ["qwrt", 4, -1, 0, 0, 0], // unrecognised
      ["zzk", 2, -1, 0, 0, 0, 0, ["nope"]], // unrecognised, head not listed either
    ];
    const b = scanBuckets(rows, by);
    expect(b).toEqual({
      mastered: 1,
      learning: 2,
      fresh: 5,
      names: 1,
      unrecognised: ["qwrt", "zzk"],
    });
    // Every row counted once: the bar's segments add up to the distinct words.
    expect(b.mastered + b.learning + b.fresh + b.names + b.unrecognised.length).toBe(rows.length);
  });

  test("unrecognised words keep the server's order (most frequent first)", () => {
    const rows: WordRow[] = [
      ["b", 9, -1, 0, 0, 0],
      ["a", 5, -1, 0, 0, 0],
      ["c", 1, -1, 0, 0, 0],
    ];
    expect(scanBuckets(rows, by).unrecognised).toEqual(["b", "a", "c"]);
  });

  test("no rows: all zero", () => {
    expect(scanBuckets([], by)).toEqual({
      mastered: 0,
      learning: 0,
      fresh: 0,
      names: 0,
      unrecognised: [],
    });
  });
});

describe("the panel's details at the top of the reader", () => {
  test("first visit: open on a wide screen, folded on a phone", () => {
    expect(scanOpenAtStart(null, true)).toBe(true);
    expect(scanOpenAtStart(null, false)).toBe(false);
  });
  test("then as he last left them on this device", () => {
    expect(scanOpenAtStart("1", false)).toBe(true);
    expect(scanOpenAtStart("0", true)).toBe(false);
    expect(scanOpenAtStart("junk", true)).toBe(true);
  });
});
