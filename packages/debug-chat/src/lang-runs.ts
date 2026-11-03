/**
 * Mixed-language text in runs, each to be voiced in its own language (owner,
 * 2026-11-03 23:16 JST: a Chinese reply with one Japanese word in it was read
 * entirely with the Japanese voice, its Han in Japanese readings).
 *
 * No per-language code: what a language is written in is data
 * (lang-scripts.json). The text is cut into Unicode script runs; a script
 * only one language uses (kana, Hangul, Cyrillic…) decides its run; a shared
 * one (Han) takes the language of a run it is glued to (稲妻 in 稲妻です),
 * else the text's own language when that is written in it, else the
 * language whose primary script it is. Punctuation, digits and spaces stay
 * with the run before them, so nothing is cut into tiny requests.
 */
import data from "./lang-scripts.json";

type LangInfo = { locale: string; scripts: string[]; glue?: string[] };
const LANGS = Object.entries(data.langs as Record<string, LangInfo>);
const BORROWED = data.borrowed as Record<string, number>;
const GLUE_MAX = data.glueMax;

/** Every listed script, with the languages that use it (primary users first). */
const SCRIPTS = (() => {
  const m = new Map<string, { re: RegExp; users: string[]; primary: string }>();
  for (const [lang, info] of LANGS)
    for (const s of info.scripts) {
      const have = m.get(s);
      if (have) have.users.push(lang);
      else m.set(s, { re: new RegExp(`\\p{Script=${s}}`, "u"), users: [lang], primary: lang });
    }
  // The primary user: the language listing it first (zh for Han, not ja).
  for (const [s, v] of m) v.primary = LANGS.find(([, i]) => i.scripts[0] === s)?.[0] ?? v.primary;
  return m;
})();
/** Characters that join the run of a language's own script (ー after kana). */
const GLUE = new Map(LANGS.flatMap(([lang, i]) => (i.glue ?? []).map((c) => [c, lang] as const)));

const scriptOf = (c: string): string | null => {
  for (const [s, v] of SCRIPTS) if (v.re.test(c)) return s;
  return null;
};

/** Language subtag → the locale speechSynthesis is asked for (zh → zh-CN). */
export const localeOf = (lang: string) =>
  (data.langs as Record<string, LangInfo>)[lang]?.locale ?? lang;
const baseOf = (l?: string) => l?.trim().toLowerCase().split(/[-_]/)[0] || undefined;

export type Run = { text: string; lang: string };

type Seg = { text: string; script: string | null; lang?: string };

/** Script runs, the language each decides, and the text's own language. */
function analyse(text: string, hint?: string) {
  // 1. Script runs; neutral characters (punctuation, digits, spaces) are their own segments.
  const segs: Seg[] = [];
  for (const c of text) {
    let s = scriptOf(c);
    if (!s && GLUE.has(c)) {
      const prev = segs.at(-1);
      if (prev?.script && SCRIPTS.get(prev.script)!.users.includes(GLUE.get(c)!)) s = prev.script;
    }
    const last = segs.at(-1);
    if (last && last.script === s) last.text += c;
    else segs.push({ text: c, script: s });
  }
  // 2. Scripts only one language uses decide their runs.
  for (const g of segs) if (g.script && SCRIPTS.get(g.script)!.users.length === 1) g.lang = SCRIPTS.get(g.script)!.users[0];
  // 3. A short shared-script run glued (no neutral between) to a decided one whose language uses it joins it.
  const uses = (lang: string | undefined, script: string) =>
    !!lang && SCRIPTS.get(script)!.users.includes(lang);
  for (let pass = 0; pass < 2; pass++)
    for (let i = 0; i < segs.length; i++) {
      const g = segs[i]!;
      if (!g.script || g.lang || [...g.text].length > GLUE_MAX) continue;
      const nb = [segs[i - 1], segs[i + 1]].find((n) => n?.lang && n.script && uses(n.lang, g.script!));
      if (nb) g.lang = nb.lang;
    }
  // 4. The text's language: the hint, else the language with most characters
  //    (an undecided shared run counted for its primary user; one glued
  //    to a decided run joins it only when short, GLUE_MAX: a Japanese word
  //    in Chinese is 稲妻です, while the Chinese around it runs on).
  let base = baseOf(hint);
  if (!base || !LANGS.some(([l]) => l === base)) {
    const tally = new Map<string, number>();
    for (const g of segs) {
      if (!g.script) continue;
      const l = g.lang ?? SCRIPTS.get(g.script)!.primary;
      // A borrowed script counts by the word (one run), others by the character.
      tally.set(l, (tally.get(l) ?? 0) + (g.script in BORROWED ? 1 : [...g.text].length));
    }
    base = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? baseOf(hint) ?? "en";
  }
  return { segs, base: base as string, uses };
}

/**
 * `text` as runs, each in a language subtag (zh, ja, …). `hint`: the
 * language the text is known to be in (the thread's, the book's, or the
 * whole message's when `text` is one sentence of it), if any.
 */
export function langRuns(text: string, hint?: string): Run[] {
  const { segs, base, uses } = analyse(text, hint);
  // 5. Undecided runs: the text's language when it is written in that script, else the primary user.
  for (const g of segs)
    if (g.script && !g.lang) g.lang = uses(base, g.script) ? base : SCRIPTS.get(g.script)!.primary;
  // 6. A short borrowed-script run (an acronym, a name) keeps the language around it.
  for (let i = 0; i < segs.length; i++) {
    const g = segs[i]!;
    const min = g.script ? BORROWED[g.script] : undefined;
    if (min === undefined || g.lang === base || uses(base, g.script!)) continue;
    // The words of the whole stretch in this script, neutral gaps between them included.
    let j = i;
    let words = 0;
    for (let k = i; k < segs.length; k++) {
      const s = segs[k]!;
      if (s.script === g.script) {
        words++;
        j = k;
      } else if (s.script || /[^\s\p{P}\p{N}]/u.test(s.text) || /[。！？.!?\n]/u.test(s.text)) break;
    }
    if (words >= min) {
      i = j;
      continue;
    }
    const other = (s: Seg) => !!s.lang && s.script !== g.script;
    const around = [...segs.slice(0, i)].reverse().find(other)?.lang ?? segs.slice(j + 1).find(other)?.lang;
    // All of the text is in it: it is no borrowing.
    if (!around) break;
    for (let k = i; k <= j; k++) if (segs[k]!.script === g.script) segs[k]!.lang = around;
    i = j;
  }
  // 7. Neutral segments go with the run before them (the first ones with the run after); merge.
  const out: Run[] = [];
  let lead = "";
  for (const g of segs) {
    if (!g.lang) {
      if (out.length) out.at(-1)!.text += g.text;
      else lead += g.text;
      continue;
    }
    const last = out.at(-1);
    if (last && last.lang === g.lang) last.text += g.text;
    else {
      out.push({ text: lead + g.text, lang: g.lang });
      lead = "";
    }
  }
  if (lead) out.push({ text: lead, lang: base });
  // Whitespace between runs belongs to neither.
  return out.map((r) => ({ ...r, text: r.text.trim() })).filter((r) => r.text);
}
