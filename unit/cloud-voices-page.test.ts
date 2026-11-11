import { describe, expect, it } from "bun:test";
import {
  type LineVoice,
  cloudVoiceIds,
  cloudVoicesOn,
  langVoice,
  parseLineVoice,
  setCloudVoices,
} from "@lianki/debug-chat/voices";
import { createCloudOut, providerSkip, providerTtsUrl, ttsUrl } from "@lianki/debug-chat/voice-out";
import { createVoice, type UtterLike } from "@lianki/debug-chat/voice";

// The page side of provider voices: which sentences go to one, and the fallback.

const tick = () => new Promise((r) => setTimeout(r, 0));
const resetCloud = () => delete (globalThis as { __lkCloudVoices?: unknown }).__lkCloudVoices;
const voice = (id: string) => {
  const v = parseLineVoice(id);
  if ("error" in v) throw new Error(id);
  return v as Extract<LineVoice, { kind: "google" | "azure" }>;
};

describe("setCloudVoices / langVoice", () => {
  it("off by default; on, the map's locale first, then its language", () => {
    resetCloud();
    expect(cloudVoicesOn()).toBe(false);
    expect(langVoice("zh-TW")).toBeUndefined();
    setCloudVoices({
      on: true,
      map: { "zh-TW": "google:cmn-TW-Wavenet-A", ZH: "azure:zh-TW-HsiaoChenNeural", ja: "melo:ja" },
    });
    expect(cloudVoicesOn()).toBe(true);
    expect(langVoice("zh-TW")?.id).toBe("google:cmn-TW-Wavenet-A");
    expect(langVoice("zh_TW")?.id).toBe("google:cmn-TW-Wavenet-A");
    expect(langVoice("zh-CN")?.id).toBe("azure:zh-TW-HsiaoChenNeural");
    // Not a provider voice: dropped.
    expect(langVoice("ja")).toBeUndefined();
    setCloudVoices({ on: false, map: { zh: "google:cmn-TW-Wavenet-A" } });
    expect(langVoice("zh")).toBeUndefined();
    setCloudVoices(undefined);
    expect(cloudVoicesOn()).toBe(false);
    setCloudVoices({ on: true, map: ["x"] });
    expect(langVoice("zh")).toBeUndefined();
    resetCloud();
  });
});

class El {
  src = "";
  currentTime = 0;
  volume = 1;
  preload = "";
  paused = true;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {
    this.onloadedmetadata?.();
  }
}

function cloudRig(providerStatus: number) {
  const fetched: string[] = [];
  const el = new El();
  const out = createCloudOut({
    fetch: async (u) => {
      fetched.push(u);
      const provider = u.startsWith("/api/voice/tts");
      const ok = !provider || providerStatus === 200;
      return {
        ok,
        status: provider ? providerStatus : 200,
        headers: {
          get: (k: string) => (k === "X-Voice" && provider && !ok ? "not-configured" : null),
        },
        blob: async () => new Blob(["x"]),
      };
    },
    element: () => el,
    ctx: () => null,
    toUrl: () => `blob:${fetched.length}`,
  });
  const events: string[] = [];
  const ev = {
    onstart: () => void events.push("start"),
    onend: () => void events.push("end"),
    onerror: () => void events.push("error"),
    onfail: (r: string) => void events.push(`fail:${r}`),
  };
  return { out, fetched, events, ev, el };
}

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await tick();
};

describe("voice-out: provider voices", () => {
  const pick = voice("google:cmn-TW-Wavenet-A");

  it("asks /api/voice/tts with the written text", async () => {
    const r = cloudRig(200);
    r.out.play(
      { text: "Web R T C 好", written: "WebRTC 好", lang: "zh-CN", at: 0, volume: 1, pick },
      r.ev,
    );
    await settle();
    expect(r.fetched).toEqual([providerTtsUrl("google:cmn-TW-Wavenet-A", "WebRTC 好")]);
    expect(r.fetched[0]).toBe(
      `/api/voice/tts?voice=google%3Acmn-TW-Wavenet-A&text=${encodeURIComponent("WebRTC 好")}`,
    );
    expect(r.events).toEqual(["start"]);
  });

  it("no key (503): the lane's own cloud voice reads the spoken text, never silence", async () => {
    const r = cloudRig(503);
    r.out.play(
      { text: "Web R T C 好", written: "WebRTC 好", lang: "zh-CN", at: 0, volume: 1, pick },
      r.ev,
    );
    await settle();
    expect(r.fetched).toEqual([
      providerTtsUrl("google:cmn-TW-Wavenet-A", "WebRTC 好"),
      ttsUrl("Web R T C 好", "zh"),
    ]);
    expect(r.events).toEqual(["start"]);
  });

  it("no key and a language the cloud lacks: the session's fallback (onfail)", async () => {
    const r = cloudRig(503);
    r.out.play({ text: "hola", lang: "xx", at: 0, volume: 1, pick }, r.ev);
    await settle();
    expect(r.events).toEqual(["fail:lang"]);
  });

  it("prepare fetches ahead from the provider; a language MeloTTS lacks is still asked", async () => {
    const r = cloudRig(200);
    r.out.prepare?.(
      "x",
      "nan-CN",
      undefined,
      voice("azure:zh-CN-XiaoxiaoDialectsNeural/nan-CN"),
      "食飽未",
    );
    r.out.prepare?.("", "zh", undefined, pick, "");
    r.out.prepare?.("好", "zh", undefined, pick);
    await tick();
    expect(r.fetched).toEqual([
      providerTtsUrl("azure:zh-CN-XiaoxiaoDialectsNeural/nan-CN", "食飽未"),
      providerTtsUrl("google:cmn-TW-Wavenet-A", "好"),
    ]);
    expect(providerSkip("x".repeat(201))).toBe("long");
    expect(providerSkip("  ")).toBe("empty");
    expect(providerSkip("好")).toBeNull();
  });

  it("a text too long for the provider goes to the lane's voice at once", async () => {
    const r = cloudRig(200);
    r.out.play({ text: "好", written: "x".repeat(201), lang: "zh", at: 0, volume: 1, pick }, r.ev);
    await settle();
    expect(r.fetched).toEqual([ttsUrl("好", "zh")]);
  });
});

describe("voice session: provider voices", () => {
  const session = (cloud: ReturnType<typeof cloudRig>["out"]) => {
    const spoken: UtterLike[] = [];
    const played: { text: string; written?: string; pick?: unknown }[] = [];
    const v = createVoice({
      synth: () => ({ speak: (u) => void spoken.push(u), cancel: () => {} }),
      utter: (text, lang) =>
        ({ text, lang, onend: null, onerror: null, onboundary: null }) as UtterLike,
      enabled: () => true,
      here: () => true,
      touch: () => false,
      cloud: () => ({
        ...cloud,
        play: (s, ev) => {
          played.push({ text: s.text, written: s.written, pick: s.pick });
          return cloud.play(s, ev);
        },
      }),
    });
    return { v, spoken, played };
  };

  it("a line's google: voice goes to the cloud with its written text; off, the lane voice reads it", () => {
    resetCloud();
    setCloudVoices({ on: true, map: {} });
    const h = session(cloudRig(200).out);
    expect(h.v.reply("用WebRTC连接。", { voice: "google:cmn-TW-Wavenet-A" })).toBe(true);
    expect(h.played).toEqual([
      {
        text: "用Web R T C连接。",
        written: "用WebRTC连接。",
        pick: voice("google:cmn-TW-Wavenet-A"),
      },
    ]);
    setCloudVoices({ on: false, map: {} });
    const off = session(cloudRig(200).out);
    expect(off.v.reply("好的。", { voice: "google:cmn-TW-Wavenet-A" })).toBe(true);
    expect(off.played).toEqual([]);
    expect(off.spoken.map((u) => u.text)).toEqual(["好的。"]);
    resetCloud();
  });

  it("no voice of its own: the map's voice for the line's language", () => {
    resetCloud();
    setCloudVoices({ on: true, map: { zh: "google:cmn-TW-Wavenet-A" } });
    const h = session(cloudRig(200).out);
    expect(h.v.reply("你好。")).toBe(true);
    expect(h.played[0]?.pick).toEqual(voice("google:cmn-TW-Wavenet-A"));
    // A line naming a voice keeps it.
    const own = session(cloudRig(200).out);
    expect(own.v.reply("你好。", { voice: "melo:zh" })).toBe(true);
    expect(own.played[0]?.pick).toEqual({ kind: "melo", lang: "zh" });
    // English has no map entry: no provider voice.
    const en = session(cloudRig(200).out);
    expect(en.v.reply("Hello.")).toBe(true);
    expect(en.played).toEqual([]);
    resetCloud();
  });
});

describe("cloudVoiceIds lists the Taiwan pair", () => {
  it("both parse", () => {
    const ids = cloudVoiceIds().map((v) => v.id);
    expect(ids).toContain("google:cmn-TW-Wavenet-A");
    expect(ids).toContain("azure:zh-CN-XiaoxiaoDialectsNeural/nan-CN");
    for (const id of ids) expect("error" in parseLineVoice(id)).toBe(false);
  });
});
