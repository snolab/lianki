// Word segments with the languages' joins (lib/read/word-segments.ts, the
// joins in lib/read/lang/ja.json). Owner, 2026-11-05 14:17 JST: かついで
// (te-form of 担ぐ) showed as two words, か + ついで — Intl.Segmenter prefers
// the dictionary word ついで, under every locale and in every engine.
// Made-up sentences only.

import { describe, expect, it } from "bun:test";
import { cutPara } from "@/lib/read/reader-model";
import { phraseTokens } from "@/lib/read/select-meaning";
import { readingLoad } from "@/lib/read/units";
import { wordSegments } from "@/lib/read/word-segments";
import { countWords, wordsOf } from "@/lib/read/words";

const words = (text: string, lang = "ja") =>
  wordSegments(new Intl.Segmenter(lang, { granularity: "word" }), text)
    .filter((s) => s.isWordLike)
    .map((s) => s.segment);

describe("japanese inflected forms are one word", () => {
  it("かついで is one word, not か + ついで", () => {
    expect(words("荷物をかついで、山を登った。")).toEqual([
      "荷物",
      "を",
      "かついで",
      "山",
      "を",
      "登った",
    ]);
    expect(words("彼はかついで歩いた。")).toContain("かついで");
  });

  it("te-forms, past forms and polite forms after a kanji stem", () => {
    expect(words("ご飯を食べて、本を読んだ。駅に行きました。")).toEqual([
      "ご飯",
      "を",
      "食べて",
      "本",
      "を",
      "読んだ",
      "駅",
      "に",
      "行きました",
    ]);
    for (const w of ["書いて", "話して", "見て", "待って", "泳いで", "遊んで", "食べなかった"])
      expect(words(`今日は${w}。`)).toContain(w);
    expect(words("行きませんでした。")).toEqual(["行きませんでした"]);
  });

  it("particles after a noun stay apart", () => {
    expect(words("駅で待つ。猫が好き。私の本を読む。東京まで行く。")).toEqual([
      "駅",
      "で",
      "待つ",
      "猫",
      "が",
      "好き",
      "私",
      "の",
      "本",
      "を",
      "読む",
      "東京",
      "まで",
      "行く",
    ]);
    // で after a noun is the particle, だ the copula: not a verb's ending.
    expect(words("休みで家にいた。好きだ。")).toEqual([
      "休み",
      "で",
      "家",
      "に",
      "いた",
      "好き",
      "だ",
    ]);
    // ついで the word stays: か belongs to 何 here.
    expect(words("何かついでに買う。")).toEqual(["何", "か", "ついでに", "買う"]);
  });

  it("joins apply under any locale: a ja line in an English book, or no tag", () => {
    for (const lang of ["en", "und", "fr"])
      expect(words("荷物をかついで、ご飯を食べて。", lang === "und" ? "en" : lang)).toEqual([
        "荷物",
        "を",
        "かついで",
        "ご飯",
        "を",
        "食べて",
      ]);
  });

  it("other scripts are left alone", () => {
    expect(words("I took it and left.", "en")).toEqual(["I", "took", "it", "and", "left"]);
    expect(words("Il y a un chat.", "fr")).toEqual(["Il", "y", "a", "un", "chat"]);
  });

  it("segments join back into the text exactly, offsets kept", () => {
    const text = "荷物をかついで、ご飯を食べて。";
    const segs = wordSegments(new Intl.Segmenter("ja", { granularity: "word" }), text);
    expect(segs.map((s) => s.segment).join("")).toBe(text);
    for (const s of segs) expect(text.slice(s.index, s.index + s.segment.length)).toBe(s.segment);
  });
});

describe("every reader path cuts the same words", () => {
  const text = "荷物をかついで、ご飯を食べて、本を読んだ。";
  it("the paragraph's tokens (a ja line in a mixed book, counted in en)", () => {
    for (const [lang, norm] of [
      ["ja", "ja"],
      ["ja", "en"],
      ["en", "en"],
    ]) {
      const p = cutPara(text, lang, norm);
      const toks = p.sentences.flatMap((s) => s.segs.filter((g) => g.t >= 0).map((g) => g.text));
      expect(toks).toEqual([
        "荷物",
        "を",
        "かついで",
        "ご飯",
        "を",
        "食べて",
        "本",
        "を",
        "読んだ",
      ]);
    }
  });

  it("the word count, the selection's tokens and the reading load agree", () => {
    const stats = countWords([text], "en");
    expect(stats.words.map(([w]) => w)).toContain("かついで");
    expect(stats.words.map(([w]) => w)).not.toContain("ついで");
    expect(wordsOf(text, "ja")).toContain("かついで");
    expect(phraseTokens(text, "ja")).toEqual([
      "荷物",
      "を",
      "かついで",
      "ご飯",
      "を",
      "食べて",
      "本",
      "を",
      "読んだ",
    ]);
    expect(readingLoad(text, "ja")).toBe(9);
  });
});
