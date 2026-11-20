/**
 * Play reports, the page's side (packages/debug-chat/src/play-report.ts;
 * docs/echo-suppression.md, layer (b)): what his pages read aloud goes to the
 * hub as `playing` / `played` frames, on the hub's clock, only with the flag
 * on and his socket attached; a private screen sends hashed n-grams only.
 * Also the sources that report: Li's voice queue (voice.ts), /words and the
 * reader (page-audio.ts). Fake synths, nothing plays.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { gramHashes } from "@lianki/debug-chat/echo";
import { createPageAudio } from "@lianki/debug-chat/page-audio";
import {
  ECHO_REPORTS_FLAG,
  PLAY_TEXT_MAX,
  type PlayFrame,
  echoReportsOn,
  hubSpanOf,
  reportPlayed,
  reportPlaying,
  setEchoReports,
  setPlaySender,
} from "@lianki/debug-chat/play-report";
import { hubClock } from "@lianki/debug-chat/sync-speak";
import { type UtterLike, createVoice, playVoiceOf, CLONE_SPEAKER } from "@lianki/debug-chat/voice";
import { FLAGS } from "@/lib/flags";
import { globalDescriptor, restoreGlobal, stubGlobals } from "./support/globals";

let sent: PlayFrame[];
const clockDesc = globalDescriptor("__lkHubClock");
const reportDesc = globalDescriptor("__lkPlayReport");

beforeEach(() => {
  sent = [];
  restoreGlobal("__lkHubClock", undefined);
  restoreGlobal("__lkPlayReport", undefined);
  setEchoReports(true);
  setPlaySender((f) => {
    sent.push(f);
    return true;
  });
});
afterEach(() => {
  setEchoReports(false);
  setPlaySender(null);
  restoreGlobal("__lkHubClock", clockDesc);
  restoreGlobal("__lkPlayReport", reportDesc);
});

/** Give the page a hub-clock offset of `off` ms (one ping/pong round). */
function synced(off: number) {
  const c = hubClock();
  const p = c.ping()!;
  c.pong({ t0: p.t0, t1: p.t0 + off, t2: p.t0 + off });
}

describe("the flag and the sender", () => {
  it("is voice.echo-reports, default on, audience owner", () => {
    expect(ECHO_REPORTS_FLAG).toBe("voice.echo-reports");
    expect(FLAGS[ECHO_REPORTS_FLAG]).toMatchObject({ default: true, audience: "owner" });
  });

  it("sends nothing with the flag off, with no socket, or with no words", () => {
    setEchoReports(false);
    expect(echoReportsOn()).toBe(false);
    expect(reportPlaying({ text: "hello", voice: "device", at: 1 })).toBeNull();
    setEchoReports(true);
    expect(reportPlaying({ text: "   ", voice: "device", at: 1 })).toBeNull();
    setPlaySender(null);
    expect(reportPlaying({ text: "hello", voice: "device", at: 1 })).toBeNull();
    reportPlayed("p1", 2);
    expect(sent).toEqual([]);
  });

  it("a socket that refuses or throws: no ref, never an error", () => {
    setPlaySender(() => false);
    expect(reportPlaying({ text: "hello", voice: "device", at: 1 })).toBeNull();
    setPlaySender(() => {
      throw new Error("closed");
    });
    expect(reportPlaying({ text: "hello", voice: "device", at: 1 })).toBeNull();
  });
});

describe("the frames", () => {
  it("without a clock estimate: the page's own times, not synced; refs by line and count", () => {
    const ref = reportPlaying({
      text: "spoken form",
      alt: "Written Form",
      voice: "melo",
      at: 1000,
      line: "d3c3",
    });
    expect(ref).toBe("d3c3#1");
    reportPlayed(ref!, 4000);
    expect(sent).toEqual([
      {
        type: "playing",
        ref: "d3c3#1",
        text: "spoken form",
        alt: "Written Form",
        voice: "melo",
        from: 1000,
      },
      { type: "played", ref: "d3c3#1", to: 4000 },
    ]);
    expect(reportPlaying({ text: "same", alt: "same", voice: "device", at: 5 })).toBe("p2");
    expect(sent.at(-1)).not.toHaveProperty("alt");
  });

  it("with an estimate: hub-clock times, synced", () => {
    synced(5000);
    const ref = reportPlaying({ text: "hello", voice: "device", at: 1000 })!;
    reportPlayed(ref, 2000);
    expect(sent.map((f) => [f.type, f.type === "playing" ? f.from : f.to, f.synced])).toEqual([
      ["playing", 6000, true],
      ["played", 7000, true],
    ]);
  });

  it("cuts long text and long voice names", () => {
    reportPlaying({ text: "a".repeat(5000), alt: "b".repeat(5000), voice: "v".repeat(99), at: 1 });
    const f = sent[0] as Extract<PlayFrame, { type: "playing" }>;
    expect(f.text!.length).toBe(PLAY_TEXT_MAX);
    expect(f.alt!.length).toBe(PLAY_TEXT_MAX);
    expect(f.voice.length).toBe(40);
  });

  it("a private screen sends hashed n-grams, never the words", () => {
    const restore = stubGlobals({
      document: { querySelector: (s: string) => (s === "[data-lk-private-screen]" ? {} : null) },
    });
    try {
      reportPlaying({ text: "my private diary", voice: "reader", at: 1 });
    } finally {
      restore();
    }
    const f = sent[0] as Extract<PlayFrame, { type: "playing" }>;
    expect(f.text).toBeUndefined();
    expect(JSON.stringify(f)).not.toContain("diary");
    expect(f.g2).toEqual(gramHashes("my private diary ", 2));
    expect(f.g3).toEqual(gramHashes("my private diary ", 3));
  });

  it("a document that throws on the query counts as not private", () => {
    const restore = stubGlobals({
      document: {
        querySelector: () => {
          throw new Error("detached");
        },
      },
    });
    try {
      reportPlaying({ text: "hello", voice: "reader", at: 1 });
    } finally {
      restore();
    }
    expect((sent[0] as { text?: string }).text).toBe("hello");
  });
});

describe("a voice line's hub span", () => {
  it("needs the offset and the end; uses the start, else the length", () => {
    expect(hubSpanOf({ t_speechStart: 100, t_speechEnd: 900 }, 1000)).toEqual({
      from: 1100,
      to: 1900,
    });
    expect(hubSpanOf({ t_speechEnd: 900, audioMs: 400 }, 1000)).toEqual({ from: 1500, to: 1900 });
    expect(hubSpanOf({ t_speechEnd: 900 }, 0)).toEqual({ from: 900, to: 900 });
    expect(hubSpanOf({ t_speechStart: 1000, t_speechEnd: 900 }, 0)).toEqual({ from: 900, to: 900 });
    expect(hubSpanOf({ t_speechEnd: 900 }, null)).toBeUndefined();
    expect(hubSpanOf(undefined, 5)).toBeUndefined();
    // The page's own estimate by default: none yet.
    expect(hubSpanOf({ t_speechEnd: 900 })).toBeUndefined();
  });
});

describe("who reports", () => {
  it("page audio with words (/words, the reader), once per sound", () => {
    let t = 100;
    const timers: (() => void)[] = [];
    const pa = createPageAudio({
      now: () => t,
      setTimer: (f) => timers.push(f),
      clearTimer: () => {},
    });
    const end = pa.start({ text: "apple", voice: "words" });
    t = 700;
    end();
    end();
    pa.start({})();
    pa.start({ text: "default voice" })();
    expect(
      sent.map((f) => (f.type === "playing" ? [f.type, f.text, f.voice, f.from] : [f.type, f.to])),
    ).toEqual([
      ["playing", "apple", "words", 100],
      ["played", 700],
      ["playing", "default voice", "page", 700],
      ["played", 700],
    ]);
  });

  it("names the voice: his clone, a provider, the device, the cloud route", () => {
    expect(playVoiceOf(CLONE_SPEAKER, undefined, "audio")).toBe("clone");
    expect(playVoiceOf(undefined, "clone", "audio")).toBe("clone");
    expect(playVoiceOf(undefined, "melo", "audio")).toBe("melo");
    expect(playVoiceOf(undefined, "device", "audio")).toBe("device");
    expect(playVoiceOf(undefined, undefined, "speech")).toBe("device");
    expect(playVoiceOf(undefined, undefined, "audio")).toBe("cloud");
  });

  it("Li's queue: each sentence as it starts, in its spoken form, and when it ends", () => {
    let t = 1000;
    const utters: UtterLike[] = [];
    const v = createVoice({
      now: () => t,
      setTimer: () => 0,
      clearTimer: () => {},
      enabled: () => true,
      here: () => true,
      synth: () => ({
        speak: (u) => void utters.push(u),
        cancel: () => {},
      }),
      utter: (text) => ({ text }) as UtterLike,
    });
    v.reply("第一句话。第二句话。", { id: "line1" } as never);
    expect(utters.length).toBe(1);
    t = 1500;
    utters[0]!.onend?.(undefined as never);
    expect(sent.slice(0, 2)).toEqual([
      { type: "playing", ref: "line1#1", text: "第一句话。", voice: "device", from: 1000 },
      { type: "played", ref: "line1#1", to: 1500 },
    ]);
    expect(sent[2]).toMatchObject({ type: "playing", ref: "line1#2", text: "第二句话。" });
  });

  it("voice.cloudWhileMic: with the mic on, the cloud voice reads (the canceller hears it)", () => {
    const run = (mic: boolean, want: boolean) => {
      const spoken: string[] = [];
      const cloud: string[] = [];
      const v = createVoice({
        now: () => 0,
        setTimer: () => 0,
        clearTimer: () => {},
        enabled: () => true,
        here: () => true,
        synth: () => ({ speak: (u) => void spoken.push(u.text), cancel: () => {} }),
        utter: (text) => ({ text }) as UtterLike,
        cloud: () => ({
          play: (x) => {
            cloud.push(x.text);
            return { route: "audio", stop: () => ({}), volume: () => {} };
          },
        }),
        cloudWhileMic: () => want,
      });
      v.setMic(mic);
      v.reply("好的。");
      return { spoken, cloud };
    };
    expect(run(true, true)).toEqual({ spoken: [], cloud: ["好的。"] });
    expect(run(false, true)).toEqual({ spoken: ["好的。"], cloud: [] });
    expect(run(true, false)).toEqual({ spoken: ["好的。"], cloud: [] });
  });
});
