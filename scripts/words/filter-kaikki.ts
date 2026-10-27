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
 * Korean also needs the dictionary forms of verbs and adjectives, which rarely
 * occur as subtitle tokens themselves (팔다 is met as 팔고, 팔아, 판). With
 * KAIKKI_FORMS=1 every verb/adjective that has a conjugation table is kept,
 * with its table forms in `f`, so the builder can map 팔고 → 팔다:
 *
 *   curl -sL …/Korean/kaikki.org-dictionary-Korean.jsonl \
 *     | KAIKKI_FORMS=1 bun scripts/words/filter-kaikki.ts <raw>/freq/ko_50k.txt > <raw>/kaikki/ko.jsonl
 *
 * Input is treated as untrusted data: it is only JSON.parse'd, never executed.
 * Output: one JSON object per line: { w, pos, senses: [{ g, tags, of, top? }], hj?, f?, ex? }
 * (`ex`: up to 3 short usage examples [text, English, sense index])
 * (`top`: Wiktionary topics such as heraldry, Buddhism, chemistry)
 * (`hj`: the entry lists a hanja spelling — a Sino-Korean word; `f`: conjugated forms).
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

const withForms = process.env.KAIKKI_FORMS === "1";

/**
 * Sub-senses repeat their parent gloss first. When the parent is only a
 * heading ("Figurative senses.", "Senses relating to brittleness.", "To move,
 * either physically or in an abstract sense:") the real definition is the
 * sub-gloss that follows it.
 */
const HEADING = /\bsenses?\.?:?$|^(?:senses|primarily|literal|figurative)\b.*\bsenses?\b/i;
function pickGloss(glosses: unknown, isForm: boolean): string {
  if (!Array.isArray(glosses)) return "";
  const gs = glosses.filter((g): g is string => typeof g === "string");
  // the top-level gloss, unless it is only a header like "[with genitive]"
  // (Russian prepositions); then the first real sub-gloss
  const i = gs.findIndex((g) => !/^\[[^\]]*\]$/.test(g.trim()));
  if (i < 0) return "";
  if (!isForm && HEADING.test(gs[i].trim()) && gs[i + 1]) return gs[gs.length - 1];
  return gs[i];
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
  if (!w) continue;
  const pos = String(e.pos ?? "");
  const forms: any[] = Array.isArray(e.forms) ? e.forms : [];
  const tagsOf = (f: any): string[] => (Array.isArray(f?.tags) ? f.tags : []);
  // conjugation-table forms (not romanization, hanja, template names…)
  const conj =
    withForms && (pos === "verb" || pos === "adj")
      ? [
          ...new Set(
            forms
              .filter((f) => typeof f?.form === "string" && /^\p{Script=Hangul}+$/u.test(f.form))
              .filter(
                (f) =>
                  !tagsOf(f).some((t) => /^(romanization|hanja|canonical|alternative)$/.test(t)),
              )
              .map((f) => f.form as string),
          ),
        ]
      : [];
  if (!keep.has(w.toLowerCase()) && !conj.length) continue;
  const senses = (Array.isArray(e.senses) ? e.senses : [])
    .slice(0, 12)
    .map((s: any) => {
      const of = [...(s.form_of ?? []), ...(s.alt_of ?? [])]
        .map((f: any) => (typeof f?.word === "string" ? f.word : ""))
        .filter(Boolean);
      const top = Array.isArray(s.topics) ? s.topics.filter((t: any) => typeof t === "string") : [];
      return {
        g: pickGloss(s.glosses, of.length > 0),
        tags: Array.isArray(s.tags) ? s.tags.filter((t: any) => typeof t === "string") : [],
        of,
        ...(top.length ? { top } : {}),
      };
    })
    .filter((s: any) => s.g);
  if (!senses.length) continue;
  const rec: any = { w, pos, senses };
  // short made-up usage examples (not dated quotations), in sense order:
  // [text, English translation (empty for English), sense index]
  const ex: [string, string, number][] = [];
  (Array.isArray(e.senses) ? e.senses : []).slice(0, 12).forEach((s: any, si: number) => {
    for (const x of Array.isArray(s.examples) ? s.examples : []) {
      if (ex.length >= 3) return;
      const text = typeof x?.text === "string" ? x.text.replace(/\s+/g, " ").trim() : "";
      const tr = String(x?.translation ?? x?.english ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text || text.length > 100 || tr.length > 120 || x.ref || x.type === "quotation")
        continue;
      if (x.type && x.type !== "example") continue;
      ex.push([text, tr, si]);
    }
  });
  if (ex.length) rec.ex = ex;
  if (forms.some((f) => tagsOf(f).includes("hanja"))) rec.hj = 1;
  if (conj.length) rec.f = conj;
  out.write(JSON.stringify(rec) + "\n");
  kept++;
}
await out.flush();
console.error(`filter-kaikki: ${seen} lines read, ${kept} entries kept`);
