import { afterEach, describe, expect, it } from "bun:test";
import {
  AEC_CONSTRAINTS,
  MIC_SESSION_GLOBAL,
  RAW_CONSTRAINTS,
  VOICE_AEC_KEY,
  aecOn,
  applyAec,
  micAec,
  micConstraints,
  noteOpened,
  onOpened,
  openedAec,
} from "@lianki/debug-chat/aec";
import { MIC_SESSION_KEY } from "@lianki/debug-chat/mic-session";
import { captureHeld, createPageAudio, pageAudio } from "@lianki/debug-chat/page-audio";

function withStorage(store: Record<string, string>, f: () => void | Promise<void>) {
  const g = globalThis as Record<string, unknown>;
  const saved = g.localStorage;
  g.localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => void (store[k] = v),
    removeItem: (k: string) => void delete store[k],
  };
  const restore = () => {
    if (saved === undefined) delete g.localStorage;
    else g.localStorage = saved;
  };
  try {
    const r = f();
    if (r) return r.finally(restore);
  } catch (e) {
    restore();
    throw e;
  }
  restore();
}

describe("aec: the constraint selection", () => {
  it("on = all processing on; off = none at all (Android leaves call mode)", () => {
    expect(micConstraints(true)).toEqual({ ...AEC_CONSTRAINTS });
    expect(micConstraints(false)).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    });
    // Copies: a caller changing one never changes the next.
    expect(micConstraints(false)).not.toBe(RAW_CONSTRAINTS);
  });

  it("follows lk:voice-aec: on unless '0'", () => {
    const store: Record<string, string> = {};
    withStorage(store, () => {
      expect(aecOn()).toBe(true);
      expect(micConstraints().echoCancellation).toBe(true);
      store[VOICE_AEC_KEY] = "0";
      expect(aecOn()).toBe(false);
      expect(micConstraints().echoCancellation).toBe(false);
      expect(micConstraints().noiseSuppression).toBe(false);
      expect(micConstraints().autoGainControl).toBe(false);
    });
  });

  it("the mode in force is the open track's, else the switch's", () => {
    const store: Record<string, string> = { [VOICE_AEC_KEY]: "0" };
    withStorage(store, () => {
      let calls = 0;
      const off = onOpened(() => calls++);
      noteOpened(true);
      expect(openedAec()).toBe(true);
      // The switch says off, but the track was opened with AEC on: the hold goes by the track.
      expect(micAec()).toBe(true);
      noteOpened(true);
      expect(calls).toBe(1); // same mode again: nothing to work out
      noteOpened(false);
      expect(micAec()).toBe(false);
      expect(calls).toBe(2);
      off();
    });
  });

  it("the session key matches mic-session's", () => {
    expect(MIC_SESSION_GLOBAL).toBe(MIC_SESSION_KEY);
  });
});

describe("aec: applyAec", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[MIC_SESSION_GLOBAL];
  });

  it("mic off: writes the switch, applies at next open", async () => {
    const store: Record<string, string> = {};
    await withStorage(store, async () => {
      const g = {
        [MIC_SESSION_GLOBAL]: { view: () => ({ state: "off" }), reopen: async () => true },
      };
      expect(await applyAec(false, g)).toBe("next-open");
      expect(store[VOICE_AEC_KEY]).toBe("0");
      expect(await applyAec(true, {})).toBe("next-open");
      expect(store[VOICE_AEC_KEY]).toBeUndefined();
    });
  });

  it("mic on: reopens it so the change is heard at once", async () => {
    const store: Record<string, string> = {};
    await withStorage(store, async () => {
      let reopened = 0;
      let seen: boolean | null = null;
      const g = {
        [MIC_SESSION_GLOBAL]: {
          view: () => ({ state: "listening" }),
          reopen: async () => {
            reopened++;
            seen = aecOn(); // the new setting is written before the reopen
            return true;
          },
        },
      };
      expect(await applyAec(false, g)).toBe("reopened");
      expect(reopened).toBe(1);
      expect(seen as boolean | null).toBe(false);
      // An older session with no reopen, or one that fails: next open.
      expect(
        await applyAec(true, { [MIC_SESSION_GLOBAL]: { view: () => ({ state: "listening" }) } }),
      ).toBe("next-open");
      const failing = {
        [MIC_SESSION_GLOBAL]: {
          view: () => ({ state: "listening" }),
          reopen: async () => {
            throw new Error("denied");
          },
        },
      };
      expect(await applyAec(true, failing)).toBe("next-open");
    });
  });
});

describe("page audio: the half-duplex hold for word read-aloud", () => {
  function clock() {
    let t = 0;
    const timers = new Map<number, { at: number; f: () => void }>();
    let id = 0;
    return {
      setTimer: (f: () => void, ms: number) => {
        timers.set(++id, { at: t + ms, f });
        return id;
      },
      clearTimer: (h: unknown) => void timers.delete(h as number),
      advance(ms: number) {
        t += ms;
        for (const [k, v] of [...timers].sort((a, b) => a[1].at - b[1].at))
          if (v.at <= t && timers.has(k)) {
            timers.delete(k);
            v.f();
          }
      },
    };
  }

  it("holds while a sound plays and 400 ms after the last one ends", () => {
    const c = clock();
    const p = createPageAudio(c);
    const seen: boolean[] = [];
    p.subscribe((x) => seen.push(x));
    const a = p.start();
    expect(p.playing()).toBe(true);
    const b = p.start(); // the next part starts before the first one's end
    a();
    c.advance(1000);
    expect(p.playing()).toBe(true);
    b();
    b(); // twice is a no-op
    c.advance(399);
    expect(p.playing()).toBe(true);
    c.advance(1);
    expect(p.playing()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("a part starting within the tail keeps the hold; a lost end lets go after 30 s", () => {
    const c = clock();
    const p = createPageAudio(c);
    p.start()();
    c.advance(200);
    p.start(); // never ended
    c.advance(300);
    expect(p.playing()).toBe(true);
    c.advance(30_000); // its cap: the tail starts
    c.advance(400);
    expect(p.playing()).toBe(false);
  });

  it("real timers by default", async () => {
    const p = createPageAudio({ tailMs: 1 });
    p.start()();
    expect(p.playing()).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(p.playing()).toBe(false);
  });

  it("one registry per page", () => {
    expect(pageAudio()).toBe(pageAudio());
    expect(pageAudio().playing()).toBe(false);
  });

  it("captureHeld: the page's audio holds the mic only with echo cancellation off", () => {
    expect(captureHeld(false, true, true)).toBe(false);
    expect(captureHeld(false, true, false)).toBe(true);
    expect(captureHeld(false, false, false)).toBe(false);
    expect(captureHeld(true, false, false)).toBe(true);
  });
});
