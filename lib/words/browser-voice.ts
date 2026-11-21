import { voiceQuality } from "@lianki/debug-chat/wire";

/**
 * Browser speech (Web Speech API): instant, offline, no rate limit, and every
 * language the OS has a voice for. Where it cannot speak — no API, no voice
 * for the language, or it never starts (Firefox on Android) — the word comes
 * from the server instead (/api/words/tts, generated once and cached).
 */

/**
 * Full language tags for speech. A bare "ja" with no voice chosen lets
 * Android pick any engine voice — Japanese then came out in a Chinese accent.
 */
export const SPEECH_TAG: Record<string, string> = {
  ja: "ja-JP",
  zh: "zh-CN",
  ko: "ko-KR",
  fr: "fr-FR",
  es: "es-ES",
  de: "de-DE",
  it: "it-IT",
  pt: "pt-BR",
  ru: "ru-RU",
  fi: "fi-FI",
  en: "en-US",
};

/** What a listed speechSynthesis voice offers (SpeechSynthesisVoice). */
export type ListedVoice = {
  lang: string;
  voiceURI?: string;
  name?: string;
  localService?: boolean;
};

/**
 * The device voice for one part's language (its own, lib/words/part-lang.ts —
 * never the card's), or null: only a voice of this very language. With none
 * listed the OS would pick its default voice, a Japanese voice reading French.
 */
export function browserVoiceFor<V extends ListedVoice>(
  voices: readonly V[],
  lang: string,
): V | null {
  // Android has reported tags as "fr_FR".
  const norm = (v: V) => v.lang.toLowerCase().replace("_", "-");
  const want = lang.toLowerCase().replace("_", "-");
  const vs = voices.filter((v) => norm(v).startsWith(want));
  const tag = (SPEECH_TAG[want] ?? want).toLowerCase();
  // The language's own region first (ja-JP, not a ja voice of elsewhere).
  const exact = vs.filter((v) => norm(v) === tag);
  // Natural voices first: iOS lists robotic Eloquence and novelty voices first.
  const best = (pool: V[]) => {
    const q = Math.max(-1, ...pool.map(voiceQuality));
    const top = pool.filter((v) => voiceQuality(v) === q);
    return top.find((v) => v.localService) ?? top[0];
  };
  return best(exact) ?? best(vs) ?? null;
}
