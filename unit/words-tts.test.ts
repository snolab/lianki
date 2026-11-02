import { describe, expect, test } from "bun:test";
import { voiceKey } from "@/lib/voice";
import {
  CACHE_HEADERS,
  NO_STORE_HEADERS,
  PUBLIC_CACHE_HEADERS,
  storeParam,
  wordsTts,
  type WordsTtsDeps,
} from "@/lib/words-tts";

const MP3 = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]); // "ID3…"

function deps(over: Partial<WordsTtsDeps> & { recorded?: Record<string, Uint8Array> } = {}) {
  const r2 = new Map<string, Uint8Array>();
  const puts: string[] = [];
  const limited: string[] = [];
  const spoken: string[] = [];
  const logs: string[] = [];
  const d: WordsTtsDeps = {
    getVoiceClip: async (k) => over.recorded?.[k] ?? null,
    getCachedTTS: async (k) => r2.get(k) ?? null,
    putCachedTTS: async (k, audio) => {
      puts.push(k);
      r2.set(k, audio);
    },
    checkRateLimit: (k) => {
      limited.push(k);
      return { allowed: true, retryAfterMs: 0 };
    },
    isConfigured: () => true,
    speechModel: () => "@cf/myshell-ai/melotts",
    speech: async ({ text }) => {
      spoken.push(text);
      return { audio: new Uint8Array(MP3), contentType: "audio/mpeg" };
    },
    log: (where) => void logs.push(where),
    ...over,
  };
  return { d, r2, puts, limited, spoken, logs };
}

const q = (s: string) => new URLSearchParams(s);
const call = (s: string, d: WordsTtsDeps, email: string | null = "a@example.com") =>
  wordsTts(q(s), email, d);

describe("storeParam", () => {
  test("only store=0 opts out", () => {
    expect(storeParam(q(""))).toBe(true);
    expect(storeParam(q("store=1"))).toBe(true);
    expect(storeParam(q("store=false"))).toBe(true);
    expect(storeParam(q("store=0"))).toBe(false);
  });
});

describe("wordsTts", () => {
  test("login and text length are checked first", async () => {
    const { d } = deps();
    expect((await call("lang=en&text=hi", d, null)).status).toBe(401);
    expect((await call("lang=en&text=", d)).status).toBe(400);
    expect((await call(`lang=en&text=${"x".repeat(201)}`, d)).status).toBe(400);
  });

  test("a word clip is generated once, kept in R2 and cached for a year", async () => {
    const { d, puts, spoken } = deps();
    const res = await call("lang=en&text=apple", d);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Voice")).toBe("melotts");
    expect(res.headers.get("Cache-Control")).toBe(CACHE_HEADERS["Cache-Control"]);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP3);
    expect(puts).toHaveLength(1);
    const again = await call("lang=en&text=apple", d);
    expect(again.headers.get("X-Voice")).toBe("melotts-cached");
    expect(again.headers.get("Cache-Control")).toBe(CACHE_HEADERS["Cache-Control"]);
    expect(again.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(spoken).toEqual(["apple"]);
  });

  test("store=0: generated, not written to R2, sent no-store", async () => {
    const { d, puts, spoken, limited } = deps();
    const res = await call("lang=en&text=Hello%20there.&store=0", d);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Voice")).toBe("melotts");
    expect(res.headers.get("Cache-Control")).toBe(NO_STORE_HEADERS["Cache-Control"]);
    expect(puts).toEqual([]);
    expect(spoken).toEqual(["Hello there."]);
    // The miss counted against the same limit as a word's.
    expect(limited).toEqual(["words-tts:a@example.com"]);
  });

  test("store=0 still serves a clip already in R2, without counting a miss", async () => {
    const { d, spoken, limited } = deps();
    await call("lang=en&text=apple", d);
    limited.length = 0;
    const res = await call("lang=en&text=apple&store=0", d);
    expect(res.headers.get("X-Voice")).toBe("melotts-cached");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(spoken).toEqual(["apple"]);
    expect(limited).toEqual([]);
  });

  test("store=0 is rate limited exactly like a word", async () => {
    const { d, spoken } = deps({
      checkRateLimit: () => ({ allowed: false, retryAfterMs: 2500 }),
    });
    for (const s of ["lang=en&text=a", "lang=en&text=a&store=0"]) {
      const res = await call(s, d);
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("3");
    }
    expect(spoken).toEqual([]);
  });

  test("a recording wins, public, store=0 or not", async () => {
    const { d, spoken } = deps({ recorded: { [voiceKey("fr", "mot")]: MP3 } });
    for (const s of ["lang=fr&text=mot", "lang=fr&text=mot&store=0"]) {
      const res = await call(s, d);
      expect(res.headers.get("X-Voice")).toBe("recorded");
      expect(res.headers.get("Cache-Control")).toBe(PUBLIC_CACHE_HEADERS["Cache-Control"]);
    }
    expect(spoken).toEqual([]);
  });

  test("no server voice: 404, with X-Voice: miss for a recorded language", async () => {
    const { d } = deps();
    const miss = await call("lang=de&text=Wort", d);
    expect(miss.status).toBe(404);
    expect(miss.headers.get("X-Voice")).toBe("miss");
    const none = await call("lang=xx&text=w", d);
    expect(none.status).toBe(404);
    expect(none.headers.get("X-Voice")).toBeNull();
  });

  test("lookups and the R2 write may fail; speech still answers", async () => {
    const boom = async () => {
      throw new Error("down");
    };
    const { d, logs } = deps({ getVoiceClip: boom, getCachedTTS: boom, putCachedTTS: boom });
    const res = await call("lang=en&text=apple", d);
    expect(res.status).toBe(200);
    expect(logs).toEqual([
      "words.tts.voice.lookup",
      "words.tts.cache.lookup",
      "words.tts.cache.save",
    ]);
  });

  test("unconfigured: 503; a failed generation: 502", async () => {
    expect((await call("lang=en&text=a", deps({ isConfigured: () => false }).d)).status).toBe(503);
    const { d, logs } = deps({
      speech: async () => {
        throw new Error("ai down");
      },
    });
    expect((await call("lang=en&text=a&store=0", d)).status).toBe(502);
    expect(logs).toEqual(["words.tts.generate"]);
  });
});
