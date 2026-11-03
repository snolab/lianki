import { describe, expect, it } from "bun:test";
import { langRuns, localeOf } from "@/packages/debug-chat/src/lang-runs";

const runs = (t: string, hint?: string) => langRuns(t, hint).map((r) => `${r.lang}:${r.text}`);

describe("langRuns: mixed-language text, each run in its own language", () => {
  it("a Japanese word in a Chinese sentence: only the word is Japanese", () => {
    expect(runs("你刚刚说的ありがとう，其实是谢谢的意思。")).toEqual([
      "zh:你刚刚说的",
      "ja:ありがとう，",
      "zh:其实是谢谢的意思。",
    ]);
    // Han glued to kana (a Japanese word) goes with the kana; the Chinese around stays Chinese.
    expect(runs("我昨天去了東京に行きました的那家店。")).toEqual([
      "zh:我昨天去了東京",
      "ja:に行きました",
      "zh:的那家店。",
    ]);
    // Quoted (the usual way a reply cites a word): the Han inside the quote goes with its kana.
    expect(runs("这个词叫「稲妻です」，意思是闪电。")).toEqual([
      "zh:这个词叫「",
      "ja:稲妻です」，",
      "zh:意思是闪电。",
    ]);
  });
  it("Japanese with Han not glued to kana stays Japanese", () => {
    expect(runs("東京、大阪、京都に行きました。")).toEqual(["ja:東京、大阪、京都に行きました。"]);
    expect(runs("日本語を勉強しています。")).toEqual(["ja:日本語を勉強しています。"]);
    expect(runs("コーヒーを飲みたい。")).toEqual(["ja:コーヒーを飲みたい。"]);
  });
  it("Japanese with English words keeps them in Japanese", () => {
    expect(runs("今日はReactのhooksについて話します。")).toEqual([
      "ja:今日はReactのhooksについて話します。",
    ]);
  });
  it("an English acronym or name in Chinese stays Chinese; a long English sentence is English", () => {
    expect(runs("我们用 API 调用 DeepSeek 模型。")).toEqual(["zh:我们用 API 调用 DeepSeek 模型。"]);
    expect(runs("他说：The quick brown fox jumps over the lazy dog. 然后笑了。")).toEqual([
      "zh:他说：",
      "en:The quick brown fox jumps over the lazy dog.",
      "zh:然后笑了。",
    ]);
  });
  it("Korean with Han is Korean", () => {
    expect(runs("한국어에서 漢字는 한자라고 합니다.")).toEqual([
      "ko:한국어에서 漢字는 한자라고 합니다.",
    ]);
  });
  it("plain text is one run; a hint decides shared scripts, never a whole other script", () => {
    expect(runs("OK, let's go.")).toEqual(["en:OK, let's go."]);
    expect(runs("OK, let's go.", "zh")).toEqual(["en:OK, let's go."]);
    expect(runs("東京", "ja")).toEqual(["ja:東京"]);
    expect(runs("東京")).toEqual(["zh:東京"]);
    expect(runs("2026年11月3日")).toEqual(["zh:2026年11月3日"]);
    expect(runs("")).toEqual([]);
  });
  it("locales for speechSynthesis", () => {
    expect(["zh", "ja", "ko", "en", "xx"].map(localeOf)).toEqual([
      "zh-CN",
      "ja-JP",
      "ko-KR",
      "en-US",
      "xx",
    ]);
  });
});
