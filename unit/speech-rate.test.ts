import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SPEECH_RATE,
  SPEECH_RATE_KEY,
  setSpeechRate,
  speechRate,
} from "@lianki/debug-chat/speech-rate";
import { type UtterLike, createVoice } from "@lianki/debug-chat/voice";
import { createCloudOut } from "@lianki/debug-chat/voice-out";

const mem = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
};

describe("speech rate setting", () => {
  it("defaults to 1.5×", () => {
    expect(DEFAULT_SPEECH_RATE).toBe(1.5);
    expect(speechRate(mem())).toBe(1.5);
    expect(speechRate(null)).toBe(1.5);
  });

  it("persists one of 1, 1.25, 1.5, 2 under lk:agent-speech-rate", () => {
    const s = mem();
    setSpeechRate(2, s);
    expect(s.m.get(SPEECH_RATE_KEY)).toBe("2");
    expect(speechRate(s)).toBe(2);
    setSpeechRate(1.25, s);
    expect(speechRate(s)).toBe(1.25);
    setSpeechRate(3, s); // not offered: ignored
    expect(speechRate(s)).toBe(1.25);
    s.m.set(SPEECH_RATE_KEY, "fast");
    expect(speechRate(s)).toBe(1.5);
  });

  it("survives storage that throws", () => {
    const bad = {
      getItem: () => {
        throw new Error("private");
      },
      setItem: () => {
        throw new Error("private");
      },
    };
    expect(speechRate(bad)).toBe(1.5);
    expect(() => setSpeechRate(2, bad)).not.toThrow();
  });
});

describe("the rate reaches the outputs", () => {
  it("speech: each utterance gets the rate as set when it starts", () => {
    const spoken: UtterLike[] = [];
    let rate = 1.5;
    const v = createVoice({
      synth: () => ({ speak: (u) => void spoken.push(u), cancel: () => {} }),
      utter: (text) => ({ text, onend: null, onerror: null, onboundary: null }) as UtterLike,
      enabled: () => true,
      here: () => true,
      rate: () => rate,
    });
    v.reply("One. Two.");
    expect(spoken[0].rate).toBe(1.5);
    rate = 2; // changed mid-reply: from the next utterance
    spoken[0].onend?.();
    expect(spoken[1].rate).toBe(2);
    expect(spoken[0].rate).toBe(1.5);
  });

  it("cloud audio: playbackRate set, pitch kept (both names)", async () => {
    const el = {
      src: "",
      currentTime: 0,
      volume: 1,
      preload: "",
      paused: true,
      playbackRate: 1,
      defaultPlaybackRate: 1,
      preservesPitch: false,
      webkitPreservesPitch: false,
      onended: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onloadedmetadata: null as (() => void) | null,
      play: async () => {},
      pause() {},
      load() {
        // A real load() resets the rate to the default.
        el.playbackRate = el.defaultPlaybackRate;
      },
    };
    const out = createCloudOut({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        blob: async () => new Blob(["x"]),
      }),
      element: () => el,
      ctx: () => null,
      toUrl: () => "blob:1",
    });
    out.play(
      { text: "Hello.", lang: "en", at: 0, volume: 1, rate: 1.25 },
      { onend() {}, onerror() {} },
    );
    await new Promise((r) => setTimeout(r, 0));
    el.onloadedmetadata?.();
    expect(el.playbackRate).toBe(1.25);
    expect(el.defaultPlaybackRate).toBe(1.25);
    expect(el.preservesPitch).toBe(true);
    expect(el.webkitPreservesPitch).toBe(true);
  });
});
