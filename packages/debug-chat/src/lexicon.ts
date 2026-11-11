/**
 * The pronunciation table (docs/li-sound-hub.md, "Pronunciation table"): how
 * a term is SPOKEN, never how it is shown. Li's read-aloud (voice.ts) passes
 * every sentence through `speakForm` before any engine sees it — the
 * device's speechSynthesis and the cloud alike — so "WebRTC" is read
 * "Web R T C" while the chat line still shows "WebRTC".
 *
 * The table is data: the live value is the config key `voice.lexicon`
 * (lib/config.ts, editable at /dev/config with no deploy), handed to the page
 * by the app (`setLexicon`); `DEFAULT_LEXICON` below is only its default.
 * One generic matcher for every language: an entry may name a language
 * (`lang`, a primary subtag like "zh" or a locale like "zh-TW"), and the most
 * specific entry for the sentence's language wins; no per-language code.
 *
 * Matching: whole words only (an ASCII letter or digit next to the term
 * means it is part of a longer word: "APIs" is not "API"), CJK neighbours
 * are fine ("用WebRTC连接"). Case-sensitive unless the entry says
 * `ignoreCase` ("US" is not "us"). One pass, longest term first, so a spoken
 * form is never matched again.
 *
 * `ph` (+ `alphabet`, default IPA) is a phoneme string for engines that take
 * SSML (the server-side provider voices): `toSsml` writes it as `<phoneme>`,
 * else the spoken form as `<sub alias>`.
 */

export type LexEntry = {
  /** The term as written. */
  term: string;
  /** How it is spoken: plain text any engine can read. */
  say: string;
  /** Only for this language ("zh") or locale ("zh-TW"); absent: every language. */
  lang?: string;
  /** Match "github" as well as "GitHub". */
  ignoreCase?: boolean;
  /** Its phonemes, for SSML engines. */
  ph?: string;
  alphabet?: "ipa" | "x-sampa";
};

/** The limits the config schema also enforces (lib/config.ts `voice.lexicon`). */
export const LEX_LIMITS = { entries: 500, term: 40, say: 80, ph: 120 } as const;
export const LEX_LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** The seed (the owner's report, 2026-11-11: TTS said "WebRTC" wrongly). */
export const DEFAULT_LEXICON: readonly LexEntry[] = [
  { term: "WebRTC", say: "Web R T C" },
  { term: "API", say: "A P I" },
  { term: "MCP", say: "M C P" },
  { term: "Tailscale", say: "Tail scale" },
  { term: "Tailscale", lang: "ja", say: "テイルスケール" },
  { term: "iOS", say: "i O S" },
  { term: "iOS", lang: "en", say: "eye O S" },
  { term: "iOS", lang: "ja", say: "アイオーエス" },
  { term: "PWA", say: "P W A" },
  { term: "STT", say: "S T T" },
  { term: "TTS", say: "T T S" },
  { term: "URL", say: "U R L" },
  { term: "JSON", say: "Jason" },
  { term: "JSON", lang: "ja", say: "ジェイソン" },
  { term: "GitHub", say: "Git Hub", ignoreCase: true },
  { term: "GitHub", lang: "ja", say: "ギットハブ", ignoreCase: true },
  { term: "npm", say: "N P M", ignoreCase: true },
  { term: "CLI", say: "C L I" },
  { term: "Lianki", say: "Lian ki" },
  { term: "Lianki", lang: "en", say: "Lee-ahn-kee" },
  { term: "Lianki", lang: "ja", say: "リアンキ" },
];

const str = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;

/** One entry of the table, checked (the page's own copy of the config schema). */
export function isLexEntry(v: unknown): v is LexEntry {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  if (!str(e.term, LEX_LIMITS.term) || !str(e.say, LEX_LIMITS.say)) return false;
  if (e.lang !== undefined && !(typeof e.lang === "string" && LEX_LANG.test(e.lang))) return false;
  if (e.ignoreCase !== undefined && typeof e.ignoreCase !== "boolean") return false;
  if (e.ph !== undefined && !str(e.ph, LEX_LIMITS.ph)) return false;
  if (e.alphabet !== undefined && e.alphabet !== "ipa" && e.alphabet !== "x-sampa") return false;
  return true;
}

type Store = { __lkLexicon?: readonly LexEntry[] };

/**
 * The live table from the app (config `voice.lexicon`). Kept on globalThis so
 * a hot-loaded copy of this module reads the same one. Anything that is not a
 * valid table leaves the default in place.
 */
export function setLexicon(entries: unknown): void {
  if (!Array.isArray(entries) || entries.length > LEX_LIMITS.entries) return;
  const ok = entries.filter(isLexEntry);
  if (ok.length !== entries.length) return;
  (globalThis as Store).__lkLexicon = ok;
}

/** The table in force: the app's, else the default. */
export const activeLexicon = (): readonly LexEntry[] =>
  (globalThis as Store).__lkLexicon ?? DEFAULT_LEXICON;

/** How closely `entry` fits `lang`: -1 not at all, 0 any language, else the length of its tag. */
function fit(entry: LexEntry, lang: string): number {
  if (!entry.lang) return 0;
  const want = entry.lang.toLowerCase();
  const l = lang.toLowerCase().replace(/_/g, "-");
  return l === want || l.startsWith(`${want}-`) ? want.length : -1;
}

type Compiled = { re: RegExp | null; exact: Map<string, LexEntry>; folded: Map<string, LexEntry> };
const cache = new WeakMap<readonly LexEntry[], Map<string, Compiled>>();

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The entries for `lang`: per term (and case rule) the most specific one. */
function compile(entries: readonly LexEntry[], lang: string): Compiled {
  let byLang = cache.get(entries);
  if (!byLang) cache.set(entries, (byLang = new Map()));
  const have = byLang.get(lang);
  if (have) return have;
  const best = new Map<string, { e: LexEntry; f: number }>();
  for (const e of entries) {
    const f = fit(e, lang);
    if (f < 0) continue;
    const key = e.ignoreCase ? `i\n${e.term.toLowerCase()}` : `s\n${e.term}`;
    const b = best.get(key);
    if (!b || f > b.f) best.set(key, { e, f });
  }
  const exact = new Map<string, LexEntry>();
  const folded = new Map<string, LexEntry>();
  for (const { e } of best.values())
    if (e.ignoreCase) folded.set(e.term.toLowerCase(), e);
    else exact.set(e.term, e);
  const terms = [...new Set([...best.values()].map(({ e }) => e.term))].sort(
    (a, b) => b.length - a.length,
  );
  const c: Compiled = {
    re: terms.length ? new RegExp(terms.map(escape).join("|"), "gi") : null,
    exact,
    folded,
  };
  byLang.set(lang, c);
  return c;
}

const WORD = /[A-Za-z0-9_]/;
/** A term's edge touching an ASCII word character makes it part of a longer word. */
const whole = (text: string, at: number, len: number, term: string) =>
  !(WORD.test(term[0]!) && at > 0 && WORD.test(text[at - 1]!)) &&
  !(WORD.test(term[term.length - 1]!) && at + len < text.length && WORD.test(text[at + len]!));

/** Each whole-word occurrence of a term in `text` (one pass, longest first), with its entry. */
function scan(text: string, lang: string, entries: readonly LexEntry[]) {
  const c = compile(entries, lang);
  const hits: { at: number; len: number; e: LexEntry }[] = [];
  if (!c.re || !text) return hits;
  const re = new RegExp(c.re.source, c.re.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const s = m[0];
    const e = c.exact.get(s) ?? c.folded.get(s.toLowerCase());
    if (e && whole(text, m.index, s.length, s)) hits.push({ at: m.index, len: s.length, e });
    // Not a term here (a case it does not take, part of a word): look again one character on.
    else re.lastIndex = m.index + 1;
  }
  return hits;
}

/** `text` as it is spoken in `lang`: each term replaced by its spoken form. */
export function speakForm(
  text: string,
  lang: string,
  entries: readonly LexEntry[] = activeLexicon(),
): string {
  const hits = scan(text, lang, entries);
  if (!hits.length) return text;
  let out = "";
  let from = 0;
  for (const h of hits) {
    out += text.slice(from, h.at) + h.e.say;
    from = h.at + h.len;
  }
  return out + text.slice(from);
}

const xml = (s: string) =>
  s.replace(/[<>&"']/g, (c) => `&${{ "<": "lt", ">": "gt", "&": "amp", '"': "quot", "'": "apos" }[c]};`);

/**
 * `text` as SSML body (no <speak>): escaped, each term a `<phoneme>` when the
 * entry has one, else `<sub alias>` with its spoken form. For engines that
 * read SSML (Google, Azure: lib/cloud-voices.ts).
 */
export function toSsml(
  text: string,
  lang: string,
  entries: readonly LexEntry[] = activeLexicon(),
): string {
  let out = "";
  let from = 0;
  for (const h of scan(text, lang, entries)) {
    const term = xml(text.slice(h.at, h.at + h.len));
    out += xml(text.slice(from, h.at));
    out += h.e.ph
      ? `<phoneme alphabet="${h.e.alphabet ?? "ipa"}" ph="${xml(h.e.ph)}">${term}</phoneme>`
      : `<sub alias="${xml(h.e.say)}">${term}</sub>`;
    from = h.at + h.len;
  }
  return out + xml(text.slice(from));
}
