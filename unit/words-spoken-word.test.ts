import { beforeEach, describe, expect, it } from "bun:test";
import {
  BOUNDARY_WAIT_MS,
  estimateSeconds,
  followAudio,
  followSpeech,
  learnPace,
  ownedBy,
  pauseAfter,
  resetPace,
  spokenIn,
  spokenWord,
  timeline,
  wordAt,
  wordAtChar,
  wordWeight,
  type AudioClock,
  type Spoken,
} from "@/lib/words/spoken-word";

const words = (text: string, lang: string) =>
  timeline(text, lang).map((s) => text.slice(s.start, s.end));

describe("timeline", () => {
  it("cuts a spaced sentence into its words, punctuation left out", () => {
    expect(words("Le chat dort, puis mange.", "fr")).toEqual([
      "Le",
      "chat",
      "dort",
      "puis",
      "mange",
    ]);
  });

  it("cuts a sentence without spaces at the segmenter's words", () => {
    const w = words("私は学生です。", "ja");
    expect(w.length).toBeGreaterThan(1);
    expect(w.join("")).toBe("私は学生です");
  });

  it("covers the whole audio, in order, with no overlap", () => {
    const s = timeline("One two three, four five.", "en");
    expect(s[0].t0).toBe(0);
    expect(s.at(-1)!.t1).toBeCloseTo(1, 10);
    for (let i = 1; i < s.length; i++) expect(s[i].t0).toBeGreaterThanOrEqual(s[i - 1].t1);
  });

  it("gives a longer word a longer share", () => {
    const s = timeline("a extraordinarily b", "en");
    const len = (i: number) => s[i].t1 - s[i].t0;
    expect(len(1)).toBeGreaterThan(len(0) * 10);
    expect(len(0)).toBeCloseTo(len(2), 10);
  });

  it("leaves a gap for the pause at a comma, a bigger one at a full stop", () => {
    const s = timeline("aa bb, cc. dd ee", "en");
    const gap = (i: number) => s[i + 1].t0 - s[i].t1;
    expect(gap(0)).toBe(0);
    expect(gap(1)).toBeGreaterThan(0);
    expect(gap(2)).toBeGreaterThan(gap(1));
    expect(gap(3)).toBe(0);
  });

  it("weighs a syllabic script's characters as syllables", () => {
    expect(wordWeight("学生")).toBeGreaterThan(wordWeight("ab"));
    expect(wordWeight("é")).toBe(1);
  });

  it("knows sentence ends and commas in any script", () => {
    expect(pauseAfter("。")).toBeGreaterThan(pauseAfter("、"));
    expect(pauseAfter("、")).toBeGreaterThan(0);
    expect(pauseAfter("? ")).toBeGreaterThan(pauseAfter(", "));
    expect(pauseAfter(" ")).toBe(0);
  });
});

describe("wordAt", () => {
  const s = timeline("aa bb, cc", "en");
  it("picks the word at each moment, the last begun through a pause", () => {
    expect(wordAt(s, 0)).toBe(0);
    expect(wordAt(s, (s[1].t0 + s[1].t1) / 2)).toBe(1);
    // Inside the comma's pause: still "bb".
    expect(wordAt(s, (s[1].t1 + s[2].t0) / 2)).toBe(1);
    expect(wordAt(s, 1)).toBe(2);
  });
  it("says none for no words or a bad time", () => {
    expect(wordAt([], 0.5)).toBe(-1);
    expect(wordAt(s, Number.NaN)).toBe(-1);
  });
});

describe("wordAtChar", () => {
  const text = "Le chat dort.";
  const s = timeline(text, "fr");
  it("maps a boundary's charIndex onto its word", () => {
    expect(wordAtChar(s, 0)).toBe(0);
    expect(wordAtChar(s, 3)).toBe(1);
    expect(wordAtChar(s, 5)).toBe(1);
  });
  it("takes the space before a word as that word", () => {
    expect(wordAtChar(s, 2)).toBe(1);
  });
  it("says none past the last word", () => {
    expect(wordAtChar(s, text.length)).toBe(-1);
  });
});

describe("spokenWord store", () => {
  it("tells its listeners of a change, once per change", () => {
    let calls = 0;
    const off = spokenWord.subscribe(() => calls++);
    spokenWord.set({ text: "aa bb", lang: "en", span: [0, 2] });
    spokenWord.set({ text: "aa bb", lang: "en", span: [0, 2] });
    expect(calls).toBe(1);
    spokenWord.set({ text: "aa bb", lang: "en", span: [3, 5] });
    expect(spokenWord.get()!.span).toEqual([3, 5]);
    spokenWord.set(null);
    spokenWord.set(null);
    expect(calls).toBe(3);
    off();
    spokenWord.set({ text: "x", lang: "en", span: [0, 1] });
    expect(calls).toBe(3);
    spokenWord.set(null);
  });
});

describe("a language tag the segmenter refuses", () => {
  it("still cuts the words", () => {
    expect(words("aa bb", "!!")).toEqual(["aa", "bb"]);
  });
});

describe("spokenIn", () => {
  it("places the span in the shown text, padding and all", () => {
    const sp: Spoken = { text: "Le chat", lang: "fr", span: [3, 7] };
    expect(spokenIn(sp, " Le chat")).toEqual([4, 8]);
    expect(spokenIn(sp, "Le chien")).toBeNull();
    expect(spokenIn(sp, "Le chat dort")).toBeNull();
    expect(spokenIn(null, "x")).toBeNull();
  });

  it("two cards sharing one sentence: only the reading's own card gets the span", () => {
    const sp: Spoken = { text: "Le chat dort", lang: "fr", span: [3, 7], owner: "list\u0000chat" };
    expect(spokenIn(sp, "Le chat dort", "list\u0000chat")).toEqual([3, 7]);
    expect(spokenIn(sp, "Le chat dort", "list\u0000dort")).toBeNull();
    expect(spokenIn(sp, "Le chat dort")).toBeNull();
  });

  it("ownedBy stamps each mark with the owner card; a clear stays a clear", () => {
    const out = ownedBy("a");
    out({ text: "aa bb", lang: "en", span: [0, 2] });
    expect(spokenWord.get()).toEqual({ text: "aa bb", lang: "en", span: [0, 2], owner: "a" });
    expect(spokenIn(spokenWord.get(), "aa bb", "a")).toEqual([0, 2]);
    expect(spokenIn(spokenWord.get(), "aa bb", "b")).toBeNull();
    // The same word on another card is a change: listeners hear it.
    let calls = 0;
    const off = spokenWord.subscribe(() => calls++);
    ownedBy("b")({ text: "aa bb", lang: "en", span: [0, 2] });
    expect(calls).toBe(1);
    out(null);
    expect(spokenWord.get()).toBeNull();
    off();
  });
});

/** A fake animation-frame clock: frames run only when the test says so. */
function fakeFrames() {
  let next = 1;
  const q = new Map<number, () => void>();
  return {
    request: (fn: () => void) => (q.set(next, fn), next++),
    cancel: (h: unknown) => void q.delete(h as number),
    flush() {
      const fns = [...q.values()];
      q.clear();
      for (const f of fns) f();
    },
    get pending() {
      return q.size;
    },
  };
}

function fakeAudio(duration: number) {
  const ls = new Map<string, Set<() => void>>();
  const el = {
    currentTime: 0,
    duration,
    paused: true,
    addEventListener: (t: string, f: () => void) => {
      if (!ls.has(t)) ls.set(t, new Set());
      ls.get(t)!.add(f);
    },
    removeEventListener: (t: string, f: () => void) => void ls.get(t)?.delete(f),
    fire(t: string) {
      for (const f of ls.get(t) ?? []) f();
    },
    count: () => [...ls.values()].reduce((a, s) => a + s.size, 0),
  };
  return el satisfies AudioClock;
}

describe("followAudio", () => {
  beforeEach(resetPace);

  it("lights each word as the clip's clock passes it, and clears on the end", () => {
    const text = "aa bb cc";
    const el = fakeAudio(3);
    const fr = fakeFrames();
    const seen: Spoken[] = [];
    followAudio(el, text, "en", fr, (s) => seen.push(s));
    expect(fr.pending).toBe(0);
    el.paused = false;
    el.fire("playing");
    fr.flush();
    expect(seen.at(-1)!.span).toEqual([0, 2]);
    el.currentTime = 1.5;
    fr.flush();
    expect(seen.at(-1)!.span).toEqual([3, 5]);
    el.currentTime = 2.9;
    fr.flush();
    expect(seen.at(-1)!.span).toEqual([6, 8]);
    el.paused = true;
    el.fire("ended");
    expect(seen.at(-1)).toBeNull();
    expect(fr.pending).toBe(0);
  });

  it("estimates a clip of unknown length, and stops the loop on pause", () => {
    const el = fakeAudio(Number.POSITIVE_INFINITY);
    const fr = fakeFrames();
    const seen: Spoken[] = [];
    followAudio(el, "aa bb", "en", fr, (s) => seen.push(s));
    el.paused = false;
    el.fire("playing");
    fr.flush();
    expect(seen.at(-1)!.span).toEqual([0, 2]);
    el.currentTime = 1e6;
    fr.flush();
    expect(seen.at(-1)!.span).toEqual([3, 5]);
    el.paused = true;
    el.fire("pause");
    expect(fr.pending).toBe(0);
    expect(seen.at(-1)).toBeNull();
  });

  it("the stop clears the mark and unhooks the clip", () => {
    const el = fakeAudio(2);
    el.paused = false;
    const fr = fakeFrames();
    const seen: Spoken[] = [];
    const stop = followAudio(el, "aa bb", "en", fr, (s) => seen.push(s));
    fr.flush();
    expect(seen.at(-1)).not.toBeNull();
    stop();
    expect(seen.at(-1)).toBeNull();
    expect(el.count()).toBe(0);
    expect(fr.pending).toBe(0);
  });

  it("teaches the language's pace from the clip's real duration", () => {
    const before = estimateSeconds("aa bb", "xx");
    const el = fakeAudio(before * 4);
    el.paused = false;
    const fr = fakeFrames();
    followAudio(el, "aa bb", "xx", fr, () => {});
    fr.flush();
    expect(estimateSeconds("aa bb", "xx")).toBeCloseTo(before * 4, 6);
  });
});

describe("followSpeech", () => {
  beforeEach(resetPace);

  function rig(text: string) {
    let now = 0;
    const timers = new Map<number, () => void>();
    let id = 1;
    const fr = fakeFrames();
    const seen: Spoken[] = [];
    const f = followSpeech(
      text,
      "en",
      1,
      {
        now: () => now,
        frames: fr,
        setTimer: (fn) => (timers.set(id, fn), id++),
        clearTimer: (t) => void timers.delete(t as number),
      },
      (s) => seen.push(s),
    );
    return {
      f,
      fr,
      seen,
      timers,
      at(ms: number) {
        now = ms;
      },
      fireTimers() {
        const fns = [...timers.values()];
        timers.clear();
        fns.forEach((fn) => fn());
      },
    };
  }

  it("follows boundary events exactly, with no estimate loop", () => {
    const r = rig("Le chat dort.");
    r.f.start();
    r.f.boundary(0, "word");
    expect(r.seen.at(-1)!.span).toEqual([0, 2]);
    r.f.boundary(3, "word");
    expect(r.seen.at(-1)!.span).toEqual([3, 7]);
    r.f.boundary(0, "sentence");
    expect(r.seen.at(-1)!.span).toEqual([3, 7]);
    r.fireTimers();
    expect(r.fr.pending).toBe(0);
    r.f.end(true);
    expect(r.seen.at(-1)).toBeNull();
  });

  it("estimates when no boundary arrives shortly after the start", () => {
    const text = "aa bb cc";
    const total = estimateSeconds(text, "en") * 1000;
    const r = rig(text);
    r.f.start();
    expect(r.timers.size).toBe(1);
    r.at(BOUNDARY_WAIT_MS);
    r.fireTimers();
    r.at(total * 0.1);
    r.fr.flush();
    expect(r.seen.at(-1)!.span).toEqual([0, 2]);
    r.at(total * 0.5);
    r.fr.flush();
    expect(r.seen.at(-1)!.span).toEqual([3, 5]);
    // Running long: held on the last word.
    r.at(total * 3);
    r.fr.flush();
    expect(r.seen.at(-1)!.span).toEqual([6, 8]);
    r.f.end(true);
    expect(r.seen.at(-1)).toBeNull();
    expect(r.fr.pending).toBe(0);
    // It ran three times the estimate: the next estimate is longer.
    expect(estimateSeconds(text, "en") * 1000).toBeGreaterThan(total);
  });

  it("a late boundary takes over from the estimate", () => {
    const r = rig("aa bb cc");
    r.f.start();
    r.fireTimers();
    r.fr.flush();
    r.f.boundary(6, "word");
    expect(r.seen.at(-1)!.span).toEqual([6, 8]);
    expect(r.fr.pending).toBe(0);
  });

  it("a stop before the end teaches nothing and clears the mark", () => {
    learnPace("en", 10, 1);
    const before = estimateSeconds("aa", "en");
    const r = rig("aa bb");
    r.f.start();
    r.at(99_999);
    r.f.end(false);
    expect(r.seen.at(-1)).toBeNull();
    expect(estimateSeconds("aa", "en")).toBe(before);
  });
});
