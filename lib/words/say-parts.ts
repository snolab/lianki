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

const LATIN_LANGS = new Set([
  "en",
  "fr",
  "de",
  "es",
  "pt",
  "it",
  "id",
  "sw",
  "vi",
  "nl",
  "pl",
  "tr",
]);

function charLang(ch: string, lang: string, uiLocale: string): string | null {
  const baseLang = lang.toLowerCase().split(/[-_]/)[0];
  if (/[぀-ヿ]/.test(ch)) return "ja";
  if (/[가-힯ᄀ-ᇿ]/.test(ch)) return "ko";
  if (/[Ѐ-ӿ]/.test(ch)) return "ru";
  if (/[一-鿿㐀-䶿]/.test(ch)) return baseLang === "ja" ? "ja" : meaningLang(ch, uiLocale);
  if (/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(ch)) return LATIN_LANGS.has(baseLang) ? lang : "en";
  return null;
}

/**
 * Split an example sentence at every script/language switch, attaching
 * adjacent punctuation to its neighboring part, so mixed-language examples
 * (e.g. `"Use 中文 then continue in English."` or `"I like it. (我喜欢它。)"`)
 * have each segment voiced in its own language.
 */
export function exampleParts(ex: string, lang: string, uiLocale: string): SayPart[] {
  const tokens: { text: string; lang: string | null }[] = [];
  for (const ch of ex) {
    const l = charLang(ch, lang, uiLocale);
    const prev = tokens[tokens.length - 1];
    if (prev && prev.lang === l) prev.text += ch;
    else tokens.push({ text: ch, lang: l });
  }

  // Merge punctuation/whitespace into adjacent script runs.
  const runs: { text: string; lang: string }[] = [];
  let pendingLead = "";
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.lang === null) {
      const prevRun = runs[runs.length - 1];
      const nextTok = tokens[i + 1];
      if (!prevRun) {
        pendingLead += tok.text;
        continue;
      }
      // Split neutral gap at whitespace or opening bracket so trailing punctuation
      // stays with the previous part and opening brackets/quotes stay with the next.
      const splitIdx = tok.text.search(/\s|[(（[「『"“']/);
      if (splitIdx < 0) {
        prevRun.text += tok.text;
      } else {
        const toPrev = tok.text.slice(0, splitIdx);
        const rest = tok.text.slice(splitIdx).trimStart();
        if (toPrev) prevRun.text += toPrev;
        if (nextTok && rest) pendingLead += rest;
        else if (rest.trim()) prevRun.text += " " + rest.trim();
      }
      continue;
    }

    // If a standalone parenthesized gloss like "(我们记录每个事件。)" starts with "("
    // and ends with ")", strip the outer parens so TTS reads the inner text cleanly.
    const nextTok = tokens[i + 1];
    let text = pendingLead + tok.text;
    if (
      /^\s*[(（]$/.test(pendingLead) &&
      nextTok?.lang === null &&
      /^[。！？!?,，、\s]*[)）]\s*$/.test(nextTok.text)
    ) {
      text = tok.text;
      nextTok.text = nextTok.text.replace(/[)）](\s*)$/, "$1");
    }
    pendingLead = "";
    const prevRun = runs[runs.length - 1];
    if (prevRun && prevRun.lang === tok.lang) {
      prevRun.text = `${prevRun.text} ${text}`.trim();
    } else {
      runs.push({ text: text.trim(), lang: tok.lang });
    }
  }

  const cleaned = runs
    .map((r) => ({ kind: "example" as const, text: r.text.trim(), lang: r.lang }))
    .filter((r) => r.text);
  return cleaned.length ? cleaned : [{ kind: "example", text: ex, lang }];
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
