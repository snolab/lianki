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
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04]);

  it("posts prompt + lang to the model's run endpoint and returns the audio", async () => {
    configure();
    let seen: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
    }) as never;

    const out = await workersAiSpeech({ text: "これは日本語です" });

    expect(out).toEqual(Buffer.from(mp3));
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

  it("rejects a JSON body served with a 200 rather than passing it off as audio", async () => {
    // Cloudflare answers some model failures inside a 200 envelope; handing that
    // to an <audio> element produces a silent, unexplained failure.
    configure();
    globalThis.fetch = (async () =>
      new Response('{"success":false,"errors":[{"message":"model overloaded"}]}', {
        headers: { "content-type": "application/json" },
      })) as never;

    expect(workersAiSpeech({ text: "hi" })).rejects.toThrow(/JSON, not audio.*model overloaded/s);
  });
});
