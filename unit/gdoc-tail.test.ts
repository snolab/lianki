// The live end of a Google Doc (docs/connections.md, "Live stream").
import { describe, expect, it } from "bun:test";
import { EMPTY_TAIL, applyTailOps, parseBindOps, unsavedTail } from "@/lib/read/gdoc-tail";

describe("parseBindOps", () => {
  it("finds inserts and deletes in a real chunk's shape, unescaped", () => {
    const chunk =
      '459\n[[2192,[0,1,{"c":[[{"ty":"is","ibi":13167,"s":"えっと\\n\\"ok\\""},1793935434878]]}]],[2193,[10,1,{"selection":[]}]]]' +
      '{"ty":"mlti","mts":[{"ty":"ds","si":5,"ei":7}]} trailing';
    const { ops, consumed } = parseBindOps(chunk);
    expect(ops).toEqual([
      { i: 13167, s: 'えっと\n"ok"' },
      { si: 5, ei: 7 },
    ]);
    expect(chunk.slice(consumed)).toBe("]} trailing");
  });
  it("gives nothing for noise or an edit still arriving", () => {
    expect(parseBindOps('17\n[[2131,["noop"]]]')).toEqual({ ops: [], consumed: 0 });
    expect(parseBindOps('{"ty":"is","ibi":1,"s":"half').ops).toEqual([]);
  });
  it("skips text that does not unescape", () => {
    expect(parseBindOps('{"ty":"is","ibi":1,"s":"\\x"}').ops).toEqual([]);
  });
});

describe("applyTailOps", () => {
  it("appends from wherever the doc's end first shows itself", () => {
    let t = applyTailOps(EMPTY_TAIL, [{ i: 100, s: "abc" }]);
    t = applyTailOps(t, [{ i: 103, s: "def" }]);
    expect(t).toEqual({ text: "abcdef", end: 106 });
  });
  it("applies a revision inside the tail", () => {
    const t = applyTailOps(EMPTY_TAIL, [
      { i: 100, s: "abcdef" },
      { i: 103, s: "X" },
      { si: 100, ei: 101 },
    ]);
    expect(t.text).toBe("cXdef");
    expect(t.end).toBe(105);
  });
  it("ignores edits before the tail, keeping the end right", () => {
    const t = applyTailOps(EMPTY_TAIL, [
      { i: 100, s: "abc" },
      { i: 5, s: "head" },
      { si: 1, ei: 2 },
      { i: 105, s: "d" },
    ]);
    expect(t.text).toBe("abcd");
    expect(t.end).toBe(106);
  });
  it("cannot delete before any insert, and reads control characters as breaks", () => {
    expect(applyTailOps(EMPTY_TAIL, [{ si: 1, ei: 2 }])).toEqual(EMPTY_TAIL);
    expect(applyTailOps(EMPTY_TAIL, [{ i: 1, s: "a\u0012\u001cb\tc" }]).text).toBe("a\nb\nc");
  });
});

describe("unsavedTail", () => {
  it("keeps what the export has not caught up with", () => {
    expect(unsavedTail("old text 今天天气很好", "今天天气很好\n然后继续")).toBe("然后继续");
  });
  it("is empty when the book holds it all, even when newer", () => {
    expect(unsavedTail("abc defghijk and more", "defghijk")).toBe("");
    expect(unsavedTail("anything", "")).toBe("");
  });
  it("ignores how the lines were cut", () => {
    expect(unsavedTail("first line\nsecond li\nne", "second line then third")).toBe(
      " then third".trimStart(),
    );
  });
  it("keeps all of it when nothing overlaps, or the match is not at the end", () => {
    expect(unsavedTail("completely other", "brand new words")).toBe("brand new words");
    expect(unsavedTail("brandnew then other", "brand new words")).toBe("brand new words");
  });
  it("gives nothing when only spaces remain", () => {
    expect(unsavedTail("abcdefghij", "abcdefghij  ")).toBe("");
  });
});
