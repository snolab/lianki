import { describe, expect, it } from "bun:test";
import {
  FOLLOW_ATTR,
  registerFollower,
  spokenFollower,
  spokenMoved,
  type Follower,
} from "@/lib/words/spoken-scroll";
import { followAudio, timeline, type AudioClock, type Spoken } from "@/lib/words/spoken-word";

/** A fake animation-frame clock: frames run only when the test says so (as in words-spoken-word.test.ts). */
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
  };
  return el satisfies AudioClock;
}

const LH = 20;
/** Where each word sits in the content, unscrolled: px from the content's top-left. */
type At = { x: number; y: number; w: number };

/**
 * A clipping cell `w` × `h` at the viewport's origin, its content laid out at
 * `at` (one per word), scrolled by scrollTop / scrollLeft (instantly; every
 * scroll asked for is recorded).
 */
function fakeCell(at: At[], w: number, h: number, opts: { wrap: boolean; home?: number }) {
  const ls = new Map<string, Set<() => void>>();
  const scrolls: ScrollToOptions[] = [];
  const states: boolean[] = [];
  const width = Math.max(...at.map((a) => a.x + a.w));
  const height = Math.max(...at.map((a) => a.y + LH));
  const rect = (x: number, y: number, rw: number, rh: number) => ({
    top: y,
    bottom: y + rh,
    left: x,
    right: x + rw,
    width: rw,
    height: rh,
  });
  const box = {
    scrollTop: 0,
    scrollLeft: 0,
    clientWidth: w,
    scrollWidth: Math.max(w, width),
    getBoundingClientRect: () => rect(0, 0, w, h),
    getClientRects: () => [rect(0, 0, w, h)],
    scrollTo(o: ScrollToOptions) {
      scrolls.push(o);
      if (o.top !== undefined) box.scrollTop = o.top;
      if (o.left !== undefined) box.scrollLeft = o.left;
    },
    addEventListener: (t: string, f: () => void) => {
      if (!ls.has(t)) ls.set(t, new Set());
      ls.get(t)!.add(f);
    },
    removeEventListener: (t: string, f: () => void) => void ls.get(t)?.delete(f),
    fire(t: string) {
      for (const f of ls.get(t) ?? []) f();
    },
    listeners: () => [...ls.values()].reduce((a, s) => a + s.size, 0),
  };
  const inner = {
    scrollHeight: height,
    getBoundingClientRect: () =>
      rect(-box.scrollLeft, -box.scrollTop, Math.max(w, width), Math.max(h, height)),
    getClientRects: () => [inner.getBoundingClientRect()],
  };
  const word = (i: number) => {
    const a = at[i];
    const r = () => rect(a.x - box.scrollLeft, a.y - box.scrollTop, a.w, LH);
    return {
      getBoundingClientRect: r,
      getClientRects: () => [r()],
      closest: (sel: string) => (sel === `[${FOLLOW_ATTR}]` ? box : null),
    };
  };
  const f = spokenFollower(box, {
    inner: () => inner,
    wrap: opts.wrap,
    lines: Math.round(h / LH),
    lh: () => LH,
    rtl: () => false,
    smooth: () => true,
    home: () => opts.home ?? 0,
    following: (on) => void states.push(on),
  });
  registerFollower(box, f);
  // Where #528 left it: at the card word.
  if (opts.wrap) box.scrollTop = opts.home ?? 0;
  else box.scrollLeft = opts.home ?? 0;
  return { box, word, f, scrolls, states };
}

/**
 * Read `text` aloud on a fake clip and clock, its lit word shown in `cell`:
 * each move goes to spokenMoved, as MarkedExample tells it after painting.
 */
function readAloud(text: string, cell: ReturnType<typeof fakeCell>) {
  const slots = timeline(text, "en");
  const el = fakeAudio(slots.length);
  const fr = fakeFrames();
  let prev: Follower | null = null;
  let lit = -1;
  const out = (s: Spoken) => {
    const i = s ? slots.findIndex((x) => x.start === s.span[0]) : -1;
    if (i === lit) return;
    lit = i;
    prev = spokenMoved(i < 0 ? null : cell.word(i), prev);
  };
  followAudio(el, text, "en", fr, out);
  return {
    slots,
    /** Play on until word `i` is lit. */
    to(i: number) {
      if (el.paused) {
        el.paused = false;
        el.fire("playing");
      }
      el.currentTime = ((slots[i].t0 + slots[i].t1) / 2) * el.duration;
      fr.flush();
      expect(lit).toBe(i);
    },
    end() {
      el.paused = true;
      el.fire("ended");
    },
    pause() {
      el.paused = true;
      el.fire("pause");
    },
  };
}

// Twelve words, two to a line, in a cell two lines tall.
const TEXT = "aa bb cc dd ee ff gg hh ii jj kk ll";
const twoPerLine = (n: number): At[] =>
  Array.from({ length: n }, (_, i) => ({ x: (i % 2) * 50, y: Math.floor(i / 2) * LH, w: 40 }));

describe("a wrapped example follows the word read aloud", () => {
  it("scrolls only when the lit word would leave the view, by whole lines", () => {
    const cell = fakeCell(twoPerLine(12), 100, 2 * LH, { wrap: true });
    const r = readAloud(TEXT, cell);
    for (let i = 0; i < 4; i++) r.to(i);
    expect(cell.scrolls).toEqual([]);
    expect(cell.states).toEqual([true]);
    r.to(4); // line 3: out of view
    expect(cell.scrolls).toEqual([{ top: 2 * LH, behavior: "smooth" }]);
    for (let i = 5; i < 8; i++) r.to(i); // lines 3 and 4 now in view: no re-centring per word
    expect(cell.scrolls.length).toBe(1);
    r.to(8);
    expect(cell.scrolls.at(-1)).toEqual({ top: 4 * LH, behavior: "smooth" });
    expect(cell.scrolls.length).toBe(2);
  });

  it("goes back to the card word's place when the reading ends", () => {
    const cell = fakeCell(twoPerLine(12), 100, 2 * LH, { wrap: true, home: LH * 2 });
    const r = readAloud(TEXT, cell);
    r.to(0); // on the first line, scrolled out of view: up to it
    expect(cell.scrolls).toEqual([{ top: 0, behavior: "smooth" }]);
    r.to(9);
    expect(cell.scrolls.at(-1)).toEqual({ top: 4 * LH, behavior: "smooth" });
    r.end();
    expect(cell.scrolls.at(-1)).toEqual({ top: 2 * LH, behavior: "smooth" });
    expect(cell.states).toEqual([true, false]);
    expect(cell.box.listeners()).toBe(0);
  });

  it("goes back on a pause too", () => {
    const cell = fakeCell(twoPerLine(12), 100, 2 * LH, { wrap: true });
    const r = readAloud(TEXT, cell);
    r.to(6);
    r.pause();
    expect(cell.scrolls.at(-1)).toEqual({ top: 0, behavior: "smooth" });
    expect(cell.f.on).toBe(false);
  });

  it("holds while the person scrolls it by touch, until the reading ends", () => {
    const cell = fakeCell(twoPerLine(12), 100, 2 * LH, { wrap: true });
    const r = readAloud(TEXT, cell);
    r.to(1);
    cell.box.fire("touchmove");
    expect(cell.f.held).toBe(true);
    r.to(6);
    r.to(10);
    expect(cell.scrolls).toEqual([]);
    r.end();
    expect(cell.scrolls).toEqual([{ top: 0, behavior: "smooth" }]);
    expect(cell.f.held).toBe(false);
    // The next reading follows again.
    const again = readAloud(TEXT, cell);
    again.to(6);
    expect(cell.scrolls.at(-1)).toEqual({ top: 3 * LH, behavior: "smooth" });
  });
});

describe("a one-line example", () => {
  // Words 40 px wide every 50 px, in a cell 120 px wide.
  const oneLine = (n: number): At[] =>
    Array.from({ length: n }, (_, i) => ({ x: i * 50, y: 0, w: 40 }));
  it("centres the lit word when it would leave the view, not on every word", () => {
    const cell = fakeCell(oneLine(12), 120, LH, { wrap: false });
    const r = readAloud(TEXT, cell);
    r.to(0);
    r.to(1);
    expect(cell.scrolls).toEqual([]);
    r.to(2); // 100..140: past the right edge → its centre (120) to the middle (60)
    expect(cell.scrolls).toEqual([{ left: 60, behavior: "smooth" }]);
    r.to(3); // 150..190, view 60..180: still cut → centred again
    expect(cell.scrolls.length).toBe(2);
    expect(cell.scrolls.at(-1)).toEqual({ left: 110, behavior: "smooth" });
    r.end();
    expect(cell.scrolls.at(-1)).toEqual({ left: 0, behavior: "smooth" });
  });
});

describe("spokenMoved", () => {
  it("ends the cell before when the lit word moves to another", () => {
    const a = fakeCell(twoPerLine(4), 100, 2 * LH, { wrap: true });
    const b = fakeCell(twoPerLine(4), 100, 2 * LH, { wrap: true });
    let prev = spokenMoved(a.word(0), null);
    expect(prev).toBe(a.f);
    prev = spokenMoved(b.word(0), prev);
    expect(a.states).toEqual([true, false]);
    expect(prev).toBe(b.f);
    expect(spokenMoved(null, prev)).toBe(null);
    expect(b.states).toEqual([true, false]);
  });

  it("does nothing for a word outside any following cell", () => {
    const el = { ...fakeCell(twoPerLine(2), 100, LH, { wrap: true }).word(0), closest: () => null };
    expect(spokenMoved(el, null)).toBe(null);
  });
});
