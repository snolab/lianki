import { describe, expect, test } from "bun:test";
import {
  cleanMapping,
  emptyMapping,
  fromColumns,
  guessMapping,
  ignored,
  moveColumn,
  sameMapping,
  slotOf,
  slotText,
  type ColumnMapping,
} from "@/lib/import/column-map";
import { parseWordList, tableShape } from "@/lib/import/wordlist";

const map = (m: Partial<ColumnMapping>): ColumnMapping => ({ ...emptyMapping(), ...m });

describe("column map: the defaults come from the aliases", () => {
  test("a named header maps by name, in any order", () => {
    const t = tableShape("例句,单词,意思\nJe suis.,être,to be\n");
    expect(t.header).toBe(true);
    expect(t.names).toEqual(["例句", "单词", "意思"]);
    expect(t.defaults).toEqual(map({ term: [1], back: [2], ex: [0] }));
    expect(t.rows[0]).toEqual(["Je suis.", "être", "to be"]);
  });
  test("no header: word, meaning, example by position; the rest ignored", () => {
    const t = tableShape("chat,cat,Le chat dort.,extra\nchien,dog,Un chien.,x\n");
    expect(t.header).toBe(false);
    expect(t.width).toBe(4);
    expect(t.defaults).toEqual(map({ term: [0], back: [1], ex: [2] }));
    expect(ignored(t.defaults, t.width)).toEqual([3]);
  });
  test("a plain list has one column, the word", () => {
    const t = tableShape("chat\nchien\n");
    expect(t.format).toBe("lines");
    expect(t.width).toBe(1);
    expect(t.defaults).toEqual(map({ term: [0] }));
  });
});

describe("column map: parsing with an explicit mapping", () => {
  const csv = "a,b,c,d\nchat,cat,Le chat dort.,ʃa\nchien,dog,Un chien.,ʃjɛ̃\n";
  test("the mapping decides every field", () => {
    const p = parseWordList(csv, "x.csv", {
      mapping: map({ term: [1], back: [0], ex: [2], reading: [3] }),
      header: true,
    });
    expect(p.rows.map((r) => [r.term, r.back, r.ex, r.reading])).toEqual([
      ["cat", "chat", "Le chat dort.", "ʃa"],
      ["dog", "chien", "Un chien.", "ʃjɛ̃"],
    ]);
  });
  test("two columns in one slot are joined in their order", () => {
    const p = parseWordList(csv, "x.csv", {
      mapping: map({ term: [0], back: [3, 1] }),
      header: true,
    });
    expect(p.rows[0].back).toBe("ʃa; cat");
    expect(p.rows[0].ex).toBeUndefined();
  });
  test("an ignored column is left out", () => {
    const p = parseWordList(csv, "x.csv", { mapping: map({ term: [0] }), header: true });
    expect(p.rows[0]).toEqual({ line: 2, term: "chat", back: "" });
  });
  test("header off: the first row is a word too", () => {
    const p = parseWordList(csv, "x.csv", { mapping: map({ term: [0] }), header: false });
    expect(p.rows.map((r) => r.term)).toEqual(["a", "chat", "chien"]);
  });
  test("header on for a file without one: the first row is dropped", () => {
    const p = parseWordList("chat,cat\nchien,dog\n", "", {
      mapping: map({ term: [0], back: [1] }),
      header: true,
    });
    expect(p.rows.map((r) => r.term)).toEqual(["chien"]);
  });
  test("no word column: every row is skipped as no-term", () => {
    const p = parseWordList(csv, "x.csv", { mapping: map({ back: [1] }), header: true });
    expect(p.rows).toEqual([]);
    expect(p.skippedBy["no-term"]).toBe(2);
  });
  test("without a mapping, nothing changes", () => {
    const a = parseWordList(csv, "x.csv");
    const b = parseWordList(csv, "x.csv", {});
    expect(b).toEqual(a);
  });
  test("the detected columns are reported from the mapping", () => {
    const p = parseWordList(csv, "x.csv", { mapping: map({ term: [2], back: [0, 1] }) });
    expect(p.columns.term).toBe(2);
    expect(p.columns.back).toBe(0);
    expect(p.columns.ex).toBe(-1);
  });
});

describe("column map: a mapping from the page is checked", () => {
  test("out-of-range, repeated and non-integer columns are dropped", () => {
    expect(
      cleanMapping({ term: [0, 9, 0, 1.5, -1], back: [0, 2], ex: "x" as unknown as number[] }, 3),
    ).toBeNull();
    expect(cleanMapping({ term: [0, 9, 0, 1.5, -1], back: [0, 2] }, 3)).toEqual(
      map({ term: [0], back: [2] }),
    );
  });
  test("not an object: null", () => {
    expect(cleanMapping(null, 3)).toBeNull();
    expect(cleanMapping([1], 3)).toBeNull();
    expect(cleanMapping("term", 3)).toBeNull();
  });
  test("unknown slots are ignored", () => {
    expect(cleanMapping({ term: [0], evil: [1] }, 2)).toEqual(map({ term: [0] }));
  });
});

describe("column map: moving chips", () => {
  const m = map({ term: [0], back: [1, 2] });
  test("into another slot, at an index", () => {
    expect(moveColumn(m, 2, "term", 0)).toEqual(map({ term: [2, 0], back: [1] }));
  });
  test("reorder within a slot", () => {
    expect(moveColumn(m, 2, "back", 0)).toEqual(map({ term: [0], back: [2, 1] }));
  });
  test("to ignore", () => {
    expect(moveColumn(m, 1, null)).toEqual(map({ term: [0], back: [2] }));
    expect(slotOf(moveColumn(m, 1, null), 1)).toBeNull();
  });
  test("fromColumns, slotText, sameMapping", () => {
    expect(fromColumns({ term: 1, back: -1, reading: 5, ex: 0, exTr: -1 }, 3)).toEqual(
      map({ term: [1], ex: [0] }),
    );
    expect(slotText(["a ", " b", ""], [1, 2, 0])).toBe("b; a");
    expect(sameMapping(m, map({ term: [0], back: [1, 2] }))).toBe(true);
    expect(sameMapping(m, map({ term: [0], back: [2, 1] }))).toBe(false);
  });
});

describe("column map: the guessing hook", () => {
  const shape = { header: null, rows: [["a", "b"]], width: 2 };
  const fallback = map({ term: [0], back: [1] });
  test("no guessers: the aliases' mapping", () => {
    expect(guessMapping(shape, fallback, [])).toBe(fallback);
  });
  test("a guesser's answer wins when it names a word column", () => {
    expect(guessMapping(shape, fallback, [() => map({ term: [1], back: [0] })])).toEqual(
      map({ term: [1], back: [0] }),
    );
    expect(guessMapping(shape, fallback, [() => map({ back: [0] })])).toBe(fallback);
    expect(guessMapping(shape, fallback, [() => null])).toBe(fallback);
  });
});
