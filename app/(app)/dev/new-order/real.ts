import catalogIndex from "@/public/words/index.json";
import { getD1 } from "@/lib/d1";
import { WordsD1Repo } from "@/lib/repos/wordsD1";
import { projectCurve } from "@/lib/words/gate-eta";
import { bucketByLanguage, type OrderNode } from "@/lib/words/new-order";
import { parseCard } from "@/lib/words/schedule";
import { flatten } from "@/lib/words/tree";

/** The owner's real tree for the simulator, read-only, plus each list's projected progress. */
export type RealData = {
  tree: OrderNode;
  /** Projected Σ score per day (day 0 = today), per leaf id, two decimals. */
  curves: Record<string, number[]>;
  /** New words and reviews a day over the last 14 days, per leaf id. */
  pace: Record<string, { n: number; r: number }>;
  today: string;
};

const HORIZON = 730;
const PACE_DAYS = 14;

/** Reads D1 only (SELECTs); writes nothing. */
export async function loadRealData(email: string, now = new Date()): Promise<RealData> {
  const db = getD1();
  const repo = new WordsD1Repo(db, email);
  const counts = new Map(catalogIndex.lists.map((c) => [c.id, c.count]));
  const lists = (await repo.lists(now)).filter(
    (l) =>
      l.source &&
      (counts.has(l.source) || l.source === "group:words" || l.source.startsWith("anki:")),
  );
  const isGroup = (l: (typeof lists)[number]) => l.source === "group:words";
  const sizeOf = (l: (typeof lists)[number]) => counts.get(l.source!) ?? l.size ?? 0;

  const { results: cardRows } = await db
    .prepare("SELECT list_id, card FROM word_cards WHERE email = ?")
    .bind(email)
    .all<{ list_id: string; card: string }>();
  const since = new Date(now.getTime() - PACE_DAYS * 86400_000).toISOString();
  const { results: paceRows } = await db
    .prepare(
      `SELECT list_id, SUM(state = 0) AS n, COUNT(*) AS r FROM word_reviews
       WHERE email = ? AND reviewed_at >= ? GROUP BY list_id`,
    )
    .bind(email, since)
    .all<{ list_id: string; n: number; r: number }>();

  const cards = new Map<string, NonNullable<ReturnType<typeof parseCard>>[]>();
  for (const row of cardRows) {
    const c = parseCard(row.card);
    if (c) cards.set(row.list_id, [...(cards.get(row.list_id) ?? []), c]);
  }
  const pace: RealData["pace"] = {};
  for (const p of paceRows)
    pace[p.list_id] = { n: (p.n ?? 0) / PACE_DAYS, r: (p.r ?? 0) / PACE_DAYS };

  const curves: RealData["curves"] = {};
  const leaf = (l: (typeof lists)[number], id = l.id): OrderNode => {
    const size = sizeOf(l);
    const own = cards.get(l.id) ?? [];
    const curve = projectCurve({
      size,
      cards: own,
      params: l.params,
      pace: pace[l.id]?.n ?? 0,
      now,
      horizon: HORIZON,
    });
    curves[id] = curve.score.map((x) => Math.round(x * 100) / 100);
    return { id, name: l.name, lang: l.lang, size, seen: l.cards, score: l.progress };
  };

  // Nest the flat rows: a group holds its children; a list with children of
  // its own counts its own words as a first child.
  const flat = flatten(lists);
  const byParent = new Map<string | null, typeof flat>();
  for (const x of flat) byParent.set(x.parentId, [...(byParent.get(x.parentId) ?? []), x]);
  const done = new Set<string>();
  const node = (l: (typeof flat)[number]): OrderNode => {
    done.add(l.id);
    // A cycle in stored parents: each row once.
    const kids = (byParent.get(l.id) ?? []).filter((k) => !done.has(k.id)).map(node);
    if (!kids.length) return isGroup(l) ? { id: l.id, name: l.name, children: [] } : leaf(l);
    if (!isGroup(l) && sizeOf(l) > 0) kids.unshift(leaf(l, `${l.id}:self`));
    return { id: l.id, name: l.name, lang: l.lang, children: kids };
  };
  const ids = new Set(flat.map((x) => x.id));
  const top = flat.filter((x) => !x.parentId || !ids.has(x.parentId));
  const tree = bucketByLanguage({ id: "root", children: top.map(node) });
  return { tree, curves, pace, today: now.toISOString().slice(0, 10) };
}
