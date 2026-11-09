// A clip in R2's tts/ is shared: the same language and text answer anyone who asks
// (lib/words-tts.ts). So a sentence of the user's own private text is voiced but not
// kept. Asked on the server, so it holds on every path to the route: the reader read
// aloud (/read on a /vibe doc) and a word card's example on /words, prefetched or
// tapped, on any client.
//
// The card outlives its doc ("a word card stays in their deck", docs/vibe.md), and a
// book's list does not say which kind of book it came from, so every `book:` list's
// example counts. A single word stays shareable, as a word's gloss does.
import type { D1Like } from "@/lib/d1/types";

/** A /vibe conversation, by the key its first line was saved under (lib/vibe/store.ts). */
export const isVibeMaterial = (m: { sourceKey?: string }) => !!m.sourceKey?.startsWith("vibe:");

/** Two or more words, in a script with or without spaces. */
export function moreThanAWord(text: string, lang: string): boolean {
  let tag: string | undefined;
  try {
    tag = Intl.getCanonicalLocales(lang)[0];
  } catch {}
  let n = 0;
  for (const w of new Intl.Segmenter(tag, { granularity: "word" }).segment(text))
    if (w.isWordLike && ++n > 1) return true;
  return false;
}

export async function isPrivateSpeech(
  db: D1Like,
  email: string,
  text: string,
  lang: string,
): Promise<boolean> {
  if (!moreThanAWord(text, lang)) return false;
  // read_materials.lines is a JSON array: the text as it is spelt in there.
  const inLines = JSON.stringify(text).slice(1, -1);
  const hit = await db
    .prepare(
      `SELECT 1 AS hit FROM vibe_doc v
         JOIN user u ON u.id = v.user_id
         JOIN read_materials m ON m.id = v.material_id
       WHERE u.email = ? AND instr(m.lines, ?) > 0
       UNION ALL
       SELECT 1 AS hit FROM word_list_entries e
         JOIN word_lists l ON l.email = e.email AND l.id = e.list_id
       WHERE e.email = ? AND l.source LIKE 'book:%' AND instr(e.ex, ?) > 0
       LIMIT 1`,
    )
    .bind(email, inLines, email, text)
    .first<{ hit: number }>();
  return !!hit;
}
