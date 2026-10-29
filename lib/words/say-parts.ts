import { spokenText, type SpokenCard } from "@/lib/words/spoken";

/**
 * What a tap reads aloud: the word, then its meaning, then the example
 * sentence — each its own clip, in its own language.
 */
export type PartKind = "word" | "meaning" | "example";
export type SayPart = { kind: PartKind; text: string; lang: string };

/**
 * Who voices the meaning, until the owner decides:
 * - "server": /api/words/tts (MeloTTS for most meanings, generated once and
 *   kept in R2 — see docs/workers-ai.md, "Prefetch and cost").
 * - "browser": the device's speech engine, free, but voices vary by device.
 */
export const MEANING_VOICE: "server" | "browser" = "server";

/**
 * The meaning's first sense, without notes: "outside, exterior; other" →
 * "outside"; "I (first person singular …)" → "I".
 */
export function meaningText(back: string): string {
  const bare = back.replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]/g, " ");
  const first = bare.split(/\s*[;,/·、；，]\s*/).find((s) => s.trim()) ?? "";
  return first.replace(/\s+/g, " ").trim();
}

/**
 * The meaning's language, from its script. The UI locale settles what script
 * alone cannot (Han text is Japanese for a Japanese UI). Latin text is read
 * as English: the bundled lists' meanings are English whatever the UI is, and
 * a French voice reading English would teach nothing.
 */
export function meaningLang(text: string, uiLocale: string): string {
  const ui = uiLocale.toLowerCase().split(/[-_]/)[0];
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[가-힯ᄀ-ᇿ]/.test(text)) return "ko";
  if (/[一-鿿㐀-䶿]/.test(text)) return ui === "ja" ? "ja" : "zh";
  if (/[Ѐ-ӿ]/.test(text)) return "ru";
  return "en";
}

/** Word → meaning → example; empty parts and repeats left out. */
export function sayParts(
  it: SpokenCard & { ex?: string },
  lang: string,
  readingOnBack: boolean,
  uiLocale: string,
): SayPart[] {
  const word = spokenText(it, lang, readingOnBack);
  const meaning = meaningText(it.back);
  const ex = it.ex?.trim() ?? "";
  const parts: SayPart[] = [];
  if (word) parts.push({ kind: "word", text: word, lang });
  if (meaning && meaning !== word)
    parts.push({ kind: "meaning", text: meaning, lang: meaningLang(meaning, uiLocale) });
  // Past the server's limit (400) a part is left to the browser's speech.
  if (ex && ex !== word) parts.push({ kind: "example", text: ex, lang });
  return parts;
}

/**
 * Rows' parts in prefetch order: every word first, then the examples, then
 * the meanings — each in row order.
 */
export function prefetchOrder(rows: SayPart[][]): SayPart[] {
  const order: PartKind[] = ["word", "example", "meaning"];
  return order.flatMap((kind) => rows.flatMap((parts) => parts.filter((p) => p.kind === kind)));
}
