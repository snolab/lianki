// The reader's Translate (owner, 2026-11-04 14:58 JST: "when i click translate
// it goes to google translate but dont, lets use ai credits and our api"):
// the selected text in the learner's own language, shown on the selection
// card itself. The rules are pure and here; the I/O (cache, model, charge) is
// lib/read/translate-server.ts.
//
// Nothing is per language: a language is named to the model by Intl's own
// English name for its code, and the cache is keyed by the text and the
// target code alone.

/** The longest text one translation takes, in characters (bounds a call's cost). */
export const MAX_TRANSLATE_CHARS = 6000;

/** A BCP 47 tag as the reader sends it ("fr", "zh-Hans", "pt-BR"); anything else is refused. */
const TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

export function langTag(v: unknown): string | null {
  if (typeof v !== "string" || !TAG.test(v)) return null;
  try {
    return Intl.getCanonicalLocales(v)[0] ?? null;
  } catch {
    return null;
  }
}

/** The language's English name ("ja" → "Japanese"), or its code when Intl has none. */
export function langName(tag: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** The text as it is translated and cached: NFC, trimmed, runs of spaces in a line made one. */
export function normText(text: string): string {
  return text
    .normalize("NFC")
    .split(/\n{2,}/)
    .map((p) => p.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The cache key: SHA-256 of the target and the normalised text (hex). With
 * translator's notes it is another key, so a translation made without them is
 * never served as one that had the chance to carry them; a change to the rule
 * below means a new version here.
 */
export async function translationKey(to: string, text: string, notes = false): Promise<string> {
  const bytes = new TextEncoder().encode(`${to}\n${notes ? "notes:v1\n" : ""}${text}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The prompt: translate into `to`, keep the paragraphs, answer with the translation alone. */
export function translateMessages(text: string, to: string, from: string | null, notes = false) {
  const src = from ? `from ${langName(from)} ` : "";
  const answer = notes
    ? "Answer with the translation only: no quotes, no explanation. The one exception: where a " +
      "cultural difference really changes what the reader would understand (an idiom, an " +
      "honorific or level of politeness, a taboo, wordplay that does not carry over), put a " +
      `short translator's note in ${langName(to)} right after the phrase, inside ⟦ and ⟧, ` +
      "at most 20 words. Most texts need none: never note ordinary vocabulary, grammar or " +
      "facts, and never invent a difference. "
    : "Answer with the translation only: no notes, no quotes, no explanation. ";
  return [
    {
      role: "system" as const,
      content:
        `You translate text ${src}into ${langName(to)} (language code "${to}") for a ` +
        "language learner reading it in a book. Translate faithfully and naturally, keeping " +
        "names, the paragraph breaks and the tone. " +
        answer +
        "If the text is already in that language, repeat it.",
    },
    { role: "user" as const, content: text },
  ];
}

/** The model's answer as shown: trimmed, without a wrapping pair of quotes; "" when empty. */
export function cleanTranslation(out: string): string {
  const t = out.trim();
  const m = /^(["“「『])([\s\S]*)(["”」』])$/.exec(t);
  return (m && !/["“”「」『』]/.test(m[2]) ? m[2] : t).trim();
}

/**
 * A translation cut at its translator's notes, for the card to show them as
 * notes. A ⟦ left open (the answer was cut off) or a stray ⟧ never reaches the reader.
 */
export function translationParts(out: string): { text: string; note: boolean }[] {
  const parts: { text: string; note: boolean }[] = [];
  let at = 0;
  for (const m of out.matchAll(/⟦([^⟦⟧]*)⟧/g)) {
    if (m.index > at) parts.push({ text: out.slice(at, m.index), note: false });
    if (m[1].trim()) parts.push({ text: m[1].trim(), note: true });
    at = m.index + m[0].length;
  }
  if (at < out.length) parts.push({ text: out.slice(at), note: false });
  return parts
    .map((p) => (p.note ? p : { ...p, text: p.text.replace(/⟦[^]*$/, "").replace(/⟧/g, "") }))
    .filter((p) => p.text);
}
