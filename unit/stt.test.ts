import { describe, expect, it } from "bun:test";
import {
  DEFAULT_STT_MODEL,
  FALLBACK_STT_MODEL,
  STT_MAX_BYTES,
  STT_MODELS,
  STT_PRICE_PER_MIN,
  pickSttModel,
  readStt,
  sttLang,
} from "@/lib/stt";
import { STT_MAX, STT_MAX_OWNER, type SttDeps, handleStt } from "@/lib/stt-handler";

describe("STT models", () => {
  it("the owner may pick a listed model; everyone else gets the default", () => {
    expect(pickSttModel("@cf/openai/whisper", true)).toBe("@cf/openai/whisper");
    expect(pickSttModel("@cf/openai/whisper", false)).toBe(DEFAULT_STT_MODEL);
    expect(pickSttModel("@cf/meta/llama-3", true)).toBe(DEFAULT_STT_MODEL);
    expect(pickSttModel(null, true)).toBe(DEFAULT_STT_MODEL);
    expect(STT_MODELS).toContain(FALLBACK_STT_MODEL);
    for (const m of STT_MODELS) expect(m in STT_PRICE_PER_MIN).toBe(true);
  });

  it("sttLang takes a short BCP-47 tag or nothing", () => {
    expect(sttLang("zh-CN")).toBe("zh-CN");
    expect(sttLang(" ja ")).toBe("ja");
    expect(sttLang("multi language")).toBeUndefined();
    expect(sttLang("")).toBeUndefined();
    expect(sttLang(null)).toBeUndefined();
  });

  it("readStt reads each model's answer, and tolerates junk", () => {
    expect(
      readStt("@cf/deepgram/nova-3", {
        results: { channels: [{ detected_language: "en", alternatives: [{ transcript: "hi" }] }] },
      }),
    ).toEqual({ text: "hi", language: "en" });
    expect(readStt("@cf/deepgram/nova-3", null)).toEqual({ text: "" });
    expect(readStt("@cf/openai/whisper", { text: " a " })).toEqual({ text: "a" });
    // Nova-3's spaces between Japanese words go; spaces next to Latin stay.
    expect(
      readStt("@cf/deepgram/nova-3", {
        results: {
          channels: [
            {
              alternatives: [
                { transcript: "君 を生 かす も 僕 次第 だ。 I see 君 は", languages: ["ja"] },
              ],
            },
          ],
        },
      }),
    ).toEqual({ text: "君を生かすも僕次第だ。 I see 君は", language: "ja" });
    expect(readStt("@cf/openai/whisper-large-v3-turbo", { transcription_info: {} })).toEqual({
      text: "",
    });
  });
});

describe("POST /api/debug/stt", () => {
  const audio = new Uint8Array([1, 2, 3, 4]);
  const post = (body: BodyInit | null = audio, q = "", headers: Record<string, string> = {}) =>
    new Request(`https://lianki.com/api/debug/stt${q}`, {
      method: "POST",
      body,
      headers: { "content-type": "audio/webm;codecs=opus", ...headers },
    });
  const deps = (over: Partial<SttDeps> = {}) => {
    const seen: Record<string, unknown>[] = [];
    const logs: Record<string, unknown>[] = [];
    const counts = new Map<string, number>();
    let t = 1000;
    const d: SttDeps = {
      user: { id: "u1" },
      owner: false,
      transcribe: async (o) => {
        seen.push({ ...o, audio: o.audio.byteLength });
        t += 250;
        return { text: "你好 hello", language: "zh" };
      },
      limit: (key, max) => {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return { allowed: n <= max, retryAfterMs: 61_000 };
      },
      clock: () => t,
      log: (o) => logs.push(o),
      ...over,
    };
    return { d, seen, logs };
  };

  it("transcribes with the default model and answers {text, model, ms, language}", async () => {
    const { d, seen, logs } = deps();
    const res = await handleStt(post(), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      text: "你好 hello",
      model: DEFAULT_STT_MODEL,
      ms: 250,
      language: "zh",
    });
    expect(seen).toEqual([
      { audio: 4, mime: "audio/webm", model: DEFAULT_STT_MODEL, lang: undefined },
    ]);
    // Sizes and timings only: no text, no audio.
    expect(logs).toEqual([
      { msg: "debug.stt", model: DEFAULT_STT_MODEL, bytes: 4, ms: 250, chars: 8 },
    ]);
  });

  it("only audio types: webm, ogg, mp4, wav, mpeg (codecs ignored); others 415", async () => {
    for (const t of ["audio/webm;codecs=opus", "audio/ogg", "audio/mp4", "audio/wav", "audio/mpeg"])
      expect((await handleStt(post(audio, "", { "content-type": t }), deps().d)).status).toBe(200);
    for (const t of ["text/plain", "application/octet-stream", "video/mp4", ""]) {
      const { d, seen } = deps();
      const res = await handleStt(post(audio, "", { "content-type": t }), d);
      expect(res.status).toBe(415);
      expect(seen).toEqual([]);
    }
  });

  it("guests get 401; GET 405; empty 400; too large 413", async () => {
    expect((await handleStt(post(), deps({ user: null }).d)).status).toBe(401);
    expect(
      (await handleStt(new Request("https://lianki.com/api/debug/stt"), deps().d)).status,
    ).toBe(405);
    expect((await handleStt(post(new Uint8Array(0)), deps().d)).status).toBe(400);
    expect(
      (await handleStt(post(audio, "", { "content-length": String(STT_MAX_BYTES + 1) }), deps().d))
        .status,
    ).toBe(413);
    expect((await handleStt(post(new Uint8Array(STT_MAX_BYTES + 1)), deps().d)).status).toBe(413);
  });

  it("rate limits per user: friends at STT_MAX, the owner at STT_MAX_OWNER", async () => {
    const { d } = deps();
    for (let i = 0; i < STT_MAX; i++) expect((await handleStt(post(), d)).status).toBe(200);
    const res = await handleStt(post(), d);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("61");
    const owner = deps({ owner: true }).d;
    for (let i = 0; i < STT_MAX + 1; i++) expect((await handleStt(post(), owner)).status).toBe(200);
    expect(STT_MAX_OWNER).toBeGreaterThan(STT_MAX);
  });

  it("?model= is the owner's only; ?lang= is a hint", async () => {
    const friend = deps();
    await handleStt(post(audio, "?model=@cf/openai/whisper&lang=ja"), friend.d);
    expect(friend.seen[0]).toMatchObject({ model: DEFAULT_STT_MODEL, lang: "ja" });
    const owner = deps({ owner: true });
    const res = await handleStt(post(audio, "?model=@cf/openai/whisper"), owner.d);
    expect((await res.json()).model).toBe("@cf/openai/whisper");
  });

  it("the default failing falls back once; a model the owner asked for does not", async () => {
    let n = 0;
    const tried: string[] = [];
    const flaky = deps({
      transcribe: async (o) => {
        tried.push(o.model);
        if (n++ === 0) throw new Error("default down");
        return { text: `via ${o.model}` };
      },
    });
    const res = await handleStt(post(), flaky.d);
    expect(await res.json()).toMatchObject({
      text: `via ${FALLBACK_STT_MODEL}`,
      model: FALLBACK_STT_MODEL,
    });
    expect(tried).toEqual([DEFAULT_STT_MODEL, FALLBACK_STT_MODEL]);
    const down = deps({
      transcribe: async () => {
        throw new Error("all down");
      },
    });
    const r2 = await handleStt(post(), down.d);
    expect(r2.status).toBe(502);
    expect((await r2.json()).error).toBe("transcription failed: all down");
    expect(down.logs.at(-1)).toEqual({
      msg: "debug.stt.error",
      model: FALLBACK_STT_MODEL,
      bytes: 4,
    });
    const asked = deps({
      owner: true,
      transcribe: async () => {
        throw new Error("no");
      },
    });
    const r3 = await handleStt(post(audio, `?model=${DEFAULT_STT_MODEL}`), asked.d);
    expect(r3.status).toBe(502);
  });
});

describe("POST /api/debug/stt defaults", () => {
  it("uses the real clock and logs as JSON when none is given", async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (s: string) => lines.push(s);
    try {
      const res = await handleStt(
        new Request("https://lianki.com/api/debug/stt", {
          method: "POST",
          body: new Uint8Array([1]),
          headers: { "content-type": "audio/wav" },
        }),
        {
          user: { id: "u2" },
          owner: false,
          transcribe: async () => ({ text: "ok" }),
          limit: () => ({ allowed: true, retryAfterMs: 0 }),
        },
      );
      expect((await res.json()).text).toBe("ok");
    } finally {
      console.log = log;
    }
    expect(JSON.parse(lines[0])).toMatchObject({ msg: "debug.stt", bytes: 1, chars: 2 });
  });
});
