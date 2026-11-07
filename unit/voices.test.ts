import { describe, expect, it } from "bun:test";
import {
  LANES,
  VOICES,
  auraSpeakers,
  cloudVoice,
  laneOf,
  resolveVoices,
  voiceIdOf,
  voiceTier,
  withLane,
} from "@lianki/debug-chat/voices";
import { pickVoice } from "@lianki/debug-chat/wire";
import { lineAvatar } from "@lianki/debug-chat/avatar-rules";
import { type UtterLike, createVoice } from "@lianki/debug-chat/voice";
import { createCloudOut } from "@lianki/debug-chat/voice-out";
import { silenceFor } from "@lianki/debug-chat/speak-rules";
import { parseControllerMessage } from "@/lib/dev-eval";
import { sayLane } from "@/scripts/dev/node-args";
import { AURA_VOICE, speakerParam, wordsTts, type WordsTtsDeps } from "@/lib/words-tts";

type V = { lang: string; name: string; voiceURI: string; default?: boolean };
const v = (lang: string, name: string, uri = `com.apple.voice.compact.${lang}.${name}`): V => ({
  lang,
  name,
  voiceURI: uri,
});
const elo = (lang: string, name: string) => v(lang, name, `com.apple.eloquence.${lang}.${name}`);
const novelty = (name: string) => v("en-US", name, `com.apple.speech.synthesis.voice.${name}`);

/** This Mac's list as AVSpeechSynthesisVoice gives it (2026-11-07): what Safari on macOS sees. */
const MAC: V[] = [
  v("en-US", "Samantha"),
  elo("en-US", "Eddy"),
  elo("en-US", "Flo"),
  elo("en-US", "Reed"),
  elo("en-US", "Shelley"),
  novelty("Bahh"),
  novelty("Zarvox"),
  novelty("Fred"),
  v("en-GB", "Daniel"),
  v("en-AU", "Karen"),
  v("en-IE", "Moira"),
  v("zh-CN", "Tingting"),
  v("zh-CN", "Tingting", "com.apple.voice.super-compact.zh-CN.Tingting"),
  v("zh-TW", "Meijia"),
  elo("zh-CN", "Eddy"),
  elo("zh-CN", "Flo"),
  elo("zh-CN", "Grandma"),
  elo("zh-CN", "Reed"),
  elo("zh-CN", "Rocko"),
  elo("zh-CN", "Shelley"),
  v("ja-JP", "Kyoko"),
  elo("ja-JP", "Flo"),
  elo("ja-JP", "Reed"),
  v("ko-KR", "Yuna"),
];
const names = (r: ReturnType<typeof resolveVoices<V>>) => ({
  main: r.main.voice?.name,
  calm: r.calm.voice?.name,
  bright: r.bright.voice?.name,
});

describe("lanes: who said a line", () => {
  it("takes the lane field first, else a known 【lane】 prefix, and drops that prefix", () => {
    expect(laneOf({ text: "【codex】 好的，开始。" })).toEqual({
      lane: "codex",
      text: "好的，开始。",
    });
    expect(laneOf({ text: "【AGY】done" })).toEqual({ lane: "agy", text: "done" });
    expect(laneOf({ text: "【未知】hi" })).toEqual({ lane: null, text: "【未知】hi" });
    expect(laneOf({ text: "plain" })).toEqual({ lane: null, text: "plain" });
    expect(laneOf({ lane: "agy", text: "x" })).toEqual({ lane: "agy", text: "x" });
    // A prefix naming another lane than the field stays (the field wins, the text is the agent's).
    expect(laneOf({ lane: "agy", text: "【codex】x" })).toEqual({
      lane: "agy",
      text: "【codex】x",
    });
    expect(laneOf({ lane: "bogus", text: "【codex】x" }).lane).toBe("codex");
  });

  it("withLane changes agent lines only, and returns the same object when nothing changes", () => {
    const plain = { from: "agent", text: "hi", id: "1" };
    expect(withLane(plain)).toBe(plain);
    const owner = { from: "owner", text: "【codex】hi" };
    expect(withLane(owner)).toBe(owner);
    const line: { from: string; text: string; id: string; lane?: string } = {
      from: "agent",
      text: "【codex】hi",
      id: "2",
    };
    expect(withLane(line)).toEqual({
      from: "agent",
      text: "hi",
      id: "2",
      lane: "codex",
    });
  });

  it("a line's voice: its voice field, else its lane's, else main", () => {
    expect(voiceIdOf({ text: "hi" })).toBe("main");
    expect(voiceIdOf({ text: "【codex】hi" })).toBe("calm");
    expect(voiceIdOf({ lane: "agy", text: "hi" })).toBe("bright");
    expect(voiceIdOf({ lane: "agy", voice: "calm", text: "hi" })).toBe("calm");
    expect(voiceIdOf({ voice: "nope", text: "【agy】hi" })).toBe("bright");
    expect(LANES.main.voice).toBe("main");
  });

  it("a lane line has its own avatar and name; a line with no lane is as before", () => {
    const base = { id: "1", from: "agent" as const, label: "Claude", at: 0 };
    const today = lineAvatar({ ...base, text: "hi" }, { agentAvatar: "logo.svg" });
    expect(today).toEqual({
      src: "logo.svg",
      name: "Claude",
      initialFrom: "Claude",
      seed: "agent:Claude",
      mine: false,
    });
    const mark = "codex-mark.svg";
    const codex = lineAvatar(
      { ...base, text: "hi", lane: "codex" },
      { agentAvatar: "logo.svg", laneAvatar: () => mark },
    );
    expect(codex).toMatchObject({ src: mark, name: "codex", seed: "lane:codex" });
    // The main lane keeps today's look.
    expect(lineAvatar({ ...base, text: "hi", lane: "main" }, { agentAvatar: "logo.svg" })).toEqual(
      today,
    );
  });
});

describe("device voices: a different voice model per lane", () => {
  it("macOS as installed here: zh gets Meijia / Eloquence Reed / Tingting, en three natural voices", () => {
    expect(names(resolveVoices(MAC, "zh-CN", pickVoice))).toEqual({
      // The chat lane's cute voice: Meijia (Taiwan Mandarin, young and bright).
      main: "Meijia",
      // No natural male Mandarin voice installed: the preferred Eloquence one.
      calm: "Reed",
      bright: "Tingting",
    });
    expect(names(resolveVoices(MAC, "en-US", pickVoice))).toEqual({
      main: "Samantha",
      calm: "Daniel",
      bright: "Karen",
    });
    expect(names(resolveVoices(MAC, "ja-JP", pickVoice))).toEqual({
      main: "Kyoko",
      calm: "Reed",
      bright: "Flo",
    });
  });

  it("with downloaded voices, natural ones win: Li-mu and Lili", () => {
    const list = [
      ...MAC,
      v("zh-CN", "Lili (Enhanced)", "com.apple.voice.enhanced.zh-CN.Lili"),
      v("zh-CN", "Li-mu (Premium)", "com.apple.voice.premium.zh-CN.Li-mu"),
    ];
    const r = resolveVoices(list, "zh-CN", pickVoice);
    expect(names(r)).toEqual({
      main: "Meijia",
      calm: "Li-mu (Premium)",
      bright: "Lili (Enhanced)",
    });
    expect(r.calm.pitch).toBe(1);
    expect(r.calm.shared).toBe(false);
    // No Meijia: main takes Lili, the next cute one.
    const t = resolveVoices(
      [v("zh-CN", "Tingting"), v("zh-CN", "Lili"), v("zh-CN", "Li-mu")],
      "zh-CN",
      pickVoice,
    );
    expect(names(t)).toEqual({ main: "Lili", calm: "Li-mu", bright: "Tingting" });
  });

  it("never the same model twice, and never a novelty voice", () => {
    const r = resolveVoices(MAC, "en-US", pickVoice);
    const used = [r.main, r.calm, r.bright].map((x) => x.voice?.name);
    expect(new Set(used).size).toBe(3);
    expect(voiceTier(novelty("Bahh"))).toBe(0);
    expect(voiceTier({ lang: "en-US", name: "Zarvox", voiceURI: "Zarvox" })).toBe(0);
    expect(voiceTier({ lang: "zh-CN", name: "Reed (中文（中国大陆）)", voiceURI: "Reed" })).toBe(1);
    // Two Tingting variants are one model: Tingting is not given to a second lane.
    const tt = [
      v("zh-CN", "Tingting"),
      v("zh-CN", "Tingting", "com.apple.voice.enhanced.zh-CN.Tingting"),
    ];
    const t = resolveVoices(tt, "zh-CN", pickVoice);
    expect(t.calm.shared).toBe(true);
    expect(t.bright.shared).toBe(true);
  });

  it("one voice only: main's voice with the lane's pitch and speed (the last resort)", () => {
    const r = resolveVoices([v("ko-KR", "Yuna")], "ko-KR", pickVoice);
    expect(r.main).toMatchObject({ pitch: VOICES.main.pitch, rate: 1, shared: false });
    expect(r.calm).toMatchObject({
      pitch: VOICES.calm.pitch,
      rate: VOICES.calm.rate,
      shared: true,
    });
    expect(r.calm.voice?.name).toBe("Yuna");
    expect(r.bright.pitch).toBeGreaterThan(VOICES.main.pitch);
    expect(r.calm.pitch).toBeLessThan(1);
  });

  it("no voices at all: still speaks (browser default), never silent", () => {
    const r = resolveVoices([] as V[], "zh-CN", pickVoice);
    expect(r.main.voice).toBeUndefined();
    expect(r.calm.voice).toBeUndefined();
    expect(r.calm.shared).toBe(true);
  });

  it("Cantonese is not a sibling of Mandarin; Taiwan Mandarin is", () => {
    const r = resolveVoices(
      [v("zh-CN", "Tingting"), v("zh-HK", "Sinji"), v("zh-TW", "Meijia")],
      "zh-CN",
      pickVoice,
    );
    expect(names(r)).toEqual({ main: "Meijia", calm: "Meijia", bright: "Tingting" });
    expect(r.calm.shared).toBe(true);
  });
});

describe("cloud voices", () => {
  it("Aura-2 speakers for en and es, main's too; one voice shifted elsewhere", () => {
    expect(cloudVoice("calm", "en-US")).toEqual({ speaker: "orion", shift: 1 });
    expect(cloudVoice("bright", "es")).toEqual({ speaker: "carina", shift: 1 });
    expect(cloudVoice("calm", "zh-CN")).toEqual({ shift: VOICES.calm.shift });
    expect(cloudVoice("main", "en")).toEqual({ speaker: "luna", shift: 1 });
    expect(cloudVoice("main", "zh")).toEqual({ shift: VOICES.main.shift });
    expect(auraSpeakers()).toEqual({
      en: ["luna", "orion", "thalia"],
      es: ["celeste", "nestor", "carina"],
    });
  });

  it("the route keeps only a speaker the table names for that language", () => {
    const p = (s: string) => new URLSearchParams(s);
    expect(speakerParam(p("speaker=orion"), "en")).toBe("orion");
    expect(speakerParam(p("speaker=Thalia"), "en")).toBe("thalia");
    expect(speakerParam(p("speaker=orion"), "zh")).toBeUndefined();
    expect(speakerParam(p("speaker=zeus"), "en")).toBeUndefined();
  });

  function ttsDeps(fail = false) {
    const asked: { text: string; speaker?: string }[] = [];
    const recorded: string[] = [];
    const d: WordsTtsDeps = {
      getVoiceClip: async (k) => (recorded.push(k), null),
      getCachedTTS: async () => null,
      putCachedTTS: async () => {},
      checkRateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
      isConfigured: () => true,
      speechModel: () => "@cf/myshell-ai/melotts",
      speech: async ({ text, speaker }) => {
        asked.push({ text, speaker });
        if (speaker && fail) throw new Error("aura down");
        return { audio: new Uint8Array([0x49, 0x44, 0x33]), contentType: "audio/mpeg" };
      },
      log: () => {},
    };
    return { d, asked, recorded };
  }

  it("a speaker goes to Aura-2 (no recording lookup); a failure falls back to MeloTTS", async () => {
    const ok = ttsDeps();
    const res = await wordsTts(
      new URLSearchParams("lang=en&text=Hi&store=0&speaker=orion"),
      "a@x",
      ok.d,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Voice")).toBe(AURA_VOICE);
    expect(ok.asked).toEqual([{ text: "Hi", speaker: "orion" }]);
    expect(ok.recorded).toEqual([]);
    const bad = ttsDeps(true);
    const r2 = await wordsTts(
      new URLSearchParams("lang=en&text=Hi&store=0&speaker=orion"),
      "a@x",
      bad.d,
    );
    expect(r2.status).toBe(200);
    expect(r2.headers.get("X-Voice")).toBe("melotts");
    expect(bad.asked).toEqual([
      { text: "Hi", speaker: "orion" },
      { text: "Hi", speaker: undefined },
    ]);
  });

  it("the page asks for the speaker; a clip with no voice of its own plays at its speed, pitch kept", async () => {
    const fetched: string[] = [];
    const el = {
      src: "",
      currentTime: 0,
      volume: 1,
      preload: "",
      paused: true,
      playbackRate: 1,
      preservesPitch: true,
      onended: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onloadedmetadata: null as (() => void) | null,
      play: () => Promise.resolve(),
      pause() {},
      load() {},
    };
    let voiceHeader: string | null = AURA_VOICE;
    let n = 0;
    const out = createCloudOut({
      fetch: async (u) => {
        fetched.push(u);
        return {
          ok: true,
          status: 200,
          headers: { get: () => voiceHeader },
          blob: async () => new Blob(["x"]),
        };
      },
      element: () => el,
      ctx: () => null,
      toUrl: () => `blob:${++n}`,
    });
    const ev = { onend() {}, onerror() {} };
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const play = async (s: Parameters<typeof out.play>[0]) => {
      out.play(s, ev);
      await tick();
      await tick();
      el.onloadedmetadata?.();
    };
    await play({ text: "Hi.", lang: "en-US", at: 0, volume: 1, rate: 1.5, voice: "calm" });
    expect(fetched.at(-1)).toBe("/api/words/tts?lang=en&text=Hi.&store=0&speaker=orion");
    expect(el.playbackRate).toBe(1.5);
    expect(el.preservesPitch).toBe(true);
    // zh: the one MeloTTS voice at the lane's speed, pitch kept (a pitch-free clip stalls on iOS).
    voiceHeader = "melotts";
    await play({ text: "好。", lang: "zh-CN", at: 0, volume: 1, rate: 1, voice: "bright" });
    expect(fetched.at(-1)).toBe(
      `/api/words/tts?lang=zh&text=${encodeURIComponent("好。")}&store=0`,
    );
    expect(el.playbackRate).toBeCloseTo(VOICES.bright.shift, 5);
    expect(el.preservesPitch).toBe(true);
    // Aura failed on the route (MeloTTS answered): shifted too, never silent.
    await play({ text: "Bye.", lang: "en", at: 0, volume: 1, rate: 1, voice: "calm" });
    expect(el.playbackRate).toBeCloseTo(VOICES.calm.shift, 5);
    expect(el.preservesPitch).toBe(true);
    // Main in zh (owner, 2026-11-07): his own reading speed, no shift, pitch kept.
    voiceHeader = "melotts";
    await play({ text: "好。", lang: "zh-CN", at: 0, volume: 1, rate: 1.5 });
    expect(el.playbackRate).toBe(1.5);
    expect(el.preservesPitch).toBe(true);
    // Main (no voice on the line): the chat lane's own speaker.
    voiceHeader = AURA_VOICE;
    await play({ text: "Yo.", lang: "en", at: 0, volume: 1, rate: 1 });
    expect(fetched.at(-1)).toBe("/api/words/tts?lang=en&text=Yo.&store=0&speaker=luna");
    expect(el.playbackRate).toBe(1);
    expect(el.preservesPitch).toBe(true);
  });
});

describe("the voice session reads each line in its lane's voice", () => {
  it("passes the voice to utter, drops the prefix, and keeps main lines unchanged", () => {
    const spoken: { text: string; voice?: string; rate?: number }[] = [];
    const s = createVoice({
      synth: () => ({
        speak: (u) => void spoken.push(u as unknown as { text: string }),
        cancel() {},
      }),
      utter: (text, _lang, voice) =>
        ({ text, voice, onend: null, onerror: null, onboundary: null }) as unknown as UtterLike,
      enabled: () => true,
      here: () => true,
      rate: () => 1.5,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    s.reply("【agy】 搞定。", { id: "a" });
    (spoken.at(-1) as unknown as UtterLike).onend?.();
    s.reply("Plain.", { id: "b" });
    (spoken.at(-1) as unknown as UtterLike).onend?.();
    s.reply("Calm one.", { id: "c", lane: "agy", voice: "calm" });
    expect(spoken.map((u) => [u.text, u.voice, u.rate])).toEqual([
      ["搞定。", "bright", 1.5],
      ["Plain.", undefined, 1.5],
      ["Calm one.", "calm", 1.5],
    ]);
  });

  it("a quiet line stays quiet whatever its lane (the gate is unchanged)", () => {
    expect(silenceFor({ quiet: true, lane: "codex" }, { hidden: false })).toBe("quiet");
    expect(silenceFor({ lane: "agy" }, { hidden: true })).toBe("hidden");
    expect(silenceFor({ lane: "agy", voice: "bright" }, { hidden: false })).toBeNull();
  });
});

describe("say: --lane / --voice to the hub", () => {
  it("the CLI checks the ids; the hub keeps them, refuses unknown ones", () => {
    expect(sayLane("codex")).toEqual({ lane: "codex" });
    expect(sayLane(undefined, "bright")).toEqual({ voice: "bright" });
    expect(sayLane("bogus")).toHaveProperty("error");
    const say = (o: object) =>
      parseControllerMessage(JSON.stringify({ type: "say", text: "hi", ...o }));
    const ok = say({ lane: "agy", voice: "calm" });
    expect(ok).toEqual({
      ok: true,
      value: { type: "say", text: "hi", lane: "agy", voice: "calm" },
    });
    expect(say({ lane: "x" }).ok).toBe(false);
    expect(say({ voice: 3 }).ok).toBe(false);
    expect(say({})).toEqual({
      ok: true,
      value: { type: "say", text: "hi" },
    });
  });
});
