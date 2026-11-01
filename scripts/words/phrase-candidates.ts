#!/usr/bin/env bun
/**
 * Candidate phrases for the scenario phrase decks (build-phrase-decks.ts):
 * short Tatoeba sentences written by users who declare the language native
 * (skill 5 in the user_languages export), with an English translation.
 * Chinese keeps simplified characters only: a character CC-CEDICT lists only
 * as traditional rules a sentence out. Writes cand-<lang>.tsv with
 * id, sentence, English, author, and `orig` (written in this language),
 * `tr:<id>` (translated from that sentence) or `unk`.
 * The decks were picked from these; see public/words/SOURCES.md,
 * "Scenario phrase decks".
 *
 *   DL=<new empty dir outside the repo>; cd $DL
 *   for t in jpn cmn; do
 *     curl -sfLO https://downloads.tatoeba.org/exports/per_language/$t/${t}_sentences_detailed.tsv.bz2
 *     curl -sfLO https://downloads.tatoeba.org/exports/per_language/$t/$t-eng_links.tsv.bz2
 *   done
 *   curl -sfLO https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2
 *   curl -sfLO https://downloads.tatoeba.org/exports/user_languages.tar.bz2
 *   curl -sfLO https://downloads.tatoeba.org/exports/sentences_base.tar.bz2
 *   bunzip2 -k *.tsv.bz2; mkdir ul base cedict
 *   tar -xjf user_languages.tar.bz2 -C ul; tar -xjf sentences_base.tar.bz2 -C base
 *   curl -sfL https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz | gunzip > cedict/cedict.txt
 *   bun scripts/words/phrase-candidates.ts $DL <out-dir>
 *
 * Downloads are untrusted data: only split and compared, never executed.
 */
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { MAX_TERM } from "@/lib/words/phrases";

const [DL, OUT] = process.argv.slice(2);
if (!DL || !OUT) {
  console.error("usage: phrase-candidates.ts <download-dir> <out-dir>");
  process.exit(1);
}
const CODES = { ja: "jpn", zh: "cmn" } as const;
/** A little over the deck limit: the curator may trim punctuation. */
const max = (lang: string) => (MAX_TERM[lang] ?? 20) + 2;

const natives: Record<string, Set<string>> = { jpn: new Set(), cmn: new Set() };
for (const l of readFileSync(join(DL, "ul/user_languages.csv"), "utf8").split("\n")) {
  const [lang, skill, user] = l.split("\t");
  if (skill === "5" && natives[lang]) natives[lang].add(user);
}

// Characters CC-CEDICT has only on the traditional side.
const trad = new Set<string>();
const simp = new Set<string>();
for (const l of readFileSync(join(DL, "cedict/cedict.txt"), "utf8").split("\n")) {
  if (l.startsWith("#")) continue;
  const [t, s] = l.split(" ");
  if (!t || !s || [...t].length !== [...s].length) continue;
  const ss = [...s];
  [...t].forEach((c, i) => (c !== ss[i] ? trad.add(c) : simp.add(c)));
  ss.forEach((c) => simp.add(c));
}
for (const c of simp) trad.delete(c);

const wanted = new Map<string, { lang: string; text: string; user: string }>();
for (const [lang, code] of Object.entries(CODES)) {
  for (const l of readFileSync(join(DL, `${code}_sentences_detailed.tsv`), "utf8").split("\n")) {
    const [id, , text, user] = l.split("\t");
    if (!id || !text || !natives[code].has(user)) continue;
    if ([...text].length > max(lang)) continue;
    if (/[0-9０-９A-Za-zＡ-Ｚａ-ｚ]/.test(text)) continue;
    if (lang === "zh" && ([...text].some((c) => trad.has(c)) || /[぀-ヿ]/.test(text))) continue;
    wanted.set(id, { lang, text, user });
  }
}
// English translations
const links = new Map<string, string[]>();
for (const code of Object.values(CODES))
  for (const l of readFileSync(join(DL, `${code}-eng_links.tsv`), "utf8").split("\n")) {
    const [a, b] = l.split("\t");
    if (a && b && wanted.has(a)) links.set(a, [...(links.get(a) ?? []), b]);
  }
const engIds = new Set([...links.values()].flat());
const eng = new Map<string, string>();
for await (const l of createInterface({ input: createReadStream(join(DL, "eng_sentences.tsv")) })) {
  const i = l.indexOf("\t");
  const id = l.slice(0, i);
  if (engIds.has(id)) eng.set(id, l.slice(l.indexOf("\t", i + 1) + 1));
}
// Written in this language, or translated from another sentence
const base = new Map<string, string>();
for await (const l of createInterface({
  input: createReadStream(join(DL, "base/sentences_base.csv")),
})) {
  const i = l.indexOf("\t");
  const id = l.slice(0, i);
  if (wanted.has(id)) base.set(id, l.slice(i + 1));
}
for (const lang of Object.keys(CODES)) {
  const rows: string[] = [];
  for (const [id, w] of wanted) {
    if (w.lang !== lang) continue;
    const ens = (links.get(id) ?? []).map((b) => eng.get(b)).filter((x): x is string => !!x);
    if (!ens.length) continue;
    ens.sort((a, b) => a.length - b.length);
    const b = base.get(id);
    const orig = b === "0" ? "orig" : b && b !== "\\N" ? `tr:${b}` : "unk";
    rows.push([id, w.text, ens[0], w.user, orig].join("\t"));
  }
  writeFileSync(join(OUT, `cand-${lang}.tsv`), rows.join("\n") + "\n");
  console.log(lang, rows.length);
}
