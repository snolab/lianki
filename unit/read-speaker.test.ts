// /read's speaker with fake browser pieces: nothing here makes a sound.
import { describe, expect, it } from "bun:test";
import { createReadSpeaker, WATCHDOG_MS, type UtterLike, type AudioLike } from "@/lib/read/speaker";
import { captureHeld, createPageAudio } from "@lianki/debug-chat/page-audio";

type Timer = { f: () => void; at: number; id: number };
function setup(
  o: {
    voices?: { lang: string; name: string }[];
    mode?: "speech" | "cloud";
    fetchOk?: boolean;
  } = {},
) {
  let t = 0;
  let nid = 0;
  const timers: Timer[] = [];
  const setTimer = (f: () => void, ms: number) => {
    const tm = { f, at: t + ms, id: ++nid };
    timers.push(tm);
    return tm.id;
  };
  const clearTimer = (id: unknown) => {
    const i = timers.findIndex((x) => x.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  const advance = (ms: number) => {
    t += ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > t) break;
      timers.shift();
      due.f();
    }
  };
  const page = createPageAudio({ setTimer, clearTimer, now: () => t });
  const spoken: UtterLike[] = [];
  let cancels = 0;
  const synth = {
    speak: (u: UtterLike) => void spoken.push(u),
    cancel: () => void cancels++,
    getVoices: () => o.voices ?? [],
  };
  const fetched: string[] = [];
  const audio: AudioLike & { plays: string[] } = {
    src: "",
    paused: true,
    onended: null,
    onerror: null,
    plays: [],
    play() {
      this.plays.push(this.src);
      return Promise.resolve();
    },
    pause() {},
  };
  const logs: Record<string, unknown>[] = [];
  const sp = createReadSpeaker({
    mode: () => o.mode ?? "speech",
    synth: () => synth,
    utterance: (text) => ({
      text,
      lang: "",
      voice: null,
      rate: 1,
      onstart: null,
      onend: null,
      onerror: null,
    }),
    fetch: async (url) => {
      fetched.push(url);
      return {
        ok: o.fetchOk ?? true,
        status: o.fetchOk === false ? 503 : 200,
        blob: async () => new Blob(["x"]),
      };
    },
    audio: () => audio,
    toUrl: () => `blob:${fetched.length}`,
    revoke: () => {},
    pageAudio: () => page,
    setTimer,
    clearTimer,
    log: (e) => void logs.push(e),
  });
  const result: string[] = [];
  const cb = {
    onend: () => void result.push("end"),
    onerror: (w: string) => void result.push(`error:${w}`),
  };
  return {
    sp,
    spoken,
    synth,
    audio,
    fetched,
    page,
    advance,
    result,
    cb,
    cancels: () => cancels,
    logs,
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const FR = { lang: "fr-FR", name: "Thomas" };
const EN = { lang: "en-US", name: "Samantha" };

describe("read speaker", () => {
  it("reads French with a French browser voice, sentence by sentence, then ends once", () => {
    const x = setup({ voices: [EN, FR] });
    x.sp.speak("Bonjour. Au revoir.", "fr", x.cb);
    expect(x.spoken.map((u) => [u.text, u.voice?.name])).toEqual([["Bonjour.", "Thomas"]]);
    x.spoken[0].onstart?.();
    x.spoken[0].onend?.();
    expect(x.spoken[1]).toMatchObject({ text: "Au revoir.", lang: "fr-FR" });
    expect(x.result).toEqual([]);
    x.spoken[1].onstart?.();
    x.spoken[1].onend?.();
    x.spoken[1].onend?.();
    expect(x.result).toEqual(["end"]);
  });

  it("a /read utterance holds the mic, echo cancellation on or not, and its text feeds the echo guard", () => {
    const x = setup({ voices: [FR] });
    x.sp.speak("Chapitre trois.", "fr", x.cb);
    expect(x.page.playing()).toBe(true);
    expect(x.page.always()).toBe(true);
    // AEC on (true) still holds for /read's audio; /words' plain sounds would not.
    expect(captureHeld(false, x.page.playing(), true, x.page.always())).toBe(true);
    expect(x.page.said(0, 10_000).map((r) => r.text)).toEqual(["Chapitre trois."]);
    x.spoken[0].onstart?.();
    x.spoken[0].onend?.();
    // The tail: the mic opens 400 ms after the line's audio ended, not before.
    expect(x.page.always()).toBe(true);
    x.advance(400);
    expect(x.page.playing()).toBe(false);
    expect(captureHeld(false, x.page.playing(), true, x.page.always())).toBe(false);
  });

  it("an onend with nothing started is a failure, not an instant advance", async () => {
    const x = setup({ voices: [{ lang: "de-DE", name: "Anna" }] });
    x.sp.speak("Guten Tag.", "de", x.cb);
    x.spoken[0].onend?.();
    // de has no server voice either: the line fails with a reason.
    expect(x.result).toEqual(["error:the browser voice did not start"]);
  });

  it("a browser voice that never starts falls back to the server voice", async () => {
    const x = setup({ voices: [FR] });
    x.sp.speak("Bonjour.", "fr", x.cb);
    x.advance(WATCHDOG_MS);
    await flush();
    expect(x.fetched).toEqual(["/api/words/tts?lang=fr&text=Bonjour."]);
    x.audio.onended?.();
    expect(x.result).toEqual(["end"]);
  });

  it("after falling back, the failed voice's watchdog and late callbacks are ignored", async () => {
    const x = setup({ voices: [FR] });
    x.sp.speak("Bonjour.", "fr", x.cb);
    const u = x.spoken[0];
    u.onend?.(); // ended without starting: the server voice takes over
    await flush();
    expect(x.fetched.length).toBe(1);
    x.advance(WATCHDOG_MS * 2);
    u.onerror?.({ error: "synthesis-failed" });
    u.onend?.();
    expect(x.result).toEqual([]);
    x.audio.onended?.();
    expect(x.result).toEqual(["end"]);
  });

  it("a long paragraph keeps the mic held past the 30 s cap, sentence by sentence", () => {
    const x = setup({ voices: [FR] });
    x.sp.speak("Une phrase. Une autre phrase. Et la dernière.", "fr", x.cb);
    for (let i = 0; i < 3; i++) {
      x.spoken[i].onstart?.();
      x.advance(25_000);
      expect(x.page.always()).toBe(true);
      x.spoken[i].onend?.();
    }
    expect(x.result).toEqual(["end"]);
    expect(x.page.said(0, 100_000).map((r) => r.text)).toEqual([
      "Une phrase.",
      "Une autre phrase.",
      "Et la dernière.",
    ]);
    x.advance(400);
    expect(x.page.playing()).toBe(false);
  });

  it("no browser voice for French: the server voice reads it (lk:voice-out speech)", async () => {
    const x = setup({ voices: [EN] });
    x.sp.speak("Bonjour.", "fr-FR", x.cb);
    await flush();
    expect(x.spoken).toEqual([]);
    expect(x.fetched[0]).toContain("lang=fr&");
  });

  it("lk:voice-out cloud uses the server voice first", async () => {
    const x = setup({ voices: [FR], mode: "cloud" });
    x.sp.speak("Salut.", "fr", x.cb);
    await flush();
    expect(x.spoken).toEqual([]);
    expect(x.fetched.length).toBe(1);
  });

  it("both engines failing stops with the reason", async () => {
    const x = setup({ voices: [], fetchOk: false });
    x.sp.speak("Bonjour.", "fr", x.cb);
    await flush();
    await flush();
    expect(x.result).toEqual(["error:server voice: HTTP 503"]);
    expect(x.page.always()).toBe(true);
    x.advance(400);
    expect(x.page.playing()).toBe(false);
  });

  it("a browser voice that throws is a failure, not a crash", async () => {
    const x = setup({ voices: [FR], fetchOk: false });
    x.synth.speak = () => {
      throw new TypeError("Failed to set the 'voice' property");
    };
    x.sp.speak("Bonjour.", "fr", x.cb);
    await flush();
    await flush();
    expect(x.result).toEqual(["error:server voice: HTTP 503"]);
  });

  it("no voice at all for the language fails at once", () => {
    const x = setup({ voices: [EN] });
    x.sp.speak("Здравствуйте.", "ru", x.cb);
    expect(x.result).toEqual(["error:no voice for ru on this device"]);
  });

  it("cancel stops it: later events are ignored and the hold ends", () => {
    const x = setup({ voices: [FR] });
    const cancel = x.sp.speak("Un. Deux.", "fr", x.cb);
    x.spoken[0].onstart?.();
    cancel();
    expect(x.cancels()).toBe(1);
    x.spoken[0].onerror?.({ error: "interrupted" });
    x.spoken[0].onend?.();
    expect(x.result).toEqual([]);
    expect(x.spoken.length).toBe(1);
    x.advance(400);
    expect(x.page.playing()).toBe(false);
  });

  it("a new line cancels the one still speaking", () => {
    const x = setup({ voices: [FR] });
    x.sp.speak("Un.", "fr", x.cb);
    const first = x.spoken[0];
    x.sp.speak("Deux.", "fr", x.cb);
    first.onstart?.();
    first.onend?.();
    expect(x.result).toEqual([]);
    x.spoken[1].onstart?.();
    x.spoken[1].onend?.();
    expect(x.result).toEqual(["end"]);
  });
});

describe("page audio: the page listens (shadowing) and knows the mic", () => {
  it("heard() goes to the listener, which may consume it", () => {
    const p = createPageAudio();
    expect(p.heard("x", 0)).toBe(false);
    p.listen((t) => t === "mine");
    expect(p.heard("mine", 0)).toBe(true);
    expect(p.heard("other", 0)).toBe(false);
    p.listen(null);
    expect(p.heard("mine", 0)).toBe(false);
  });

  it("setMic tells subscribers", () => {
    const p = createPageAudio();
    let n = 0;
    p.subscribe(() => n++);
    p.setMic(true);
    p.setMic(true);
    expect(p.mic()).toBe(true);
    expect(n).toBe(1);
  });
});

describe("read speaker: engines and unlock", () => {
  it("engineFor follows lk:voice-out and what the device has", () => {
    expect(setup({ voices: [FR] }).sp.engineFor("fr")).toBe("speech");
    expect(setup({ voices: [FR], mode: "cloud" }).sp.engineFor("fr")).toBe("cloud");
    expect(setup({ voices: [EN] }).sp.engineFor("fr")).toBe("cloud");
    expect(setup({ voices: [EN] }).sp.engineFor("ru")).toBeNull();
  });

  it("unlock plays a silent clip on the element, once it is paused", () => {
    const x = setup();
    x.sp.unlock();
    expect(x.audio.plays.length).toBe(1);
    expect(x.audio.plays[0].startsWith("data:audio/wav;base64,")).toBe(true);
  });

  it("an empty line ends on the next tick, holding nothing", () => {
    const x = setup({ voices: [FR] });
    x.sp.speak("   ", "fr", x.cb);
    expect(x.result).toEqual([]);
    expect(x.page.playing()).toBe(false);
    x.advance(0);
    expect(x.result).toEqual(["end"]);
  });

  it("cancel() stops whatever speaks, and a clip that fails to play falls back", async () => {
    const x = setup({ voices: [FR], mode: "cloud" });
    x.sp.speak("Salut.", "fr", x.cb);
    await flush();
    await flush();
    x.audio.onerror?.();
    expect(x.spoken.length).toBe(1);
    x.sp.cancel();
    x.spoken[0].onstart?.();
    x.spoken[0].onend?.();
    expect(x.result).toEqual([]);
  });
});
