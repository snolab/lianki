import { describe, expect, it } from "bun:test";
import { parseLineVoice, lineVoiceOf } from "@lianki/debug-chat/voices";
import type { LexEntry } from "@lianki/debug-chat/lexicon";
import {
  AZURE_FORMAT,
  GOOGLE_TTS_URL,
  PROVIDER_SECRET,
  type ProviderVoice,
  azureTtsUrl,
  billedChars,
  providerConfigured,
  providerKey,
  providerRequest,
  synthesize,
} from "@/lib/cloud-voices";
import {
  CLOUD_VOICE_MAX_TEXT,
  cloudVoiceTts,
  type CloudVoiceDeps,
} from "@/lib/cloud-voices-handler";
import { CREDITS_PER_USD as CREDITS_PER_USD_FOR_TEST } from "@/lib/payments/credits";
import {
  MARGIN,
  PROVIDER_TTS_USD_PER_M,
  providerTier,
  providerTtsUsd,
  FEATURES,
} from "@/lib/payments/prices";
import { FEATURES as USAGE_FEATURES } from "@/lib/payments/credit-usage";
import { CONFIG, parseConfigValue } from "@/lib/config";
import { FLAGS } from "@/lib/flags";

const LEX: LexEntry[] = [{ term: "WebRTC", say: "Web R T C" }];
const voice = (id: string) => {
  const v = parseLineVoice(id);
  if ("error" in v || (v.kind !== "google" && v.kind !== "azure")) throw new Error(id);
  return v as ProviderVoice;
};

describe("parseLineVoice: provider voices", () => {
  it("takes google:<name> with its locale", () => {
    expect(parseLineVoice("google:cmn-TW-Wavenet-A")).toEqual({
      kind: "google",
      id: "google:cmn-TW-Wavenet-A",
      name: "cmn-TW-Wavenet-A",
      lang: "cmn-TW",
    });
    expect(lineVoiceOf("google:en-US-Chirp3-HD-Achernar")?.kind).toBe("google");
  });

  it("takes azure:<name> and an optional /<locale> it reads the text in", () => {
    expect(parseLineVoice("azure:zh-TW-HsiaoChenNeural")).toEqual({
      kind: "azure",
      id: "azure:zh-TW-HsiaoChenNeural",
      name: "zh-TW-HsiaoChenNeural",
      voiceLang: "zh-TW",
      lang: "zh-TW",
    });
    expect(parseLineVoice("azure:zh-CN-XiaoxiaoDialectsNeural/nan-CN")).toEqual({
      kind: "azure",
      id: "azure:zh-CN-XiaoxiaoDialectsNeural/nan-CN",
      name: "zh-CN-XiaoxiaoDialectsNeural",
      voiceLang: "zh-CN",
      locale: "nan-CN",
      lang: "nan-CN",
    });
  });

  it("refuses anything else, never guessing", () => {
    for (const bad of [
      "google:",
      "google:Wavenet",
      "google:cmn-tw-Wavenet-A",
      "google:cmn-TW-Wavenet-A<x>",
      'google:cmn-TW-"A"',
      "azure:",
      "azure:XiaoxiaoNeural",
      "azure:zh-CN-Xiaoxiao Neural",
      "azure:zh-CN-XiaoxiaoNeural/nan",
      "azure:zh-CN-XiaoxiaoNeural/nan-CN/x",
    ])
      expect("error" in parseLineVoice(bad)).toBe(true);
  });
});

describe("providerRequest", () => {
  it("google: SSML with the lexicon as <sub>, the key in a header, never the URL", () => {
    const r = providerRequest(voice("google:cmn-TW-Wavenet-A"), "用WebRTC & 手机", {
      key: "k-test",
      lexicon: LEX,
      region: "",
    });
    expect(r.url).toBe(GOOGLE_TTS_URL);
    expect(r.url).not.toContain("k-test");
    expect(r.init.headers["X-Goog-Api-Key"]).toBe("k-test");
    expect(JSON.parse(r.init.body)).toEqual({
      input: { ssml: '<speak>用<sub alias="Web R T C">WebRTC</sub> &amp; 手机</speak>' },
      voice: { languageCode: "cmn-TW", name: "cmn-TW-Wavenet-A" },
      audioConfig: { audioEncoding: "MP3" },
    });
  });

  it("azure: the region's host, the voice, and a secondary locale as <lang>", () => {
    const r = providerRequest(voice("azure:zh-CN-XiaoxiaoDialectsNeural/nan-CN"), "食飽未", {
      key: "k-az",
      lexicon: LEX,
      region: "eastasia",
    });
    expect(r.url).toBe(azureTtsUrl("eastasia"));
    expect(r.url).toBe("https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1");
    expect(r.init.headers["Ocp-Apim-Subscription-Key"]).toBe("k-az");
    expect(r.init.headers["X-Microsoft-OutputFormat"]).toBe(AZURE_FORMAT);
    expect(r.init.body).toBe(
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><voice name="zh-CN-XiaoxiaoDialectsNeural"><lang xml:lang="nan-CN">食飽未</lang></voice></speak>',
    );
    const plain = providerRequest(voice("azure:zh-TW-HsiaoChenNeural"), "好", {
      key: "k",
      lexicon: [],
      region: "japaneast",
    });
    expect(plain.init.body).toContain('<voice name="zh-TW-HsiaoChenNeural">好</voice>');
    expect(() =>
      providerRequest(voice("azure:zh-TW-HsiaoChenNeural"), "好", {
        key: "k",
        lexicon: [],
        region: "evil.example/x",
      }),
    ).toThrow();
  });

  it("bills the SSML body's characters", () => {
    expect(billedChars(voice("google:cmn-TW-Standard-A"), "WebRTC", LEX)).toBe(
      '<sub alias="Web R T C">WebRTC</sub>'.length,
    );
  });
});

describe("synthesize", () => {
  it("google: decodes audioContent; azure: the body is the MP3", async () => {
    const calls: string[] = [];
    const g = await synthesize(voice("google:cmn-TW-Wavenet-A"), "好", {
      key: "k",
      lexicon: [],
      region: "",
      fetch: async (url) => {
        calls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ audioContent: btoa("ID3abc") }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      },
    });
    expect(new TextDecoder().decode(g.audio)).toBe("ID3abc");
    expect(g.contentType).toBe("audio/mpeg");
    const a = await synthesize(voice("azure:zh-TW-HsiaoChenNeural"), "好", {
      key: "k",
      lexicon: [],
      region: "eastasia",
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({}),
        arrayBuffer: async () => new TextEncoder().encode("ID3xyz").buffer as ArrayBuffer,
      }),
    });
    expect(new TextDecoder().decode(a.audio)).toBe("ID3xyz");
    expect(calls).toEqual([GOOGLE_TTS_URL]);
  });

  it("throws on an HTTP error or no audio, naming only the status", async () => {
    const res =
      (ok: boolean, status: number, body: unknown, bytes = 0) =>
      async () => ({
        ok,
        status,
        json: async () => body,
        arrayBuffer: async () => new ArrayBuffer(bytes),
      });
    const o = { key: "secret-key", lexicon: [], region: "eastasia" };
    const g = voice("google:cmn-TW-Wavenet-A");
    const a = voice("azure:zh-TW-HsiaoChenNeural");
    await expect(synthesize(g, "x", { ...o, fetch: res(false, 403, {}) })).rejects.toThrow(
      "google tts http 403",
    );
    await expect(synthesize(g, "x", { ...o, fetch: res(true, 200, {}) })).rejects.toThrow(
      "no audio",
    );
    await expect(synthesize(a, "x", { ...o, fetch: res(true, 200, {}, 0) })).rejects.toThrow(
      "no audio",
    );
    await expect(synthesize(a, "x", { ...o, fetch: res(false, 401, {}) })).rejects.not.toThrow(
      "secret-key",
    );
  });
});

describe("keys: names only, inert without them", () => {
  it("reads only the named secrets", () => {
    expect(PROVIDER_SECRET).toEqual({ google: "GOOGLE_TTS_API_KEY", azure: "AZURE_SPEECH_KEY" });
    expect(providerConfigured("google", {})).toBe(false);
    expect(providerConfigured("google", { GOOGLE_TTS_API_KEY: "  " })).toBe(false);
    expect(providerConfigured("azure", { AZURE_SPEECH_KEY: "x" })).toBe(true);
    expect(providerKey("azure", { AZURE_SPEECH_KEY: " x " })).toBe("x");
  });
});

describe("prices", () => {
  it("list price per tier × MARGIN; an unknown Google tier is priced as the dearest", () => {
    expect(providerTier("google", "cmn-TW-Standard-A")).toBe("google:standard");
    expect(providerTier("google", "cmn-TW-Wavenet-A")).toBe("google:wavenet");
    expect(providerTier("google", "en-US-Neural2-F")).toBe("google:neural2");
    expect(providerTier("google", "en-US-Chirp3-HD-Achernar")).toBe("google:chirp");
    expect(providerTier("google", "en-US-Studio-O")).toBe("google:studio");
    expect(providerTier("google", "en-US-Mystery-A")).toBe("google:studio");
    expect(providerTier("azure", "zh-TW-HsiaoChenNeural")).toBe("azure:neural");
    expect(providerTier("azure", "en-US-Ava:DragonHDLatestNeural")).toBe("azure:hd");
    expect(providerTtsUsd("google", "cmn-TW-Standard-A", 1_000_000)).toBeCloseTo(
      PROVIDER_TTS_USD_PER_M["google:standard"] * MARGIN,
    );
    expect(providerTtsUsd("azure", "zh-TW-HsiaoChenNeural", 0)).toBe(0);
    // 100 characters of Google Standard: 0.09 credits (research, 2026-11-11).
    expect(
      providerTtsUsd("google", "cmn-TW-Standard-A", 100) * CREDITS_PER_USD_FOR_TEST,
    ).toBeCloseTo(0.09);
    expect(FEATURES).toContain("voice.cloud");
    expect(USAGE_FEATURES["voice.cloud"]?.group).toBe("voice");
  });
});

describe("config and flag", () => {
  it("the language → voice map is data, validated by the same parser", () => {
    const d = CONFIG["voice.langVoices"].default;
    expect(d["zh-TW"]).toBe("google:cmn-TW-Wavenet-A");
    expect(d.nan).toBe("azure:zh-CN-XiaoxiaoDialectsNeural/nan-CN");
    expect(parseConfigValue("voice.langVoices", d).ok).toBe(true);
    expect(parseConfigValue("voice.langVoices", { zh: "melo:zh" }).ok).toBe(false);
    expect(parseConfigValue("voice.langVoices", { Chinese: "google:cmn-TW-Wavenet-A" }).ok).toBe(
      false,
    );
    expect(parseConfigValue("voice.azureRegion", "eastasia").ok).toBe(true);
    expect(parseConfigValue("voice.azureRegion", "evil.example").ok).toBe(false);
  });

  it("voice.cloud-voices: positive, off by default, the owner's", () => {
    const f = FLAGS["voice.cloud-voices"];
    expect(f.default).toBe(false);
    expect(f.audience).toBe("owner");
  });
});

/** The route's logic with fakes: who may, what it refuses, what it charges. */
function deps(o: Partial<CloudVoiceDeps> = {}) {
  const paid: number[] = [];
  const said: string[] = [];
  const logs: string[] = [];
  const d: CloudVoiceDeps = {
    enabled: async () => true,
    configured: () => true,
    lexicon: async () => LEX,
    checkRateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
    pay: async (usd, run) => {
      paid.push(usd);
      return { ok: true, value: await run(), charged: 1 };
    },
    synthesize: async (_v, text) => {
      said.push(text);
      return {
        audio: new TextEncoder().encode("ID3") as Uint8Array<ArrayBuffer>,
        contentType: "audio/mpeg",
      };
    },
    log: (w) => void logs.push(w),
    ...o,
  };
  return { d, paid, said, logs };
}
const q = (voice: string, text: string) => new URLSearchParams({ voice, text });

describe("cloudVoiceTts", () => {
  it("serves a sentence as MP3, never kept, paid at the provider's price", async () => {
    const h = deps();
    const r = await cloudVoiceTts(q("google:cmn-TW-Wavenet-A", "WebRTC 好"), "a@b.c", h.d);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(r.headers.get("X-Voice")).toBe("google");
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(h.said).toEqual(["WebRTC 好"]);
    expect(h.paid[0]).toBeCloseTo(
      providerTtsUsd("google", "cmn-TW-Wavenet-A", '<sub alias="Web R T C">WebRTC</sub> 好'.length),
    );
  });

  it("refuses: signed out 401, feature off 404, a bad voice or text 400", async () => {
    const h = deps();
    expect((await cloudVoiceTts(q("google:cmn-TW-Wavenet-A", "x"), null, h.d)).status).toBe(401);
    expect(
      (
        await cloudVoiceTts(
          q("google:cmn-TW-Wavenet-A", "x"),
          "a@b.c",
          deps({ enabled: async () => false }).d,
        )
      ).status,
    ).toBe(404);
    for (const [v, t] of [
      ["melo:zh", "x"],
      ["device:Meijia", "x"],
      ["nope", "x"],
      ["google:cmn-TW-Wavenet-A", ""],
      ["google:cmn-TW-Wavenet-A", "   "],
      ["google:cmn-TW-Wavenet-A", "x".repeat(CLOUD_VOICE_MAX_TEXT + 1)],
    ])
      expect((await cloudVoiceTts(q(v!, t!), "a@b.c", h.d)).status).toBe(400);
    expect((await cloudVoiceTts(new URLSearchParams(), "a@b.c", h.d)).status).toBe(400);
    expect(h.paid).toEqual([]);
  });

  it("no key: 503 not-configured, nothing charged", async () => {
    const h = deps({ configured: () => false });
    const r = await cloudVoiceTts(q("azure:zh-TW-HsiaoChenNeural", "好"), "a@b.c", h.d);
    expect(r.status).toBe(503);
    expect(r.headers.get("X-Voice")).toBe("not-configured");
    expect(h.paid).toEqual([]);
    // The real check: no secret in this test process.
    const real = deps({ configured: undefined });
    const saved = process.env.AZURE_SPEECH_KEY;
    delete process.env.AZURE_SPEECH_KEY;
    try {
      expect(
        (await cloudVoiceTts(q("azure:zh-TW-HsiaoChenNeural", "好"), "a@b.c", real.d)).status,
      ).toBe(503);
    } finally {
      if (saved !== undefined) process.env.AZURE_SPEECH_KEY = saved;
    }
  });

  it("rate limited: 429 with Retry-After", async () => {
    const h = deps({ checkRateLimit: () => ({ allowed: false, retryAfterMs: 1500 }) });
    const r = await cloudVoiceTts(q("google:cmn-TW-Wavenet-A", "x"), "a@b.c", h.d);
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("2");
  });

  it("not enough credits: the wallet's 402; a provider error: 502, logged", async () => {
    const poor = deps({
      pay: async () => ({ ok: false, reason: "no-credits", balance: 0, need: 1, recommended: 1 }),
    });
    const r = await cloudVoiceTts(q("google:cmn-TW-Wavenet-A", "x"), "a@b.c", poor.d);
    expect(r.status).toBe(402);
    expect(poor.said).toEqual([]);
    const down = deps({
      synthesize: async () => {
        throw new Error("google tts http 500");
      },
    });
    const e = await cloudVoiceTts(q("google:cmn-TW-Wavenet-A", "x"), "a@b.c", down.d);
    expect(e.status).toBe(502);
    expect(down.logs).toEqual(["voice.cloud.generate"]);
  });
});
