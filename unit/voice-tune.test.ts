import { afterEach, describe, expect, it } from "bun:test";
import { VOICE_TUNE, createJoiner, isBlip, voiceTune } from "@lianki/debug-chat/voice-tune";

describe("isBlip", () => {
  it("drops one short Latin word, and 嗯 / 呃 alone", () => {
    for (const t of ["hmm", "Uh.", "the", "so,", "anyways", "嗯", "嗯嗯。", "呃…", "", "  ."])
      expect(isBlip(t)).toBe(true);
  });
  it("keeps the short answers, and anything longer", () => {
    for (const t of [
      "Yes.",
      "no",
      "OK",
      "okay!",
      "good",
      "Stop",
      "next",
      "thanks",
      "是",
      "不。",
      "行",
      "はい",
      "いいえ",
      "どうぞ",
      "important", // 9 letters
      "go on",
      "好的",
      "嗯，可以",
    ])
      expect(isBlip(t)).toBe(false);
  });
});

/** Timers driven by hand. */
function clock() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; f: () => void }>();
  return {
    setTimer: (f: () => void, ms: number) => {
      due.set(next, { at: now + ms, f });
      return next++;
    },
    clearTimer: (t: unknown) => void due.delete(t as number),
    advance(ms: number) {
      now += ms;
      for (const [id, x] of [...due]) if (x.at <= now) (due.delete(id), x.f());
    },
    pending: () => due.size,
  };
}

describe("createJoiner (hold a spoken line up to joinMs for more speech)", () => {
  const make = (joinMs = 2500) => {
    const c = clock();
    let sent = 0;
    const j = createJoiner({
      send: () => void sent++,
      joinMs: () => joinMs,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
    });
    return { j, c, sent: () => sent };
  };

  it("nothing more said: the line goes after joinMs", () => {
    const h = make();
    h.j.final();
    h.c.advance(2499);
    expect(h.sent()).toBe(0);
    h.c.advance(1);
    expect(h.sent()).toBe(1);
    expect(h.j.waiting()).toBe(false);
  });

  it("speech within the window: no send; the next final joins and starts the window again", () => {
    const h = make();
    h.j.final();
    h.c.advance(1200);
    h.j.speechStart();
    h.c.advance(5000); // talking: nothing goes
    expect(h.sent()).toBe(0);
    h.j.final(); // the second half: joined in the draft, held again
    h.c.advance(2500);
    expect(h.sent()).toBe(1);
  });

  it("speech that comes to nothing (a misfire, a blip): held again, then sent", () => {
    const h = make();
    h.j.final();
    h.j.speechStart();
    h.j.idle();
    h.c.advance(2500);
    expect(h.sent()).toBe(1);
    h.j.idle(); // nothing waiting: nothing happens
    h.j.speechStart();
    expect(h.c.pending()).toBe(0);
  });

  it("flush sends now; cancel forgets (sent another way); joinMs 0 sends at once", () => {
    const h = make();
    h.j.final();
    h.j.flush();
    expect(h.sent()).toBe(1);
    h.j.flush(); // nothing held
    expect(h.sent()).toBe(1);
    h.j.final();
    h.j.cancel();
    h.c.advance(5000);
    expect(h.sent()).toBe(1);
    const z = make(0);
    z.j.final();
    expect(z.sent()).toBe(1);
  });
});

describe("voiceTune", () => {
  afterEach(() => {
    delete (globalThis as { __lkVoiceTune?: unknown }).__lkVoiceTune;
  });
  it("the A/B's values, with the page's valid overrides only", () => {
    expect(voiceTune()).toEqual(VOICE_TUNE);
    expect(VOICE_TUNE).toMatchObject({ minSpeechMs: 250, preSpeechPadMs: 800, joinMs: 2500 });
    (globalThis as { __lkVoiceTune?: unknown }).__lkVoiceTune = {
      joinMs: 1500,
      minSpeechMs: -1,
      x: 1,
    };
    expect(voiceTune()).toEqual({ ...VOICE_TUNE, joinMs: 1500 });
    expect(voiceTune(null)).toEqual(VOICE_TUNE);
  });
});
