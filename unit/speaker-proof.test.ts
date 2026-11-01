/**
 * lib/speaker-proof.ts lineIsSigned: the line must be exactly the signed
 * texts; the only differences allowed are NFKC, whitespace, and one "。"/"."
 * the mic appends after a signed text that had no final punctuation.
 */
import { describe, expect, it } from "bun:test";
import { lineIsSigned } from "@/lib/speaker-proof";

describe("lineIsSigned", () => {
  it("signed punctuation must stay as signed", () => {
    expect(lineIsSigned("删除全部卡片？", ["删除全部卡片？"])).toBe(true);
    // A question made an order.
    expect(lineIsSigned("删除全部卡片！", ["删除全部卡片？"])).toBe(false);
    // The signed ？ dropped.
    expect(lineIsSigned("删除全部卡片", ["删除全部卡片？"])).toBe(false);
    expect(lineIsSigned("删除全部卡片。", ["删除全部卡片？"])).toBe(false);
    // An ！ added where nothing was signed.
    expect(lineIsSigned("删除全部卡片！", ["删除全部卡片"])).toBe(false);
    expect(lineIsSigned("Delete all my cards!", ["Delete all my cards"])).toBe(false);
    // An ellipsis kept, dropped, or added.
    expect(lineIsSigned("我想想…", ["我想想…"])).toBe(true);
    expect(lineIsSigned("我想想", ["我想想…"])).toBe(false);
    expect(lineIsSigned("我想想。", ["我想想…"])).toBe(false);
    expect(lineIsSigned("我想想…", ["我想想"])).toBe(false);
  });

  it("only the mic's final full stop may be appended, once, where none was signed", () => {
    expect(lineIsSigned("下一个。", ["下一个"])).toBe(true);
    expect(lineIsSigned("next word.", ["next word"])).toBe(true);
    expect(lineIsSigned("下一个。。", ["下一个"])).toBe(false);
    expect(lineIsSigned("下一个。.", ["下一个"])).toBe(false);
    expect(lineIsSigned("下一个?", ["下一个"])).toBe(false);
    // Already ended by a signed mark: nothing more.
    expect(lineIsSigned("下一个。", ["下一个。"])).toBe(true);
    expect(lineIsSigned("下一个。。", ["下一个。"])).toBe(false);
  });

  it("NFKC and whitespace only; utterances in order", () => {
    // Full-width ？ is NFKC ?.
    expect(lineIsSigned("你好?", ["你好？"])).toBe(true);
    expect(lineIsSigned("  Next   word ", ["Next word"])).toBe(true);
    expect(lineIsSigned("你好。 下一个!", ["你好", "下一个!"])).toBe(true);
    expect(lineIsSigned("你好。下一个!", ["你好", "下一个!"])).toBe(true);
    expect(lineIsSigned("下一个! 你好", ["你好", "下一个!"])).toBe(false);
    expect(lineIsSigned("你好 下一个", ["你好", "下一个!"])).toBe(false);
    // A word dropped, added, replaced.
    expect(lineIsSigned("delete all my cards", ["do not delete all my cards"])).toBe(false);
    expect(lineIsSigned("next word now", ["next word"])).toBe(false);
    expect(lineIsSigned("next bird", ["next word"])).toBe(false);
    expect(lineIsSigned("", [])).toBe(false);
  });
});
