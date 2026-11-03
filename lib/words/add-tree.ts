/**
 * The /words "Add a list" picker as a tree (owner, 2026-11-03 18:54 JST:
 * "语言单词列表应该显示成一个树，然后我可以一次把我想学的全部添加进来"):
 *
 *   language → Most common words → list
 *            → Exam word lists   → exam (JLPT, HSK 3.0, CET…) → list
 *            → Phrases           → scenario deck
 *
 * Every node has a tri-state checkbox. Ticking a node ticks every list under
 * it that is not added yet; lists already added show checked and disabled.
 * One "Add selected" adds everything ticked, and the learner stays on the
 * picker (nothing starts studying).
 *
 * Exams we cannot ship (lib/words/external-search.ts) sit among the exam
 * lists as "external" nodes: no checkbox, only search links when unfolded.
 */
import type { ExternalSearch } from "./external-search";

/** What the tree needs from a catalog entry. */
export type AddMeta = {
  id: string;
  lang: string;
  kind?: "phrase" | "exam";
  exam?: string;
  scenario?: string;
};

export type AddFamily = "freq" | "exam" | "phrases";

export type AddNode<M extends AddMeta = AddMeta> =
  | { kind: "lang"; key: string; lang: string; children: AddNode<M>[] }
  | { kind: "family"; key: string; family: AddFamily; children: AddNode<M>[] }
  | { kind: "exam"; key: string; exam: string; children: AddNode<M>[] }
  | { kind: "list"; key: string; meta: M }
  | { kind: "external"; key: string; search: ExternalSearch };

const isPhrase = (m: AddMeta) => m.kind === "phrase" || !!m.scenario;

/**
 * The tree, in catalog order: languages as they first appear, then within a
 * language its common-word lists, its exams (each exam's levels in catalog
 * order: N5 before N1, CET-4 before CET-6), then its phrase decks ordered by
 * `scenarios` (lib/words/phrases.ts). An empty family is left out.
 * `external` exams follow the shipped ones; an exam with one entry and no
 * level sits right under "Exam word lists", with no branch between.
 */
export function buildAddTree<M extends AddMeta>(
  catalog: M[],
  scenarios: readonly string[],
  external: readonly ExternalSearch[] = [],
) {
  const langs = [...new Set([...catalog.map((c) => c.lang), ...external.map((s) => s.lang)])];
  return langs.map((lang): AddNode<M> => {
    const of = catalog.filter((c) => c.lang === lang);
    const ext = external.filter((s) => s.lang === lang);
    const leaf = (meta: M): AddNode<M> => ({ kind: "list", key: meta.id, meta });
    const extLeaf = (search: ExternalSearch): AddNode<M> => ({
      kind: "external",
      key: `ext:${search.id}`,
      search,
    });
    const freq = of.filter((c) => !isPhrase(c) && !c.exam);
    const exams = [
      ...new Set([
        ...of.filter((c) => !isPhrase(c) && c.exam).map((c) => c.exam!),
        ...ext.map((s) => s.exam),
      ]),
    ];
    const phrases = of
      .filter((c) => isPhrase(c) && c.scenario)
      .sort((a, b) => scenarios.indexOf(a.scenario!) - scenarios.indexOf(b.scenario!));
    const families: AddNode<M>[] = [];
    if (freq.length)
      families.push({
        kind: "family",
        key: `${lang}/freq`,
        family: "freq",
        children: freq.map(leaf),
      });
    if (exams.length)
      families.push({
        kind: "family",
        key: `${lang}/exam`,
        family: "exam",
        children: exams.map((exam): AddNode<M> => {
          const lists = of.filter((c) => !isPhrase(c) && c.exam === exam);
          const searches = ext.filter((s) => s.exam === exam);
          if (!lists.length && searches.length === 1 && !searches[0].level)
            return extLeaf(searches[0]);
          return {
            kind: "exam",
            key: `${lang}/exam/${exam}`,
            exam,
            children: [...lists.map(leaf), ...searches.map(extLeaf)],
          };
        }),
      });
    if (phrases.length)
      families.push({
        kind: "family",
        key: `${lang}/phrases`,
        family: "phrases",
        children: phrases.map(leaf),
      });
    // One kind only (an alphabet's letters, a language with only common
    // words): its lists sit right under the language, with no branch between.
    const only = families.length === 1 && families[0].kind === "family" ? families[0] : null;
    const children = only?.family === "freq" ? only.children : families;
    return { kind: "lang", key: `lang:${lang}`, lang, children };
  });
}

/** Every list under a node (the node itself when it is a list). */
export function leavesOf<M extends AddMeta>(node: AddNode<M>): M[] {
  if (node.kind === "list") return [node.meta];
  if (node.kind === "external") return [];
  return node.children.flatMap(leavesOf);
}

export type TickState = { checked: boolean; mixed: boolean; disabled: boolean };

/**
 * A node's checkbox: checked when every list under it is ticked or already
 * added, mixed when only some are, disabled when all of them are added.
 */
export function tickState(
  node: AddNode,
  ticked: ReadonlySet<string>,
  added: ReadonlySet<string>,
): TickState {
  const leaves = leavesOf(node);
  const on = leaves.filter((m) => added.has(m.id) || ticked.has(m.id)).length;
  return {
    checked: leaves.length > 0 && on === leaves.length,
    mixed: on > 0 && on < leaves.length,
    disabled: leaves.every((m) => added.has(m.id)),
  };
}

/**
 * Tap a node: when anything under it that can be added is not ticked yet,
 * tick all of it; otherwise untick it all. Added lists never change.
 */
export function toggleTick(
  node: AddNode,
  ticked: ReadonlySet<string>,
  added: ReadonlySet<string>,
): Set<string> {
  const open = leavesOf(node)
    .map((m) => m.id)
    .filter((id) => !added.has(id));
  const next = new Set(ticked);
  const all = open.every((id) => ticked.has(id));
  for (const id of open) {
    if (all) next.delete(id);
    else next.add(id);
  }
  return next;
}

/**
 * The node keys under a node, itself included (for expanding a language).
 * External nodes stay folded: their links show only when tapped open.
 */
export function branchKeys(node: AddNode): string[] {
  if (node.kind === "list" || node.kind === "external") return [];
  return [node.key, ...node.children.flatMap(branchKeys)];
}

/**
 * The languages to show unfolded at first: the learner's own (the languages
 * of the lists he has), or when he has none yet, the ones his browser asks for.
 */
export function defaultOpen(
  tree: AddNode[],
  ownLangs: readonly string[],
  browserLangs: readonly string[],
): Set<string> {
  const has = (lang: string) => tree.some((n) => n.kind === "lang" && n.lang === lang);
  let langs = [...new Set(ownLangs)].filter(has);
  if (!langs.length) langs = [...new Set(browserLangs.map((l) => l.split("-")[0]))].filter(has);
  return new Set(
    tree.filter((n) => n.kind === "lang" && langs.includes(n.lang)).flatMap(branchKeys),
  );
}

/** The ticked lists in tree order (the order they are added in). */
export function tickedInOrder<M extends AddMeta>(tree: AddNode<M>[], ticked: ReadonlySet<string>) {
  return tree.flatMap(leavesOf).filter((m) => ticked.has(m.id));
}

/**
 * The coverage lines the one-tap bands aim for: shares of running text, which
 * hold for every language and learner (docs/design-principles.md, "No fixed
 * numbers for users"; 95% is the reading-coverage line).
 */
export const COVERAGE_TARGETS = [0.5, 0.8, 0.9, 0.95] as const;

export type CoverageBand = {
  /** The frequency lists that make the band: a prefix, most frequent first. */
  ids: string[];
  /** The share of text the band covers (estimated by lemma; scripts/words/build-word-lists.ts). */
  coverage: number;
  /** The band's last rank: the band is the top 1–`top` words. */
  top: number;
};

/**
 * One-tap bands over a language's frequency lists, in rank order: for each
 * coverage target, the fewest lists from the top that reach it. Targets the
 * lists never reach give no band; targets reached by the same lists give one.
 * Lists without coverage data give none.
 */
export function coverageBands(
  freq: { id: string; level: string; coverage?: number }[],
  targets: readonly number[] = COVERAGE_TARGETS,
): CoverageBand[] {
  const bands: CoverageBand[] = [];
  for (const target of targets) {
    const i = freq.findIndex((l) => (l.coverage ?? 0) >= target);
    if (i < 0 || freq.slice(0, i + 1).some((l) => l.coverage == null)) continue;
    if (bands.at(-1)?.ids.length === i + 1) continue;
    const top = Number(/[–-](\d+)$/.exec(freq[i].level)?.[1]);
    if (!top) continue;
    bands.push({ ids: freq.slice(0, i + 1).map((l) => l.id), coverage: freq[i].coverage!, top });
  }
  return bands;
}

/**
 * A language node's frequency lists, most frequent first: its "Most common
 * words" branch, or its own lists when they sit right under it.
 */
export function freqListsOf<M extends AddMeta>(lang: AddNode<M>): M[] {
  if (lang.kind !== "lang") return [];
  const freq = lang.children.find((c) => c.kind === "family" && c.family === "freq");
  if (freq) return leavesOf(freq);
  return lang.children.every((c) => c.kind === "list") ? leavesOf(lang) : [];
}

/**
 * Fold or unfold one node (owner, 2026-11-03 20:12 JST: folding a language
 * must hide everything under it). Folding removes only the node's own key, so
 * its branches keep their state and come back as they were when it is
 * unfolded; a node unfolded for the first time (no branch below it open)
 * opens with all its branches.
 */
export function toggleOpenKey(node: AddNode, open: ReadonlySet<string>): Set<string> {
  const next = new Set(open);
  if (next.has(node.key)) {
    next.delete(node.key);
    return next;
  }
  const below = branchKeys(node).slice(1);
  const fresh = !below.some((k) => open.has(k));
  for (const k of fresh ? [node.key, ...below] : [node.key]) next.add(k);
  return next;
}

/**
 * The rows the tree shows, depth first, as keys: a node's branch (its
 * children, and a language's coverage bands and Add all, `bands:<lang>` and
 * `all:<lang>`) only while it is open. AddTreeNode renders by the same rule.
 */
export function shownKeys(tree: AddNode[], open: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walk = (n: AddNode) => {
    out.push(n.key);
    if (n.kind === "list" || !open.has(n.key)) return;
    if (n.kind === "external") return;
    if (n.kind === "lang") out.push(`all:${n.lang}`, `bands:${n.lang}`);
    n.children.forEach(walk);
  };
  tree.forEach(walk);
  return out;
}

/** The unfolded nodes, per device and page (docs/ui-state.md): `lk:words-add-open:<base>`. */
const openStoreKey = (base: string) => `lk:words-add-open:${base}`;
const MAX_OPEN = 400;

export function loadAddOpen(base: string, storage?: Storage): Set<string> | null {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(openStoreKey(base));
    if (raw == null) return null;
    const keys = JSON.parse(raw);
    if (!Array.isArray(keys)) return null;
    return new Set(keys.filter((k): k is string => typeof k === "string" && k.length <= 200));
  } catch {
    return null;
  }
}

export function saveAddOpen(base: string, open: ReadonlySet<string>, storage?: Storage) {
  try {
    (storage ?? globalThis.localStorage)?.setItem(
      openStoreKey(base),
      JSON.stringify([...open].slice(-MAX_OPEN)),
    );
  } catch {}
}
