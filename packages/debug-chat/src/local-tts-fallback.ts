import type { VoiceId } from "./voices";

export type LocalTtsFallbacks = Record<string, Record<string, string>>;

/** Language and lane choices are data; an unavailable cloud language is never read as English. */
export const DEFAULT_LOCAL_TTS_FALLBACKS: LocalTtsFallbacks = {
  zh: { main: "xiaoxiao", calm: "yunxi", sweet: "xiaobei", bright: "neko-moe" },
};

let fallbacks: LocalTtsFallbacks = {};

export function setLocalTtsFallbacks(value: LocalTtsFallbacks) {
  fallbacks = Object.fromEntries(
    Object.entries(value).map(([lang, picks]) => [lang.toLowerCase(), { ...picks }]),
  );
}

/** Only an explicitly configured, enabled local service may replace the retired cloud voice. */
export function localTtsFallback(lang: string, voice: VoiceId = "main", configured = false) {
  if (!configured) return undefined;
  const key = lang.toLowerCase();
  const picks = fallbacks[key] ?? fallbacks[key.split(/[-_]/)[0]!];
  return picks?.[voice] ?? picks?.main;
}
