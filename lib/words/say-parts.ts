import { BACK_ORDER, type BackPart } from "@/lib/words/row-layout";
import { spokenText, type SpokenCard } from "@/lib/words/spoken";
import { publicCfg } from "@/lib/config-client";
import { dropForeignParens } from "@/lib/words/foreign-parens";

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
export type SayPart = {
  /** Explicit playback from the private original recording; never substitute a synthetic voice. */
  originalOnly?: boolean;
  kind: PartKind;
  text: string;
  lang: string;
  owner?: string;
  /** Private original pronunciation belongs to this exact card, never to text globally. */
  card?: { listId: string; term: string };
};

/*
 * The meaning is voiced like every other part: the server's voice
 * (/api/words/tts, docs/workers-ai.md "Prefetch and cost") with "Server voice"
 * on; with it off, the device's own voice where it has one for the language.
 */

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

/** Keep embedded translations out of the card language's speech engine. */
export function exampleParts(text: string, lang: string): SayPart[] {
  const base = lang.toLowerCase().split(/[-_]/)[0];
  const eastAsian = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
    ? "ja"
    : base === "ja" || base === "ko"
      ? base
      : "zh";
  const latin = ["zh", "ja", "ko", "ru"].includes(base) ? "en" : lang;
  const runs: SayPart[] = [];
  let pending = "";
  for (const ch of text) {
    const scriptLang = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)
      ? eastAsian
      : /\p{Script=Hangul}/u.test(ch)
        ? "ko"
        : /\p{Script=Cyrillic}/u.test(ch)
          ? "ru"
          : /\p{Script=Latin}/u.test(ch)
            ? latin
            : null;
    const last = runs.at(-1);
    if (!scriptLang) {
      if (last) last.text += ch;
      else pending += ch;
    } else if (last?.lang === scriptLang) last.text += ch;
    else {
      runs.push({ kind: "example", text: pending + ch, lang: scriptLang });
      pending = "";
    }
  }
  return runs.length ? runs : [{ kind: "example", text, lang }];
}

/**
 * The word, then the back in the row's order (BACK_ORDER: example → meaning);
 * empty parts and repeats left out. With `words.speak.skipForeignParens` on,
 * a bracketed translation in another script ("I like apples. (我喜欢苹果。)")
 * is not read (lib/words/foreign-parens.ts); the screen still shows it.
 */
export function sayParts(
  it: SpokenCard & { ex?: string },
  lang: string,
  readingOnBack: boolean,
  uiLocale: string,
  skipForeignParens: boolean = publicCfg("words.speak.skipForeignParens"),
): SayPart[] {
  const speakable = (t: string) => (skipForeignParens ? dropForeignParens(t, lang).text : t).trim();
  const word = speakable(spokenText(it, lang, readingOnBack));
  const meaning = meaningText(it.back);
  const ex = speakable(it.ex?.trim() ?? "");
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
    if (p) parts.push(...(p.kind === "example" ? exampleParts(p.text, p.lang) : [p]));
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
