import { describe, expect, it } from "bun:test";
import { ECHO_WINDOW_MS } from "@lianki/debug-chat/echo";
import {
  BARGE_IN_MS,
  BARGE_IN_PROB,
  CHUNK_MAX,
  DUCK_ATTACK_MS,
  DUCK_LEVEL,
  DUCK_RELEASE_MS,
  IDLE_RESUME_MS,
  RESUME_TAIL_MS,
  SPEAK_KEY,
  SPEECH_START_MS,
  type UtterLike,
  chunk,
  createVoice,
  REPLY_DEDUPE_MS,
  heardFraction,
  isBargeIn,
  resumeOffset,
  sentences,
  speakHere,
  speechEnabled,
  voice,
} from "@lianki/debug-chat/voice";
import { RESUME_REWIND_S, createCloudOut } from "@lianki/debug-chat/voice-out";
import { AUDIO_CLAIM, AUDIO_PRIO, audioOwner } from "@lianki/debug-chat/audio-claim";

describe("sentences", () => {
  it("cuts Latin text after . ! ? before a space or the end, keeping 3.14 and e.g. whole", () => {
    expect(sentences("Hello there. How are you? Fine!")).toEqual([
      "Hello there.",
      "How are you?",
      "Fine!",
    ]);
    expect(sentences("Pi is 3.14 today, e.g.here. Done")).toEqual([
      "Pi is 3.14 today, e.g.here.",
      "Done",
    ]);
    expect(sentences('He said "stop." Then left...  ok?!')).toEqual([
      'He said "stop."',
      "Then left...",
      "ok?!",
    ]);
  });

  it("cuts CJK text after 。．！？ with no space needed, keeping closing brackets", () => {
    expect(sentences("今日は晴れです。散歩しますか？「はい。」行こう！")).toEqual([
      "今日は晴れです。",
      "散歩しますか？",
      "「はい。」",
      "行こう！",
    ]);
    expect(sentences("好的。我明白了")).toEqual(["好的。", "我明白了"]);
  });

  it("cuts at newlines and drops blank pieces", () => {
    expect(sentences("line one\n\n  line two\r\n- item")).toEqual([
      "line one",
      "line two",
      "- item",
    ]);
    expect(sentences("   \n ")).toEqual([]);
  });
});

/** speechSynthesis in memory: one utterance at a time is all the session ever gives it. */
function harness(
  o: {
    enabled?: boolean;
    here?: boolean;
    touch?: boolean;
    owner?: { claim(): boolean; release(): void };
  } = {},
) {
  const spoken: (UtterLike & { lang: string })[] = [];
  let cancels = 0;
  const flags = {
    enabled: o.enabled ?? true,
    here: o.here ?? false,
    touch: o.touch ?? false,
    synth: true,
  };
  const timers: { f: () => void; ms: number; live: boolean }[] = [];
  const v = createVoice({
    synth: () =>
      flags.synth
        ? {
            speak: (u) => void spoken.push(u as UtterLike & { lang: string }),
            cancel: () => void cancels++,
          }
        : null,
    utter: (text, lang) =>
      ({ text, lang, onend: null, onerror: null, onboundary: null }) as UtterLike,
    enabled: () => flags.enabled,
    here: () => flags.here,
    touch: () => flags.touch,
    owner: o.owner,
    setTimer: (f, ms) => {
      const t = { f, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) (t as { live: boolean }).live = false;
    },
  });
  /** Run the live timers of this length (one-shot). */
  const fire = (ms: number) => {
    for (const t of timers.filter((x) => x.live && x.ms === ms)) {
      t.live = false;
      t.f();
    }
  };
  const live = (ms: number) => timers.some((t) => t.live && t.ms === ms);
  const texts = () => spoken.map((u) => u.text);
  const end = () => spoken.at(-1)?.onend?.();
  const states: boolean[] = [];
  v.subscribe((s) => states.push(s.speaking));
  return { v, spoken, texts, end, fire, live, flags, timers, states, cancels: () => cancels };
}

describe("voice session: Li owns the page's audio while speaking (audio-claim.ts)", () => {
  it("claims before the first sentence is spoken, and lets go after the tail", () => {
    const target = new EventTarget();
    const log: string[] = [];
    const reader = audioOwner({
      id: "para",
      prio: AUDIO_PRIO.para,
      target,
      onYield: () => void log.push("para yield"),
      onResume: () => void log.push("para resume"),
    });
    reader.claim();
    let spokenAtYield = -1;
    const h = harness({
      enabled: true,
      here: true,
      owner: audioOwner({ id: "li", prio: AUDIO_PRIO.li, target }),
    });
    target.addEventListener(AUDIO_CLAIM, () => void (spokenAtYield = h.spoken.length));
    expect(h.v.reply("One. Two.")).toBe(true);
    // The reader paused before Li's utterance went to the engine.
    expect(spokenAtYield).toBe(0);
    expect(log).toEqual(["para yield"]);
    h.end();
    h.end();
    expect(log).toEqual(["para yield"]);
    h.fire(RESUME_TAIL_MS);
    expect(log).toEqual(["para yield", "para resume"]);
  });
});

describe("voice session: the focus rule (mic off)", () => {
  it("reads only with the speaker on and the input focused here", () => {
    const h = harness({ enabled: true, here: false });
    expect(h.v.reply("Not focused.")).toBe(false);
    h.flags.here = true;
    h.flags.enabled = false;
    expect(h.v.reply("Speaker off.")).toBe(false);
    h.flags.enabled = true;
    expect(h.v.reply("Read me.")).toBe(true);
    expect(h.texts()).toEqual(["Read me."]);
    expect(h.v.shouldSpeak()).toBe(true);
    h.flags.synth = false;
    expect(h.v.reply("No synth.")).toBe(false);
    h.flags.synth = true;
    expect(h.v.reply("  \n ")).toBe(false);
  });

  it("the mic overrides it, forcing the speaker on; the setting is back when the mic stops", () => {
    const h = harness({ enabled: false, here: false });
    expect(h.v.readAloud()).toBe(false);
    h.v.setMic(true);
    h.v.setMic(true); // no change
    expect(h.v.readAloud()).toBe(true);
    expect(h.v.shouldSpeak()).toBe(true);
    expect(h.v.reply("Hands free. Two sentences.")).toBe(true);
    expect(h.texts()).toEqual(["Hands free."]);
    // Mic off: the focus rule is back, so what it would not read stops.
    h.v.setMic(false);
    expect(h.v.readAloud()).toBe(false);
    expect(h.v.state()).toMatchObject({ mic: false, queued: 0, speaking: false });
    expect(h.cancels()).toBe(1);
    expect(h.v.reply("Silent again.")).toBe(false);
  });

  it("mic off while the focus rule holds: the reading goes on", () => {
    const h = harness({ enabled: true, here: true });
    h.v.setMic(true);
    h.v.reply("One. Two.");
    h.v.setMic(false);
    expect(h.v.state().queued).toBe(2);
    h.end();
    expect(h.texts()).toEqual(["One.", "Two."]);
  });
});

describe("voice session: on a phone the speaker toggle alone decides (owner 2026-11-10)", () => {
  it("reads with the input unfocused and the mic never used", () => {
    const h = harness({ enabled: true, here: false, touch: true });
    expect(h.v.voiced()).toBe(false);
    expect(h.v.shouldSpeak()).toBe(true);
    expect(h.v.state().touch).toBe(true);
    expect(h.v.reply("Read on the reader.")).toBe(true);
    expect(h.texts()).toEqual(["Read on the reader."]);
  });

  it("his mute still wins", () => {
    const h = harness({ enabled: false, here: false, touch: true });
    expect(h.v.shouldSpeak()).toBe(false);
    expect(h.v.reply("Muted.")).toBe(false);
  });

  it("the mic stopping keeps reading on a phone (the toggle is on)", () => {
    const h = harness({ enabled: true, here: false, touch: true });
    h.v.setMic(true);
    h.v.reply("One. Two.");
    h.v.setMic(false);
    expect(h.v.state().queued).toBe(2);
  });

  it("a computer still needs focus or the sticky mic state", () => {
    const h = harness({ enabled: true, here: false, touch: false });
    expect(h.v.state().touch).toBe(false);
    expect(h.v.reply("Unfocused desk.")).toBe(false);
  });
});

describe("voice session: sticky read-aloud once the mic was used (owner 2026-11-04)", () => {
  it("after the mic, replies to typed lines are read with the input unfocused; no time window", () => {
    const h = harness({ enabled: true, here: false });
    expect(h.v.reply("Before the mic.")).toBe(false);
    expect(h.v.voiced()).toBe(false);
    h.v.setMic(true);
    h.v.setMic(false);
    expect(h.v.voiced()).toBe(true);
    expect(h.v.state().voiced).toBe(true);
    expect(h.v.shouldSpeak()).toBe(true);
    expect(h.v.reply("Typed reply.")).toBe(true);
    expect(h.texts()).toEqual(["Typed reply."]);
    // No timer decides it: nothing was armed for the sticky state.
    expect(h.timers.filter((t) => t.live).length).toBe(0);
  });

  it("his mute wins: the toggle off silences it, and unvoice ends the sticky state", () => {
    const h = harness({ enabled: true, here: false });
    h.v.setMic(true);
    h.v.setMic(false);
    h.flags.enabled = false;
    expect(h.v.reply("Muted.")).toBe(false);
    h.v.unvoice();
    expect(h.v.voiced()).toBe(false);
    // The toggle back on: the focus rule again, until the mic is used once more.
    h.flags.enabled = true;
    expect(h.v.reply("Unfocused again.")).toBe(false);
    h.flags.here = true;
    expect(h.v.reply("Focused.")).toBe(true);
  });

  it("the mic stopping mid-reading with the sticky state on keeps reading", () => {
    const h = harness({ enabled: true, here: false });
    h.v.setMic(true);
    h.v.reply("One. Two.");
    h.v.setMic(false);
    expect(h.v.state().queued).toBe(2);
  });

  it("keeps the state where it is told (localStorage in the page)", () => {
    let kept = false;
    const v = createVoice({
      synth: () => null,
      utter: (text, lang) =>
        ({ text, lang, onend: null, onerror: null, onboundary: null }) as UtterLike,
      enabled: () => true,
      here: () => false,
      voiced: { get: () => kept, set: (on) => void (kept = on) },
    });
    v.setMic(true);
    expect(kept).toBe(true);
    v.unvoice();
    expect(kept).toBe(false);
  });
});

describe("voice session: the queue", () => {
  it("FIFO, one utterance per sentence; a new reply waits and never cuts one off", () => {
    const h = harness();
    h.v.setMic(true);
    h.v.reply("First one. Second one.");
    h.v.reply("今日は。");
    expect(h.texts()).toEqual(["First one."]);
    expect(h.cancels()).toBe(0);
    expect(h.v.state().queued).toBe(3);
    h.end();
    h.end();
    expect(h.texts()).toEqual(["First one.", "Second one.", "今日は。"]);
    // The language is the reply's, for each of its sentences.
    expect(h.spoken.map((u) => u.lang)).toEqual(["en-US", "en-US", "ja-JP"]);
    // A failed utterance (not ours) moves on rather than sticking.
    h.end();
    h.v.reply("A. B.");
    h.spoken.at(-1)?.onerror?.();
    expect(h.texts().at(-1)).toBe("B.");
  });

  it("onStart hears each sentence begin playing, but not a dropped one's late start", () => {
    const h = harness();
    let starts = 0;
    const off = h.v.onStart(() => starts++);
    h.v.setMic(true);
    h.v.reply("One. Two.");
    h.spoken[0].onstart?.();
    expect(starts).toBe(1);
    h.v.stop();
    h.spoken[0].onstart?.(); // stopped: its epoch is gone
    expect(starts).toBe(1);
    off();
    h.v.reply("Three.");
    h.spoken.at(-1)?.onstart?.();
    expect(starts).toBe(1);
  });

  it("stop() clears the queue (Stop reading)", () => {
    const h = harness();
    h.v.setMic(true);
    h.v.reply("One. Two. Three.");
    h.v.stop();
    expect(h.v.state()).toMatchObject({ queued: 0, speaking: false, paused: false });
    expect(h.cancels()).toBe(1);
    h.end(); // the cancelled utterance's late end: ignored
    expect(h.texts()).toEqual(["One."]);
  });
});

describe("voice session: holding the mic while the agent speaks", () => {
  it("mic on → TTS → held → end → released only after the tail", () => {
    const h = harness();
    h.v.setMic(true);
    h.v.reply("Hi. There.");
    expect(h.v.state().speaking).toBe(true);
    h.end(); // between sentences: still held, no tail
    expect(h.v.state().speaking).toBe(true);
    expect(h.live(RESUME_TAIL_MS)).toBe(false);
    h.end();
    expect(h.v.state().speaking).toBe(true);
    expect(h.live(RESUME_TAIL_MS)).toBe(true);
    h.fire(RESUME_TAIL_MS);
    expect(h.v.state().speaking).toBe(false);
    expect(h.states.at(-1)).toBe(false);
  });

  it("a reply arriving in the tail cancels it: held on", () => {
    const h = harness();
    h.v.setMic(true);
    h.v.reply("Hi.");
    h.end();
    h.v.reply("Again.");
    expect(h.live(RESUME_TAIL_MS)).toBe(false);
    h.fire(RESUME_TAIL_MS);
    expect(h.v.state().speaking).toBe(true);
    expect(h.texts()).toEqual(["Hi.", "Again."]);
  });

  it("a tap in the tail releases the mic at once", () => {
    const h = harness();
    h.v.setMic(true);
    h.v.reply("Hi.");
    h.end();
    h.v.interrupt("tap");
    expect(h.v.state()).toMatchObject({ speaking: false, paused: false });
    expect(h.live(RESUME_TAIL_MS)).toBe(false);
  });
});

describe("voice session: interruptions and resuming", () => {
  it("a tap (barge-in) releases the mic at once; it reads on after the idle", () => {
    const h = harness();
    h.v.setMic(true);
    h.v.reply("The quick brown fox jumps. Then rests.");
    h.v.interrupt("tap");
    expect(h.v.state()).toMatchObject({ speaking: false, paused: true, queued: 2 });
    expect(h.cancels()).toBe(1);
    expect(h.live(RESUME_TAIL_MS)).toBe(false);
    // The cancelled utterance's late error is ignored.
    h.spoken.at(-1)?.onerror?.();
    expect(h.texts()).toHaveLength(1);
    h.fire(IDLE_RESUME_MS);
    expect(h.v.state()).toMatchObject({ speaking: true, paused: false });
    // No boundary heard: from the start of the interrupted sentence.
    expect(h.texts()).toEqual(["The quick brown fox jumps.", "The quick brown fox jumps."]);
  });

  it("resumes at the last word boundary (fake boundary events), and again after a second cut", () => {
    const h = harness();
    h.v.setMic(true);
    h.v.reply("The quick brown fox jumps.");
    const u = h.spoken[0];
    u.onboundary?.({ charIndex: 4, name: "word" });
    u.onboundary?.({ charIndex: 10, name: "word" });
    u.onboundary?.({ charIndex: 20, name: "sentence" }); // not a word: ignored
    h.v.interrupt("tap");
    h.v.resume();
    expect(h.texts().at(-1)).toBe("brown fox jumps.");
    // Offsets of the resumed utterance count from where it began.
    h.spoken.at(-1)?.onboundary?.({ charIndex: 6 });
    h.v.interrupt("typing");
    h.v.resume();
    expect(h.texts().at(-1)).toBe("fox jumps.");
    // A boundary from a dropped utterance changes nothing.
    u.onboundary?.({ charIndex: 0, name: "word" });
    h.v.interrupt("tap");
    h.v.resume();
    expect(h.texts().at(-1)).toBe("fox jumps.");
  });

  it("the user starting to speak interrupts; their line ending resumes after the idle, a send at once", () => {
    const h = harness();
    h.v.setMic(true);
    h.v.reply("One. Two.");
    h.v.interrupt("speech");
    expect(h.v.state().paused).toBe(true);
    expect(h.live(IDLE_RESUME_MS)).toBe(false); // waits for the user to finish
    h.v.userIdle();
    expect(h.live(IDLE_RESUME_MS)).toBe(true);
    h.v.interrupt("speech"); // talking again: the idle is cancelled
    expect(h.live(IDLE_RESUME_MS)).toBe(false);
    h.v.userIdle();
    h.v.resume(); // the transcript was sent
    expect(h.live(IDLE_RESUME_MS)).toBe(false);
    expect(h.v.state()).toMatchObject({ paused: false, speaking: true });
    expect(h.texts()).toEqual(["One.", "One."]);
    // An idle with no speech pause arms nothing.
    h.v.userIdle();
    expect(h.live(IDLE_RESUME_MS)).toBe(false);
  });

  it("typing pauses until a send or blur; nothing to interrupt is a no-op", () => {
    const h = harness();
    h.v.setMic(true);
    h.v.interrupt("typing"); // empty queue
    expect(h.v.state().paused).toBe(false);
    h.v.reply("Hello.");
    h.v.interrupt("typing");
    expect(h.live(IDLE_RESUME_MS)).toBe(false);
    // A reply while paused queues behind and waits.
    h.v.reply("World.");
    expect(h.texts()).toEqual(["Hello."]);
    expect(h.v.state()).toMatchObject({ paused: true, queued: 2 });
    h.v.resume();
    expect(h.texts()).toEqual(["Hello.", "Hello."]);
    h.end();
    expect(h.texts().at(-1)).toBe("World.");
    h.v.resume(); // not paused: nothing
    expect(h.texts()).toHaveLength(3);
  });

  it("subscribers can unsubscribe", () => {
    const h = harness();
    const seen: number[] = [];
    const off = h.v.subscribe((s) => seen.push(s.queued));
    h.v.setMic(true);
    off();
    h.v.reply("Ignored by it.");
    expect(seen).toEqual([0]);
  });
});

describe("voice(): the browser session, shared on globalThis", () => {
  it("one session per page, reading through speechSynthesis with the speaker setting and focus", () => {
    const g = globalThis as Record<string, unknown>;
    const saved = Object.fromEntries(
      [
        "speechSynthesis",
        "SpeechSynthesisUtterance",
        "localStorage",
        "document",
        "matchMedia",
        "__lkVoice",
      ].map((k) => [k, g[k]]),
    );
    const spoken: (EventTarget & { text: string; lang: string; voice?: unknown })[] = [];
    let store: Record<string, string> | null = {};
    const doc = { visibilityState: "visible", activeElement: null as unknown };
    try {
      g.SpeechSynthesisUtterance = class extends EventTarget {
        lang = "";
        voice: unknown;
        constructor(readonly text: string) {
          super();
        }
      };
      g.speechSynthesis = {
        getVoices: () => [{ lang: "ja-JP", name: "kyoko" }],
        speak: (u: (typeof spoken)[number]) => void spoken.push(u),
        cancel: () => {},
      };
      g.localStorage = {
        getItem: (k: string) => {
          if (!store) throw new Error("blocked");
          return store[k] ?? null;
        },
      };
      g.document = doc;
      // A computer (fine pointer): the focus rule applies.
      g.matchMedia = () => ({ matches: true });
      delete g.__lkVoice;
      const v = voice();
      expect(voice()).toBe(v);
      // Mic off, input not focused: silent.
      expect(speakHere()).toBe(false);
      expect(v.reply("Nope.")).toBe(false);
      doc.activeElement = { getAttribute: () => "debug-chat-input" };
      expect(speakHere()).toBe(true);
      expect(speechEnabled()).toBe(true);
      expect(v.reply("こんにちは。")).toBe(true);
      expect(spoken[0]).toMatchObject({ text: "こんにちは。", lang: "ja-JP" });
      expect(spoken[0].voice).toMatchObject({ name: "kyoko" });
      spoken[0].dispatchEvent(new Event("end"));
      // The speaker off (or storage blocked: on), the tab hidden.
      store = { [SPEAK_KEY]: "0" };
      expect(speechEnabled()).toBe(false);
      store = null;
      expect(speechEnabled()).toBe(true);
      doc.visibilityState = "hidden";
      expect(speakHere()).toBe(false);
      // An older copy's session on the page is replaced by this version's.
      g.__lkVoice = { v: 0 };
      expect(voice()).not.toBe(v);
    } finally {
      for (const [k, x] of Object.entries(saved)) {
        if (x === undefined) delete g[k];
        else g[k] = x;
      }
    }
  });
});

// ── Echo-cancelled barge-in: ducking, the barge-in judge, the cloud route ──

/** A GainNode in memory: its value follows each set or ramp at once; the calls are kept. */
function fakeGain() {
  const calls: [string, number, number][] = [];
  const gain = {
    value: 1,
    cancelScheduledValues: (t: number) => void calls.push(["cancel", 0, t]),
    setValueAtTime(v: number, t: number) {
      calls.push(["set", v, t]);
      gain.value = v;
    },
    linearRampToValueAtTime(v: number, t: number) {
      calls.push(["ramp", v, t]);
      gain.value = v;
    },
  };
  return { gain, calls, connect: (n: unknown) => n };
}

/** An <audio> element in memory: load() waits for the test to fire loadedmetadata. */
class FakeEl {
  src = "";
  currentTime = 0;
  volume = 1;
  preload = "";
  paused = true;
  refuse = false;
  plays: { src: string; at: number }[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  play() {
    if (this.refuse)
      return Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" }));
    this.paused = false;
    this.plays.push({ src: this.src, at: this.currentTime });
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {
    this.currentTime = 0;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** The session with the real cloud output over fakes (fetch, element, AudioContext, GainNode). */
function cloudHarness(
  o: {
    aec?: boolean;
    mode?: "speech" | "cloud";
    status?: (text: string) => number;
    hasVoice?: (lang: string) => boolean;
    /** Device voices by name (a line's `device:<name>`). */
    devices?: string[];
  } = {},
) {
  const h0 = { t: 0 };
  const el = new FakeEl();
  /** The ElevenLabs preview element (never routed through the context). */
  const pel = new FakeEl();
  const g = fakeGain();
  const ctx = {
    currentTime: 0,
    destination: {},
    resume: () => Promise.resolve(),
    createGain: () => g,
    createMediaElementSource: () => ({ connect: (n: unknown) => n }),
  };
  const fetched: string[] = [];
  const cloud = createCloudOut({
    fetch: async (url) => {
      fetched.push(url);
      const text = new URL(url, "https://x").searchParams.get("text") ?? "";
      const status = o.status?.(text) ?? 200;
      return {
        ok: status === 200,
        status,
        headers: { get: (k: string) => (k === "X-Voice" && status === 404 ? "miss" : null) },
        blob: async () => new Blob([text]),
      };
    },
    element: () => el,
    plain: () => pel,
    ctx: () => ctx,
    toUrl: (b) => `blob:${(b as Blob).size}`,
    revoke: () => {},
  });
  const spoken: (UtterLike & { lang: string; pick?: unknown; voice?: unknown })[] = [];
  let cancels = 0;
  const timers: { f: () => void; ms: number; live: boolean }[] = [];
  const logs: Record<string, unknown>[] = [];
  const reports: string[] = [];
  const flags = { aec: o.aec ?? true, mode: o.mode ?? "cloud" };
  const v = createVoice({
    synth: () => ({
      speak: (u) => void spoken.push(u as UtterLike & { lang: string }),
      cancel: () => void cancels++,
    }),
    utter: (text, lang, voice, pick) =>
      ({ text, lang, voice, pick, onend: null, onerror: null, onboundary: null }) as UtterLike,
    hasDeviceVoice: (name) => (o.devices ?? []).includes(name),
    enabled: () => true,
    here: () => false,
    cloud: () => cloud,
    hasVoice: o.hasVoice,
    mode: () => flags.mode,
    aec: () => flags.aec,
    now: () => h0.t,
    log: (e) => void logs.push(e),
    report: (m) => void reports.push(m),
    setTimer: (f, ms) => {
      const t = { f, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) (t as { live: boolean }).live = false;
    },
  });
  const fire = (ms: number) => {
    for (const t of timers.filter((x) => x.live && x.ms === ms)) {
      t.live = false;
      t.f();
    }
  };
  const live = (ms: number) => timers.some((t) => t.live && t.ms === ms);
  /** Let the fetch settle and the clip's metadata arrive. */
  const loaded = async () => {
    await tick();
    el.onloadedmetadata?.();
    await tick();
  };
  return {
    v,
    el,
    pel,
    g,
    ctx,
    fetched,
    spoken,
    logs,
    reports,
    fire,
    live,
    flags,
    h0,
    loaded,
    cancels: () => cancels,
  };
}

describe("voice session: chunks and the barge-in judge", () => {
  it("cuts a sentence over CHUNK_MAX after a clause mark, else a space, else hard", () => {
    expect(chunk("short one.")).toEqual(["short one."]);
    const long = `${"a".repeat(50)}, ${"b ".repeat(80)}end.`;
    const parts = chunk(long, CHUNK_MAX);
    expect(parts.every((p) => p.length <= CHUNK_MAX)).toBe(true);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(long.replace(/\s+/g, " "));
    expect(chunk("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
    expect(chunk("一二三四五、六七八九十一二三四五", 10)).toEqual([
      "一二三四五、",
      "六七八九十一二三四五",
    ]);
    expect(chunk("aaaa bbbb cccc dddd", 10)).toEqual(["aaaa bbbb", "cccc dddd"]);
  });

  it("a barge-in needs the VAD's mean probability over BARGE_IN_PROB (none known: yes)", () => {
    expect(isBargeIn([])).toBe(true);
    expect(isBargeIn([0.9, 0.95, 0.8])).toBe(true);
    expect(isBargeIn([0.55, 0.6, 0.5])).toBe(false);
    expect(isBargeIn([BARGE_IN_PROB])).toBe(true);
  });
});

describe("voice session: ducking and barge-in (cloud route, fake GainNode)", () => {
  it("duck → restore: the user's voice ducks the clip over DUCK_ATTACK_MS, and its end restores it", async () => {
    const h = cloudHarness();
    h.v.setMic(true);
    h.v.reply("The first sentence. The second one.");
    await h.loaded();
    expect(h.el.plays).toHaveLength(1);
    expect(h.g.gain.value).toBe(1);
    expect(h.v.state()).toMatchObject({ speaking: true, hold: false, ducked: false });
    h.ctx.currentTime = 2;
    h.v.userSpeech();
    expect(h.g.calls.at(-1)).toEqual(["ramp", DUCK_LEVEL, 2 + DUCK_ATTACK_MS / 1000]);
    expect(h.v.state()).toMatchObject({ ducked: true, paused: false, speaking: true });
    expect(h.el.paused).toBe(false); // keeps playing, quieter
    expect(h.live(BARGE_IN_MS)).toBe(true);
    h.ctx.currentTime = 2.5;
    h.v.userIdle(); // speech end before BARGE_IN_MS
    expect(h.g.calls.at(-1)).toEqual(["ramp", 1, 2.5 + DUCK_RELEASE_MS / 1000]);
    expect(h.v.state()).toMatchObject({ ducked: false, paused: false });
    expect(h.live(BARGE_IN_MS)).toBe(false);
    expect(h.live(IDLE_RESUME_MS)).toBe(false);
    expect(h.logs.some((l) => l.ev === "voice-duck" && l.route === "audio")).toBe(true);
  });

  it("duck → sustained → hard-pause, and the clip resumes by its offset", async () => {
    const h = cloudHarness();
    h.v.setMic(true);
    h.v.reply("The first sentence. The second one.");
    await h.loaded();
    h.v.userSpeech();
    for (const p of [0.9, 0.85, 0.95]) h.v.userFrame(p);
    h.el.currentTime = 1.8;
    h.fire(BARGE_IN_MS);
    expect(h.el.paused).toBe(true);
    expect(h.v.state()).toMatchObject({ paused: true, ducked: false, speaking: false, queued: 2 });
    expect(h.logs.find((l) => l.ev === "voice-barge-in")?.prob).toBeCloseTo(0.9, 5);
    // The user finishes: read on after the idle, from where the clip stopped (less the rewind), at full volume.
    h.v.userIdle();
    h.fire(IDLE_RESUME_MS);
    await h.loaded();
    expect(h.el.plays.at(-1)?.at).toBeCloseTo(1.8 - RESUME_REWIND_S, 5);
    expect(h.g.gain.value).toBe(1);
    expect(h.fetched).toHaveLength(2); // the 1st sentence once (cached), the 2nd prefetched
    // Ends: on to the next sentence, from its start.
    h.el.onended?.();
    await h.loaded();
    expect(h.el.plays.at(-1)).toMatchObject({ at: 0 });
    expect(h.el.src).toBe(`blob:${"The second one.".length}`);
  });

  it("weak speech (likely echo) stays ducked and is judged again; a later strong window barges in", async () => {
    const h = cloudHarness();
    h.v.setMic(true);
    h.v.reply("Hello there.");
    await h.loaded();
    h.v.userSpeech();
    for (const p of [0.55, 0.6]) h.v.userFrame(p);
    h.fire(BARGE_IN_MS);
    expect(h.v.state()).toMatchObject({ ducked: true, paused: false });
    expect(h.live(BARGE_IN_MS)).toBe(true);
    expect(h.logs.some((l) => l.ev === "voice-duck-hold")).toBe(true);
    h.v.userSpeech(); // a second start while ducked: no second duck
    expect(h.logs.filter((l) => l.ev === "voice-duck")).toHaveLength(1);
    h.v.userFrame(0.9);
    h.fire(BARGE_IN_MS);
    expect(h.v.state()).toMatchObject({ ducked: false, paused: true });
  });

  it("a tap or Stop reading while ducked ends the duck", async () => {
    const h = cloudHarness();
    h.v.setMic(true);
    h.v.reply("One. Two.");
    await h.loaded();
    h.v.userSpeech();
    h.v.interrupt("tap");
    expect(h.v.state()).toMatchObject({ ducked: false, paused: true });
    h.v.resume();
    await h.loaded();
    h.v.userSpeech();
    h.v.stop();
    expect(h.v.state()).toMatchObject({ ducked: false, queued: 0, speaking: false });
  });

  it("speech mode: the duck applies from the next sentence (iOS cannot change an utterance's volume)", () => {
    const h = cloudHarness({ mode: "speech" });
    h.v.setMic(true);
    h.v.reply("One. Two. Three.");
    expect(h.spoken[0].volume).toBeUndefined();
    h.v.userSpeech();
    expect(h.v.state().ducked).toBe(true);
    h.spoken[0].onend?.();
    expect(h.spoken[1].volume).toBe(DUCK_LEVEL);
    h.v.userIdle();
    h.spoken[1].onend?.();
    expect(h.spoken[2].volume).toBeUndefined();
    expect(h.v.mode()).toBe("speech");
    expect(h.logs[0]).toMatchObject({ ev: "voice-out", out: "speech", route: "speech" });
  });

  it("speech mode: sustained speech pauses at the last word boundary", () => {
    const h = cloudHarness({ mode: "speech" });
    h.v.setMic(true);
    h.v.reply("The quick brown fox.");
    h.spoken[0].onboundary?.({ charIndex: 10, name: "word" });
    h.v.userSpeech();
    h.fire(BARGE_IN_MS);
    expect(h.cancels()).toBe(1);
    h.v.resume();
    expect(h.spoken.at(-1)?.text).toBe("brown fox.");
  });

  it("aec off: the old way — capture held while the agent speaks, user speech pauses at once", () => {
    const h = cloudHarness({ mode: "speech", aec: false });
    h.v.setMic(true);
    h.v.reply("One. Two.");
    expect(h.v.state()).toMatchObject({ speaking: true, hold: true });
    h.v.userSpeech();
    expect(h.v.state()).toMatchObject({ ducked: false, paused: true, hold: false });
    expect(h.v.aec()).toBe(false);
  });

  it("no utterance playing: the user's speech interrupts as before", () => {
    const h = cloudHarness({ mode: "speech" });
    h.v.setMic(true);
    h.v.userSpeech(); // nothing queued: a no-op
    expect(h.v.state()).toMatchObject({ paused: false, ducked: false });
    h.v.reply("Hi.");
    h.v.interrupt("typing");
    h.v.userSpeech(); // paused, nothing playing: another pause reason, no duck
    expect(h.v.state()).toMatchObject({ paused: true, ducked: false });
  });
});

describe("voice session: the cloud route falls back to speech per sentence", () => {
  it("a 404 miss or a refused play: that sentence is spoken", async () => {
    const h = cloudHarness({ status: (t) => (t.startsWith("Missing") ? 404 : 200) });
    h.v.setMic(true);
    h.v.reply("Missing clip. Fine clip.");
    await tick();
    expect(h.spoken.map((u) => u.text)).toEqual(["Missing clip."]);
    expect(h.logs.find((l) => l.fallback)).toMatchObject({
      ev: "voice-out",
      out: "cloud",
      route: "speech",
      fallback: "http 404 miss",
    });
    h.spoken[0].onend?.();
    await h.loaded();
    expect(h.el.plays).toHaveLength(1);
    h.el.onended?.();
    // The element refuses to play (no gesture yet on iOS).
    h.el.refuse = true;
    h.v.reply("Refused here.");
    await h.loaded();
    expect(h.spoken.at(-1)?.text).toBe("Refused here.");
    expect(h.logs.at(-1)).toMatchObject({ fallback: "play NotAllowedError" });
  });

  it("a fallback with no speechSynthesis skips the sentence", async () => {
    const h = cloudHarness({ status: () => 503 });
    const v = createVoice({
      synth: () => null,
      utter: () => ({}) as UtterLike,
      enabled: () => true,
      here: () => true,
      cloud: () =>
        createCloudOut({
          fetch: async () => ({
            ok: false,
            status: 503,
            headers: { get: () => null },
            blob: async () => new Blob(),
          }),
          element: () => h.el,
          ctx: () => null,
        }),
      mode: () => "cloud",
    });
    expect(v.reply("Nothing can say this.")).toBe(true);
    await tick();
    await tick();
    expect(v.state()).toMatchObject({ queued: 0 });
  });
});

describe("voice session: no speechSynthesis voice for the language → the cloud reads it", () => {
  it("speech mode, getVoices() empty (Android Chrome): read through /api/words/tts, not silent", async () => {
    const h = cloudHarness({ mode: "speech", hasVoice: () => false });
    h.v.setMic(true);
    expect(h.v.reply("你好。")).toBe(true);
    await h.loaded();
    expect(h.spoken).toEqual([]);
    expect(h.el.plays).toHaveLength(1);
    expect(h.fetched[0]).toContain("/api/words/tts?lang=zh&text=");
    expect(h.logs.find((l) => l.ev === "voice-out")).toMatchObject({
      out: "cloud",
      route: "audio",
      fallback: "no-voice",
    });
  });

  it("speech mode with a voice for the language stays on speechSynthesis", async () => {
    const h = cloudHarness({ mode: "speech", hasVoice: (l) => l.startsWith("en") });
    h.v.setMic(true);
    h.v.reply("Hello there.");
    await tick();
    expect(h.spoken.map((u) => u.text)).toEqual(["Hello there."]);
    expect(h.fetched).toEqual([]);
    // A language it has no voice for, in the same session: the cloud.
    h.spoken[0].onend?.();
    h.v.reply("こんにちは。");
    await h.loaded();
    expect(h.el.plays).toHaveLength(1);
    expect(h.spoken).toHaveLength(1);
  });

  it("no speechSynthesis at all, cloud available: replies are still read (canSpeak)", async () => {
    const h = cloudHarness();
    const v = createVoice({
      synth: () => null,
      utter: () => ({}) as UtterLike,
      enabled: () => true,
      here: () => true,
      cloud: () =>
        createCloudOut({
          fetch: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            blob: async () => new Blob(["x"]),
          }),
          element: () => h.el,
          ctx: () => null,
          toUrl: () => "blob:x",
        }),
      mode: () => "speech",
    });
    expect(v.reply("Read me.")).toBe(true);
    await h.loaded();
    expect(h.el.plays).toHaveLength(1);
  });
});

describe("voice session: the echo check", () => {
  it("matches what the agent said in the window, and says whether it was audible during the utterance", () => {
    const h = cloudHarness({ mode: "speech" });
    h.v.setMic(true);
    h.h0.t = 1_000;
    h.v.reply("I pushed the branch to origin.");
    h.h0.t = 3_000;
    const during = h.v.echoCheck("pushed the branch to origin", 1_500);
    expect(during).toMatchObject({ drop: true, during: true, score: 1 });
    h.spoken[0].onend?.();
    h.h0.t = 3_000 + ECHO_WINDOW_MS - 100;
    expect(h.v.echoCheck("pushed the branch to origin", 500)).toMatchObject({
      drop: true,
      during: false,
    });
    h.h0.t = 3_000 + ECHO_WINDOW_MS + 2_000;
    expect(h.v.echoCheck("pushed the branch to origin", 500)).toMatchObject({
      drop: false,
      during: false,
    });
    expect(h.v.echoCheck("something else entirely", 0).drop).toBe(false);
  });

  it("a dropped echo that caused a barge-in reads on at once", async () => {
    const h = cloudHarness();
    h.v.setMic(true);
    h.v.reply("A long sentence here. And more.");
    await h.loaded();
    h.v.userSpeech();
    h.fire(BARGE_IN_MS);
    expect(h.v.state().paused).toBe(true);
    h.v.echoDropped();
    expect(h.v.state().paused).toBe(false);
    // Paused by typing: an echo drop does not resume it.
    h.v.interrupt("typing");
    h.v.echoDropped();
    expect(h.v.state().paused).toBe(true);
  });

  it("setLog redirects the debug events; log() goes there too", () => {
    const h = cloudHarness({ mode: "speech" });
    const seen: unknown[] = [];
    h.v.setLog((e) => seen.push(e));
    h.v.log({ ev: "x" });
    h.v.setMic(true);
    h.v.reply("Hi.");
    expect(seen).toEqual([{ ev: "x" }, expect.objectContaining({ ev: "voice-out" })]);
  });
});

describe("resuming where the reading was (resumeOffset, heardFraction)", () => {
  it("resumeOffset: rounds DOWN to the start of a sentence or clause, never skipping", () => {
    const t = "今天先复习单词，然后做听力。最后休息一下！";
    // Half heard: back to after the last mark before the middle.
    expect(t.slice(resumeOffset(t, 0.5))).toBe("然后做听力。最后休息一下！");
    expect(t.slice(resumeOffset(t, 0.75))).toBe("最后休息一下！");
    expect(resumeOffset(t, 0.1)).toBe(0); // no mark passed yet: from the start
    expect(resumeOffset(t, 0)).toBe(0);
    const en = "First we review, then we listen. Then rest.";
    expect(en.slice(resumeOffset(en, 0.9))).toBe("Then rest.");
    expect(en.slice(resumeOffset(en, 0.5))).toBe("then we listen. Then rest.");
    expect("one\ntwo\nthree".slice(resumeOffset("one\ntwo\nthree", 0.8))).toBe("three");
    expect(resumeOffset("", 0.5)).toBe(0);
    expect(resumeOffset("abc", 7)).toBe(0); // clamped, and no mark at all
  });

  it("heardFraction: by the reading speed, CJK slower per character, capped at 1", () => {
    expect(heardFraction("你好你好你好你好你好", 1000)).toBeCloseTo(0.5, 5); // 5 chars/s of 10
    expect(heardFraction("a".repeat(28), 1000, 1)).toBeCloseTo(0.5, 5); // 14 chars/s of 28
    expect(heardFraction("a".repeat(28), 1000, 2)).toBeCloseTo(1, 5);
    expect(heardFraction("abc", 0)).toBe(0);
    expect(heardFraction("", 500)).toBe(0);
  });
});

describe("voice session: resume after a pause", () => {
  function timed() {
    let t = 0;
    const spoken: UtterLike[] = [];
    const v = createVoice({
      synth: () => ({ speak: (u) => void spoken.push(u), cancel: () => {} }),
      utter: (text) => ({ text, onend: null, onerror: null, onboundary: null }) as UtterLike,
      enabled: () => true,
      here: () => true,
      now: () => t,
      setTimer: () => ({}),
      clearTimer: () => {},
    });
    v.setMic(true);
    return { v, spoken, advance: (ms: number) => void (t += ms) };
  }

  it("goes on from the sentence it was on, not from the reply's first", () => {
    const h = timed();
    h.v.reply("One. Two. Three.");
    h.spoken.at(-1)?.onend?.(); // "One." done
    h.spoken.at(-1)?.onend?.(); // "Two." done
    expect(h.spoken.at(-1)?.text).toBe("Three.");
    h.v.interrupt("speech");
    h.v.resume();
    expect(h.spoken.map((u) => u.text)).toEqual(["One.", "Two.", "Three.", "Three."]);
  });

  it("no word boundaries (Android voices): the place is estimated, rounded down to a clause", () => {
    const h = timed();
    // One long utterance (no sentence stop inside): commas only.
    h.v.reply("今天先复习单词，然后做听力，最后休息一下");
    h.advance(2_000); // 10 of 19 characters at 5/s
    h.v.interrupt("speech");
    h.v.resume();
    expect(h.spoken.at(-1)?.text).toBe("然后做听力，最后休息一下");
  });

  it("a reply delivered again is not read again; a new reply while paused waits its turn", () => {
    const h = timed();
    h.v.reply("Alpha. Beta.");
    h.v.interrupt("typing");
    expect(h.v.reply("Alpha. Beta.")).toBe(false); // a reconnect re-sent it
    expect(h.v.reply("Gamma.")).toBe(true); // queued behind the rest
    h.v.resume();
    h.spoken.at(-1)?.onend?.();
    h.spoken.at(-1)?.onend?.();
    expect(h.spoken.map((u) => u.text)).toEqual(["Alpha.", "Alpha.", "Beta.", "Gamma."]);
    // Long after, the same words are a new reply.
    h.advance(REPLY_DEDUPE_MS + 1);
    expect(h.v.reply("Alpha. Beta.")).toBe(true);
  });
});

describe("voice session: never silent without saying so (Android, no speechSynthesis voices; 2026-11-03)", () => {
  it("a refused clip with no voice to fall back on: kept, the chat is told (blocked), reported; a tap reads on", async () => {
    const h = cloudHarness({ hasVoice: () => false });
    h.v.setMic(true);
    h.el.refuse = true;
    expect(h.v.reply("第一句。")).toBe(true);
    await h.loaded();
    expect(h.spoken).toEqual([]); // never handed to a silent speechSynthesis
    expect(h.v.state()).toMatchObject({ blocked: true, paused: true, speaking: false, queued: 1 });
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toContain("playback blocked");
    expect(h.logs.find((l) => l.ev === "voice-blocked")).toMatchObject({
      reason: "play NotAllowedError",
    });
    // A line arriving meanwhile is queued, not dropped.
    expect(h.v.reply("第二句。")).toBe(true);
    expect(h.v.state()).toMatchObject({ blocked: true, queued: 2 });
    // The tap.
    h.el.refuse = false;
    h.v.unblock();
    await h.loaded();
    expect(h.el.plays).toHaveLength(1);
    expect(h.v.state()).toMatchObject({ blocked: false, speaking: true, queued: 2 });
    h.el.onended?.();
    await h.loaded();
    expect(h.el.plays).toHaveLength(2);
    expect(h.reports).toHaveLength(1);
  });

  it("a cloud failure with no voice to fall back on skips that sentence (reported) and reads the next", async () => {
    const h = cloudHarness({
      hasVoice: () => false,
      status: (t) => (t.startsWith("坏") ? 503 : 200),
    });
    h.v.setMic(true);
    h.v.reply("坏的一句。好的一句。");
    await h.loaded();
    await h.loaded();
    expect(h.spoken).toEqual([]);
    expect(h.el.plays).toHaveLength(1);
    expect(h.reports[0]).toContain("http 503");
    expect(h.logs.find((l) => l.route === "none")).toMatchObject({ fallback: "http 503" });
  });

  it("speechSynthesis with no voice that never starts is given up on after SPEECH_START_MS", async () => {
    const spoken: UtterLike[] = [];
    const timers: { f: () => void; ms: number; live: boolean }[] = [];
    const reports: string[] = [];
    const v = createVoice({
      synth: () => ({ speak: (u) => void spoken.push(u), cancel: () => {} }),
      utter: (text) => ({ text, onend: null, onerror: null, onboundary: null }) as UtterLike,
      enabled: () => true,
      here: () => true,
      hasVoice: () => false,
      report: (m) => void reports.push(m),
      setTimer: (f, ms) => {
        const t = { f, ms, live: true };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        if (t) (t as { live: boolean }).live = false;
      },
    });
    v.reply("One. Two.");
    expect(spoken.map((u) => u.text)).toEqual(["One."]);
    for (const t of timers.filter((x) => x.live && x.ms === SPEECH_START_MS)) {
      t.live = false;
      t.f();
    }
    expect(spoken.map((u) => u.text)).toEqual(["One.", "Two."]);
    expect(reports[0]).toContain("never started");
    // The given-up one's late end does not move the queue past "Two." (Codex).
    spoken[0].onend?.();
    expect(v.state().queued).toBe(1);
    // One that starts is not given up on.
    spoken[1].onstart?.();
    expect(timers.filter((x) => x.live && x.ms === SPEECH_START_MS)).toHaveLength(0);
  });

  it("speechSynthesis refusing (not-allowed, no tap yet) waits for the tap instead of skipping", () => {
    const spoken: UtterLike[] = [];
    const v = createVoice({
      synth: () => ({ speak: (u) => void spoken.push(u), cancel: () => {} }),
      utter: (text) => ({ text, onend: null, onerror: null, onboundary: null }) as UtterLike,
      enabled: () => true,
      here: () => true,
    });
    v.reply("Hello.");
    spoken[0].onerror?.({ error: "not-allowed" });
    expect(v.state()).toMatchObject({ blocked: true, queued: 1 });
    v.unblock();
    expect(spoken.map((u) => u.text)).toEqual(["Hello.", "Hello."]);
    expect(v.state().blocked).toBe(false);
  });
});

describe("voice session: a line's own voice (voices.ts parseLineVoice)", () => {
  const JESSICA = "cgSgspJ2msm6clMCkdW9";

  it("device:<name> the device has: speechSynthesis in that voice, even in cloud mode", async () => {
    const h = cloudHarness({ mode: "cloud", devices: ["Meijia"] });
    h.v.setMic(true);
    h.v.reply("你好。", { voice: "device:Meijia" });
    await tick();
    expect(h.fetched).toEqual([]);
    expect(h.spoken[0]).toMatchObject({ text: "你好。", pick: { kind: "device", name: "Meijia" } });
    expect(h.logs.find((l) => l.ev === "voice-out")).toMatchObject({
      out: "speech",
      pick: "device",
    });
  });

  it("device:<name> the device lacks: the usual route and voice, never silence", async () => {
    const h = cloudHarness({ mode: "cloud", devices: [] });
    h.v.setMic(true);
    h.v.reply("你好。", { voice: "device:Nobody" });
    await h.loaded();
    expect(h.spoken).toEqual([]);
    expect(h.el.plays).toHaveLength(1);
    expect(h.fetched[0]).toContain("/api/words/tts?lang=zh&");
    expect(h.fetched[0]).not.toContain("speaker=");
    expect(h.logs.find((l) => l.ev === "voice-out")).toMatchObject({
      pick: "device",
      missing: true,
    });
  });

  it("aura:<speaker> goes to the cloud with that speaker even in speech mode, in its language", async () => {
    const h = cloudHarness({ mode: "speech", hasVoice: () => true });
    h.v.setMic(true);
    h.v.reply("Hello there.", { voice: "aura:thalia" });
    await h.loaded();
    expect(h.spoken).toEqual([]);
    expect(h.fetched[0]).toContain("lang=en&");
    expect(h.fetched[0]).toContain("speaker=thalia");
    expect(h.el.plays).toHaveLength(1);
    expect((h.el as unknown as { playbackRate?: number }).playbackRate).toBe(1);
  });

  it("melo:<lang> asks for that language's one voice, no speaker", async () => {
    const h = cloudHarness({ mode: "speech", hasVoice: () => true });
    h.v.setMic(true);
    h.v.reply("こんにちは。", { voice: "melo:ja" });
    await h.loaded();
    expect(h.fetched[0]).toContain("/api/words/tts?lang=ja&");
    expect(h.fetched[0]).not.toContain("speaker=");
    expect(h.el.plays).toHaveLength(1);
  });

  it("eleven:<id> plays the public preview on its own element, straight from ElevenLabs", async () => {
    const h = cloudHarness({ mode: "speech", hasVoice: () => true });
    h.v.setMic(true);
    h.v.reply("Try Jessica. She is cute.", { voice: `eleven:${JESSICA}` });
    await tick();
    expect(h.fetched).toEqual([]);
    expect(h.el.plays).toEqual([]);
    expect(h.pel.plays).toHaveLength(1);
    expect(h.pel.plays[0]!.src).toStartWith(
      `https://storage.googleapis.com/eleven-public-prod/premade/voices/${JESSICA}/`,
    );
    expect(h.v.state().queued).toBe(1);
    h.pel.onended?.();
    expect(h.v.state().queued).toBe(0);
  });

  it("eleven:<id> refused (no tap yet): the line is read in its lane's voice instead", async () => {
    const h = cloudHarness({ mode: "speech", hasVoice: () => true });
    h.pel.refuse = true;
    h.v.setMic(true);
    h.v.reply("One. Two.", { voice: `eleven:${JESSICA}` });
    await tick();
    await tick();
    expect(h.spoken.map((u) => u.text)).toEqual(["One."]);
    expect(h.spoken[0]!.pick).toBeUndefined();
    expect(h.logs.find((l) => l.out === "eleven")).toMatchObject({ route: "lane" });
    h.spoken[0]!.onend?.();
    expect(h.spoken.map((u) => u.text)).toEqual(["One.", "Two."]);
  });

  it("the same words in another voice are read again (a demo), a re-delivery is not", async () => {
    const h = cloudHarness({ mode: "speech", hasVoice: () => true });
    h.v.setMic(true);
    expect(h.v.reply("Hi.", { voice: "main" })).toBe(true);
    expect(h.v.reply("Hi.", { voice: "calm" })).toBe(true);
    expect(h.v.reply("Hi.", { voice: "calm" })).toBe(false);
    expect(h.v.state().queued).toBe(2);
  });

  it("an id the parser refuses is no voice of its own: the lane's", async () => {
    const h = cloudHarness({ mode: "speech", hasVoice: () => true });
    h.v.setMic(true);
    h.v.reply("Hello.", { voice: "aura:nope" });
    await tick();
    expect(h.spoken[0]).toMatchObject({ text: "Hello.", pick: undefined });
    expect(h.fetched).toEqual([]);
  });
});
