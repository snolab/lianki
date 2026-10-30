/**
 * Language groups on /words: a parent group per language ("Japanese") holding
 * that language's lists (JLPT N5 → N1, top 1–500 → 2501–3000, imported decks).
 * Pure helpers, shared by the picker and the server.
 *
 * The grouping is real data, not a view: each language gets a group row
 * (`source: "group:words"`, `lang: <the language>`), and that language's
 * top-level lists move under it. A parent's child order is the saved
 * position order, which is also the order "study" introduces new words in;
 * a later per-parent mode (sequential / parallel with weights) reads the
 * same order.
 *
 * Manual structure wins: a list the learner already put in a group stays
 * where it is, and an existing group of that language (or with that
 * language's name) is reused rather than doubled.
 */
import { flatten, type TreeNode } from "./tree";

/** Group rows keep `lang: "mul"` unless they stand for one language. */
export const MULTI_LANG = "mul";

/** The once-per-account record's name (word_list_migrations.name). */
export const GROUP_BY_LANGUAGE = "group-by-language-v1";

type Named = { name: string; lang: string };

/**
 * A list's name as shown under its parent: inside a group of the same
 * language, the "Japanese · " prefix of a catalog name says nothing new, so
 * "Japanese · JLPT N5" reads "JLPT N5". The stored name is not changed.
 */
export function shownName(list: Named, parent: Named | null | undefined): string {
  if (!parent || parent.lang === MULTI_LANG || parent.lang !== list.lang) return list.name;
  const cut = list.name.indexOf(" · ");
  if (cut <= 0) return list.name;
  const rest = list.name.slice(cut + 3).trim();
  return rest || list.name;
}

export type PlanList = TreeNode & { name: string; lang: string; source: string | null };

export type GroupingPlan = {
  /**
   * Groups to create. `key` stands in for the new id; `parentId` is an
   * existing id, another new group's key (always listed earlier), or null.
   */
  create: { key: string; name: string; lang: string; parentId: string | null }[];
  /** The page's whole tree in its new order; a new group's id is its `key`. */
  order: { id: string; parentId: string | null }[];
  /** Lists that move, and the group each goes into (an id, or a `create` key). */
  moved: { id: string; into: string }[];
};

/** Placeholder id of a group still to be created: a language, or a series in it. */
export const newGroupKey = (lang: string, series?: string) =>
  series ? `new-group:${lang}/${series}` : `new-group:${lang}`;
const isNewKey = (id: string) => id.startsWith("new-group:");

/**
 * A catalog list's series, for the middle level: Japanese → JLPT → N5…N1,
 * Chinese → HSK → 1…7–9. Frequency lists ("top 1–500") have none and sit
 * right under their language.
 */
export function seriesOf(source: string | null): string | undefined {
  const m = /^[a-z]{2,3}-(jlpt|hsk)-/.exec(source ?? "");
  return m ? m[1].toUpperCase() : undefined;
}

/**
 * Plan the grouping. `lists` are one page's rows in saved order. `rank`
 * gives a catalog list's place in the catalog (N5 before N1); imported decks
 * have none and keep their relative order after the catalog lists.
 * `names(lang)` lists names that count as that language's group (its name in
 * the app's language first, then English); the first one names a new group.
 *
 * Only top-level, non-group lists with a real language move: into their
 * language's group, and for a series (JLPT, HSK) into that series' group
 * inside it. Existing groups are reused: for a language, one of that
 * language or named like it; for a series, one named like it (inside the
 * language group first). Running the plan on its own result moves nothing.
 */
export function planLanguageGroups(
  lists: PlanList[],
  o: {
    groupSource: string;
    rank: (source: string | null) => number | undefined;
    names: (lang: string) => string[];
    series?: (source: string | null) => string | undefined;
    /** Move only these lists (adding a series from the catalog); others stay put. */
    only?: Set<string>;
  },
): GroupingPlan {
  const series = o.series ?? seriesOf;
  const flat = flatten(lists);
  const isGroup = (l: PlanList) => l.source === o.groupSource;
  const real = (lang: string) => !!lang && lang !== MULTI_LANG;
  // flatten() puts orphans and cycles at depth 0: those count as top level.
  const parentOf = new Map(flat.map((x) => [x.id, x.depth === 0 ? null : x.parentId]));
  const kids = new Map<string | null, PlanList[]>();
  for (const x of flat)
    kids.set(parentOf.get(x.id)!, [...(kids.get(parentOf.get(x.id)!) ?? []), x]);

  const movingLists = flat.filter(
    (l) =>
      !isGroup(l) && parentOf.get(l.id) === null && real(l.lang) && (!o.only || o.only.has(l.id)),
  );
  if (!movingLists.length) return { create: [], order: flat.map(pick), moved: [] };

  const fold = (s: string) => s.trim().toLocaleLowerCase();
  const groups = flat.filter(isGroup);
  const topFirst = (a: PlanList, b: PlanList) =>
    Number(parentOf.get(a.id) !== null) - Number(parentOf.get(b.id) !== null);
  const create: GroupingPlan["create"] = [];
  const made = new Set<string>();
  const make = (key: string, name: string, lang: string, parentId: string | null) => {
    if (!made.has(key)) create.push({ key, name, lang, parentId });
    made.add(key);
    return key;
  };

  const langGroup = new Map<string, string>();
  const langOf = (lang: string) => {
    if (!langGroup.has(lang)) {
      const names = o.names(lang).map(fold);
      const found =
        [...groups].sort(topFirst).find((g) => g.lang === lang) ??
        [...groups].sort(topFirst).find((g) => !real(g.lang) && names.includes(fold(g.name)));
      langGroup.set(
        lang,
        found?.id ?? make(newGroupKey(lang), o.names(lang)[0] ?? lang, lang, null),
      );
    }
    return langGroup.get(lang)!;
  };
  const seriesGroup = new Map<string, string>();
  const seriesIn = (lang: string, s: string) => {
    const k = `${lang}/${s}`;
    if (!seriesGroup.has(k)) {
      // One he made, wherever it is (inside his language group first) …
      const like = groups.filter(
        (g) => fold(g.name) === fold(s) && (g.lang === lang || !real(g.lang)),
      );
      const parent = langGroup.get(lang);
      const found = like.find((g) => g.parentId === parent) ?? like.sort(topFirst)[0];
      // … else a new one inside the language group.
      seriesGroup.set(k, found?.id ?? make(newGroupKey(lang, s), s, lang, langOf(lang)));
    }
    return seriesGroup.get(k)!;
  };

  // Catalog lists by catalog rank (N5 → N1), then imported decks as they were.
  const sorted = movingLists
    .map((l, i) => ({ l, i, r: o.rank(l.source) }))
    .sort((a, b) => {
      if (a.r !== undefined && b.r !== undefined) return a.r - b.r || a.i - b.i;
      if (a.r !== undefined) return -1;
      if (b.r !== undefined) return 1;
      return a.i - b.i;
    })
    .map((x) => x.l);

  // What goes into each group, in order: new groups and moved lists.
  const incoming = new Map<string, string[]>();
  const put = (into: string, id: string) => {
    const now = incoming.get(into) ?? [];
    if (!now.includes(id)) incoming.set(into, [...now, id]);
  };
  const moved: GroupingPlan["moved"] = [];
  for (const l of sorted) {
    const s = series(l.source);
    const into = s ? seriesIn(l.lang, s) : langOf(l.lang);
    moved.push({ id: l.id, into });
    put(into, l.id);
  }
  for (const c of create) if (c.parentId) put(c.parentId, c.key);
  // A new group listed after the lists already in it would put N5 after the
  // JLPT group: new groups go where their first list would.
  for (const [into, ids] of incoming) {
    const first = (id: string): number => {
      if (!isNewKey(id)) return sorted.findIndex((l) => l.id === id);
      return Math.min(...(incoming.get(id) ?? []).map(first), Infinity);
    };
    incoming.set(
      into,
      ids
        .map((id, i) => ({ id, i, at: first(id) }))
        .sort((a, b) => a.at - b.at || a.i - b.i)
        .map((x) => x.id),
    );
  }
  const moving = new Set(moved.map((m) => m.id));
  const byId = new Map(flat.map((x) => [x.id, x]));

  const order: GroupingPlan["order"] = [];
  const placed = new Set<string>();
  const emit = (id: string, parentId: string | null) => {
    if (placed.has(id)) return false;
    placed.add(id);
    order.push({ id, parentId });
    return true;
  };
  // A row, its own children (manual structure first), then what moves in.
  const emitTree = (row: PlanList, parentId: string | null) => {
    if (!emit(row.id, parentId)) return;
    for (const k of kids.get(row.id) ?? []) emitTree(k, row.id);
    fill(row.id);
  };
  const fill = (into: string) => {
    for (const id of incoming.get(into) ?? []) {
      if (isNewKey(id)) {
        if (emit(id, into)) fill(id);
      } else emitTree(byId.get(id)!, into);
    }
  };
  for (const row of kids.get(null) ?? []) {
    if (!moving.has(row.id)) {
      emitTree(row, null);
      continue;
    }
    // A new top-level group stands where its first list stood.
    let top: string | null = moved.find((m) => m.id === row.id)!.into;
    const parentOfNew = new Map(create.map((c) => [c.key, c.parentId]));
    while (top && parentOfNew.get(top)) top = parentOfNew.get(top)!;
    if (top && isNewKey(top) && emit(top, null)) fill(top);
  }
  for (const row of flat) emit(row.id, parentOf.get(row.id) ?? null); // nothing is lost
  return { create, order, moved };
}

const pick = (x: TreeNode) => ({ id: x.id, parentId: x.parentId ?? null });

/**
 * Names that count as a language's group: in the app's language first (it
 * names a new group: "Japonais" on a French phone), then in English, so a
 * group he called "Japanese" himself is found either way.
 */
export function languageNames(lang: string, locale?: string): string[] {
  const named = (loc: string) => {
    try {
      const n = new Intl.DisplayNames([loc], { type: "language" }).of(lang);
      return n && n !== lang ? n.charAt(0).toLocaleUpperCase(loc) + n.slice(1) : undefined;
    } catch {
      return undefined;
    }
  };
  const all = [locale ? named(locale) : undefined, named("en"), lang];
  return [...new Set(all.filter((x): x is string => !!x))];
}

/** What the record keeps, to undo the grouping. */
export type GroupingUndo = {
  /** The page's tree before, in order. */
  before: { id: string; parentId: string | null }[];
  /** The tree right after, to tell whether anything changed since. */
  after: { id: string; parentId: string | null }[];
  /** Groups the grouping made (real ids). */
  created: string[];
  /** Lists it moved, and the group each went into (real ids). */
  moved: { id: string; into: string }[];
};

/**
 * The tree after undoing. Untouched since: exactly the tree before. Changed
 * since: each moved list still in the group it was moved into comes back to
 * the top level where that group stands; lists the learner moved on their own
 * since stay where they are. `drop` are the created groups left empty, to
 * delete.
 */
export function planUndo(
  now: PlanList[],
  undo: GroupingUndo,
): { order: { id: string; parentId: string | null }[]; drop: string[] } {
  const flat = flatten(now);
  const same = (a: { id: string; parentId: string | null }[]) =>
    a.map((x) => `${x.id}>${x.parentId}`).join();
  const back = new Set(
    undo.moved.filter((m) => flat.find((x) => x.id === m.id)?.parentId === m.into).map((m) => m.id),
  );
  // A created group goes when nothing is left in it but lists going back and
  // other created groups that go too (Japanese → JLPT → nothing).
  const dropped = new Set(undo.created.filter((g) => flat.some((x) => x.id === g)));
  for (let changed = true; changed; ) {
    changed = false;
    for (const g of dropped)
      if (flat.some((x) => x.parentId === g && !back.has(x.id) && !dropped.has(x.id))) {
        dropped.delete(g);
        changed = true;
      }
  }
  const drop = undo.created.filter((g) => dropped.has(g));
  if (same(flat.map(pick)) === same(undo.after)) {
    const live = new Set(flat.map((x) => x.id));
    return { order: undo.before.filter((x) => live.has(x.id)), drop };
  }
  // Every moved list was at the top level before: it goes back there, in
  // the place its group stands now.
  const order = flat
    .filter((row) => !dropped.has(row.id))
    .map((row) => ({ id: row.id, parentId: back.has(row.id) ? null : (row.parentId ?? null) }));
  return { order, drop };
}

/**
 * Adding a whole series from the catalog (JLPT → N5…N1): which of its lists
 * he lacks (by catalog id), and which he has, at the top level (they may
 * join the new group if he says so) or already inside a group (left alone).
 */
export function seriesStatus(
  lists: PlanList[],
  members: string[],
): { missing: string[]; top: string[]; nested: string[] } {
  const ids = new Set(lists.map((l) => l.id));
  const out = { missing: [] as string[], top: [] as string[], nested: [] as string[] };
  for (const source of members) {
    const have = lists.filter((l) => l.source === source);
    if (!have.length) out.missing.push(source);
    for (const l of have)
      (l.parentId && ids.has(l.parentId) && l.parentId !== l.id ? out.nested : out.top).push(l.id);
  }
  return out;
}
