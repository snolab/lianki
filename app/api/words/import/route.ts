import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { WordEntriesD1Repo } from "@/lib/repos/wordEntriesD1";
import { MAX_ENTRIES, MAX_LEN } from "@/lib/words/anki";
import { wordsRepo } from "../repo";

const text = (max: number) => z.string().max(max);
const Body = z.object({
  /** An imported list to update (re-import); absent = a new list. */
  listId: z.string().max(64).optional(),
  /** The Anki deck id, kept in the list's source as "anki:<id>". */
  deckId: z.string().regex(/^[0-9a-z-]{1,40}$/),
  name: z.string().trim().min(1).max(120),
  lang: z.string().trim().min(2).max(16),
  entries: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        term: text(MAX_LEN.term).min(1),
        back: text(MAX_LEN.back),
        reading: text(MAX_LEN.reading).optional(),
        ex: text(MAX_LEN.ex).optional(),
        exTr: text(MAX_LEN.exTr).optional(),
      }),
    )
    .max(MAX_ENTRIES),
});

/**
 * Import an Anki deck as a word list (/words/import). The browser parses the
 * .apkg and sends plain-text entries; importing into the same list again
 * updates it by note guid (WordEntriesD1Repo.sync), keeping review history.
 */
export async function POST(req: NextRequest) {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: `Invalid import: ${issue?.path.join(".")} ${issue?.message}` },
      { status: 400 },
    );
  }
  const { listId, deckId, name, lang, entries } = parsed.data;
  let id = listId;
  if (id) {
    const list = await repo.getList(id);
    if (!list?.source?.startsWith("anki:"))
      return NextResponse.json({ error: "Not an imported list" }, { status: 404 });
  } else id = await repo.createList({ name, lang, source: `anki:${deckId}` });
  const result = await new WordEntriesD1Repo(repo.db, repo.email).sync(id, entries);
  return NextResponse.json({ listId: id, ...result });
}
