import { BACK_ORDER, type BackPart } from "@/lib/words/row-layout";
import { spokenText, type SpokenCard } from "@/lib/words/spoken";

/**
 * What a tap reads aloud: the word, then its example sentence, then its
 * meaning (the row's order, lib/words/row-layout.ts) — each its own clip, in
 * its own language.
 */
export type PartKind = "word" | "meaning" | "example";
/**
 * `owner`: the card it belongs to (its key), so the spoken-word highlight
 * lights that card's example and no other card showing the same sentence.
 */
export type SayPart = { kind: PartKind; text: string; lang: string; owner?: string };

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
 * Split an example sentence by script/language so a parenthesized or trailing
 * translation (e.g. `"I like it. (我喜欢它。)"`) is voiced in its own language
 * rather than read by the word's TTS voice.
 */
export function exampleParts(ex: string, lang: string, uiLocale: string): SayPart[] {
  const baseLang = lang.toLowerCase().split(/[-_]/)[0];
  const isLatinTarget = !["zh", "ja", "ko", "ru", "ar", "hi", "bn", "ur", "mr"].includes(baseLang);
  if (!isLatinTarget) return [{ kind: "example", text: ex, lang }];

  const parts: SayPart[] = [];
  // Match parenthesized foreign-script glosses or bare foreign-script runs.
  const re =
    /[(（]([^()（）]*[぀-ヿ가-힯ᄀ-ᇿ一-鿿㐀-䶿Ѐ-ӿ][^()（）]*)[)）]|([぀-ヿ가-힯ᄀ-ᇿ一-鿿㐀-䶿Ѐ-ӿ][぀-ヿ가-힯ᄀ-ᇿ一-鿿㐀-䶿Ѐ-ӿ\s、，。！？；：…—·0-9a-zA-Z]*[぀-ヿ가-힯ᄀ-ᇿ一-鿿㐀-䶿Ѐ-ӿ。！？]?)/g;
  let last = 0;
  for (const m of ex.matchAll(re)) {
    const idx = m.index ?? 0;
    const before = ex.slice(last, idx).trim();
    if (before) parts.push({ kind: "example", text: before, lang });
    const inner = (m[1] ?? m[2] ?? "").trim();
    if (inner) {
      parts.push({ kind: "example", text: inner, lang: meaningLang(inner, uiLocale) });
    }
    last = idx + m[0].length;
  }
  const tail = ex.slice(last).trim();
  if (tail) parts.push({ kind: "example", text: tail, lang });
  return parts.length ? parts : [{ kind: "example", text: ex, lang }];
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
  const back: Record<BackPart, SayPart[]> = {
    meaning:
      meaning && meaning !== word
        ? [{ kind: "meaning", text: meaning, lang: meaningLang(meaning, uiLocale) }]
        : [],
    // Past the server's limit (400) a part is left to the browser's speech.
    example: ex && ex !== word ? exampleParts(ex, lang, uiLocale) : [],
  };
  const parts: SayPart[] = [];
  if (word) parts.push({ kind: "word", text: word, lang });
  for (const k of BACK_ORDER) {
    parts.push(...back[k]);
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
