import { describe, expect, test } from "bun:test";
import { voiceKey } from "@/lib/voice";
import { ttsParams, voiceKeyAsync } from "@/lib/voice-clip";
import {
  CLIP_CACHE_CONTROL,
  cacheKeyUrl,
  handle,
  recordedClipOf,
  type EdgeCache,
  type Env,
} from "../workers/voice/src/clip";

const ORIGIN = "https://lianki.com";
const url = (q: string) => `${ORIGIN}/api/words/tts?${q}`;

function setup(objects: Record<string, string> = {}) {
  const got: string[] = [];
  const passed: Request[] = [];
  const store = new Map<string, Response>();
  const waits: Promise<unknown>[] = [];
  const env: Env = {
    BLOBS: {
      get: async (key) => {
        got.push(key);
        const body = objects[key];
        if (body === undefined) return null;
        return {
          body: new Response(body).body!,
          size: body.length,
          httpEtag: `"etag-${body.length}"`,
        };
      },
    },
    MAIN: {
      fetch: async (req) => {
        passed.push(req);
        return new Response("from main", { status: 401 });
      },
    },
  };
  const cache: EdgeCache = {
    match: async (key) => store.get(key.url)?.clone(),
    put: async (key, res) => void store.set(key.url, res),
  };
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
  const get = (u: string, init?: RequestInit) => handle(new Request(u, init), env, ctx, cache);
  return { env, got, passed, store, waits, get };
}

describe("voiceKeyAsync", () => {
  test("is the very key the renderer writes and the route reads", async () => {
    for (const [lang, text] of [
      ["ja", "ひと"],
      ["en", "the"],
      ["fr", "C'est la vie."],
    ])
      expect(await voiceKeyAsync(lang, text)).toBe(voiceKey(lang, text));
  });
});

describe("ttsParams", () => {
  test("primary subtag in lower case, text trimmed", () => {
    expect(ttsParams(new URLSearchParams("lang=FR-fr&text=%20mot%20"))).toEqual({
      lang: "fr",
      text: "mot",
    });
    expect(ttsParams(new URLSearchParams(""))).toEqual({ lang: "", text: "" });
  });
});

describe("recordedClipOf", () => {
  test("only a GET of a recorded language, within the length limit", () => {
    expect(recordedClipOf(new Request(url("lang=fr&text=mot")))).toEqual({
      lang: "fr",
      text: "mot",
    });
    expect(recordedClipOf(new Request(url("lang=fr&text=mot"), { method: "HEAD" }))).toBeNull();
    // Korean is MeloTTS only: nothing to look up here.
    expect(recordedClipOf(new Request(url("lang=ko&text=말")))).toBeNull();
    expect(recordedClipOf(new Request(url("lang=fr&text=")))).toBeNull();
    expect(recordedClipOf(new Request(url(`lang=fr&text=${"a".repeat(201)}`)))).toBeNull();
    expect(recordedClipOf(new Request(`${ORIGIN}/api/words/ttsx?lang=fr&text=mot`))).toBeNull();
  });
});

describe("lianki-voice", () => {
  test("a recording is served from R2, public and immutable, with no session", async () => {
    const key = voiceKey("fr", "mot");
    const { get, got, passed, waits, store } = setup({ [key]: "mp3!" });
    const res = await get(url("lang=fr&text=mot"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("mp3!");
    expect(res.headers.get("Cache-Control")).toBe(CLIP_CACHE_CONTROL);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(res.headers.get("Content-Length")).toBe("4");
    expect(res.headers.get("ETag")).toBe('"etag-4"');
    expect(res.headers.get("X-Voice")).toBe("recorded");
    expect(got).toEqual([key]);
    expect(passed).toHaveLength(0);
    // Kept in the edge cache, under the normalised URL.
    await Promise.all(waits);
    expect([...store.keys()]).toEqual([cacheKeyUrl(ORIGIN, "fr", "mot")]);
  });

  test("an edge-cache hit never reaches R2, whatever the spelling of the query", async () => {
    const key = voiceKey("fr", "mot");
    const { get, got, waits } = setup({ [key]: "mp3!" });
    await get(url("lang=fr&text=mot"));
    await Promise.all(waits);
    const again = await get(url("text=%20mot&lang=fr-FR&v=2"));
    expect(await again.text()).toBe("mp3!");
    expect(got).toEqual([key]);
  });

  test("no recording: the main Worker answers, with the request as it came", async () => {
    const { get, passed } = setup();
    const res = await get(url("lang=fr&text=inconnu"), { headers: { Cookie: "s=1" } });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("from main");
    expect(passed).toHaveLength(1);
    expect(passed[0].headers.get("Cookie")).toBe("s=1");
    expect(passed[0].url).toBe(url("lang=fr&text=inconnu"));
  });

  test("a language with no recordings goes straight to the main Worker", async () => {
    const { get, got, passed } = setup();
    await get(url("lang=ko&text=말"));
    expect(got).toHaveLength(0);
    expect(passed).toHaveLength(1);
  });

  test("a failed edge-cache write still serves the clip", async () => {
    const key = voiceKey("fr", "mot");
    const objects = { [key]: "mp3!" };
    const s = setup(objects);
    const failing: EdgeCache = {
      match: async () => undefined,
      put: () => Promise.reject(new Error("cache full")),
    };
    const ctx = { waitUntil: (p: Promise<unknown>) => void s.waits.push(p) };
    const res = await handle(new Request(url("lang=fr&text=mot")), s.env, ctx, failing);
    expect(await res.text()).toBe("mp3!");
    await Promise.all(s.waits);
  });

  test("an R2 error falls back to the main Worker", async () => {
    const s = setup();
    s.env.BLOBS.get = async () => {
      throw new Error("R2 down");
    };
    const err = console.error;
    console.error = () => {};
    try {
      const res = await s.get(url("lang=fr&text=mot"));
      expect(res.status).toBe(401);
      expect(s.passed).toHaveLength(1);
    } finally {
      console.error = err;
    }
  });
});
