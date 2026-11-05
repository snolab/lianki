// "Keep speaker awake" (packages/debug-chat/src/output-bed.ts) with a mocked
// AudioContext and a fake clock: nothing here makes a sound.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import {
  BED_DBFS,
  LINGER_MS,
  PREROLL_MS,
  createOutputBed,
  exitOutputBed,
  keepAwakeOn,
  setKeepAwake,
  KEEP_AWAKE_KEY,
  type BedCtx,
  type OutputBed,
} from "@lianki/debug-chat/output-bed";
import { createVoice, type UtterLike } from "@lianki/debug-chat/voice";
import { createSequencer } from "@/lib/words/sequence";
import { createReadSpeaker, type AudioLike } from "@/lib/read/speaker";
import { createPageAudio } from "@lianki/debug-chat/page-audio";

type Timer = { f: () => void; at: number };
function clock() {
  let t = 1_000_000;
  const timers = new Set<Timer>();
  return {
    now: () => t,
    setTimer: (f: () => void, ms: number) => {
      const x = { f, at: t + ms };
      timers.add(x);
      return x;
    },
    clearTimer: (x: unknown) => void timers.delete(x as Timer),
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = [...timers].filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due);
        t = Math.max(t, due.at);
        due.f();
      }
      t = end;
    },
  };
}

function fakeCtx(log: string[]) {
  const destination = { name: "destination" };
  const connected: unknown[] = [];
  let data = new Float32Array(0);
  const ctx = {
    state: "running",
    sampleRate: 100,
    destination,
    closed: false,
    resumes: 0,
    createBuffer: (_c: number, n: number) => {
      data = new Float32Array(n);
      return { getChannelData: () => data };
    },
    createBufferSource: () => ({
      buffer: null as unknown,
      loop: false,
      connect: (n: unknown) => connected.push(n),
      start: () => void log.push("bed start"),
      stop: () => void log.push("bed stop"),
      disconnect() {},
    }),
    resume: async () => void ctx.resumes++,
    close: async () => {
      ctx.closed = true;
      ctx.state = "closed";
      log.push("ctx close");
    },
    connected,
    samples: () => data,
  };
  return ctx;
}

function setup(o: { enabled?: boolean; hidden?: boolean } = {}) {
  const c = clock();
  const log: string[] = [];
  const ctxs: ReturnType<typeof fakeCtx>[] = [];
  const s = { enabled: o.enabled ?? true, mic: false, busy: false, hidden: o.hidden ?? false };
  const bed = createOutputBed({
    makeCtx: () => {
      const x = fakeCtx(log);
      ctxs.push(x);
      return x as unknown as BedCtx;
    },
    enabled: () => s.enabled,
    micOn: () => s.mic,
    busy: () => s.busy,
    hidden: () => s.hidden,
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
  });
  return { c, log, ctxs, s, bed };
}

describe("the bed starts only from a gesture", () => {
  it("no gesture: no context, and the line is not made to wait", () => {
    const { bed, ctxs } = setup();
    expect(bed.begin()).toBe(0);
    expect(ctxs.length).toBe(0);
    expect(bed.running()).toBe(false);
  });

  it("a line in a tap: one context, running, and the full pre-roll", () => {
    const { bed, ctxs, c } = setup();
    bed.gesture();
    expect(bed.begin()).toBe(PREROLL_MS);
    expect(ctxs.length).toBe(1);
    expect(ctxs[0].resumes).toBe(1);
    expect(bed.running()).toBe(true);
    c.advance(100);
    expect(bed.begin()).toBe(PREROLL_MS - 100);
    c.advance(PREROLL_MS);
    expect(bed.begin()).toBe(0);
    expect(ctxs.length).toBe(1);
  });

  it("a tap long ago is no gesture now", () => {
    const { bed, c, ctxs } = setup();
    bed.gesture();
    c.advance(5_000);
    expect(bed.begin()).toBe(0);
    expect(ctxs.length).toBe(0);
  });

  it("a tap while a line plays, or with the mic on, starts it; an idle tap does not", () => {
    const { bed, s, c } = setup();
    bed.gesture();
    expect(bed.running()).toBe(false);
    c.advance(5_000);
    s.busy = true;
    bed.gesture();
    expect(bed.running()).toBe(true);
    bed.exit("test");
    s.busy = false;
    s.mic = true;
    bed.gesture();
    expect(bed.running()).toBe(true);
  });

  it("a mic turned on in a tap starts it; a mic resumed on load waits for one", () => {
    const a = setup();
    a.s.mic = true;
    a.bed.sync();
    expect(a.bed.running()).toBe(false);
    a.bed.gesture();
    expect(a.bed.running()).toBe(true);
    const b = setup();
    b.bed.gesture();
    b.s.mic = true;
    b.bed.sync();
    expect(b.bed.running()).toBe(true);
  });

  it("a hidden page starts nothing, however recent the tap", () => {
    const { bed, ctxs } = setup({ hidden: true });
    bed.gesture();
    expect(bed.begin()).toBe(0);
    expect(ctxs.length).toBe(0);
  });

  it("a context that cannot be made leaves speech as it was", () => {
    const c = clock();
    const bed = createOutputBed({
      makeCtx: () => {
        throw new Error("no audio");
      },
      enabled: () => true,
      micOn: () => false,
      busy: () => false,
      now: c.now,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
    });
    bed.gesture();
    expect(bed.begin()).toBe(0);
    expect(bed.running()).toBe(false);
  });
});

describe("what the bed plays, and where", () => {
  it("noise at the agreed level, looping, into its own destination and nothing else", () => {
    const { bed, ctxs } = setup();
    bed.gesture();
    bed.begin();
    const [x] = ctxs;
    const peak = Math.max(...Array.from(x.samples(), Math.abs));
    expect(peak).toBeLessThanOrEqual(10 ** (BED_DBFS / 20));
    expect(peak).toBeGreaterThan(0);
    expect(x.connected).toEqual([x.destination]);
  });

  it("has no way into the mic: no capture node, no page-audio hold, no echo text", () => {
    const src = readFileSync("packages/debug-chat/src/output-bed.ts", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/createMediaStream|getUserMedia|createMediaElementSource/);
    expect(code).not.toMatch(/pageAudio\(\)\.start/);
  });
});

describe("the bed stops", () => {
  it("LINGER_MS after the last line, closing its context", () => {
    const { bed, ctxs, c } = setup();
    bed.gesture();
    bed.begin();
    c.advance(LINGER_MS - 1);
    expect(ctxs[0].closed).toBe(false);
    bed.begin();
    c.advance(LINGER_MS - 1);
    expect(ctxs[0].closed).toBe(false);
    c.advance(1);
    expect(ctxs[0].closed).toBe(true);
    expect(bed.running()).toBe(false);
  });

  it("not while a long line still plays", () => {
    const { bed, ctxs, c, s } = setup();
    bed.gesture();
    bed.begin();
    s.busy = true;
    c.advance(LINGER_MS * 2);
    expect(ctxs[0].closed).toBe(false);
    s.busy = false;
    c.advance(LINGER_MS);
    expect(ctxs[0].closed).toBe(true);
  });

  it("not while the mic is on; the mic going off starts the linger", () => {
    const { bed, ctxs, c, s } = setup();
    bed.gesture();
    bed.begin();
    s.mic = true;
    bed.sync();
    c.advance(LINGER_MS * 3);
    expect(ctxs[0].closed).toBe(false);
    s.mic = false;
    bed.sync();
    c.advance(LINGER_MS);
    expect(ctxs[0].closed).toBe(true);
  });

  it("at once on exit, mic or not, and only a new gesture starts it again", () => {
    const { bed, ctxs, s, log } = setup();
    const told: string[] = [];
    bed.onExit((w) => told.push(w));
    bed.gesture();
    s.mic = true;
    bed.begin();
    bed.exit("pagehide");
    expect(ctxs[0].closed).toBe(true);
    expect(log).toEqual(["bed start", "bed stop", "ctx close"]);
    expect(told).toEqual(["pagehide"]);
    expect(bed.begin()).toBe(0);
    expect(ctxs.length).toBe(1);
    bed.gesture();
    expect(ctxs.length).toBe(2);
  });

  it("sign-out reaches the page's bed, and makes none when there is none", () => {
    const g = globalThis as unknown as Record<string, OutputBed | undefined>;
    exitOutputBed("sign-out");
    expect(g.__lkOutputBed).toBeUndefined();
    const { bed, ctxs } = setup();
    g.__lkOutputBed = bed;
    try {
      bed.gesture();
      bed.begin();
      exitOutputBed("sign-out");
      expect(ctxs[0].closed).toBe(true);
    } finally {
      delete g.__lkOutputBed;
    }
    const src = readFileSync("lib/sign-out.ts", "utf8");
    expect(src).toContain('exitOutputBed("sign-out")');
  });

  it("page hide and hiding the tab are wired to exit", () => {
    const src = readFileSync("packages/debug-chat/src/output-bed.ts", "utf8");
    expect(src).toContain('window.addEventListener("pagehide", () => bed.exit("pagehide"))');
    expect(src).toMatch(/visibilityState === "hidden"\) bed\.exit\("hidden"\)/);
  });
});

describe("the setting", () => {
  it("off: no bed, no wait, gesture or not", () => {
    const { bed, ctxs, s } = setup({ enabled: false });
    s.mic = true;
    bed.gesture();
    bed.sync();
    expect(bed.begin()).toBe(0);
    expect(ctxs.length).toBe(0);
  });

  it("turned off while running: stops at once", () => {
    const { bed, ctxs, s } = setup();
    bed.gesture();
    bed.begin();
    s.enabled = false;
    bed.sync();
    expect(ctxs[0].closed).toBe(true);
  });

  it("on unless turned off, kept on this device under its own key", () => {
    const store = new Map<string, string>();
    const g = globalThis as unknown as { localStorage?: unknown };
    const had = g.localStorage;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    try {
      expect(keepAwakeOn()).toBe(true);
      setKeepAwake(false);
      expect(store.get(KEEP_AWAKE_KEY)).toBe("0");
      expect(keepAwakeOn()).toBe(false);
      setKeepAwake(true);
      expect(store.has(KEEP_AWAKE_KEY)).toBe(false);
    } finally {
      g.localStorage = had;
    }
    expect(readFileSync("docs/prefs-sync.md", "utf8")).toMatch(/`lk:voice-keep-awake`.*device/);
  });
});

describe("pre-roll order on each read-aloud path", () => {
  it("/words: the bed runs before the first part, parts after it with no more waiting", () => {
    const { bed, c, log } = setup();
    const seq = createSequencer<string>({
      say: (p, done) => {
        log.push(`say ${p}`);
        done(true);
      },
      cancel: () => {},
      setTimeout: c.setTimer,
      clearTimeout: c.clearTimer,
      preroll: () => bed.begin(),
    });
    bed.gesture();
    seq.play(["word", "example"]);
    expect(log).toEqual(["bed start"]);
    c.advance(PREROLL_MS - 1);
    expect(log).toEqual(["bed start"]);
    c.advance(1);
    expect(log).toEqual(["bed start", "say word"]);
    c.advance(150);
    expect(log).toEqual(["bed start", "say word", "say example"]);
    // The next card, bed still running: at once.
    seq.play(["next word"]);
    expect(log.at(-1)).toBe("say next word");
  });

  it("/words: a card changed during the pre-roll says only the new card", () => {
    const { bed, c, log } = setup();
    const seq = createSequencer<string>({
      say: (p, done) => {
        log.push(`say ${p}`);
        done(true);
      },
      cancel: () => {},
      setTimeout: c.setTimer,
      clearTimeout: c.clearTimer,
      preroll: () => bed.begin(),
    });
    bed.gesture();
    seq.play(["old"]);
    c.advance(100);
    seq.play(["new"]);
    c.advance(PREROLL_MS);
    expect(log).toEqual(["bed start", "say new"]);
  });

  it("/words: a row's own delay already covers a shorter pre-roll", () => {
    const { bed, c, log } = setup();
    const seq = createSequencer<string>({
      say: (p, done) => {
        log.push(`say ${p}`);
        done(true);
      },
      cancel: () => {},
      setTimeout: c.setTimer,
      clearTimeout: c.clearTimer,
      preroll: () => bed.begin(),
    });
    bed.gesture();
    seq.play(["word"], { delayMs: PREROLL_MS + 50 });
    c.advance(PREROLL_MS);
    expect(log).toEqual(["bed start"]);
    c.advance(50);
    expect(log).toEqual(["bed start", "say word"]);
  });

  function reader(preroll: () => number, c: ReturnType<typeof clock>, log: string[]) {
    return createReadSpeaker({
      mode: () => "speech",
      synth: () => ({
        speak: (u) => {
          if (u.text) log.push(`say ${u.text}`);
        },
        cancel() {},
        getVoices: () => [{ lang: "fr", name: "v" }],
      }),
      utterance: (text) => ({
        text,
        lang: "",
        voice: null,
        rate: 1,
        onstart: null,
        onend: null,
        onerror: null,
      }),
      fetch: () => Promise.reject(new Error("no network here")),
      audio: () => ({}) as unknown as AudioLike,
      toUrl: () => "",
      revoke() {},
      pageAudio: () =>
        createPageAudio({ setTimer: c.setTimer, clearTimer: c.clearTimer, now: c.now }),
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
      preroll,
    });
  }

  it("the reader: the line waits for the pre-roll; a cancel in it says nothing", () => {
    const { bed, c, log } = setup();
    const sp = reader(() => bed.begin(), c, log);
    bed.gesture();
    sp.speak("Une ligne.", "fr", { onend() {}, onerror() {} });
    expect(log).toEqual(["bed start"]);
    c.advance(PREROLL_MS);
    expect(log).toEqual(["bed start", "say Une ligne."]);
    const later = setup();
    const sp2 = reader(() => later.bed.begin(), later.c, later.log);
    later.bed.gesture();
    const cancel = sp2.speak("Une ligne.", "fr", { onend() {}, onerror() {} });
    cancel();
    later.c.advance(PREROLL_MS * 2);
    expect(later.log).toEqual(["bed start"]);
  });

  function li(preroll: () => number, c: ReturnType<typeof clock>, log: string[]) {
    return createVoice({
      synth: () => ({
        speak: (u) => {
          log.push(`say ${u.text}`);
          c.setTimer(() => (u as UtterLike).onend?.(), 10);
        },
        cancel() {},
      }),
      utter: (text, lang) =>
        ({ text, lang, onend: null, onerror: null, onboundary: null }) as UtterLike,
      enabled: () => true,
      here: () => true,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
      preroll,
    });
  }

  it("Li: the first sentence waits for the pre-roll, the rest do not", () => {
    const { bed, c, log } = setup();
    const v = li(() => bed.begin(), c, log);
    bed.gesture();
    v.reply("Une phrase. Une autre.");
    expect(log).toEqual(["bed start"]);
    c.advance(PREROLL_MS);
    c.advance(10);
    expect(log).toEqual(["bed start", "say Une phrase.", "say Une autre."]);
  });

  it("Li: stopped during the pre-roll, nothing is said", () => {
    const { bed, c, log } = setup();
    const v = li(() => bed.begin(), c, log);
    bed.gesture();
    v.reply("Une phrase.");
    v.stop();
    c.advance(PREROLL_MS);
    expect(log).toEqual(["bed start"]);
  });

  it("Li with no gesture: says it at once, with no bed", () => {
    const { bed, c, log } = setup();
    const v = li(() => bed.begin(), c, log);
    v.reply("Une phrase.");
    expect(log).toEqual(["say Une phrase."]);
  });

  it("each path is wired to the page's bed", () => {
    for (const f of [
      "packages/debug-chat/src/voice.ts",
      "lib/read/speaker-browser.ts",
      "app/(app)/words/WordsClient.tsx",
    ])
      expect(readFileSync(f, "utf8")).toContain("outputBed().begin()");
  });
});
