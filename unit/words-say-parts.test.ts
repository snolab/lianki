import { describe, expect, test } from "bun:test";
import { meaningLang, meaningText, prefetchOrder, sayParts } from "@/lib/words/say-parts";
import { createSequencer } from "@/lib/words/sequence";

describe("sayParts", () => {
  test("word, then meaning, then example, each in its own language", () => {
    expect(
      sayParts(
        { term: "maison", back: "house, home; household", ex: "Ma maison est grande." },
        "fr",
        false,
        "zh",
      ),
    ).toEqual([
      { kind: "word", text: "maison", lang: "fr" },
      { kind: "meaning", text: "house", lang: "en" },
      { kind: "example", text: "Ma maison est grande.", lang: "fr" },
    ]);
  });

  test("a missing example or meaning is left out", () => {
    expect(sayParts({ term: "ich", back: "I (pronoun)" }, "de", false, "en")).toEqual([
      { kind: "word", text: "ich", lang: "de" },
      { kind: "meaning", text: "I", lang: "en" },
    ]);
    expect(sayParts({ term: "ich", back: "", ex: "Ich bin." }, "de", false, "en")).toEqual([
      { kind: "word", text: "ich", lang: "de" },
      { kind: "example", text: "Ich bin.", lang: "de" },
    ]);
  });

  test("readingOnBack: the kana reading is the word; the meaning still follows", () => {
    expect(
      sayParts(
        { term: "外", reading: "そと; ほか", back: "outside, exterior; other", ex: "外は寒い。" },
        "ja",
        true,
        "ja",
      ).map((p) => [p.kind, p.text, p.lang]),
    ).toEqual([
      ["word", "そと", "ja"],
      ["meaning", "outside", "en"],
      ["example", "外は寒い。", "ja"],
    ]);
  });

  test("a meaning that is the word itself is not said twice", () => {
    expect(sayParts({ term: "/u/", back: "ou" }, "fr", false, "en")).toEqual([
      { kind: "word", text: "ou", lang: "fr" },
    ]);
  });

  test("meaningText keeps the first sense, without notes", () => {
    expect(meaningText("to be (copula); to exist")).toBe("to be");
    expect(meaningText("（書）本、書籍")).toBe("本");
    expect(meaningText("")).toBe("");
  });

  test("meaningLang reads the script; the UI settles Han", () => {
    expect(meaningLang("house", "zh")).toBe("en");
    expect(meaningLang("房子", "zh")).toBe("zh");
    expect(meaningLang("家", "ja-JP")).toBe("ja");
    expect(meaningLang("いえ", "en")).toBe("ja");
    expect(meaningLang("집", "en")).toBe("ko");
    expect(meaningLang("дом", "en")).toBe("ru");
  });

  test("prefetch order: words, then examples, then meanings", () => {
    const rows = [
      sayParts({ term: "a", back: "x", ex: "a!" }, "fr", false, "en"),
      sayParts({ term: "b", back: "y", ex: "b!" }, "fr", false, "en"),
    ];
    expect(prefetchOrder(rows).map((p) => p.text)).toEqual(["a", "b", "a!", "b!", "x", "y"]);
  });
});

/** A sequencer on fake timers; `say` records each part and holds its `done`. */
function rig() {
  const said: string[] = [];
  const pending: ((played: boolean) => void)[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let cancels = 0;
  const seq = createSequencer<string>({
    say: (p, done) => {
      said.push(p);
      pending.push(done);
    },
    cancel: () => void cancels++,
    setTimeout: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      const i = timers.indexOf(t as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const tick = () => {
    const t = timers.shift()!;
    t.fn();
    return t.ms;
  };
  return { seq, said, pending, timers, tick, cancels: () => cancels };
}

describe("sequencer", () => {
  test("plays the parts in order, 150 ms apart, once", () => {
    const r = rig();
    r.seq.play(["word", "meaning", "example"]);
    expect(r.said).toEqual(["word"]);
    r.pending[0](true);
    expect(r.tick()).toBe(150);
    r.pending[1](false); // no voice for the meaning: the example still comes
    expect(r.tick()).toBe(150);
    expect(r.said).toEqual(["word", "meaning", "example"]);
    r.pending[2](true);
    expect(r.timers).toHaveLength(0);
  });

  test("another tap interrupts: the old word's late done does nothing", () => {
    const r = rig();
    r.seq.play(["a", "a-meaning"]);
    r.seq.play(["b", "b-meaning"]);
    expect(r.cancels()).toBe(2);
    r.pending[0](true); // "a" ended after the interrupt
    expect(r.timers).toHaveLength(0);
    r.pending[1](true);
    r.tick();
    expect(r.said).toEqual(["a", "b", "b-meaning"]);
  });

  test("stop clears the gap timer", () => {
    const r = rig();
    r.seq.play(["a", "b"]);
    r.pending[0](true);
    r.seq.stop();
    expect(r.timers).toHaveLength(0);
  });

  test("a loop starts over after a pause, and ends when nothing could play", () => {
    const r = rig();
    r.seq.play(["w", "e"], { loop: true, delayMs: 250 });
    expect(r.tick()).toBe(250);
    r.pending[0](true);
    r.tick();
    r.pending[1](true);
    r.pending[1](true); // a second done is ignored
    expect(r.tick()).toBe(1200);
    expect(r.said).toEqual(["w", "e", "w"]);
    r.pending[2](false);
    r.tick();
    r.pending[3](false);
    expect(r.timers).toHaveLength(0);
  });

  test("an empty list just stops", () => {
    const r = rig();
    r.seq.play([]);
    expect(r.said).toEqual([]);
    expect(r.cancels()).toBe(1);
  });
});
