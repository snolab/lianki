#!/usr/bin/env bun
/**
 * Text coverage for the frequency word lists (`<lang>-freq-<n>`, ranks
 * "a–b"): the share of running text (OpenSubtitles 2018 tokens,
 * hermitdave/FrequencyWords `<lang>_50k.txt`) that the top b words cover.
 * The /words "Add a list" tree offers one-tap coverage bands from it
 * (lib/words/add-tree.ts coverageBands) — bands by coverage, not by fixed
 * rank cut-offs (docs/design-principles.md, "No fixed numbers for users").
 *
 * It counts word forms, not lemmas: a lemma list's top b covers at least as
 * much (one lemma stands for several forms), so the figure is a floor. The
 * total is the 50k file's own sum; the tail past 50k forms is left out.
 *
 *   RAW=<scratch dir with freq/<l>_50k.txt, see build-word-lists.ts step 1>
 *   RAW=$RAW bun scripts/words/freq-coverage.ts
 *
 * Patches `coverage` into public/words/index.json in place; run it again
 * after build-word-lists.ts (which rewrites the frequency rows).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RAW = process.env.RAW;
if (!RAW) throw new Error("RAW=<dir> required");
const indexPath = join(import.meta.dir, "../../public/words/index.json");
const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
  lists: { id: string; lang: string; level: string; coverage?: number }[];
};

const cumulative = new Map<string, number[]>();
const cum = (lang: string) => {
  if (cumulative.has(lang)) return cumulative.get(lang)!;
  const file = join(RAW, `freq/${lang}_50k.txt`);
  if (!existsSync(file)) return null;
  const counts = readFileSync(file, "utf8")
    .split("\n")
    .map((line) => Number(line.trim().split(/\s+/)[1]) || 0)
    .filter((c) => c > 0);
  const total = counts.reduce((a, b) => a + b, 0);
  let run = 0;
  const out = counts.map((c) => (run += c) / total);
  cumulative.set(lang, out);
  return out;
};

for (const l of index.lists) {
  if (!/-freq-\d+$/.test(l.id)) continue;
  const top = Number(/[–-](\d+)$/.exec(l.level)?.[1]);
  const c = cum(l.lang);
  if (!c || !top) continue;
  l.coverage = Math.round(c[Math.min(top, c.length) - 1] * 1000) / 1000;
  console.log(l.id, l.level, l.coverage);
}
writeFileSync(indexPath, JSON.stringify(index));
