import { describe, expect, it } from "bun:test";
import {
  IDLE_RESUME_MS,
  RESUME_TAIL_MS,
  SPEAK_KEY,
  type UtterLike,
  createVoice,
  sentences,
  speakHere,
  speechEnabled,
  voice,
} from "@lianki/debug-chat/voice";

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
function harness(o: { enabled?: boolean; here?: boolean } = {}) {
  const spoken: (UtterLike & { lang: string })[] = [];
  let cancels = 0;
  const flags = { enabled: o.enabled ?? true, here: o.here ?? false, synth: true };
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
      ["speechSynthesis", "SpeechSynthesisUtterance", "localStorage", "document", "__lkVoice"].map(
        (k) => [k, g[k]],
      ),
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
