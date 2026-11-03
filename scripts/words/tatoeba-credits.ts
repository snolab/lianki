#!/usr/bin/env bun
/**
 * Per-sentence credits for the Tatoeba example sentences in the word lists
 * (Tatoeba's CC BY 2.0 FR asks for the author of each sentence). For every
 * list in index.json that is not a phrase deck (those carry their credits in
 * SOURCES.md, build-phrase-decks.ts), each example (`ex`) found verbatim in
 * Tatoeba is written with its author, and its English translation (`exTr`)
 * with that sentence's id and author, to `credits/tatoeba-<lang>.tsv`.
 * Examples not found in Tatoeba are Wiktionary usage examples (credited as
 * Wiktionary in SOURCES.md).
 *
 *   # the detailed exports carry each sentence's author
 *   for t in fra spa deu kor ita por rus heb fin jpn cmn eng; do
 *     curl -sfL https://downloads.tatoeba.org/exports/per_language/$t/${t}_sentences_detailed.tsv.bz2 \
 *       | bunzip2 > $RAW/tatoeba-detailed/${t}_sentences_detailed.tsv
 *   done
 *   # plus $RAW/tatoeba/<code>-eng_links.tsv (build-word-lists.ts step 5)
 *   bun scripts/words/tatoeba-credits.ts $RAW public/words
 *   # WORDS_ONLY=fi,he… credits only those languages (others' files are kept)
 *
 * Downloads are untrusted data: only split and compared, never executed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TATOEBA_CODE } from "./examples";

const [RAW, OUT] = process.argv.slice(2);
if (!RAW || !OUT) {
  console.error("usage: tatoeba-credits.ts <raw-dir> <words-dir>");
  process.exit(1);
}

type Row = { id: string; lang: string; kind?: string; file: string };
const lists = (JSON.parse(readFileSync(join(OUT, "index.json"), "utf8")).lists as Row[]).filter(
  (l) => l.kind !== "phrase",
);

/** id → author, and text → ids, for the sentences of one export we need. */
function detailed(code: string, want: Set<string>) {
  const byText = new Map<string, string[]>();
  const author = new Map<string, string>();
  const p = join(RAW, `tatoeba-detailed/${code}_sentences_detailed.tsv`);
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const [id, , text, by] = line.split("\t");
    if (!id || !text || !want.has(text)) continue;
    byText.set(text, [...(byText.get(text) ?? []), id]);
    author.set(id, by && by !== "\\N" ? by : "");
  }
  return { byText, author };
}

mkdirSync(join(OUT, "credits"), { recursive: true });
const only = process.env.WORDS_ONLY?.split(",");
for (const lang of new Set(lists.map((l) => l.lang))) {
  if (only && !only.includes(lang)) continue;
  const code = TATOEBA_CODE[lang];
  if (!code) continue;
  const pairs: [string, string][] = [];
  for (const l of lists.filter((x) => x.lang === lang)) {
    const j = JSON.parse(readFileSync(join(OUT, l.file), "utf8"));
    for (const e of j.entries as { ex?: string; exTr?: string }[])
      if (e.ex) pairs.push([e.ex, e.exTr ?? ""]);
  }
  const src = detailed(code, new Set(pairs.map((p) => p[0])));
  const isEn = lang === "en";
  const eng = isEn ? null : detailed("eng", new Set(pairs.map((p) => p[1]).filter(Boolean)));
  // links from this language's sentences to English ones
  const links = new Map<string, Set<string>>();
  if (!isEn)
    for (const line of readFileSync(join(RAW, `tatoeba/${code}-eng_links.tsv`), "utf8").split(
      "\n",
    )) {
      const [a, b] = line.split("\t");
      if (a && b && src.author.has(a) && eng!.author.has(b))
        links.set(a, (links.get(a) ?? new Set()).add(b));
    }
  const rows = new Set<string>();
  for (const [ex, tr] of pairs) {
    for (const id of src.byText.get(ex) ?? []) {
      const trId = tr ? (eng?.byText.get(tr) ?? []).find((t) => links.get(id)?.has(t)) : undefined;
      if (!isEn && tr && !trId) continue; // not this sentence's translation
      rows.add(
        [id, src.author.get(id) ?? "", trId ?? "", trId ? (eng!.author.get(trId) ?? "") : ""].join(
          "\t",
        ),
      );
      break;
    }
  }
  const body = [
    `# Tatoeba (tatoeba.org) sentences used as examples in the ${lang} word lists, CC BY 2.0 FR.`,
    "# Each sentence and its author: https://tatoeba.org/sentences/show/<id>",
    "# sentence id\tauthor\tEnglish translation id\ttranslation author",
    ...[...rows].sort((a, b) => Number(a.split("\t")[0]) - Number(b.split("\t")[0])),
  ].join("\n");
  writeFileSync(join(OUT, `credits/tatoeba-${lang}.tsv`), body + "\n");
  console.log(`${lang}: ${rows.size} sentences credited (${pairs.length} examples)`);
}
