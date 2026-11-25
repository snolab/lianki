import { expect, test } from "bun:test";
import { devLocalSpeech, type SpeechFetch } from "@/lib/dev-local-tts";
import { DEFAULT_LOCAL_TTS_FALLBACKS } from "@lianki/debug-chat/local-tts-fallback";

const env = {
  LIANKI_DEV_WHOLE_PAGE: "1",
  NEXT_PUBLIC_LIANKI_LOCAL_TTS_BASE: "https://voice.example.invalid",
};
const q = (value = "lang=zh&text=test&localVoice=xiaoxiao") => new URLSearchParams(value);
const make = (params = q(), request?: SpeechFetch) =>
  devLocalSpeech(params, env, true, DEFAULT_LOCAL_TTS_FALLBACKS, request);

test("local speech stays inside the existing dev server and configured language voices", () => {
  expect(devLocalSpeech(q(), env, false, DEFAULT_LOCAL_TTS_FALLBACKS)).toBeNull();
  expect(devLocalSpeech(q(), {}, true, DEFAULT_LOCAL_TTS_FALLBACKS)).toBeNull();
  expect(
    devLocalSpeech(q(), { ...env, LIANKI_DEV_WHOLE_PAGE: "0" }, true, DEFAULT_LOCAL_TTS_FALLBACKS),
  ).toBeNull();
  expect(make(q("lang=en&text=test"))).toBeNull();
  expect(make(q("lang=zh&text=test"))).toBeNull();
  expect(make(q("lang=zh&localVoice=not-configured"))).toBeNull();
  expect(devLocalSpeech(q(), env, true, { zh: { main: "unknown" } })).toBeNull();
  expect(devLocalSpeech(q(), env, true, { zh: {} })).toBeNull();
});

test("phone requests use a configured server URL, keep text intact and preserve the chosen voice", async () => {
  const controller = new AbortController();
  let requested: URL | undefined;
  const local = make(q("lang=zh-CN&localVoice=xiaobei"), async (url, init) => {
    requested = new URL(String(url));
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeDefined();
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "audio/mpeg" } });
  })!;
  expect(local.model).toBe("local:xiaobei");
  expect((await local.speech({ text: "你好 & 好梦", signal: controller.signal })).audio).toEqual(
    new Uint8Array([1, 2, 3]),
  );
  expect(requested?.origin).toBe(env.NEXT_PUBLIC_LIANKI_LOCAL_TTS_BASE);
  expect(requested?.searchParams.get("text")).toBe("你好 & 好梦");
  expect(requested?.searchParams.get("voice")).toBe("xiaobei");
});

test("failures never return non-audio or expose the configured host", async () => {
  const failure = make(q(), async () => {
    throw new Error(env.NEXT_PUBLIC_LIANKI_LOCAL_TTS_BASE);
  })!;
  await expect(failure.speech({ text: "test" })).rejects.toThrow("Local speech unavailable");
  for (const response of [
    new Response("bad", { status: 502 }),
    new Response("html"),
    new Response("", { headers: { "Content-Type": "audio/mpeg" } }),
  ]) {
    const local = make(q(), async () => response)!;
    await expect(local.speech({ text: "test" })).rejects.toThrow();
  }
  const ok = make(
    q(),
    async () => new Response("audio", { headers: { "Content-Type": "audio/mpeg" } }),
  )!;
  expect((await ok.speech({ text: "test" })).contentType).toBe("audio/mpeg");
});
