import { describe, expect, it } from "bun:test";
import {
  DWELL_FACTOR,
  DWELL_MIN_MS,
  READ_RATE_CJK,
  READ_RATE_LATIN,
  FADE_MS,
  MINIMIZE_FLOAT_MAX_AGE_MS,
  createDwellTimer,
  createFloatLife,
  dwellMs,
  minimizeFloat,
  readTime,
} from "@lianki/debug-chat/float-lines";

/** Fake clock and timers: `advance(ms)` runs what falls due. */
function clock() {
  let now = 0;
  let timers: { at: number; f: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    setTimer: (f: () => void, ms: number) => {
      const t = { at: now + ms, f, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t: unknown) => {
      (t as { live: boolean }).live = false;
    },
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.live && t.at <= now);
      timers = timers.filter((t) => !due.includes(t));
      for (const t of due) {
        t.live = false;
        t.f();
      }
    },
  };
}

describe("dwell", () => {
  it("reads CJK at 6 characters a second", () => {
    expect(readTime("今日は良い天気ですね")).toBeCloseTo(10 / READ_RATE_CJK);
    expect(readTime("안녕하세요")).toBeCloseTo(5 / READ_RATE_CJK);
    // 60 kana/kanji = 10 s to read, twice = 20 s.
    expect(dwellMs("あ".repeat(60))).toBe((60_000 / READ_RATE_CJK) * DWELL_FACTOR);
  });

  it("reads other text at 15 characters a second", () => {
    const text = "x".repeat(150);
    expect(readTime(text)).toBeCloseTo(10);
    expect(dwellMs(text)).toBe((150 / READ_RATE_LATIN) * 1000 * DWELL_FACTOR);
  });

  it("counts mixed text by script", () => {
    // 6 CJK (1 s) + 15 others (1 s), including the spaces.
    const text = "漢字かなカナ and some more!";
    expect([...text].length).toBe(6 + 15);
    expect(readTime(text)).toBeCloseTo(2);
    expect(dwellMs(text)).toBe(4_000);
  });

  it("never goes under the minimum", () => {
    expect(dwellMs("")).toBe(DWELL_MIN_MS);
    expect(dwellMs("ok")).toBe(DWELL_MIN_MS);
    expect(dwellMs("はい")).toBe(DWELL_MIN_MS);
  });
});

describe("createDwellTimer", () => {
  it("fires once its time is up", () => {
    const c = clock();
    let done = 0;
    createDwellTimer({ ms: 1000, onDone: () => done++, ...c });
    c.advance(999);
    expect(done).toBe(0);
    c.advance(1);
    expect(done).toBe(1);
  });

  it("pauses, and resumes with the time that was left", () => {
    const c = clock();
    let done = 0;
    const t = createDwellTimer({ ms: 1000, onDone: () => done++, ...c });
    c.advance(400);
    t.pause();
    expect(t.remaining()).toBe(600);
    c.advance(5000); // held: nothing fires
    expect(done).toBe(0);
    expect(t.remaining()).toBe(600);
    t.resume();
    c.advance(599);
    expect(done).toBe(0);
    c.advance(1);
    expect(done).toBe(1);
  });

  it("ignores a double pause or resume, and cancel stops it for good", () => {
    const c = clock();
    let done = 0;
    const t = createDwellTimer({ ms: 1000, onDone: () => done++, ...c });
    t.resume(); // already running: no second timer
    c.advance(300);
    t.pause();
    t.pause();
    c.advance(300);
    t.resume();
    c.advance(700);
    expect(done).toBe(1);
    const u = createDwellTimer({ ms: 1000, onDone: () => done++, ...c });
    u.cancel();
    u.resume();
    c.advance(5000);
    expect(done).toBe(1);
  });

  it("restarts with a full dwell when made again (a scrub step or its release)", () => {
    const c = clock();
    let done = 0;
    let t = createDwellTimer({ ms: 1000, onDone: () => done++, ...c });
    c.advance(900);
    t.cancel(); // the chat's FloatLine does this when the epoch moves...
    t = createDwellTimer({ ms: 1000, onDone: () => done++, ...c }); // ...and starts over
    c.advance(900);
    expect(done).toBe(0);
    c.advance(100);
    expect(done).toBe(1);
  });
});

describe("createDwellTimer with the real clock", () => {
  it("pauses and fires on real timers", async () => {
    let done = 0;
    const t = createDwellTimer({ ms: 20, onDone: () => done++ });
    t.pause();
    expect(t.remaining()).toBeGreaterThan(0);
    t.resume();
    expect(t.remaining()).toBeLessThanOrEqual(20);
    await new Promise((r) => setTimeout(r, 60));
    expect(done).toBe(1);
    const u = createDwellTimer({ ms: 20, onDone: () => done++ });
    u.cancel();
    await new Promise((r) => setTimeout(r, 40));
    expect(done).toBe(1);
  });
});

describe("minimizeFloat (the latest message, on minimize)", () => {
  const msg = (id: string, at: number) => ({ id, at, text: "Deployed; the bar is one container." });

  it("floats only the single latest message, unless it is over 10 minutes old", () => {
    const list = [msg("a", 0), msg("b", 1_000)];
    expect(minimizeFloat(list, 60_000)?.id).toBe("b");
    expect(minimizeFloat(list, 1_000 + MINIMIZE_FLOAT_MAX_AGE_MS)?.id).toBe("b");
    expect(minimizeFloat(list, 1_001 + MINIMIZE_FLOAT_MAX_AGE_MS)).toBeNull();
    expect(minimizeFloat([], 0)).toBeNull();
  });

  it("starts the dwell at the minimize, not at the arrival", () => {
    const c = clock();
    const m = msg("a", 0);
    c.advance(5 * 60_000); // the message arrived 5 minutes before the minimize
    const minimizedAt = c.now();
    const latest = minimizeFloat([m], minimizedAt);
    expect(latest).not.toBeNull();
    let gone = 0;
    createDwellTimer({ ms: dwellMs(latest!.text), onDone: () => gone++, ...c });
    // Fully visible for its whole dwell, counted from the minimize...
    c.advance(dwellMs(m.text) - 1);
    expect(gone).toBe(0);
    // ...then it fades.
    c.advance(1);
    expect(gone).toBe(1);
    expect(c.now() - minimizedAt).toBe(dwellMs(m.text));
  });
});

describe("createFloatLife (dwell, then the slow fade)", () => {
  const life = (o: { reducedMotion?: boolean; paused?: boolean } = {}) => {
    const c = clock();
    const seen: string[] = [];
    const l = createFloatLife({ ms: 3000, onPhase: (p) => seen.push(p), ...o, ...c });
    return { c, seen, l };
  };

  it("fades over FADE_MS (10 s) once the dwell is over, then goes", () => {
    expect(FADE_MS).toBe(10_000);
    const { c, seen, l } = life();
    c.advance(2999);
    expect(l.phase()).toBe("dwell");
    c.advance(1);
    expect(seen).toEqual(["fade"]);
    c.advance(FADE_MS - 1);
    expect(l.phase()).toBe("fade");
    c.advance(1);
    expect(seen).toEqual(["fade", "gone"]);
  });

  it("touched mid-fade: back to full (held), and the fade starts over on release", () => {
    const { c, seen, l } = life();
    c.advance(3000 + 6000); // 6 s into the fade
    l.pause();
    expect(l.phase()).toBe("held");
    c.advance(60_000); // held as long as it is touched
    expect(l.phase()).toBe("held");
    l.resume();
    expect(l.phase()).toBe("fade");
    c.advance(FADE_MS - 1); // a whole fade again, from full
    expect(l.phase()).toBe("fade");
    c.advance(1);
    expect(seen).toEqual(["fade", "held", "fade", "gone"]);
  });

  it("touched during the dwell: the time left is kept", () => {
    const { c, l } = life({ paused: true });
    c.advance(10_000);
    expect(l.phase()).toBe("dwell");
    l.resume();
    c.advance(2000);
    l.pause();
    c.advance(10_000);
    l.resume();
    c.advance(999);
    expect(l.phase()).toBe("dwell");
    c.advance(1);
    expect(l.phase()).toBe("fade");
  });

  it("reduced motion: gone the moment the dwell ends", () => {
    const { c, seen } = life({ reducedMotion: true });
    c.advance(3000);
    expect(seen).toEqual(["gone"]);
  });

  it("cancel stops it in either phase", () => {
    const a = life();
    a.l.cancel();
    a.c.advance(60_000);
    expect(a.seen).toEqual([]);
    const b = life();
    b.c.advance(3000);
    b.l.cancel();
    b.c.advance(60_000);
    expect(b.seen).toEqual(["fade"]);
  });

  it("runs on the real timers too", async () => {
    const seen: string[] = [];
    createFloatLife({ ms: 5, fadeMs: 5, onPhase: (p) => seen.push(p) });
    await new Promise((r) => setTimeout(r, 60));
    expect(seen).toEqual(["fade", "gone"]);
  });
});
