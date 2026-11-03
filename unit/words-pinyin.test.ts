import { describe, expect, test } from "bun:test";
import { markPinyin } from "../scripts/words/pinyin";

describe("markPinyin (CC-CEDICT numbered pinyin → tone marks)", () => {
  test("a and e take the mark, then the o of ou, else the last vowel", () => {
    expect(markPinyin("ni3 hao3")).toBe("nǐ hǎo");
    expect(markPinyin("zhi1 dao4")).toBe("zhī dào");
    expect(markPinyin("dou1")).toBe("dōu");
    expect(markPinyin("gui4")).toBe("guì");
    expect(markPinyin("xue2")).toBe("xué");
  });
  test("neutral tone and ü", () => {
    expect(markPinyin("wo3 men5")).toBe("wǒ men");
    expect(markPinyin("lu:4")).toBe("lǜ");
    expect(markPinyin("nu:3 er2")).toBe("nǚ ér");
  });
  test("capitals and non-syllables pass through", () => {
    expect(markPinyin("Bei3 jing1")).toBe("Běi jīng");
    expect(markPinyin("A A4")).toBe("A À");
    expect(markPinyin("110")).toBe("110");
  });
});
