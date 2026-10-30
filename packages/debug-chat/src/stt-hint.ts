/**
 * The mic's language hint for speech to text (`?hint=`, lib/stt.ts): the
 * language of the owner's last typed line, else the device's. Only a hint:
 * Whisper still detects per window, and the hint picks which language its
 * prompt leads with. It is learnt from typed lines only, so a misheard
 * transcript (Chinese heard as katakana) cannot teach it the wrong language.
 */
export const STT_HINT_KEY = "lk:agent:stt-hint";

export type SttHint = "zh" | "ja" | "en";
const HINTS: readonly string[] = ["zh", "ja", "en"];

/** A line's language by its script: any kana is Japanese, else Han is Chinese, else Latin is English. */
export function scriptLang(text: string): SttHint | undefined {
  if (/[\p{sc=Hiragana}\p{sc=Katakana}]/u.test(text)) return "ja";
  if (/\p{sc=Han}/u.test(text)) return "zh";
  if (/[A-Za-z]{2,}/.test(text)) return "en";
  return undefined;
}

/** The first of the device's languages that is a hint ("zh-Hans-CN" → "zh"). */
export function deviceLang(langs: readonly string[]): SttHint | undefined {
  for (const l of langs) {
    const p = l.slice(0, 2).toLowerCase();
    if (HINTS.includes(p)) return p as SttHint;
  }
  return undefined;
}

/** A typed line was sent: its language becomes the hint. */
export function learnSttHint(text: string): void {
  const l = scriptLang(text);
  if (!l) return;
  try {
    localStorage.setItem(STT_HINT_KEY, l);
  } catch {}
}

/** The hint for the next recording, or none (the server's mixed prompt). */
export function sttHint(): SttHint | undefined {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STT_HINT_KEY);
  } catch {}
  if (stored && HINTS.includes(stored)) return stored as SttHint;
  if (typeof navigator === "undefined") return undefined;
  return deviceLang(navigator.languages?.length ? navigator.languages : [navigator.language ?? ""]);
}
