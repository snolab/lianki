import { describe, expect, test } from "bun:test";
import { spokenText } from "@/lib/words/spoken";

describe("spokenText", () => {
  test("word lists say the word, or the kana reading for Japanese", () => {
    expect(spokenText({ term: "être", back: "to be" }, "fr", true)).toBe("être");
    expect(spokenText({ term: "何", reading: "なん; なに", back: "what" }, "ja", true)).toBe(
      "なん",
    );
    expect(spokenText({ term: "你好", reading: "nǐ hǎo", back: "hello" }, "zh", true)).toBe("你好");
  });

  test("alphabets say the native-script side, never romanization or IPA", () => {
    expect(spokenText({ term: "あ", back: "a" }, "ja", false)).toBe("あ");
    expect(spokenText({ term: "ji", back: "じ / ぢ" }, "ja", false)).toBe("じ");
    expect(spokenText({ term: "/u/", back: "ou" }, "fr", false)).toBe("ou");
    expect(spokenText({ term: "ou", back: "/u/" }, "fr", false)).toBe("ou");
    expect(spokenText({ term: "shi", back: "ㄕ", reading: "是 时" }, "zh", false)).toBe("是");
  });

  test("stays silent when there is nothing sensible to say", () => {
    expect(spokenText({ term: "b", back: "/p/" }, "zh", false)).toBe("");
  });
});
