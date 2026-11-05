/**
 * The voice cues (packages/debug-chat cues.ts, docs/voice-mode.md "Cues"): a
 * mocked AudioContext and fake VAD events, wired the way MicButton wires them.
 * Nothing here makes a sound.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CUES,
  CUE_RESUME_MS,
  CUE_SEND_KEY,
  CUE_SPEECH_KEY,
  CUE_START_GAP_MS,
  CUE_TAIL_MS,
  type CueContext,
  type CueGate,
  type CueKind,
  SPEECH_CUE_GAIN,
  TICK_GAIN,
  TICK_MS,
  cueAllowed,
  createCues,
  scheduleCue,
} from "@lianki/debug-chat/cues";
import { type VadEvents, createMic } from "@lianki/debug-chat/mic";
import { prefBindings } from "@/lib/prefs/bindings";

const FRAME = 1600; // 0.1 s at 16 kHz
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A mocked AudioContext: what was scheduled, in order, and a clock the tests move. */
function fakeCtx(state = "running") {
  const notes: { hz: number; start: number; stop: number }[] = [];
  const peaks: number[] = [];
  const ctx = {
    currentTime: 100,
    destination: "out",
    state,
    outputLatency: 0.02,
    resumes: 0,
    resolve: null as null | (() => void),
    resume() {
      ctx.resumes++;
      if (ctx.state === "running") return Promise.resolve();
      // Chrome keeps it pending until a tap.
      return new Promise<void>((r) => {
        ctx.resolve = () => {
          ctx.state = "running";
          r();
        };
      });
    },
    createGain: () => ({
      gain: {
        setValueAtTime: () => {},
        linearRampToValueAtTime: (v: number) => void peaks.push(v),
        exponentialRampToValueAtTime: () => {},
      },
      connect: () => {},
    }),
    createOscillator: () => {
      const n = { hz: 0, start: 0, stop: 0 };
      notes.push(n);
      return {
        type: "",
        frequency: { setValueAtTime: (v: number) => (n.hz = v) },
        connect: () => {},
        start: (t: number) => void (n.start = t),
        stop: (t: number) => void (n.stop = t),
      };
    },
  };
  return { ctx: ctx as typeof ctx & CueContext, notes, peaks };
}

/** Cues on a fake clock and fake timers. */
function cueRig(o: { state?: string; allowed?: (k: CueKind) => boolean } = {}) {
  const f = fakeCtx(o.state);
  let t = 1_000_000;
  let timers: { at: number; f: () => void; live: boolean }[] = [];
  const idles: number[] = [];
  const cues = createCues({
    ctx: () => f.ctx,
    allowed: o.allowed ?? (() => true),
    now: () => t,
    setTimer: (fn, ms) => {
      const x = { at: t + ms, f: fn, live: true };
      timers.push(x);
      return x;
    },
    clearTimer: (x) => {
      if (x) (x as { live: boolean }).live = false;
    },
    idle: () => void idles.push(t),
  });
  const advance = (ms: number) => {
    t += ms;
    const due = timers.filter((x) => x.live && x.at <= t);
    timers = timers.filter((x) => !due.includes(x));
    for (const x of due) {
      x.live = false;
      x.f();
    }
  };
  return { ...f, cues, advance, idles };
}

/** The mic on fake VAD events, with the cues wired as MicButton's session() does. */
async function micRig(over: Partial<Parameters<typeof createMic>[0]> = {}, rig = cueRig()) {
  let ev: VadEvents | null = null;
  const did: string[] = [];
  const states: string[] = [];
  const texts: string[] = [];
  const uploads: number[] = [];
  const logs: Record<string, unknown>[] = [];
  const mic = createMic({
    load: async (e) => {
      ev = e;
      return {
        start: () => void did.push("start"),
        pause: () => void did.push("pause"),
        flush: () => void did.push("flush"),
        destroy: () => void did.push("destroy"),
      };
    },
    upload: async (wav) => {
      uploads.push((wav.length - 44) / 2);
      return "hello there";
    },
    onState: (s) => {
      states.push(s);
      if (s === "capturing") rig.cues.capture(true);
      else if (s === "listening" || s === "off") rig.cues.capture(false);
    },
    onText: (t) => texts.push(t),
    onPending: () => {},
    log: (e) => logs.push(e),
    cue: {
      guard: () => rig.cues.guard(),
      edge: (edge) => void (edge === "start" ? rig.cues.speechStart() : rig.cues.speechEnd()),
    },
    ...over,
  });
  await mic.toggle();
  const vad = () => ev as unknown as VadEvents;
  /** `n` frames of speech (or of whatever the VAD scores `prob`). */
  const frames = (n: number, prob = 0.9) => {
    for (let i = 0; i < n; i++) vad().onFrame?.(new Float32Array(FRAME), prob);
  };
  /** The VAD's own end of an utterance of `n` frames. */
  const end = (n: number) => vad().onSpeechEnd(new Float32Array(n * FRAME));
  return { ...rig, mic, vad, frames, end, did, states, texts, uploads, logs };
}

/** Which cues were scheduled, by their first note. */
const kinds = (notes: { hz: number }[]) =>
  notes
    .filter((_, i) => i % 2 === 0)
    .map((n) => {
      const k = (Object.keys(CUES) as CueKind[]).find((x) => CUES[x].notes[0][0] === n.hz);
      return k;
    });

describe("the cue set", () => {
  it("start rises, end falls, each softer than the send cue, all short", () => {
    const hz = (k: CueKind) => CUES[k].notes.map((n) => n[0]);
    expect(hz("start")[1]).toBeGreaterThan(hz("start")[0]);
    expect(hz("end")[1]).toBeLessThan(hz("end")[0]);
    expect(hz("end")).toEqual([...hz("start")].reverse());
    expect(SPEECH_CUE_GAIN).toBeLessThan(TICK_GAIN / 2);
    for (const k of Object.keys(CUES) as CueKind[]) {
      const ms = CUES[k].notes.reduce((a, n) => a + n[1], 0);
      expect(ms).toBeLessThanOrEqual(TICK_MS);
    }
  });

  it("plays its notes in turn on the context's clock", () => {
    const { ctx, notes, peaks } = fakeCtx();
    const end = scheduleCue(ctx, "start");
    expect(notes.map((n) => n.hz)).toEqual(CUES.start.notes.map((n) => n[0]));
    expect(notes[0].start).toBe(100);
    expect(notes[1].start).toBeCloseTo(notes[0].stop);
    expect(end).toBeCloseTo(100.09);
    expect(peaks).toEqual([SPEECH_CUE_GAIN, SPEECH_CUE_GAIN]);
  });
});

describe("cueAllowed: the switches, his mute, read-aloud", () => {
  const gate = (o: Partial<CueGate> = {}): CueGate => ({
    on: true,
    muted: false,
    silenced: false,
    speaking: false,
    aec: true,
    ...o,
  });
  it("each cue plays by default", () => {
    for (const k of ["send", "start", "end"] as const) expect(cueAllowed(k, gate())).toBe(true);
  });
  it("its switch, his mute and a silenced page stop all of them", () => {
    for (const k of ["send", "start", "end"] as const) {
      expect(cueAllowed(k, gate({ on: false }))).toBe(false);
      expect(cueAllowed(k, gate({ muted: true }))).toBe(false);
      expect(cueAllowed(k, gate({ silenced: true }))).toBe(false);
    }
  });
  it("over a reply being read only the send cue plays", () => {
    expect(cueAllowed("send", gate({ speaking: true }))).toBe(true);
    expect(cueAllowed("start", gate({ speaking: true }))).toBe(false);
    expect(cueAllowed("end", gate({ speaking: true }))).toBe(false);
  });
  it("with no echo canceller the start cue, which plays over his words, stays out", () => {
    expect(cueAllowed("start", gate({ aec: false }))).toBe(false);
    expect(cueAllowed("end", gate({ aec: false }))).toBe(true);
    expect(cueAllowed("send", gate({ aec: false }))).toBe(true);
  });
});

describe("the send cue", () => {
  it("one per line sent, played in turn, never on top of each other", async () => {
    const r = cueRig();
    expect(r.cues.send()).toBe(true);
    expect(r.cues.send()).toBe(true);
    await settle();
    expect(kinds(r.notes)).toEqual(["send", "send"]);
    expect(r.notes[2].start).toBeGreaterThanOrEqual(r.notes[1].stop);
  });

  it("waits out a capture, once for each line, so it is not recorded", async () => {
    const r = cueRig();
    r.cues.capture(true);
    expect(r.cues.send()).toBe(true);
    await settle();
    expect(r.notes).toEqual([]);
    r.cues.capture(false);
    await settle();
    expect(kinds(r.notes)).toEqual(["send"]);
    r.cues.capture(true);
    r.cues.capture(false);
    await settle();
    expect(kinds(r.notes)).toEqual(["send"]);
  });

  it("a context that will not run drops the cue: it never sounds late at his next tap", async () => {
    const r = cueRig({ state: "suspended" });
    r.cues.send();
    await settle();
    r.advance(CUE_RESUME_MS);
    r.ctx.resolve?.();
    await settle();
    expect(r.notes).toEqual([]);
  });

  it("goes through resume even when running: a suspend under way must not freeze it", async () => {
    const r = cueRig();
    r.cues.send();
    expect(r.ctx.resumes).toBe(1);
    await settle();
    expect(kinds(r.notes)).toEqual(["send"]);
  });

  it("a muted or switched-off cue plays nothing and reports it", async () => {
    const r = cueRig({ allowed: () => false });
    expect(r.cues.send()).toBe(false);
    await settle();
    expect(r.notes).toEqual([]);
    expect(r.cues.guard()).toBe(false);
  });

  it("the guard covers the cue, its output latency and the tail, then says idle once", async () => {
    const r = cueRig();
    r.cues.send();
    await settle();
    expect(r.cues.guard()).toBe(true);
    const window = TICK_MS + 20 + CUE_TAIL_MS;
    r.advance(window - 5);
    expect(r.cues.guard()).toBe(true);
    expect(r.idles).toEqual([]);
    r.advance(5);
    expect(r.cues.guard()).toBe(false);
    expect(r.cues.quiet()).toBe(true);
    expect(r.idles.length).toBe(1);
  });
});

describe("the start and end cues on VAD events", () => {
  it("one start and one end per utterance, the start only once speech is confirmed", async () => {
    const r = await micRig();
    r.vad().onSpeechStart();
    r.frames(2); // 200 ms: not confirmed yet
    await settle();
    expect(r.notes).toEqual([]);
    r.frames(10);
    await settle();
    expect(kinds(r.notes)).toEqual(["start"]);
    r.advance(1000);
    r.frames(10);
    await settle();
    expect(kinds(r.notes)).toEqual(["start"]);
    r.end(22);
    await settle();
    expect(kinds(r.notes)).toEqual(["start", "end"]);
  });

  it("a false start the VAD discards plays nothing", async () => {
    const r = await micRig();
    r.vad().onSpeechStart();
    r.frames(1);
    r.vad().onMisfire();
    await settle();
    expect(r.notes).toEqual([]);
    expect(r.cues.guard()).toBe(false);
    expect(r.uploads).toEqual([]);
  });

  it("noise the VAD starts on but scores low confirms nothing", async () => {
    const r = await micRig();
    r.vad().onSpeechStart();
    r.frames(10, 0.1);
    await settle();
    expect(r.notes).toEqual([]);
  });

  it("debounced: talk resuming right after a pause does not chime again", async () => {
    const r = await micRig();
    r.vad().onSpeechStart();
    r.frames(5);
    r.end(5);
    await settle();
    expect(kinds(r.notes)).toEqual(["start", "end"]);
    // Past the end cue's guard, but inside the gap.
    r.advance(500);
    r.vad().onSpeechStart();
    r.frames(5);
    await settle();
    expect(kinds(r.notes)).toEqual(["start", "end"]);
    r.end(5);
    await settle();
    expect(kinds(r.notes)).toEqual(["start", "end", "end"]);
    // After the gap the next utterance chimes again.
    r.advance(CUE_START_GAP_MS);
    r.vad().onSpeechStart();
    r.frames(5);
    await settle();
    expect(kinds(r.notes)).toEqual(["start", "end", "end", "start"]);
  });

  it("no re-trigger: the end cue heard by the mic starts nothing and reaches no transcript", async () => {
    const r = await micRig();
    r.vad().onSpeechStart();
    r.frames(5);
    r.end(5);
    await settle();
    expect(kinds(r.notes)).toEqual(["start", "end"]);
    expect(r.uploads.length).toBe(1);
    await settle();
    const textsBefore = r.texts.length;
    const statesBefore = r.states.length;
    // The tone leaks in: the VAD fires, and every frame of the window scores as speech.
    r.vad().onSpeechStart();
    r.frames(1);
    await settle();
    expect(r.states.slice(statesBefore)).toEqual([]); // nobody hears of a capture
    r.end(3);
    await settle();
    expect(r.uploads.length).toBe(1);
    expect(r.texts.length).toBe(textsBefore);
    expect(kinds(r.notes)).toEqual(["start", "end"]); // and it plays no cue of its own
    expect(r.logs.some((l) => l.ev === "cue-echo-drop")).toBe(true);
    expect(r.mic.state()).toBe("listening");
  });

  it("the send cue is guarded the same way", async () => {
    const r = await micRig();
    r.cues.send();
    await settle();
    r.vad().onSpeechStart();
    r.frames(1);
    r.end(1);
    await settle();
    expect(r.uploads).toEqual([]);
    expect(kinds(r.notes)).toEqual(["send"]);
    expect(r.states).not.toContain("capturing");
  });

  it("the tone's frames do not teach the noise floor or the speech level", async () => {
    const taught: (number | undefined)[] = [];
    const ends: boolean[] = [];
    const r = await micRig({
      adapt: {
        frame: (_f, p) => void taught.push(p),
        end: (k) => void ends.push(k),
        state: () => ({ endpointMs: 600, endpointMargin: 0.1, endpointMin: 0.1 }),
      },
    });
    r.cues.send();
    await settle();
    r.vad().onFrame?.(new Float32Array(FRAME), 0.8);
    expect(taught).toEqual([]);
    r.vad().onSpeechStart();
    r.frames(1);
    r.end(1);
    expect(ends).toEqual([false]);
  });

  it("his real speech starting inside a cue's window is kept whole", async () => {
    const r = await micRig();
    r.cues.send();
    await settle();
    // He starts talking while the cue plays: the VAD fires, the frames are kept.
    r.vad().onSpeechStart();
    r.frames(2);
    expect(r.states).not.toContain("capturing");
    // The window ends; he is still talking.
    r.advance(TICK_MS + 20 + CUE_TAIL_MS);
    r.frames(2);
    expect(r.states).toContain("capturing");
    r.frames(6);
    r.end(10);
    await settle();
    // All of it, first frames included: the cue cost him nothing.
    expect(r.uploads).toEqual([10 * FRAME]);
    expect(r.texts.length).toBe(1);
  });

  it("the start cue never pauses the VAD or cuts the capture", async () => {
    const r = await micRig();
    const before = [...r.did];
    r.vad().onSpeechStart();
    r.frames(10);
    await settle();
    expect(kinds(r.notes)).toEqual(["start"]);
    r.frames(10);
    r.end(20);
    await settle();
    expect(r.did).toEqual(before); // no pause, no flush
    expect(r.mic.held()).toBe(false);
    expect(r.uploads).toEqual([20 * FRAME]);
  });

  it("the cue's own frames neither end the utterance early nor hold it open", async () => {
    let began = 0;
    const r = await micRig({
      stream: () =>
        ({
          begin: () => {
            began++;
            return { frame: () => {}, end: async () => ({ text: "x", ms: 1 }), cancel: () => {} };
          },
        }) as never,
    });
    r.vad().onSpeechStart();
    expect(began).toBe(1);
    r.frames(4); // confirmed: the start cue plays
    await settle();
    expect(kinds(r.notes)).toEqual(["start"]);
    // Silence scored inside the guard is not silence: it must not reach the endpoint.
    r.frames(20, 0);
    expect(r.did).not.toContain("flush");
    // Past the guard real silence counts again.
    r.advance(1000);
    r.frames(10, 0);
    await settle();
    expect(r.logs.some((l) => l.ev === "stt-endpoint")).toBe(true);
  });

  it("listening in passive mode stays silent: ambient talk never chimes", async () => {
    const r = await micRig({
      wake: {
        passive: () => true,
        spot: async () => ({ hit: false }),
        onWake: () => {},
        verdict: () => {},
      } as never,
    });
    r.vad().onSpeechStart();
    r.frames(10);
    r.end(10);
    await settle();
    expect(r.notes).toEqual([]);
  });

  it("an enrolment sentence stays clean: no cue, and no guard over it", async () => {
    const r = await micRig({
      enrol: { active: () => true, begin: () => null, done: () => {} } as never,
    });
    r.cues.send();
    await settle();
    r.vad().onSpeechStart();
    expect(r.states).toContain("capturing");
    r.advance(1000);
    r.frames(10);
    r.end(10);
    await settle();
    expect(kinds(r.notes)).toEqual(["send"]);
  });

  it("speech dropped by a hold (a reply being read, no canceller) plays no end cue", async () => {
    const r = await micRig();
    r.vad().onSpeechStart();
    r.frames(1);
    r.mic.hold(true);
    r.end(1);
    await settle();
    expect(r.notes).toEqual([]);
    r.mic.hold(false);
  });

  it("speech flushed by turning the mic off plays no end cue", async () => {
    const r = await micRig();
    r.vad().onSpeechStart();
    r.frames(1);
    const off = r.mic.off();
    r.end(1);
    await off;
    await settle();
    expect(r.notes).toEqual([]);
  });
});

describe("the wiring", () => {
  const chat = readFileSync("packages/debug-chat/src/DebugChat.tsx", "utf8");
  it("the send cue has one call, in submit, for spoken lines only", () => {
    expect(chat.match(/pageCues\(\)\.send\(\)/g)?.length).toBe(1);
    const i = chat.indexOf("pageCues().send()");
    const before = chat.slice(chat.lastIndexOf("const submit = ", i), i);
    expect(before).toContain("if (!source) learnSttHint(text);");
    expect(chat).not.toContain("playSentTick");
  });
  it("the two switches are in the chat's menu, each with its own key", () => {
    expect(chat).toContain('data-testid="debug-menu-cue-send"');
    expect(chat).toContain('data-testid="debug-menu-cue-speech"');
    expect(CUE_SEND_KEY).not.toBe(CUE_SPEECH_KEY);
  });
  it("both follow the account, and are on by default", () => {
    const b = prefBindings();
    const send = b.find((x) => x.key === "chat-voice.cueSend");
    const speech = b.find((x) => x.key === "chat-voice.cueSpeech");
    expect(send?.fallback).toBe(true);
    expect(speech?.fallback).toBe(true);
  });
  it("no hold, no audio owner: a cue never pauses the mic or read-aloud", () => {
    const src = readFileSync("packages/debug-chat/src/cues.ts", "utf8");
    expect(src).not.toMatch(/from "\.\/audio-claim"/);
    expect(src).not.toMatch(/from "\.\/page-audio"/);
    expect(src).not.toMatch(/\.hold\(/);
  });
});
