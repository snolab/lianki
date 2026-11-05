#!/usr/bin/env bun
/**
 * Re-derive the HSK lists' backs and readings with scripts/words/senses.ts
 * (hskSenses), in place: order, terms and examples stay as they are — a
 * full rebuild (build-word-lists.ts) would also re-pick the Tatoeba examples.
 *
 *   RAW=/tmp/words-raw   # with hsk/new-1..7.json, as build-word-lists.ts says
 *   bun scripts/words/patch-hsk-backs.ts $RAW public/words
 *
 * Prints each changed back. 2026-11-05: 云 was "(classical) to say" — its
 * first CC-CEDICT form — instead of "cloud" (owner, a Japanese line in /read).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hskSenses, joinSenses, type CedictForm } from "./senses";

const [RAW, OUT] = process.argv.slice(2);
if (!RAW || !OUT) throw new Error("usage: patch-hsk-backs.ts <raw dir> <public/words>");

type W = { s?: string; f?: CedictForm[] };
const forms = new Map<string, CedictForm[]>();
for (const n of [1, 2, 3, 4, 5, 6, 7])
  for (const w of JSON.parse(readFileSync(join(RAW, `hsk/new-${n}.json`), "utf8")) as W[])
    if (w.s && Array.isArray(w.f) && w.f.length && !forms.has(w.s)) forms.set(w.s, w.f);

let changed = 0;
for (const id of ["1", "2", "3", "4", "5", "6", "7-9"]) {
  const file = join(OUT, `zh-hsk-${id}.json`);
  const list = JSON.parse(readFileSync(file, "utf8")) as {
    entries: { term: string; reading?: string; back: string }[];
  };
  let n = 0;
  for (const e of list.entries) {
    const f = forms.get(e.term);
    if (!f) continue;
    const { reading, senses } = hskSenses(f, e.term);
    const back = joinSenses(senses, 80);
    if (!back || (back === e.back && (reading || undefined) === e.reading)) continue;
    console.log(`${id}\t${e.term}\t${e.reading ?? ""} → ${reading}\t${e.back}  →  ${back}`);
    e.back = back;
    if (reading) e.reading = reading;
    else delete e.reading;
    n++;
  }
  // The same shape as writeList: one line, keys in the same order.
  if (n) writeFileSync(file, JSON.stringify(list));
  changed += n;
}
console.error(`${changed} backs changed`);
