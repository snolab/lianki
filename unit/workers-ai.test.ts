import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  guessTtsLang,
  isWorkersAiConfigured,
  resolveTtsLang,
  speechModel,
  textModel,
  textModelHq,
  workersAiOpenAI,
  workersAiProvider,
  sniffAudioType,
  workersAiSpeech,
  WORKERS_AI_NOT_CONFIGURED,
} from "../lib/workers-ai";

const ENV_KEYS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_AI_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "WORKERS_AI_MODEL",
  "WORKERS_AI_MODEL_HQ",
  "WORKERS_AI_TTS_MODEL",
] as const;

let saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  globalThis.fetch = realFetch;
});

const configure = () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct123";
  process.env.CLOUDFLARE_AI_TOKEN = "tok_abc";
};

describe("models", () => {
  it("defaults to Workers AI model ids, not OpenAI ones", () => {
    expect(textModel()).toStartWith("@cf/");
    expect(textModelHq()).toStartWith("@cf/");
    expect(speechModel()).toBe("@cf/myshell-ai/melotts");
  });

  it("is overridable per tier without a code change", () => {
    process.env.WORKERS_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";
    process.env.WORKERS_AI_MODEL_HQ = "@cf/other/big";
    process.env.WORKERS_AI_TTS_MODEL = "@cf/deepgram/aura-1";
    expect(textModel()).toBe("@cf/meta/llama-3.1-8b-instruct");
    expect(textModelHq()).toBe("@cf/other/big");
    expect(speechModel()).toBe("@cf/deepgram/aura-1");
  });
});

describe("configuration", () => {
  it("needs both an account and a token", () => {
    expect(isWorkersAiConfigured()).toBe(false);
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct123";
    expect(isWorkersAiConfigured()).toBe(false);
    process.env.CLOUDFLARE_AI_TOKEN = "tok_abc";
    expect(isWorkersAiConfigured()).toBe(true);
  });

  it("accepts the wrangler-style token name as a fallback", () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct123";
    process.env.CLOUDFLARE_API_TOKEN = "tok_wrangler";
    expect(isWorkersAiConfigured()).toBe(true);
  });

  it("treats whitespace-only values as unset", () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "   ";
    process.env.CLOUDFLARE_AI_TOKEN = "tok_abc";
    expect(isWorkersAiConfigured()).toBe(false);
  });

  it("refuses to build a client when unconfigured, with an actionable message", () => {
    expect(() => workersAiOpenAI()).toThrow(WORKERS_AI_NOT_CONFIGURED);
    expect(() => workersAiProvider()).toThrow(WORKERS_AI_NOT_CONFIGURED);
    expect(workersAiSpeech({ text: "hi" })).rejects.toThrow(WORKERS_AI_NOT_CONFIGURED);
  });
});

describe("clients", () => {
  it("points the OpenAI SDK at the account's compatibility endpoint", () => {
    configure();
    const client = workersAiOpenAI();
    expect(client.baseURL).toBe("https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1");
    expect(client.apiKey).toBe("tok_abc");
  });

  it("builds an AI SDK provider that yields a model", () => {
    configure();
    const model = workersAiProvider()(textModel());
    expect(model.modelId).toBe(textModel());
  });
});

describe("tts language", () => {
  it("reads the script when the caller gives no locale", () => {
    expect(guessTtsLang("これは日本語です")).toBe("ja"); // kana wins over the han it also contains
    expect(guessTtsLang("한국어입니다")).toBe("ko");
    expect(guessTtsLang("这是中文")).toBe("zh");
    expect(guessTtsLang("plain english")).toBe("en");
  });

  it("prefers an explicit locale over the guess", () => {
    // Romanised Japanese would otherwise read as English.
    expect(resolveTtsLang("konnichiwa", "ja")).toBe("ja");
    expect(resolveTtsLang("konnichiwa", "ja-JP")).toBe("ja");
    expect(resolveTtsLang("konnichiwa", "JA_jp")).toBe("ja");
  });

  it("falls back to the guess for a locale MeloTTS cannot speak", () => {
    // Passing "de" through would make the model reject the request outright.
    expect(resolveTtsLang("これは日本語です", "de")).toBe("ja");
    expect(resolveTtsLang("hello", "de")).toBe("en");
    expect(resolveTtsLang("hello", "")).toBe("en");
    expect(resolveTtsLang("hello", undefined)).toBe("en");
  });
});

describe("speech", () => {
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04]); // "ID3"
  const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]); // "RIFF….WAVE"
  /** What the live API actually returns — verified against Workers AI. */
  const envelope = (bytes: Uint8Array) =>
    new Response(
      JSON.stringify({ result: { audio: Buffer.from(bytes).toString("base64") }, success: true }),
      { headers: { "content-type": "application/json" } },
    );

  it("posts prompt + lang to the model's run endpoint and returns the audio", async () => {
    configure();
    let seen: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
    }) as never;

    const out = await workersAiSpeech({ text: "これは日本語です" });

    expect(out.audio).toEqual(Buffer.from(mp3));
    expect(out.contentType).toBe("audio/mpeg");
    expect(seen!.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/myshell-ai/melotts",
    );
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok_abc");
    expect(JSON.parse(seen!.init.body as string)).toEqual({
      prompt: "これは日本語です",
      lang: "ja",
    });
  });

  it("honours an explicit lang", async () => {
    configure();
    let body = "";
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      body = init.body as string;
      return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
    }) as never;

    await workersAiSpeech({ text: "hello", lang: "fr" });
    expect(JSON.parse(body).lang).toBe("fr");
  });

  it("surfaces the provider's error text instead of a bare status", async () => {
    configure();
    globalThis.fetch = (async () =>
      new Response('{"errors":[{"message":"Authentication error"}]}', { status: 401 })) as never;

    expect(workersAiSpeech({ text: "hi" })).rejects.toThrow(/HTTP 401.*Authentication error/s);
  });

  it("decodes the JSON envelope the live API actually returns", async () => {
    // Cloudflare's model docs say binary MP3. The live API returns
    // {result:{audio:"<base64>"}} as application/json, and the bytes are WAV.
    // Rejecting that shape — which the first version of this client did — makes
    // every TTS request fail in production while passing every doc-based test.
    configure();
    globalThis.fetch = (async () => envelope(wav)) as never;

    const out = await workersAiSpeech({ text: "これは日本語です" });
    expect(out.audio).toEqual(Buffer.from(wav));
    expect(out.contentType).toBe("audio/wav");
  });

  it("sniffs the container instead of trusting the documented format", () => {
    expect(sniffAudioType(wav)).toBe("audio/wav");
    expect(sniffAudioType(mp3)).toBe("audio/mpeg");
    expect(sniffAudioType(new Uint8Array([0xff, 0xfb, 0x90]))).toBe("audio/mpeg"); // raw frame sync
    expect(sniffAudioType(new Uint8Array([0x4f, 0x67, 0x67, 0x53]))).toBe("audio/ogg");
    expect(sniffAudioType(new Uint8Array([1, 2, 3, 4]))).toBe("application/octet-stream");
  });

  it("rejects a 200 envelope that carries no audio", async () => {
    // A model-side failure wrapped in a success envelope; handing it to an
    // <audio> element produces a silent, unexplained dead player.
    configure();
    globalThis.fetch = (async () =>
      new Response('{"success":false,"errors":[{"message":"model overloaded"}]}', {
        headers: { "content-type": "application/json" },
      })) as never;

    expect(workersAiSpeech({ text: "hi" })).rejects.toThrow(/no audio.*model overloaded/s);
  });

  it("rejects an unparseable JSON body", async () => {
    configure();
    globalThis.fetch = (async () =>
      new Response("<html>gateway</html>", {
        headers: { "content-type": "application/json" },
      })) as never;

    expect(workersAiSpeech({ text: "hi" })).rejects.toThrow(/unparseable JSON/);
  });
});
