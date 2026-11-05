#!/usr/bin/env bun
/**
 * Write the scenario sentence sources `<lang>-<scenario>.jsonl` for one
 * language, picked from Tatoeba by data (scene-sentences.ts). Then
 * build-phrase-decks.ts turns them into decks, as for the ja/zh phrases.
 *
 *   DL=<new empty dir outside the repo>; cd $DL; T=fra   # Tatoeba's code for the language
 *   curl -sfLO https://downloads.tatoeba.org/exports/per_language/$T/${T}_sentences_detailed.tsv.bz2
 *   curl -sfLO https://downloads.tatoeba.org/exports/per_language/$T/$T-eng_links.tsv.bz2
 *   curl -sfLO https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences_detailed.tsv.bz2
 *   curl -sfLO https://downloads.tatoeba.org/exports/user_languages.tar.bz2
 *   curl -sfLO https://downloads.tatoeba.org/exports/sentences_base.tar.bz2
 *   curl -sfLO https://downloads.tatoeba.org/exports/tags.tar.bz2
 *   bunzip2 -k *.tsv.bz2; mkdir ul base tags
 *   tar -xjf user_languages.tar.bz2 -C ul; tar -xjf sentences_base.tar.bz2 -C base
 *   tar -xjf tags.tar.bz2 -C tags
 *   cd <repo>; bun scripts/words/build-scene-sentences.ts $DL fr public/words scripts/words/phrases
 *   bun scripts/words/build-phrase-decks.ts scripts/words/phrases public/words
 *
 * Ranks come from the language's frequency lists in public/words
 * (`<lang>-freq-N`, in index.json order) and, when it has one, its lemma
 * file (lemma/<lang>.txt) for inflected forms and known words.
 * Downloads are untrusted data: only split and compared, never executed.
 */
import {
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { parseLemmas } from "@/lib/read/lemma";
import { TATOEBA_CODE } from "./examples";
import { pickSceneSentences, type Candidate, type Vocab } from "./scene-sentences";

const [DL, LANG, WORDS, OUT] = process.argv.slice(2);
const code = LANG && TATOEBA_CODE[LANG];
if (!DL || !code || !WORDS || !OUT) {
  console.error("usage: build-scene-sentences.ts <download-dir> <lang> <words-dir> <phrases-dir>");
  process.exit(1);
}

const lines = async function* (path: string) {
  for await (const l of createInterface({ input: createReadStream(path) })) yield l;
};

// Bands: the frequency lists, in catalog order.
const index = JSON.parse(readFileSync(join(WORDS, "index.json"), "utf8")).lists as {
  id: string;
  lang: string;
  file: string;
  kind?: string;
  exam?: string;
}[];
const freq = index.filter((l) => l.lang === LANG && /-freq-\d+$/.test(l.id));
const bandOf = new Map<string, number>();
freq.forEach((l, i) => {
  for (const e of JSON.parse(readFileSync(join(WORDS, l.file), "utf8")).entries as {
    term: string;
  }[]) {
    const t = e.term.toLowerCase();
    if (!bandOf.has(t)) bandOf.set(t, i + 1);
  }
});
const lemmaFile = join(WORDS, "lemma", `${LANG}.txt`);
const lemmas = existsSync(lemmaFile) ? parseLemmas(readFileSync(lemmaFile, "utf8")) : null;
const vocab: Vocab = {
  beyond: freq.length + 1,
  band(w) {
    const bands = [w, ...(lemmas?.of(w) ?? [])].map((x) => bandOf.get(x)).filter((b) => b != null);
    return bands.length ? Math.min(...bands) : null;
  },
  known: (w) => !lemmas || bandOf.has(w) || lemmas.has(w) || lemmas.of(w).length > 0,
};
console.log(
  `${LANG}: ${freq.length} frequency lists, ${bandOf.size} ranked words, lemmas ${!!lemmas}`,
);

// Native speakers of the language (skill 5).
const natives = new Set<string>();
for await (const l of lines(join(DL, "ul/user_languages.csv"))) {
  const [lang, skill, user] = l.split("\t");
  if (lang === code && skill === "5" && user) natives.add(user);
}
const sents = new Map<string, { text: string; user: string }>();
for await (const l of lines(join(DL, `${code}_sentences_detailed.tsv`))) {
  const [id, , text, user] = l.split("\t");
  if (id && text && user && natives.has(user)) sents.set(id, { text, user });
}
const links = new Map<string, string[]>();
for await (const l of lines(join(DL, `${code}-eng_links.tsv`))) {
  const [a, b] = l.split("\t");
  if (a && b && sents.has(a)) links.set(a, [...(links.get(a) ?? []), b]);
}
const engIds = new Set([...links.values()].flat());
const eng = new Map<string, { text: string; user: string }>();
for await (const l of lines(join(DL, "eng_sentences_detailed.tsv"))) {
  const [id, , text, user] = l.split("\t");
  if (id && text && engIds.has(id)) eng.set(id, { text, user: user && user !== "\\N" ? user : "" });
}
const tags = new Map<string, string[]>();
for await (const l of lines(join(DL, "tags/tags.csv"))) {
  const [id, tag] = l.split("\t");
  if (id && tag && (sents.has(id) || engIds.has(id)))
    tags.set(id, [...(tags.get(id) ?? []), tag.trim()]);
}
const orig = new Set<string>();
for await (const l of lines(join(DL, "base/sentences_base.csv"))) {
  const [id, base] = l.split("\t");
  if (base === "0" && sents.has(id)) orig.add(id);
}

const candidates: Candidate[] = [];
for (const [id, s] of sents) {
  // Its shortest English translation; the tags of the sentence and of every translation.
  const ens = (links.get(id) ?? []).filter((b) => eng.has(b));
  if (!ens.length) continue;
  ens.sort((a, b) => eng.get(a)!.text.length - eng.get(b)!.text.length);
  const en = eng.get(ens[0])!;
  candidates.push({
    id,
    term: s.text,
    en: en.text,
    enId: ens[0],
    enBy: en.user,
    by: s.user,
    tags: [...new Set([id, ...ens].flatMap((x) => tags.get(x) ?? []))],
    orig: orig.has(id),
  });
}
const { decks, rejected } = pickSceneSentences(LANG, candidates, vocab);
console.log(
  `${candidates.length} native sentences with English; left out:`,
  Object.fromEntries(rejected),
);

for (const f of readdirSync(OUT).filter((f) => f.startsWith(`${LANG}-`) && f.endsWith(".jsonl")))
  unlinkSync(join(OUT, f));
for (const [scenario, deck] of decks) {
  const head = `// ${LANG}-${scenario}: written by build-scene-sentences.ts; edit the lexicon, not this file`;
  writeFileSync(
    join(OUT, `${LANG}-${scenario}.jsonl`),
    [head, ...deck.map((l) => JSON.stringify(l))].join("\n") + "\n",
  );
  console.log(`${LANG}-${scenario}`.padEnd(24), deck.length);
}
