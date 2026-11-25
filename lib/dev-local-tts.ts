import { LOCAL_ENGINES } from "@lianki/debug-chat/voices";
import type { LocalTtsFallbacks } from "@lianki/debug-chat/local-tts-fallback";
import { ttsParams } from "@/lib/voice-clip";

export type SpeechFetch = (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => Promise<Response>;

/** The existing development server can reach its local voice service even
 * when a phone cannot. Never enabled in a deployed Worker or for a non-dev. */
export function devLocalSpeech(
  params: URLSearchParams,
  env: { LIANKI_DEV_WHOLE_PAGE?: string; NEXT_PUBLIC_LIANKI_LOCAL_TTS_BASE?: string },
  dev: boolean,
  voices: LocalTtsFallbacks,
  request: SpeechFetch = fetch,
) {
  if (!dev || env.LIANKI_DEV_WHOLE_PAGE !== "1" || !env.NEXT_PUBLIC_LIANKI_LOCAL_TTS_BASE)
    return null;
  const { lang } = ttsParams(params);
  const laneVoices = voices[lang] ?? voices[lang.split(/[-_]/)[0]!];
  if (!laneVoices) return null;
  const voice = params.get("localVoice");
  if (!voice || !LOCAL_ENGINES.includes(voice) || !Object.values(laneVoices).includes(voice))
    return null;
  const base = env.NEXT_PUBLIC_LIANKI_LOCAL_TTS_BASE.replace(/\/+$/, "");
  return {
    model: `local:${voice}`,
    async speech({ text, signal }: { text: string; signal?: AbortSignal }) {
      const url = new URL(`${base}/tts`);
      url.searchParams.set("voice", voice);
      url.searchParams.set("text", text);
      const timeout = AbortSignal.timeout(10_000);
      const response = await request(url, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: "error",
      }).catch(() => {
        throw new Error("Local speech unavailable");
      });
      if (!response.ok) throw new Error(`Local speech HTTP ${response.status}`);
      const contentType = response.headers.get("Content-Type") ?? "";
      if (!contentType.startsWith("audio/")) throw new Error("Local speech returned no audio");
      const audio = new Uint8Array(await response.arrayBuffer());
      if (!audio.byteLength) throw new Error("Local speech returned empty audio");
      return { audio, contentType };
    },
  };
}
