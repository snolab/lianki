import { BACK_ORDER, type BackPart } from "@/lib/words/row-layout";
import { spokenText, type SpokenCard } from "@/lib/words/spoken";

/**
 * What a tap reads aloud: the word, then its example sentence, then its
 * meaning (the row's order, lib/words/row-layout.ts) — each its own clip, in
 * its own language.
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

/**
 * The word, then the back in the row's order (BACK_ORDER: example → meaning);
 * empty parts and repeats left out.
 */
export function sayParts(
  it: SpokenCard & { ex?: string },
  lang: string,
  readingOnBack: boolean,
  uiLocale: string,
): SayPart[] {
  const word = spokenText(it, lang, readingOnBack);
  const meaning = meaningText(it.back);
  const ex = it.ex?.trim() ?? "";
  const back: Record<BackPart, SayPart | null> = {
    meaning:
      meaning && meaning !== word
        ? { kind: "meaning", text: meaning, lang: meaningLang(meaning, uiLocale) }
        : null,
    // Past the server's limit (400) a part is left to the browser's speech.
    example: ex && ex !== word ? { kind: "example", text: ex, lang } : null,
  };
  const parts: SayPart[] = [];
  if (word) parts.push({ kind: "word", text: word, lang });
  for (const k of BACK_ORDER) {
    const p = back[k];
    if (p) parts.push(p);
  }
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
