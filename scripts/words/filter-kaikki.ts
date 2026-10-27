#!/usr/bin/env bun
/**
 * Stream a kaikki.org (English Wiktionary) JSONL extract from stdin and keep
 * only the entries whose headword (case-insensitive) appears in a
 * FrequencyWords list, reduced to the fields the word-list builder needs.
 *
 * Kaikki files are 0.2–3.5 GB, so this never stores them — pipe curl into it:
 *
 *   curl -sL https://kaikki.org/dictionary/French/kaikki.org-dictionary-French.jsonl \
 *     | bun scripts/words/filter-kaikki.ts <raw>/freq/fr_50k.txt > <raw>/kaikki/fr.jsonl
 *
 * Input is treated as untrusted data: it is only JSON.parse'd, never executed.
 * Output: one JSON object per line: { w, pos, senses: [{ g, tags, of }] }
 */

export {};

const [freqPath] = process.argv.slice(2);
if (!freqPath) {
  console.error("usage: filter-kaikki.ts <freq_50k.txt> < kaikki.jsonl > out.jsonl");
  process.exit(1);
}

const keep = new Set<string>();
for (const line of (await Bun.file(freqPath).text()).split("\n")) {
  const w = line.split(" ")[0]?.trim().toLowerCase();
  if (w) keep.add(w);
}

const out = Bun.stdout.writer();
let seen = 0;
let kept = 0;
for await (const line of console) {
  seen++;
  if (!line) continue;
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  const w = typeof e.word === "string" ? e.word : "";
  if (!w || !keep.has(w.toLowerCase())) continue;
  const senses = (Array.isArray(e.senses) ? e.senses : [])
    .slice(0, 12)
    .map((s: any) => ({
      // The top-level gloss, unless it is only a header like "[with genitive]"
      // (Russian prepositions); then the first real sub-gloss.
      g: Array.isArray(s.glosses)
        ? String(
            s.glosses.find((g: any) => typeof g === "string" && !/^\[[^\]]*\]$/.test(g.trim())) ??
              "",
          )
        : "",
      tags: Array.isArray(s.tags) ? s.tags.filter((t: any) => typeof t === "string") : [],
      of: [...(s.form_of ?? []), ...(s.alt_of ?? [])]
        .map((f: any) => (typeof f?.word === "string" ? f.word : ""))
        .filter(Boolean),
    }))
    .filter((s: any) => s.g);
  if (!senses.length) continue;
  out.write(JSON.stringify({ w, pos: String(e.pos ?? ""), senses }) + "\n");
  kept++;
}
await out.flush();
console.error(`filter-kaikki: ${seen} lines read, ${kept} entries kept`);
