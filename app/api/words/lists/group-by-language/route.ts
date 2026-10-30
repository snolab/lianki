import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import catalog from "@/public/words/index.json";
import type { WordList } from "@/lib/repos/wordsD1";
import { languageNames } from "@/lib/words/lang-groups";
import { wordsRepo } from "../../repo";

/** /words's own group rows (WordsClient's groupSourceOf). */
const GROUP = "group:words";
const ids: string[] = catalog.lists.map((c) => c.id);
/** The lists /words shows: its catalog, imported decks, its groups (not /alphabets'). */
const onPage = (l: WordList) =>
  !!l.source && (ids.includes(l.source) || l.source.startsWith("anki:") || l.source === GROUP);

const Body = z.object({
  /** The app's language: names a new group ("Japonais" on a French phone). */
  locale: z.string().max(35).optional(),
  undo: z.boolean().optional(),
});

/**
 * Group /words's top-level lists by language: Japanese → JLPT → N5…N1,
 * French → top 1–500…, once per account (lib/words/lang-groups.ts,
 * WordsD1Repo.groupByLanguage). The picker calls it after loading the lists;
 * a second call changes nothing. `{undo: true}` puts the lists back.
 */
export async function POST(req: NextRequest) {
  const repo = await wordsRepo();
  if (repo instanceof NextResponse) return repo;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  if (parsed.data.undo) {
    const undone = await repo.undoGroupByLanguage(onPage);
    return NextResponse.json({ undone, lists: await repo.lists() });
  }
  const result = await repo.groupByLanguage({
    onPage,
    groupSource: GROUP,
    rank: (s) => (s && ids.includes(s) ? ids.indexOf(s) : undefined),
    names: (lang) => languageNames(lang, parsed.data.locale),
  });
  return NextResponse.json({ ...result, lists: result.applied ? await repo.lists() : undefined });
}
