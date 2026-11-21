import { describe, expect, test } from "bun:test";
import {
  browserSpeak,
  START_TIMEOUT_MS,
  type BrowserSpeakDeps,
  type Follower,
  type UtteranceEvents,
} from "@/lib/words/browser-speak";
import { sayParts, type SayPart } from "@/lib/words/say-parts";
import { createSequencer } from "@/lib/words/sequence";

/** No real speech: utterances are recorded, their events fired by hand. */
type Voice = { name: string; lang: string };

function rig(opts: { voices?: string[]; clips?: string[] } = {}) {
  const voices = opts.voices ?? ["en", "zh"];
  const clips = new Set(opts.clips ?? []);
  let gen = 0;
  let now = 0;
  const timers = new Map<number, { fn: () => void; at: number; ms: number }>();
  let id = 0;
  const log: string[] = [];
  const spoken: { text: string; lang: string; on: UtteranceEvents }[] = [];
  const dead = new Set<string>();
  const followers: string[] = [];
  /** Server clips that play: their done, by text. */
  const clipDone = new Map<string, (p: boolean) => void>();
  const setTimer = (fn: () => void, ms: number) => {
    timers.set(++id, { fn, at: now + ms, ms });
    return id;
  };
  const clearTimer = (t: unknown) => void timers.delete(t as number);
  const deps: BrowserSpeakDeps<Voice> = {
    generation: () => gen,
    can: (lang) => voices.includes(lang) && !dead.has(lang),
    voiceFor: (lang) => (voices.includes(lang) ? { name: `v-${lang}`, lang } : null),
    speak: (text, voice, _rate, on) => {
      log.push(`browser:${text}`);
      spoken.push({ text, lang: voice.lang, on });
    },
    cancel: () => log.push("cancel"),
    giveUp: (lang) => void dead.add(lang),
    serverSpeak: async (text, _lang, done) => {
      if (!clips.has(text)) {
        log.push(`no-clip:${text}`);
        return false;
      }
      log.push(`server:${text}`);
      clipDone.set(text, done);
      return true;
    },
    follow: (text): Follower => ({
      start: () => followers.push(`start:${text}`),
      end: (s) => followers.push(`end:${text}:${s}`),
      boundary: (i) => followers.push(`at:${text}:${i}`),
    }),
    setTimer,
    clearTimer,
    log: (e) => log.push(`log:${String(e.ev)}`),
  };
  /** Run every timer due by `ms` from now, in order. */
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at);
      if (!due.length) break;
      const [k, t] = due[0];
      timers.delete(k);
      now = t.at;
      t.fn();
    }
    now = until;
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const last = () => spoken[spoken.length - 1];
  return {
    deps,
    log,
    spoken,
    last,
    dead,
    followers,
    clipDone,
    timers,
    setTimer,
    clearTimer,
    advance,
    flush,
    now: () => now,
    bump: () => gen++,
  };
}

function call(r: ReturnType<typeof rig>, text: string, lang: string, extra = {}) {
  const dones: boolean[] = [];
  browserSpeak(r.deps, { text, lang, done: (p) => dones.push(p), ...extra });
  return dones;
}

describe("browserSpeak: every utterance ends exactly once", () => {
  test("end after start: done(true), once", () => {
    const r = rig();
    const d = call(r, "hello", "en");
    r.last().on.start();
    r.last().on.end();
    r.last().on.end();
    r.last().on.error("synthesis-failed");
    expect(d).toEqual([true]);
    expect(r.timers.size).toBe(0);
  });

  test("error after start: done(false) at once, no server retry, voice kept", () => {
    const r = rig({ clips: ["我喜欢茶。"] });
    const d = call(r, "我喜欢茶。", "zh");
    r.last().on.start();
    r.last().on.error("synthesis-failed");
    r.last().on.end();
    expect(d).toEqual([false]);
    expect(r.log).not.toContain("server:我喜欢茶。");
    expect(r.dead.has("zh")).toBe(false);
  });

  test("interrupted after start ends the part too", () => {
    const r = rig();
    const d = call(r, "hello", "en");
    r.last().on.start();
    r.last().on.error("interrupted");
    expect(d).toEqual([false]);
  });

  test("interrupted before start: done(false), the language is not given up", () => {
    const r = rig();
    const d = call(r, "hello", "en");
    r.last().on.error("canceled");
    expect(d).toEqual([false]);
    expect(r.dead.size).toBe(0);
    expect(r.timers.size).toBe(0);
  });

  test("failed before start: the server's clip says it, and ends the part", async () => {
    const r = rig({ clips: ["hello"] });
    const d = call(r, "hello", "en");
    r.last().on.error("synthesis-failed");
    expect(r.dead.has("en")).toBe(true);
    expect(r.log).toContain("cancel");
    await r.flush();
    expect(r.log).toContain("server:hello");
    // The utterance's own late events no longer count.
    r.last().on.end();
    expect(d).toEqual([]);
    r.clipDone.get("hello")!(true);
    r.clipDone.get("hello")!(true);
    expect(d).toEqual([true]);
  });

  test("never starts: after the start timeout the server is asked; no clip → done(false)", async () => {
    const r = rig();
    const d = call(r, "hello", "en");
    expect(d).toEqual([]);
    r.advance(START_TIMEOUT_MS);
    await r.flush();
    expect(r.log).toContain("no-clip:hello");
    expect(d).toEqual([false]);
  });

  test("ends without a start: handed to the server at once", async () => {
    const r = rig();
    const d = call(r, "hello", "en", { serverTried: true });
    r.last().on.end();
    expect(d).toEqual([false]);
    expect(r.log).toContain("log:silent");
  });

  test("a rejected server call still ends the part", async () => {
    const r = rig({ voices: [] });
    r.deps.serverSpeak = () => Promise.reject(new Error("offline"));
    const d = call(r, "hello", "en");
    await r.flush();
    expect(d).toEqual([false]);
  });

  test("after a cancel (new generation) nothing reports", async () => {
    const r = rig();
    const d = call(r, "hello", "en");
    r.bump();
    r.last().on.start();
    r.last().on.error("interrupted");
    r.advance(START_TIMEOUT_MS);
    expect(d).toEqual([]);
    const d2 = call(r, "again", "en");
    r.bump();
    r.advance(START_TIMEOUT_MS);
    expect(d2).toEqual([]);
    expect(r.dead.size).toBe(0);
  });

  test("a tracked part follows the words, and stops following at the end", () => {
    const r = rig();
    const d = call(r, "I like tea.", "en", { track: true });
    r.last().on.start();
    r.last().on.boundary(2, "word");
    r.last().on.end();
    r.last().on.boundary(7, "word");
    expect(d).toEqual([true]);
    expect(r.followers).toEqual(["start:I like tea.", "at:I like tea.:2", "end:I like tea.:true"]);
  });

  test("a tracked part that falls back stops following before the server plays", async () => {
    const r = rig({ clips: ["I like tea."] });
    call(r, "I like tea.", "en", { track: true });
    r.last().on.error("synthesis-failed");
    expect(r.followers).toEqual(["end:I like tea.:false"]);
  });
});

describe("browserSpeak: a run with no voice is skipped at once", () => {
  test("no browser voice, server already failed: done(false) synchronously", () => {
    const r = rig({ voices: ["en"] });
    const d = call(r, "我喜欢茶。", "zh", { serverTried: true });
    expect(d).toEqual([false]);
    expect(r.spoken).toEqual([]);
    expect(r.timers.size).toBe(0);
  });

  test("no browser voice, no server clip: done(false) as soon as the server answers", async () => {
    const r = rig({ voices: ["en"] });
    const d = call(r, "我喜欢茶。", "zh");
    await r.flush();
    expect(d).toEqual([false]);
    expect(r.spoken).toEqual([]);
  });

  test("a language given up on is not tried in the browser again", async () => {
    const r = rig({ clips: ["茶"] });
    r.dead.add("zh");
    call(r, "茶", "zh");
    await r.flush();
    expect(r.spoken).toEqual([]);
    expect(r.log).toContain("server:茶");
  });
});

describe("a mixed en+zh example in a sequence", () => {
  const PART_TIMEOUT = 30000;
  const parts = sayParts(
    { term: "tea", back: "茶", ex: "I like tea. 我喜欢茶。" },
    "en",
    false,
    "zh",
  );

  function seqRig(voices: string[]) {
    const r = rig({ voices });
    const said: { text: string; at: number }[] = [];
    const ended: { text: string; played: boolean; at: number }[] = [];
    const seq = createSequencer<SayPart>({
      say: (p, done) => {
        said.push({ text: p.text, at: r.now() });
        browserSpeak(r.deps, {
          text: p.text,
          lang: p.lang,
          done: (played) => {
            ended.push({ text: p.text, played, at: r.now() });
            done(played);
          },
          serverTried: true,
          track: p.kind === "example",
        });
      },
      cancel: () => r.bump(),
      setTimeout: r.setTimer,
      clearTimeout: r.clearTimer,
      partTimeoutMs: () => PART_TIMEOUT,
    });
    return { r, seq, said, ended };
  }

  test("the example is one part per language run", () => {
    expect(parts.map((p) => [p.kind, p.lang, p.text])).toEqual([
      ["word", "en", "tea"],
      ["example", "en", "I like tea."],
      ["example", "zh", "我喜欢茶。"],
      ["meaning", "zh", "茶"],
    ]);
  });

  test("the zh run errors after it started: the meaning plays next, well under the part timeout", () => {
    const { r, seq, said, ended } = seqRig(["en", "zh"]);
    seq.play(parts);
    const speakNext = (fail?: string) => {
      const u = r.last();
      u.on.start();
      if (fail) u.on.error(fail);
      else u.on.end();
    };
    speakNext(); // tea
    r.advance(150);
    speakNext(); // I like tea.
    r.advance(150);
    expect(r.last().text).toBe("我喜欢茶。");
    const t0 = r.now();
    speakNext("synthesis-failed");
    expect(ended.at(-1)).toEqual({ text: "我喜欢茶。", played: false, at: t0 });
    r.advance(150);
    expect(said.at(-1)!.text).toBe("茶");
    expect(said.at(-1)!.at - t0).toBeLessThan(PART_TIMEOUT / 10);
    expect(r.last().text).toBe("茶");
    speakNext();
    expect(seq.playing()).toBeNull();
    expect(ended.map((e) => e.played)).toEqual([true, true, false, true]);
  });

  test("no zh voice and no clip: the zh runs are skipped at once and the sequence ends", () => {
    const { r, seq, said, ended } = seqRig(["en"]);
    seq.play(parts);
    r.last().on.start();
    r.last().on.end(); // tea
    r.advance(150);
    r.last().on.start();
    r.last().on.end(); // I like tea.
    const t0 = r.now();
    r.advance(150); // zh example: skipped
    r.advance(150); // zh meaning: skipped
    expect(said.map((s) => s.text)).toEqual(["tea", "I like tea.", "我喜欢茶。", "茶"]);
    expect(ended.slice(2).map((e) => e.played)).toEqual([false, false]);
    expect(r.now() - t0).toBeLessThan(1000);
    expect(seq.playing()).toBeNull();
    expect(r.spoken.map((s) => s.text)).toEqual(["tea", "I like tea."]);
  });
});
