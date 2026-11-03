#!/usr/bin/env bun
/**
 * Stream the kaikki.org English-Wiktionary extract (stdin, JSONL; CC BY-SA 4.0)
 * and keep, for the words listed in argv[2] (one per line), what the exam
 * decks use: Mandarin translations (not Cantonese, Min, Dungan …), IPA and the
 * first glosses. One line per entry: {word, pos, tr: [{w, s, tags}], ipa, glosses}.
 * Downloads are untrusted data: only parsed. See build-exam-decks.ts for the
 * pipeline.
 */
import { readFileSync } from "node:fs";
const want = new Set(readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean));
const dec = new TextDecoder();
let buf = "";
const OTHER =
  /Cantonese|Hokkien|Min|Hakka|Wu|Dungan|Teochew|Gan|Xiang|Jin|Taishanese|Classical|Literary/;
/** A Mandarin translation in Han script. */
const isZh = (t: any) =>
  ["cmn", "zh"].includes(t.lang_code ?? t.code) &&
  /\p{Script=Han}/u.test(t.word ?? "") &&
  !(t.tags ?? []).some((x: string) => OTHER.test(x)) &&
  !OTHER.test(t.lang ?? "");
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const m = /"word": ?"((?:[^"\\]|\\.)*)", ?"lang": ?"English", ?"lang_code": ?"en"/.exec(line);
    if (!m || !want.has(m[1])) continue;
    const e = JSON.parse(line);
    if (e.lang_code !== "en") continue;
    const tr: any[] = [];
    for (const t of e.translations ?? [])
      if (isZh(t) && t.word) tr.push({ w: t.word, s: t.sense ?? "", tags: t.tags });
    for (const s of e.senses ?? [])
      for (const t of s.translations ?? [])
        if (isZh(t) && t.word)
          tr.push({ w: t.word, s: t.sense ?? s.glosses?.[0] ?? "", tags: t.tags });
    const ipa = (e.sounds ?? [])
      .filter((x: any) => x.ipa)
      .map((x: any) => ({ ipa: x.ipa, tags: x.tags ?? [] }));
    const glosses = (e.senses ?? []).slice(0, 3).map((x: any) => x.glosses?.[0] ?? "");
    process.stdout.write(JSON.stringify({ word: e.word, pos: e.pos, tr, ipa, glosses }) + "\n");
  }
}
