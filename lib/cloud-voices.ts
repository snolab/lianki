/**
 * Provider voices: Google Cloud Text-to-Speech and Azure Speech
 * (docs/li-sound-hub.md, "Provider voices"). One adapter per provider, never
 * per language: which voice reads which language is data (the config key
 * `voice.langVoices`, and a line's own `google:<name>` / `azure:<name>[/<locale>]`,
 * packages/debug-chat/src/voices.ts).
 *
 * Synthesis runs here, on the server, and the page plays the MP3 through the
 * chat's cloud `<audio>` (voice-out.ts): a phone with no speechSynthesis
 * voices at all (his Android) hears them too.
 *
 * Keys are Worker secrets (`GOOGLE_TTS_API_KEY`, `AZURE_SPEECH_KEY`) and are
 * only ever read here, sent in a request header (never a URL), and never
 * logged. Without one, the provider is "not configured" and the page reads
 * the line in its usual voice.
 *
 * Pure request building + an injected fetch, so it is tested with fakes.
 */
import { toSsml, type LexEntry } from "@lianki/debug-chat/lexicon";
import type { LineVoice } from "@lianki/debug-chat/voices";

export type ProviderVoice = Extract<LineVoice, { kind: "google" | "azure" }>;
export type Provider = ProviderVoice["kind"];

/** The Worker secret each provider needs (names only; docs/li-sound-hub.md). */
export const PROVIDER_SECRET: Readonly<Record<Provider, string>> = {
  google: "GOOGLE_TTS_API_KEY",
  azure: "AZURE_SPEECH_KEY",
};

type Env = Record<string, string | undefined>;

/** The provider's key, or "" when it is not set. */
export const providerKey = (p: Provider, env: Env = process.env) =>
  env[PROVIDER_SECRET[p]]?.trim() || "";

/** Whether `p` can be called at all (its key is set). */
export const providerConfigured = (p: Provider, env: Env = process.env) => !!providerKey(p, env);

export const GOOGLE_TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";
/** Azure's region (`voice.azureRegion`) as a host: letters and digits only. */
export const AZURE_REGION = /^[a-z0-9]{2,30}$/;
export const azureTtsUrl = (region: string) =>
  `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
export const AZURE_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

/** What is billed: the SSML body (the terms written as <sub>/<phoneme>), escaped. */
export const ssmlBody = (v: ProviderVoice, text: string, lexicon: readonly LexEntry[]) =>
  toSsml(text, v.lang, lexicon);

/** The characters a provider bills for `text` in `v` (the SSML body's length). */
export const billedChars = (v: ProviderVoice, text: string, lexicon: readonly LexEntry[]) =>
  ssmlBody(v, text, lexicon).length;

export type ProviderRequest = {
  url: string;
  init: { method: "POST"; headers: Record<string, string>; body: string };
};

/** The HTTP request for one sentence (the key goes in a header, never the URL). */
export function providerRequest(
  v: ProviderVoice,
  text: string,
  o: { key: string; lexicon: readonly LexEntry[]; region: string },
): ProviderRequest {
  const body = ssmlBody(v, text, o.lexicon);
  if (v.kind === "google")
    return {
      url: GOOGLE_TTS_URL,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": o.key },
        body: JSON.stringify({
          input: { ssml: `<speak>${body}</speak>` },
          voice: { languageCode: v.lang, name: v.name },
          audioConfig: { audioEncoding: "MP3" },
        }),
      },
    };
  if (!AZURE_REGION.test(o.region)) throw new Error("azure region");
  // A secondary locale (`/nan-CN`): the voice reads the text in it (<lang>).
  const inner = v.locale ? `<lang xml:lang="${v.locale}">${body}</lang>` : body;
  return {
    url: azureTtsUrl(o.region),
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/ssml+xml",
        "Ocp-Apim-Subscription-Key": o.key,
        "X-Microsoft-OutputFormat": AZURE_FORMAT,
        "User-Agent": "lianki",
      },
      body: `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${v.voiceLang}"><voice name="${v.name}">${inner}</voice></speak>`,
    },
  };
}

type FetchLike = (
  url: string,
  init: ProviderRequest["init"] & { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** One sentence in `v`, as MP3. Throws on any provider error (its status only, never the key). */
export async function synthesize(
  v: ProviderVoice,
  text: string,
  o: {
    key: string;
    lexicon: readonly LexEntry[];
    region: string;
    fetch: FetchLike;
    signal?: AbortSignal;
  },
): Promise<{ audio: Uint8Array<ArrayBuffer>; contentType: "audio/mpeg" }> {
  const r = providerRequest(v, text, o);
  const res = await o.fetch(r.url, { ...r.init, ...(o.signal ? { signal: o.signal } : {}) });
  if (!res.ok) throw new Error(`${v.kind} tts http ${res.status}`);
  if (v.kind === "google") {
    const j = (await res.json()) as { audioContent?: unknown };
    if (typeof j?.audioContent !== "string" || !j.audioContent)
      throw new Error("google tts: no audio");
    return {
      audio: Uint8Array.from(atob(j.audioContent), (c) => c.charCodeAt(0)),
      contentType: "audio/mpeg",
    };
  }
  const buf = await res.arrayBuffer();
  if (!buf.byteLength) throw new Error("azure tts: no audio");
  return { audio: new Uint8Array(buf), contentType: "audio/mpeg" };
}
