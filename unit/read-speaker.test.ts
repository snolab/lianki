// /read's speaker with fake browser pieces: nothing here makes a sound.
import { describe, expect, it } from "bun:test";
import { createReadSpeaker, WATCHDOG_MS, type UtterLike, type AudioLike } from "@/lib/read/speaker";
import { captureHeld, createPageAudio } from "@lianki/debug-chat/page-audio";
import { AUDIO_PRIO, audioOwner } from "@lianki/debug-chat/audio-claim";

type Timer = { f: () => void; at: number; id: number };
type FakeAudio = AudioLike & { plays: string[]; loads: string[] };
function setup(
  o: {
    voices?: { lang: string; name: string }[];
    mode?: "speech" | "cloud";
    fetchOk?: boolean;
    /** The status of a failed fetch (default 503). */
    failStatus?: number;
    held?: boolean;
    /** The page the audio owner claims on (absent: no owner). */
    claims?: EventTarget;
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
  /** Every element the speaker made, and every play() in order (the fake audio clock). */
  const audios: FakeAudio[] = [];
  const played: { el: FakeAudio; src: string; at: number }[] = [];
  let playing: FakeAudio | null = null;
  const makeAudio = (): FakeAudio => {
    const a: FakeAudio = {
      src: "",
      paused: true,
      onended: null,
      onerror: null,
      plays: [],
      loads: [],
      play() {
        a.plays.push(a.src);
        played.push({ el: a, src: a.src, at: t });
        playing = a;
        return Promise.resolve();
      },
      pause() {},
      load() {
        a.loads.push(a.src);
      },
    };
    audios.push(a);
    return a;
  };
  /** A fetch held open until the test answers it (`o.held`), else answered at once. */
  const pending: { url: string; answer(ok?: boolean): void; aborted: boolean }[] = [];
  const textOf = new WeakMap<Blob, string>();
  const revoked: string[] = [];
  let nurl = 0;
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
    fetch: (url, init) => {
      fetched.push(url);
      const res = (ok = o.fetchOk ?? true) => ({
        ok,
        status: ok ? 200 : (o.failStatus ?? 503),
        blob: async () => {
          const b = new Blob([url]);
          textOf.set(b, new URL(url, "https://x").searchParams.get("text") ?? "");
          return b;
        },
      });
      if (!o.held) return Promise.resolve(res());
      return new Promise((resolve, reject) => {
        const p = { url, aborted: false, answer: (ok?: boolean) => resolve(res(ok)) };
        init?.signal?.addEventListener("abort", () => {
          p.aborted = true;
          reject(new Error("aborted"));
        });
        pending.push(p);
      });
    },
    audio: makeAudio,
    toUrl: (b) => `blob:${++nurl}:${textOf.get(b)}`,
    revoke: (u) => void revoked.push(u),
    pageAudio: () => page,
    setTimer,
    clearTimer,
    log: (e) => void logs.push(e),
    owner: o.claims ? (h) => audioOwner({ ...h, id: "read", target: o.claims }) : undefined,
  });
  const result: string[] = [];
  const cb = {
    onend: () => void result.push("end"),
    onerror: (w: string, noVoice?: boolean) =>
      void result.push(`error:${w}${noVoice ? " [no-voice]" : ""}`),
  };
  return {
    sp,
    spoken,
    synth,
    /** The element that played last. */
    get audio(): FakeAudio {
      return playing ?? audios[0];
    },
    audios,
    played,
    pending,
    revoked,
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

  it("one sentence lasting past the 30 s cap keeps the mic held, and lets go when it ends", () => {
    const x = setup({ voices: [FR] });
    x.sp.speak("Une très longue phrase.", "fr", x.cb);
    x.spoken[0].onstart?.();
    x.advance(65_000);
    expect(x.page.always()).toBe(true);
    x.spoken[0].onend?.();
    expect(x.result).toEqual(["end"]);
    x.advance(60_000);
    expect(x.page.playing()).toBe(false);
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
    expect([...new Set(x.page.said(0, 100_000).map((r) => r.text))]).toEqual([
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
    expect(x.result).toEqual(["error:no voice for ru on this device [no-voice]"]);
  });

  it("no browser voice and the server has none (404): a no-voice state, not a failure", async () => {
    const x = setup({ voices: [EN], fetchOk: false, failStatus: 404 });
    x.sp.speak("雲", "ja", x.cb);
    await flush();
    await flush();
    expect(x.fetched[0]).toContain("lang=ja");
    expect(x.result).toEqual(["error:server voice: HTTP 404 [no-voice]"]);
  });

  it("a server outage with a browser voice there falls back to it, so no no-voice state", async () => {
    const x = setup({ voices: [{ lang: "ja-JP", name: "Kyoko" }], mode: "cloud", fetchOk: false });
    x.sp.speak("雲", "ja", x.cb);
    await flush();
    await flush();
    expect(x.spoken.map((u) => u.lang)).toEqual(["ja-JP"]);
    x.spoken[0].onerror?.({ error: "synthesis-failed" });
    expect(x.result).toEqual(["error:browser voice: synthesis-failed"]);
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
    // "Deux." was queued when "Un." started; the cancel cleared the queue, and nothing more is said.
    expect(x.spoken.map((u) => u.text)).toEqual(["Un.", "Deux."]);
    x.spoken[1].onstart?.();
    x.spoken[1].onend?.();
    expect(x.spoken.length).toBe(2);
    expect(x.result).toEqual([]);
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

// Owner, 2026-11-05: "句子之间感觉有 1s 停顿". Each sentence's clip used to be
// fetched only after the one before had ended. The fake clock: `x.advance`
// is time, a held fetch answers when the test says, `onended` is the clip
// ending. Nothing here makes a sound.
describe("read speaker: no wait between sentences", () => {
  const FOUR = "Un. Deux. Trois. Quatre.";
  const text = (u: string) => new URL(u, "https://x").searchParams.get("text");

  it("the next sentences are fetched while one plays, and the next starts on `ended` at once", async () => {
    const x = setup({ mode: "cloud", held: true });
    const parts: number[] = [];
    x.sp.speak(["Un. Deux.", "Trois. Quatre."], "fr", { ...x.cb, onpart: (p) => parts.push(p) });
    // Asked at once: the first sentence and the PREFETCH_AHEAD after it.
    expect(x.fetched.map(text)).toEqual(["Un.", "Deux.", "Trois."]);
    x.pending.forEach((p) => p.answer());
    await flush();
    await flush();
    expect(x.played.map((p) => p.src)).toEqual(["blob:1:Un."]);
    // "Deux." is already loaded into the other element, before "Un." ends.
    const [first, second] = x.audios;
    expect(second.src).toBe("blob:2:Deux.");
    expect(second.loads).toEqual(["blob:2:Deux."]);
    x.advance(1800);
    first.onended?.();
    // Same tick, no await, no timer: the gap is zero on the fake clock.
    expect(x.played.map((p) => [p.src, p.at])).toEqual([
      ["blob:1:Un.", 0],
      ["blob:2:Deux.", 1800],
    ]);
    // "Un." is let go, and "Quatre." asked for while "Deux." plays.
    expect(x.revoked).toEqual(["blob:1:Un."]);
    expect(x.fetched.map(text)).toEqual(["Un.", "Deux.", "Trois.", "Quatre."]);
    x.pending[3].answer();
    await flush();
    await flush();
    x.advance(1500);
    second.onended?.();
    expect(x.played.at(-1)).toMatchObject({ src: "blob:3:Trois.", at: 3300, el: first });
    await flush();
    first.onended?.();
    expect(x.played.at(-1)).toMatchObject({ src: "blob:4:Quatre.", el: second });
    second.onended?.();
    expect(parts).toEqual([0, 1]);
    expect(x.result).toEqual(["end"]);
    expect(x.revoked.length).toBe(4);
  });

  it("a slow next clip is played as soon as it arrives, not refetched", async () => {
    const x = setup({ mode: "cloud", held: true });
    x.sp.speak("Un. Deux.", "fr", x.cb);
    x.pending[0].answer();
    await flush();
    await flush();
    x.audios[0].onended?.();
    expect(x.played.length).toBe(1);
    x.pending[1].answer();
    await flush();
    await flush();
    expect(x.played.map((p) => p.src)).toEqual(["blob:1:Un.", "blob:2:Deux."]);
    expect(x.fetched.length).toBe(2);
  });

  it("a sentence said again in the session is played from memory", async () => {
    const x = setup({ mode: "cloud" });
    x.sp.speak("Un. Deux.", "fr", x.cb);
    await flush();
    await flush();
    x.audio.onended?.();
    x.audio.onended?.();
    expect(x.result).toEqual(["end"]);
    x.sp.speak("Deux. Un.", "fr", x.cb);
    await flush();
    await flush();
    expect(x.fetched.length).toBe(2);
    expect(x.played.at(-1)?.src).toEndWith(":Deux.");
  });

  it("stop drops what is still being fetched: aborted, never played, not kept", async () => {
    const x = setup({ mode: "cloud", held: true });
    const stop = x.sp.speak(FOUR, "fr", x.cb);
    x.pending[0].answer();
    await flush();
    await flush();
    stop();
    expect(x.pending.slice(1).map((p) => p.aborted)).toEqual([true, true]);
    await flush();
    expect(x.played.length).toBe(1);
    expect(x.spoken).toEqual([]);
    expect(x.result).toEqual([]);
    // The aborted ones are fetched afresh next time; the finished one is not.
    x.sp.speak(FOUR, "fr", x.cb);
    expect(x.fetched.map(text)).toEqual(["Un.", "Deux.", "Trois.", "Deux.", "Trois."]);
  });

  it("a prefetch that failed is not an error until its sentence is due", async () => {
    const x = setup({ mode: "cloud", held: true, voices: [FR] });
    x.sp.speak("Un. Deux.", "fr", x.cb);
    x.pending[0].answer();
    x.pending[1].answer(false);
    await flush();
    await flush();
    // Loading it into the other element asked once more (a failure is not kept); that fails too.
    expect(x.fetched.map(text)).toEqual(["Un.", "Deux.", "Deux."]);
    x.pending[2].answer(false);
    await flush();
    expect(x.spoken).toEqual([]);
    expect(x.result).toEqual([]);
    x.audios[0].onended?.();
    await flush();
    // Its turn: the browser voice reads it instead.
    expect(x.spoken.map((u) => u.text)).toEqual(["Deux."]);
  });

  it("the browser voice gets the next sentence queued as soon as one starts", () => {
    const x = setup({ voices: [FR] });
    x.sp.speak(FOUR, "fr", x.cb);
    expect(x.spoken.map((u) => u.text)).toEqual(["Un."]);
    x.spoken[0].onstart?.();
    expect(x.spoken.map((u) => u.text)).toEqual(["Un.", "Deux."]);
    x.spoken[0].onend?.();
    // Not spoken twice: the engine starts the queued one itself.
    expect(x.spoken.length).toBe(2);
    x.spoken[1].onstart?.();
    x.spoken[1].onend?.();
    x.spoken[2].onstart?.();
    x.spoken[2].onend?.();
    x.spoken[3].onstart?.();
    x.spoken[3].onend?.();
    expect(x.spoken.map((u) => u.text)).toEqual(["Un.", "Deux.", "Trois.", "Quatre."]);
    expect(x.result).toEqual(["end"]);
  });

  it("a queued browser sentence that never starts still falls back after WATCHDOG_MS", async () => {
    const x = setup({ voices: [FR] });
    x.sp.speak("Un. Deux.", "fr", x.cb);
    x.spoken[0].onstart?.();
    x.spoken[0].onend?.();
    x.advance(WATCHDOG_MS);
    await flush();
    expect(x.fetched.map(text)).toEqual(["Deux."]);
  });
});

// Owner, 2026-11-05 03:05–03:06 JST: the word review and Li's voice pause the
// paragraph read aloud, which goes on from the same sentence after.
describe("read speaker: pauses for a higher sound, resumes at the same sentence", () => {
  const text = (u: string) => new URL(u, "https://x").searchParams.get("text");
  const li = (claims: EventTarget) => audioOwner({ id: "li", prio: AUDIO_PRIO.li, target: claims });
  const said = (p: { src: string }) => p.src.split(":").at(-1);

  it("cloud: Li speaking pauses sentence 2; Li done, sentence 2 plays again", async () => {
    const claims = new EventTarget();
    const x = setup({ mode: "cloud", claims });
    const parts: number[] = [];
    x.sp.speak(["Un.", "Deux.", "Trois."], "fr", { ...x.cb, onpart: (p) => parts.push(p) });
    await flush();
    await flush();
    x.audios[0].onended?.();
    expect(x.played.map(said)).toEqual(["Un.", "Deux."]);
    const playing = x.audio;
    let pauses = 0;
    playing.pause = () => void pauses++;
    const voice = li(claims);
    voice.claim();
    expect(pauses).toBeGreaterThan(0);
    // Its `ended` after the pause is the old attempt's: ignored.
    playing.onended?.();
    expect(x.played.length).toBe(2);
    voice.release();
    await flush();
    await flush();
    expect(x.played.map(said)).toEqual(["Un.", "Deux.", "Deux."]);
    // From memory: nothing fetched twice.
    expect(new Set(x.fetched.map(text)).size).toBe(x.fetched.length);
    expect(x.result).toEqual([]);
    x.audio.onended?.();
    await flush();
    x.audio.onended?.();
    expect(x.result).toEqual(["end"]);
    expect(parts).toEqual([0, 1, 2]);
  });

  it("speech: the word review open pauses it; closed, the same sentence is said again", () => {
    const claims = new EventTarget();
    const x = setup({ voices: [FR], claims });
    x.sp.speak("Un. Deux. Trois.", "fr", x.cb);
    x.spoken[0].onstart?.();
    x.spoken[0].onend?.();
    x.spoken[1].onstart?.();
    const review = audioOwner({ id: "review", prio: AUDIO_PRIO.card, target: claims });
    const before = x.cancels();
    review.claim();
    expect(x.cancels()).toBe(before + 1);
    x.spoken[1].onerror?.({ error: "interrupted" });
    x.spoken[1].onend?.();
    expect(x.result).toEqual([]);
    const n = x.spoken.length;
    review.release();
    expect(x.spoken.slice(n).map((u) => u.text)).toEqual(["Deux."]);
  });

  it("a paragraph started while Li speaks waits, then reads from its start", () => {
    const claims = new EventTarget();
    const x = setup({ voices: [FR], claims });
    const voice = li(claims);
    voice.claim();
    x.sp.speak("Un. Deux.", "fr", x.cb);
    expect(x.spoken).toEqual([]);
    x.advance(WATCHDOG_MS * 2);
    expect(x.result).toEqual([]);
    voice.release();
    expect(x.spoken.map((u) => u.text)).toEqual(["Un."]);
  });

  it("stop while paused cancels nothing (Li keeps talking) and never resumes", () => {
    const claims = new EventTarget();
    const x = setup({ voices: [FR], claims });
    const stop = x.sp.speak("Un. Deux.", "fr", x.cb);
    x.spoken[0].onstart?.();
    const voice = li(claims);
    voice.claim();
    const before = x.cancels();
    stop();
    expect(x.cancels()).toBe(before);
    voice.release();
    expect(x.spoken.length).toBe(2);
    expect(x.result).toEqual([]);
  });

  it("a line that ends lets the page go", () => {
    const claims = new EventTarget();
    const x = setup({ voices: [FR], claims });
    let released = 0;
    claims.addEventListener("lk:audio-release", () => released++);
    x.sp.speak("Un.", "fr", x.cb);
    x.spoken[0].onstart?.();
    x.spoken[0].onend?.();
    expect(x.result).toEqual(["end"]);
    expect(released).toBe(1);
  });
});

// No gap between paragraphs either (auto mode): the reader prefetches the
// next block's first sentences while the last sentence of this one plays.
describe("read speaker: the next paragraph fetched ahead", () => {
  const text = (u: string) => new URL(u, "https://x").searchParams.get("text");

  it("prefetch asks for the first sentences; speak then plays them from memory at once", async () => {
    const x = setup({ mode: "cloud", held: true });
    x.sp.speak("Fin.", "fr", x.cb);
    x.pending[0].answer();
    await flush();
    await flush();
    x.sp.prefetch(["Un. Deux. Trois.", "Quatre."], "fr");
    expect(x.fetched.map(text)).toEqual(["Fin.", "Un.", "Deux."]);
    x.pending[1].answer();
    x.pending[2].answer();
    await flush();
    x.audio.onended?.();
    expect(x.result).toEqual(["end"]);
    const n = x.fetched.length;
    x.sp.speak(["Un. Deux. Trois.", "Quatre."], "fr", x.cb);
    // Only the sentence after the prefetched two is new.
    expect(x.fetched.slice(n).map(text)).toEqual(["Trois."]);
    await flush();
    await flush();
    expect(x.played.at(-1)?.src).toEndWith(":Un.");
  });

  it("does nothing for the browser voice", () => {
    const x = setup({ voices: [FR] });
    x.sp.prefetch("Un. Deux.", "fr");
    expect(x.fetched).toEqual([]);
    expect(x.spoken).toEqual([]);
  });

  it("the line playing is not touched: no sound, no callbacks", async () => {
    const x = setup({ mode: "cloud" });
    x.sp.speak("Un.", "fr", x.cb);
    await flush();
    await flush();
    const plays = x.played.length;
    x.sp.prefetch("Deux.", "fr");
    await flush();
    expect(x.played.length).toBe(plays);
    expect(x.result).toEqual([]);
  });
});
