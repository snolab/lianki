/**
 * "Arrange" for the learner's own lists on /words (owner, 2026-11-03 19:43–19:58
 * JST: "单词列表目录，给他们排成竖状", "排成一棵树，按语言；场景、还有考试",
 * "N5 在最上面", "只针对我的账号里面的东西"): one tap puts every list he has
 * into one tree,
 *
 *   language → Most common words → lists
 *            → Phrases           → lists
 *            → Exam word lists   → lists
 *            → his own decks (imported, made by hand), by name
 *
 * with each kind's lists in learning order (the catalog's `order`: N5 before
 * N1, HSK 1 before HSK 6, top 1–500 first). Everything comes from the data;
 * nothing here knows a language.
 *
 * Nothing is deleted or renamed. Groups he already has are reused: a group of
 * the language that holds only one kind's lists becomes that kind's group, and
 * another group of the language becomes the language's. Groups left over
 * (emptied or of no one language) go to the end, as they were. A language
 * with lists of only one kind has no kind level: its lists sit right under it.
 */
import { descendants, flatten, type FlatItem, type TreeNode } from "./tree";

export type ArrangeKind = "freq" | "phrase" | "exam";
export const ARRANGE_KINDS: readonly ArrangeKind[] = ["freq", "phrase", "exam"];

/** What arranging needs from a catalog entry. */
export type ArrangeMeta = { kind?: string; exam?: string; scenario?: string; order?: number };

/** A built-in list's kind: phrase decks, exam decks (JLPT, HSK, CET…), the rest common words. */
export function kindOf(meta: ArrangeMeta | undefined): ArrangeKind | null {
  if (!meta) return null;
  if (meta.kind === "phrase" || meta.scenario) return "phrase";
  if (meta.kind === "exam" || meta.exam) return "exam";
  return "freq";
}

type Row = TreeNode & { name: string; lang: string; source?: string | null };

/** A group to make before the order can be saved; `key` names it in `ids`. */
export type NeededGroup = { key: string; lang: string; kind: ArrangeKind | null };

export type ArrangePlan = {
  /** Groups to create (POST), in order; then call `order` with their ids. */
  make: NeededGroup[];
  /** The whole tree's order, for PATCH /api/words/lists. */
  order: (ids: ReadonlyMap<string, string>) => { id: string; parentId: string | null }[];
};

export const groupKey = (lang: string, kind: ArrangeKind | null) =>
  kind ? `${lang}/${kind}` : `lang:${lang}`;

/**
 * Plan the arrangement. `metaOf` gives a list's catalog entry (undefined for
 * his own decks); `catalogIndex` breaks ties in catalog order; `kindLabels`
 * are the kind groups' names in the UI's language, to recognise an empty
 * group he made for a kind.
 */
export function planArrange<T extends Row>(
  rows: T[],
  {
    isGroup,
    metaOf,
    catalogIndex,
    kindLabels,
  }: {
    isGroup: (r: T) => boolean;
    metaOf: (r: T) => ArrangeMeta | undefined;
    catalogIndex: (r: T) => number;
    kindLabels: Record<ArrangeKind, string>;
  },
): ArrangePlan {
  const flat = flatten(rows);
  const byId = new Map(flat.map((r) => [r.id, r]));
  const lists = flat.filter((r) => !isGroup(r));
  const groups = flat.filter(isGroup);
  // Languages in the order he has them.
  const langs = [...new Set(lists.map((r) => r.lang))];

  const listsUnder = (g: FlatItem<T>) =>
    descendants(flat, g.id)
      .map((id) => byId.get(id)!)
      .filter((r) => !isGroup(r));
  const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  /** The kind a group stands for: all its lists are of it, or it is empty and named for it. */
  const groupKind = (g: FlatItem<T>): ArrangeKind | null => {
    const under = listsUnder(g);
    if (!under.length) return ARRANGE_KINDS.find((k) => sameName(g.name, kindLabels[k])) ?? null;
    const kinds = new Set(under.map((r) => kindOf(metaOf(r))));
    const [only] = kinds;
    return kinds.size === 1 && only ? only : null;
  };

  const used = new Set<string>();
  const reuse = new Map<string, string>(); // group key → existing group id
  for (const lang of langs) {
    const own = groups.filter((g) => g.lang === lang);
    for (const kind of ARRANGE_KINDS) {
      const g = own.find((g) => !used.has(g.id) && groupKind(g) === kind);
      if (g) {
        used.add(g.id);
        reuse.set(groupKey(lang, kind), g.id);
      }
    }
    const home = own.find((g) => !used.has(g.id));
    if (home) {
      used.add(home.id);
      reuse.set(groupKey(lang, null), home.id);
    }
  }

  const rank = (r: T) => [metaOf(r)?.order ?? Infinity, catalogIndex(r)] as const;
  const byLearning = (a: T, b: T) => {
    const [oa, ia] = rank(a);
    const [ob, ib] = rank(b);
    return oa - ob || ia - ib;
  };
  const layout = langs.map((lang) => {
    const of = lists.filter((r) => r.lang === lang);
    const kinds = ARRANGE_KINDS.map((kind) => ({
      kind,
      lists: of.filter((r) => kindOf(metaOf(r)) === kind).sort(byLearning),
    })).filter((k) => k.lists.length);
    const mine = of
      .filter((r) => kindOf(metaOf(r)) === null)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    // One kind and nothing of his own: no kind level.
    const flatKinds = kinds.length === 1 && !mine.length;
    return { lang, kinds, mine, flatKinds };
  });

  const make: NeededGroup[] = [];
  for (const { lang, kinds, flatKinds } of layout) {
    if (!reuse.has(groupKey(lang, null)))
      make.push({ key: groupKey(lang, null), lang, kind: null });
    if (flatKinds) continue;
    for (const { kind } of kinds)
      if (!reuse.has(groupKey(lang, kind))) make.push({ key: groupKey(lang, kind), lang, kind });
  }

  const order = (ids: ReadonlyMap<string, string>) => {
    const idOf = (key: string) => reuse.get(key) ?? ids.get(key);
    const out: { id: string; parentId: string | null }[] = [];
    const placed = new Set<string>();
    const put = (id: string | undefined, parentId: string | null) => {
      if (!id || placed.has(id)) return;
      placed.add(id);
      out.push({ id, parentId });
    };
    for (const { lang, kinds, mine, flatKinds } of layout) {
      const home = idOf(groupKey(lang, null)) ?? null;
      put(home ?? undefined, null);
      for (const { kind, lists } of kinds) {
        const parent = flatKinds ? home : (idOf(groupKey(lang, kind)) ?? home);
        if (!flatKinds) put(parent ?? undefined, home);
        for (const r of lists) put(r.id, parent);
      }
      for (const r of mine) put(r.id, home);
    }
    // Groups left over keep their place among themselves, at the end; a kind
    // group not needed now (one kind only) is left over too.
    const arranged = new Set(placed);
    for (const g of groups) {
      if (arranged.has(g.id)) continue;
      const p = g.parentId && byId.has(g.parentId) && !arranged.has(g.parentId) ? g.parentId : null;
      put(g.id, p);
    }
    return out;
  };
  return { make, order };
}
