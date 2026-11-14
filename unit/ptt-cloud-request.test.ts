import { expect, test } from "bun:test";
import { postStt } from "../packages/debug-chat/src/mic";

test("PTT cloud decode reuses the existing raw-audio route with explicit abort and supported model selection", async () => {
  const ac = new AbortController();
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Response.json({ text: "observed text", model: "@cf/openai/whisper-large-v3-turbo" });
  }) as typeof fetch;
  const wav = new Uint8Array([1, 2, 3]);
  expect(
    await postStt(wav, fetcher, "audio/wav", "zh", {
      signal: ac.signal,
      model: "@cf/openai/whisper-large-v3-turbo",
    }),
  ).toEqual({ text: "observed text", model: "@cf/openai/whisper-large-v3-turbo" });
  expect(calls[0]!.url).toBe(
    "/api/debug/stt?hint=zh&model=%40cf%2Fopenai%2Fwhisper-large-v3-turbo",
  );
  expect(calls[0]!.init).toMatchObject({
    method: "POST",
    body: wav,
    signal: ac.signal,
    headers: { "content-type": "audio/wav" },
  });
  expect(calls[0]!.url).not.toMatch(/scene|quality/);
  ac.abort();
  expect(calls[0]!.init!.signal!.aborted).toBe(true);
});
