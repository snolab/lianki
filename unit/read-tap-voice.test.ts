// What a combo click says (owner 2026-11-03 22:12 / 22:13 JST): each level
// its own unit, chapter and book nothing; the first click at once, the
// combo's further clicks after the double-click interval; playback paused.
import { describe, expect, it } from "bun:test";
import {
  COMBO_MS,
  type Combo,
  type ComboCtx,
  type Hit,
  comboClick,
  comboContinues,
  tapVoice,
} from "@/lib/read/reader-select";

const ctx: ComboCtx = {
  interval: COMBO_MS,
  phraseAt: () => null,
  chapterAt: (line) => (line < 10 ? 0 : 1),
  chapterRange: (n) => (n === 0 ? [0, 10] : n === 1 ? [10, 20] : null),
};
const hit: Hit = { line: 3, s: 1, t: 4 };

/** Clicks at the given times: the voice decision of each. */
function run(times: number[], playing = false, h: Hit = hit) {
  let prev: Combo | null = null;
  return times.map((at) => {
    const continued = comboContinues(prev, h, at, ctx);
    prev = comboClick(prev, h, at, ctx);
    return tapVoice(prev.unit, continued, playing);
  });
}

describe("tapVoice", () => {
  it("a tap on a word says that word alone, at once", () => {
    const [v] = run([1000]);
    expect(v).toEqual({ say: { kind: "word", line: 3, t: 4 }, wait: false, pause: false });
  });

  it("pauses a running playback, and only then", () => {
    expect(run([1000], true)[0].pause).toBe(true);
    expect(run([1000], false)[0].pause).toBe(false);
  });

  it("each level of the combo says its own unit, after the combo rests", () => {
    const v = run([1000, 1200, 1400]);
    expect(v.map((x) => x.say?.kind ?? null)).toEqual(["word", "sentence", "para"]);
    expect(v.map((x) => x.wait)).toEqual([false, true, true]);
  });

  it("chapter and book say nothing", () => {
    const v = run([1000, 1200, 1400, 1600, 1800]);
    expect(v.slice(3).map((x) => x.say)).toEqual([null, null]);
    expect(v.slice(3).every((x) => !x.pause)).toBe(true);
  });

  it("a pause longer than the interval starts again at the word, said at once", () => {
    const v = run([1000, 1000 + COMBO_MS + 1]);
    expect(v[1]).toEqual({ say: { kind: "word", line: 3, t: 4 }, wait: false, pause: false });
  });

  it("a tap between words says the sentence it hit", () => {
    const [v] = run([1000], false, { line: 3, s: 0, t: null });
    expect(v.say).toEqual({ kind: "sentence", line: 3, s: 0 });
  });
});
