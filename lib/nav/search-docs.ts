/**
 * The nav search's own-content index (docs/bottom-nav.md, "Search"): what a
 * document is, how each source becomes documents, and the scan that ranks
 * them. Pure: the IndexedDB glue is lib/nav/islands/search-idb.ts. Queries
 * never leave the device; the index is built from the offline copy.
 */
import { norm, scoreNorm, treeItems } from "./nav-core";

export type DocKind = "list" | "word" | "card" | "plan" | "tree";

/** The async groups, in the order they are shown (and appended). */
export const GROUP_ORDER: readonly DocKind[] = ["list", "word", "card", "plan", "tree"];

export type SearchDoc = {
  /** Unique: `${src}|…`. */
  id: string;
  /** The source it was built from: "lists", "words:<listId>", "cards", "plan", "tree". */
  src: string;
  kind: DocKind;
  title: string;
  sub?: string;
  /** An app path, or an absolute URL for a card. */
  href: string;
  /** norm(title). */
  t: string;
  /** norm(everything else that should match: reading, meaning, example, URL). */
  k: string;
  /** A word's list and term, to put it at the top of the list when opened. */
  listId?: string;
  term?: string;
};

/** Words indexed per list until "search all words" lifts the cap. */
export const WORD_CAP = 3000;
/** Cards indexed at most. */
export const CARD_CAP = 2000;
/** A best-of per group, so a common letter does not render thousands of rows. */
export const GROUP_LIMIT = 30;

const plain = (s: string | undefined) =>
  (s ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** A short stable hash (FNV-1a) of a source's content: unchanged sources are not rebuilt. */
export function stampOf(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

const doc = (d: Omit<SearchDoc, "t" | "k"> & { more?: string }): SearchDoc => {
  const { more, ...rest } = d;
  return { ...rest, t: norm(d.title), k: norm([d.sub, more].filter(Boolean).join(" ")) };
};

export type ListLike = {
  id: string;
  name: string;
  lang?: string;
  source?: string | null;
};

/** Where a list opens: /alphabet for an alphabet catalog, else /words. */
export const listHref = (l: ListLike, alphabetIds: ReadonlySet<string>) =>
  `${l.source && alphabetIds.has(l.source) ? "/alphabet" : "/words"}?list=${encodeURIComponent(l.id)}`;

export const isGroupList = (l: ListLike) => !!l.source?.startsWith("group:");

export function listDocs(
  lists: readonly ListLike[],
  alphabetIds: ReadonlySet<string>,
  label: string,
): SearchDoc[] {
  return lists.map((l) =>
    doc({
      id: `lists|${l.id}`,
      src: "lists",
      kind: "list",
      title: l.name,
      sub: label,
      href: listHref(l, alphabetIds),
      more: l.lang,
    }),
  );
}

export type EntryLike = {
  term: string;
  reading?: string;
  back?: string;
  ex?: string;
  exTr?: string;
};

/** One list's words, capped unless `all`. */
export function wordDocs(
  list: ListLike,
  entries: readonly EntryLike[],
  alphabetIds: ReadonlySet<string>,
  all = false,
): { docs: SearchDoc[]; capped: boolean } {
  const take = all ? entries : entries.slice(0, WORD_CAP);
  const href = listHref(list, alphabetIds);
  const src = `words:${list.id}`;
  const docs = take.map((e, i) =>
    doc({
      id: `${src}|${i}`,
      src,
      kind: "word",
      title: e.term,
      sub: [e.reading, plain(e.back)].filter(Boolean).join(" · ").slice(0, 120) || list.name,
      href,
      more: [plain(e.ex), plain(e.exTr), list.name].join(" "),
      listId: list.id,
      term: e.term,
    }),
  );
  return { docs, capped: take.length < entries.length };
}

export function cardDocs(rows: readonly { url: string; title?: string }[]): SearchDoc[] {
  return rows.slice(0, CARD_CAP).map((c) =>
    doc({
      id: `cards|${c.url}`,
      src: "cards",
      kind: "card",
      title: c.title || c.url,
      sub: c.url,
      href: c.url,
    }),
  );
}

type GoalLike = { _id?: string; id?: string; topic?: string; nodes?: unknown };

/** Roadmap goals (the study plan): the topic and each node's title. */
export function planDocs(goals: readonly GoalLike[]): SearchDoc[] {
  const out: SearchDoc[] = [];
  for (const g of goals) {
    const id = String(g._id ?? g.id ?? g.topic ?? out.length);
    if (g.topic)
      out.push(
        doc({ id: `plan|${id}`, src: "plan", kind: "plan", title: g.topic, href: "/roadmap" }),
      );
    const nodes = Array.isArray(g.nodes) ? g.nodes : [];
    nodes.forEach((n, i) => {
      const title =
        n && typeof n === "object"
          ? ((n as { title?: unknown; label?: unknown }).title ?? (n as { label?: unknown }).label)
          : null;
      if (typeof title === "string" && title.trim())
        out.push(
          doc({
            id: `plan|${id}|${i}`,
            src: "plan",
            kind: "plan",
            title,
            sub: g.topic,
            href: "/roadmap",
          }),
        );
    });
  }
  return out;
}

/** The state tree's open nodes (owner only). */
export function treeDocs(nodes: Parameters<typeof treeItems>[0]): SearchDoc[] {
  return treeItems(nodes, "/dev/roadmap", 1000).map((it) =>
    doc({
      id: `tree|${it.id}`,
      src: "tree",
      kind: "tree",
      title: it.title,
      sub: it.sub,
      href: it.href,
    }),
  );
}

/** How well a document matches a normalized query: its title first, then the rest. */
export const scoreDoc = (d: SearchDoc, n: string) =>
  Math.max(scoreNorm(d.t, n), d.k ? scoreNorm(d.k, n) * 0.6 : 0);

/**
 * The best `limit` of `docs` for `n` (normalized), scanned in slices of
 * `slice` with `pause()` between them so typing never waits; null when
 * `cancelled()` turns true (a newer keystroke). Stable: ties keep index order.
 */
export async function scan(
  docs: readonly SearchDoc[],
  n: string,
  o: { cancelled: () => boolean; pause?: () => Promise<void>; slice?: number; limit?: number },
): Promise<SearchDoc[] | null> {
  const hits: { d: SearchDoc; s: number; i: number }[] = [];
  const slice = o.slice ?? 1500;
  for (let i = 0; i < docs.length; i++) {
    if (i && i % slice === 0) {
      await (o.pause ?? (() => new Promise<void>((r) => setTimeout(r, 0))))();
      if (o.cancelled()) return null;
    }
    // Subsequence matches over a meaning or example are noise: those fields need a substring.
    const d = docs[i];
    const s = Math.max(scoreNorm(d.t, n), d.k && d.k.includes(n) ? 36 : 0);
    if (s > 0) hits.push({ d, s, i });
  }
  if (o.cancelled()) return null;
  return hits
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, o.limit ?? GROUP_LIMIT)
    .map((h) => h.d);
}
