#!/usr/bin/env bun
/**
 * Build the scenario phrase decks served from public/words/ for /words:
 * `<lang>-phrases-<scenario>.json` and their rows in index.json
 * (`kind: "phrase"`, `scenario`). Word lists in index.json are left alone.
 *
 *   bun scripts/words/build-phrase-decks.ts scripts/words/phrases public/words
 *
 * Sources are the curated `<lang>-<scenario>.jsonl` files in the first dir,
 * one phrase per line; `drop.tsv` there (`lang<TAB>term`) holds the lines the
 * owner marked drop in the review sheet. How they were made, and the checks
 * they passed: public/words/SOURCES.md, "Scenario phrase decks".
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isScenario, type Scenario } from "@/lib/words/phrases";
import { buildPhraseDecks, mergeIndex, parseDrops, parseJsonl, withCredits } from "./phrase-decks";

const [SRC, OUT] = process.argv.slice(2);
if (!SRC || !OUT) {
  console.error("usage: build-phrase-decks.ts <phrases-dir> <out-dir>");
  process.exit(1);
}

const sources: { lang: string; scenario: Scenario; lines: ReturnType<typeof parseJsonl> }[] = [];
for (const f of readdirSync(SRC).filter((f) => f.endsWith(".jsonl"))) {
  const m = /^([a-z]{2})-(.+)\.jsonl$/.exec(f);
  if (!m || !isScenario(m[2])) throw new Error(`unexpected source file ${f}`);
  sources.push({
    lang: m[1],
    scenario: m[2],
    lines: parseJsonl(readFileSync(join(SRC, f), "utf8")),
  });
}
const dropPath = join(SRC, "drop.tsv");
const drops = existsSync(dropPath) ? parseDrops(readFileSync(dropPath, "utf8")) : new Set<string>();
const built = buildPhraseDecks(sources, drops);
if (built.problems.length) {
  console.error(built.problems.join("\n"));
  process.exit(1);
}
for (const { file, json } of built.files) writeFileSync(join(OUT, file), JSON.stringify(json));
const indexPath = join(OUT, "index.json");
const existing = JSON.parse(readFileSync(indexPath, "utf8")).lists;
const langs = [...new Set(sources.map((s) => s.lang))];
const lists = mergeIndex(existing, built.lists, langs);
writeFileSync(indexPath, JSON.stringify({ lists }));
// Per-sentence credits in SOURCES.md, between its phrase-credits markers.
const sourcesPath = join(OUT, "SOURCES.md");
if (existsSync(sourcesPath))
  writeFileSync(sourcesPath, withCredits(readFileSync(sourcesPath, "utf8"), built.credits));
for (const l of built.lists) console.log(`${l.id.padEnd(24)} ${l.count}`);
console.log(`index.json: ${lists.length} lists`);
